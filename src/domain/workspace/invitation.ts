import type { WorkspaceRole } from "./server-workspace";

export type WorkspaceInvitationState = "ACTIVE" | "ACCEPTED" | "REVOKED" | "EXPIRED";

export interface WorkspaceInvitation {
  id: string;
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
  creatorUserId: string;
  creatorName: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedBy: string | null;
  revokedAt: Date | null;
  revokedBy: string | null;
}

export function invitationState(invitation: WorkspaceInvitation, now: Date): WorkspaceInvitationState {
  if (invitation.acceptedAt) return "ACCEPTED";
  if (invitation.revokedAt) return "REVOKED";
  return invitation.expiresAt.getTime() <= now.getTime() ? "EXPIRED" : "ACTIVE";
}
