import type {
  AuthoritativeBatchIntent,
  AuthoritativeBatchOperation,
  AuthoritativeBatchRecord,
  AuthoritativeBatchRepository,
} from "../application/ports/authoritative-batch-repository";
import type { SqlClient } from "./sql-client";
import { createIdGenerator, type IdGenerator } from "../shared/ids/uuid";
import { conflict, invalid, notFound, revisionConflict } from "../application/errors";
import { normalizeResourceMetadata, parseResourceMetadata } from "../domain/workspace/resource-metadata";
import { createAuditEventWriter } from "./audit-repository";
import { toWorkspaceOperation } from "./workspace-operation-repository";

const date = (value: unknown): Date => value instanceof Date ? value : new Date(String(value));

export function createAuthoritativeBatchRepository(
  client: SqlClient,
  options: { newId?: IdGenerator } = {},
): AuthoritativeBatchRepository {
  const newId = options.newId ?? createIdGenerator();
  const writeAudit = createAuditEventWriter(newId);

  const read = async (db: SqlClient, batchId: string): Promise<AuthoritativeBatchRecord | null> => {
    const batch = await db.query("SELECT * FROM workspace_operation_batches WHERE id = $1", [batchId]);
    if (!batch.rows[0]) return null;
    const operations = await db.query("SELECT * FROM workspace_operations WHERE batch_id = $1 ORDER BY created_at, id", [batchId]);
    const row = batch.rows[0];
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      status: row.status as AuthoritativeBatchRecord["status"],
      createdAt: date(row.created_at),
      ...(row.completed_at == null ? {} : { completedAt: date(row.completed_at) }),
      operations: operations.rows.map(toWorkspaceOperation),
    };
  };

  const operationRow = async (
    tx: SqlClient,
    input: AuthoritativeBatchIntent,
    operation: AuthoritativeBatchOperation,
  ): Promise<void> => {
    const operationId = newId();
    const expectedRevision = "expectedRevision" in operation ? operation.expectedRevision : null;
    const content = "content" in operation ? operation.content : undefined;
    const result = await tx.query(
      `INSERT INTO workspace_operations
         (id, project_id, resource_id, operation, status, source_path, target_path,
          staged_path, expected_revision, resulting_revision, actor_type, actor_id,
          credential_id, request_id, batch_id)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        operationId, input.projectId, operation.resourceId, operation.operation,
        operation.path, operation.path, "stagedPath" in operation ? operation.stagedPath ?? null : null,
        expectedRevision, operation.operation === "create" ? 1 : expectedRevision === null ? null : expectedRevision + 1,
        input.audit.actorType ?? "user", input.audit.actorId ?? input.audit.subjectUserId,
        input.audit.credentialId ?? null, input.audit.requestId ?? null, input.batchId,
      ],
    );
    if (!result.rows[0]) throw invalid("Could not journal authoritative batch operation.");
    if (content !== undefined) {
      const revision = operation.operation === "create" ? 1 : expectedRevision! + 1;
      const resource = await tx.query("SELECT type, metadata FROM resources WHERE id = $1", [operation.resourceId]);
      const metadata = normalizeResourceMetadata(
        "metadata" in operation ? operation.metadata : parseResourceMetadata(resource.rows[0]?.metadata),
      );
      await tx.query(
        `INSERT INTO resource_revisions
           (resource_id, revision, content, type, metadata, authorship)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [operation.resourceId, revision, content, "type" in operation ? operation.type : String(resource.rows[0]?.type), JSON.stringify(metadata), JSON.stringify(input.actor)],
      );
    }
  };

  return {
    async claim(input) {
      if (input.operations.length === 0) throw invalid("An authoritative batch must contain an operation.");
      return client.transaction(async (tx) => {
        const existing = await read(tx, input.batchId);
        if (existing) return existing;
        if (input.idempotencyKey) {
          const prior = await tx.query(
            "SELECT result, status FROM idempotency_records WHERE actor_id = $1 AND project_id = $2 AND idempotency_key = $3",
            [input.audit.actorId ?? input.audit.subjectUserId ?? "system", input.projectId, input.idempotencyKey],
          );
          if (prior.rows[0]) {
            if (String(prior.rows[0].status) !== "completed") throw conflict("An authoritative batch with this idempotency key is in progress.");
            const priorId = (prior.rows[0].result as { batchId?: string } | null)?.batchId;
            if (priorId) {
              const replay = await read(tx, priorId);
              if (replay) return replay;
            }
          }
        }
        await tx.query("INSERT INTO workspace_operation_batches (id, project_id) VALUES ($1, $2)", [input.batchId, input.projectId]);
        for (const operation of input.operations) {
            if (operation.operation === "create") {
              await tx.query(
                `INSERT INTO resources (id, project_id, path, type, metadata, lifecycle)
                 VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb), 'ACTIVE')`,
                [operation.resourceId, input.projectId, operation.path, operation.type, operation.metadata === undefined ? null : JSON.stringify(operation.metadata)],
              );
            } else {
              const current = await tx.query("SELECT * FROM resources WHERE project_id = $1 AND id = $2 AND knowledge_context_id IS NULL FOR UPDATE", [input.projectId, operation.resourceId]);
              const row = current.rows[0];
              if (!row) throw notFound(`No resource with id ${operation.resourceId}.`);
              if (String(row.lifecycle) !== "ACTIVE") throw invalid("The resource is already retired.");
              if (Number(row.revision) !== operation.expectedRevision) throw revisionConflict(operation.expectedRevision, Number(row.revision));
              if (operation.operation === "update") {
                await tx.query("UPDATE resources SET revision = revision + 1, metadata = COALESCE($3::jsonb, metadata), updated_at = now() WHERE project_id = $1 AND id = $2", [input.projectId, operation.resourceId, operation.metadata === undefined ? null : JSON.stringify(operation.metadata)]);
              } else {
                const relationships = await tx.query(
                  `SELECT source_id, target_id, kind, source_role, target_role
                     FROM resource_relationships
                    WHERE project_id = $1 AND knowledge_context_id IS NULL
                      AND (source_id = $2 OR target_id = $2)`,
                  [input.projectId, operation.resourceId],
                );
                for (const relationship of relationships.rows) {
                  await tx.query(
                    `INSERT INTO resource_relationship_history
                       (id, project_id, source_id, target_id, kind, source_role, target_role, recorded_by, operation_id)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [newId(), input.projectId, String(relationship.source_id), String(relationship.target_id), String(relationship.kind), relationship.source_role == null ? null : String(relationship.source_role), relationship.target_role == null ? null : String(relationship.target_role), input.audit.actorId ?? input.audit.subjectUserId, input.batchId],
                  );
                }
                await tx.query(
                  `DELETE FROM resource_relationships
                    WHERE project_id = $1 AND knowledge_context_id IS NULL
                      AND (source_id = $2 OR target_id = $2)`,
                  [input.projectId, operation.resourceId],
                );
                await tx.query("UPDATE resources SET lifecycle = 'RETIRED', retired_at = now(), retired_by = $3, updated_at = now() WHERE project_id = $1 AND id = $2", [input.projectId, operation.resourceId, input.audit.actorId ?? input.audit.subjectUserId]);
              }
            }
            await operationRow(tx, input, operation);
        }
        await writeAudit(tx, { ...input.audit, detail: { ...(input.audit.detail ?? {}), batchId: input.batchId, operationCount: input.operations.length } });
        if (input.idempotencyKey) {
          await tx.query("INSERT INTO idempotency_records (actor_id, project_id, idempotency_key, operation, status, result, completed_at) VALUES ($1, $2, $3, 'batch', 'completed', $4::jsonb, now())", [input.audit.actorId ?? input.audit.subjectUserId ?? "system", input.projectId, input.idempotencyKey, JSON.stringify({ batchId: input.batchId })]);
        }
        return (await read(tx, input.batchId))!;
      });
    },
    async complete(batchId) {
      return client.transaction(async (tx) => {
        const pending = await tx.query("SELECT 1 FROM workspace_operations WHERE batch_id = $1 AND status <> 'completed' LIMIT 1", [batchId]);
        if (pending.rows.length > 0) return read(tx, batchId);
        await tx.query("UPDATE workspace_operation_batches SET status = 'completed', completed_at = now() WHERE id = $1", [batchId]);
        return read(tx, batchId);
      });
    },
    get(batchId) {
      return read(client, batchId);
    },
  };
}
