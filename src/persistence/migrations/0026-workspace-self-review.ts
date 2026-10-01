export const up = String.raw`
ALTER TABLE workspaces
  ADD COLUMN allow_author_self_review boolean NOT NULL DEFAULT false;
`;
