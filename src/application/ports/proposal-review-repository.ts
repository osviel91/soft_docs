import type { ProposalReview, ProposalReviewDecision } from "../../domain/workspace/architectural-proposal";

export interface ProposalReviewRepository {
  submit(input: {
    proposalId: string;
    reviewerUserId: string;
    decision: ProposalReviewDecision;
    summary?: string;
    proposalBaseRevision: string;
    observedSharedRevision: string;
  }): Promise<ProposalReview>;
  list(proposalId: string): Promise<ProposalReview[]>;
}
