import type { ProjectShareRepository } from "../application/ports/project-share-repository";
import type { ProjectShareGrant } from "../domain/project/share-grant";
import type { SqlClient } from "./sql-client";
import { createAuditRepository } from "./audit-repository";

function map(row: Record<string, unknown>): ProjectShareGrant {
  const date = (key: string) => row[key] instanceof Date ? row[key] as Date : new Date(String(row[key]));
  return { id: String(row.id), projectId: String(row.project_id), tokenHash: String(row.token_hash), createdByUserId: String(row.created_by_user_id), createdAt: date("created_at"), expiresAt: date("expires_at"), revokedAt: row.revoked_at == null ? null : date("revoked_at"), revokedByUserId: row.revoked_by_user_id == null ? null : String(row.revoked_by_user_id) };
}

export function createProjectShareRepository(client: SqlClient): ProjectShareRepository {
  return {
    async create(grant, event) {
      return client.transaction(async tx => {
        const r = await tx.query("INSERT INTO project_share_grants(id, project_id, token_hash, created_by_user_id, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [grant.id, grant.projectId, grant.tokenHash, grant.createdByUserId, grant.createdAt, grant.expiresAt]);
        await createAuditRepository(tx).record(event);
        return map(r.rows[0]);
      });
    },
    async list(projectId) { const r = await client.query("SELECT * FROM project_share_grants WHERE project_id = $1 ORDER BY created_at DESC, id", [projectId]); return r.rows.map(map); },
    async find(id) { const r = await client.query("SELECT * FROM project_share_grants WHERE id = $1", [id]); return r.rows[0] ? map(r.rows[0]) : null; },
    async findByToken(id, tokenHash) { const r = await client.query("SELECT * FROM project_share_grants WHERE id = $1 AND token_hash = $2", [id, tokenHash]); return r.rows[0] ? map(r.rows[0]) : null; },
    async revoke(id, actorId, event) {
      await client.transaction(async tx => {
        await tx.query("UPDATE project_share_grants SET revoked_at = now(), revoked_by_user_id = $2 WHERE id = $1 AND revoked_at IS NULL", [id, actorId]);
        await createAuditRepository(tx).record(event);
      });
    },
  };
}
