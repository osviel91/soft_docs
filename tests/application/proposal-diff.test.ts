import { describe, expect, it } from "vitest";
import { architecturalProposalDiff } from "../../src/application/proposal-diff";
import type { ArchitecturalProposal } from "../../src/domain/workspace/architectural-proposal";

const proposal: ArchitecturalProposal = {
  id: "proposal-1", projectId: "project-1", authorUserId: "author-1", sourcePrivateContextId: "work-1", title: "Document governance", description: "Explain the publication path.", status: "open", baseSharedRevision: "base", baseSharedResourceRevisions: { "resource-1": 1 }, baseManifestRevision: 1, createdAt: new Date(0), submittedAt: new Date(0),
  resources: [{ sourceResourceId: "private-1", baseResourceId: "resource-1", baseRevision: 1, basePath: "README.md", path: "README.md", type: "markdown-document", sourceRevision: 2, content: "before\nafter\n" }],
  semanticMessages: [{ id: "message-1", name: "Published", kind: "event", sourceContextId: "work-1", operation: "ADD" }],
  relationships: [{ sourceId: "resource-1", targetId: "resource-2", kind: "complementary-view", sourceContextId: "work-1", operation: "ADD" }],
  semanticBindings: [],
};

describe("architectural proposal diff", () => {
  it("compares the immutable base revision to the proposal snapshot and reports staleness separately", async () => {
    const diff = await architecturalProposalDiff(proposal, { revision: "current" }, async (id, revision) => id === "resource-1" && revision === 1 ? { type: "markdown-document", content: "before\n" } : null);
    expect(diff.resources[0].baseContent).toBe("before\n");
    expect(diff.resources[0].proposedContent).toBe("before\nafter\n");
    expect(diff.resources[0].source.changed).toBe(true);
    expect(diff.staleBase).toBe(true);
    expect(diff.impact).toEqual({ resourcesAdded: 0, resourcesModified: 1, resourcesDeleted: 0, relationshipsChanged: 1, semanticIdentitiesChanged: 1, semanticBindingsChanged: 0 });
  });

  it("reports explicitly selected semantic binding operations and evidence changes", async () => {
    const binding = {
      id: "binding-1", projectId: "project-1", left: { version: 1 as const, resourceId: "concepts", representation: "conceptual" as const, entityKind: "concept" as const, identity: { kind: "local-id" as const, value: "account" } },
      right: { version: 1 as const, resourceId: "schema", representation: "database" as const, entityKind: "table" as const, identity: { kind: "local-id" as const, value: "accounts" } }, relation: "represents-in" as const,
      evidence: { version: 1 as const, rationale: "Updated evidence", items: [{ kind: "external" as const, reference: "spec", description: "The source specification" }] }, revision: 2, status: "ACTIVE" as const,
      provenance: { authorId: "author", createdAt: "2026-01-01T00:00:00Z" },
    };
    const diff = await architecturalProposalDiff({ ...proposal, semanticBindings: [{ operation: "UPDATE", binding, baseBinding: { ...binding, evidence: { ...binding.evidence, rationale: "Old evidence" } }, sourceContextId: "private", expectedRevision: 1, baseFingerprint: "fingerprint" }] }, { revision: "base" }, async () => null);
    expect(diff.semanticBindings).toEqual([{ operation: "MODIFIED", bindingId: "binding-1", endpointDelta: { before: { left: binding.left, right: binding.right }, after: { left: binding.left, right: binding.right } }, relationDelta: { before: "represents-in", after: "represents-in" }, evidenceDelta: { before: { ...binding.evidence, rationale: "Old evidence" }, after: binding.evidence } }]);
  });

  it("shows explicit ADD, UPDATE and REMOVE operations", async () => {
    const binding = {
      id: "binding-ops", projectId: "project-1", left: { version: 1 as const, resourceId: "concepts", representation: "conceptual" as const, entityKind: "concept" as const, identity: { kind: "local-id" as const, value: "account" } },
      right: { version: 1 as const, resourceId: "schema", representation: "database" as const, entityKind: "table" as const, identity: { kind: "local-id" as const, value: "accounts" } }, relation: "represents-in" as const,
      evidence: { version: 1 as const, rationale: "Mapping evidence.", items: [{ kind: "external" as const, reference: "ADR-1", description: "Approved mapping." }] }, revision: 1, status: "ACTIVE" as const, provenance: { authorId: "author", createdAt: "2026-01-01T00:00:00Z" },
    };
    const diff = await architecturalProposalDiff({ ...proposal, semanticBindings: [
      { operation: "ADD", binding, sourceContextId: "work" },
      { operation: "UPDATE", binding: { ...binding, revision: 2 }, baseBinding: binding, sourceContextId: "work", expectedRevision: 1, baseFingerprint: "base" },
      { operation: "REMOVE", binding, bindingId: binding.id, sourceContextId: "work", expectedRevision: 1, baseFingerprint: "base" },
    ] }, { revision: "base" }, async () => null);
    expect(diff.semanticBindings.map((entry) => entry.operation)).toEqual(["ADDED", "MODIFIED", "DELETED"]);
  });

  it("does not read current MY WORK when computing a submitted proposal", async () => {
    let reads = 0;
    const diff = await architecturalProposalDiff(proposal, { revision: "base" }, async () => { reads += 1; return { type: "markdown-document", content: "before\n" }; });
    expect(reads).toBe(1);
    expect(diff.resources[0].proposedContent).toBe("before\nafter\n");
  });
});
