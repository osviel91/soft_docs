import { describe, expect, it } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import { analyzeEventFlow } from "../../src/language/eventflow/parser";
import { projectEventFlowToCausalView } from "../../src/domain/eventflow/causal-projection";
import { causalElkGraph, causalFlowElements, causalNodeSize, causalReachability, causalTextLines, positionedCausalFlow } from "../../src/renderer/causal/causal-flow-adapter";
import { layout } from "./causal-flow-test-support";

describe("causal React Flow adapter", () => {
  it("projects every causal kind without changing topology", () => {
    const view = projectEventFlowToCausalView(analyzeEventFlow([
      "event Delivery", "event Delivered", "handler Webhook", "Delivery handled by Webhook", "Webhook causes Delivered",
      "effect send on Webhook: send webhook", "failure send-failed on effect send", "retry send-again for send-failed {", "  mechanism: handler", "}",
    ].join("\n")).flow);
    const graph = causalFlowElements(view);
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "message:Delivery", "message:Delivered", "handler:Webhook", "effect:send", "failure:send-failed", "retry:send-again",
    ]);
    expect(graph.nodes.map((node) => node.data.kind)).toEqual(["message", "message", "handler", "effect", "failure", "retry"]);
    expect(graph.nodes.map((node) => [node.id, node.data.sourceNodeIds])).toEqual([
      ...view.messages, ...view.handlers, ...view.effects, ...(view.failures ?? []), ...(view.retries ?? []),
    ].map((node) => [node.id, node.sourceNodeIds]));
    expect(graph.edges.map((edge) => [edge.source, edge.target, edge.data!.causalType])).toEqual(view.edges.map((edge) => [edge.from, edge.to, edge.type]));
    expect(graph.edges.map((edge) => edge.data!.sourceNodeIds)).toEqual(view.edges.map((edge) => edge.sourceNodeIds));
    expect(graph.edges.every((edge) => graph.nodes.some((node) => node.id === edge.source) && graph.nodes.some((node) => node.id === edge.target))).toBe(true);
    for (const edge of graph.edges) {
      expect(graph.nodes.find((node) => node.id === edge.source)?.data.ports?.some((port) => port.id === edge.sourceHandle && port.side === "EAST")).toBe(true);
      expect(graph.nodes.find((node) => node.id === edge.target)?.data.ports?.some((port) => port.id === edge.targetHandle && port.side === "WEST")).toBe(true);
    }
    const elkGraph = causalElkGraph(view);
    expect(elkGraph.edges?.map((edge) => [edge.sources[0], edge.targets[0]])).toEqual(graph.edges.map((edge) => [edge.sourceHandle, edge.targetHandle]));
  });

  it("preserves owner and source metadata", () => {
    const view = projectEventFlowToCausalView(analyzeEventFlow("event A\nhandler H\nA handled by H\neffect save on H: Save state").flow);
    const graph = causalFlowElements(view);
    expect(graph.nodes.find((node) => node.id === "effect:save")?.data.owner).toBe("handler:H");
    expect(graph.nodes.find((node) => node.id === "message:A")?.data.sourceNodeIds.length).toBeGreaterThan(0);
    expect(graph.edges[0]!.data!.sourceNodeIds.length).toBeGreaterThan(0);
  });

  it("wraps PascalCase labels at lexical boundaries and sizes them from rendered lines", () => {
    const label = "BillerViabilityEventRaisedHandler";
    const lines = causalTextLines(label, 160);
    const acronymLabel = "HTTPServerOutputEvent";
    const acronymLines = causalTextLines(acronymLabel, 160);
    const size = causalNodeSize({ label, kind: "handler" });
    const longAtomicToken = "A".repeat(72);
    const longTokenSize = causalNodeSize({ label: longAtomicToken, kind: "message" });

    expect(lines).toEqual(["BillerViability", "EventRaisedHandler"]);
    expect(acronymLines).toEqual(["HTTPServerOutput", "Event"]);
    expect(lines.join("")).toBe(label);
    expect(acronymLines.join("")).toBe(acronymLabel);
    expect(size.labelLines.join("")).toBe(label);
    expect(size.height).toBeGreaterThanOrEqual(size.labelLines.length * size.labelFontSize * 1.25 + 40);
    expect(longTokenSize.width).toBeLessThanOrEqual(480);
    expect(longTokenSize.labelLines.join("")).toBe(longAtomicToken);
    expect(longTokenSize.labelFontSize).toBeGreaterThanOrEqual(9);
    expect(longTokenSize.labelFontSize).toBeLessThan(13);
  });

  it("wraps very long atomic tokens without dropping below the minimum font size", () => {
    const label = "A".repeat(300);
    const size = causalNodeSize({ label, kind: "message" });
    const maxLineLength = Math.floor((size.width - 28) / (size.labelFontSize * 0.95));

    expect(size.width).toBeLessThanOrEqual(480);
    expect(size.labelFontSize).toBeGreaterThanOrEqual(9);
    expect(size.labelLines.join("")).toBe(label);
    expect(size.labelLines.every((line) => Array.from(line).length <= maxLineLength)).toBe(true);
  });

  it("wraps wide uppercase identifiers conservatively to avoid node overflow", () => {
    const label = "W".repeat(60);
    const size = causalNodeSize({ label, kind: "handler" });
    const maxLineLength = Math.floor((size.width - 28) / (size.labelFontSize * 0.95));

    expect(size.labelLines.join("")).toBe(label);
    expect(size.labelLines.every((line) => line.length <= maxLineLength)).toBe(true);
    expect(size.height).toBeGreaterThan(size.labelFontSize * 1.25 + 40);
  });

  it("keeps complete grapheme clusters together", () => {
    const cases = [
      ["a".repeat(18), "e\u0301", "z".repeat(20)],
      ["b".repeat(16), "👍🏽", "y".repeat(20)],
      ["c".repeat(13), "👩🏽‍💻", "x".repeat(20)],
      ["d".repeat(18), "😀", "w".repeat(20)],
    ] as const;
    for (const [prefix, cluster, suffix] of cases) {
      const label = `${prefix}${cluster}${suffix}`;
      const lines = causalTextLines(label, 48, 1);
      expect(lines).toEqual([`${prefix}${cluster}`, suffix]);
      expect(lines.join("")).toBe(label);
      expect(lines.every((line) => line.length <= 20)).toBe(true);
    }

    const oversizedGrapheme = `e${"\u0301".repeat(100)}`;
    expect(causalTextLines(oversizedGrapheme, 48, 1)).toEqual([oversizedGrapheme]);
  });

  it("sizes a handler with enough height for all of its same-side ports", () => {
    const ports = Array.from({ length: 5 }, (_, index) => ({ id: `out:${index}`, side: "EAST" as const }));
    const size = causalNodeSize({ label: "Handler", kind: "handler", ports });

    expect(size.height).toBeGreaterThanOrEqual((ports.length + 1) * 16);
  });

  it("passes all source references through on one projected edge", () => {
    const view = projectEventFlowToCausalView(analyzeEventFlow([
      "event Input",
      "handler H",
      "Input handled by H",
      "Input handled by H",
    ].join("\n")).flow);
    const projectedEdge = view.edges.find((edge) => edge.type === "MESSAGE_HANDLED_BY_HANDLER")!;
    const adaptedEdges = causalFlowElements(view).edges;

    expect(adaptedEdges).toHaveLength(1);
    expect(adaptedEdges[0]!.id).toBe(projectedEdge.id);
    expect(adaptedEdges[0]!.data!.sourceNodeIds).toEqual([
      "handler-input@2:0",
      "handler-input@3:0",
    ]);
  });

  it("creates a direct ELK graph with all entities and no subordinate filtering", () => {
    const view = projectEventFlowToCausalView(analyzeEventFlow("event A\nhandler H\nA handled by H\neffect save on H: Save state").flow);
    const graph = causalElkGraph(view);
    expect(graph.children).toHaveLength(3);
    expect(graph.edges).toHaveLength(2);
    expect(graph.layoutOptions?.["elk.edgeRouting"]).toBe("ORTHOGONAL");
    expect(graph.layoutOptions?.["elk.direction"]).toBe("RIGHT");
    for (const node of graph.children ?? []) {
      expect(node.layoutOptions?.["elk.portConstraints"]).toBe("FIXED_SIDE");
      expect(node.ports?.length).toBeGreaterThan(0);
    }
    for (const edge of graph.edges ?? []) {
      expect(edge.sources?.[0]).toMatch(/^out:/);
      expect(edge.targets?.[0]).toMatch(/^in:/);
    }
  });

  it("lays out the disconnected fixture as visible nodes", async () => {
    const view = projectEventFlowToCausalView(analyzeEventFlow("event A\nevent Isolated\nhandler H\nA handled by H").flow);
    const result = await layout(view);
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes.find((node) => node.id === "message:Isolated")?.position).toBeDefined();
  });

  it("renders every linked ELK section separately and marks only the target section", async () => {
    const view = projectEventFlowToCausalView(analyzeEventFlow("event A\nhandler H\nA handled by H").flow);
    const laidOut = structuredClone(await new ELK().layout(causalElkGraph(view)));
    const elkEdge = laidOut.edges![0]!;
    const originalSection = elkEdge.sections![0]!;
    const source = originalSection.startPoint;
    const target = originalSection.endPoint;
    const middle = { x: (source.x + target.x) / 2, y: source.y };
    const sourceHandle = elkEdge.sources[0]!;
    const targetHandle = elkEdge.targets[0]!;
    elkEdge.sections = [
      { id: "first", startPoint: source, endPoint: middle, incomingShape: sourceHandle, outgoingSections: ["second"] },
      { id: "second", startPoint: middle, endPoint: target, incomingSections: ["first"], outgoingShape: targetHandle },
    ];
    const result = positionedCausalFlow(view, laidOut);
    expect(result.edges[0]!.data!.routes).toEqual([
      { id: "first", points: [source, middle], endsAtTarget: false },
      { id: "second", points: [middle, target], endsAtTarget: true },
    ]);
    expect(result.layoutWarnings).toEqual([]);
  });

  it("shows a port-to-port fallback and warning for invalid ELK geometry", async () => {
    const view = projectEventFlowToCausalView(analyzeEventFlow("event A\nhandler H\nA handled by H").flow);
    const valid = await new ELK().layout(causalElkGraph(view));
    const edge = valid.edges![0]!;
    edge.sections![0]!.bendPoints = [{ x: edge.sections![0]!.startPoint.x + 5, y: edge.sections![0]!.startPoint.y + 5 }];
    const result = positionedCausalFlow(view, valid);
    expect(result.layoutWarnings).toHaveLength(1);
    expect(result.edges[0]!.data!.routeWarning).toContain("non-orthogonal");
    expect(result.edges[0]!.data!.routes[0]!.fallback).toBe(true);
    expect(result.edges[0]!.data!.routes[0]!.points).toHaveLength(2);
  });

  it("traverses directed causal cycles once without changing semantic edges", () => {
    const view = projectEventFlowToCausalView(analyzeEventFlow([
      "event Work", "handler Worker", "Work handled by Worker", "failure failed on handler Worker",
      "retry retry-worker for failed {", "  target: same-execution", "}",
    ].join("\n")).flow);
    const before = view.edges.map(({ id, from, to, type, sourceNodeIds }) => [id, from, to, type, sourceNodeIds]);
    const traversal = causalReachability(view, "handler:Worker");
    expect(traversal.nodeIds).toEqual(new Set(["handler:Worker", "failure:failed", "retry:retry-worker"]));
    expect([...traversal.edgeIds]).toEqual(view.edges.filter((edge) => edge.from !== "message:Work").map((edge) => edge.id));
    expect(view.edges.map(({ id, from, to, type, sourceNodeIds }) => [id, from, to, type, sourceNodeIds])).toEqual(before);
  });
});
