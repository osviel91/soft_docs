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
import { createHash } from "node:crypto";
import { applySemanticBindingOperations } from "./semantic-binding-repository";
import type { SemanticBinding } from "../domain/workspace/semantic-binding";

const date = (value: unknown): Date => value instanceof Date ? value : new Date(String(value));
const revisionFingerprint = (rows: Array<Record<string, unknown>>): string =>
  JSON.stringify(rows.map((row) => [String(row.id), Number(row.revision)]).sort(([a], [b]) => String(a).localeCompare(String(b))));
const relationshipFingerprint = (row: Record<string, unknown>): string =>
  JSON.stringify({ kind: String(row.kind), sourceId: String(row.source_id), targetId: String(row.target_id), sourceRole: row.source_role ?? null, targetRole: row.target_role ?? null });

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
      ...(row.promotion_id == null ? {} : { promotionId: String(row.promotion_id) }),
      ...(row.manifest_content == null ? {} : { manifest: { expectedContent: row.manifest_expected_content == null ? null : String(row.manifest_expected_content), content: String(row.manifest_content), ...(row.manifest_staged_path == null ? {} : { stagedPath: String(row.manifest_staged_path) }) } }),
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
           credential_id, request_id, batch_id, content_hash)
        VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        operationId, input.projectId, operation.resourceId, operation.operation,
         "sourcePath" in operation ? operation.sourcePath ?? operation.path : operation.path, operation.path, "stagedPath" in operation ? operation.stagedPath ?? null : null,
        expectedRevision, operation.operation === "create" ? 1 : expectedRevision === null ? null : expectedRevision + 1,
        input.audit.actorType ?? "user", input.audit.actorId ?? input.audit.subjectUserId,
         input.audit.credentialId ?? null, input.audit.requestId ?? null, input.batchId,
         content === undefined ? null : createHash("sha256").update(content, "utf8").digest("hex"),
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
      if (input.operations.length === 0 && !(input.semanticBindingChanges?.length) && !input.promotion) throw invalid("An authoritative batch must contain an operation.");
      return client.transaction(async (tx) => {
        const existing = await read(tx, input.batchId);
        if (existing) return existing;
        if (input.promotion) {
          const proposal = await tx.query("SELECT status FROM architectural_proposals WHERE id = $1 FOR UPDATE", [input.promotion.proposalId]);
          if (!proposal.rows[0]) throw notFound("The proposal no longer exists.");
          if (String(proposal.rows[0].status) !== "open") throw conflict("The proposal is no longer open for promotion.", { state: String(proposal.rows[0].status) });
        }
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
         await tx.query(
           `INSERT INTO workspace_operation_batches
              (id, project_id, promotion_id, manifest_expected_revision, manifest_expected_content, manifest_content, manifest_staged_path)
            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
           [input.batchId, input.projectId, input.promotion?.id ?? null, input.manifest?.expectedRevision ?? null, input.manifest?.expectedContent ?? null, input.manifest?.content ?? null, input.manifest?.stagedPath ?? null],
         );
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
                 await tx.query("UPDATE resources SET path = $3, revision = revision + 1, metadata = COALESCE($4::jsonb, metadata), updated_at = now() WHERE project_id = $1 AND id = $2", [input.projectId, operation.resourceId, operation.path, operation.metadata === undefined ? null : JSON.stringify(operation.metadata)]);
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
        for (const change of input.relationshipChanges ?? []) {
          const relationship = change.relationship;
          const current = await tx.query("SELECT kind, source_id, target_id, source_role, target_role FROM resource_relationships WHERE project_id = $1 AND knowledge_context_id IS NULL AND source_id = $2 AND target_id = $3 FOR UPDATE", [input.projectId, relationship.sourceId, relationship.targetId]);
          if (change.operation === "ADD" && current.rows.length > 0) throw conflict("The relationship already exists.");
          if (change.operation !== "ADD" && current.rows.length === 0) throw conflict("The relationship no longer exists.");
          if (change.operation !== "ADD" && change.baseFingerprint !== undefined && current.rows.length > 0 && relationshipFingerprint(current.rows[0]) !== change.baseFingerprint) throw conflict("The relationship changed since the proposal base.");
          if (change.operation === "ADD") {
            await tx.query(
              `INSERT INTO resource_relationships (project_id, source_id, target_id, kind, source_role, target_role)
               VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (project_id, source_id, target_id) DO NOTHING`,
              [input.projectId, relationship.sourceId, relationship.targetId, relationship.kind, relationship.sourceRole ?? null, relationship.targetRole ?? null],
            );
           } else if (change.operation === "UPDATE") {
             await tx.query(
               `INSERT INTO resource_relationships (project_id, source_id, target_id, kind, source_role, target_role)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (project_id, source_id, target_id) DO UPDATE SET kind = EXCLUDED.kind, source_role = EXCLUDED.source_role, target_role = EXCLUDED.target_role`,
               [input.projectId, relationship.sourceId, relationship.targetId, relationship.kind, relationship.sourceRole ?? null, relationship.targetRole ?? null],
             );
           } else {
            await tx.query(
              `INSERT INTO resource_relationship_history (id, project_id, source_id, target_id, kind, source_role, target_role, recorded_by, operation_id)
               SELECT $1, project_id, source_id, target_id, kind, source_role, target_role, $2, $3
                 FROM resource_relationships WHERE project_id = $4 AND source_id = $5 AND target_id = $6`,
              [newId(), input.audit.actorId ?? input.audit.subjectUserId, input.batchId, input.projectId, relationship.sourceId, relationship.targetId],
            );
            await tx.query("DELETE FROM resource_relationships WHERE project_id = $1 AND source_id = $2 AND target_id = $3", [input.projectId, relationship.sourceId, relationship.targetId]);
          }
        }
        const bindingOperations = (input.semanticBindingChanges ?? []).map((change) => {
          if (change.operation === "ADD") return { operation: "create" as const, binding: { ...change.binding, projectId: input.projectId, revision: 1, status: "ACTIVE" as const, provenance: { ...change.binding.provenance, contextId: undefined, proposalId: input.promotion?.proposalId, authorId: input.audit.actorId ?? input.audit.subjectUserId ?? "system" } } };
          if (change.operation === "UPDATE") return { operation: "update" as const, expectedRevision: change.expectedRevision, binding: { ...change.binding, projectId: input.projectId, revision: change.expectedRevision + 1, status: "ACTIVE" as const, provenance: { ...change.binding.provenance, contextId: undefined, proposalId: input.promotion?.proposalId, authorId: input.audit.actorId ?? input.audit.subjectUserId ?? "system" } } };
          return { operation: "remove" as const, scope: { projectId: input.projectId, contextId: null }, id: change.bindingId, expectedRevision: change.expectedRevision };
        });
        if (bindingOperations.length) {
          for (const change of input.semanticBindingChanges ?? []) {
            if (change.operation === "ADD") continue;
            const current = await tx.query("SELECT binding FROM semantic_bindings WHERE project_id = $1 AND knowledge_context_id IS NULL AND id = $2 AND revision = $3 FOR UPDATE", [input.projectId, change.operation === "REMOVE" ? change.bindingId : change.binding.id, change.expectedRevision]);
            if (!current.rows[0]) throw conflict(`Semantic binding ${change.binding.id} changed since the proposal base.`);
            const decoded = typeof current.rows[0].binding === "string" ? JSON.parse(current.rows[0].binding) : current.rows[0].binding;
            if (JSON.stringify(decoded) !== change.baseFingerprint) throw conflict(`Semantic binding ${change.binding.id} fingerprint changed since the proposal base.`);
          }
          await applySemanticBindingOperations(tx, bindingOperations);
        }
        if (input.promotion) {
          const current = await tx.query("SELECT id, revision FROM resources WHERE project_id = $1 AND knowledge_context_id IS NULL AND lifecycle = 'ACTIVE' ORDER BY id", [input.projectId]);
          const resultingRevision = revisionFingerprint(current.rows);
          await tx.query(
              `INSERT INTO promotions (id, project_id, proposal_id, actor, base_shared_revision, base_manifest_revision, semantic_changes, semantic_bindings, resulting_shared_revision)
               VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, $9)`,
               [input.promotion.id, input.projectId, input.promotion.proposalId, JSON.stringify(input.actor), input.promotion.baseSharedRevision, input.promotion.baseManifestRevision ?? 0, JSON.stringify(input.promotion.semanticMessages ?? []), JSON.stringify(input.promotion.semanticBindings ?? []), resultingRevision],
          );
          for (const entry of input.promotion.entries) {
            await tx.query(
              `INSERT INTO promotion_entries
                (id, promotion_id, proposal_resource_id, operation, path, type, base_resource_id, base_revision, resulting_resource_id, resulting_revision, resulting_lifecycle)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [entry.id, input.promotion.id, entry.proposalResourceId, entry.operation, entry.path, entry.type, entry.baseResourceId ?? null, entry.baseRevision ?? null, entry.resultingResourceId, entry.resultingRevision, entry.resultingLifecycle],
            );
          }
          for (const change of input.promotion.relationships) {
            const relationship = change.relationship;
            await tx.query(
              `INSERT INTO promotion_relationship_changes (id, promotion_id, operation, source_id, target_id, kind, source_role, target_role, base_fingerprint)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [newId(), input.promotion.id, change.operation, relationship.sourceId, relationship.targetId, relationship.kind, relationship.sourceRole ?? null, relationship.targetRole ?? null, change.baseFingerprint ?? null],
            );
          }
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
        await tx.query("UPDATE workspace_operations SET status = 'completed', completed_at = now(), updated_at = now() WHERE batch_id = $1 AND status <> 'completed'", [batchId]);
        const pending = await tx.query("SELECT 1 FROM workspace_operations WHERE batch_id = $1 AND status <> 'completed' LIMIT 1", [batchId]);
        if (pending.rows.length > 0) return read(tx, batchId);
        await tx.query("UPDATE workspace_operation_batches SET status = 'completed', completed_at = now() WHERE id = $1", [batchId]);
        return read(tx, batchId);
      });
    },
    get(batchId) {
      return read(client, batchId);
    },
    async listIncomplete(limit = 100) {
      const rows = await client.query(
        `SELECT b.id FROM workspace_operation_batches b
          LEFT JOIN promotions p ON p.id = b.promotion_id
         WHERE b.status <> 'completed' OR p.status = 'COMMITTED_COMPLETION_PENDING'
         ORDER BY b.created_at, b.id LIMIT $1`,
        [limit],
      );
      const result: AuthoritativeBatchRecord[] = [];
      for (const row of rows.rows) {
        const record = await read(client, String(row.id));
        if (record) result.push(record);
      }
      return result;
    },
    async listSharedSemanticBindings(projectId) {
      const rows = await client.query("SELECT binding FROM semantic_bindings WHERE project_id = $1 AND knowledge_context_id IS NULL ORDER BY id", [projectId]);
      return rows.rows.map((row) => (typeof row.binding === "string" ? JSON.parse(row.binding) : row.binding) as SemanticBinding);
    },
  };
}
