import type { CandidateAssessmentRepository } from "../application/ports/candidate-assessment-repository";
import { validateCandidateAssessment, type CandidateAssessment } from "../domain/workspace/candidate-assessment";
import type { SqlClient } from "./sql-client";

const where = "project_id = $1 AND knowledge_context_id = $2";
const decode = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as CandidateAssessment;
const stale = (expected: number) => new Error(`Candidate assessment changed since it was read: expected revision ${expected}.`);

export function createCandidateAssessmentRepository(client: SqlClient): CandidateAssessmentRepository {
  return {
    async list(scope) {
      const result = await client.query(`SELECT assessment FROM candidate_assessments WHERE ${where} ORDER BY candidate_id`, [scope.projectId, scope.contextId]);
      return result.rows.map((row) => decode(row.assessment));
    },
    async get(scope, candidateId) {
      const result = await client.query(`SELECT assessment FROM candidate_assessments WHERE ${where} AND candidate_id = $3`, [scope.projectId, scope.contextId, candidateId]);
      return result.rows[0] ? decode(result.rows[0].assessment) : null;
    },
    async history(scope, candidateId) {
      const result = await client.query(`SELECT assessment FROM candidate_assessment_revisions WHERE ${where} AND candidate_id = $3 ORDER BY revision`, [scope.projectId, scope.contextId, candidateId]);
      return result.rows.map((row) => decode(row.assessment));
    },
    async create(assessment) {
      validateCandidateAssessment(assessment);
      if (assessment.revision !== 1) throw new Error("A new candidate assessment must start at revision 1.");
      await client.transaction(async (tx) => {
        const json = JSON.stringify(assessment);
        const saved = await tx.query(`INSERT INTO candidate_assessments (project_id, knowledge_context_id, candidate_id, revision, assessment) SELECT $1, $2, $3, 1, $4::jsonb WHERE EXISTS (SELECT 1 FROM knowledge_contexts WHERE project_id = $1 AND id = $2 AND owner_user_id = $5) RETURNING candidate_id`, [assessment.projectId, assessment.contextId, assessment.candidateId, json, assessment.authorId]);
        if (!saved.rows[0]) throw new Error("Candidate assessment context is unavailable to its author.");
        await tx.query(`INSERT INTO candidate_assessment_revisions (project_id, knowledge_context_id, candidate_id, revision, assessment) VALUES ($1, $2, $3, 1, $4::jsonb)`, [assessment.projectId, assessment.contextId, assessment.candidateId, json]);
      });
      return assessment;
    },
    async update(scope, assessment, expectedRevision) {
      if (assessment.projectId !== scope.projectId || assessment.contextId !== scope.contextId) throw new Error("Candidate assessment scope does not match.");
      const updated = { ...assessment, revision: expectedRevision + 1 };
      validateCandidateAssessment(updated);
      await client.transaction(async (tx) => {
        const result = await tx.query(`UPDATE candidate_assessments SET revision = $4, assessment = $5::jsonb, updated_at = now() WHERE ${where} AND candidate_id = $3 AND revision = $6 AND EXISTS (SELECT 1 FROM knowledge_contexts WHERE project_id = $1 AND id = $2 AND owner_user_id = $7) RETURNING candidate_id`, [scope.projectId, scope.contextId, assessment.candidateId, updated.revision, JSON.stringify(updated), expectedRevision, updated.authorId]);
        if (!result.rows[0]) throw stale(expectedRevision);
        await tx.query(`INSERT INTO candidate_assessment_revisions (project_id, knowledge_context_id, candidate_id, revision, assessment) VALUES ($1, $2, $3, $4, $5::jsonb)`, [scope.projectId, scope.contextId, updated.candidateId, updated.revision, JSON.stringify(updated)]);
      });
      return updated;
    },
  };
}
