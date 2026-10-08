export const up = String.raw`
CREATE TABLE candidate_assessments (
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  knowledge_context_id uuid NOT NULL REFERENCES knowledge_contexts (id) ON DELETE CASCADE,
  candidate_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  assessment jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, knowledge_context_id, candidate_id)
);
CREATE TABLE candidate_assessment_revisions (
  project_id uuid NOT NULL,
  knowledge_context_id uuid NOT NULL,
  candidate_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  assessment jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, knowledge_context_id, candidate_id, revision)
);
`;
