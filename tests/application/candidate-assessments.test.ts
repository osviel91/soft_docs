import { describe, expect, it } from "vitest";
import type { ProjectCatalog } from "../../src/application/project-catalog";
import type { CandidateAssessmentRepository } from "../../src/application/ports/candidate-assessment-repository";
import { createCandidateAssessmentUseCases } from "../../src/application/candidate-assessments";
import type { ApplicationContext } from "../../src/application/context";
import type { CatalogResource } from "../../src/application/project-catalog";
import type { CandidateAssessment } from "../../src/domain/workspace/candidate-assessment";

const projectId = "project";
const contextId = "work-a";
const leftId = "shared-concept";
const rightId = "shared-database";
const owner: ApplicationContext = { requestId: "test", principal: { subjectUserId: "owner", actor: { kind: "user", userId: "owner" }, authType: "session", scopes: ["resource:read", "resource:create", "resource:update"] } };

function setup() {
  const resources: CatalogResource[] = [
    { id: leftId, projectId, path: "domain.concept", type: "conceptual", revision: 1 } as CatalogResource,
    { id: rightId, projectId, path: "schema.dbschema", type: "database", revision: 1 } as CatalogResource,
  ];
  const content = new Map([[leftId, 'concept account "Account"'], [rightId, 'table account - "Account"']]);
  const catalog = {
    async can() { return true; },
    async listEffectiveResources(_context: ApplicationContext, _project: string, work: string) { if (work !== contextId) throw new Error("not found"); return resources; },
    async readResource(_context: ApplicationContext, _project: string, id: string) { return { content: content.get(id)!, revision: resources.find((r) => r.id === id)?.revision ?? 1 }; },
    async listSemanticBindings() { return []; },
  } as unknown as ProjectCatalog;
  const values = new Map<string, CandidateAssessment>();
  const revisions = new Map<string, CandidateAssessment[]>();
  const key = (scope: { projectId: string; contextId: string }, id: string) => `${scope.projectId}/${scope.contextId}/${id}`;
  const repository: CandidateAssessmentRepository = {
    async list(scope) { return [...values.values()].filter((a) => a.projectId === scope.projectId && a.contextId === scope.contextId); },
    async get(scope, id) { return values.get(key(scope, id)) ?? null; },
    async history(scope, id) { return revisions.get(key(scope, id)) ?? []; },
    async create(a) { values.set(key(a, a.candidateId), a); revisions.set(key(a, a.candidateId), [a]); return a; },
    async update(scope, a, expected) {
      const current = values.get(key(scope, a.candidateId));
      if (!current || current.revision !== expected) throw new Error(`changed since it was read: expected revision ${expected}`);
      const next = { ...a, revision: expected + 1 };
      values.set(key(scope, a.candidateId), next); revisions.set(key(scope, a.candidateId), [...(revisions.get(key(scope, a.candidateId)) ?? []), next]); return next;
    },
  };
  return { useCases: createCandidateAssessmentUseCases(catalog, repository), resources, content };
}

describe("candidate assessment use cases", () => {
  it("requires an effective candidate, rationale and evidence for READY, then versions decisions privately", async () => {
    const { useCases } = setup();
    const discovered = await import("../../src/application/discover-semantic-candidates").then(({ createDiscoverSemanticCandidatesUseCase }) => createDiscoverSemanticCandidatesUseCase({
      can: async () => true,
      listEffectiveResources: async () => [
        { id: leftId, projectId, path: "domain.concept", type: "conceptual", revision: 1, contextId: null },
        { id: rightId, projectId, path: "schema.dbschema", type: "database", revision: 1, contextId: null },
      ],
      readResource: async (_ctx: unknown, _project: string, id: string) => ({ content: id === leftId ? 'concept account "Account"' : 'table account - "Account"' }),
      listSemanticBindings: async () => [],
    } as unknown as ProjectCatalog)(owner, { projectId, contextId }));
    const id = discovered.candidates[0]!.id;
    const fingerprint = discovered.candidates[0]!.fingerprint;
    await expect(useCases.assess(owner, { projectId, contextId, candidateId: id, observedFingerprint: fingerprint, decision: "READY_FOR_BINDING", rationale: "Ready." })).rejects.toThrow("requires valid version 1 evidence");
    const ready = await useCases.assess(owner, { projectId, contextId, candidateId: id, observedFingerprint: fingerprint, decision: "READY_FOR_BINDING", rationale: "Reviewed against the contract.", evidence: { version: 1, rationale: "Migration is explicit.", items: [{ kind: "internal", resourceId: leftId, revision: 1 }] } });
    expect(ready).toMatchObject({ decision: "READY_FOR_BINDING", revision: 1, status: "CURRENT" });
    await expect(useCases.assess(owner, { projectId, contextId, candidateId: id, observedFingerprint: "old-fingerprint", decision: "REJECTED", rationale: "Wrong." })).rejects.toThrow("fingerprint changed");
    expect(await useCases.history(owner, projectId, contextId, id)).toHaveLength(1);
    const changed = await useCases.assess(owner, { projectId, contextId, candidateId: id, observedFingerprint: fingerprint, decision: "NEEDS_EVIDENCE", rationale: "Need an additional source.", expectedRevision: 1 });
    expect(changed).toMatchObject({ decision: "NEEDS_EVIDENCE", revision: 2 });
    await expect(useCases.assess(owner, { projectId, contextId, candidateId: id, observedFingerprint: fingerprint, decision: "REJECTED", rationale: "Wrong mapping.", expectedRevision: 1 })).rejects.toThrow("current revision 2");
    expect(await useCases.history(owner, projectId, contextId, id)).toHaveLength(2);
    expect(await useCases.get(owner, projectId, contextId, id)).toMatchObject({ revision: 2, decision: "NEEDS_EVIDENCE" });
  });

  it("retains assessments and marks exact anchor or evidence changes stale", async () => {
    const { useCases, resources, content } = setup();
    content.set(leftId, 'concept account "Account"\nconcept other "Other"');
    const candidate = await import("../../src/application/discover-semantic-candidates").then(({ createDiscoverSemanticCandidatesUseCase }) => createDiscoverSemanticCandidatesUseCase({
      can: async () => true,
      listEffectiveResources: async () => resources,
      readResource: async (_ctx: unknown, _project: string, id: string) => ({ content: content.get(id) }),
      listSemanticBindings: async () => [],
    } as unknown as ProjectCatalog)(owner, { projectId, contextId }));
    const id = candidate.candidates[0]!.id;
    const fingerprint = candidate.candidates[0]!.fingerprint;
    const evidenceEntity = { version: 1 as const, resourceId: leftId, representation: "conceptual" as const, entityKind: "concept" as const, identity: { kind: "local-id" as const, value: "other" } };
    await useCases.assess(owner, { projectId, contextId, candidateId: id, observedFingerprint: fingerprint, decision: "READY_FOR_BINDING", rationale: "Evidence checked.", evidence: { version: 1, rationale: "Source revision.", items: [{ kind: "internal", resourceId: leftId, revision: 1, entity: evidenceEntity }] } });
    resources[0] = { ...resources[0]!, revision: 2 };
    expect(await useCases.get(owner, projectId, contextId, id)).toMatchObject({ status: "STALE", staleReasons: ["evidence-changed"] });
    resources[0] = { ...resources[0]!, revision: 1 };
    content.set(leftId, 'concept account "Account"');
    const unresolvedEvidence = await useCases.get(owner, projectId, contextId, id);
    expect(unresolvedEvidence.staleReasons).toContain("evidence-changed");
    expect(await useCases.list(owner, projectId, contextId, { status: "STALE", limit: 1 })).toMatchObject({ total: 1, assessments: [{ status: "STALE" }] });
    content.set(leftId, 'concept account "Account"\nconcept other "Other"');
    content.set(leftId, 'concept account "ACCOUNT"\nconcept other "Other"');
    content.set(rightId, 'table account - "Account"');
    expect(await useCases.get(owner, projectId, contextId, id)).toMatchObject({ status: "STALE", staleReasons: ["candidate-changed"] });
    resources.splice(0, 1);
    const missingAnchor = await useCases.get(owner, projectId, contextId, id);
    expect(missingAnchor.status).toBe("STALE");
    expect(missingAnchor.staleReasons).toContain("anchor-unavailable");
    expect(await useCases.getCandidate(owner, projectId, contextId, id)).toMatchObject({ candidate: null, assessment: { status: "STALE", staleReasons: expect.arrayContaining(["anchor-unavailable"]) } });
    expect(await useCases.history(owner, projectId, contextId, id)).toHaveLength(1);
  });
});
