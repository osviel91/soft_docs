/** Migration 0018: append-only architectural proposal review evidence. */
export const up = String.raw`
CREATE TABLE architectural_proposal_reviews (
  id uuid PRIMARY KEY,
  proposal_id uuid NOT NULL REFERENCES architectural_proposals (id) ON DELETE CASCADE,
  reviewer_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  decision text NOT NULL,
  summary text,
  proposal_base_revision text NOT NULL,
  observed_shared_revision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT architectural_proposal_reviews_decision_known CHECK (decision IN ('APPROVE', 'REQUEST_CHANGES')),
  CONSTRAINT architectural_proposal_reviews_summary_length CHECK (summary IS NULL OR length(summary) <= 4000)
);
CREATE INDEX architectural_proposal_reviews_proposal_idx ON architectural_proposal_reviews (proposal_id, created_at DESC, id DESC);
`;
