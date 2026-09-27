/** Migration 0024: preserve the authoritative path used as an update base. */
export const up = String.raw`
ALTER TABLE architectural_proposal_resources ADD COLUMN IF NOT EXISTS base_path text;
`;
