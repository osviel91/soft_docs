export const up = `
CREATE TABLE password_recovery_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_recovery_tokens_user_idx ON password_recovery_tokens (user_id);
`;
