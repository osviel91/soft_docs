import { nodeIdOf } from "../../domain/diagram/node-id";
import type { ProjectIndex } from "../../domain/project/project-index";
import type { SemanticMessageIdentity } from "../../domain/workspace/metadata";
import type { ResourceRelationship } from "../../domain/workspace/resource-relationship";
import type { AnalysisContext } from "./cross-context-analysis";

export type ComparisonPane = "a" | "b";

export interface ComparisonOccurrence {
  resourceId: string;
  contextId?: string;
  messageId?: string;
  name: string;
  kind: "event" | "command";
  operation?: "publish" | "consume" | "dispatch";
  nodeId: string;
  step?: number;
}

export interface SemanticComparison {
  occurrences: Record<ComparisonPane, ComparisonOccurrence[]>;
  identities: Map<string, SemanticMessageIdentity>;
  shared: SemanticMessageIdentity[];
  onlyA: SemanticMessageIdentity[];
  onlyB: SemanticMessageIdentity[];
  candidates: ComparisonOccurrence[];
  relationship: ResourceRelationship | null;
  contexts?: { a: AnalysisContext; b: AnalysisContext };
}

function occurrencesFor(index: ProjectIndex, resourceId: string): ComparisonOccurrence[] {
  const sequence = (index.semanticOccurrences ?? [])
    .filter((entry) => entry.resourceId === resourceId)
    .map((entry) => ({
      resourceId,
      contextId: index.provenance?.id,
      messageId: entry.messageRef,
      name: entry.name,
      kind: entry.kind,
      operation: entry.operation,
      nodeId: nodeIdOf("message", entry.range),
      step: entry.step,
    }));
  const flow = (index.eventFlowMessages ?? [])
    .filter((entry) => entry.resourceId === resourceId)
    .map((entry) => ({
      resourceId,
      contextId: index.provenance?.id,
      messageId: entry.messageRef,
      name: entry.name,
      kind: entry.kind,
      nodeId: entry.nodeId ?? nodeIdOf("event", entry.sourceRange!),
    }));
  return [...sequence, ...flow];
}

export function semanticComparison(
  index: ProjectIndex | null,
  resourceA: string | null,
  resourceB: string | null,
  relationships: ResourceRelationship[] = [],
): SemanticComparison {
  const empty: SemanticComparison = {
    occurrences: { a: [], b: [] }, identities: new Map(), shared: [], onlyA: [], onlyB: [], candidates: [], relationship: null,
  };
  if (!index || !resourceA || !resourceB) return empty;
  const occurrences = {
    a: occurrencesFor(index, resourceA),
    b: occurrencesFor(index, resourceB),
  };
  const identities = new Map((index.semanticMessages ?? []).map((identity) => [identity.id, identity]));
  const isAuthoritative = (entry: ComparisonOccurrence) => Boolean(
    entry.messageId && identities.get(entry.messageId)?.kind === entry.kind,
  );
  const idsA = new Set(occurrences.a.filter(isAuthoritative).map((entry) => entry.messageId!));
  const idsB = new Set(occurrences.b.filter(isAuthoritative).map((entry) => entry.messageId!));
  const shared = [...idsA].filter((id) => idsB.has(id)).map((id) => identities.get(id)!);
  const onlyA = [...idsA].filter((id) => !idsB.has(id)).map((id) => identities.get(id)!);
  const onlyB = [...idsB].filter((id) => !idsA.has(id)).map((id) => identities.get(id)!);
  const candidates = [...occurrences.a, ...occurrences.b].filter((entry) => !isAuthoritative(entry));
  const relationship = relationships.find((entry) =>
    (entry.sourceId === resourceA && entry.targetId === resourceB) ||
    (entry.sourceId === resourceB && entry.targetId === resourceA),
  ) ?? null;
  return { occurrences, identities, shared, onlyA, onlyB, candidates, relationship };
}

/** Compare two authorized knowledge contexts without treating names as identity. */
export function semanticComparisonAcrossContexts(
  contextA: AnalysisContext,
  contextB: AnalysisContext,
  relationships: ResourceRelationship[] = [],
): SemanticComparison {
  const occurrences = {
    a: contextA.resourceId ? occurrencesFor(contextA.index, contextA.resourceId) : [],
    b: contextB.resourceId ? occurrencesFor(contextB.index, contextB.resourceId) : [],
  };
  const base: SemanticComparison = {
    occurrences,
    identities: new Map(),
    shared: [],
    onlyA: [],
    onlyB: [],
    candidates: [],
    relationship: relationships.find((entry) =>
      contextA.resourceId && contextB.resourceId &&
      ((entry.sourceId === contextA.resourceId && entry.targetId === contextB.resourceId) ||
        (entry.sourceId === contextB.resourceId && entry.targetId === contextA.resourceId)),
    ) ?? null,
  };
  const relationship = base.relationship && (
    base.relationship.contextId === undefined ||
    base.relationship.contextId === contextA.knowledgeContext.id ||
    base.relationship.contextId === contextB.knowledgeContext.id
  ) ? base.relationship : null;
  const identitiesA = new Map((contextA.index.semanticMessages ?? []).map((message) => [message.id, message]));
  const identitiesB = new Map((contextB.index.semanticMessages ?? []).map((message) => [message.id, message]));
  const authoritative = (entry: ComparisonOccurrence, identities: Map<string, SemanticMessageIdentity>) =>
    Boolean(entry.messageId && identities.get(entry.messageId)?.kind === entry.kind);
  const a = base.occurrences.a.filter((entry) => authoritative(entry, identitiesA));
  const b = base.occurrences.b.filter((entry) => authoritative(entry, identitiesB));
  const idsA = new Set(a.map((entry) => entry.messageId!));
  const idsB = new Set(b.map((entry) => entry.messageId!));
  // If an id is explicitly reused, SHARED remains the display authority.
  const identities = new Map([...identitiesB, ...identitiesA]);
  const shared = [...idsA].filter((id) => idsB.has(id)).map((id) => identities.get(id)).filter((entry): entry is SemanticMessageIdentity => entry !== undefined);
  const onlyA = [...idsA].filter((id) => !idsB.has(id)).map((id) => identitiesA.get(id)).filter((entry): entry is SemanticMessageIdentity => entry !== undefined);
  const onlyB = [...idsB].filter((id) => !idsA.has(id)).map((id) => identitiesB.get(id)).filter((entry): entry is SemanticMessageIdentity => entry !== undefined);
  return {
    ...base,
    identities,
    shared,
    onlyA,
    onlyB,
    candidates: [
      ...base.occurrences.a.filter((entry) => !authoritative(entry, identitiesA)),
      ...base.occurrences.b.filter((entry) => !authoritative(entry, identitiesB)),
    ],
    relationship,
    contexts: { a: contextA, b: contextB },
  };
}
