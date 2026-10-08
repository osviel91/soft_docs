import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { TraceDirection, TraceQueryStart } from "../../domain/project/architecture-trace";
import type { ProjectIndex } from "../../domain/project/project-index";
import TraceExplorer from "./TraceExplorer";
import type { AnalysisProvenance } from "../../domain/workspace/knowledge-context";

interface Props {
  index: ProjectIndex;
  start: TraceQueryStart;
  direction: TraceDirection;
  provenance: string;
  contextProvenance?: AnalysisProvenance;
  onOpenResource: (resourceId: string, nodeId?: string) => void;
  embedded?: boolean;
  onClose?: () => void;
}

type SurfaceMode = "minimized" | "normal" | "expanded";
const MIN_HEIGHT = 180;
const MIN_VIEWER_HEIGHT = 220;

function startKey(start: TraceQueryStart): string {
  return "messageId" in start ? `message:${start.messageId}` : `occurrence:${start.resourceId}:${start.name}:${start.step ?? ""}`;
}

export default function TraceSurface({ index, start, direction, provenance, contextProvenance, onOpenResource, embedded = false, onClose }: Props) {
  const surfaceRef = useRef<HTMLElement | null>(null);
  const [mode, setMode] = useState<SurfaceMode>("normal");
  const [height, setHeight] = useState(420);
  const [resizing, setResizing] = useState(false);
  const traceKey = startKey(start);

  useEffect(() => setMode("normal"), [traceKey]);

  const resize = (clientY: number) => {
    const parent = surfaceRef.current?.parentElement;
    if (!parent) return;
    const bounds = parent.getBoundingClientRect();
    const maximum = Math.max(MIN_HEIGHT, bounds.height - MIN_VIEWER_HEIGHT);
    setHeight(Math.min(maximum, Math.max(MIN_HEIGHT, bounds.bottom - clientY)));
  };
  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setResizing(false);
  };
  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const delta = event.key === "ArrowUp" ? 32 : -32;
    setHeight((current) => {
      const parent = surfaceRef.current?.parentElement;
      const maximum = parent ? Math.max(MIN_HEIGHT, parent.getBoundingClientRect().height - MIN_VIEWER_HEIGHT) : current;
      return Math.min(maximum, Math.max(MIN_HEIGHT, current + delta));
    });
  };

  return (
    <section ref={surfaceRef} className={`trace-surface trace-surface--${mode}${embedded ? " trace-surface--embedded" : ""}`} style={!embedded && mode === "normal" ? { flexBasis: height } : undefined} aria-label="Architectural Trace analysis surface" data-testid="trace-surface" data-provenance={provenance}>
      {!embedded && mode !== "minimized" ? <div className="trace-surface__splitter" role="separator" tabIndex={0} aria-label="Resize Architectural Trace" aria-orientation="horizontal" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setResizing(true); resize(event.clientY); }} onPointerMove={(event) => { if (resizing) resize(event.clientY); }} onPointerUp={endResize} onPointerCancel={endResize} onKeyDown={resizeWithKeyboard} /> : null}
      {!embedded ? <div className="trace-surface__toolbar">
        <span><strong>Architectural Trace</strong> · launched from {provenance}</span>
        <div>
          <button type="button" className="button button--ghost button--small" onClick={() => setMode(mode === "expanded" ? "normal" : "expanded")} aria-label={mode === "expanded" ? "Restore Architectural Trace" : "Maximize Architectural Trace"}>{mode === "expanded" ? "Restore" : "Expand"}</button>
          <button type="button" className="button button--ghost button--small" onClick={() => setMode(mode === "minimized" ? "normal" : "minimized")} aria-label={mode === "minimized" ? "Restore Architectural Trace" : "Minimize Architectural Trace"}>{mode === "minimized" ? "Restore" : "Minimize"}</button>
        </div>
      </div> : null}
      <div className="trace-surface__content"><TraceExplorer index={index} start={start} direction={direction} provenance={contextProvenance} onClose={onClose ?? (() => setMode("minimized"))} onOpenResource={onOpenResource} /></div>
    </section>
  );
}
