import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ApplicationContext } from "./context";
import { conflict, forbidden, invalid, notFound } from "./errors";
import type { AuditEvent } from "./ports/audit-repository";
import type { WorkspaceInvitationRepository } from "./ports/workspace-invitation-repository";
import type { WorkspaceRepository } from "./ports/workspace-repository";
import { invitationState, type WorkspaceInvitation } from "../domain/workspace/invitation";
import { isWorkspaceRole, type WorkspaceRole } from "../domain/workspace/server-workspace";

const lifetimeMs = 7 * 24 * 60 * 60 * 1000;
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const validToken = (token: string) => /^sdi_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
export interface WorkspaceInvitationService {
  create(context: ApplicationContext, workspaceId: string, role: WorkspaceRole): Promise<{ invitation: WorkspaceInvitation; token: string }>;
  list(context: ApplicationContext, workspaceId: string): Promise<WorkspaceInvitation[]>;
  revoke(context: ApplicationContext, workspaceId: string, invitationId: string): Promise<void>;
  inspect(token: string): Promise<{ invitation: WorkspaceInvitation; state: ReturnType<typeof invitationState> } | null>;
  accept(context: ApplicationContext, token: string): Promise<WorkspaceInvitation>;
}

export function createWorkspaceInvitationService(options: { invitations: WorkspaceInvitationRepository; workspaces: WorkspaceRepository; now?: () => Date; newId?: () => string }): WorkspaceInvitationService {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const admin = async (context: ApplicationContext, workspaceId: string) => {
    const role = await options.workspaces.roleOf(workspaceId, context.principal.subjectUserId);
    if (!role) throw notFound(`No workspace with id ${workspaceId}.`);
    if (role !== "ADMIN") throw forbidden("Workspace administrator access is required.");
  };
  const event = (context: ApplicationContext, action: AuditEvent["action"], detail: AuditEvent["detail"]): AuditEvent => ({ action, subjectUserId: context.principal.subjectUserId, actorType: "user", actorId: context.principal.subjectUserId, authType: context.principal.authType, requestId: context.requestId, detail });
  return {
    async create(context, workspaceId, role) {
      await admin(context, workspaceId);
      if (!isWorkspaceRole(role)) throw invalid("The invitation role is invalid.");
      const id = newId();
      const token = `sdi_${id}.${randomBytes(32).toString("base64url")}`;
      const expiresAt = new Date(now().getTime() + lifetimeMs);
      const invitation = await options.invitations.create({ id, workspaceId, role, creatorUserId: context.principal.subjectUserId, tokenHash: tokenHash(token), expiresAt, audit: event(context, "workspace.invitation.created", { workspaceId, invitationId: id, role }) });
      return { invitation, token };
    },
    async list(context, workspaceId) { await admin(context, workspaceId); return options.invitations.list(workspaceId); },
    async revoke(context, workspaceId, invitationId) {
      await admin(context, workspaceId);
      const invitation = await options.invitations.inspect(invitationId);
      if (!invitation || invitation.workspaceId !== workspaceId) throw notFound("No invitation found.");
      if (invitationState(invitation, now()) !== "ACTIVE") throw conflict("Only an active invitation can be revoked.");
      await options.invitations.revoke(invitationId, context.principal.subjectUserId, event(context, "workspace.invitation.revoked", { workspaceId, invitationId }));
    },
    async inspect(token) {
      const match = validToken(token);
      if (!match) return null;
      const invitation = await options.invitations.inspect(match[1], tokenHash(token));
      if (!invitation) return null;
      const state = invitationState(invitation, now());
      if (state !== "ACTIVE") return null;
      return { invitation, state };
    },
    async accept(context, token) {
      const match = validToken(token);
      if (!match) throw notFound("Invitation is invalid or no longer active.");
      const eventData = event(context, "workspace.invitation.accepted", { invitationId: match[1], userId: context.principal.subjectUserId });
      try { return await options.invitations.accept(match[1], context.principal.subjectUserId, tokenHash(token), eventData); }
      catch (error) { if (error instanceof Error && error.message === "MEMBER_EXISTS") throw conflict("You are already a member of this workspace."); throw notFound("Invitation is invalid or no longer active."); }
    },
  };
}
