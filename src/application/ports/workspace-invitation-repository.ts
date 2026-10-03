import type { WorkspaceInvitation } from "../../domain/workspace/invitation";
import type { WorkspaceRole } from "../../domain/workspace/server-workspace";
import type { AuditEvent } from "./audit-repository";

export interface WorkspaceInvitationRepository {
  create(input: { id: string; workspaceId: string; role: WorkspaceRole; creatorUserId: string; tokenHash: string; expiresAt: Date; audit: AuditEvent }): Promise<WorkspaceInvitation>;
  list(workspaceId: string): Promise<WorkspaceInvitation[]>;
  inspect(id: string, tokenHash?: string): Promise<WorkspaceInvitation | null>;
  revoke(id: string, actorUserId: string, audit: AuditEvent): Promise<void>;
  accept(id: string, userId: string, tokenHash: string, audit: AuditEvent): Promise<WorkspaceInvitation>;
}
