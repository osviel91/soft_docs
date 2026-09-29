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
import type { Promotion } from "../domain/workspace/promotion";

export type ProposalLifecycleState = "OPEN" | "CHANGES_REQUESTED" | "APPROVED" | "PROMOTING" | "PROMOTED" | "WITHDRAWN" | "SUPERSEDED";

function lifecycle(status: ArchitecturalProposal["status"], reviewStatus: ProposalReviewSummary["status"], promotion: Promotion | null): ProposalLifecycleState {
  if (status === "withdrawn") return "WITHDRAWN";
  if (status === "superseded") return "SUPERSEDED";
  if (promotion?.status === "COMPLETED") return "PROMOTED";
  if (promotion?.status === "COMMITTED_COMPLETION_PENDING") return "PROMOTING";
  if (reviewStatus === "changes-requested") return "CHANGES_REQUESTED";
  if (reviewStatus === "approved") return "APPROVED";
  return "OPEN";
}

export type PublicArchitecturalProposal = Omit<ArchitecturalProposal, "sourcePrivateContextId" | "semanticMessages" | "relationships"> & {
  semanticMessages: Array<Omit<ProposalSemanticMessageSnapshot, "sourceContextId">>;
  relationships: Array<Omit<ProposalRelationshipSnapshot, "sourceContextId" | "contextId">>;
};
export type PublicArchitecturalProposalSummary = Omit<ArchitecturalProposalSummary, "sourcePrivateContextId">;

function publicProposal(proposal: ArchitecturalProposal): PublicArchitecturalProposal {
  const { id, projectId, authorUserId, title, description, status, supersedesProposalId, withdrawnAt, withdrawnBy, withdrawalReason, supersededAt, baseSharedRevision, baseSharedResourceRevisions, baseManifestRevision, createdAt, submittedAt, resources, semanticMessages, relationships } = proposal;
  return {
    id, projectId, authorUserId, title, ...(description === undefined ? {} : { description }), status, supersedesProposalId, withdrawnAt, withdrawnBy, withdrawalReason, supersededAt, baseSharedRevision, baseSharedResourceRevisions, baseManifestRevision, createdAt, submittedAt, resources,
    semanticMessages: semanticMessages.map(({ id: messageId, name, kind, operation, baseName, baseKind }) => ({ id: messageId, name, kind, ...(operation === undefined ? {} : { operation }), ...(baseName === undefined ? {} : { baseName }), ...(baseKind === undefined ? {} : { baseKind }) })),
    relationships: relationships.map(({ sourceId, targetId, kind, sourceRole, targetRole, operation, baseFingerprint }) => ({ sourceId, targetId, kind, ...(sourceRole === undefined ? {} : { sourceRole }), ...(targetRole === undefined ? {} : { targetRole }), ...(operation === undefined ? {} : { operation }), ...(baseFingerprint === undefined ? {} : { baseFingerprint }) })),
  };
}

function publicSummary(summary: ArchitecturalProposalSummary): PublicArchitecturalProposalSummary {
  const { id, projectId, authorUserId, title, description, status, supersedesProposalId, withdrawnAt, withdrawnBy, withdrawalReason, supersededAt, baseSharedRevision, baseSharedResourceRevisions, baseManifestRevision, createdAt, submittedAt, staleBase, currentSharedRevision } = summary;
  return { id, projectId, authorUserId, title, ...(description === undefined ? {} : { description }), status, supersedesProposalId, withdrawnAt, withdrawnBy, withdrawalReason, supersededAt, baseSharedRevision, baseSharedResourceRevisions, baseManifestRevision, createdAt, submittedAt, staleBase, currentSharedRevision };
}

export interface ArchitecturalProposalService {
  list(context: ApplicationContext, projectId: string): Promise<PublicArchitecturalProposalSummary[]>;
  get(context: ApplicationContext, projectId: string, proposalId: string): Promise<PublicArchitecturalProposal & { staleBase: boolean; currentSharedRevision: string; lifecycle: { state: ProposalLifecycleState; promotionStatus?: Promotion["status"] }; promotion?: Pick<Promotion, "id" | "status" | "createdAt" | "completedAt" | "resultingSharedRevision">; supersedes?: { id: string; title: string }; supersededBy?: { id: string; title: string }; revisionContextId?: string }>;
  submit(context: ApplicationContext, input: { projectId: string; sourcePrivateContextId: string; resourceIds: string[]; retireResourceIds?: string[]; resourceOperations?: Array<{ resourceId: string; operation: "CREATE" | "UPDATE"; baseResourceId?: string; path?: string; baseRevision?: number }>; semanticMessages?: Array<{ id: string; name: string; kind: "event" | "command"; operation?: "ADD" | "UPDATE" | "RETIRE"; baseName?: string; baseKind?: "event" | "command" }>; relationshipOperations?: Array<{ sourceId: string; targetId: string; kind: "complementary-view"; sourceRole?: "execution" | "causal" | "other"; targetRole?: "execution" | "causal" | "other"; operation?: "ADD" | "UPDATE" | "REMOVE"; baseFingerprint?: string }>; title: string; description?: string }): Promise<PublicArchitecturalProposal>;
  revise(context: ApplicationContext, input: { projectId: string; proposalId: string; sourcePrivateContextId: string; resourceIds: string[]; retireResourceIds?: string[]; resourceOperations?: Array<{ resourceId: string; operation: "CREATE" | "UPDATE"; baseResourceId?: string; path?: string; baseRevision?: number }>; semanticMessages?: Array<{ id: string; name: string; kind: "event" | "command"; operation?: "ADD" | "UPDATE" | "RETIRE"; baseName?: string; baseKind?: "event" | "command" }>; relationshipOperations?: Array<{ sourceId: string; targetId: string; kind: "complementary-view"; sourceRole?: "execution" | "causal" | "other"; targetRole?: "execution" | "causal" | "other"; operation?: "ADD" | "UPDATE" | "REMOVE"; baseFingerprint?: string }>; title: string; description?: string }): Promise<PublicArchitecturalProposal>;
  withdraw(context: ApplicationContext, input: { projectId: string; proposalId: string; reason?: string }): Promise<PublicArchitecturalProposal>;
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
  promotions?: import("./ports/promotion-repository").PromotionRepository;
}): ArchitecturalProposalService {
  const policy = options.policy ?? createAuthorizationPolicy<ServerProject>(options.projects);
  const requireRead = (context: ApplicationContext, projectId: string) => policy.requirePermission(context, projectId, "project:read");
  const requireSubmit = (context: ApplicationContext, projectId: string) => policy.requirePermission(context, projectId, "resource:update");
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
    const analyses = files.map(({ descriptor, content }) => analyzeResource(descriptor, content));
    return buildProjectIndex(proposal.projectId, analyses, metadata, (core) => validateProject(core, analyses.flatMap((analysis) => analysis.diagnostics), metadata));
  };
  const prepare = async (context: ApplicationContext, input: Parameters<ArchitecturalProposalService["submit"]>[1]) => {
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
    let baseManifestRevision = 0;
    if (options.storage) {
      const manifest = await options.storage(input.projectId).read("project.json");
      if (manifest.ok && manifest.value) {
        try { baseManifestRevision = parseProjectMetadata(JSON.parse(manifest.value.content))?.manifestRevision ?? 0; } catch { throw invalid("The project manifest is not valid JSON."); }
      }
    }
    const shared = await options.projects.listResources(input.projectId, null);
    const retirementTargets = shared.filter((resource) => retireIds.includes(resource.id));
    if (retirementTargets.length !== retireIds.length) throw notFound("One or more retirement targets are not active SHARED resources.");
    let sharedMetadata: ProjectMetadata = createEmptyMetadata();
    if (options.storage) {
      const stored = await options.storage(input.projectId).read("project.json");
      if (stored.ok && stored.value) sharedMetadata = parseProjectMetadata(JSON.parse(stored.value.content)) ?? sharedMetadata;
    }
    const semanticMessages = (input.semanticMessages ?? []).map((message) => {
      const existing = sharedMetadata.semanticMessages?.find((candidate) => candidate.id === message.id);
      return { ...message, ...(message.operation !== "ADD" && existing && message.baseName === undefined ? { baseName: existing.name, baseKind: existing.kind } : {}) };
    });
    const relationships = input.relationshipOperations ?? [];
    return {
      projectId: input.projectId, authorUserId: context.principal.subjectUserId, sourcePrivateContextId: source.id, title,
      ...(input.description === undefined ? {} : { description: input.description }),
      selections: selected.map((resource) => ({ resourceId: resource.id, expectedRevision: resource.revision, ...((input.resourceOperations ?? []).find((operation) => operation.resourceId === resource.id) ?? {}) })),
      retirements: retirementTargets.map((resource) => ({ resourceId: resource.id, expectedRevision: resource.revision })), privateMessageIds,
      baseSharedRevision: base.revision, baseSharedResourceRevisions: base.resources, baseManifestRevision,
      ...(input.semanticMessages === undefined ? {} : { semanticMessages }),
      ...(relationships.length === 0 ? {} : { relationships }),
    };
  };

  return {
    async list(context, projectId) {
      await requireRead(context, projectId);
      const proposals = await options.proposals.list(projectId);
      return Promise.all(proposals.map(async (proposal) => {
        const summary = publicSummary(proposal);
        const entries = options.reviews ? await options.reviews.list(proposal.id) : [];
        const latest = new Map<string, ProposalReview>();
        for (const entry of entries) latest.set(entry.reviewerUserId, entry);
        const effective = [...latest.values()];
        const approvals = effective.filter((entry) => entry.decision === "APPROVE").length;
        const changesRequested = effective.filter((entry) => entry.decision === "REQUEST_CHANGES").length;
        const reviewStatus = effective.length === 0 ? "none" : approvals > 0 && changesRequested > 0 ? "mixed" : approvals > 0 ? "approved" : "changes-requested";
        const promotion = options.promotions ? await options.promotions.getForProposal(projectId, proposal.id) : null;
        return { ...summary, reviewStatus, approvals, changesRequested, lifecycle: { state: lifecycle(proposal.status, reviewStatus, promotion), ...(promotion ? { promotionStatus: promotion.status } : {}) } };
      }));
    },
    async get(context, projectId, proposalId) {
      await requireRead(context, projectId);
      const proposal = await options.proposals.get(projectId, proposalId);
      if (!proposal) throw notFound(`No architectural proposal with id ${proposalId}.`);
      const current = await options.proposals.currentSharedRevision(projectId);
      const reviews = options.reviews ? await options.reviews.list(proposalId) : [];
      const latest = new Map<string, ProposalReview>();
      for (const entry of reviews) latest.set(entry.reviewerUserId, entry);
      const effective = [...latest.values()];
      const approvals = effective.filter((entry) => entry.decision === "APPROVE").length;
      const changesRequested = effective.filter((entry) => entry.decision === "REQUEST_CHANGES").length;
      const reviewStatus = effective.length === 0 ? "none" : approvals > 0 && changesRequested > 0 ? "mixed" : approvals > 0 ? "approved" : "changes-requested";
      const promotion = options.promotions ? await options.promotions.getForProposal(projectId, proposalId) : null;
      const predecessor = proposal.supersedesProposalId ? await options.proposals.get(projectId, proposal.supersedesProposalId) : null;
      const successor = options.proposals.findSuccessor ? await options.proposals.findSuccessor(projectId, proposalId) : null;
      const result = publicProposal(proposal);
      return {
        ...result,
        staleBase: proposal.baseSharedRevision !== current.revision,
        currentSharedRevision: current.revision,
        lifecycle: { state: lifecycle(proposal.status, reviewStatus, promotion), ...(promotion ? { promotionStatus: promotion.status } : {}) },
        ...(promotion ? { promotion: { id: promotion.id, status: promotion.status, createdAt: promotion.createdAt, ...(promotion.completedAt ? { completedAt: promotion.completedAt } : {}), resultingSharedRevision: promotion.resultingSharedRevision } } : {}),
        ...(predecessor ? { supersedes: { id: predecessor.id, title: predecessor.title } } : {}),
        ...(successor ? { supersededBy: { id: successor.id, title: successor.title } } : {}),
        ...(proposal.authorUserId === context.principal.subjectUserId ? { revisionContextId: proposal.sourcePrivateContextId } : {}),
      };
    },
     async submit(context, input) {
      await requireSubmit(context, input.projectId);
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
      let baseManifestRevision = 0;
      if (options.storage) {
        const manifest = await options.storage(input.projectId).read("project.json");
        if (manifest.ok && manifest.value) {
          try { baseManifestRevision = parseProjectMetadata(JSON.parse(manifest.value.content))?.manifestRevision ?? 0; } catch { throw invalid("The project manifest is not valid JSON."); }
        }
      }
      const shared = await options.projects.listResources(input.projectId, null);
      const retirementTargets = shared.filter((resource) => retireIds.includes(resource.id));
      if (retirementTargets.length !== retireIds.length) throw notFound("One or more retirement targets are not active SHARED resources.");
      let sharedMetadata: ProjectMetadata = createEmptyMetadata();
      if (options.storage) {
        const stored = await options.storage(input.projectId).read("project.json");
        if (stored.ok && stored.value) sharedMetadata = parseProjectMetadata(JSON.parse(stored.value.content)) ?? sharedMetadata;
      }
      const relationshipFingerprint = (relationship: { kind: string; sourceId: string; targetId: string; sourceRole?: string; targetRole?: string }) => JSON.stringify({ kind: relationship.kind, sourceId: relationship.sourceId, targetId: relationship.targetId, sourceRole: relationship.sourceRole ?? null, targetRole: relationship.targetRole ?? null });
      const semanticMessages = (input.semanticMessages ?? []).map((message) => {
        const existing = sharedMetadata.semanticMessages?.find((candidate) => candidate.id === message.id);
        return { ...message, ...(message.operation !== "ADD" && existing && message.baseName === undefined ? { baseName: existing.name, baseKind: existing.kind } : {}) };
      });
      const relationships = (input.relationshipOperations ?? []).map((relationship) => {
        const existing = sharedMetadata.relationships?.find((candidate) => candidate.sourceId === relationship.sourceId && candidate.targetId === relationship.targetId);
        return { ...relationship, ...(relationship.operation !== "ADD" && existing && relationship.baseFingerprint === undefined ? { baseFingerprint: relationshipFingerprint(existing) } : {}) };
      });
      let proposal: ArchitecturalProposal;
      try {
        proposal = await options.proposals.submit({
          projectId: input.projectId, authorUserId: context.principal.subjectUserId, sourcePrivateContextId: source.id,
          title, ...(input.description === undefined ? {} : { description: input.description }),
           selections: selected.map((resource) => ({ resourceId: resource.id, expectedRevision: resource.revision, ...((input.resourceOperations ?? []).find((operation) => operation.resourceId === resource.id) ?? {}) })),
           retirements: retirementTargets.map((resource) => ({ resourceId: resource.id, expectedRevision: resource.revision })), privateMessageIds,
           baseSharedRevision: base.revision, baseSharedResourceRevisions: base.resources, baseManifestRevision,
            ...(input.semanticMessages === undefined ? {} : { semanticMessages }),
            ...(input.relationshipOperations === undefined ? {} : { relationships }),
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
     async revise(context, input) {
       await requireSubmit(context, input.projectId);
       const prior = await options.proposals.get(input.projectId, input.proposalId);
       if (!prior) throw notFound(`No architectural proposal with id ${input.proposalId}.`);
       if (prior.authorUserId !== context.principal.subjectUserId) throw invalid("Only the proposal author may revise it.");
       if (prior.status !== "open") throw conflict("Only open proposals may be revised.", { state: prior.status });
       const prepared = await prepare(context, input);
       try {
         if (!options.proposals.revise) throw invalid("Proposal revision is not configured.");
         const proposal = await options.proposals.revise({ ...prepared, proposalId: input.proposalId, supersedesProposalId: input.proposalId });
         await options.audit?.record({ action: "proposal.revised", subjectUserId: context.principal.subjectUserId, actorType: actorTypeOf(context.principal), actorId: actorIdOf(context.principal), credentialId: credentialIdOf(context.principal), authType: context.principal.authType, projectId: input.projectId, resourceId: null, requestId: context.requestId, detail: { proposalId: proposal.id, supersedesProposalId: input.proposalId, baseSharedRevision: proposal.baseSharedRevision } });
         return publicProposal(proposal);
       } catch (error) { throw conflict(error instanceof Error ? error.message : "Proposal revision conflicted with current state."); }
     },
     async withdraw(context, input) {
       await requireSubmit(context, input.projectId);
       const proposal = await options.proposals.get(input.projectId, input.proposalId);
       if (!proposal) throw notFound(`No architectural proposal with id ${input.proposalId}.`);
       if (proposal.authorUserId !== context.principal.subjectUserId) throw invalid("Only the proposal author may withdraw it.");
       try {
         if (!options.proposals.withdraw) throw invalid("Proposal withdrawal is not configured.");
         const withdrawn = await options.proposals.withdraw(input.proposalId, context.principal.subjectUserId, input.reason);
         await options.audit?.record({ action: "proposal.withdrawn", subjectUserId: context.principal.subjectUserId, actorType: actorTypeOf(context.principal), actorId: actorIdOf(context.principal), credentialId: credentialIdOf(context.principal), authType: context.principal.authType, projectId: input.projectId, resourceId: null, requestId: context.requestId, detail: { proposalId: input.proposalId, reason: input.reason ?? null } });
         return publicProposal(withdrawn);
       } catch (error) { throw conflict(error instanceof Error ? error.message : "Proposal withdrawal conflicted with current state."); }
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
       if (proposal.status !== "open") throw conflict("Only open proposals may be reviewed.", { state: proposal.status });
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
