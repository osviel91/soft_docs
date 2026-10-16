import type { ElkEdge, ElkEdgeSection, ElkNode, ElkPort } from "elkjs/lib/elk-api";
import type { Edge, Node } from "@xyflow/react";
import type {
  CausalEdge,
  CausalNodeId,
  CausalViewModel,
} from "../../domain/eventflow/causal-projection";

export type CausalFlowNodeKind = "message" | "handler" | "effect" | "failure" | "retry";
export interface CausalFlowPort {
  id: string;
  side: "WEST" | "EAST";
  top?: number;
}
export interface CausalFlowNodeData extends Record<string, unknown> {
  causalId: CausalNodeId;
  kind: CausalFlowNodeKind;
  label: string;
  labelLines?: string[];
  labelFontSize?: number;
  sourceNodeIds: string[];
  owner?: string;
  ownerLines?: string[];
  ownerFontSize?: number;
  messageKind?: "event" | "command";
  provenance?: string;
  ports?: CausalFlowPort[];
}
export interface CausalFlowRoute {
  id: string;
  points: Array<{ x: number; y: number }>;
  endsAtTarget: boolean;
  fallback?: boolean;
}
export interface CausalFlowEdgeData extends Record<string, unknown> {
  causalType: CausalEdge["type"];
  sourceNodeIds: string[];
  points?: Array<{ x: number; y: number }>;
  routes: CausalFlowRoute[];
  routeWarning?: string;
}

// Zero-sized ports keep routes on node borders while retaining explicit handle IDs.
export const CAUSAL_PORT_SIZE = 0;
const ROUTE_EPSILON = 0.01;
export type CausalFlowNode = Node<CausalFlowNodeData>;
export type CausalFlowEdge = Edge<CausalFlowEdgeData>;
export interface CausalFlowGraph {
  nodes: CausalFlowNode[];
  edges: CausalFlowEdge[];
  width: number;
  height: number;
  layoutWarnings: string[];
}

export const CAUSAL_ELK_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.spacing.edgeEdge": "18",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "18",
  "elk.spacing.nodeNode": "24",
  "elk.layered.spacing.nodeNodeBetweenLayers": "48",
};

export interface CausalElkRequest {
  id: number;
  graph: ElkNode;
}
export interface CausalElkResponse {
  id: number;
  graph?: ElkNode;
  error?: string;
}

export function causalFlowElements(view: CausalViewModel): {
  nodes: CausalFlowNode[];
  edges: CausalFlowEdge[];
} {
  const nodeData = new Map<CausalNodeId, CausalFlowNodeData>();
  for (const item of view.messages) nodeData.set(item.id, {
    causalId: item.id,
    kind: "message",
    label: item.name,
    sourceNodeIds: item.sourceNodeIds,
    messageKind: item.kind,
    provenance: item.provenance,
  });
  for (const item of view.handlers) nodeData.set(item.id, {
    causalId: item.id,
    kind: "handler",
    label: item.displayName,
    sourceNodeIds: item.sourceNodeIds,
  });
  for (const item of view.effects) nodeData.set(item.id, {
    causalId: item.id,
    kind: "effect",
    label: item.description,
    sourceNodeIds: item.sourceNodeIds,
    owner: item.handlerId,
  });
  for (const item of view.failures ?? []) nodeData.set(item.id, {
    causalId: item.id,
    kind: "failure",
    label: item.description ?? item.failureId,
    sourceNodeIds: item.sourceNodeIds,
  });
  for (const item of view.retries ?? []) nodeData.set(item.id, {
    causalId: item.id,
    kind: "retry",
    label: item.description ?? item.retryId,
    sourceNodeIds: item.sourceNodeIds,
  });

  const nodePorts = new Map<CausalNodeId, CausalFlowPort[]>([...nodeData.keys()].map((id) => [id, []]));
  const edgePorts = new Map<string, { sourceHandle: string; targetHandle: string }>();
  for (const edge of view.edges) {
    const sourceHandle = `out:${edge.id}`;
    const targetHandle = `in:${edge.id}`;
    edgePorts.set(edge.id, { sourceHandle, targetHandle });
    nodePorts.get(edge.from)?.push({ id: sourceHandle, side: "EAST" });
    nodePorts.get(edge.to)?.push({ id: targetHandle, side: "WEST" });
  }

  return {
    nodes: [...nodeData.values()].map((data) => {
      const ports = nodePorts.get(data.causalId) ?? [];
      if (!ports.some((port) => port.side === "WEST")) ports.push({ id: `in:${data.causalId}`, side: "WEST" });
      if (!ports.some((port) => port.side === "EAST")) ports.push({ id: `out:${data.causalId}`, side: "EAST" });
      const size = causalNodeSize({ ...data, ports });
      return {
        id: data.causalId,
        type: "causal",
        position: { x: 0, y: 0 },
        width: size.width,
        height: size.height,
        data: {
          ...data,
          ports,
          labelLines: size.labelLines,
          labelFontSize: size.labelFontSize,
          ...(size.ownerLines ? { ownerLines: size.ownerLines, ownerFontSize: size.ownerFontSize } : {}),
        },
      };
    }),
    edges: view.edges.map((edge) => {
      const ports = edgePorts.get(edge.id)!;
      return {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        sourceHandle: ports.sourceHandle,
        targetHandle: ports.targetHandle,
        type: "causal",
        data: { causalType: edge.type, sourceNodeIds: edge.sourceNodeIds, routes: [] },
      };
    }),
  };
}

export function causalElkGraph(view: CausalViewModel): ElkNode {
  const elements = causalFlowElements(view);
  return {
    id: "causal-root",
    layoutOptions: CAUSAL_ELK_OPTIONS,
    children: elements.nodes.map((node) => ({
      id: node.id,
      width: node.width,
      height: node.height,
      layoutOptions: { "elk.portConstraints": "FIXED_SIDE" },
      ports: (node.data.ports ?? []).map((port) => ({
        id: port.id,
        width: CAUSAL_PORT_SIZE,
        height: CAUSAL_PORT_SIZE,
        layoutOptions: { "elk.port.side": port.side },
      })),
    })),
    edges: elements.edges.map((edge) => ({
      id: edge.id,
      sources: [edge.sourceHandle!],
      targets: [edge.targetHandle!],
    })),
  };
}

export function positionedCausalFlow(view: CausalViewModel, laidOut: ElkNode): CausalFlowGraph {
  const elements = causalFlowElements(view);
  const positions = new Map((laidOut.children ?? []).map((node) => [node.id, node]));
  const laidOutEdges = new Map((laidOut.edges ?? []).map((edge) => [edge.id, edge]));
  const laidOutNodes = new Map((laidOut.children ?? []).map((node) => [node.id, node]));
  const layoutWarnings: string[] = [];
  return {
    nodes: elements.nodes.map((node) => {
      const placed = positions.get(node.id);
      const laidPorts = new Map((placed?.ports ?? []).map((port) => [port.id, port]));
      return {
        ...node,
        position: { x: placed?.x ?? 0, y: placed?.y ?? 0 },
        width: placed?.width ?? node.width,
        height: placed?.height ?? node.height,
        data: { ...node.data, ports: (node.data.ports ?? []).map((port) => ({ ...port, top: laidPorts.get(port.id)?.y === undefined ? undefined : laidPorts.get(port.id)!.y! + (laidPorts.get(port.id)!.height ?? 0) / 2 })) },
      };
    }),
    edges: elements.edges.map((edge) => {
      const laidOutEdge = laidOutEdges.get(edge.id);
      const routeResult = laidOutEdge
        ? edgeRoutes(laidOutEdge, laidOutNodes, edge.source, edge.target, edge.sourceHandle!, edge.targetHandle!)
        : { routes: [], warning: "ELK omitted the edge geometry." };
      const routes = routeResult.routes.length
        ? routeResult.routes
        : fallbackRoute(laidOutNodes, edge.source, edge.target, edge.sourceHandle!, edge.targetHandle!, edge.id);
      if (routeResult.warning) layoutWarnings.push(`${edge.id}: ${routeResult.warning}`);
      return {
        ...edge,
        data: {
          causalType: edge.data?.causalType ?? "HANDLER_CAUSES_MESSAGE",
          sourceNodeIds: edge.data?.sourceNodeIds ?? [],
          routes,
          points: routes[0]?.points,
          ...(routeResult.warning ? { routeWarning: routeResult.warning } : {}),
        },
      };
    }),
    width: laidOut.width ?? 0,
    height: laidOut.height ?? 0,
    layoutWarnings,
  };
}

export function causalReachability(view: CausalViewModel, start: CausalNodeId): { nodeIds: Set<CausalNodeId>; edgeIds: Set<string> } {
  const outgoing = new Map<CausalNodeId, CausalEdge[]>();
  for (const edge of view.edges) {
    const edges = outgoing.get(edge.from) ?? [];
    edges.push(edge);
    outgoing.set(edge.from, edges);
  }
  const nodeIds = new Set<CausalNodeId>([start]);
  const edgeIds = new Set<string>();
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    for (const edge of outgoing.get(queue[index]!) ?? []) {
      edgeIds.add(edge.id);
      if (nodeIds.has(edge.to)) continue;
      nodeIds.add(edge.to);
      queue.push(edge.to);
    }
  }
  return { nodeIds, edgeIds };
}

const CAUSAL_NODE_MAX_WIDTH = 480;
const CAUSAL_NODE_BASE_WIDTH_BY_KIND: Record<CausalFlowNodeKind, number> = {
  message: 360,
  handler: 320,
  effect: 320,
  failure: 280,
  retry: 280,
};
const CAUSAL_PORT_MIN_SPACING = 16;
const CAUSAL_MIN_LABEL_FONT_SIZE = 9;

export function causalNodeSize(data: Pick<CausalFlowNodeData, "label" | "kind" | "owner" | "ports">): {
  width: number;
  height: number;
  labelLines: string[];
  labelFontSize: number;
  ownerLines?: string[];
  ownerFontSize?: number;
} {
  const minWidth = data.kind === "handler" ? 150 : 140;
  const ownerText = data.owner ? `owned by ${data.owner.replace("handler:", "")}` : undefined;
  const longestToken = Math.max(1, ...[data.label, ...(ownerText ? [ownerText] : [])].flatMap((text) => lexicalPieces(text).map((piece) => piece.text.length)));
  const readableTokenWidth = longestToken * CAUSAL_MIN_LABEL_FONT_SIZE * 0.55 + 28;
  const contentWidth = Math.min(CAUSAL_NODE_BASE_WIDTH_BY_KIND[data.kind], Math.max(minWidth, data.label.length * 5.4 + 38));
  const width = Math.min(CAUSAL_NODE_MAX_WIDTH, Math.max(contentWidth, readableTokenWidth));
  const labelFontSize = Math.min(13, (width - 28) / (longestToken * 0.55));
  const labelLines = causalTextLines(data.label, width, labelFontSize * 0.55);
  const ownerFontSize = labelFontSize * 0.77;
  const ownerLines = ownerText ? causalTextLines(ownerText, width, ownerFontSize * 0.55) : undefined;
  const lineHeight = labelFontSize * 1.25;
  const ownerLineHeight = ownerFontSize * 1.3;
  const contentHeight = Math.max(54, labelLines.length * lineHeight + (ownerLines ? 5 + ownerLines.length * ownerLineHeight : 0) + 40);
  const maxPortsOnSide = Math.max(0, ...(data.ports ?? []).reduce((counts, port) => {
    counts.set(port.side, (counts.get(port.side) ?? 0) + 1);
    return counts;
  }, new Map<CausalFlowPort["side"], number>()).values());
  const portHeight = maxPortsOnSide > 1 ? (maxPortsOnSide + 1) * CAUSAL_PORT_MIN_SPACING : 0;
  return {
    width,
    height: Math.max(contentHeight, portHeight),
    labelLines,
    labelFontSize,
    ...(ownerLines ? { ownerLines, ownerFontSize } : {}),
  };
}

export function causalTextLines(text: string, width: number, characterWidth = 7.2): string[] {
  const limit = Math.max(1, Math.floor((width - 28) / characterWidth));
  const lines: string[] = [];
  let current = "";
  for (const piece of lexicalPieces(text)) {
    const separator = piece.spaceBefore ? " " : "";
    if (current && current.length + separator.length + piece.text.length > limit) {
      lines.push(current);
      current = piece.text;
    } else {
      current += separator + piece.text;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function lexicalPieces(text: string): Array<{ text: string; spaceBefore: boolean }> {
  const pieces: Array<{ text: string; spaceBefore: boolean }> = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const parts = word.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[_.:/-])/u).filter(Boolean);
    for (const [index, part] of parts.entries()) pieces.push({ text: part, spaceBefore: pieces.length > 0 && index === 0 });
  }
  return pieces;
}

function edgeRoutes(
  edge: ElkEdge,
  nodes: Map<string, ElkNode>,
  sourceId: string,
  targetId: string,
  sourcePortId: string,
  targetPortId: string,
): { routes: CausalFlowRoute[]; warning?: string } {
  const sections = (edge as ElkEdge & { sections?: ElkEdgeSection[] }).sections ?? [];
  const byId = new Map(sections.map((section) => [section.id, section]));
  if (!sections.length) return { routes: [], warning: "ELK returned no route sections." };

  for (const section of sections) {
    const points = sectionPoints(section);
    if (points.length < 2 || points.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y))) {
      return { routes: [], warning: `ELK returned invalid coordinates for section ${section.id}.` };
    }
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1]!;
      const current = points[index]!;
      if (Math.abs(previous.x - current.x) > ROUTE_EPSILON && Math.abs(previous.y - current.y) > ROUTE_EPSILON) {
        return { routes: [], warning: `ELK returned a non-orthogonal segment in section ${section.id}.` };
      }
    }
    if (section.incomingShape === targetPortId || section.outgoingShape === sourcePortId) {
      return { routes: [], warning: `ELK reversed the declared direction in section ${section.id}.` };
    }
    for (const nextId of section.outgoingSections ?? []) {
      const next = byId.get(nextId);
      if (!next || !samePoint(section.endPoint, next.startPoint)) {
        return { routes: [], warning: `ELK sections ${section.id} and ${nextId} are not continuous.` };
      }
    }
    for (const previousId of section.incomingSections ?? []) {
      const previous = byId.get(previousId);
      if (!previous || !samePoint(previous.endPoint, section.startPoint)) {
        return { routes: [], warning: `ELK sections ${previousId} and ${section.id} are not continuous.` };
      }
    }
  }

  const sourceSection = sections.find((section) => section.incomingShape === sourcePortId && !section.incomingSections?.length);
  const targetSection = sections.find((section) => section.outgoingShape === targetPortId && !section.outgoingSections?.length);
  if (!sourceSection || !targetSection) return { routes: [], warning: "ELK sections do not preserve the source-to-target direction." };
  const expectedSource = portAnchor(nodes.get(sourceId), sourcePortId, "EAST");
  const expectedTarget = portAnchor(nodes.get(targetId), targetPortId, "WEST");
  if (!expectedSource || !expectedTarget || !samePoint(sourceSection.startPoint, expectedSource) || !samePoint(targetSection.endPoint, expectedTarget)) {
    return { routes: [], warning: "ELK route endpoints do not match the declared ports." };
  }
  const connected = new Set<string>();
  const queue = [sourceSection.id];
  while (queue.length) {
    const id = queue.shift()!;
    if (connected.has(id)) continue;
    connected.add(id);
    for (const nextId of byId.get(id)?.outgoingSections ?? []) queue.push(nextId);
  }
  if (!connected.has(targetSection.id) || connected.size !== sections.length) {
    return { routes: [], warning: "ELK returned sections outside the directed source-to-target route." };
  }
  return {
    routes: sections.map((section) => ({
      id: section.id,
      points: sectionPoints(section),
      endsAtTarget: section.id === targetSection.id,
    })),
  };
}

function sectionPoints(section: ElkEdgeSection): Array<{ x: number; y: number }> {
  const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(({ x, y }) => ({ x, y }));
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    if (Math.abs(previous.x - current.x) <= ROUTE_EPSILON) current.x = previous.x;
    else if (Math.abs(previous.y - current.y) <= ROUTE_EPSILON) current.y = previous.y;
  }
  return points;
}

function samePoint(left: { x: number; y: number }, right: { x: number; y: number }): boolean {
  return Math.abs(left.x - right.x) <= ROUTE_EPSILON && Math.abs(left.y - right.y) <= ROUTE_EPSILON;
}

function fallbackRoute(
  nodes: Map<string, ElkNode>,
  sourceId: string,
  targetId: string,
  sourcePortId: string,
  targetPortId: string,
  edgeId: string,
): CausalFlowRoute[] {
  const source = portAnchor(nodes.get(sourceId), sourcePortId, "EAST");
  const target = portAnchor(nodes.get(targetId), targetPortId, "WEST");
  if (!source || !target) return [];
  return [{ id: `${edgeId}:fallback`, points: [source, target], endsAtTarget: true, fallback: true }];
}

function portAnchor(node: ElkNode | undefined, id: string, side: "WEST" | "EAST"): { x: number; y: number } | undefined {
  const port = node?.ports?.find((candidate) => candidate.id === id) as ElkPort | undefined;
  if (!node || !port || !Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(port.x) || !Number.isFinite(port.y)) return undefined;
  return {
    x: (node.x ?? 0) + (port.x ?? 0) + (side === "EAST" ? port.width ?? 0 : 0),
    y: (node.y ?? 0) + (port.y ?? 0) + (port.height ?? 0) / 2,
  };
}
