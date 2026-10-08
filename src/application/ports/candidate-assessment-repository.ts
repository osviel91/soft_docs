import type { CandidateAssessment } from "../../domain/workspace/candidate-assessment";

export interface CandidateAssessmentScope { projectId: string; contextId: string }
export interface CandidateAssessmentRepository {
  list(scope: CandidateAssessmentScope): Promise<CandidateAssessment[]>;
  get(scope: CandidateAssessmentScope, candidateId: string): Promise<CandidateAssessment | null>;
  history(scope: CandidateAssessmentScope, candidateId: string): Promise<CandidateAssessment[]>;
  create(assessment: CandidateAssessment): Promise<CandidateAssessment>;
  update(scope: CandidateAssessmentScope, assessment: CandidateAssessment, expectedRevision: number): Promise<CandidateAssessment>;
}
