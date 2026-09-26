import { describe, expect, it } from "vitest";
import { semanticComparison } from "../../../src/features/preview/semantic-comparison";
import type { ProjectIndex } from "../../../src/domain/project/project-index";

function index(overrides: Partial<ProjectIndex> = {}): ProjectIndex {
  return {
    projectId: "p",
    resources: [],
    diagrams: [],
    eventFlows: [],
    documents: [],
    participants: [],
    usages: [],
    references: [],
    diagnostics: [],
    semanticMessages: [],
    semanticOccurrences: [],
    eventFlowMessages: [],
    ...overrides,
  };
}

describe("semanticComparison", () => {
  const mslSequence = "msl-sequence";
  const upOneSequence = "upone-sequence";
  const mslTransactionIngestion = "msl-transaction-ingestion";
  const negativeLedgerNotification = "negative-ledger-notification";
  const upOneEventFlow = "upone-event-flow";

  function occurrence(resourceId: string, id: string, kind: "event" | "command", step: number) {
    return { resourceId, name: id, kind, operation: "publish" as const, step, from: "A", to: "B", messageRef: id, range: { start: { line: step, column: 1 }, end: { line: step, column: 2 } } };
  }

  it("matches authoritative sequence and Event Flow occurrences by identity", () => {
    const result = semanticComparison(index({
      semanticMessages: [{ id: "created", name: "Created", kind: "event" }],
      semanticOccurrences: [{ resourceId: "seq", name: "Created", kind: "event", operation: "publish", step: 1, from: "A", to: "B", messageRef: "created", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }],
      eventFlowMessages: [{ resourceId: "flow", name: "Created", kind: "event", messageRef: "created", nodeId: "event:1", sourceRange: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }],
    }), "seq", "flow");
    expect(result.shared.map((entry) => entry.id)).toEqual(["created"]);
    expect(result.occurrences.a[0].operation).toBe("publish");
    expect(result.occurrences.b[0].nodeId).toBe("event:1");
  });

  it("does not match equal names with different identities and preserves candidates", () => {
    const result = semanticComparison(index({
      semanticMessages: [
        { id: "a", name: "Changed", kind: "event" },
        { id: "b", name: "Changed", kind: "event" },
      ],
      semanticOccurrences: [
        { resourceId: "a", name: "Changed", kind: "event", operation: "publish", step: 1, from: "A", to: "B", messageRef: "a", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } },
        { resourceId: "b", name: "Changed", kind: "event", operation: "consume", step: 1, from: "B", to: "C", messageRef: "b", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } },
        { resourceId: "b", name: "Changed", kind: "event", operation: "consume", step: 2, from: "B", to: "D", range: { start: { line: 2, column: 1 }, end: { line: 2, column: 2 } } },
      ],
    }), "a", "b");
    expect(result.shared).toHaveLength(0);
    expect(result.onlyA.map((entry) => entry.id)).toEqual(["a"]);
    expect(result.onlyB.map((entry) => entry.id)).toEqual(["b"]);
    expect(result.candidates).toHaveLength(1);
  });

  it("keeps complementary relationships separate from semantic matches", () => {
    const result = semanticComparison(index({
      semanticMessages: [{ id: "m", name: "M", kind: "command" }],
      semanticOccurrences: [{ resourceId: "a", name: "M", kind: "command", operation: "dispatch", step: 1, from: "A", to: "B", messageRef: "m", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }],
    }), "a", "b", [{ kind: "complementary-view", sourceId: "a", targetId: "b", sourceRole: "execution", targetRole: "causal" }]);
    expect(result.onlyA[0].kind).toBe("command");
    expect(result.relationship?.sourceRole).toBe("execution");
  });

  it("has zero shared identities for MSL Sequence and UpOne Sequence", () => {
    const result = semanticComparison(index({
      semanticMessages: [{ id: "msl-only", name: "MSLMessage", kind: "event" }, { id: "upone-only", name: "UpOneMessage", kind: "event" }],
      semanticOccurrences: [occurrence(mslSequence, "msl-only", "event", 1), occurrence(upOneSequence, "upone-only", "event", 1)],
    }), mslSequence, upOneSequence);
    expect(result.shared).toHaveLength(0);
  });

  it("shows three shared authoritative identities without implying a relationship", () => {
    const identities = [
      { id: "transaction", name: "TransactionIngested", kind: "event" as const },
      { id: "posted", name: "LedgerPosted", kind: "event" as const },
      { id: "notify", name: "NegativeBalanceNotification", kind: "command" as const },
    ];
    const result = semanticComparison(index({
      semanticMessages: identities,
      semanticOccurrences: identities.flatMap((identity, step) => [occurrence(mslTransactionIngestion, identity.id, identity.kind, step + 1), occurrence(negativeLedgerNotification, identity.id, identity.kind, step + 1)]),
    }), mslTransactionIngestion, negativeLedgerNotification);
    expect(result.shared).toHaveLength(3);
    expect(result.relationship).toBeNull();
    expect(result.shared.find((identity) => identity.kind === "command")?.name).toBe("NegativeBalanceNotification");
  });

  it("keeps authoritative shared identities distinct from the UpOne relationship", () => {
    const result = semanticComparison(index({
      semanticMessages: [{ id: "upone-shared", name: "UpOneCreated", kind: "event" }],
      semanticOccurrences: [occurrence(upOneSequence, "upone-shared", "event", 1)],
      eventFlowMessages: [{ resourceId: upOneEventFlow, name: "UpOneCreated", kind: "event", messageRef: "upone-shared", nodeId: "event:1", sourceRange: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }],
    }), upOneSequence, upOneEventFlow, [{ kind: "complementary-view", sourceId: upOneSequence, targetId: upOneEventFlow, sourceRole: "execution", targetRole: "causal" }]);
    expect(result.shared.map((identity) => identity.id)).toEqual(["upone-shared"]);
    expect(result.relationship?.kind).toBe("complementary-view");
  });
});
