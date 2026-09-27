import { traceArchitectureQuery, type ArchitectureTrace, type TraceDirection, type TraceNode, type TraceQueryStart } from "../../domain/project/architecture-trace";
import type { ProjectIndex, ResourceDescriptor } from "../../domain/project/project-index";
import type { ResourceRelationship } from "../../domain/workspace/resource-relationship";
import type { SemanticMessageIdentity } from "../../domain/workspace/metadata";
import type { AnalysisProvenance, KnowledgeContext } from "../../domain/workspace/knowledge-context";
import type { ArchitecturalProposal } from "../../domain/workspace/architectural-proposal";
import type { ComparisonOccurrence, SemanticComparison } from "./semantic-comparison";

export interface AnalysisContext {
  projectId: string;
  knowledgeContext: KnowledgeContext;
  index: ProjectIndex;
  resourceId: string | null;
  resourcePath?: string;
  sessionId?: string;
}

/** Compose authorized SHARED facts with one private context without flattening provenance. */
export function effectivePrivateIndex(
  shared: ProjectIndex,
  privateIndex: ProjectIndex,
  context: Extract<KnowledgeContext, { kind: "private-work" }>,
): ProjectIndex {
  const sharedProvenance: AnalysisProvenance = { kind: "shared", id: shared.provenance?.id ?? `shared:${shared.projectId}` };
  const privateProvenance: AnalysisProvenance = { kind: "private-work", id: context.id, label: context.name };
  const mark = <T extends ResourceDescriptor>(resources: T[], provenance: AnalysisProvenance): T[] => resources.map((resource) => ({ ...resource, provenance }));
  const privateIds = new Set(privateIndex.resources.map((resource) => resource.id));
  return {
    ...shared,
    provenance: privateProvenance,
    resources: [...mark(shared.resources.filter((resource) => !privateIds.has(resource.id)), sharedProvenance), ...mark(privateIndex.resources, privateProvenance)],
    diagrams: [...mark(shared.diagrams.filter((resource) => !privateIds.has(resource.id)), sharedProvenance), ...mark(privateIndex.diagrams, privateProvenance)],
    eventFlows: [...mark(shared.eventFlows.filter((resource) => !privateIds.has(resource.id)), sharedProvenance), ...mark(privateIndex.eventFlows, privateProvenance)],
    documents: [...mark(shared.documents.filter((resource) => !privateIds.has(resource.id)), sharedProvenance), ...mark(privateIndex.documents, privateProvenance)],
    participants: [...shared.participants.filter((entry) => !privateIds.has(entry.resourceId)), ...privateIndex.participants],
    usages: [...shared.usages.filter((entry) => !privateIds.has(entry.resourceId)), ...privateIndex.usages],
    references: [...shared.references.filter((entry) => !privateIds.has(entry.from)), ...privateIndex.references],
    semanticMessages: [...(shared.semanticMessages ?? []), ...(privateIndex.semanticMessages ?? []).filter((message) => !(shared.semanticMessages ?? []).some((existing) => existing.id === message.id))],
    semanticOccurrences: [...(shared.semanticOccurrences ?? []).filter((entry) => !privateIds.has(entry.resourceId)), ...(privateIndex.semanticOccurrences ?? [])],
    eventFlowMessages: [...(shared.eventFlowMessages ?? []).filter((entry) => !privateIds.has(entry.resourceId)), ...(privateIndex.eventFlowMessages ?? [])],
    eventFlowCausality: [...(shared.eventFlowCausality ?? []).filter((entry) => !privateIds.has(entry.resourceId)), ...(privateIndex.eventFlowCausality ?? [])],
    diagnostics: [...shared.diagnostics.filter((entry) => !privateIds.has(entry.resourceId)), ...privateIndex.diagnostics],
  };
}

/** Compose SHARED facts with an immutable proposal snapshot while retaining its provenance. */
export function effectiveProposalIndex(
  shared: ProjectIndex,
  proposalIndex: ProjectIndex,
  proposal: Pick<ArchitecturalProposal, "id" | "title">,
): ProjectIndex {
  const sharedProvenance: AnalysisProvenance = { kind: "shared", id: shared.provenance?.id ?? `shared:${shared.projectId}` };
  const proposalProvenance: AnalysisProvenance = { kind: "proposal", id: proposal.id, label: proposal.title };
  const mark = <T extends ResourceDescriptor>(resources: T[], provenance: AnalysisProvenance): T[] => resources.map((resource) => ({ ...resource, provenance }));
  const proposalIds = new Set(proposalIndex.resources.map((resource) => resource.id));
  return {
    ...shared,
    provenance: proposalProvenance,
    resources: [...mark(shared.resources.filter((resource) => !proposalIds.has(resource.id)), sharedProvenance), ...mark(proposalIndex.resources, proposalProvenance)],
    diagrams: [...mark(shared.diagrams.filter((resource) => !proposalIds.has(resource.id)), sharedProvenance), ...mark(proposalIndex.diagrams, proposalProvenance)],
    eventFlows: [...mark(shared.eventFlows.filter((resource) => !proposalIds.has(resource.id)), sharedProvenance), ...mark(proposalIndex.eventFlows, proposalProvenance)],
    documents: [...mark(shared.documents.filter((resource) => !proposalIds.has(resource.id)), sharedProvenance), ...mark(proposalIndex.documents, proposalProvenance)],
    participants: [...shared.participants.filter((entry) => !proposalIds.has(entry.resourceId)), ...proposalIndex.participants],
    usages: [...shared.usages.filter((entry) => !proposalIds.has(entry.resourceId)), ...proposalIndex.usages],
    references: [...shared.references.filter((entry) => !proposalIds.has(entry.from)), ...proposalIndex.references],
    semanticMessages: [...(shared.semanticMessages ?? []), ...(proposalIndex.semanticMessages ?? []).filter((message) => !(shared.semanticMessages ?? []).some((existing) => existing.id === message.id))],
    semanticOccurrences: [...(shared.semanticOccurrences ?? []).filter((entry) => !proposalIds.has(entry.resourceId)), ...(proposalIndex.semanticOccurrences ?? [])],
    eventFlowMessages: [...(shared.eventFlowMessages ?? []).filter((entry) => !proposalIds.has(entry.resourceId)), ...(proposalIndex.eventFlowMessages ?? [])],
    eventFlowCausality: [...(shared.eventFlowCausality ?? []).filter((entry) => !proposalIds.has(entry.resourceId)), ...(proposalIndex.eventFlowCausality ?? [])],
    diagnostics: [...shared.diagnostics.filter((entry) => !proposalIds.has(entry.resourceId)), ...proposalIndex.diagnostics],
  };
}

export interface AnalysisAnchor {
  messageId: string;
  occurrence?: ComparisonOccurrence;
}

export interface AnalysisOptions {
  direction: TraceDirection;
  maxDepth: number;
  maxNodes: number;
  includeCandidates: boolean;
  includeRecovery: boolean;
}

export interface AnalysisSide {
  trace: ArchitectureTrace | null;
  resolution: "authoritative" | "candidate" | "unknown";
  documentedMessageIds: string[];
  effects: TraceNode[];
  unknownBoundaries: TraceNode[];
  recovery: "documented" | "unknown";
  cycles: number;
}

export interface AnalysisMessage {
  identity: SemanticMessageIdentity;
  side: "shared" | "a" | "b";
  occurrencesA: ComparisonOccurrence[];
  occurrencesB: ComparisonOccurrence[];
  provenanceA?: string;
  provenanceB?: string;
}

export interface CrossContextAnalysis {
  anchor: AnalysisAnchor | null;
  semanticConnections: SemanticMessageIdentity[];
  explicitRelationships: ResourceRelationship[];
  messages: AnalysisMessage[];
  documentedOnlyA: AnalysisMessage[];
  documentedOnlyB: AnalysisMessage[];
  candidates: ComparisonOccurrence[];
  sides: { a: AnalysisSide; b: AnalysisSide };
  staleAnchor: boolean;
  contexts: { a: AnalysisContext; b: AnalysisContext };
}

const emptySide: AnalysisSide = {
  trace: null,
  resolution: "unknown",
  documentedMessageIds: [],
  effects: [],
  unknownBoundaries: [],
  recovery: "unknown",
  cycles: 0,
};

export function crossContextAnalysis(
  contextA: AnalysisContext,
  contextB: AnalysisContext,
  comparison: SemanticComparison,
  anchor: AnalysisAnchor | null,
  options: AnalysisOptions,
  relationships: ResourceRelationship[] = [],
): CrossContextAnalysis {
  const explicitRelationships = relationships.filter((relationship) =>
    Boolean(contextA.resourceId && contextB.resourceId) &&
    (relationship.contextId === undefined || relationship.contextId === contextA.knowledgeContext.id || relationship.contextId === contextB.knowledgeContext.id) &&
    ((relationship.sourceId === contextA.resourceId && relationship.targetId === contextB.resourceId) ||
      (relationship.sourceId === contextB.resourceId && relationship.targetId === contextA.resourceId)),
  );
  const identity = anchor ? comparison.identities.get(anchor.messageId) : undefined;
  const validAnchor = Boolean(identity);
  const staleAnchor = Boolean(anchor && !validAnchor);
  const sides = validAnchor && anchor
    ? { a: traceSide(contextA, { messageId: anchor.messageId }, options), b: traceSide(contextB, { messageId: anchor.messageId }, options) }
    : { a: emptySide, b: emptySide };
  const idsA = new Set(sides.a.documentedMessageIds);
  const idsB = new Set(sides.b.documentedMessageIds);
  const traceIdentities = [...comparison.identities.values()].filter((message) => idsA.has(message.id) || idsB.has(message.id));
  const messages = traceIdentities.map((message) => ({
    identity: message,
    side: idsA.has(message.id) && idsB.has(message.id) ? "shared" as const : idsA.has(message.id) ? "a" as const : "b" as const,
    occurrencesA: comparison.occurrences.a.filter((entry) => entry.messageId === message.id),
    occurrencesB: comparison.occurrences.b.filter((entry) => entry.messageId === message.id),
    provenanceA: idsA.has(message.id) ? contextLabel(contextA) : undefined,
    provenanceB: idsB.has(message.id) ? contextLabel(contextB) : undefined,
  }));
  return {
    anchor: validAnchor ? anchor : null,
    semanticConnections: messages.filter((message) => message.side === "shared").map((message) => message.identity),
    explicitRelationships,
    messages,
    documentedOnlyA: messages.filter((message) => message.side === "a"),
    documentedOnlyB: messages.filter((message) => message.side === "b"),
    candidates: comparison.candidates,
    sides,
    staleAnchor,
    contexts: { a: contextA, b: contextB },
  };
}

function traceSide(context: AnalysisContext, start: TraceQueryStart, options: AnalysisOptions): AnalysisSide {
  if (!context.resourceId) return emptySide;
  const result = traceArchitectureQuery(scopeToResource(context.index, context.resourceId), start, options);
  const trace = result.trace;
  if (!trace) return { ...emptySide, resolution: result.resolution.status };
  const provenance = context.knowledgeContext.kind === "private-work"
    ? { kind: "private-work" as const, id: context.knowledgeContext.id, label: context.knowledgeContext.name }
    : context.knowledgeContext.kind === "proposal"
      ? { kind: "proposal" as const, id: context.knowledgeContext.id, label: context.knowledgeContext.title }
      : { kind: context.knowledgeContext.kind, id: context.knowledgeContext.id };
  for (const node of trace.nodes) if (node.source && !node.source.provenance) node.source.provenance = provenance;
  for (const edge of trace.edges) if (edge.source && !edge.source.provenance) edge.source.provenance = provenance;
  const documentedMessageIds = [...new Set(trace.nodes.flatMap((node) => {
    if (node.kind === "identity") return [node.identity.id];
    if (node.kind === "causal-message" && node.messageRef) return [node.messageRef];
    if (node.kind === "execution-occurrence" && node.occurrence.messageRef) return [node.occurrence.messageRef];
    return [];
  }))];
  return {
    trace,
    resolution: result.resolution.status,
    documentedMessageIds,
    effects: trace.nodes.filter((node) => node.kind === "effect"),
    unknownBoundaries: trace.nodes.filter((node) => node.kind === "unknown-boundary"),
    recovery: trace.nodes.some((node) => node.kind === "failure" || node.kind === "retry") ? "documented" : "unknown",
    cycles: trace.edges.filter((edge) => edge.cycleReference).length,
  };
}

function contextLabel(context: AnalysisContext): string {
  if (context.knowledgeContext.kind === "private-work") return `MY WORK · ${context.knowledgeContext.name}`;
  if (context.knowledgeContext.kind === "proposal") return `PROPOSAL · ${context.knowledgeContext.title}`;
  return context.knowledgeContext.kind.toUpperCase();
}

function scopeToResource(index: ProjectIndex, resourceId: string): ProjectIndex {
  const semanticOccurrences = (index.semanticOccurrences ?? []).filter((entry) => entry.resourceId === resourceId);
  const eventFlowMessages = (index.eventFlowMessages ?? []).filter((entry) => entry.resourceId === resourceId);
  const messageIds = new Set([
    ...semanticOccurrences.flatMap((entry) => entry.messageRef ? [entry.messageRef] : []),
    ...eventFlowMessages.flatMap((entry) => entry.messageRef ? [entry.messageRef] : []),
  ]);
  return {
    ...index,
    resources: index.resources.filter((resource) => resource.id === resourceId),
    diagrams: index.diagrams.filter((resource) => resource.id === resourceId),
    eventFlows: index.eventFlows.filter((resource) => resource.id === resourceId),
    semanticMessages: (index.semanticMessages ?? []).filter((message) => messageIds.has(message.id)),
    semanticOccurrences,
    eventFlowMessages,
    eventFlowCausality: (index.eventFlowCausality ?? []).filter((entry) => entry.resourceId === resourceId),
    references: index.references.filter((reference) => reference.from === resourceId || reference.to === resourceId),
  };
}
