import type { CandidateAssessmentRepository, CandidateAssessmentScope } from "../application/ports/candidate-assessment-repository";
import type { ProjectStorage } from "../application/project-storage";
import { validateCandidateAssessment, type CandidateAssessment } from "../domain/workspace/candidate-assessment";
import { isOk } from "../shared/result/result";

const PATH = ".candidate-assessments.json";
interface Registry { version: 1; assessments: CandidateAssessment[]; history: CandidateAssessment[] }
const empty: Registry = { version: 1, assessments: [], history: [] };

export function createLocalCandidateAssessmentRepository(storage: ProjectStorage): CandidateAssessmentRepository {
  async function read() {
    const result = await storage.read(PATH);
    if (!isOk(result)) throw result.error;
    if (!result.value) return { registry: empty, raw: null as string | null };
    const value: unknown = JSON.parse(result.value.content);
    if (!value || typeof value !== "object" || (value as Registry).version !== 1 || !Array.isArray((value as Registry).assessments) || !Array.isArray((value as Registry).history)) throw new Error("Invalid candidate assessment registry.");
    return { registry: value as Registry, raw: result.value.content };
  }
  async function save(previous: string | null, registry: Registry) {
    if (!storage.writeIfUnchanged) throw new Error("Local assessment storage must support atomic compare-and-write.");
    const result = await storage.writeIfUnchanged(PATH, previous, JSON.stringify(registry, null, 2));
    if (!isOk(result)) throw result.error;
  }
  const inScope = (a: CandidateAssessment, s: CandidateAssessmentScope) => a.projectId === s.projectId && a.contextId === s.contextId;
  return {
    async list(scope) { return (await read()).registry.assessments.filter((a) => inScope(a, scope)).sort((a, b) => a.candidateId.localeCompare(b.candidateId)); },
    async get(scope, candidateId) { return (await read()).registry.assessments.find((a) => a.candidateId === candidateId && inScope(a, scope)) ?? null; },
    async history(scope, candidateId) { return (await read()).registry.history.filter((a) => a.candidateId === candidateId && inScope(a, scope)).sort((a, b) => a.revision - b.revision); },
    async create(assessment) {
      validateCandidateAssessment(assessment);
      if (assessment.revision !== 1) throw new Error("A new candidate assessment must start at revision 1.");
      const { registry, raw } = await read();
      if (registry.assessments.some((a) => inScope(a, assessment) && a.candidateId === assessment.candidateId)) throw new Error("Candidate assessment already exists.");
      await save(raw, { ...registry, assessments: [...registry.assessments, assessment], history: [...registry.history, assessment] });
      return assessment;
    },
    async update(scope, assessment, expectedRevision) {
      const { registry, raw } = await read();
      const index = registry.assessments.findIndex((a) => inScope(a, scope) && a.candidateId === assessment.candidateId && a.revision === expectedRevision);
      if (index < 0) throw new Error(`Candidate assessment changed since it was read: expected revision ${expectedRevision}.`);
      const updated = { ...assessment, revision: expectedRevision + 1 };
      validateCandidateAssessment(updated);
      const assessments = [...registry.assessments]; assessments[index] = updated;
      await save(raw, { ...registry, assessments, history: [...registry.history, updated] });
      return updated;
    },
  };
}
