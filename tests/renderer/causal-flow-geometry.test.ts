import { describe, expect, it } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import { analyzeEventFlow } from "../../src/language/eventflow/parser";
import { projectEventFlowToCausalView, type CausalEdge, type CausalFailure, type CausalRetry, type CausalViewModel } from "../../src/domain/eventflow/causal-projection";
import { CAUSAL_ELK_OPTIONS, CAUSAL_PORT_SIZE, causalFlowElements } from "../../src/renderer/causal/causal-flow-adapter";
import { layout } from "./causal-flow-test-support";
import { CAUSAL_GOLDEN_FIXTURES } from "../fixtures/causal-fixtures";

type Point = { x: number; y: number };
type Box = Point & { width: number; height: number };

function overlaps(left: Box, right: Box): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x && left.y < right.y + right.height && left.y + left.height > right.y;
}

function crossesInterior(points: Point[], box: Box): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    if (from.x === to.x && from.x > box.x && from.x < box.x + box.width && Math.max(from.y, to.y) > box.y && Math.min(from.y, to.y) < box.y + box.height) return true;
    if (from.y === to.y && from.y > box.y && from.y < box.y + box.height && Math.max(from.x, to.x) > box.x && Math.min(from.x, to.x) < box.x + box.width) return true;
  }
  return false;
}

function crossings(edges: Array<{ id: string; source: string; target: string; routes: Point[][] }>): number {
  let count = 0;
  for (let first = 0; first < edges.length; first += 1) for (let second = first + 1; second < edges.length; second += 1) {
    const left = edges[first]!;
    const right = edges[second]!;
    const intersections = new Set<string>();
    for (const leftRoute of left.routes) for (const rightRoute of right.routes) for (let i = 1; i < leftRoute.length; i += 1) for (let j = 1; j < rightRoute.length; j += 1) {
      const a = leftRoute[i - 1]!; const b = leftRoute[i]!;
      const c = rightRoute[j - 1]!; const d = rightRoute[j]!;
      const verticalA = a.x === b.x; const verticalB = c.x === d.x;
      if (verticalA === verticalB) continue;
      const vertical = verticalA ? [a, b] : [c, d];
      const horizontal = verticalA ? [c, d] : [a, b];
      const x = vertical[0]!.x; const y = horizontal[0]!.y;
      if (x > Math.min(horizontal[0]!.x, horizontal[1]!.x) && x < Math.max(horizontal[0]!.x, horizontal[1]!.x)
        && y > Math.min(vertical[0]!.y, vertical[1]!.y) && y < Math.max(vertical[0]!.y, vertical[1]!.y)) intersections.add(`${x},${y}`);
    }
    count += intersections.size;
  }
  return count;
}

async function baselineLayout(view: CausalViewModel) {
  const elements = causalFlowElements(view);
  const baselineGraph: ElkNode = {
    id: "causal-root",
    layoutOptions: CAUSAL_ELK_OPTIONS,
    children: elements.nodes.map((node) => ({ id: node.id, width: node.width, height: node.height })),
    edges: elements.edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  };
  const result = await new ELK().layout(baselineGraph);
  return {
    nodes: (result.children ?? []).map((node) => ({ id: node.id, x: node.x ?? 0, y: node.y ?? 0, width: node.width ?? 0, height: node.height ?? 0 })),
    edges: (result.edges ?? []).map((edge) => {
      const section = edge.sections?.[0];
      const original = view.edges.find((candidate) => candidate.id === edge.id)!;
      return { id: edge.id, source: original.from, target: original.to, routes: [section ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint] : []] };
    }),
  };
}

function boxOf(node: { position: Point; width?: number; height?: number }): Box {
  return { x: node.position.x, y: node.position.y, width: node.width ?? 0, height: node.height ?? 0 };
}

function samePoint(left: Point | undefined, right: Point): boolean {
  return !!left && Math.abs(left.x - right.x) <= 0.01 && Math.abs(left.y - right.y) <= 0.01;
}

function model(name: keyof typeof CAUSAL_GOLDEN_FIXTURES): CausalViewModel {
  const view = projectEventFlowToCausalView(analyzeEventFlow(CAUSAL_GOLDEN_FIXTURES[name].join("\n")).flow);
  if (name !== "BillerViabilityEventRaisedHandler layout") return view;
  // Layout-only unknown failure target: the example establishes a retry exists,
  // but does not provide evidence for the operation that failed.
  const failure: CausalFailure = { id: "failure:layout-context", failureId: "layout-context", target: "undocumented", metadata: [], sourceNodeIds: [] };
  const retry: CausalRetry = { id: "retry:layout-retry", retryId: "layout-retry", failureId: failure.failureId, metadata: [], sourceNodeIds: [] };
  return {
    ...view,
    failures: [failure],
    retries: [retry],
    edges: [...view.edges, { id: "layout:failure-retried", type: "FAILURE_RETRIED" as const, from: failure.id, to: retry.id, sourceNodeIds: [] } satisfies CausalEdge],
    components: [...view.components, { id: `component:${failure.id}`, nodeIds: [failure.id, retry.id], rootNodeIds: [failure.id] }],
  };
}

describe("production causal ELK geometry", () => {
  it.each(Object.entries(CAUSAL_GOLDEN_FIXTURES))("preserves topology and safe geometry for %s", async (name) => {
    const view = model(name as keyof typeof CAUSAL_GOLDEN_FIXTURES);
    const result = await layout(view);
    const expectedCount = view.messages.length + view.handlers.length + view.effects.length + (view.failures?.length ?? 0) + (view.retries?.length ?? 0);
    expect(result.nodes).toHaveLength(expectedCount);
    expect(result.edges).toHaveLength(view.edges.length);
    expect(result.layoutWarnings, name).toEqual([]);
    expect(new Set(result.nodes.map((node) => node.id)).size).toBe(result.nodes.length);
    expect(result.edges.map(({ id, source, target, data }) => [id, source, target, data?.causalType, data?.sourceNodeIds])).toEqual(view.edges.map(({ id, from, to, type, sourceNodeIds }) => [id, from, to, type, sourceNodeIds]));
    for (let left = 0; left < result.nodes.length; left += 1) for (let right = left + 1; right < result.nodes.length; right += 1) expect(overlaps(boxOf(result.nodes[left]!), boxOf(result.nodes[right]!))).toBe(false);

    const nodes = new Map(result.nodes.map((node) => [node.id, node]));
    for (const node of result.nodes) for (const side of ["WEST", "EAST"] as const) {
      const portTops = (node.data.ports ?? []).filter((port) => port.side === side).map((port) => port.top!).sort((left, right) => left - right);
      for (let index = 1; index < portTops.length; index += 1) {
        expect(portTops[index]! - portTops[index - 1]!).toBeGreaterThanOrEqual(16);
      }
    }
    for (const edge of result.edges) {
      const source = nodes.get(edge.source)!;
      const target = nodes.get(edge.target)!;
      const sourcePort = source.data.ports!.find((port) => port.id === edge.sourceHandle)!;
      const targetPort = target.data.ports!.find((port) => port.id === edge.targetHandle)!;
      expect(sourcePort.side).toBe("EAST");
      expect(targetPort.side).toBe("WEST");
      expect(edge.data?.routes.length).toBeGreaterThan(0);
      const sourcePoint = { x: source.position.x + source.width! + CAUSAL_PORT_SIZE, y: source.position.y + sourcePort.top! };
      const targetPoint = { x: target.position.x - CAUSAL_PORT_SIZE, y: target.position.y + targetPort.top! };
      expect(edge.data?.routes.some((route) => samePoint(route.points[0], sourcePoint))).toBe(true);
      expect(samePoint(edge.data?.routes.find((route) => route.endsAtTarget)?.points.at(-1), targetPoint)).toBe(true);
      for (const route of edge.data?.routes ?? []) for (let index = 1; index < route.points.length; index += 1) {
        const previous = route.points[index - 1]!;
        const current = route.points[index]!;
        expect(previous.x === current.x || previous.y === current.y).toBe(true);
      }
      for (const node of result.nodes) if (node.id !== edge.source && node.id !== edge.target) {
        for (const route of edge.data?.routes ?? []) expect(crossesInterior(route.points, boxOf(node))).toBe(false);
      }
    }
  });

  it.each([
    "Branch and converge",
    "Disconnected causal components",
    "Cyclic failure retry",
    "BillerViabilityEventRaisedHandler layout",
    "RechargeReprogrammingSubEventHandler layout",
  ] as const)("does not increase edge crossings or vary layout for %s", async (name) => {
    const view = model(name);
    const [first, second, baseline] = await Promise.all([layout(view), layout(view), baselineLayout(view)]);
    const countCurrent = crossings(first.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, routes: edge.data?.routes.map((route) => route.points) ?? [] })));
    const countBaseline = crossings(baseline.edges);
    expect(countCurrent).toBeLessThanOrEqual(countBaseline);
    if (name.endsWith(" layout")) expect(countCurrent).toBe(0);
    expect(first.nodes.map((node) => [node.id, node.position.x, node.position.y])).toEqual(second.nodes.map((node) => [node.id, node.position.x, node.position.y]));
    expect(first.edges.map((edge) => edge.data?.routes)).toEqual(second.edges.map((edge) => edge.data?.routes));
  });

  it("keeps disconnected components separate without adding relationships", async () => {
    const view = model("Disconnected causal components");
    const result = await layout(view);
    expect(result.edges.map(({ id, source, target }) => [id, source, target])).toEqual(view.edges.map(({ id, from, to }) => [id, from, to]));
    expect(result.nodes.find((node) => node.id === "message:Isolated")).toBeDefined();
    expect(result.layoutWarnings).toEqual([]);
  });

  it("keeps effects owned and disconnected nodes visible", async () => {
    const view = projectEventFlowToCausalView(analyzeEventFlow(CAUSAL_GOLDEN_FIXTURES["Disconnected components"].join("\n")).flow);
    const result = await layout(view);
    expect(result.nodes.find((node) => node.id === "effect:persist")?.data.owner).toBe("handler:PrimaryHandler");
    expect(result.nodes.find((node) => node.id === "message:Isolated")).toBeDefined();
  });
});
