import type { SemanticBindingRepository, SemanticBindingScope } from "../application/ports/semantic-binding-repository";
import { validateSemanticBinding, type SemanticBinding } from "../domain/workspace/semantic-binding";
import type { SqlClient } from "./sql-client";

const scopeWhere = "project_id = $1 AND knowledge_context_id IS NOT DISTINCT FROM $2";
const decode = (value: unknown): SemanticBinding => (typeof value === "string" ? JSON.parse(value) : value) as SemanticBinding;

function revisionConflict(expected: number): Error {
  return new Error(`Semantic binding changed since it was read: expected revision ${expected}. Re-read it and retry.`);
}

async function appendRevision(db: SqlClient, binding: SemanticBinding): Promise<void> {
  await db.query(
    `INSERT INTO semantic_binding_revisions (project_id, knowledge_context_id, binding_id, revision, status, binding)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [binding.projectId, binding.provenance.contextId ?? null, binding.id, binding.revision, binding.status, JSON.stringify(binding)],
  );
}

/** SQL-only operation primitive for callers composing semantic changes into their transaction. */
export async function applySemanticBindingOperations(
  tx: SqlClient,
  operations: Array<
    | { operation: "create"; binding: SemanticBinding }
    | { operation: "update"; binding: SemanticBinding; expectedRevision: number }
    | { operation: "remove"; scope: SemanticBindingScope; id: string; expectedRevision: number }
    | { operation: "retire"; scope: SemanticBindingScope; id: string; expectedRevision: number }
  >,
): Promise<SemanticBinding[]> {
  const changed: SemanticBinding[] = [];
  for (const operation of operations) {
    if (operation.operation === "create") {
      const binding = operation.binding;
      validateSemanticBinding(binding);
      if (binding.revision !== 1 || binding.status !== "ACTIVE") throw new Error("A new semantic binding must be active at revision 1.");
      await tx.query(
        `INSERT INTO semantic_bindings (id, project_id, knowledge_context_id, revision, status, binding)
         VALUES ($1, $2, $3, 1, $4, $5::jsonb)`,
        [binding.id, binding.projectId, binding.provenance.contextId ?? null, binding.status, JSON.stringify(binding)],
      );
      await appendRevision(tx, binding);
      changed.push(binding);
      continue;
    }

    const scope = operation.operation === "update"
      ? { projectId: operation.binding.projectId, contextId: operation.binding.provenance.contextId ?? null }
      : operation.scope;
    const id = operation.operation === "update" ? operation.binding.id : operation.id;
    const expected = operation.expectedRevision;
    const current = await tx.query(
      `SELECT binding FROM semantic_bindings WHERE ${scopeWhere} AND id = $3 AND revision = $4`,
      [scope.projectId, scope.contextId, id, expected],
    );
    if (!current.rows[0]) throw revisionConflict(expected);
    if (operation.operation === "remove") {
      const removed = decode(current.rows[0].binding);
      const tombstone = { ...removed, revision: expected + 1, status: "RETIRED" as const };
      const result = await tx.query(
        `DELETE FROM semantic_bindings WHERE ${scopeWhere} AND id = $3 AND revision = $4 RETURNING id`,
        [scope.projectId, scope.contextId, id, expected],
      );
      if (!result.rows[0]) throw revisionConflict(expected);
      await appendRevision(tx, tombstone);
      changed.push(tombstone);
      continue;
    }
    const binding = operation.operation === "update"
      ? operation.binding
      : { ...decode(current.rows[0].binding), revision: expected + 1, status: "RETIRED" as const };
    validateSemanticBinding(binding);
    if (binding.revision !== expected + 1) throw new Error("Semantic binding revision must increment by one.");
    const saved = await tx.query(
      `UPDATE semantic_bindings SET revision = $5, status = $6, binding = $7::jsonb, updated_at = now()
       WHERE ${scopeWhere} AND id = $3 AND revision = $4 RETURNING id`,
      [scope.projectId, scope.contextId, id, expected, binding.revision, binding.status, JSON.stringify(binding)],
    );
    if (!saved.rows[0]) throw revisionConflict(expected);
    await appendRevision(tx, binding);
    changed.push(binding);
  }
  return changed;
}

export function createSemanticBindingRepository(client: SqlClient): SemanticBindingRepository {
  const retire = async (scope: SemanticBindingScope, id: string, expectedRevision: number) =>
    (await client.transaction((tx) => applySemanticBindingOperations(tx, [{ operation: "retire", scope, id, expectedRevision }])))[0];
  return {
    async list(scope) {
      const result = await client.query(`SELECT binding FROM semantic_bindings WHERE ${scopeWhere} ORDER BY id`, [scope.projectId, scope.contextId]);
      return result.rows.map((row) => decode(row.binding));
    },
    async get(scope, id) {
      const result = await client.query(`SELECT binding FROM semantic_bindings WHERE ${scopeWhere} AND id = $3`, [scope.projectId, scope.contextId, id]);
      return result.rows[0] ? decode(result.rows[0].binding) : null;
    },
    async history(scope, id) {
      const result = await client.query(
        `SELECT binding FROM semantic_binding_revisions WHERE ${scopeWhere} AND binding_id = $3 ORDER BY revision`,
        [scope.projectId, scope.contextId, id],
      );
      return result.rows.map((row) => decode(row.binding));
    },
    async create(binding) {
      return (await client.transaction((tx) => applySemanticBindingOperations(tx, [{ operation: "create", binding }])))[0];
    },
    async update(scope, binding, expectedRevision) {
      if (binding.projectId !== scope.projectId || (binding.provenance.contextId ?? null) !== scope.contextId) throw new Error("Semantic binding scope does not match the requested scope.");
      return (await client.transaction((tx) => applySemanticBindingOperations(tx, [{ operation: "update", binding, expectedRevision }])))[0];
    },
    async remove(scope, id, expectedRevision) {
      return (await client.transaction((tx) => applySemanticBindingOperations(tx, [{ operation: "remove", scope, id, expectedRevision }])))[0];
    },
    retire,
  };
}
