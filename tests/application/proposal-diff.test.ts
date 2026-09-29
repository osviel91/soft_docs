import { describe, expect, it } from "vitest";
import { architecturalProposalDiff } from "../../src/application/proposal-diff";
import type { ArchitecturalProposal } from "../../src/domain/workspace/architectural-proposal";

const proposal: ArchitecturalProposal = {
  id: "proposal-1", projectId: "project-1", authorUserId: "author-1", sourcePrivateContextId: "work-1", title: "Document governance", description: "Explain the publication path.", status: "open", baseSharedRevision: "base", baseSharedResourceRevisions: { "resource-1": 1 }, baseManifestRevision: 1, createdAt: new Date(0), submittedAt: new Date(0),
  resources: [{ sourceResourceId: "private-1", baseResourceId: "resource-1", baseRevision: 1, basePath: "README.md", path: "README.md", type: "markdown-document", sourceRevision: 2, content: "before\nafter\n" }],
  semanticMessages: [{ id: "message-1", name: "Published", kind: "event", sourceContextId: "work-1", operation: "ADD" }],
  relationships: [{ sourceId: "resource-1", targetId: "resource-2", kind: "complementary-view", sourceContextId: "work-1", operation: "ADD" }],
};

describe("architectural proposal diff", () => {
  it("compares the immutable base revision to the proposal snapshot and reports staleness separately", async () => {
    const diff = await architecturalProposalDiff(proposal, { revision: "current" }, async (id, revision) => id === "resource-1" && revision === 1 ? { type: "markdown-document", content: "before\n" } : null);
    expect(diff.resources[0].baseContent).toBe("before\n");
    expect(diff.resources[0].proposedContent).toBe("before\nafter\n");
    expect(diff.resources[0].source.changed).toBe(true);
    expect(diff.staleBase).toBe(true);
    expect(diff.impact).toEqual({ resourcesAdded: 0, resourcesModified: 1, resourcesDeleted: 0, relationshipsChanged: 1, semanticIdentitiesChanged: 1 });
  });

  it("does not read current MY WORK when computing a submitted proposal", async () => {
    let reads = 0;
    const diff = await architecturalProposalDiff(proposal, { revision: "base" }, async () => { reads += 1; return { type: "markdown-document", content: "before\n" }; });
    expect(reads).toBe(1);
    expect(diff.resources[0].proposedContent).toBe("before\nafter\n");
  });
});
