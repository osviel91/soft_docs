import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkEdgeSection, ElkNode } from "elkjs/lib/elk-api";
import type {
  CausalEdge,
  CausalNodeId,
  CausalViewModel,
} from "../domain/eventflow/causal-projection";
import { estimateTextWidth, wrapText } from "./text";

export interface CausalBox { x: number; y: number; width: number; height: number }
export interface CausalPoint { x: number; y: number }
export interface CausalNodeLayout {
  id: CausalNodeId;
  type: "message" | "handler" | "effect" | "failure" | "retry";
  label: string;
  box: CausalBox;
  sourceNodeIds: string[];
  lines: string[];
}
export interface CausalEdgeLayout {
  edge: CausalEdge;
  from: CausalBox;
  to: CausalBox;
  points: CausalPoint[];
  backEdge?: boolean;
}
export interface HandlerEffectGroup {
  handlerId: CausalNodeId;
  effectIds: CausalNodeId[];
}
export interface CausalLayout {
  width: number;
  height: number;
  title?: string;
  nodes: CausalNodeLayout[];
  edges: CausalEdgeLayout[];
  effectGroups: HandlerEffectGroup[];
}

export interface CausalDensity {
  name: "normal" | "compact";
  layerGap: number;
  subordinateGap: number;
  handlerWidth: [number, number];
  messageWidth: [number, number];
  effectWidth: [number, number];
}

const NORMAL_DENSITY: CausalDensity = {
  name: "normal", layerGap: 72, subordinateGap: 28,
  handlerWidth: [140, 220], messageWidth: [180, 260], effectWidth: [150, 250],
};
const COMPACT_DENSITY: CausalDensity = {
  name: "compact", layerGap: 42, subordinateGap: 16,
  handlerWidth: [122, 178], messageWidth: [160, 220], effectWidth: [138, 220],
};
const COMPONENT_GAP = 64;
const MARGIN = 28;
const NODE_LINE_HEIGHT = 15;
const NODE_PADDING_Y = 14;
const EFFECT_LINE_HEIGHT = 14;
const EFFECT_PADDING_Y = 12;
const elk = new ELK();

type LayoutItem = {
  id: CausalNodeId;
  type: CausalNodeLayout["type"];
  label: string;
  sourceNodeIds: string[];
};

export function selectCausalDensity(view: CausalViewModel): CausalDensity {
  const causalEdges = view.edges.filter((edge) => edge.type !== "HANDLER_HAS_EFFECT");
  const outgoing = new Map<CausalNodeId, CausalNodeId[]>();
  for (const edge of causalEdges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  const depth = (id: CausalNodeId, path: Set<CausalNodeId>): number => {
    if (path.has(id)) return 0;
    const next = new Set(path).add(id);
    return Math.max(0, ...(outgoing.get(id) ?? []).map((child) => 1 + depth(child, next)));
  };
  const maxDepth = Math.max(0, ...[
    ...view.messages,
    ...view.handlers,
    ...(view.failures ?? []),
    ...(view.retries ?? []),
  ].map((item) => depth(item.id, new Set())));
  return maxDepth >= 5 || view.messages.length + view.handlers.length + (view.failures?.length ?? 0) + (view.retries?.length ?? 0) >= 14
    ? COMPACT_DENSITY
    : NORMAL_DENSITY;
}

function width(label: string, type: CausalNodeLayout["type"], density: CausalDensity): number {
  const limits = type === "message"
    ? density.messageWidth
    : type === "effect"
      ? density.effectWidth
      : type === "handler"
        ? density.handlerWidth
        : [130, 210];
  return Math.min(limits[1], Math.max(limits[0], estimateTextWidth(label) + 28));
}

function nodeGeometry(label: string, type: CausalNodeLayout["type"], density: CausalDensity): { width: number; height: number; lines: string[] } {
  const boxWidth = width(label, type, density);
  const lines = wrapText(label, boxWidth - 24, type === "effect" ? 12 : 13);
  const lineHeight = type === "effect" ? EFFECT_LINE_HEIGHT : NODE_LINE_HEIGHT;
  const padding = type === "effect" ? EFFECT_PADDING_Y : NODE_PADDING_Y;
  return { width: boxWidth, height: padding + lineHeight * Math.max(1, lines.length) + 18, lines };
}

/** ELK owns placement and routing; the projection remains the source of edges. */
export async function layoutCausalView(view: CausalViewModel): Promise<CausalLayout> {
  const density = selectCausalDensity(view);
  const items = causalItems(view);
  const itemById = new Map(items.map((item) => [item.id, item]));
  const effectGroups = view.handlers
    .map((handler) => ({ handlerId: handler.id, effectIds: view.effects.filter((effect) => effect.handlerId === handler.id).map((effect) => effect.id) }))
    .filter((group) => group.effectIds.length > 0);
  const components = view.components.length
    ? view.components
    : items.map((item) => ({ id: `component:${item.id}`, nodeIds: [item.id], rootNodeIds: [item.id] }));
  const placedNodes: CausalNodeLayout[] = [];
  const placedEdges: CausalEdgeLayout[] = [];
  const componentLayouts: Array<{ nodes: CausalNodeLayout[]; edges: CausalEdgeLayout[]; width: number; height: number }> = [];
  for (const component of components) {
    const componentItems = component.nodeIds.map((id) => itemById.get(id)).filter((item): item is LayoutItem => Boolean(item));
    if (!componentItems.length) continue;
    componentLayouts.push(await layoutComponent(componentItems, view.edges.filter((edge) => component.nodeIds.includes(edge.from) && component.nodeIds.includes(edge.to)), density));
  }
  const placements = packComponents(componentLayouts, MARGIN + (view.title ? 28 : 0));
  let canvasWidth = MARGIN * 2;
  let canvasHeight = MARGIN + (view.title ? 28 : 0);
  for (let index = 0; index < componentLayouts.length; index++) {
    const result = componentLayouts[index];
    const placement = placements[index];
    for (const node of result.nodes) placedNodes.push({ ...node, box: translateBox(node.box, placement.x, placement.y) });
    const boxes = new Map(result.nodes.map((node) => [node.id, translateBox(node.box, placement.x, placement.y)]));
    for (const edge of result.edges) placedEdges.push({
      ...edge,
      from: boxes.get(edge.edge.from)!,
      to: boxes.get(edge.edge.to)!,
      points: edge.points.map((point) => ({ x: point.x + placement.x, y: point.y + placement.y })),
    });
    canvasWidth = Math.max(canvasWidth, placement.x + result.width + MARGIN);
    canvasHeight = Math.max(canvasHeight, placement.y + result.height + MARGIN);
  }

  return {
    width: canvasWidth,
    height: Math.max(MARGIN * 2, canvasHeight),
    ...(view.title === undefined ? {} : { title: view.title }),
    nodes: placedNodes,
    edges: placedEdges,
    effectGroups,
  };
}

async function layoutComponent(items: LayoutItem[], edges: CausalEdge[], density: CausalDensity): Promise<{ nodes: CausalNodeLayout[]; edges: CausalEdgeLayout[]; width: number; height: number }> {
  const mainItems = items.filter((item) => item.type !== "effect");
  const itemById = new Map(items.map((item) => [item.id, item]));
  const graph: ElkNode = {
    id: "component",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.spacing.nodeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": String(density.layerGap),
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: mainItems.map((item) => {
      const geometry = nodeGeometry(item.label, item.type, density);
      return { id: item.id, width: geometry.width, height: geometry.height };
    }),
    edges: edges.filter((edge) => edge.type !== "HANDLER_HAS_EFFECT" && itemById.has(edge.from) && itemById.has(edge.to)).map((edge) => ({ id: edge.id, sources: [edge.from], targets: [edge.to] })),
  };
  const laidOut = mainItems.length ? await elk.layout(graph) : graph;
  const localNodes = (laidOut.children ?? []).map((child) => {
    const item = itemById.get(child.id as CausalNodeId)!;
    const geometry = nodeGeometry(item.label, item.type, density);
    return { ...item, box: { x: child.x ?? 0, y: child.y ?? 0, width: child.width ?? geometry.width, height: child.height ?? geometry.height }, lines: geometry.lines };
  });
  const boxes = new Map(localNodes.map((node) => [node.id, node.box]));
  const mainBottom = Math.max(0, ...localNodes.map((node) => node.box.y + node.box.height));
  const effectGroups = new Map<CausalNodeId, LayoutItem[]>();
  for (const effect of items.filter((item) => item.type === "effect")) {
    const owner = edges.find((edge) => edge.type === "HANDLER_HAS_EFFECT" && edge.to === effect.id)?.from;
    if (owner) effectGroups.set(owner, [...(effectGroups.get(owner) ?? []), effect]);
  }
  for (const [owner, effects] of effectGroups) {
    const handler = boxes.get(owner);
    if (!handler) continue;
    const geometries = effects.map((effect) => ({ effect, geometry: nodeGeometry(effect.label, effect.type, density) }));
    let groupY = handler.y + handler.height + density.subordinateGap;
    const makeGroupBoxes = (y: number) => {
      let cursor = y;
      return geometries.map(({ geometry }) => {
        const box = { x: handler.x + (handler.width - geometry.width) / 2, y: cursor, width: geometry.width, height: geometry.height };
        cursor += geometry.height + density.subordinateGap;
        return box;
      });
    };
    let groupBoxes = makeGroupBoxes(groupY);
    while (groupBoxes.some((box) => [...boxes.values()].some((other) => overlaps(box, other)))) {
      groupY += Math.max(...groupBoxes.map((box) => box.height)) + density.subordinateGap;
      groupBoxes = makeGroupBoxes(groupY);
    }
    for (let index = 0; index < geometries.length; index++) {
      const { effect, geometry } = geometries[index];
      const box = groupBoxes[index];
      boxes.set(effect.id, box);
      localNodes.push({ ...effect, box, lines: geometry.lines });
    }
  }
  const localEdges = edges.flatMap((edge) => {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (!from || !to) return [];
    const sections = laidOut.edges?.find((candidate) => candidate.id === edge.id)?.sections;
    const points = edge.type === "HANDLER_HAS_EFFECT"
      ? effectRoute(from, to)
      : routePoints(sections, from, to);
    return [{ edge, from, to, points, ...(isBackEdge(from, to) ? { backEdge: true } : {}) }];
  });
  const right = Math.max(0, ...localNodes.map((node) => node.box.x + node.box.width));
  const bottom = Math.max(mainBottom, ...localNodes.map((node) => node.box.y + node.box.height));
  return { nodes: localNodes, edges: localEdges, width: right, height: bottom };
}

function causalItems(view: CausalViewModel): LayoutItem[] {
  return [
    ...view.messages.map((item) => ({ id: item.id, type: "message" as const, label: item.name, sourceNodeIds: item.sourceNodeIds })),
    ...view.handlers.map((item) => ({ id: item.id, type: "handler" as const, label: item.displayName, sourceNodeIds: item.sourceNodeIds })),
    ...(view.failures ?? []).map((item) => ({ id: item.id, type: "failure" as const, label: item.description ?? item.failureId, sourceNodeIds: item.sourceNodeIds })),
    ...(view.retries ?? []).map((item) => ({ id: item.id, type: "retry" as const, label: item.description ?? item.retryId, sourceNodeIds: item.sourceNodeIds })),
    ...view.effects.map((item) => ({ id: item.id, type: "effect" as const, label: item.description, sourceNodeIds: item.sourceNodeIds })),
  ];
}

function routePoints(sections: ElkEdgeSection[] | undefined, from: CausalBox, to: CausalBox): CausalPoint[] {
  const section = sections?.[0];
  if (!section) return orthogonalFallback(from, to);
  return [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
}

function effectRoute(from: CausalBox, to: CausalBox): CausalPoint[] {
  const start = { x: from.x + from.width / 2, y: from.y + from.height };
  const end = { x: to.x + to.width / 2, y: to.y };
  return [start, { x: start.x, y: end.y - 12 }, { x: end.x, y: end.y - 12 }, end];
}

function orthogonalFallback(from: CausalBox, to: CausalBox): CausalPoint[] {
  const forward = to.x >= from.x;
  const start = { x: forward ? from.x + from.width : from.x, y: from.y + from.height / 2 };
  const end = { x: forward ? to.x : to.x + to.width, y: to.y + to.height / 2 };
  const lane = (start.x + end.x) / 2;
  return [start, { x: lane, y: start.y }, { x: lane, y: end.y }, end];
}

function isBackEdge(from: CausalBox, to: CausalBox): boolean {
  return to.x + to.width / 2 < from.x + from.width / 2;
}

function overlaps(left: CausalBox, right: CausalBox): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x && left.y < right.y + right.height && left.y + left.height > right.y;
}

function translateBox(box: CausalBox, x: number, y: number): CausalBox {
  return { ...box, x: box.x + x, y: box.y + y };
}

/** Pack complete component bounds; ELK coordinates inside each bound stay intact. */
function packComponents(components: Array<{ width: number; height: number }>, startY: number): CausalPoint[] {
  const maxWidth = Math.max(0, ...components.map((component) => component.width));
  const placements: CausalPoint[] = [];
  let x = MARGIN;
  let y = startY;
  let rowHeight = 0;
  for (const component of components) {
    if (x > MARGIN && x + component.width > MARGIN + maxWidth) {
      x = MARGIN;
      y += rowHeight + COMPONENT_GAP;
      rowHeight = 0;
    }
    placements.push({ x, y });
    x += component.width + COMPONENT_GAP;
    rowHeight = Math.max(rowHeight, component.height);
  }
  return placements;
}
