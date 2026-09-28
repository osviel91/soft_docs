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
  operation?: "CREATE" | "UPDATE" | "RETIRE";
  baseResourceId?: string;
  basePath?: string;
  baseRevision?: number;
}

export interface ProposalSemanticMessageSnapshot extends SemanticMessageIdentity {
  sourceContextId: string;
  operation?: "ADD" | "UPDATE" | "RETIRE";
  baseName?: string;
  baseKind?: "event" | "command";
}

export interface ProposalRelationshipSnapshot extends ResourceRelationship {
  sourceContextId: string;
  operation?: "ADD" | "UPDATE" | "REMOVE";
  baseFingerprint?: string;
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
  /** Null means this legacy proposal predates manifest-base capture. */
  baseManifestRevision: number | null;
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
  reviewStatus?: ProposalReviewStatus;
  approvals?: number;
  changesRequested?: number;
}

export type ProposalReviewDecision = "APPROVE" | "REQUEST_CHANGES";
export type ProposalReviewStatus = "none" | "approved" | "changes-requested" | "mixed";

export interface ProposalReview {
  id: string;
  proposalId: string;
  reviewerUserId: string;
  reviewerDisplayName?: string;
  decision: ProposalReviewDecision;
  summary?: string;
  createdAt: Date;
  updatedAt: Date;
  proposalBaseRevision: string;
  observedSharedRevision: string;
}

export interface ProposalReviewSummary {
  status: ProposalReviewStatus;
  approvals: number;
  changesRequested: number;
  reviews: ProposalReview[];
}
