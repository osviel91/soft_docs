import { useEffect, useMemo, useRef, useState } from "react";
import { BaseEdge, Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, type EdgeProps, type NodeProps } from "@xyflow/react";
import { downstreamCausalNeighbors, upstreamCausalNeighbors, type CausalNodeId, type CausalViewModel } from "../../domain/eventflow/causal-projection";
import { causalElkGraph, causalNodeSize, positionedCausalFlow, type CausalFlowEdgeData, type CausalFlowGraph, type CausalFlowNode } from "./causal-flow-adapter";
import { createCausalElkLayout, type CausalWorkerFactory } from "./causal-elk-layout";
import "@xyflow/react/dist/style.css";
import "./causal-flow.css";

export interface CausalFlowViewProps {
  view: CausalViewModel;
  onNodeSelect?: (nodeId: CausalNodeId) => void;
  onSourceSelect?: (nodeId: string) => void;
  onLayoutState?: (state: "loading" | "ready" | "error") => void;
  onLayoutError?: (message: string) => void;
  workerFactory?: CausalWorkerFactory;
}

export default function CausalFlowView({ view, onNodeSelect, onSourceSelect, onLayoutState, onLayoutError, workerFactory }: CausalFlowViewProps) {
  const [graph, setGraph] = useState<CausalFlowGraph | null>(null);
  const [selected, setSelected] = useState<CausalNodeId | null>(null);
  const clientRef = useRef<ReturnType<typeof createCausalElkLayout> | null>(null);
  useEffect(() => {
    const client = createCausalElkLayout(workerFactory);
    clientRef.current = client;
    let active = true;
    setGraph(null);
    setSelected(null);
    onLayoutState?.("loading");
    void client.layout(causalElkGraph(view)).then((laidOut) => {
      if (!active) return;
      setGraph(positionedCausalFlow(view, laidOut));
      onLayoutState?.("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      onLayoutState?.("error");
      onLayoutError?.(error instanceof Error ? error.message : "Unable to lay out the causal graph.");
      setGraph({ nodes: [], edges: [], width: 0, height: 0 });
    });
    return () => { active = false; client.dispose(); };
  }, [onLayoutState, onLayoutError, view, workerFactory]);

  const highlighted = useMemo(() => {
    if (!selected) return null;
    return new Set([selected, ...upstreamCausalNeighbors(view, selected), ...downstreamCausalNeighbors(view, selected)]);
  }, [selected, view]);
  if (!graph) return <div className="causal-flow causal-flow--loading"><p className="preview__empty">Laying out causal graph...</p></div>;
  const nodes = graph.nodes.map((node) => ({ ...node, className: highlighted && !highlighted.has(node.id as CausalNodeId) ? "is-dimmed" : "", selected: node.id === selected }));
  const edges = graph.edges.map((edge) => ({ ...edge, className: highlighted && edge.source !== selected && edge.target !== selected ? "is-dimmed" : "" }));
  return <div className="causal-flow"><ReactFlowProvider><ReactFlow nodes={nodes} edges={edges} nodeTypes={{ causal: CausalNode }} edgeTypes={{ causal: CausalEdge }} fitView fitViewOptions={{ padding: 0.18 }} onNodeClick={(_, node) => {
    const id = node.id as CausalNodeId;
    setSelected(id);
    onNodeSelect?.(id);
    const source = (node.data as CausalFlowNode["data"]).sourceNodeIds[0];
    if (source) onSourceSelect?.(source);
  }}><Background gap={24} size={1} /><Controls /><MiniMap nodeColor={(node) => node.data.kind === "message" ? "#4f46e5" : node.data.kind === "handler" ? "#0f766e" : node.data.kind === "effect" ? "#b45309" : "#be123c"} /></ReactFlow></ReactFlowProvider></div>;
}

function CausalNode({ data }: NodeProps<CausalFlowNode>) {
  const size = causalNodeSize(data);
  return <div className={`causal-node causal-node--${data.kind}`} style={{ width: size.width, minHeight: size.height }}><Handle type="target" position={Position.Left} /><span className="causal-node__kind">{data.kind}{data.messageKind ? ` · ${data.messageKind}` : ""}</span><strong>{data.label}</strong>{data.owner && <small>owned by {data.owner.replace("handler:", "")}</small>}<Handle type="source" position={Position.Right} /></div>;
}

function CausalEdge({ id, data }: EdgeProps) {
  const edgeData = data as CausalFlowEdgeData | undefined;
  const points = edgeData?.points;
  if (!points || points.length < 2) return null;
  const path = `M ${points.map((point) => `${point.x} ${point.y}`).join(" L ")}`;
  const dashed = edgeData?.causalType === "HANDLER_HAS_EFFECT" || edgeData?.causalType === "FAILURE_RETRIED" || edgeData?.causalType?.startsWith("RETRY_");
  return <BaseEdge id={id} path={path} style={{ stroke: edgeColor(edgeData?.causalType), strokeWidth: 2, strokeDasharray: dashed ? "5 4" : undefined }} markerEnd="url(#react-flow__arrowclosed)" />;
}

function edgeColor(type?: string): string { return type === "HANDLER_HAS_EFFECT" ? "#b45309" : type === "ENTITY_FAILED" || type === "FAILURE_RETRIED" || type?.startsWith("RETRY_") ? "#be123c" : "#64748b"; }
