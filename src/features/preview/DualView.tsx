import { useEffect, useMemo, useState } from "react";
import type { ComparisonOption } from "./ComparisonView";
import { analyzeEventFlow } from "../../language/eventflow/parser";
import { resourceRepresentationOfName, type ResourceRepresentation } from "../../domain/workspace/resource-id";
import { diagramDisplayName } from "../../language/diagram-title";
import { noteDisplayName } from "../../language/markdown/note-title";
import Preview from "./Preview";
import EventFlowPreview, { type EventFlowView } from "./EventFlowPreview";
import ConceptualPreview from "./ConceptualPreview";
import DatabasePreview from "./DatabasePreview";
import MarkdownView from "../notes/MarkdownView";
import { analysisProvenanceLabel } from "../../domain/workspace/knowledge-context";

type Session = { option: ComparisonOption; source: string; representation: ResourceRepresentation };

function DualPane({ session, pane }: { session: Session; pane: "a" | "b" }) {
  const { option, source, representation } = session;
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [eventView, setEventView] = useState<EventFlowView>("flow");
  const flow = useMemo(() => representation === "event-flow" ? analyzeEventFlow(source).flow : null, [representation, source]);
  useEffect(() => setActiveNodeId(null), [option.id, source]);
  const name = "markdown" in option.resource
    ? noteDisplayName(option.resource.name, source)
    : diagramDisplayName(option.resource.name, source);
  const provenance = analysisProvenanceLabel(option.context.knowledgeContext.kind === "private-work"
    ? { kind: "private-work", id: option.context.knowledgeContext.id, label: option.context.knowledgeContext.name }
    : { kind: option.context.knowledgeContext.kind, id: option.context.knowledgeContext.id });

  return <section className="comparison__pane" aria-label={`Dual viewer ${pane.toUpperCase()}`} data-testid={`dual-pane-${pane}`}>
    <header className="comparison__header"><div><strong>Viewer {pane.toUpperCase()}</strong><span className="comparison__provenance">{provenance}</span><h2>{name}</h2><span>{option.resource.name}</span></div></header>
    <div className="comparison__viewer">
      {representation === "markdown" ? <MarkdownView markdown={source} />
        : representation === "conceptual" ? <ConceptualPreview source={source} onNodeSelect={setActiveNodeId} />
          : representation === "database" ? <DatabasePreview source={source} onNodeSelect={setActiveNodeId} />
            : representation === "event-flow" ? <EventFlowPreview source={source} flow={flow} view={eventView} onViewChange={setEventView} onNodeSelect={setActiveNodeId} activeNodeId={activeNodeId} />
              : <Preview source={source} onNodeSelect={setActiveNodeId} activeNodeId={activeNodeId} />}
    </div>
  </section>;
}

export default function DualView({ options, initialOptionId, projectId, onExit, focusMode = false, onToggleFocus = () => {}, fullscreen = false, onToggleFullscreen = () => {}, fullscreenError = false, rootRef }: {
  options: ComparisonOption[];
  initialOptionId?: string;
  projectId: string;
  onExit: () => void;
  focusMode?: boolean;
  onToggleFocus?: () => void;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  fullscreenError?: boolean;
  rootRef?: (node: HTMLDivElement | null) => void;
}) {
  const first = options.find(option => option.id === initialOptionId) ?? options[0];
  const [ids, setIds] = useState<[string, string]>(() => [first?.id ?? "", options.find(option => option.id !== first?.id)?.id ?? ""]);
  useEffect(() => {
    setIds(([a, b]) => {
      const nextA = options.some(option => option.id === a) ? a : (options.find(option => option.id === initialOptionId)?.id ?? options[0]?.id ?? "");
      const nextB = options.some(option => option.id === b && option.id !== nextA) ? b : (options.find(option => option.id !== nextA)?.id ?? "");
      return a === nextA && b === nextB ? [a, b] : [nextA, nextB];
    });
  }, [options, initialOptionId, projectId]);
  const a = options.find(option => option.id === ids[0]);
  const b = options.find(option => option.id === ids[1]);
  const swap = () => setIds(([left, right]) => [right, left]);
  const select = (pane: 0 | 1, id: string) => setIds(current => pane === 0 ? [id, current[1]] : [current[0], id]);
  return <div ref={rootRef} className={`comparison dual-view${focusMode ? " dual-view--focus" : ""}`} data-testid="dual-view" aria-hidden={false}>
    <header className="comparison__toolbar"><strong>Dual View · {projectId}</strong>
      <button type="button" className="button button--ghost button--small" aria-pressed={focusMode} onClick={onToggleFocus}>{focusMode ? "Exit Focus" : "Focus"}</button>
      <button type="button" className="button button--ghost button--small" aria-pressed={fullscreen} title={fullscreenError ? "Fullscreen unavailable" : undefined} onClick={onToggleFullscreen}>{fullscreen ? "Exit fullscreen" : "Fullscreen"}</button>
      <label>Viewer A <select aria-label="Dual View A resource" value={a?.id ?? ""} onChange={event => select(0, event.target.value)}>{options.filter(option => option.id !== b?.id).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      <label>Viewer B <select aria-label="Dual View B resource" value={b?.id ?? ""} onChange={event => select(1, event.target.value)}><option value="">Select a resource</option>{options.filter(option => option.id !== a?.id).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      <button type="button" className="icon-button" aria-label="Swap dual viewers" onClick={swap} disabled={!a || !b}>⇄</button>
      <button type="button" className="icon-button" aria-label="Close Dual View" onClick={onExit}>×</button>
    </header>
    <div className="comparison__content"><div className="comparison__panes">
      {a ? <div className="comparison__slot" key={a.id}><DualPane key={a.id} session={{ option: a, source: a.source, representation: a.representation ?? resourceRepresentationOfName(a.resource.name) }} pane="a" /></div> : <div className="comparison__empty">Select a resource for Viewer A.</div>}
      {b ? <div className="comparison__slot" key={b.id}><DualPane key={b.id} session={{ option: b, source: b.source, representation: b.representation ?? resourceRepresentationOfName(b.resource.name) }} pane="b" /></div> : <div className="comparison__empty">Select a resource for Viewer B.</div>}
    </div></div>
  </div>;
}
