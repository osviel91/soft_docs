import { describe, expect, it } from "vitest";
import { buildProposalLineage, deriveProposalLifecycle, evaluateProposalConsistency, type ProposalLifecycleRecord } from "../../../src/domain/workspace/proposal-lifecycle";

const proposal = (id: string, overrides: Partial<ProposalLifecycleRecord> = {}): ProposalLifecycleRecord => ({
  id,
  projectId: "project",
  title: id,
  status: "open",
  supersedesProposalId: null,
  ...overrides,
});

describe("architectural proposal lifecycle", () => {
  it.each([
    ["open", "none", null, "OPEN"],
    ["open", "mixed", null, "CHANGES_REQUESTED"],
    ["open", "changes-requested", null, "CHANGES_REQUESTED"],
    ["open", "approved", null, "APPROVED"],
    ["open", "approved", "COMMITTED_COMPLETION_PENDING", "PROMOTING"],
    ["open", "approved", "COMPLETED", "PROMOTED"],
    ["withdrawn", "approved", "COMPLETED", "WITHDRAWN"],
    ["superseded", "approved", null, "SUPERSEDED"],
  ] as const)("derives %s/%s/%s as %s", (status, review, promotion, expected) => {
    expect(deriveProposalLifecycle(status, review, promotion)).toBe(expected);
  });

  it("returns an ordered bounded lineage and marks missing or cyclic links", () => {
    const a = proposal("a");
    const b = proposal("b", { status: "superseded", supersedesProposalId: "a" });
    const c = proposal("c", { supersedesProposalId: "b" });
    expect(buildProposalLineage(c, [c, b, a]).entries.map((entry) => entry.id)).toEqual(["a", "b", "c"]);

    const cyclicA = proposal("cycle-a", { supersedesProposalId: "cycle-b" });
    const cyclicB = proposal("cycle-b", { supersedesProposalId: "cycle-a" });
    expect(buildProposalLineage(cyclicA, [cyclicA, cyclicB]).diagnostics.map((item) => item.code)).toContain("LINEAGE_CYCLE");
    expect(buildProposalLineage(proposal("broken", { supersedesProposalId: "missing" }), []).diagnostics.map((item) => item.code)).toContain("LINEAGE_BROKEN_PREDECESSOR");
    expect(buildProposalLineage(c, [c, b, a], 1).diagnostics.map((item) => item.code)).toContain("LINEAGE_DEPTH_LIMIT");
    expect(buildProposalLineage(proposal("outside", { supersedesProposalId: "other-project" }), [proposal("other-project", { projectId: "other" })]).diagnostics.map((item) => item.code)).toContain("LINEAGE_BROKEN_PREDECESSOR");
  });

  it("flags contradictory terminal status and promotion evidence without rewriting it", () => {
    const lineage = buildProposalLineage(proposal("old", { status: "superseded" }), [proposal("old", { status: "superseded" })]);
    const consistency = evaluateProposalConsistency("superseded", {
      id: "promotion", projectId: "project", proposalId: "old", status: "COMPLETED", createdAt: new Date(0), completedAt: new Date(1),
      actor: { kind: "user", userId: "actor", subjectUserId: "actor" }, baseSharedRevision: "base", baseManifestRevision: 0, resultingSharedRevision: "result", entries: [], relationships: [], semanticMessages: [],
    }, lineage);
    expect(consistency.diagnostics.map((item) => item.code)).toContain("PROMOTION_ON_TERMINAL_PROPOSAL");
    expect(consistency.state).toBe("INCONSISTENT");
  });
});
