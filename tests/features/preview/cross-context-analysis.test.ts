import { describe, expect, it } from "vitest";
import { crossContextAnalysis, type AnalysisOptions } from "../../../src/features/preview/cross-context-analysis";
import { semanticComparison } from "../../../src/features/preview/semantic-comparison";
import type { ProjectIndex } from "../../../src/domain/project/project-index";
import type { ResourceRelationship } from "../../../src/domain/workspace/resource-relationship";

const options: AnalysisOptions = { direction: "both", maxDepth: 8, maxNodes: 20, includeCandidates: false, includeRecovery: false };

function index(overrides: Partial<ProjectIndex> = {}): ProjectIndex {
  return {
    projectId: "p",
    resources: [
      { id: "a", projectId: "p", path: "a.seq", type: "sequence-diagram", title: "A" },
      { id: "b", projectId: "p", path: "b.seq", type: "sequence-diagram", title: "B" },
    ],
    diagrams: [], eventFlows: [], documents: [], participants: [], usages: [], references: [], diagnostics: [],
    semanticMessages: [], semanticOccurrences: [], eventFlowMessages: [], ...overrides,
  };
}

function occurrence(resourceId: string, messageRef?: string, name = "Created") {
  return { resourceId, name, kind: "event" as const, operation: "publish" as const, step: 1, from: "A", to: "B", messageRef, range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } };
}

function run(source: ProjectIndex, selected = "created", relationships: ResourceRelationship[] = []) {
  const comparison = semanticComparison(source, "a", "b", relationships);
  return crossContextAnalysis(
    { index: source, resourceId: "a" },
    { index: source, resourceId: "b" },
    comparison,
    { messageId: selected },
    options,
    relationships,
  );
}

describe("crossContextAnalysis", () => {
  it("correlates an authoritative anchor only when both scoped traces document it", () => {
    const result = run(index({
      semanticMessages: [{ id: "created", name: "Created", kind: "event" }],
      semanticOccurrences: [occurrence("a", "created"), occurrence("b", "created")],
    }));
    expect(result.semanticConnections.map((entry) => entry.id)).toEqual(["created"]);
    expect(result.sides.a.trace?.limits.maxDepth).toBe(8);
  });

  it("keeps documented-only knowledge and unknown continuation separate", () => {
    const result = run(index({
      semanticMessages: [
        { id: "created", name: "Created", kind: "event" },
        { id: "done", name: "Done", kind: "event" },
      ],
      semanticOccurrences: [occurrence("a", "created"), occurrence("a", "done", "Done"), occurrence("b", "created")],
    }));
    expect(result.documentedOnlyA.map((entry) => entry.identity.id)).toContain("done");
    expect(result.documentedOnlyB).toHaveLength(0);
    expect(result.sides.a.unknownBoundaries.length).toBeGreaterThan(0);
    expect(result.sides.b.unknownBoundaries.length).toBeGreaterThan(0);
  });

  it("does not correlate equal names without an explicit identity", () => {
    const source = index({
      semanticMessages: [{ id: "created", name: "Created", kind: "event" }],
      semanticOccurrences: [occurrence("a", "created"), occurrence("b", undefined)],
    });
    const result = run(source);
    expect(result.semanticConnections).toHaveLength(0);
    expect(result.candidates).toHaveLength(1);
  });

  it("keeps explicit relationships separate from semantic connections", () => {
    const relationship = { kind: "complementary-view" as const, sourceId: "a", targetId: "b", sourceRole: "execution" as const, targetRole: "causal" as const };
    const result = run(index({
      semanticMessages: [{ id: "created", name: "Created", kind: "event" }],
      semanticOccurrences: [occurrence("a", "created"), occurrence("b", "created")],
    }), "created", [relationship]);
    expect(result.semanticConnections).toHaveLength(1);
    expect(result.explicitRelationships).toEqual([relationship]);
  });

  it("clears a stale anchor without mutating the project", () => {
    const source = index();
    const before = JSON.stringify(source);
    const result = run(source, "deleted");
    expect(result.staleAnchor).toBe(true);
    expect(JSON.stringify(source)).toBe(before);
  });
});
