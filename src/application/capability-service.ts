import type { ApplicationContext } from "./context";
import type { AuthorizationPolicy } from "./authorization";
import type { Permission, ProjectRole } from "../domain/access/permissions";
import type { ServerProject } from "../domain/project/server-project";
import type { KnowledgeContextRepository } from "./ports/knowledge-context-repository";
import type { ArchitecturalProposalRepository } from "./ports/architectural-proposal-repository";
import type { PromotionService } from "./promotion-service";

export type Capability =
  | "shared.read"
  | "privateWork.create"
  | "privateWork.open"
  | "privateWork.edit"
  | "proposal.submit"
  | "proposal.review"
  | "proposal.previewPromotion"
  | "proposal.promote"
  | "project.delete"
  | "project.members.manage";

export type CapabilityReason =
  | "restricted"
  | "scope"
  | "forbidden"
  | "not_owner"
  | "self_review"
  | "archived_context"
  | "proposal_not_eligible"
  | "review_required"
  | "promotion_in_progress"
  | "completion_pending"
  | "conflict";

export interface CapabilityDecision {
  capability: Capability;
  allowed: boolean;
  reason?: CapabilityReason;
  requiredPermission?: Permission;
  requiredRole?: ProjectRole;
  state?: string;
}

export interface CapabilityService {
  project(context: ApplicationContext, projectId: string): Promise<Pick<Record<Capability, CapabilityDecision>, "shared.read" | "privateWork.create" | "project.delete" | "project.members.manage">>;
  privateWork(context: ApplicationContext, projectId: string, contextId: string): Promise<Pick<Record<Capability, CapabilityDecision>, "privateWork.open" | "privateWork.edit" | "proposal.submit">>;
  proposal(context: ApplicationContext, projectId: string, proposalId: string): Promise<Pick<Record<Capability, CapabilityDecision>, "proposal.review" | "proposal.previewPromotion" | "proposal.promote">>;
}

type Decision = Omit<CapabilityDecision, "capability">;

export function createCapabilityService(options: {
  policy: AuthorizationPolicy<ServerProject>;
  knowledgeContexts: KnowledgeContextRepository;
  proposals: ArchitecturalProposalRepository;
  promotion: PromotionService;
}): CapabilityService {
  const permission = async (context: ApplicationContext, projectId: string, capability: Capability, requiredPermission: Permission): Promise<CapabilityDecision> => {
    const outcome = await options.policy.decide(context, projectId, requiredPermission);
    if (outcome.allowed) return { capability, allowed: true, requiredPermission };
    if (outcome.reason === "not_found" || outcome.reason === "restricted") {
      return { capability, allowed: false, requiredPermission };
    }
    return { capability, allowed: false, reason: outcome.reason, requiredPermission, ...(outcome.role === null ? {} : { requiredRole: outcome.role }) };
  };

  const ownerContext = async (context: ApplicationContext, projectId: string, contextId: string): Promise<{ context: Awaited<ReturnType<KnowledgeContextRepository["findPrivate"]>>; reason?: CapabilityReason }> => {
    const privateContext = await options.knowledgeContexts.findPrivate(projectId, contextId, context.principal.subjectUserId);
    return privateContext ? { context: privateContext } : { context: null, reason: "not_owner" };
  };

  const withContext = (capability: Capability, base: Decision, _privateContext: Awaited<ReturnType<KnowledgeContextRepository["findPrivate"]>>, reason?: CapabilityReason): CapabilityDecision => ({ capability, ...base, ...(reason === undefined ? {} : { reason }) });

  return {
    async project(context, projectId) {
      const capabilities = {} as Record<Capability, CapabilityDecision>;
      for (const [capability, requiredPermission] of [
        ["shared.read", "project:read"],
        ["privateWork.create", "project:read"],
        ["project.delete", "project:delete"],
        ["project.members.manage", "project:members:write"],
      ] as const) capabilities[capability] = await permission(context, projectId, capability, requiredPermission);
      return capabilities;
    },

    async privateWork(context, projectId, contextId) {
      const read = await permission(context, projectId, "privateWork.open", "project:read");
      const found = await ownerContext(context, projectId, contextId);
      const open = found.context ? { ...read, allowed: read.allowed && found.reason === undefined } : { ...read, allowed: false, reason: found.reason };
      const edit = withContext("privateWork.edit", { allowed: open.allowed, requiredPermission: "project:read" }, found.context, found.reason);
      const submitBase = await permission(context, projectId, "proposal.submit", "resource:update");
      const submit = found.context
        ? { ...submitBase, allowed: submitBase.allowed && found.context.lifecycle === "active", ...(found.context.lifecycle === "archived" ? { reason: "archived_context" as const } : {}) }
        : { ...submitBase, allowed: false, reason: found.reason };
      return { "privateWork.open": open, "privateWork.edit": edit, "proposal.submit": submit };
    },

    async proposal(context, projectId, proposalId) {
      const proposal = await options.proposals.get(projectId, proposalId);
      if (!proposal) {
        return {
          "proposal.review": { capability: "proposal.review", allowed: false, reason: "proposal_not_eligible" },
          "proposal.previewPromotion": { capability: "proposal.previewPromotion", allowed: false, reason: "proposal_not_eligible", requiredPermission: "project:read" },
          "proposal.promote": { capability: "proposal.promote", allowed: false, reason: "proposal_not_eligible", requiredPermission: "promotion:execute" },
        };
      }
      const review = await permission(context, projectId, "proposal.review", "resource:update");
      if (review.allowed && proposal.authorUserId === context.principal.subjectUserId) {
        review.allowed = false;
        review.reason = "self_review";
      }
      const preview = await permission(context, projectId, "proposal.previewPromotion", "project:read");
      const promotePermission = await permission(context, projectId, "proposal.promote", "promotion:execute");
      if (!promotePermission.allowed) return { "proposal.review": review, "proposal.previewPromotion": preview, "proposal.promote": { ...promotePermission, ...(promotePermission.reason === "forbidden" ? { requiredRole: "OWNER" as const } : {}) } };
      if (!preview.allowed) return { "proposal.review": review, "proposal.previewPromotion": preview, "proposal.promote": { capability: "proposal.promote", allowed: false, reason: preview.reason, requiredPermission: "project:read" } };
      const authorization = await options.policy.decide(context, projectId, "promotion:execute");
      if (!authorization.allowed || authorization.role !== "OWNER") {
        return { "proposal.review": review, "proposal.previewPromotion": preview, "proposal.promote": { capability: "proposal.promote", allowed: false, reason: "forbidden", requiredPermission: "promotion:execute", requiredRole: "OWNER" } };
      }
      const promotion = await options.promotion.preview(context, projectId, proposalId);
      const blocker = promotion.blockers[0];
      return {
        "proposal.review": review,
        "proposal.previewPromotion": preview,
        "proposal.promote": blocker
          ? { capability: "proposal.promote", allowed: false, reason: blocker.code === "REVIEW_REQUIRED" ? "review_required" : blocker.code === "COMPLETION_PENDING" ? "completion_pending" : blocker.code.includes("STALE") ? "proposal_not_eligible" : "conflict", requiredPermission: "promotion:execute", requiredRole: "OWNER", state: blocker.code }
          : { capability: "proposal.promote", allowed: true, requiredPermission: "promotion:execute", requiredRole: "OWNER" },
      };
    },
  };
}
