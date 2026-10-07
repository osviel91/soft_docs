import { describe, expect, it } from "vitest";
import type { ProjectStorage } from "../../src/application/project-storage";
import { createLocalSemanticBindingRepository } from "../../src/persistence/local-semantic-binding-repository";
import type { SemanticBinding } from "../../src/domain/workspace/semantic-binding";
import { ok, err } from "../../src/shared/result/result";

const binding: SemanticBinding = {
  id: "a4eaf244-237c-4a03-92fe-5ad681b306d4", projectId: "00000000-0000-4000-8000-000000000001",
  left: { version: 1, resourceId: "domain", representation: "conceptual", entityKind: "concept", identity: { kind: "local-id", value: "project" } },
  right: { version: 1, resourceId: "schema", representation: "database", entityKind: "table", identity: { kind: "local-id", value: "projects" } },
  relation: "represents-in", evidence: { version: 1, rationale: "Persistence design evidence.", items: [{ kind: "external", reference: "ADR-1", description: "Approved mapping." }] },
  revision: 1, status: "ACTIVE", provenance: { authorId: "owner", contextId: "work-one", createdAt: "2026-01-01T00:00:00Z" },
};

function localStore() {
  const files = new Map<string, string>();
  const storage = {
    root: "/test",
    async list() { return ok([]); },
    async read(path: string) { const content = files.get(path); return ok(content === undefined ? null : { path, type: "conceptual" as const, content }); },
    async write(path: string, content: string) { files.set(path, content); return ok({ path, type: "conceptual" as const, content }); },
    async writeIfUnchanged(path: string, expectedContent: string | null, content: string) {
      if ((files.get(path) ?? null) !== expectedContent) return err(new Error("stale"));
      files.set(path, content); return ok({ path, type: "conceptual" as const, content });
    },
    async remove(path: string) { files.delete(path); return ok(undefined); },
    async move() { return err(new Error("unused")); },
    async promote() { return err(new Error("unused")); },
    async exists(path: string) { return files.has(path); },
  } satisfies ProjectStorage;
  return storage;
}

describe("local semantic binding persistence", () => {
  it("round-trips bindings, scope, revisions and removal history", async () => {
    const repository = createLocalSemanticBindingRepository(localStore());
    await repository.create(binding);
    expect(await repository.get({ projectId: binding.projectId, contextId: "work-one" }, binding.id)).toEqual(binding);
    expect(await repository.list({ projectId: binding.projectId, contextId: "work-two" })).toEqual([]);
    await repository.update({ projectId: binding.projectId, contextId: "work-one" }, { ...binding, revision: 2, evidence: { ...binding.evidence, rationale: "Changed evidence." } }, 1);
    await repository.remove({ projectId: binding.projectId, contextId: "work-one" }, binding.id, 2);
    expect(await repository.history({ projectId: binding.projectId, contextId: "work-one" }, binding.id)).toHaveLength(3);
  });

  it("rejects stale revisions like the server repository", async () => {
    const repository = createLocalSemanticBindingRepository(localStore());
    await repository.create(binding);
    await repository.update({ projectId: binding.projectId, contextId: "work-one" }, { ...binding, revision: 2 }, 1);
    await expect(repository.update({ projectId: binding.projectId, contextId: "work-one" }, { ...binding, revision: 2 }, 1)).rejects.toThrow("expected revision 1");
  });

  it("round-trips the same JSON payload shape as the server registry", async () => {
    const storage = localStore();
    const local = createLocalSemanticBindingRepository(storage);
    await local.create(binding);
    const sidecar = await storage.read(".semantic-bindings.json");
    expect(JSON.parse(sidecar.ok && sidecar.value ? sidecar.value.content : "{}").bindings).toEqual([binding]);
    expect(await local.get({ projectId: binding.projectId, contextId: "work-one" }, binding.id)).toEqual(binding);
  });
});
