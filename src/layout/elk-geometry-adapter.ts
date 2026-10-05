import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkEdge, ElkNode } from "elkjs/lib/elk-api";
import type { GeometryInput, PositionedGeometry } from "./geometry-input";

const ENGINE_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.spacing.nodeNode": "40",
  "elk.layered.spacing.nodeNodeBetweenLayers": "72",
  "elk.spacing.edgeNode": "18",
};

const CONCEPTUAL_OPTIONS = {
  ...ENGINE_OPTIONS,
  "elk.direction": "DOWN",
  "elk.spacing.nodeNode": "20",
  "elk.layered.spacing.nodeNodeBetweenLayers": "32",
  "elk.spacing.edgeNode": "8",
};

export type GeometryLayoutProfile = "default" | "conceptual";

export class GeometryLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeometryLayoutError";
  }
}

const elk = new ELK();

/** ELK stays behind this adapter; callers only see the stable geometry contract. */
export async function layoutGeometry(input: GeometryInput, profile: GeometryLayoutProfile = "default"): Promise<PositionedGeometry> {
  validateInput(input);
  if (input.items.length === 0) return { width: 0, height: 0, items: [], ports: [], connections: [] };
  try {
    const graph = await elk.layout(toElkGraph(input, profile));
    return fromElkGraph(input, graph);
  } catch (error) {
    throw new GeometryLayoutError(`Geometry layout failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateInput({ items, connections }: GeometryInput): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (!item.id || ids.has(item.id)) throw new GeometryLayoutError(`Duplicate or empty geometry item id "${item.id}".`);
    ids.add(item.id);
    if (!(item.requiredWidth > 0) || !(item.requiredHeight > 0)) throw new GeometryLayoutError(`Geometry item "${item.id}" must have positive dimensions.`);
    for (const port of item.ports ?? []) {
      if (!port.id || ids.has(port.id)) throw new GeometryLayoutError(`Duplicate or empty geometry port id "${port.id}".`);
      if (port.x !== undefined && (port.x < 0 || port.x > item.requiredWidth)) throw new GeometryLayoutError(`Geometry port "${port.id}" is outside its owner.`);
      if (port.y !== undefined && (port.y < 0 || port.y > item.requiredHeight)) throw new GeometryLayoutError(`Geometry port "${port.id}" is outside its owner.`);
      ids.add(port.id);
    }
  }
  const portOwners = new Map(items.flatMap(item => (item.ports ?? []).map(port => [port.id, item.id] as const)));
  for (const connection of connections) {
    if (!connection.id || ids.has(connection.id)) throw new GeometryLayoutError(`Duplicate or empty geometry connection id "${connection.id}".`);
    ids.add(connection.id);
    if (connection.label && (!(connection.label.requiredWidth > 0) || !(connection.label.requiredHeight > 0))) throw new GeometryLayoutError(`Geometry label for connection "${connection.id}" must have positive dimensions.`);
    for (const endpoint of [connection.source, connection.target]) {
      if (!items.some(({ id }) => id === endpoint.itemId)) throw new GeometryLayoutError(`Connection "${connection.id}" references unknown item "${endpoint.itemId}".`);
      if (endpoint.portId && portOwners.get(endpoint.portId) !== endpoint.itemId) throw new GeometryLayoutError(`Connection "${connection.id}" references a missing or foreign port "${endpoint.portId}".`);
    }
  }
}

function toElkGraph(input: GeometryInput, profile: GeometryLayoutProfile): ElkNode {
  return {
    id: "geometry-root",
    layoutOptions: profile === "conceptual" ? CONCEPTUAL_OPTIONS : ENGINE_OPTIONS,
    children: input.items.map(item => ({
      id: item.id,
      width: item.requiredWidth,
      height: item.requiredHeight,
      layoutOptions: item.ports?.length ? { "elk.portConstraints": "FIXED_POS" } : undefined,
      ports: item.ports?.map(port => ({
        id: port.id,
        width: 1,
        height: 1,
        x: port.x ?? (port.side === "EAST" ? item.requiredWidth - 1 : port.side === "WEST" ? 0 : (item.requiredWidth - 1) / 2),
        y: port.y ?? (port.side === "SOUTH" ? item.requiredHeight - 1 : port.side === "NORTH" ? 0 : (item.requiredHeight - 1) / 2),
        layoutOptions: { "elk.port.side": port.side },
      })),
    })),
    edges: input.connections.map(connection => ({
      id: connection.id,
      sources: [connection.source.portId ?? connection.source.itemId],
      targets: [connection.target.portId ?? connection.target.itemId],
      labels: connection.label ? [{ id: `${connection.id}:label`, text: connection.label.text, width: connection.label.requiredWidth, height: connection.label.requiredHeight }] : undefined,
    })),
  };
}

function fromElkGraph(input: GeometryInput, graph: ElkNode): PositionedGeometry {
  const nodes = graph.children ?? [];
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  if (nodes.length !== input.items.length || input.items.some(item => !nodeById.has(item.id))) throw new GeometryLayoutError("Layout engine returned incomplete item geometry.");
  const edges = graph.edges ?? [];
  const edgeById = new Map(edges.map(edge => [edge.id, edge]));
  const connections = input.connections.map(connection => {
    const edge = edgeById.get(connection.id);
    const section = (edge as (ElkEdge & { sections?: Array<{ startPoint: { x: number; y: number }; bendPoints?: Array<{ x: number; y: number }>; endPoint: { x: number; y: number } }> }) | undefined)?.sections?.[0];
    if (!section) throw new GeometryLayoutError(`Layout engine returned no route for connection "${connection.id}".`);
    const label = edge?.labels?.[0];
    return {
      id: connection.id,
      points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint],
      ...(connection.label && label?.x !== undefined && label.y !== undefined ? { label: { text: connection.label.text, x: label.x, y: label.y, width: label.width ?? connection.label.requiredWidth, height: label.height ?? connection.label.requiredHeight } } : {}),
    };
  });
  const items = input.items.map(item => {
    const placed = nodeById.get(item.id)!;
    if (placed.x === undefined || placed.y === undefined) throw new GeometryLayoutError(`Layout engine returned no position for item "${item.id}".`);
    return { ...item, x: placed.x, y: placed.y };
  });
  const ports = input.items.flatMap(item => (item.ports ?? []).map(port => {
    const placedItem = nodeById.get(item.id)!;
    const placedPort = placedItem.ports?.find(candidate => candidate.id === port.id);
    if (!placedPort || placedPort.x === undefined || placedPort.y === undefined) throw new GeometryLayoutError(`Layout engine returned no position for port "${port.id}".`);
    return { ...port, ownerItemId: item.id, x: (placedItem.x ?? 0) + placedPort.x, y: (placedItem.y ?? 0) + placedPort.y };
  }));
  if (graph.width === undefined || graph.height === undefined) throw new GeometryLayoutError("Layout engine returned no overall dimensions.");
  return { width: graph.width, height: graph.height, items, ports, connections };
}
