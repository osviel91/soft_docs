import type { AuditEvent } from "./audit-repository";
import type { ResourceAuthorship } from "../../domain/workspace/resource-revision";
import type { ResourceMetadata } from "../../domain/workspace/resource-metadata";
import type { ResourceType } from "../../domain/workspace/resource-id";
import type { WorkspaceOperationRecord } from "./workspace-operation-repository";
import type { PromotionEntry, PromotionRelationshipChange, PromotionSemanticMessageChange } from "../../domain/workspace/promotion";

export type AuthoritativeBatchOperation =
  | {
      operation: "create";
      resourceId: string;
      path: string;
      type: ResourceType;
      content: string;
      metadata?: ResourceMetadata;
      stagedPath?: string;
    }
  | {
      operation: "update";
      resourceId: string;
      sourcePath?: string;
      path: string;
      expectedRevision: number;
      content: string;
      metadata?: ResourceMetadata;
      stagedPath?: string;
    }
  | {
      operation: "retire";
      resourceId: string;
      path: string;
      expectedRevision: number;
    };

export interface AuthoritativeBatchIntent {
  batchId: string;
  projectId: string;
  actor: ResourceAuthorship;
  audit: AuditEvent;
  operations: AuthoritativeBatchOperation[];
  idempotencyKey?: string;
  manifest?: { expectedRevision: number; expectedContent: string | null; content: string; stagedPath?: string };
  relationshipChanges?: PromotionRelationshipChange[];
  semanticChanges?: PromotionSemanticMessageChange[];
  promotion?: { id: string; proposalId: string; baseSharedRevision: string; baseManifestRevision?: number; entries: PromotionEntry[]; relationships: PromotionRelationshipChange[]; semanticMessages?: PromotionSemanticMessageChange[] };
}

export interface AuthoritativeBatchRecord {
  id: string;
  projectId: string;
  status: "pending" | "completed" | "failed";
  createdAt: Date;
  completedAt?: Date;
  operations: WorkspaceOperationRecord[];
  promotionId?: string;
  manifest?: { expectedContent: string | null; content: string; stagedPath?: string };
}

export interface AuthoritativeBatchRepository {
  /** Claim every SQL-visible operation in one transaction. */
  claim(input: AuthoritativeBatchIntent): Promise<AuthoritativeBatchRecord>;
  /** Mark the logical operation complete after every filesystem member settles. */
  complete(batchId: string): Promise<AuthoritativeBatchRecord | null>;
  get(batchId: string): Promise<AuthoritativeBatchRecord | null>;
  listIncomplete(limit?: number): Promise<AuthoritativeBatchRecord[]>;
}
