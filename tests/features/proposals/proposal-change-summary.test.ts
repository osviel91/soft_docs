import { describe, expect, it } from "vitest";
import { proposalChangeSummary } from "../../../src/features/proposals/proposal-change-summary";
import type { ServerArchitecturalProposal } from "../../../src/workspace/server/api-client";

const proposal = {
  id: "p1",
  projectId: "project",
  authorUserId: "user",
  title: "Checkout knowledge",
  status: "open",
  baseSharedRevision: "r1",
  baseSharedResourceRevisions: {},
  createdAt: "2026-01-01T00:00:00Z",
  submittedAt: "2026-01-01T00:00:00Z",
  resources: [
    { sourceResourceId: "seq", path: "checkout.seq", type: "sequence-diagram", sourceRevision: 1, content: "", operation: "UPDATE" },
    { sourceResourceId: "flow", path: "checkout.eventseq", type: "event-flow", sourceRevision: 1, content: "", operation: "RETIRE" },
  ],
  semanticMessages: [{ id: "paid", name: "PaymentCaptured", kind: "event" }],
  relationships: [{ kind: "complementary-view", sourceId: "seq", targetId: "flow", sourceRole: "execution", targetRole: "causal" }],
} satisfies ServerArchitecturalProposal;

describe("proposal change summary", () => {
  it("uses reported operations and human-readable paths, relationships, and identities", () => {
    const summary = proposalChangeSummary(proposal);
    expect(summary.resources).toEqual([
      { operation: "UPDATE", label: "checkout.seq" },
      { operation: "RETIRE", label: "checkout.eventseq" },
    ]);
    expect(summary.relationships[0]?.label).toContain("checkout.seq -> checkout.eventseq");
    expect(summary.relationships[0]?.label).toContain("execution/causal");
    expect(summary.semantic[0]).toEqual({ operation: "ADD", label: "PaymentCaptured (event)" });
  });

  it("prefers authoritative promotion categories when preview data exists", () => {
    const summary = proposalChangeSummary(proposal, {
      eligible: false,
      reviewStatus: "approved",
      staleBase: true,
      blockers: [{ code: "STALE_BASE", message: "SHARED changed" }],
      creates: [{ path: "new.seq", operation: "CREATE" }],
      updates: [],
      retires: [],
      semanticChanges: [],
      relationships: [],
    });
    expect(summary.resources).toEqual([{ operation: "CREATE", label: "new.seq" }]);
  });
});
