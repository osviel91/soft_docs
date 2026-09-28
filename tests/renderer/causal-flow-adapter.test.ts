import { describe, expect, it } from "vitest";
import { analyzeEventFlow } from "../../src/language/eventflow/parser";
import { projectEventFlowToCausalView } from "../../src/domain/eventflow/causal-projection";
import { causalElkGraph, causalFlowElements } from "../../src/renderer/causal/causal-flow-adapter";
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
    expect(graph.edges.map((edge) => [edge.source, edge.target, edge.data!.causalType])).toEqual(view.edges.map((edge) => [edge.from, edge.to, edge.type]));
    expect(graph.edges.every((edge) => graph.nodes.some((node) => node.id === edge.source) && graph.nodes.some((node) => node.id === edge.target))).toBe(true);
  });

  it("preserves owner and source metadata", () => {
    const view = projectEventFlowToCausalView(analyzeEventFlow("event A\nhandler H\nA handled by H\neffect save on H: Save state").flow);
    const graph = causalFlowElements(view);
    expect(graph.nodes.find((node) => node.id === "effect:save")?.data.owner).toBe("handler:H");
    expect(graph.nodes.find((node) => node.id === "message:A")?.data.sourceNodeIds.length).toBeGreaterThan(0);
    expect(graph.edges[0]!.data!.sourceNodeIds.length).toBeGreaterThan(0);
  });

  it("creates a direct ELK graph with all entities and no subordinate filtering", () => {
    const view = projectEventFlowToCausalView(analyzeEventFlow("event A\nhandler H\nA handled by H\neffect save on H: Save state").flow);
    const graph = causalElkGraph(view);
    expect(graph.children).toHaveLength(3);
    expect(graph.edges).toHaveLength(2);
    expect(graph.layoutOptions?.["elk.edgeRouting"]).toBe("ORTHOGONAL");
  });

  it("lays out the disconnected fixture as visible nodes", async () => {
    const view = projectEventFlowToCausalView(analyzeEventFlow("event A\nevent Isolated\nhandler H\nA handled by H").flow);
    const result = await layout(view);
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes.find((node) => node.id === "message:Isolated")?.position).toBeDefined();
  });
});
