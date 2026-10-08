import type { ApplicationContext } from "./context";
import type { CatalogResource, ProjectCatalog } from "./project-catalog";
import type { CandidateAssessmentRepository } from "./ports/candidate-assessment-repository";
import { createDiscoverSemanticCandidatesUseCase, type DiscoveredSemanticCandidate } from "./discover-semantic-candidates";
import { ApplicationError, conflict, forbidden, invalid, notFound } from "./errors";
import { analyzeResource } from "../domain/project/resource-analysis";
import { buildProjectIndex } from "../domain/project/project-index";
import { createEmptyMetadata } from "../domain/workspace/metadata";
import { validateCandidateAssessment, type AssessmentDecision, type CandidateAssessment, type ResolvedCandidateAssessment } from "../domain/workspace/candidate-assessment";
import { resolveEntityAnchor, type BindingEvidence, type EntityAnchor } from "../domain/workspace/semantic-binding";

export interface AssessCandidateInput {
  projectId: string;
  contextId: string;
  candidateId: string;
  decision: AssessmentDecision;
  rationale: string;
  evidence?: BindingEvidence;
  expectedRevision?: number;
}

export function createCandidateAssessmentUseCases(catalog: ProjectCatalog, repository: CandidateAssessmentRepository) {
  const discover = createDiscoverSemanticCandidatesUseCase(catalog);

  async function currentCandidate(context: ApplicationContext, input: Pick<AssessCandidateInput, "projectId" | "contextId" | "candidateId">): Promise<DiscoveredSemanticCandidate> {
    let cursor: string | undefined;
    do {
      const page = await discover(context, { projectId: input.projectId, contextId: input.contextId, limit: 200, ...(cursor === undefined ? {} : { cursor }) });
      const candidate = page.candidates.find((entry) => entry.id === input.candidateId);
      if (candidate) return candidate;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    throw notFound("The semantic candidate is not present in this effective context.");
  }

  async function resolve(context: ApplicationContext, assessment: CandidateAssessment): Promise<ResolvedCandidateAssessment> {
    const candidates = await catalog.listEffectiveResources(context, assessment.projectId, assessment.contextId);
    const resources = new Set(candidates.map((resource) => resource.id));
    const staleReasons = new Set<ResolvedCandidateAssessment["staleReasons"][number]>();
    if (![assessment.candidate.left.resourceId, assessment.candidate.right.resourceId].every((id) => resources.has(id))) {
      staleReasons.add("anchor-unavailable");
    } else {
      try {
        const current = await currentCandidate(context, assessment);
        if (current.fingerprint !== assessment.candidate.fingerprint || current.policyVersion !== assessment.candidate.policyVersion) staleReasons.add("candidate-changed");
      } catch (error) {
        if (!(error instanceof ApplicationError) || error.code !== "not_found") throw error;
        staleReasons.add("anchor-unresolved");
      }
    }
    for (const item of assessment.evidence?.items ?? []) {
      if (item.kind !== "internal") continue;
      const evidenceResource = candidates.find((resource) => resource.id === item.resourceId);
      if (!evidenceResource || evidenceResource.revision !== item.revision || (item.entity && !(await evidenceEntityResolves(context, assessment.projectId, evidenceResource, item.entity)))) staleReasons.add("evidence-changed");
    }
    return { ...assessment, status: staleReasons.size ? "STALE" : "CURRENT", staleReasons: [...staleReasons] };
  }

  async function evidenceEntityResolves(context: ApplicationContext, projectId: string, resource: CatalogResource, anchor: EntityAnchor): Promise<boolean> {
    const { content } = await catalog.readResource(context, projectId, resource.id, resource.contextId ?? null);
    const indexed = analyzeResource({ id: resource.id, projectId, path: resource.path, type: resource.type, title: resource.path }, content);
    const index = buildProjectIndex(projectId, [indexed], createEmptyMetadata(), () => []);
    return resolveEntityAnchor(anchor, index.entities ?? []) === "resolved";
  }

  async function assess(context: ApplicationContext, input: AssessCandidateInput): Promise<ResolvedCandidateAssessment> {
    if (!input.contextId?.trim()) throw invalid("Assessment requires an owned MY WORK context.");
    if (!await catalog.can(context, input.projectId, "resource:update")) throw forbidden("The caller cannot assess candidates in this project.");
    const candidate = await currentCandidate(context, input);
    const scope = { projectId: input.projectId, contextId: input.contextId };
    if (input.evidence) {
      const resources = await catalog.listEffectiveResources(context, input.projectId, input.contextId);
      for (const item of input.evidence.items) {
        if (item.kind !== "internal") continue;
        const resource = resources.find((entry) => entry.id === item.resourceId);
        if (!resource || resource.revision !== item.revision) throw conflict("Internal evidence does not match the current effective resource revision.");
        if (item.entity && !(await evidenceEntityResolves(context, input.projectId, resource, item.entity))) throw invalid("Internal evidence entity does not resolve exactly in the effective resource.");
      }
    }
    const previous = await repository.get(scope, input.candidateId);
    if (previous) {
      if (input.expectedRevision === undefined) throw invalid("expectedRevision is required when updating an assessment.");
      if (previous.revision !== input.expectedRevision) throw conflict(`Candidate assessment changed since it was read: expected revision ${input.expectedRevision}, current revision ${previous.revision}.`);
    } else if (input.expectedRevision !== undefined && input.expectedRevision !== 0) {
      throw conflict("The candidate assessment does not yet exist at the expected revision.");
    }
    const now = new Date().toISOString();
    const assessment: CandidateAssessment = {
      projectId: input.projectId, contextId: input.contextId, candidateId: candidate.id,
      candidate: { left: candidate.left, right: candidate.right, fingerprint: candidate.fingerprint, policyVersion: candidate.policyVersion, signals: candidate.signals },
      decision: input.decision, rationale: input.rationale,
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      authorId: context.principal.subjectUserId, createdAt: previous?.createdAt ?? now, updatedAt: now,
      revision: previous ? previous.revision + 1 : 1,
    };
    try {
      validateCandidateAssessment(assessment);
      const saved = previous
        ? await repository.update(scope, assessment, input.expectedRevision!)
        : await repository.create(assessment);
      return await resolve(context, saved);
    } catch (error) {
      if (error instanceof Error && /changed since|already exists|duplicate key|stale sidecar revision/i.test(error.message)) throw conflict(error.message);
      throw error;
    }
  }

  return {
    assess,
    async get(context: ApplicationContext, projectId: string, contextId: string, candidateId: string) {
      await catalog.listEffectiveResources(context, projectId, contextId);
      const assessment = await repository.get({ projectId, contextId }, candidateId);
      if (!assessment) throw notFound("Candidate assessment not found.");
      return resolve(context, assessment);
    },
    async list(context: ApplicationContext, projectId: string, contextId: string) {
      await catalog.listEffectiveResources(context, projectId, contextId);
      return Promise.all((await repository.list({ projectId, contextId })).map((assessment) => resolve(context, assessment)));
    },
    async history(context: ApplicationContext, projectId: string, contextId: string, candidateId: string) {
      await catalog.listEffectiveResources(context, projectId, contextId);
      return repository.history({ projectId, contextId }, candidateId);
    },
  };
}
