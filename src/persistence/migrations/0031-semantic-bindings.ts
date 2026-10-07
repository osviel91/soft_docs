/** Migration 0031: scoped semantic bindings with immutable revision snapshots. */
export const up = String.raw`
CREATE TABLE semantic_bindings (
  id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  knowledge_context_id uuid REFERENCES knowledge_contexts (id) ON DELETE CASCADE,
  revision integer NOT NULL,
  status text NOT NULL,
  binding jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT semantic_bindings_revision_positive CHECK (revision > 0),
  CONSTRAINT semantic_bindings_status_known CHECK (status IN ('ACTIVE', 'RETIRED'))
);
CREATE UNIQUE INDEX semantic_bindings_scope_unique
  ON semantic_bindings (project_id, COALESCE(knowledge_context_id, '00000000-0000-0000-0000-000000000000'::uuid), id);
CREATE TABLE semantic_binding_revisions (
  project_id uuid NOT NULL,
  knowledge_context_id uuid,
  binding_id uuid NOT NULL,
  revision integer NOT NULL,
  status text NOT NULL,
  binding jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT semantic_binding_revisions_revision_positive CHECK (revision > 0),
  CONSTRAINT semantic_binding_revisions_status_known CHECK (status IN ('ACTIVE', 'RETIRED'))
);
CREATE UNIQUE INDEX semantic_binding_revisions_scope_unique
  ON semantic_binding_revisions (project_id, COALESCE(knowledge_context_id, '00000000-0000-0000-0000-000000000000'::uuid), binding_id, revision);
`;
