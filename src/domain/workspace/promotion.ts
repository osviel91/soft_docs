import type { ResourceRelationship } from "./resource-relationship";
import type { ResourceType } from "./resource-id";
import type { ResourceAuthorship } from "./resource-revision";

export type PromotionOperation = "CREATE" | "UPDATE" | "RETIRE";

export interface PromotionEntry {
  id: string;
  proposalResourceId: string;
  operation: PromotionOperation;
  path: string;
  type: ResourceType;
  baseResourceId?: string;
  baseRevision?: number;
  resultingResourceId: string;
  resultingRevision: number;
  resultingLifecycle: "ACTIVE" | "RETIRED";
}

export interface PromotionRelationshipChange {
  operation: "ADD" | "REMOVE";
  relationship: ResourceRelationship;
}

export interface Promotion {
  id: string;
  projectId: string;
  proposalId: string;
  actor: ResourceAuthorship;
  createdAt: Date;
  baseSharedRevision: string;
  resultingSharedRevision: string;
  entries: PromotionEntry[];
  relationships: PromotionRelationshipChange[];
  status: "COMMITTED_COMPLETION_PENDING" | "COMPLETED";
  completedAt?: Date;
}

export interface PromotionPreview {
  proposalId: string;
  projectId: string;
  reviewStatus: "none" | "approved" | "changes-requested" | "mixed";
  eligible: boolean;
  blockers: Array<{ code: string; message: string; resourceId?: string; expectedRevision?: number; currentRevision?: number }>;
  baseSharedRevision: string;
  currentSharedRevision: string;
  staleBase: boolean;
  creates: PromotionEntry[];
  updates: PromotionEntry[];
  retires: PromotionEntry[];
  semanticIdentityAdditions: string[];
  semanticIdentityReuses: string[];
  relationships: PromotionRelationshipChange[];
}
