export const up = String.raw`
CREATE TABLE project_share_grants (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NOT NULL OR revoked_by_user_id IS NULL)
);
CREATE INDEX project_share_grants_project_created ON project_share_grants(project_id, created_at DESC);
`;
