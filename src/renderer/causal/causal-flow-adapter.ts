import type { ElkEdge, ElkEdgeSection, ElkNode } from "elkjs/lib/elk-api";
import type { Edge, Node } from "@xyflow/react";
import type {
  CausalEdge,
  CausalNodeId,
  CausalViewModel,
} from "../../domain/eventflow/causal-projection";

export type CausalFlowNodeKind = "message" | "handler" | "effect" | "failure" | "retry";
export interface CausalFlowNodeData extends Record<string, unknown> {
  causalId: CausalNodeId;
  kind: CausalFlowNodeKind;
  label: string;
  sourceNodeIds: string[];
  owner?: string;
  messageKind?: "event" | "command";
  provenance?: string;
}
export interface CausalFlowEdgeData extends Record<string, unknown> {
  causalType: CausalEdge["type"];
  sourceNodeIds: string[];
  points?: Array<{ x: number; y: number }>;
}
export type CausalFlowNode = Node<CausalFlowNodeData>;
export type CausalFlowEdge = Edge<CausalFlowEdgeData>;
export interface CausalFlowGraph {
  nodes: CausalFlowNode[];
  edges: CausalFlowEdge[];
  width: number;
  height: number;
}

export const CAUSAL_ELK_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.spacing.nodeNode": "36",
  "elk.layered.spacing.nodeNodeBetweenLayers": "72",
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

  return {
    nodes: [...nodeData.values()].map((data) => {
      const size = causalNodeSize(data);
      return {
        id: data.causalId,
        type: "causal",
        position: { x: 0, y: 0 },
        width: size.width,
        height: size.height,
        data,
      };
    }),
    edges: view.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: "causal",
      data: {
        causalType: edge.type,
        sourceNodeIds: edge.sourceNodeIds,
      },
    })),
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
    })),
    edges: elements.edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };
}

export function positionedCausalFlow(view: CausalViewModel, laidOut: ElkNode): CausalFlowGraph {
  const elements = causalFlowElements(view);
  const positions = new Map((laidOut.children ?? []).map((node) => [node.id, node]));
  const routes = new Map((laidOut.edges ?? []).map((edge) => [edge.id, edgePoints(edge)]));
  return {
    nodes: elements.nodes.map((node) => {
      const placed = positions.get(node.id);
      return {
        ...node,
        position: { x: placed?.x ?? 0, y: placed?.y ?? 0 },
        width: placed?.width ?? node.width,
        height: placed?.height ?? node.height,
      };
    }),
    edges: elements.edges.map((edge) => ({
      ...edge,
      data: { causalType: edge.data?.causalType ?? "HANDLER_CAUSES_MESSAGE", sourceNodeIds: edge.data?.sourceNodeIds ?? [], points: routes.get(edge.id) },
    })),
    width: laidOut.width ?? 0,
    height: laidOut.height ?? 0,
  };
}

export function causalNodeSize(data: Pick<CausalFlowNodeData, "label" | "kind" | "owner">): { width: number; height: number } {
  const ownerText = data.owner ? 16 : 0;
  const width = Math.min(data.kind === "message" ? 260 : 230, Math.max(data.kind === "handler" ? 150 : 140, data.label.length * 7.2 + 38));
  return { width, height: Math.max(54, Math.ceil(data.label.length / Math.max(1, Math.floor(width / 8))) * 18 + 30 + ownerText) };
}

function edgePoints(edge: ElkEdge): Array<{ x: number; y: number }> | undefined {
  const section = (edge as ElkEdge & { sections?: ElkEdgeSection[] }).sections?.[0];
  return section ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint] : undefined;
}
