/** Migration 0017: immutable, team-visible architectural proposal snapshots. */
export const up = String.raw`
CREATE TABLE architectural_proposals (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  source_private_context_id uuid NOT NULL REFERENCES knowledge_contexts (id) ON DELETE RESTRICT,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'open',
  base_shared_revision text NOT NULL,
  base_shared_resource_revisions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT architectural_proposals_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT architectural_proposals_status_known CHECK (status = 'open')
);
CREATE INDEX architectural_proposals_project_idx ON architectural_proposals (project_id, submitted_at DESC, id DESC);

CREATE TABLE architectural_proposal_resources (
  proposal_id uuid NOT NULL REFERENCES architectural_proposals (id) ON DELETE CASCADE,
  source_resource_id uuid NOT NULL,
  path text NOT NULL,
  type text NOT NULL,
  source_revision integer NOT NULL,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (proposal_id, source_resource_id),
  CONSTRAINT architectural_proposal_resources_revision_positive CHECK (source_revision > 0)
);

CREATE TABLE architectural_proposal_messages (
  proposal_id uuid NOT NULL REFERENCES architectural_proposals (id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  source_context_id uuid NOT NULL,
  PRIMARY KEY (proposal_id, message_id)
);

CREATE TABLE architectural_proposal_relationships (
  proposal_id uuid NOT NULL REFERENCES architectural_proposals (id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  target_id uuid NOT NULL,
  kind text NOT NULL,
  source_role text,
  target_role text,
  source_context_id uuid NOT NULL,
  PRIMARY KEY (proposal_id, source_id, target_id),
  CONSTRAINT architectural_proposal_relationships_not_self CHECK (source_id <> target_id)
);
`;
