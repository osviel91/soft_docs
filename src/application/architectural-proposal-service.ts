import type { ApplicationContext } from "./context";
import { actorIdOf, actorTypeOf, credentialIdOf } from "./context";
import { conflict, invalid, notFound } from "./errors";
import type { AuthorizationPolicy } from "./authorization";
import { createAuthorizationPolicy } from "./authorization";
import type { ServerProject } from "../domain/project/server-project";
import type { ProjectRepository } from "./ports/project-repository";
import type { KnowledgeContextRepository } from "./ports/knowledge-context-repository";
import type { AuditRepository } from "./ports/audit-repository";
import type { ArchitecturalProposalRepository } from "./ports/architectural-proposal-repository";
import type { ArchitecturalProposal, ArchitecturalProposalSummary, ProposalRelationshipSnapshot, ProposalSemanticMessageSnapshot, ProposalReview, ProposalReviewDecision, ProposalReviewSummary } from "../domain/workspace/architectural-proposal";
import type { ProjectStorage } from "./project-storage";
import { createEmptyMetadata, parseProjectMetadata, type ProjectMetadata } from "../domain/workspace/metadata";
import { analyzeResource } from "../domain/project/resource-analysis";
import { buildProjectIndex, type ProjectDiagnostic, type ProjectIndex } from "../domain/project/project-index";
import { validateProject } from "../domain/project/validate";
import { traceArchitectureQuery, type ArchitectureTrace, type TraceDirection } from "../domain/project/architecture-trace";

export type PublicArchitecturalProposal = Omit<ArchitecturalProposal, "sourcePrivateContextId" | "semanticMessages" | "relationships"> & {
  semanticMessages: Array<Omit<ProposalSemanticMessageSnapshot, "sourceContextId">>;
  relationships: Array<Omit<ProposalRelationshipSnapshot, "sourceContextId" | "contextId">>;
};
export type PublicArchitecturalProposalSummary = Omit<ArchitecturalProposalSummary, "sourcePrivateContextId">;

function publicProposal(proposal: ArchitecturalProposal): PublicArchitecturalProposal {
  const { id, projectId, authorUserId, title, description, status, baseSharedRevision, baseSharedResourceRevisions, createdAt, submittedAt, resources, semanticMessages, relationships } = proposal;
  return {
    id, projectId, authorUserId, title, ...(description === undefined ? {} : { description }), status, baseSharedRevision, baseSharedResourceRevisions, createdAt, submittedAt, resources,
    semanticMessages: semanticMessages.map(({ id: messageId, name, kind }) => ({ id: messageId, name, kind })),
    relationships: relationships.map((relationship) => ({ sourceId: relationship.sourceId, targetId: relationship.targetId, kind: relationship.kind, ...(relationship.sourceRole === undefined ? {} : { sourceRole: relationship.sourceRole }), ...(relationship.targetRole === undefined ? {} : { targetRole: relationship.targetRole }) })),
  };
}

function publicSummary(summary: ArchitecturalProposalSummary): PublicArchitecturalProposalSummary {
  const { id, projectId, authorUserId, title, description, status, baseSharedRevision, baseSharedResourceRevisions, createdAt, submittedAt, staleBase, currentSharedRevision } = summary;
  return { id, projectId, authorUserId, title, ...(description === undefined ? {} : { description }), status, baseSharedRevision, baseSharedResourceRevisions, createdAt, submittedAt, staleBase, currentSharedRevision };
}

export interface ArchitecturalProposalService {
  list(context: ApplicationContext, projectId: string): Promise<PublicArchitecturalProposalSummary[]>;
  get(context: ApplicationContext, projectId: string, proposalId: string): Promise<PublicArchitecturalProposal & { staleBase: boolean; currentSharedRevision: string }>;
  submit(context: ApplicationContext, input: { projectId: string; sourcePrivateContextId: string; resourceIds: string[]; retireResourceIds?: string[]; title: string; description?: string }): Promise<PublicArchitecturalProposal>;
  validate(context: ApplicationContext, projectId: string, proposalId: string): Promise<{ diagnostics: ProjectDiagnostic[]; index: ProjectIndex }>;
  trace(context: ApplicationContext, projectId: string, proposalId: string, input: { messageId: string; direction: TraceDirection; maxDepth: number; maxNodes: number; includeCandidates: boolean; includeRecovery: boolean }): Promise<{ trace: ArchitectureTrace | null; resolution: unknown }>;
  reviews(context: ApplicationContext, projectId: string, proposalId: string): Promise<ProposalReviewSummary>;
  review(context: ApplicationContext, input: { projectId: string; proposalId: string; decision: ProposalReviewDecision; summary?: string }): Promise<ProposalReview>;
}

export function createArchitecturalProposalService(options: {
  proposals: ArchitecturalProposalRepository;
  projects: ProjectRepository;
  knowledgeContexts: KnowledgeContextRepository;
  audit?: AuditRepository;
  reviews?: import("./ports/proposal-review-repository").ProposalReviewRepository;
  policy?: AuthorizationPolicy<ServerProject>;
  storage?: (projectId: string) => ProjectStorage;
}): ArchitecturalProposalService {
  const policy = options.policy ?? createAuthorizationPolicy<ServerProject>(options.projects);
  const requireRead = (context: ApplicationContext, projectId: string) => policy.requirePermission(context, projectId, "project:read");
  const indexFor = async (proposal: ArchitecturalProposal): Promise<ProjectIndex> => {
    const shared = await options.projects.listResources(proposal.projectId, null);
    const sharedFiles = await Promise.all(shared.map(async (resource) => ({ resource, revision: await options.projects.getRevision(resource.id, resource.revision) })));
    const metadata: ProjectMetadata = createEmptyMetadata();
    if (options.storage) {
      const stored = await options.storage(proposal.projectId).read("project.json");
      if (stored.ok && stored.value) {
        try {
          Object.assign(metadata, parseProjectMetadata(JSON.parse(stored.value.content)) ?? {});
        } catch {
          // The normal validation surface reports malformed shared metadata.
        }
      }
    }
    const proposalMessages = proposal.semanticMessages.map(({ id, name, kind }) => ({ id, name, kind }));
    metadata.semanticMessages = proposalMessages;
    const files = [
      ...sharedFiles.flatMap(({ resource, revision }) => revision ? [{ descriptor: { id: resource.id, projectId: proposal.projectId, path: resource.path, type: resource.type, title: resource.path, provenance: { kind: "shared" as const, id: `shared:${proposal.projectId}` } }, content: revision.content }] : []),
      ...proposal.resources.map((resource) => ({ descriptor: { id: resource.sourceResourceId, projectId: proposal.projectId, path: resource.path, type: resource.type, title: resource.path, provenance: { kind: "proposal" as const, id: proposal.id, label: proposal.title } }, content: resource.content })),
    ];
    return buildProjectIndex(proposal.projectId, files.map(({ descriptor, content }) => analyzeResource(descriptor, content)), metadata, (core) => validateProject(core, [], metadata));
  };

  return {
    async list(context, projectId) {
      await requireRead(context, projectId);
      const proposals = await options.proposals.list(projectId);
      return Promise.all(proposals.map(async (proposal) => {
        const summary = publicSummary(proposal);
        if (!options.reviews) return summary;
        const entries = await options.reviews.list(proposal.id);
        const latest = new Map<string, ProposalReview>();
        for (const entry of entries) latest.set(entry.reviewerUserId, entry);
        const effective = [...latest.values()];
        const approvals = effective.filter((entry) => entry.decision === "APPROVE").length;
        const changesRequested = effective.filter((entry) => entry.decision === "REQUEST_CHANGES").length;
        const reviewStatus = effective.length === 0 ? "none" : approvals > 0 && changesRequested > 0 ? "mixed" : approvals > 0 ? "approved" : "changes-requested";
        return { ...summary, reviewStatus, approvals, changesRequested };
      }));
    },
    async get(context, projectId, proposalId) {
      await requireRead(context, projectId);
      const proposal = await options.proposals.get(projectId, proposalId);
      if (!proposal) throw notFound(`No architectural proposal with id ${proposalId}.`);
      const current = await options.proposals.currentSharedRevision(projectId);
      return { ...publicProposal(proposal), staleBase: proposal.baseSharedRevision !== current.revision, currentSharedRevision: current.revision };
    },
    async submit(context, input) {
      await requireRead(context, input.projectId);
      const source = await options.knowledgeContexts.findPrivate(input.projectId, input.sourcePrivateContextId, context.principal.subjectUserId);
      if (!source) throw notFound(`No private work context with id ${input.sourcePrivateContextId}.`);
      if (source.lifecycle !== "active") throw invalid("Archived private work cannot be submitted.");
      const title = input.title.trim();
      if (!title) throw invalid("A proposal title is required.");
      const ids = [...new Set(input.resourceIds)];
      const retireIds = [...new Set(input.retireResourceIds ?? [])];
      if (ids.length === 0 && retireIds.length === 0) throw invalid("Select at least one private resource or explicit retirement target.");
      const resources = await options.projects.listResources(input.projectId, source.id);
      const selected = resources.filter((resource) => ids.includes(resource.id));
      if (selected.length !== ids.length) throw notFound("One or more selected private resources are not available.");
      const privateMessages = await options.knowledgeContexts.listPrivateMessages(input.projectId, source.id);
      const currentContents = await Promise.all(selected.map(async (resource) => (await options.projects.getRevision(resource.id, resource.revision))?.content ?? ""));
      const privateMessageIds = privateMessages.filter((message) => currentContents.some((content) => content.includes(message.id))).map((message) => message.id);
      const base = await options.proposals.currentSharedRevision(input.projectId);
      const shared = await options.projects.listResources(input.projectId, null);
      const retirementTargets = shared.filter((resource) => retireIds.includes(resource.id));
      if (retirementTargets.length !== retireIds.length) throw notFound("One or more retirement targets are not active SHARED resources.");
      let proposal: ArchitecturalProposal;
      try {
        proposal = await options.proposals.submit({
          projectId: input.projectId, authorUserId: context.principal.subjectUserId, sourcePrivateContextId: source.id,
          title, ...(input.description === undefined ? {} : { description: input.description }),
           selections: selected.map((resource) => ({ resourceId: resource.id, expectedRevision: resource.revision })),
           retirements: retirementTargets.map((resource) => ({ resourceId: resource.id, expectedRevision: resource.revision })), privateMessageIds,
          baseSharedRevision: base.revision, baseSharedResourceRevisions: base.resources,
        });
      } catch (error) {
        throw conflict(error instanceof Error ? error.message : "Private work changed during proposal submission.");
      }
      await options.audit?.record({
        action: "proposal.submitted", subjectUserId: context.principal.subjectUserId,
        actorType: actorTypeOf(context.principal), actorId: actorIdOf(context.principal), credentialId: credentialIdOf(context.principal),
        authType: context.principal.authType, projectId: input.projectId, resourceId: null, requestId: context.requestId,
         detail: { proposalId: proposal.id, sourcePrivateContextId: source.id, resourceIds: proposal.resources.map((resource) => resource.sourceResourceId), retirementResourceIds: retireIds, baseSharedRevision: proposal.baseSharedRevision },
      });
      return publicProposal(proposal);
    },
    async validate(context, projectId, proposalId) {
      await requireRead(context, projectId);
      const proposal = await options.proposals.get(projectId, proposalId);
      if (!proposal) throw notFound(`No architectural proposal with id ${proposalId}.`);
      const index = await indexFor(proposal);
      return { diagnostics: index.diagnostics, index };
    },
    async trace(context, projectId, proposalId, input) {
      await requireRead(context, projectId);
      const proposal = await options.proposals.get(projectId, proposalId);
      if (!proposal) throw notFound(`No architectural proposal with id ${proposalId}.`);
      const index = await indexFor(proposal);
      return traceArchitectureQuery(index, { messageId: input.messageId }, input);
    },
    async reviews(context, projectId, proposalId) {
      await requireRead(context, projectId);
      const proposal = await options.proposals.get(projectId, proposalId);
      if (!proposal) throw notFound(`No architectural proposal with id ${proposalId}.`);
      const reviews = options.reviews ? await options.reviews.list(proposalId) : [];
      const latest = new Map<string, ProposalReview>();
      for (const item of reviews) latest.set(item.reviewerUserId, item);
      const effective = [...latest.values()];
      const approvals = effective.filter((item) => item.decision === "APPROVE").length;
      const changesRequested = effective.filter((item) => item.decision === "REQUEST_CHANGES").length;
      const status = effective.length === 0 ? "none" : approvals > 0 && changesRequested > 0 ? "mixed" : approvals > 0 ? "approved" : "changes-requested";
      return { status, approvals, changesRequested, reviews };
    },
    async review(context, input) {
      await policy.requirePermission(context, input.projectId, "resource:update");
      if (!options.reviews) throw invalid("Proposal reviews are not configured.");
      const proposal = await options.proposals.get(input.projectId, input.proposalId);
      if (!proposal) throw notFound(`No architectural proposal with id ${input.proposalId}.`);
      if (input.decision === "APPROVE" && proposal.authorUserId === context.principal.subjectUserId) throw invalid("Proposal authors cannot approve their own proposal.");
      const summary = input.summary?.trim();
      if (summary !== undefined && summary.length > 4000) throw invalid("Review summary must be 4000 characters or fewer.");
      const current = await options.proposals.currentSharedRevision(input.projectId);
      const review = await options.reviews.submit({
        proposalId: proposal.id, reviewerUserId: context.principal.subjectUserId, decision: input.decision,
        ...(summary ? { summary } : {}), proposalBaseRevision: proposal.baseSharedRevision, observedSharedRevision: current.revision,
      });
      await options.audit?.record({
        action: "proposal.reviewed", subjectUserId: context.principal.subjectUserId,
        actorType: actorTypeOf(context.principal), actorId: actorIdOf(context.principal), credentialId: credentialIdOf(context.principal),
        authType: context.principal.authType, projectId: input.projectId, resourceId: null, requestId: context.requestId,
        detail: { proposalId: proposal.id, reviewId: review.id, decision: review.decision, proposalBaseRevision: review.proposalBaseRevision, observedSharedRevision: review.observedSharedRevision },
      });
      return review;
    },
  };
}
