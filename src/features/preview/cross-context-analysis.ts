import { traceArchitectureQuery, type ArchitectureTrace, type TraceDirection, type TraceNode, type TraceQueryStart } from "../../domain/project/architecture-trace";
import type { ProjectIndex } from "../../domain/project/project-index";
import type { ResourceRelationship } from "../../domain/workspace/resource-relationship";
import type { SemanticMessageIdentity } from "../../domain/workspace/metadata";
import type { ComparisonOccurrence, SemanticComparison } from "./semantic-comparison";

export interface AnalysisContext {
  index: ProjectIndex;
  resourceId: string | null;
  resourcePath?: string;
  sessionId?: string;
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
  };
}

function traceSide(context: AnalysisContext, start: TraceQueryStart, options: AnalysisOptions): AnalysisSide {
  if (!context.resourceId) return emptySide;
  const result = traceArchitectureQuery(scopeToResource(context.index, context.resourceId), start, options);
  const trace = result.trace;
  if (!trace) return { ...emptySide, resolution: result.resolution.status };
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
