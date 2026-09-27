import type { PromotionRepository } from "../application/ports/promotion-repository";
import type { Promotion, PromotionEntry, PromotionRelationshipChange, PromotionSemanticMessageChange } from "../domain/workspace/promotion";
import type { ResourceAuthorship } from "../domain/workspace/resource-revision";
import type { SqlClient } from "./sql-client";

const date = (value: unknown) => value instanceof Date ? value : new Date(String(value));

export function createPromotionRepository(client: SqlClient): PromotionRepository {
  const read = async (db: SqlClient, where: string, values: string[]): Promise<Promotion | null> => {
    const promotion = await db.query(`SELECT * FROM promotions WHERE ${where}`, values);
    const row = promotion.rows[0];
    if (!row) return null;
    const entries = await db.query("SELECT * FROM promotion_entries WHERE promotion_id = $1 ORDER BY path, id", [String(row.id)]);
    const relationships = await db.query("SELECT * FROM promotion_relationship_changes WHERE promotion_id = $1 ORDER BY id", [String(row.id)]);
    return {
      id: String(row.id), projectId: String(row.project_id), proposalId: String(row.proposal_id),
      actor: (typeof row.actor === "string" ? JSON.parse(row.actor) : row.actor) as ResourceAuthorship,
      createdAt: date(row.created_at), baseSharedRevision: String(row.base_shared_revision), baseManifestRevision: Number(row.base_manifest_revision ?? 0), resultingSharedRevision: String(row.resulting_shared_revision),
      status: row.status as Promotion["status"], ...(row.completed_at == null ? {} : { completedAt: date(row.completed_at) }),
      entries: entries.rows.map((entry): PromotionEntry => ({
        id: String(entry.id), proposalResourceId: String(entry.proposal_resource_id), operation: entry.operation as PromotionEntry["operation"], path: String(entry.path), type: entry.type as PromotionEntry["type"],
        ...(entry.base_resource_id == null ? {} : { baseResourceId: String(entry.base_resource_id) }), ...(entry.base_revision == null ? {} : { baseRevision: Number(entry.base_revision) }),
        resultingResourceId: String(entry.resulting_resource_id), resultingRevision: Number(entry.resulting_revision), resultingLifecycle: entry.resulting_lifecycle as PromotionEntry["resultingLifecycle"],
      })),
      relationships: relationships.rows.map((entry): PromotionRelationshipChange => ({
        operation: entry.operation as PromotionRelationshipChange["operation"],
        ...(entry.base_fingerprint == null ? {} : { baseFingerprint: String(entry.base_fingerprint) }),
        relationship: { kind: "complementary-view", sourceId: String(entry.source_id), targetId: String(entry.target_id), ...(entry.source_role == null ? {} : { sourceRole: String(entry.source_role) as "execution" | "causal" | "other" }), ...(entry.target_role == null ? {} : { targetRole: String(entry.target_role) as "execution" | "causal" | "other" }) },
      })),
      semanticMessages: (typeof row.semantic_changes === "string" ? JSON.parse(row.semantic_changes) : row.semantic_changes ?? []) as PromotionSemanticMessageChange[],
    };
  };
  return {
    get: (projectId, promotionId) => read(client, "project_id = $1 AND id = $2", [projectId, promotionId]),
    getForProposal: (projectId, proposalId) => read(client, "project_id = $1 AND proposal_id = $2", [projectId, proposalId]),
    async listForResource(projectId, resourceId) {
      const rows = await client.query("SELECT promotion_id FROM promotion_entries WHERE resulting_resource_id = $1", [resourceId]);
      const result: Promotion[] = [];
      for (const row of rows.rows) {
        const promotion = await read(client, "project_id = $1 AND id = $2", [projectId, String(row.promotion_id)]);
        if (promotion) result.push(promotion);
      }
      return result;
    },
    async listIncomplete(projectId) {
      const result = await client.query(
        `SELECT id FROM promotions WHERE status = 'COMMITTED_COMPLETION_PENDING' ${projectId === undefined ? "" : "AND project_id = $1"} ORDER BY created_at, id`,
        projectId === undefined ? [] : [projectId],
      );
      const promotions: Promotion[] = [];
      for (const row of result.rows) {
        const promotion = await read(client, "id = $1", [String(row.id)]);
        if (promotion) promotions.push(promotion);
      }
      return promotions;
    },
    async complete(promotionId) {
      await client.query("UPDATE promotions SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [promotionId]);
    },
  };
}
