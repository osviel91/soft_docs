/** Migration 0022: immutable CREATE/UPDATE/RETIRE proposal evidence. */
export const up = String.raw`
ALTER TABLE architectural_proposal_resources
  ADD COLUMN operation text,
  ADD COLUMN base_resource_id uuid,
  ADD COLUMN base_revision integer,
  ADD CONSTRAINT architectural_proposal_resources_operation_known
    CHECK (operation IS NULL OR operation IN ('CREATE', 'UPDATE', 'RETIRE'));
`;
