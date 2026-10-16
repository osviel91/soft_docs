import type { ApplicationContext } from "./context";
import { actorIdOf, actorTypeOf, credentialIdOf } from "./context";
import { conflict, invalid, notFound } from "./errors";
import type { AuthorizationPolicy, WorkspaceAdminGovernance, WorkspaceSelfReviewPolicy } from "./authorization";
import { createAuthorizationPolicy } from "./authorization";
import type { ServerProject } from "../domain/project/server-project";
import type { ProjectRepository } from "./ports/project-repository";
import type { KnowledgeContextRepository } from "./ports/knowledge-context-repository";
import type { AuditRepository } from "./ports/audit-repository";
import type { ArchitecturalProposalRepository } from "./ports/architectural-proposal-repository";
import type { ArchitecturalProposal, ArchitecturalProposalSummary, ProposalRelationshipSnapshot, ProposalSemanticMessageSnapshot, ProposalReview, ProposalReviewDecision, ProposalReviewSummary, ProposalSemanticBindingSnapshot } from "../domain/workspace/architectural-proposal";
import type { ProjectStorage } from "./project-storage";
import { createEmptyMetadata, parseProjectMetadata, type ProjectMetadata } from "../domain/workspace/metadata";
import { analyzeResource } from "../domain/project/resource-analysis";
import { buildProjectIndex, type ProjectDiagnostic, type ProjectIndex } from "../domain/project/project-index";
import { validateProject } from "../domain/project/validate";
import { traceArchitectureQuery, type ArchitectureTrace, type TraceDirection } from "../domain/project/architecture-trace";
import type { Promotion } from "../domain/workspace/promotion";
import { buildProposalLineage, deriveProposalLifecycle, evaluateProposalConsistency, type ProposalConsistency, type ProposalLifecycleRecord, type ProposalLifecycleState, type ProposalLineage } from "../domain/workspace/proposal-lifecycle";
import { architecturalProposalDiff, type ArchitecturalProposalDiff } from "./proposal-diff";
import type { SemanticBindingRepository } from "./ports/semantic-binding-repository";
import { entityAnchorKey, validateSemanticBinding } from "../domain/workspace/semantic-binding";

export type PublicArchitecturalProposal = Omit<ArchitecturalProposal, "sourcePrivateContextId" | "semanticMessages" | "relationships" | "semanticBindings"> & {
  semanticMessages: Array<Omit<ProposalSemanticMessageSnapshot, "sourceContextId">>;
  relationships: Array<Omit<ProposalRelationshipSnapshot, "sourceContextId" | "contextId">>;
  semanticBindings: Array<Omit<ProposalSemanticBindingSnapshot, "sourceContextId">>;
};
export interface ProposalPromotionSummary {
  id: string;
  status: Promotion["status"];
  createdAt: Date;
  completedAt?: Date;
  resultingSharedRevision: string;
}
export interface ProposalReadState {
  /** Compatibility/raw status: never substitute effectiveStatus here. */
  recordedStatus: ArchitecturalProposal["status"];
  effectiveStatus: ProposalLifecycleState;
  /** Lifecycle eligibility only; authorization still comes from capabilities and use-case checks. */
  actionable: boolean;
  /** Compatibility view retained for existing UI/API consumers. */
  lifecycle: { state: ProposalLifecycleState; promotionStatus?: Promotion["status"] };
  promotion?: ProposalPromotionSummary;
  supersedes?: { id: string; title: string };
  supersededBy?: { id: string; title: string };
  lineage: ProposalLineage;
  consistency: ProposalConsistency;
}
export type PublicArchitecturalProposalSummary = Omit<ArchitecturalProposalSummary, "sourcePrivateContextId"> & ProposalReadState;

type PublicArchitecturalProposalSummaryBase = Omit<ArchitecturalProposalSummary, "sourcePrivateContextId">;

function publicProposal(proposal: ArchitecturalProposal): PublicArchitecturalProposal {
  const { id, projectId, authorUserId, title, description, status, supersedesProposalId, withdrawnAt, withdrawnBy, withdrawalReason, supersededAt, baseSharedRevision, baseSharedResourceRevisions, baseManifestRevision, createdAt, submittedAt, resources, semanticMessages, relationships } = proposal;
  const publicBinding = (binding: import("../domain/workspace/semantic-binding").SemanticBinding) => {
    const provenance = { ...binding.provenance };
    delete provenance.contextId;
    return { ...binding, provenance };
  };
  return {
    id, projectId, authorUserId, title, ...(description === undefined ? {} : { description }), status, supersedesProposalId, withdrawnAt, withdrawnBy, withdrawalReason, supersededAt, baseSharedRevision, baseSharedResourceRevisions, baseManifestRevision, createdAt, submittedAt, resources,
    semanticMessages: semanticMessages.map(({ id: messageId, name, kind, operation, baseName, baseKind }) => ({ id: messageId, name, kind, ...(operation === undefined ? {} : { operation }), ...(baseName === undefined ? {} : { baseName }), ...(baseKind === undefined ? {} : { baseKind }) })),
    relationships: relationships.map(({ sourceId, targetId, kind, sourceRole, targetRole, operation, baseFingerprint }) => ({ sourceId, targetId, kind, ...(sourceRole === undefined ? {} : { sourceRole }), ...(targetRole === undefined ? {} : { targetRole }), ...(operation === undefined ? {} : { operation }), ...(baseFingerprint === undefined ? {} : { baseFingerprint }) })),
    semanticBindings: (proposal.semanticBindings ?? []).map((entry) => ({ ...entry, binding: publicBinding(entry.binding), ...(entry.operation === "UPDATE" ? { baseBinding: publicBinding(entry.baseBinding) } : {}) } as Omit<ProposalSemanticBindingSnapshot, "sourceContextId">)),
  };
}

function publicSummary(summary: ArchitecturalProposalSummary): PublicArchitecturalProposalSummaryBase {
  const { id, projectId, authorUserId, title, description, status, supersedesProposalId, withdrawnAt, withdrawnBy, withdrawalReason, supersededAt, baseSharedRevision, baseSharedResourceRevisions, baseManifestRevision, createdAt, submittedAt, staleBase, currentSharedRevision } = summary;
  return { id, projectId, authorUserId, title, ...(description === undefined ? {} : { description }), status, supersedesProposalId, withdrawnAt, withdrawnBy, withdrawalReason, supersededAt, baseSharedRevision, baseSharedResourceRevisions, baseManifestRevision, createdAt, submittedAt, staleBase, currentSharedRevision };
}

function publicPromotion(promotion: Promotion): ProposalPromotionSummary {
  return {
    id: promotion.id,
    status: promotion.status,
    createdAt: promotion.createdAt,
    ...(promotion.completedAt ? { completedAt: promotion.completedAt } : {}),
    resultingSharedRevision: promotion.resultingSharedRevision,
  };
}

function reviewTotals(reviews: ProposalReview[]): { reviewStatus: ProposalReviewSummary["status"]; approvals: number; changesRequested: number } {
  const latest = new Map<string, ProposalReview>();
  for (const review of reviews) latest.set(review.reviewerUserId, review);
  const effective = [...latest.values()];
  const approvals = effective.filter((entry) => entry.decision === "APPROVE").length;
  const changesRequested = effective.filter((entry) => entry.decision === "REQUEST_CHANGES").length;
  return {
    reviewStatus: effective.length === 0 ? "none" : approvals > 0 && changesRequested > 0 ? "mixed" : approvals > 0 ? "approved" : "changes-requested",
    approvals,
    changesRequested,
  };
}

function proposalReadState(
  proposal: ProposalLifecycleRecord,
  reviewStatus: ProposalReviewSummary["status"],
  promotion: Promotion | null,
  lineage: ProposalLineage,
): ProposalReadState {
  const effectiveStatus = deriveProposalLifecycle(proposal.status, reviewStatus, promotion?.status);
  const consistency = evaluateProposalConsistency(proposal.status, promotion, lineage);
  const successor = lineage.entries.findIndex((entry) => entry.id === proposal.id) + 1;
  const supersedes = proposal.supersedesProposalId ? lineage.entries.find((entry) => entry.id === proposal.supersedesProposalId) : undefined;
  const supersededBy = successor > 0 ? lineage.entries[successor] : undefined;
  return {
    recordedStatus: proposal.status,
    effectiveStatus,
    actionable: proposal.status === "open" && !promotion && !supersededBy,
    lifecycle: { state: effectiveStatus, ...(promotion ? { promotionStatus: promotion.status } : {}) },
    ...(promotion ? { promotion: publicPromotion(promotion) } : {}),
    ...(supersedes ? { supersedes: { id: supersedes.id, title: supersedes.title } } : {}),
    ...(supersededBy ? { supersededBy: { id: supersededBy.id, title: supersededBy.title } } : {}),
    lineage,
    consistency,
  };
}

export interface ArchitecturalProposalService {
  list(context: ApplicationContext, projectId: string): Promise<PublicArchitecturalProposalSummary[]>;
  get(context: ApplicationContext, projectId: string, proposalId: string): Promise<PublicArchitecturalProposal & ProposalReadState & { staleBase: boolean; currentSharedRevision: string; revisionContextId?: string }>;
  diff(context: ApplicationContext, projectId: string, proposalId: string): Promise<ArchitecturalProposalDiff>;
  submit(context: ApplicationContext, input: { projectId: string; sourcePrivateContextId: string; resourceIds: string[]; retireResourceIds?: string[]; resourceOperations?: Array<{ resourceId: string; operation: "CREATE" | "UPDATE"; baseResourceId?: string; path?: string; baseRevision?: number }>; semanticMessages?: Array<{ id: string; name: string; kind: "event" | "command"; operation?: "ADD" | "UPDATE" | "RETIRE"; baseName?: string; baseKind?: "event" | "command" }>; relationshipOperations?: Array<{ sourceId: string; targetId: string; kind: "complementary-view"; sourceRole?: "execution" | "causal" | "other"; targetRole?: "execution" | "causal" | "other"; operation?: "ADD" | "UPDATE" | "REMOVE"; baseFingerprint?: string }>; semanticBindings?: import("./ports/architectural-proposal-repository").ProposalSemanticBindingSelection[]; title: string; description?: string }): Promise<PublicArchitecturalProposal>;
  revise(context: ApplicationContext, input: { projectId: string; proposalId: string; sourcePrivateContextId: string; resourceIds: string[]; retireResourceIds?: string[]; resourceOperations?: Array<{ resourceId: string; operation: "CREATE" | "UPDATE"; baseResourceId?: string; path?: string; baseRevision?: number }>; semanticMessages?: Array<{ id: string; name: string; kind: "event" | "command"; operation?: "ADD" | "UPDATE" | "RETIRE"; baseName?: string; baseKind?: "event" | "command" }>; relationshipOperations?: Array<{ sourceId: string; targetId: string; kind: "complementary-view"; sourceRole?: "execution" | "causal" | "other"; targetRole?: "execution" | "causal" | "other"; operation?: "ADD" | "UPDATE" | "REMOVE"; baseFingerprint?: string }>; semanticBindings?: import("./ports/architectural-proposal-repository").ProposalSemanticBindingSelection[]; title: string; description?: string }): Promise<PublicArchitecturalProposal>;
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
  promotions: import("./ports/promotion-repository").PromotionRepository;
  policy?: AuthorizationPolicy<ServerProject>;
  workspaceAdmin?: WorkspaceAdminGovernance;
  workspaceSelfReview?: WorkspaceSelfReviewPolicy;
  storage?: (projectId: string) => ProjectStorage;
  semanticBindings?: SemanticBindingRepository;
}): ArchitecturalProposalService {
  const policy = options.policy ?? createAuthorizationPolicy<ServerProject>(options.projects);
  const requireRead = (context: ApplicationContext, projectId: string) => policy.requirePermission(context, projectId, "project:read");
  const requireSubmit = (context: ApplicationContext, projectId: string) => policy.requirePermission(context, projectId, "resource:update");
  const validateSelectedBindings = async (projectId: string, contextId: string, selections: import("./ports/architectural-proposal-repository").ProposalSemanticBindingSelection[], selectedIds: Set<string>) => {
    if (selections.length && !options.semanticBindings) throw invalid("Semantic binding selection is unavailable.");
    const resources = [...await options.projects.listResources(projectId, null), ...await options.projects.listResources(projectId, contextId).then((rows) => rows.filter((row) => selectedIds.has(row.id)))];
    const analyses = await Promise.all(resources.map(async (resource) => {
      const revision = await options.projects.getRevision(resource.id, resource.revision);
      return revision ? analyzeResource({ id: resource.id, projectId, path: resource.path, type: resource.type, title: resource.path }, revision.content) : null;
    }));
    const indexed = new Set(analyses.filter((analysis): analysis is NonNullable<typeof analysis> => analysis !== null).flatMap((analysis) => analysis.entities.map((entity) => entityAnchorKey(entity.anchor))));
    for (const selection of selections) {
      const binding = await options.semanticBindings!.get({ projectId, contextId: selection.operation === "REMOVE" ? null : contextId }, selection.bindingId);
       if (!binding || (selection.operation === "ADD" && binding.revision !== selection.sourceRevision)) throw invalid(`Selected semantic binding ${selection.bindingId} is not current in the selected context.`);
      try { validateSemanticBinding(binding); } catch (error) { throw invalid(error instanceof Error ? error.message : "Invalid semantic binding."); }
      if (![binding.left, binding.right].every((anchor) => indexed.has(entityAnchorKey(anchor)))) throw invalid(`Selected semantic binding ${selection.bindingId} has an endpoint outside SHARED and the selected private resources.`);
    }
  };
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
    if (ids.length === 0 && retireIds.length === 0 && (input.semanticBindings?.length ?? 0) === 0) throw invalid("Select at least one resource, retirement, or semantic binding operation.");
    const resources = await options.projects.listResources(input.projectId, source.id);
    const selected = resources.filter((resource) => ids.includes(resource.id));
    if (selected.length !== ids.length) throw notFound("One or more selected private resources are not available.");
    await validateSelectedBindings(input.projectId, source.id, input.semanticBindings ?? [], new Set(ids));
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
      ...(input.semanticBindings === undefined ? {} : { semanticBindings: input.semanticBindings }),
    };
  };

  return {
    async list(context, projectId) {
      await requireRead(context, projectId);
      const proposals = await options.proposals.list(projectId);
      return Promise.all(proposals.map(async (proposal) => {
        const summary = publicSummary(proposal);
        const [reviews, promotion] = await Promise.all([
          options.reviews?.list(proposal.id) ?? Promise.resolve([]),
          options.promotions.getForProposal(projectId, proposal.id),
        ]);
        const totals = reviewTotals(reviews);
        const state = proposalReadState(proposal, totals.reviewStatus, promotion, buildProposalLineage(proposal, proposals));
        return { ...summary, ...totals, ...state };
      }));
    },
    async get(context, projectId, proposalId) {
      await requireRead(context, projectId);
      const proposal = await options.proposals.get(projectId, proposalId);
      if (!proposal) throw notFound(`No architectural proposal with id ${proposalId}.`);
      const [current, reviews, promotion, proposalSummaries] = await Promise.all([
        options.proposals.currentSharedRevision(projectId),
        options.reviews?.list(proposalId) ?? Promise.resolve([]),
        options.promotions.getForProposal(projectId, proposalId),
        options.proposals.list(projectId),
      ]);
      const totals = reviewTotals(reviews);
      const state = proposalReadState(proposal, totals.reviewStatus, promotion, buildProposalLineage(proposal, proposalSummaries));
      const result = publicProposal(proposal);
      return {
        ...result,
        staleBase: proposal.baseSharedRevision !== current.revision,
        currentSharedRevision: current.revision,
        ...totals,
        ...state,
        ...(proposal.authorUserId === context.principal.subjectUserId ? { revisionContextId: proposal.sourcePrivateContextId } : {}),
      };
    },
    async diff(context, projectId, proposalId) {
      await requireRead(context, projectId);
      const proposal = await options.proposals.get(projectId, proposalId);
      if (!proposal) throw notFound(`No architectural proposal with id ${proposalId}.`);
      return architecturalProposalDiff(proposal, await options.proposals.currentSharedRevision(projectId), async (resourceId, revision) => {
        const value = await options.projects.getRevision(resourceId, revision);
        return value ? { content: value.content, type: value.type, ...(value.metadata === undefined ? {} : { metadata: value.metadata }) } : null;
      });
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
       if (ids.length === 0 && retireIds.length === 0 && (input.semanticBindings?.length ?? 0) === 0) throw invalid("Select at least one resource, retirement, or semantic binding operation.");
      const resources = await options.projects.listResources(input.projectId, source.id);
       const selected = resources.filter((resource) => ids.includes(resource.id));
       if (selected.length !== ids.length) throw notFound("One or more selected private resources are not available.");
       await validateSelectedBindings(input.projectId, source.id, input.semanticBindings ?? [], new Set(ids));
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
             ...(input.semanticBindings === undefined ? {} : { semanticBindings: input.semanticBindings }),
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
        const promotion = await options.promotions.getForProposal(input.projectId, prior.id);
        if (promotion) throw conflict("A proposal with promotion evidence cannot be revised.", { state: promotion.status === "COMPLETED" ? "PROMOTED" : "PROMOTING", promotionStatus: promotion.status });
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
        if (proposal.status !== "open") throw conflict("Only open proposals may be withdrawn.", { state: proposal.status });
        const promotion = await options.promotions.getForProposal(input.projectId, proposal.id);
        if (promotion) throw conflict("A proposal with promotion evidence cannot be withdrawn.", { state: promotion.status === "COMPLETED" ? "PROMOTED" : "PROMOTING", promotionStatus: promotion.status });
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
      const access = await policy.decide(context, input.projectId, "resource:update");
      const workspaceAdmin = !access.allowed && access.reason === "forbidden" && options.workspaceAdmin
        ? await options.workspaceAdmin(context, input.projectId, "resource:update")
        : false;
      if (!access.allowed && !workspaceAdmin) await policy.requirePermission(context, input.projectId, "resource:update");
      if (!options.reviews) throw invalid("Proposal reviews are not configured.");
        const proposal = await options.proposals.get(input.projectId, input.proposalId);
        if (!proposal) throw notFound(`No architectural proposal with id ${input.proposalId}.`);
        if (proposal.status !== "open") throw conflict("Only open proposals may be reviewed.", { state: proposal.status });
        const promotion = await options.promotions.getForProposal(input.projectId, proposal.id);
        if (promotion) throw conflict("A proposal with promotion evidence cannot be reviewed.", { state: promotion.status === "COMPLETED" ? "PROMOTED" : "PROMOTING", promotionStatus: promotion.status });
        if (input.decision === "APPROVE" && proposal.authorUserId === context.principal.subjectUserId && !(await options.workspaceSelfReview?.(context, input.projectId))) throw invalid("Proposal authors cannot approve their own proposal.");
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
