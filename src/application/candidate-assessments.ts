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
  observedFingerprint: string;
  evidence?: BindingEvidence;
  expectedRevision?: number;
}

export interface ListCandidateAssessmentsInput {
  decision?: AssessmentDecision;
  status?: "CURRENT" | "STALE";
  limit?: number;
  cursor?: string;
}

export function createCandidateAssessmentUseCases(catalog: ProjectCatalog, repository: CandidateAssessmentRepository) {
  const discover = createDiscoverSemanticCandidatesUseCase(catalog);

  async function currentCandidate(context: ApplicationContext, input: { projectId: string; contextId?: string; candidateId: string }): Promise<DiscoveredSemanticCandidate> {
    let cursor: string | undefined;
    do {
      const page = await discover(context, { projectId: input.projectId, ...(input.contextId === undefined ? {} : { contextId: input.contextId }), limit: 200, ...(cursor === undefined ? {} : { cursor }) });
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
    const status = staleReasons.size ? "STALE" as const : "CURRENT" as const;
    return {
      ...assessment,
      relation: "represents-in",
      status,
      staleReasons: [...staleReasons],
      nextAction: status === "STALE" ? "Re-discover and reassess before using these anchors; do not create a binding from stale data." : assessment.decision === "READY_FOR_BINDING" ? "Review the Evidence and explicitly call create_semantic_binding if you decide to create the relationship." : "Gather evidence or record a new decision after review.",
    };
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
    if (candidate.fingerprint !== input.observedFingerprint) throw conflict("The candidate fingerprint changed; rediscover and reassess without retrying automatically.");
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
    async getCandidate(context: ApplicationContext, projectId: string, contextId: string | undefined, candidateId: string) {
      const assessment = contextId ? await repository.get({ projectId, contextId }, candidateId) : null;
      try {
        const candidate = await currentCandidate(context, { projectId, ...(contextId ? { contextId } : {}), candidateId });
        const resolvedAssessment = assessment ? await resolve(context, assessment) : null;
        return { candidate, assessment: resolvedAssessment, assessmentStatus: resolvedAssessment?.status ?? "UNASSESSED" as const, assessmentRevision: resolvedAssessment?.revision ?? null, relation: "represents-in" as const, status: "unconfirmed" as const, nextAction: resolvedAssessment?.status === "STALE" ? resolvedAssessment.nextAction : resolvedAssessment?.decision === "READY_FOR_BINDING" ? resolvedAssessment.nextAction : "Review the suggestion and record an explicit assessment in owned MY WORK." };
      } catch (error) {
        if (!(error instanceof ApplicationError) || error.code !== "not_found" || !assessment) throw error;
        const resolved = await resolve(context, assessment);
        return { candidate: null, assessment: resolved, assessmentStatus: resolved.status, assessmentRevision: resolved.revision, relation: "represents-in" as const, status: "unconfirmed" as const, nextAction: resolved.nextAction };
      }
    },
    async get(context: ApplicationContext, projectId: string, contextId: string, candidateId: string) {
      await catalog.listEffectiveResources(context, projectId, contextId);
      const assessment = await repository.get({ projectId, contextId }, candidateId);
      if (!assessment) throw notFound("Candidate assessment not found.");
      return resolve(context, assessment);
    },
    async list(context: ApplicationContext, projectId: string, contextId: string, options: ListCandidateAssessmentsInput = {}) {
      await catalog.listEffectiveResources(context, projectId, contextId);
      if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200)) throw invalid("limit must be an integer from 1 to 200.");
      const assessments = await Promise.all((await repository.list({ projectId, contextId })).map((assessment) => resolve(context, assessment)));
      const filtered = assessments.filter((assessment) =>
        (options.decision === undefined || assessment.decision === options.decision) &&
        (options.status === undefined || assessment.status === options.status),
      ).sort((a, b) => a.candidateId.localeCompare(b.candidateId));
      const start = options.cursor === undefined ? 0 : filtered.findIndex((assessment) => assessment.candidateId === options.cursor) + 1;
      if (options.cursor !== undefined && start === 0) throw invalid("cursor does not identify an assessment in this filtered result.");
      const limit = options.limit ?? 50;
      const page = filtered.slice(start, start + limit);
      return { assessments: page, total: filtered.length, ...(start + page.length < filtered.length ? { nextCursor: page.at(-1)!.candidateId } : {}) };
    },
    async history(context: ApplicationContext, projectId: string, contextId: string, candidateId: string) {
      await catalog.listEffectiveResources(context, projectId, contextId);
      return repository.history({ projectId, contextId }, candidateId);
    },
  };
}
