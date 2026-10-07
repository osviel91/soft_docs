/** Migration 0033: retain semantic binding operations in promotion history. */
export const up = String.raw`
ALTER TABLE promotions ADD COLUMN semantic_bindings jsonb NOT NULL DEFAULT '[]'::jsonb;
`;
