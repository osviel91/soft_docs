export type ShareGrantState = "ACTIVE" | "REVOKED" | "EXPIRED";

export interface ProjectShareGrant {
  id: string;
  projectId: string;
  tokenHash: string;
  createdByUserId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  /** Resource ids this bearer grant is allowed to expose. */
  resourceIds: string[];
}

export function shareGrantState(grant: ProjectShareGrant, now: Date): ShareGrantState {
  if (grant.revokedAt) return "REVOKED";
  return grant.expiresAt.getTime() <= now.getTime() ? "EXPIRED" : "ACTIVE";
}
