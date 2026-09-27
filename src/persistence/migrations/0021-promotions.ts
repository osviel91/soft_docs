/** Migration 0021: append-only authoritative promotion evidence. */
export const up = String.raw`
CREATE TABLE promotions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  proposal_id uuid NOT NULL REFERENCES architectural_proposals (id) ON DELETE RESTRICT,
  actor jsonb NOT NULL,
  base_shared_revision text NOT NULL,
  resulting_shared_revision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, proposal_id)
);
ALTER TABLE promotions
  ADD COLUMN status text NOT NULL DEFAULT 'COMMITTED_COMPLETION_PENDING',
  ADD COLUMN completed_at timestamptz,
  ADD CONSTRAINT promotions_status_known CHECK (status IN ('COMMITTED_COMPLETION_PENDING', 'COMPLETED'));
CREATE TABLE promotion_entries (
  id uuid PRIMARY KEY,
  promotion_id uuid NOT NULL REFERENCES promotions (id) ON DELETE RESTRICT,
  proposal_resource_id uuid NOT NULL,
  operation text NOT NULL,
  path text NOT NULL,
  type text NOT NULL,
  base_resource_id uuid,
  base_revision integer,
  resulting_resource_id uuid NOT NULL,
  resulting_revision integer NOT NULL,
  resulting_lifecycle text NOT NULL,
  CONSTRAINT promotion_entries_operation_known CHECK (operation IN ('CREATE', 'UPDATE', 'RETIRE')),
  CONSTRAINT promotion_entries_lifecycle_known CHECK (resulting_lifecycle IN ('ACTIVE', 'RETIRED'))
);
CREATE INDEX promotion_entries_resource_idx ON promotion_entries (resulting_resource_id, resulting_revision);
CREATE TABLE promotion_relationship_changes (
  id uuid PRIMARY KEY,
  promotion_id uuid NOT NULL REFERENCES promotions (id) ON DELETE RESTRICT,
  operation text NOT NULL,
  source_id uuid NOT NULL,
  target_id uuid NOT NULL,
  kind text NOT NULL,
  source_role text,
  target_role text,
  CONSTRAINT promotion_relationship_changes_operation_known CHECK (operation IN ('ADD', 'REMOVE'))
);
ALTER TABLE workspace_operation_batches
  ADD COLUMN manifest_expected_revision integer,
  ADD COLUMN manifest_expected_content text,
  ADD COLUMN manifest_content text,
  ADD COLUMN manifest_staged_path text,
  ADD COLUMN promotion_id uuid;
`;
