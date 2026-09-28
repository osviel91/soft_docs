/** Migration 0023: explicit relationship and semantic manifest operations. */
export const up = String.raw`
ALTER TABLE architectural_proposals
  ADD COLUMN IF NOT EXISTS base_manifest_revision integer;
ALTER TABLE architectural_proposal_messages
  ADD COLUMN IF NOT EXISTS operation text NOT NULL DEFAULT 'ADD',
  ADD COLUMN IF NOT EXISTS base_name text,
  ADD COLUMN IF NOT EXISTS base_kind text;
ALTER TABLE architectural_proposal_relationships
  ADD COLUMN IF NOT EXISTS operation text NOT NULL DEFAULT 'ADD',
  ADD COLUMN IF NOT EXISTS base_fingerprint text;
ALTER TABLE architectural_proposal_messages
  ADD CONSTRAINT architectural_proposal_messages_operation_known
    CHECK (operation IN ('ADD', 'UPDATE', 'RETIRE'));
ALTER TABLE architectural_proposal_relationships
  ADD CONSTRAINT architectural_proposal_relationships_operation_known
    CHECK (operation IN ('ADD', 'UPDATE', 'REMOVE'));
ALTER TABLE promotion_relationship_changes
  DROP CONSTRAINT promotion_relationship_changes_operation_known,
  ADD CONSTRAINT promotion_relationship_changes_operation_known
    CHECK (operation IN ('ADD', 'UPDATE', 'REMOVE'));
ALTER TABLE promotions ADD COLUMN base_manifest_revision integer NOT NULL DEFAULT 0;
ALTER TABLE promotions ADD COLUMN semantic_changes jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE promotion_relationship_changes ADD COLUMN base_fingerprint text;
`;
