export const up = String.raw`
CREATE TABLE workspace_invitations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('ADMIN','EDITOR','VIEWER')),
  creator_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK (expires_at > created_at),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX workspace_invitations_workspace_created ON workspace_invitations(workspace_id, created_at DESC);
CREATE UNIQUE INDEX workspace_invitations_active_token_hash ON workspace_invitations(token_hash);
`;
