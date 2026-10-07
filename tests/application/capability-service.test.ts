import { describe, expect, it } from "vitest";
import { createCapabilityService } from "../../src/application/capability-service";
import type { ApplicationContext } from "../../src/application/context";
import type { AuthorizationPolicy } from "../../src/application/authorization";
import type { ServerProject } from "../../src/domain/project/server-project";
import type { Permission } from "../../src/domain/access/permissions";
import type { WorkspaceAdminGovernance, WorkspaceSelfReviewPolicy } from "../../src/application/authorization";

const project: ServerProject = {
  id: "p1", workspaceId: "w1", ownerId: "owner", name: "Project", slug: "project",
  createdAt: new Date(0), updatedAt: new Date(0),
};

function context(userId: string, scopes: Permission[] = [], authType: "session" | "pat" = "session"): ApplicationContext {
  return { requestId: "test", principal: { subjectUserId: userId, actor: { kind: "user", userId }, authType, scopes } };
}

function policy(role: "OWNER" | "EDITOR" | "VIEWER" | null = "OWNER"): AuthorizationPolicy<ServerProject> {
  return {
    decide: async (ctx, projectId, permission) => {
      if (projectId !== project.id || role === null) return { allowed: false, reason: "not_found", role: null, missing: permission };
      if (ctx.principal.authType !== "session" && !ctx.principal.scopes.includes(permission)) return { allowed: false, reason: "scope", role: null, missing: permission };
      const allowed = role === "OWNER" || (role === "EDITOR" && !["project:delete", "project:members:write", "promotion:execute"].includes(permission)) || (role === "VIEWER" && permission === "project:read");
      return allowed ? { allowed: true, role, project } : { allowed: false, reason: "forbidden", role, missing: permission };
    },
    requirePermission: async () => { throw new Error("not used"); },
    hasRole: async () => role === "OWNER",
  };
}

function service(role: "OWNER" | "EDITOR" | "VIEWER" | null, privateOwner = "owner", lifecycle: "active" | "archived" = "active", promotionEligible = true, blockerCode: "STALE_BASE" | "REVIEW_REQUIRED" = "STALE_BASE", workspaceAdmin?: WorkspaceAdminGovernance, workspaceSelfReview?: WorkspaceSelfReviewPolicy) {
  return createCapabilityService({
    policy: policy(role),
    knowledgeContexts: {
      listPrivate: async () => [],
      findPrivate: async (_projectId, contextId, ownerUserId) => ownerUserId === privateOwner && contextId === "work" ? { kind: "private-work", id: "work", projectId: "p1", ownerUserId, name: "Work", lifecycle, createdAt: new Date(0), updatedAt: new Date(0) } : null,
      createPrivate: async () => { throw new Error("not used"); }, updatePrivate: async () => { throw new Error("not used"); }, deletePrivate: async () => {},
      listPrivateMessages: async () => [], createPrivateMessage: async () => { throw new Error("not used"); }, updatePrivateMessages: async () => [],
    },
    proposals: { get: async () => ({ id: "proposal", projectId: "p1", authorUserId: "author", sourcePrivateContextId: "work", title: "Proposal", status: "open", baseSharedRevision: "r1", baseSharedResourceRevisions: {}, baseManifestRevision: 1, createdAt: new Date(0), submittedAt: new Date(0), resources: [], semanticMessages: [], relationships: [], semanticBindings: [] }), list: async () => [], submit: async () => { throw new Error("not used"); }, hasForContext: async () => false, currentSharedRevision: async () => ({ revision: "r1", resources: {} }) },
    promotion: { preview: async () => ({ proposalId: "proposal", projectId: "p1", reviewStatus: blockerCode === "REVIEW_REQUIRED" ? "none" : "approved", eligible: promotionEligible, blockers: promotionEligible ? [] : [{ code: blockerCode, message: blockerCode === "REVIEW_REQUIRED" ? "review required" : "stale" }], baseSharedRevision: "r1", currentSharedRevision: "r1", staleBase: false, creates: [], updates: [], retires: [], semanticIdentityAdditions: [], semanticIdentityReuses: [], semanticChanges: [], relationships: [], semanticBindings: [] }), execute: async () => { throw new Error("not used"); }, recover: async () => ({ examined: 0, completed: 0, pending: 0 }) },
    workspaceAdmin,
    workspaceSelfReview,
  });
}

describe("capability service", () => {
  it("intersects role permissions with private-work ownership", async () => {
    const capabilities = service("OWNER");
    const own = await capabilities.privateWork(context("owner"), "p1", "work");
    const other = await capabilities.privateWork(context("other"), "p1", "work");
    expect(own["privateWork.edit"].allowed).toBe(true);
    expect(own["proposal.submit"].allowed).toBe(true);
    expect(other["privateWork.edit"]).toMatchObject({ allowed: false, reason: "not_owner" });
    expect(other["proposal.submit"]).toMatchObject({ allowed: false, reason: "not_owner" });
  });

  it("keeps promotion distinct from editor permissions and readiness", async () => {
    const editor = await service("EDITOR").proposal(context("editor"), "p1", "proposal");
    expect(editor["proposal.review"].allowed).toBe(true);
    expect(editor["proposal.promote"]).toMatchObject({ allowed: false, reason: "forbidden", requiredRole: "OWNER" });

    const owner = await service("OWNER", "owner", "active", false).proposal(context("owner"), "p1", "proposal");
    expect(owner["proposal.promote"]).toMatchObject({ allowed: false, reason: "proposal_not_eligible", state: "STALE_BASE" });
  });

  it("allows workspace admins with project visibility to review and promote without elevating their project role", async () => {
    const workspaceAdmin: WorkspaceAdminGovernance = async (_context, projectId, permission) => projectId === "p1" && ["resource:update", "promotion:execute"].includes(permission);
    const capabilities = await service("VIEWER", "owner", "active", true, "STALE_BASE", workspaceAdmin).proposal(context("admin"), "p1", "proposal");
    expect(capabilities["proposal.review"]).toMatchObject({ allowed: true, requiredWorkspaceRole: "ADMIN" });
    expect(capabilities["proposal.promote"]).toMatchObject({ allowed: true, requiredWorkspaceRole: "ADMIN" });

    const author = await service("VIEWER", "owner", "active", true, "STALE_BASE", workspaceAdmin).proposal(context("author"), "p1", "proposal");
    expect(author["proposal.review"]).toMatchObject({ allowed: false, reason: "self_review" });
    const ordinaryViewer = await service("VIEWER").proposal(context("viewer"), "p1", "proposal");
    expect(ordinaryViewer["proposal.review"]).toMatchObject({ allowed: false, reason: "forbidden" });
  });

  it("denies proposal authors self-review while allowing another authorized reviewer", async () => {
    const author = await service("OWNER", "author", "active", false, "REVIEW_REQUIRED").proposal(context("author"), "p1", "proposal");
    expect(author["proposal.review"]).toMatchObject({ allowed: false, reason: "self_review", requiredPermission: "resource:update" });
    expect(author["proposal.previewPromotion"]).toMatchObject({ allowed: true, requiredPermission: "project:read" });
    expect(author["proposal.promote"]).toMatchObject({ allowed: false, reason: "review_required", state: "REVIEW_REQUIRED" });

    const reviewer = await service("EDITOR").proposal(context("reviewer"), "p1", "proposal");
    expect(reviewer["proposal.review"]).toMatchObject({ allowed: true, requiredPermission: "resource:update" });
  });

  it("reports author approval as available when the workspace policy enables it", async () => {
    const capabilities = await service("OWNER", "author", "active", true, "STALE_BASE", undefined, async () => true).proposal(context("author"), "p1", "proposal");
    expect(capabilities["proposal.review"]).toMatchObject({ allowed: true, requiredPermission: "resource:update" });
  });

  it("intersects PAT scopes with the project role", async () => {
    const readOnlyPat = await service("OWNER").project(context("owner", ["project:read"], "pat"), "p1");
    expect(readOnlyPat["shared.read"].allowed).toBe(true);
    expect(readOnlyPat["privateWork.create"].allowed).toBe(true);
    expect(readOnlyPat["project.delete"]).toMatchObject({ allowed: false, reason: "scope" });
  });

  it("is advisory when authoritative state changes", async () => {
    const capabilities = service("OWNER", "owner", "active", true);
    const first = await capabilities.proposal(context("owner"), "p1", "proposal");
    expect(first["proposal.promote"].allowed).toBe(true);
    const second = await service("OWNER", "owner", "active", false).proposal(context("owner"), "p1", "proposal");
    expect(second["proposal.promote"].allowed).toBe(false);
  });
});
