export const up = String.raw`
ALTER TABLE project_share_grants ADD COLUMN resource_ids TEXT[] NOT NULL DEFAULT '{}'::text[];
UPDATE project_share_grants AS grants
SET resource_ids = COALESCE((
  SELECT array_agg(resources.id::text ORDER BY resources.id)
  FROM resources
  WHERE resources.project_id = grants.project_id
    AND resources.lifecycle = 'ACTIVE'
    AND resources.knowledge_context_id IS NULL
), '{}'::text[]);
`;
