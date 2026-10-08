import { describe, expect, it } from "vitest";
import type { ProjectStorage } from "../../src/application/project-storage";
import { createLocalCandidateAssessmentRepository } from "../../src/persistence/local-candidate-assessment-repository";
import type { CandidateAssessment } from "../../src/domain/workspace/candidate-assessment";
import { ok, err } from "../../src/shared/result/result";

function localStore() {
  const files = new Map<string, string>();
  return {
    root: "/test",
    async list() { return ok([]); },
    async read(path: string) { const content = files.get(path); return ok(content === undefined ? null : { path, type: "conceptual" as const, content }); },
    async write(path: string, content: string) { files.set(path, content); return ok({ path, type: "conceptual" as const, content }); },
    async writeIfUnchanged(path: string, expected: string | null, content: string) { if ((files.get(path) ?? null) !== expected) return err(new Error("stale")); files.set(path, content); return ok({ path, type: "conceptual" as const, content }); },
    async remove(path: string) { files.delete(path); return ok(undefined); }, async move() { return err(new Error("unused")); }, async promote() { return err(new Error("unused")); }, async exists(path: string) { return files.has(path); },
  } satisfies ProjectStorage;
}

const assessment: CandidateAssessment = {
  projectId: "project", contextId: "work-a", candidateId: "candidate", candidate: {
    left: { version: 1, resourceId: "concept", representation: "conceptual", entityKind: "concept", identity: { kind: "local-id", value: "account" } },
    right: { version: 1, resourceId: "database", representation: "database", entityKind: "table", identity: { kind: "local-id", value: "account" } }, fingerprint: "fp", policyVersion: "policy", signals: [],
  }, decision: "REJECTED", rationale: "No semantic equivalence.", authorId: "owner", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", revision: 1,
};

describe("local candidate assessment persistence", () => {
  it("persists context-isolated snapshots and revision history", async () => {
    const storage = localStore();
    const repo = createLocalCandidateAssessmentRepository(storage);
    await repo.create(assessment);
    expect(await repo.get({ projectId: "project", contextId: "work-b" }, assessment.candidateId)).toBeNull();
    const updated = await repo.update({ projectId: "project", contextId: "work-a" }, { ...assessment, rationale: "Still rejected." }, 1);
    expect(updated.revision).toBe(2);
    await expect(repo.update({ projectId: "project", contextId: "work-a" }, updated, 1)).rejects.toThrow("expected revision 1");
    expect(await repo.history({ projectId: "project", contextId: "work-a" }, assessment.candidateId)).toEqual([assessment, updated]);
    const sidecar = await storage.read(".candidate-assessments.json");
    expect(JSON.parse(sidecar.ok && sidecar.value ? sidecar.value.content : "{}").assessments).toEqual([updated]);
  });
});
