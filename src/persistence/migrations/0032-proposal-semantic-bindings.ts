/** Migration 0032: immutable semantic-binding operations in proposal snapshots. */
export const up = String.raw`
CREATE TABLE architectural_proposal_bindings (
  proposal_id uuid NOT NULL REFERENCES architectural_proposals (id) ON DELETE CASCADE,
  binding_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('ADD', 'UPDATE', 'REMOVE')),
  source_context_id uuid NOT NULL,
  source_revision integer,
  expected_revision integer,
  base_fingerprint text,
  binding jsonb NOT NULL,
  base_binding jsonb,
  PRIMARY KEY (proposal_id, binding_id),
  CHECK ((operation = 'ADD' AND source_revision > 0 AND expected_revision IS NULL AND base_fingerprint IS NULL)
      OR (operation = 'UPDATE' AND source_revision > 0 AND expected_revision > 0 AND base_fingerprint IS NOT NULL)
      OR (operation = 'REMOVE' AND source_revision IS NULL AND expected_revision > 0 AND base_fingerprint IS NOT NULL))
);
`;
