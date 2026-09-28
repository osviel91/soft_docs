import { describe, expect, it } from "vitest";
import { analyzeEventFlow } from "../../src/language/eventflow/parser";
import { projectEventFlowToCausalView } from "../../src/domain/eventflow/causal-projection";
import { layout } from "./causal-flow-test-support";
import { CAUSAL_GOLDEN_FIXTURES } from "../fixtures/causal-fixtures";

function overlaps(left: Box, right: Box): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x && left.y < right.y + right.height && left.y + left.height > right.y;
}
type Box = { x: number; y: number; width: number; height: number };

function crossesInterior(points: Array<{ x: number; y: number }>, box: Box): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    if (from.x === to.x && from.x > box.x && from.x < box.x + box.width && Math.max(from.y, to.y) > box.y && Math.min(from.y, to.y) < box.y + box.height) return true;
    if (from.y === to.y && from.y > box.y && from.y < box.y + box.height && Math.max(from.x, to.x) > box.x && Math.min(from.x, to.x) < box.x + box.width) return true;
  }
  return false;
}

describe("production causal ELK geometry", () => {
  it.each(Object.entries(CAUSAL_GOLDEN_FIXTURES))("preserves topology and geometry for %s", async (_name, lines) => {
    const view = projectEventFlowToCausalView(analyzeEventFlow(lines.join("\n")).flow);
    const result = await layout(view);
    const expectedCount = view.messages.length + view.handlers.length + view.effects.length + (view.failures?.length ?? 0) + (view.retries?.length ?? 0);
    expect(result.nodes).toHaveLength(expectedCount);
    expect(result.edges).toHaveLength(view.edges.length);
    expect(new Set(result.nodes.map((node) => node.id)).size).toBe(result.nodes.length);
    expect(result.edges.every((edge) => result.nodes.some((node) => node.id === edge.source) && result.nodes.some((node) => node.id === edge.target))).toBe(true);
    for (let left = 0; left < result.nodes.length; left += 1) for (let right = left + 1; right < result.nodes.length; right += 1) expect(overlaps(boxOf(result.nodes[left]!), boxOf(result.nodes[right]!))).toBe(false);
    const boxes = new Map(result.nodes.map((node) => [node.id, { x: node.position.x, y: node.position.y, width: node.width!, height: node.height! }]));
    for (const edge of result.edges) for (const node of result.nodes) if (node.id !== edge.source && node.id !== edge.target) expect(crossesInterior(edge.data?.points ?? [], boxes.get(node.id)!)).toBe(false);
  });

  it("keeps effects owned and disconnected nodes visible", async () => {
    const view = projectEventFlowToCausalView(analyzeEventFlow(CAUSAL_GOLDEN_FIXTURES["Disconnected components"].join("\n")).flow);
    const result = await layout(view);
    expect(result.nodes.find((node) => node.id === "effect:persist")?.data.owner).toBe("handler:PrimaryHandler");
    expect(result.nodes.find((node) => node.id === "message:Isolated")).toBeDefined();
  });
});

function boxOf(node: { position: { x: number; y: number }; width?: number; height?: number }): Box {
  return { x: node.position.x, y: node.position.y, width: node.width ?? 0, height: node.height ?? 0 };
}
