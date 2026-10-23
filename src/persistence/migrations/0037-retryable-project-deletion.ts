/** Migration 0037: record projects whose filesystem cleanup must be retried. */
export const up = String.raw`
ALTER TABLE projects
  ADD COLUMN deletion_pending_at timestamptz;
`;
