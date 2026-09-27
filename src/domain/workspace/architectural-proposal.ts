import type { ResourceMetadata } from "./resource-metadata";
import type { ResourceType } from "./resource-id";
import type { ResourceRelationship } from "./resource-relationship";
import type { SemanticMessageIdentity } from "./metadata";

export interface ProposalResourceSnapshot {
  sourceResourceId: string;
  path: string;
  type: ResourceType;
  sourceRevision: number;
  content: string;
  metadata?: ResourceMetadata;
}

export interface ProposalSemanticMessageSnapshot extends SemanticMessageIdentity {
  sourceContextId: string;
}

export interface ProposalRelationshipSnapshot extends ResourceRelationship {
  sourceContextId: string;
}

export interface ArchitecturalProposal {
  id: string;
  projectId: string;
  authorUserId: string;
  sourcePrivateContextId: string;
  title: string;
  description?: string;
  status: "open";
  baseSharedRevision: string;
  baseSharedResourceRevisions: Record<string, number>;
  createdAt: Date;
  submittedAt: Date;
  resources: ProposalResourceSnapshot[];
  semanticMessages: ProposalSemanticMessageSnapshot[];
  relationships: ProposalRelationshipSnapshot[];
}

export interface ArchitecturalProposalSummary
  extends Omit<ArchitecturalProposal, "resources" | "semanticMessages" | "relationships"> {
  staleBase: boolean;
  currentSharedRevision: string;
}
