import { diffResources, type ResourceDiff } from "../domain/diff/resource-diff";
import type { ArchitecturalProposal } from "../domain/workspace/architectural-proposal";
import type { ResourceState } from "../domain/diff/resource-state";
import type { ResourceType } from "../domain/workspace/resource-id";

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
  impact: { resourcesAdded: number; resourcesModified: number; resourcesDeleted: number; relationshipsChanged: number; semanticIdentitiesChanged: number };
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
  return {
    proposalId: proposal.id,
    baseSharedRevision: proposal.baseSharedRevision,
    currentSharedRevision: currentSharedRevision.revision,
    staleBase: proposal.baseSharedRevision !== currentSharedRevision.revision,
    resources,
    relationships,
    semanticIdentities,
    impact: { resourcesAdded: resources.filter((entry) => entry.operation === "ADDED").length, resourcesModified: resources.filter((entry) => entry.operation === "MODIFIED").length, resourcesDeleted: resources.filter((entry) => entry.operation === "DELETED").length, relationshipsChanged: relationships.length, semanticIdentitiesChanged: semanticIdentities.length },
  };
}
