import { useEffect, useMemo, useRef, useState } from "react";
import { BaseEdge, Background, ControlButton, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow, type EdgeProps, type NodeProps } from "@xyflow/react";
import { type CausalNodeId, type CausalViewModel } from "../../domain/eventflow/causal-projection";
import { parseNodeId } from "../../domain/diagram/node-id";
import { CAUSAL_PORT_SIZE, causalElkGraph, causalNodeSize, causalReachability, positionedCausalFlow, type CausalFlowEdge, type CausalFlowEdgeData, type CausalFlowGraph, type CausalFlowNode } from "./causal-flow-adapter";
import { createCausalElkLayout, type CausalWorkerFactory } from "./causal-elk-layout";
import "@xyflow/react/dist/style.css";
import "./causal-flow.css";

const READING_ZOOM = 1;
const INITIAL_MIN_ZOOM = 0.8;
const FIT_PADDING = 0.18;

export interface CausalFlowViewProps {
  view: CausalViewModel;
  selectedNodeId?: CausalNodeId | null;
  onNodeSelect?: (nodeId: CausalNodeId | null) => void;
  onSourceSelect?: (nodeId: string) => void;
  onLayoutState?: (state: "loading" | "ready" | "error") => void;
  onLayoutError?: (message: string) => void;
  workerFactory?: CausalWorkerFactory;
}

export default function CausalFlowView({ view, selectedNodeId = null, onNodeSelect, onSourceSelect, onLayoutState, onLayoutError, workerFactory }: CausalFlowViewProps) {
  const flowContainerRef = useRef<HTMLDivElement | null>(null);
  const [graph, setGraph] = useState<CausalFlowGraph | null>(null);
  const [selected, setSelected] = useState<CausalNodeId | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  useEffect(() => {
    const client = createCausalElkLayout(workerFactory);
    let active = true;
    setGraph(null);
    setSelected(null);
    setSelectedEdgeId(null);
    onLayoutState?.("loading");
    void client.layout(causalElkGraph(view)).then((laidOut) => {
      if (!active) return;
      setGraph(positionedCausalFlow(view, laidOut));
      onLayoutState?.("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      onLayoutState?.("error");
      onLayoutError?.(error instanceof Error ? error.message : "Unable to lay out the causal graph.");
      setGraph({ nodes: [], edges: [], width: 0, height: 0, layoutWarnings: [] });
    });
    return () => { active = false; client.dispose(); };
  }, [onLayoutState, onLayoutError, view, workerFactory]);

  useEffect(() => { setSelected(selectedNodeId); setSelectedEdgeId(null); }, [selectedNodeId]);

  const highlighted = useMemo(() => selected ? causalReachability(view, selected) : null, [selected, view]);
  if (!graph) return <div className="causal-flow causal-flow--loading"><p className="preview__empty">Laying out causal graph...</p></div>;
  const selectedEdge = graph.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const nodeLabels = new Map(graph.nodes.map((node) => [node.id, node.data.label]));
  const selectedEdgeNodes = selectedEdge ? new Set([selectedEdge.source, selectedEdge.target]) : null;
  const nodes = graph.nodes.map((node) => ({ ...node, className: selectedEdgeNodes && !selectedEdgeNodes.has(node.id) || highlighted && !highlighted.nodeIds.has(node.id as CausalNodeId) ? "is-dimmed" : "", selected: node.id === selected }));
  const edges = graph.edges.map((edge) => ({
    ...edge,
    className: selectedEdgeId
      ? edge.id === selectedEdgeId ? "is-selected" : "is-dimmed"
      : highlighted && !highlighted.edgeIds.has(edge.id) ? "is-dimmed" : "",
    selected: edge.id === selectedEdgeId,
    ariaLabel: `${edge.data?.causalType ?? "Causal relation"}: ${nodeLabels.get(edge.source) ?? edge.source} to ${nodeLabels.get(edge.target) ?? edge.target}`,
  }));
  const edgeSourceIds = selectedEdge?.data?.sourceNodeIds ?? [];
  const sourceSpans = edgeSourceIds.map((id) => ({ id, location: parseNodeId(id) })).filter((item) => item.location);
  return <div className="causal-flow" ref={flowContainerRef}>
    {graph.layoutWarnings.length > 0 && <div className="causal-flow__warning" role="status">
      {graph.layoutWarnings.length} causal route{graph.layoutWarnings.length === 1 ? "" : "s"} failed validation. Dashed direct fallbacks are used only when both ports are available.
      <details><summary>Route diagnostics</summary><ul>{graph.layoutWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>
    </div>}
    {selectedEdge && <aside className="causal-flow__edge-details" data-testid="causal-edge-details" aria-label="Selected causal relation">
      <strong>{selectedEdge.data?.causalType.replaceAll("_", " ")}</strong>
      <p>{nodeLabels.get(selectedEdge.source) ?? selectedEdge.source} to {nodeLabels.get(selectedEdge.target) ?? selectedEdge.target}</p>
      {selectedEdge.data?.routeWarning && <small>{selectedEdge.data.routeWarning}</small>}
      {sourceSpans.length ? <ul>{sourceSpans.map(({ id, location }) => <li key={id}><button type="button" onClick={() => onSourceSelect?.(id)}>Source line {location!.line + 1}</button></li>)}</ul> : <small>Source location unavailable.</small>}
    </aside>}
    <ReactFlowProvider><ReactFlow nodes={nodes} edges={edges} nodeTypes={{ causal: CausalNode }} edgeTypes={{ causal: CausalEdge }} fitView fitViewOptions={{ padding: FIT_PADDING, minZoom: INITIAL_MIN_ZOOM, maxZoom: READING_ZOOM }} onNodeClick={(_, node) => {
      const id = node.id as CausalNodeId;
      setSelected(id);
      setSelectedEdgeId(null);
      onNodeSelect?.(id);
      const source = (node.data as CausalFlowNode["data"]).sourceNodeIds[0];
      if (source) onSourceSelect?.(source);
    }} onEdgeClick={(_, edge) => { setSelected(null); setSelectedEdgeId(edge.id); onNodeSelect?.(null); }} onPaneClick={() => { setSelected(null); setSelectedEdgeId(null); onNodeSelect?.(null); }}>
      <Background gap={24} size={1} />
      <Controls aria-label="Causal graph navigation" showFitView={false}>
        <CausalViewportControls flowContainerRef={flowContainerRef} />
      </Controls>
      <MiniMap nodeColor={(node) => node.data.kind === "message" ? "#4f46e5" : node.data.kind === "handler" ? "#0f766e" : node.data.kind === "effect" ? "#b45309" : "#be123c"} />
    </ReactFlow></ReactFlowProvider>
  </div>;
}

function CausalViewportControls({ flowContainerRef }: { flowContainerRef: { current: HTMLDivElement | null } }) {
  const { fitView, screenToFlowPosition, setCenter } = useReactFlow<CausalFlowNode, CausalFlowEdge>();
  const previousReadingCenter = useRef<{ x: number; y: number } | null>(null);
  const viewportCenter = () => {
    const bounds = flowContainerRef.current?.querySelector(".react-flow")?.getBoundingClientRect();
    return bounds && bounds.width > 0 && bounds.height > 0
      ? screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
      : null;
  };
  const showOverview = () => {
    previousReadingCenter.current = viewportCenter();
    void fitView({ padding: FIT_PADDING, minZoom: 0.1, maxZoom: READING_ZOOM });
  };
  const restoreReadingScale = () => {
    const center = previousReadingCenter.current ?? viewportCenter();
    previousReadingCenter.current = null;
    if (!center) return;
    void setCenter(center.x, center.y, { zoom: READING_ZOOM, duration: 180 });
  };

  return <>
    <ControlButton className="causal-flow__view-control" aria-label="Show full graph overview" title="Show full graph overview" onClick={showOverview}>All</ControlButton>
    <ControlButton className="causal-flow__view-control" aria-label="Restore reading scale" title="Restore reading scale" onClick={restoreReadingScale}>Read</ControlButton>
  </>;
}

function CausalNode({ data }: NodeProps<CausalFlowNode>) {
  const size = causalNodeSize(data);
  return <div className={`causal-node causal-node--${data.kind}`} style={{ width: size.width, height: size.height }}>
    {(data.ports ?? []).map((port) => <Handle key={port.id} id={port.id} type={port.side === "WEST" ? "target" : "source"} position={port.side === "WEST" ? Position.Left : Position.Right} style={{ ...(port.top === undefined ? {} : { top: port.top }), width: CAUSAL_PORT_SIZE, height: CAUSAL_PORT_SIZE, border: 0, background: "transparent", ...(port.side === "WEST" ? { left: -CAUSAL_PORT_SIZE } : { right: -CAUSAL_PORT_SIZE }) }} />)}
    <span className="causal-node__kind">{data.kind}{data.messageKind ? ` · ${data.messageKind}` : ""}</span>
    <strong className="causal-node__label" style={{ fontSize: size.labelFontSize, lineHeight: 1.25 }} aria-label={data.label} title={data.label}>
      {(data.labelLines ?? [data.label]).map((line, index) => <span key={index} aria-hidden="true">{line}</span>)}
    </strong>
    {data.owner && <small style={{ fontSize: size.ownerFontSize, lineHeight: 1.3 }} aria-label={`owned by ${data.owner.replace("handler:", "")}`} title={`owned by ${data.owner.replace("handler:", "")}`}>
      {(data.ownerLines ?? [`owned by ${data.owner.replace("handler:", "")}`]).map((line, index) => <span key={index} aria-hidden="true">{line}</span>)}
    </small>}
  </div>;
}

function CausalEdge({ id, data, selected }: EdgeProps) {
  const edgeData = data as CausalFlowEdgeData | undefined;
  const routes = edgeData?.routes ?? [];
  if (!routes.length) return null;
  const dashed = edgeData?.causalType === "HANDLER_HAS_EFFECT" || edgeData?.causalType === "FAILURE_RETRIED" || edgeData?.causalType?.startsWith("RETRY_");
  return <>{routes.map((route, index) => {
    if (route.points.length < 2) return null;
    const path = `M ${route.points.map((point) => `${point.x} ${point.y}`).join(" L ")}`;
    return <BaseEdge key={route.id} id={`${id}-${index}`} path={path} interactionWidth={20} className={route.fallback ? "causal-edge--fallback" : undefined} style={{ stroke: selected ? "#0f172a" : route.fallback ? "#7c3aed" : edgeColor(edgeData?.causalType), strokeWidth: selected ? 4 : 2, strokeDasharray: route.fallback ? "3 3" : dashed ? "5 4" : undefined }} markerEnd={route.endsAtTarget ? "url(#react-flow__arrowclosed)" : undefined} />;
  })}</>;
}

function edgeColor(type?: string): string { return type === "HANDLER_HAS_EFFECT" ? "#b45309" : type === "ENTITY_FAILED" || type === "FAILURE_RETRIED" || type?.startsWith("RETRY_") ? "#be123c" : "#64748b"; }
