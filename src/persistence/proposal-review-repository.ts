import type { ProposalReviewRepository } from "../application/ports/proposal-review-repository";
import type { ProposalReview } from "../domain/workspace/architectural-proposal";
import type { SqlClient } from "./sql-client";
import { createIdGenerator, type IdGenerator } from "../shared/ids/uuid";

const date = (value: unknown) => value instanceof Date ? value : new Date(String(value));

function reviewOf(row: Record<string, unknown>): ProposalReview {
  return {
    id: String(row.id), proposalId: String(row.proposal_id), reviewerUserId: String(row.reviewer_user_id),
    ...(row.reviewer_display_name == null ? {} : { reviewerDisplayName: String(row.reviewer_display_name) }),
    decision: row.decision as ProposalReview["decision"],
    ...(row.summary == null ? {} : { summary: String(row.summary) }),
    createdAt: date(row.created_at), updatedAt: date(row.updated_at),
    proposalBaseRevision: String(row.proposal_base_revision), observedSharedRevision: String(row.observed_shared_revision),
  };
}

export function createProposalReviewRepository(client: SqlClient, options: { newId?: IdGenerator } = {}): ProposalReviewRepository {
  const newId = options.newId ?? createIdGenerator();
  return {
    async submit(input) {
      const result = await client.query(
        `INSERT INTO architectural_proposal_reviews (id, proposal_id, reviewer_user_id, decision, summary, proposal_base_revision, observed_shared_revision)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *, (SELECT display_name FROM users WHERE id = reviewer_user_id) AS reviewer_display_name`,
        [newId(), input.proposalId, input.reviewerUserId, input.decision, input.summary ?? null, input.proposalBaseRevision, input.observedSharedRevision],
      );
      return reviewOf(result.rows[0]);
    },
    async list(proposalId) {
      const result = await client.query(
        `SELECT r.*, u.display_name AS reviewer_display_name
           FROM architectural_proposal_reviews r JOIN users u ON u.id = r.reviewer_user_id
          WHERE r.proposal_id = $1 ORDER BY r.created_at ASC, r.id ASC`,
        [proposalId],
      );
      return result.rows.map(reviewOf);
    },
  };
}
