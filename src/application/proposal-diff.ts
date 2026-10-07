import { diffResources, type ResourceDiff } from "../domain/diff/resource-diff";
import type { ArchitecturalProposal } from "../domain/workspace/architectural-proposal";
import type { ResourceState } from "../domain/diff/resource-state";
import type { ResourceType } from "../domain/workspace/resource-id";
import type { EntityAnchor, BindingEvidence } from "../domain/workspace/semantic-binding";

export interface ArchitecturalProposalResourceDiff extends ResourceDiff {
  path: string;
  type: ResourceType;
  operation: "ADDED" | "MODIFIED" | "DELETED";
  baseRevision?: number;
  basePath?: string;
  baseContent: string;
  proposedContent: string;
}

export interface ArchitecturalProposalDiff {
  proposalId: string;
  baseSharedRevision: string;
  currentSharedRevision: string;
  staleBase: boolean;
  resources: ArchitecturalProposalResourceDiff[];
  relationships: Array<{ operation: "ADDED" | "MODIFIED" | "DELETED"; label: string }>;
  semanticIdentities: Array<{ operation: "ADDED" | "MODIFIED" | "DELETED"; label: string }>;
  semanticBindings: Array<{ operation: "ADDED" | "MODIFIED" | "DELETED"; bindingId: string; endpointDelta: { before: { left: EntityAnchor; right: EntityAnchor } | null; after: { left: EntityAnchor; right: EntityAnchor } | null }; relationDelta: { before: string | null; after: string | null }; evidenceDelta: { before: BindingEvidence | null; after: BindingEvidence | null } }>;
  impact: { resourcesAdded: number; resourcesModified: number; resourcesDeleted: number; relationshipsChanged: number; semanticIdentitiesChanged: number; semanticBindingsChanged: number };
}

export async function architecturalProposalDiff(
  proposal: ArchitecturalProposal,
  currentSharedRevision: { revision: string },
  getRevision: (resourceId: string, revision: number) => Promise<{ content: string; type: ResourceType; metadata?: ResourceState["metadata"] } | null>,
): Promise<ArchitecturalProposalDiff> {
  const resources: ArchitecturalProposalResourceDiff[] = [];
  for (const snapshot of proposal.resources) {
    const baseId = snapshot.baseResourceId ?? snapshot.sourceResourceId;
    const baseRevision = snapshot.baseRevision ?? proposal.baseSharedResourceRevisions[baseId];
    const base = baseRevision === undefined ? null : await getRevision(baseId, baseRevision);
    const operation = snapshot.operation === "RETIRE" ? "DELETED" : snapshot.operation === "CREATE" || !base ? "ADDED" : "MODIFIED";
    const baseContent = base?.content ?? "";
    const proposedContent = operation === "DELETED" ? "" : snapshot.content;
    const baseState: ResourceState = { content: baseContent, type: base?.type ?? snapshot.type, ...(base?.metadata === undefined ? {} : { metadata: base.metadata }) };
    const proposedState: ResourceState = { content: proposedContent, type: snapshot.type, ...(snapshot.metadata === undefined ? {} : { metadata: snapshot.metadata }) };
    resources.push({ ...diffResources(baseState, proposedState), path: snapshot.path, type: snapshot.type, operation, ...(baseRevision === undefined ? {} : { baseRevision }), ...(snapshot.basePath === undefined ? {} : { basePath: snapshot.basePath }), baseContent, proposedContent });
  }
  const relationships = proposal.relationships.filter((entry) => entry.operation !== undefined).map((entry) => ({ operation: entry.operation === "REMOVE" ? "DELETED" as const : entry.operation === "UPDATE" ? "MODIFIED" as const : "ADDED" as const, label: `${entry.sourceId} -> ${entry.targetId} (${entry.kind})` }));
  const semanticIdentities = proposal.semanticMessages.filter((entry) => entry.operation !== undefined).map((entry) => ({ operation: entry.operation === "RETIRE" ? "DELETED" as const : entry.operation === "UPDATE" ? "MODIFIED" as const : "ADDED" as const, label: `${entry.name} (${entry.kind})` }));
  const semanticBindings = (proposal.semanticBindings ?? []).map((entry) => {
    const operation = entry.operation === "REMOVE" ? "DELETED" as const : entry.operation === "UPDATE" ? "MODIFIED" as const : "ADDED" as const;
    const before = entry.operation === "UPDATE" ? entry.baseBinding.evidence : entry.operation === "REMOVE" ? entry.binding.evidence : null;
    const after = entry.operation === "REMOVE" ? null : entry.binding.evidence;
     return { operation, bindingId: entry.operation === "REMOVE" ? entry.bindingId : entry.binding.id, endpointDelta: { before: entry.operation === "ADD" ? null : { left: entry.operation === "UPDATE" ? entry.baseBinding.left : entry.binding.left, right: entry.operation === "UPDATE" ? entry.baseBinding.right : entry.binding.right }, after: entry.operation === "REMOVE" ? null : { left: entry.binding.left, right: entry.binding.right } }, relationDelta: { before: entry.operation === "ADD" ? null : entry.operation === "UPDATE" ? entry.baseBinding.relation : entry.binding.relation, after: entry.operation === "REMOVE" ? null : entry.binding.relation }, evidenceDelta: { before, after } };
  });
  return {
    proposalId: proposal.id,
    baseSharedRevision: proposal.baseSharedRevision,
    currentSharedRevision: currentSharedRevision.revision,
    staleBase: proposal.baseSharedRevision !== currentSharedRevision.revision,
    resources,
    relationships,
    semanticIdentities,
    semanticBindings,
     impact: { resourcesAdded: resources.filter((entry) => entry.operation === "ADDED").length, resourcesModified: resources.filter((entry) => entry.operation === "MODIFIED").length, resourcesDeleted: resources.filter((entry) => entry.operation === "DELETED").length, relationshipsChanged: relationships.length, semanticIdentitiesChanged: semanticIdentities.length, semanticBindingsChanged: semanticBindings.length },
  };
}
