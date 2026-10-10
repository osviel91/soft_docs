export type ProposalAttentionCategory =
  | "PENDING_REVIEW"
  | "CHANGES_REQUESTED"
  | "APPROVED_PENDING_PROMOTION"
  | "PROMOTION_COMPLETION_PENDING"
  | "PROMOTED"
  | "WITHDRAWN"
  | "SUPERSEDED";

export type ProposalInboxStatus = "open" | "withdrawn" | "superseded";

export interface ProposalInboxFilters {
  workspaceId?: string;
  projectId?: string;
  status?: ProposalInboxStatus[];
  attentionCategory?: ProposalAttentionCategory[];
  search?: string;
  limit: number;
}

export interface ProposalInboxItem {
  proposalId: string;
  title: string;
  status: ProposalInboxStatus;
  author: { userId: string; displayName: string | null };
  workspace: { id: string; name: string };
  project: { id: string; name: string };
  createdAt: string;
  submittedAt: string;
  lastActivityAt: string;
  review: {
    status: "none" | "approved" | "changes-requested" | "mixed";
    approvals: number;
    changesRequested: number;
  };
  promotion: {
    status: "COMMITTED_COMPLETION_PENDING" | "COMPLETED" | null;
    createdAt: string | null;
    completedAt: string | null;
  };
  lifecycle: "OPEN" | "CHANGES_REQUESTED" | "APPROVED" | "PROMOTING" | "PROMOTED" | "WITHDRAWN" | "SUPERSEDED";
  attentionCategory: ProposalAttentionCategory;
}

export interface ProposalInboxRepository {
  query(input: {
    userId: string;
    allowedProjectIds: readonly string[] | null;
    filters: ProposalInboxFilters;
    after?: { at: string; id: string };
  }): Promise<{
    items: ProposalInboxItem[];
    hasMore: boolean;
    nextPosition: { at: string; id: string } | null;
    counts: Record<ProposalAttentionCategory, number>;
  }>;
}
