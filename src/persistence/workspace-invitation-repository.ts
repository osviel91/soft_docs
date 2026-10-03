import type { WorkspaceInvitationRepository } from "../application/ports/workspace-invitation-repository";
import type { WorkspaceRole } from "../domain/workspace/server-workspace";
import type { WorkspaceInvitation } from "../domain/workspace/invitation";
import type { SqlClient } from "./sql-client";
import { createAuditEventWriter } from "./audit-repository";
import { constantTimeEquals } from "./constant-time";

const insertAudit = createAuditEventWriter();

export function createWorkspaceInvitationRepository(client: SqlClient): WorkspaceInvitationRepository {
  const map = (row: Record<string, unknown>): WorkspaceInvitation => ({
    id: String(row.id), workspaceId: String(row.workspace_id), workspaceName: String(row.workspace_name),
    role: String(row.role) as WorkspaceRole, creatorUserId: String(row.creator_user_id), creatorName: String(row.creator_name),
    createdAt: new Date(String(row.created_at)), expiresAt: new Date(String(row.expires_at)),
    acceptedAt: row.accepted_at ? new Date(String(row.accepted_at)) : null,
    acceptedBy: row.accepted_by === null ? null : String(row.accepted_by),
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null,
    revokedBy: row.revoked_by === null ? null : String(row.revoked_by),
  });
  const select = `SELECT i.*, w.name AS workspace_name, u.display_name AS creator_name
    FROM workspace_invitations i JOIN workspaces w ON w.id=i.workspace_id
    JOIN users u ON u.id=i.creator_user_id`;
  return {
    async create(input) {
      return client.transaction(async tx => {
        await tx.query(`INSERT INTO workspace_invitations (id,workspace_id,role,creator_user_id,token_hash,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6)`, [input.id,input.workspaceId,input.role,input.creatorUserId,input.tokenHash,input.expiresAt]);
        await insertAudit(tx, input.audit);
        const result = await tx.query(`${select} WHERE i.id=$1`, [input.id]);
        return map(result.rows[0]);
      });
    },
    async list(workspaceId) {
      const result = await client.query(`${select} WHERE i.workspace_id=$1 ORDER BY i.created_at DESC LIMIT 100`, [workspaceId]);
      return result.rows.map(map);
    },
    async inspect(id, tokenHash) {
      const result = await client.query(`${select} WHERE i.id=$1${tokenHash === undefined ? "" : " AND i.token_hash=$2"}`, tokenHash === undefined ? [id] : [id, tokenHash]);
      return result.rows[0] && (tokenHash === undefined || constantTimeEquals(String(result.rows[0].token_hash), tokenHash)) ? map(result.rows[0]) : null;
    },
    async revoke(id, actorUserId, audit) {
      await client.transaction(async tx => {
        const result = await tx.query(`UPDATE workspace_invitations SET revoked_at=now(),revoked_by=$2
          WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() RETURNING id`, [id,actorUserId]);
        if (!result.rows[0]) throw new Error("INVITATION_INACTIVE");
        await insertAudit(tx, audit);
      });
    },
    async accept(id, userId, tokenHash, audit) {
      return client.transaction(async tx => {
        const result = await tx.query(`SELECT * FROM workspace_invitations WHERE id=$1 FOR UPDATE`, [id]);
        const row = result.rows[0];
        if (!row || !constantTimeEquals(String(row.token_hash ?? ""), tokenHash) || row.accepted_at || row.revoked_at || new Date(String(row.expires_at)).getTime() <= Date.now()) throw new Error("INVITATION_INACTIVE");
        const workspaceId = String(row.workspace_id);
        const role = String(row.role) as WorkspaceRole;
        const existing = await tx.query(`SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, [workspaceId,userId]);
        if (existing.rows[0]) throw new Error("MEMBER_EXISTS");
        await tx.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)`, [workspaceId,userId,role]);
        await tx.query(`UPDATE workspace_invitations SET accepted_at=now(),accepted_by=$2 WHERE id=$1`, [id,userId]);
        await insertAudit(tx, audit);
        await insertAudit(tx, { ...audit, action: "workspace.member.added", detail: { workspaceId, invitationId: id, role, userId } });
        const joined = await tx.query(`${select} WHERE i.id=$1`, [id]);
        return map(joined.rows[0]);
      });
    },
  };
}
