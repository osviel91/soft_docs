/** Migration 0020: journal envelope for multi-resource authoritative mutations. */
export const up = String.raw`
CREATE TABLE workspace_operation_batches (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT workspace_operation_batches_status_known CHECK (status IN ('pending', 'completed', 'failed'))
);
ALTER TABLE workspace_operations ADD COLUMN batch_id uuid REFERENCES workspace_operation_batches (id) ON DELETE SET NULL;
CREATE INDEX workspace_operations_batch_idx ON workspace_operations (batch_id);
`;
