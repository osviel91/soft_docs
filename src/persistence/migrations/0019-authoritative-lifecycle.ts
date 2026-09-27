/** Migration 0019: non-destructive lifecycle for authoritative resources. */
export const up = String.raw`
ALTER TABLE workspace_operations DROP CONSTRAINT workspace_operations_operation_known;
ALTER TABLE workspace_operations ADD CONSTRAINT workspace_operations_operation_known CHECK (
  operation IN ('create', 'update', 'move', 'delete', 'retire')
);
ALTER TABLE resources
  ADD COLUMN lifecycle text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN retired_by text;
ALTER TABLE resources
  ADD CONSTRAINT resources_lifecycle_known CHECK (lifecycle IN ('ACTIVE', 'RETIRED'));
ALTER TABLE resources
  ADD CONSTRAINT resources_retirement_consistent CHECK (
    (lifecycle = 'ACTIVE' AND retired_at IS NULL) OR
    (lifecycle = 'RETIRED' AND retired_at IS NOT NULL)
  );
DROP INDEX resources_context_path_unique;
CREATE UNIQUE INDEX resources_active_context_path_unique
  ON resources (project_id, COALESCE(knowledge_context_id, '00000000-0000-0000-0000-000000000000'::uuid), path)
  WHERE lifecycle = 'ACTIVE';
CREATE INDEX resources_lifecycle_idx ON resources (project_id, knowledge_context_id, lifecycle, path);

CREATE TABLE resource_relationship_history (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  target_id uuid NOT NULL,
  kind text NOT NULL,
  source_role text,
  target_role text,
  knowledge_context_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by text,
  operation_id uuid,
  CONSTRAINT resource_relationship_history_kind_known CHECK (kind IN ('complementary-view'))
);
CREATE INDEX resource_relationship_history_project_idx
  ON resource_relationship_history (project_id, recorded_at DESC);
`;
