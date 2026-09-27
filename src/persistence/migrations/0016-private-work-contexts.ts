/** Migration 0016: private, project-owned knowledge contexts. */
export const up = String.raw`
CREATE TABLE knowledge_contexts (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  lifecycle text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_contexts_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT knowledge_contexts_lifecycle_known CHECK (lifecycle IN ('active', 'archived')),
  CONSTRAINT knowledge_contexts_owner_unique_name UNIQUE (project_id, owner_user_id, name)
);
CREATE INDEX knowledge_contexts_owner_idx ON knowledge_contexts (project_id, owner_user_id, updated_at DESC);

ALTER TABLE resources ADD COLUMN knowledge_context_id uuid REFERENCES knowledge_contexts (id) ON DELETE CASCADE;
ALTER TABLE resource_revisions ADD COLUMN knowledge_context_id uuid REFERENCES knowledge_contexts (id) ON DELETE CASCADE;
ALTER TABLE resource_relationships ADD COLUMN knowledge_context_id uuid REFERENCES knowledge_contexts (id) ON DELETE CASCADE;
ALTER TABLE resource_relationships DROP CONSTRAINT resource_relationships_pkey;
CREATE UNIQUE INDEX resource_relationships_context_unique ON resource_relationships (project_id, COALESCE(knowledge_context_id, '00000000-0000-0000-0000-000000000000'::uuid), source_id, target_id);
ALTER TABLE workspace_operations ADD COLUMN knowledge_context_id uuid REFERENCES knowledge_contexts (id) ON DELETE CASCADE;
ALTER TABLE resources DROP CONSTRAINT resources_path_unique;
CREATE UNIQUE INDEX resources_context_path_unique ON resources (project_id, COALESCE(knowledge_context_id, '00000000-0000-0000-0000-000000000000'::uuid), path);
CREATE INDEX resources_context_idx ON resources (project_id, knowledge_context_id, path);
CREATE INDEX resource_relationships_context_idx ON resource_relationships (project_id, knowledge_context_id);

CREATE TABLE private_semantic_messages (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  knowledge_context_id uuid NOT NULL REFERENCES knowledge_contexts (id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT private_semantic_messages_kind_known CHECK (kind IN ('event', 'command'))
);
CREATE INDEX private_semantic_messages_context_idx ON private_semantic_messages (project_id, knowledge_context_id);
`;
