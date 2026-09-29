/** Migration 0025: immutable proposal revision and withdrawal lifecycle. */
export const up = String.raw`
ALTER TABLE architectural_proposals
  DROP CONSTRAINT architectural_proposals_status_known,
  ADD CONSTRAINT architectural_proposals_status_known CHECK (status IN ('open', 'withdrawn', 'superseded'));
ALTER TABLE architectural_proposals
  ADD COLUMN supersedes_proposal_id uuid REFERENCES architectural_proposals (id) ON DELETE RESTRICT,
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN withdrawn_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN withdrawal_reason text,
  ADD COLUMN superseded_at timestamptz;
CREATE UNIQUE INDEX architectural_proposals_one_successor_idx ON architectural_proposals (supersedes_proposal_id) WHERE supersedes_proposal_id IS NOT NULL;
CREATE INDEX architectural_proposals_lineage_idx ON architectural_proposals (project_id, supersedes_proposal_id);
`;
