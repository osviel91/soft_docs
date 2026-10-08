import { validateBindingEvidence, type BindingEvidence, type EntityAnchor } from "./semantic-binding";

export type AssessmentDecision = "NEEDS_EVIDENCE" | "REJECTED" | "READY_FOR_BINDING";
export type AssessmentStaleReason = "anchor-unavailable" | "anchor-unresolved" | "candidate-changed" | "evidence-changed";

export interface CandidateAssessment {
  projectId: string;
  contextId: string;
  candidateId: string;
  candidate: {
    left: EntityAnchor;
    right: EntityAnchor;
    fingerprint: string;
    policyVersion: string;
    signals: Array<{ code: string; description: string }>;
  };
  decision: AssessmentDecision;
  rationale: string;
  evidence?: BindingEvidence;
  authorId: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export type ResolvedCandidateAssessment = CandidateAssessment & {
  relation: "represents-in";
  status: "CURRENT" | "STALE";
  staleReasons: AssessmentStaleReason[];
  nextAction: string;
};

export function validateCandidateAssessment(assessment: CandidateAssessment): void {
  if (!assessment.projectId || !assessment.contextId || !assessment.candidateId || !assessment.authorId) throw new Error("Candidate assessment scope and identity are required.");
  if (!assessment.candidate.fingerprint || !assessment.candidate.policyVersion) throw new Error("Candidate fingerprint and policy version are required.");
  if (!assessment.rationale.trim()) throw new Error("Candidate assessment rationale is required.");
  if (!Number.isInteger(assessment.revision) || assessment.revision < 1) throw new Error("Candidate assessment revision must be positive.");
  if (assessment.decision !== "NEEDS_EVIDENCE" && assessment.decision !== "REJECTED" && assessment.decision !== "READY_FOR_BINDING") throw new Error("Unknown candidate assessment decision.");
  if (assessment.decision === "READY_FOR_BINDING") {
    const evidence = assessment.evidence;
    if (!evidence) throw new Error("READY_FOR_BINDING requires valid version 1 evidence.");
    validateBindingEvidence(evidence);
  }
}
