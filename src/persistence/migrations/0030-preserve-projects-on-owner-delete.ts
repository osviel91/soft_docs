/** Migration 0030: prevent account deletion from cascading through ownership. */
export const up = String.raw`
ALTER TABLE projects DROP CONSTRAINT projects_owner_id_fkey;
ALTER TABLE projects ADD CONSTRAINT projects_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE RESTRICT;
ALTER TABLE workspaces DROP CONSTRAINT workspaces_owner_id_fkey;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE RESTRICT;
`;
