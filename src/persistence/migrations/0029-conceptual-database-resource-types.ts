/** Migration 0029: admit source-only Conceptual and Database resources. */
export const up = String.raw`
ALTER TABLE resources DROP CONSTRAINT resources_type_known;
ALTER TABLE resources ADD CONSTRAINT resources_type_known CHECK (
  type IN ('sequence-diagram', 'event-flow', 'markdown-document', 'conceptual', 'database')
);
ALTER TABLE resource_revisions DROP CONSTRAINT resource_revisions_type_known;
ALTER TABLE resource_revisions ADD CONSTRAINT resource_revisions_type_known CHECK (
  type IN ('sequence-diagram', 'event-flow', 'markdown-document', 'conceptual', 'database')
);
`;
