import { useEffect, useMemo, useState } from "react";
import type { DiagramFile } from "../../domain/workspace/types";
import type { ProjectIndex } from "../../domain/project/project-index";
import type { TraceDirection, TraceQueryStart } from "../../domain/project/architecture-trace";
import { analyzeEventFlow } from "../../language/eventflow/parser";
import { resourceRepresentationOfName } from "../../domain/workspace/resource-id";
import { diagramDisplayName } from "../../language/diagram-title";
import Preview from "./Preview";
import EventFlowPreview, { type EventFlowView } from "./EventFlowPreview";
import SemanticMessageInspector from "./SemanticMessageInspector";
import TraceExplorer from "./TraceExplorer";
import { useDiagram } from "./use-diagram";
import { semanticComparison, type ComparisonOccurrence, type ComparisonPane as ComparisonPaneId, type SemanticComparison } from "./semantic-comparison";
import { crossContextAnalysis, type AnalysisOptions, type CrossContextAnalysis } from "./cross-context-analysis";
import type { ResourceRelationship } from "../../domain/workspace/resource-relationship";

export interface ComparisonViewProps {
  primary: DiagramFile;
  primarySource: string;
  diagrams: DiagramFile[];
  index: ProjectIndex | null;
  resourceIdForFile: (file: DiagramFile) => string | null;
  onExit: () => void;
  onOpenResource: (resourceId: string, nodeId?: string) => void;
  maximizedPane: "a" | "b" | null;
  onMaximize: (pane: "a" | "b") => void;
  onRestore: () => void;
  relationships?: ResourceRelationship[];
  editorHidden: boolean;
  onToggleEditor: () => void;
}

type Pane = "a" | "b";

interface Session {
  resource: DiagramFile;
  source: string;
  representation: "sequence" | "event-flow";
}

function resourceLabel(file: DiagramFile): string {
  return `${diagramDisplayName(file.name, file.source)} · ${file.name}`;
}

function ComparisonPane({
  pane,
  session,
  index,
  resourceIdForFile,
  maximized,
  onMaximize,
  onRestore,
  onOpenResource,
  comparison,
  counterpartMessageId,
  selectedMessageId,
  onSelectIdentity,
  focusOccurrence,
  onFocusOccurrence,
}: {
  pane: Pane;
  session: Session;
  index: ProjectIndex | null;
  resourceIdForFile: (file: DiagramFile) => string | null;
  maximized: boolean;
  onMaximize: () => void;
  onRestore: () => void;
  onOpenResource: (resourceId: string, nodeId?: string) => void;
  comparison: SemanticComparison;
  counterpartMessageId: string | null;
  selectedMessageId: string | null;
  onSelectIdentity: (messageId: string) => void;
  focusOccurrence: ComparisonOccurrence | null;
  onFocusOccurrence: (occurrence: ComparisonOccurrence) => void;
}) {
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [activeSemanticMessageId, setActiveSemanticMessageId] = useState<string | null>(null);
  const [traceStart, setTraceStart] = useState<TraceQueryStart | null>(null);
  const [traceDirection, setTraceDirection] = useState<TraceDirection>("both");
  const [eventFlowView, setEventFlowView] = useState<EventFlowView>("flow");
  const flow = useMemo(
    () => session.representation === "event-flow" ? analyzeEventFlow(session.source).flow : null,
    [session.representation, session.source],
  );
  const { ast: sequence } = useDiagram(
    session.representation === "sequence" ? session.source : "",
  );
  const resourceId = resourceIdForFile(session.resource);

  useEffect(() => {
    setActiveNodeId(null);
    setActiveSemanticMessageId(null);
    setTraceStart(null);
  }, [session.resource.id, session.source]);

  useEffect(() => {
    if (focusOccurrence?.resourceId !== resourceId) return;
    setActiveNodeId(focusOccurrence.nodeId);
    setActiveSemanticMessageId(focusOccurrence.messageId ?? null);
  }, [focusOccurrence, resourceId]);

  const selectNode = (nodeId: string) => {
    setActiveNodeId(nodeId);
    setActiveSemanticMessageId(null);
  };
  const selectIdentity = (messageId: string, nodeId: string | null) => {
    setActiveSemanticMessageId(messageId);
    onSelectIdentity(messageId);
    if (nodeId) setActiveNodeId(nodeId);
  };
  const selectOccurrence = (name: string, nodeId: string | null) => {
    if (nodeId) setActiveNodeId(nodeId);
    if (resourceId && name) setTraceStart({ resourceId, name });
  };
  const openTrace = (start: TraceQueryStart, direction: TraceDirection) => {
    setTraceStart(start);
    setTraceDirection(direction);
  };

  return (
    <section className={`comparison__pane${maximized ? " comparison__pane--maximized" : ""}`} aria-label={`Viewer ${pane.toUpperCase()}`} data-testid={`comparison-pane-${pane}`}>
      <header className="comparison__header">
        <div>
          <strong>Viewer {pane.toUpperCase()}</strong>
          <h2>{diagramDisplayName(session.resource.name, session.source)}</h2>
          <span>{session.resource.name} · {session.representation === "event-flow" ? "Event Flow" : "Sequence diagram"}</span>
          {session.resource.metadata?.description ? <p>{session.resource.metadata.description}</p> : null}
          {session.resource.metadata?.tags?.length ? <div className="comparison__tags" aria-label="Resource tags">{session.resource.metadata.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
        </div>
        <button type="button" className="icon-button" aria-label={maximized ? `Restore Viewer ${pane.toUpperCase()}` : `Maximize Viewer ${pane.toUpperCase()}`} onClick={maximized ? onRestore : onMaximize}>{maximized ? "⊡" : "⤢"}</button>
      </header>
      <div className="comparison__viewer">
        {session.representation === "event-flow" ? (
          <EventFlowPreview
            source={session.source}
            flow={flow}
            view={eventFlowView}
            onViewChange={setEventFlowView}
            onNodeSelect={selectNode}
            onSemanticMessageSelect={selectIdentity}
            onSemanticOccurrenceSelect={selectOccurrence}
            activeNodeId={activeNodeId}
            activeSemanticMessageId={activeSemanticMessageId ?? selectedMessageId ?? counterpartMessageId}
          />
        ) : (
          <Preview
            source={session.source}
            onNodeSelect={selectNode}
            onSemanticMessageSelect={selectIdentity}
            onSemanticOccurrenceSelect={selectOccurrence}
            activeNodeId={activeNodeId}
            activeSemanticMessageId={activeSemanticMessageId ?? selectedMessageId ?? counterpartMessageId}
          />
        )}
      </div>
      <SemanticMessageInspector
        index={index}
        sequence={session.representation === "sequence" ? sequence : null}
        eventFlow={flow}
        activeResourceId={resourceId}
        activeNodeId={activeNodeId}
        activeSemanticMessageId={activeSemanticMessageId}
        onOpenResource={onOpenResource}
        onTrace={openTrace}
        counterpartResourceId={counterpartMessageId ? (pane === "a" ? comparison.occurrences.b[0]?.resourceId : comparison.occurrences.a[0]?.resourceId) ?? null : null}
        counterpartOccurrences={activeSemanticMessageId ? (pane === "a" ? comparison.occurrences.b : comparison.occurrences.a).filter((entry) => entry.messageId === activeSemanticMessageId) : []}
        onFocusOccurrence={onFocusOccurrence}
      />
      {traceStart && index ? <TraceExplorer index={index} start={traceStart} direction={traceDirection} onClose={() => setTraceStart(null)} onOpenResource={onOpenResource} /> : null}
    </section>
  );
}

export default function ComparisonView({
  primary,
  primarySource,
  diagrams,
  index,
  resourceIdForFile,
  onExit,
  onOpenResource,
  maximizedPane,
  onMaximize,
  onRestore,
  relationships = [],
  editorHidden,
  onToggleEditor,
}: ComparisonViewProps) {
  const [primaryId, setPrimaryId] = useState(primary.id);
  const [secondaryId, setSecondaryId] = useState<string | null>(() => diagrams.find((diagram) => diagram.id !== primary.id)?.id ?? null);
  const primaryResource = diagrams.find((diagram) => diagram.id === primaryId) ?? (primaryId === primary.id ? primary : null);
  const secondary = diagrams.find((diagram) => diagram.id === secondaryId) ?? null;
  useEffect(() => {
    if (!primaryResource) setPrimaryId(primary.id);
    if (secondaryId === primaryId || secondaryId === null) {
      setSecondaryId(diagrams.find((diagram) => diagram.id !== primaryId)?.id ?? null);
    }
  }, [diagrams, primary.id, primaryId, primaryResource, secondaryId]);

  const sourceFor = (diagram: DiagramFile) => diagram.id === primary.id ? primarySource : diagram.source;
  const primarySession = primaryResource ? {
    resource: primaryResource,
    source: sourceFor(primaryResource),
    representation: resourceRepresentationOfName(primaryResource.name) === "event-flow" ? "event-flow" : "sequence",
  } satisfies Session : null;
  const secondarySession = secondary ? {
    resource: secondary,
    source: sourceFor(secondary),
    representation: resourceRepresentationOfName(secondary.name) === "event-flow" ? "event-flow" : "sequence",
  } satisfies Session : null;
  const comparison = useMemo(
    () => semanticComparison(index, primarySession ? resourceIdForFile(primarySession.resource) : null, secondary ? resourceIdForFile(secondary) : null, relationships),
    [index, primarySession?.resource.id, secondary?.id, resourceIdForFile, relationships],
  );
  const [selected, setSelected] = useState<{ pane: ComparisonPaneId; messageId: string } | null>(null);
  const [focused, setFocused] = useState<ComparisonOccurrence | null>(null);
  const [analysisOptions, setAnalysisOptions] = useState<AnalysisOptions>({ direction: "both", maxDepth: 8, maxNodes: 120, includeCandidates: false, includeRecovery: false });
  const analysis = useMemo<CrossContextAnalysis>(() => crossContextAnalysis(
    { index: index ?? emptyIndex, resourceId: primarySession ? resourceIdForFile(primarySession.resource) : null, sessionId: "a" },
    { index: index ?? emptyIndex, resourceId: secondary ? resourceIdForFile(secondary) : null, sessionId: "b" },
    comparison,
    selected ? { messageId: selected.messageId } : null,
    analysisOptions,
    relationships,
  ), [index, primarySession?.resource.id, secondary?.id, resourceIdForFile, comparison, selected?.messageId, analysisOptions, relationships]);
  const selectedCounterparts = selected
    ? (selected.pane === "a" ? comparison.occurrences.b : comparison.occurrences.a).filter((entry) => entry.messageId === selected.messageId)
    : [];
  const focusNext = (direction: 1 | -1) => {
    if (!selected || selectedCounterparts.length === 0) return;
    const current = selectedCounterparts.findIndex((entry) => entry.nodeId === focused?.nodeId);
    const next = selectedCounterparts[(current + direction + selectedCounterparts.length) % selectedCounterparts.length];
    setFocused(next);
  };
  useEffect(() => {
    if (selected && !comparison.identities.has(selected.messageId)) setSelected(null);
    if (focused && !comparison.occurrences.a.concat(comparison.occurrences.b).some((entry) => entry.nodeId === focused.nodeId)) setFocused(null);
  }, [comparison, focused, selected]);
  const inspectIdentity = (pane: ComparisonPaneId, messageId: string) => {
    setSelected({ pane, messageId });
    setFocused(comparison.occurrences[pane].find((entry) => entry.messageId === messageId) ?? null);
  };
  const swapViewers = () => {
    if (!primarySession || !secondary) return;
    setPrimaryId(secondary.id);
    setSecondaryId(primarySession.resource.id);
    setSelected((current) => current ? { ...current, pane: current.pane === "a" ? "b" : "a" } : null);
  };

  return (
    <div className={`comparison${maximizedPane ? " comparison--maximized" : ""}`} data-testid="comparison-view">
      <header className="comparison__toolbar">
        <strong>Compare diagrams</strong>
        <label>Viewer A <select aria-label="Viewer A resource" value={primaryId} onChange={(event) => setPrimaryId(event.target.value)}>
          {diagrams.filter((diagram) => diagram.id !== secondaryId).map((diagram) => <option key={diagram.id} value={diagram.id}>{resourceLabel(diagram)}</option>)}
        </select></label>
        <label>Viewer B <select aria-label="Viewer B resource" value={secondaryId ?? ""} onChange={(event) => setSecondaryId(event.target.value || null)}>
          <option value="">Select a diagram</option>
          {diagrams.filter((diagram) => diagram.id !== primaryId).map((diagram) => <option key={diagram.id} value={diagram.id}>{resourceLabel(diagram)}</option>)}
        </select></label>
        <button type="button" className="button button--ghost" onClick={swapViewers} disabled={!secondarySession}>Swap viewers</button>
        <button type="button" className="button button--ghost" onClick={onToggleEditor}>{editorHidden ? "Show editor" : "Hide editor"}</button>
        <button type="button" className="button button--ghost" onClick={onExit}>Close comparison</button>
      </header>
      <ComparisonSummary comparison={comparison} analysis={analysis} selected={selected} onSelect={inspectIdentity} onFocus={setFocused} onStep={focusNext} onOpenResource={onOpenResource} options={analysisOptions} onOptionsChange={setAnalysisOptions} resourceNames={{ a: primarySession?.resource.name ?? "Viewer A", b: secondary?.name ?? "Viewer B" }} />
      <div className="comparison__panes">
        <div className={maximizedPane === "b" ? "comparison__slot comparison__slot--hidden" : "comparison__slot"}>
          {primarySession ? <ComparisonPane pane="a" session={primarySession} index={index} resourceIdForFile={resourceIdForFile} maximized={maximizedPane === "a"} onMaximize={() => onMaximize("a")} onRestore={onRestore} onOpenResource={onOpenResource} comparison={comparison} selectedMessageId={selected?.pane === "a" ? selected.messageId : null} counterpartMessageId={selected?.pane === "b" ? selected.messageId : null} onSelectIdentity={(messageId) => { setSelected({ pane: "a", messageId }); setFocused(null); }} focusOccurrence={focused} onFocusOccurrence={setFocused} /> : null}
        </div>
        {secondarySession ? <div className={maximizedPane === "a" ? "comparison__slot comparison__slot--hidden" : "comparison__slot"}><ComparisonPane pane="b" session={secondarySession} index={index} resourceIdForFile={resourceIdForFile} maximized={maximizedPane === "b"} onMaximize={() => onMaximize("b")} onRestore={onRestore} onOpenResource={onOpenResource} comparison={comparison} selectedMessageId={selected?.pane === "b" ? selected.messageId : null} counterpartMessageId={selected?.pane === "a" ? selected.messageId : null} onSelectIdentity={(messageId) => { setSelected({ pane: "b", messageId }); setFocused(null); }} focusOccurrence={focused} onFocusOccurrence={setFocused} /></div> : <div className="comparison__empty">{secondaryId ? `Viewer B resource ${secondaryId} is no longer available.` : "Choose a second diagram to compare."}</div>}
      </div>
    </div>
  );
}

const emptyIndex = { projectId: "", resources: [], diagrams: [], eventFlows: [], documents: [], participants: [], usages: [], references: [], diagnostics: [] } satisfies ProjectIndex;

function ComparisonSummary({ comparison, analysis, selected, onSelect, onFocus, onStep, onOpenResource, options, onOptionsChange, resourceNames }: { comparison: SemanticComparison; analysis: CrossContextAnalysis; selected: { pane: ComparisonPaneId; messageId: string } | null; onSelect: (pane: ComparisonPaneId, id: string) => void; onFocus: (occurrence: ComparisonOccurrence) => void; onStep: (direction: 1 | -1) => void; onOpenResource: (resourceId: string, nodeId?: string) => void; options: AnalysisOptions; onOptionsChange: (options: AnalysisOptions) => void; resourceNames: Record<ComparisonPaneId, string> }) {
  const groups = [
    ["Shared", comparison.shared, "both", `${resourceNames.a} + ${resourceNames.b}`],
    ["Documented only in A", comparison.onlyA, "a", resourceNames.a],
    ["Documented only in B", comparison.onlyB, "b", resourceNames.b],
  ] as const;
  return <aside className="comparison__summary" aria-label="Architectural analysis summary" data-testid="semantic-comparison-summary">
    <div className="comparison__counts">{groups.map(([label, identities]) => <span key={label}>{label}: <strong>{identities.length}</strong></span>)}<span>Unresolved: <strong>{new Set(comparison.candidates.map((entry) => `${entry.kind}:${entry.name}`)).size}</strong></span></div>
    {comparison.relationship ? <p className="comparison__relationship">Complementary view: {comparison.relationship.sourceRole ?? "other"} ↔ {comparison.relationship.targetRole ?? "other"}</p> : null}
    <section className="comparison__analysis" aria-label="Architectural Analysis" data-testid="architectural-analysis">
      <h3>Architectural Analysis</h3>
      {!analysis.anchor && !analysis.staleAnchor ? <p>Select an authoritative semantic identity to anchor a bounded trace.</p> : <>
        {analysis.staleAnchor ? <p role="alert">The analysis anchor is no longer available.</p> : null}
        {analysis.anchor ? <>
        <p>Anchor: <strong>{comparison.identities.get(analysis.anchor.messageId)?.name ?? "stale identity"}</strong></p>
        <div className="comparison__analysis-controls">
          <label>Direction <select aria-label="Analysis direction" value={options.direction} onChange={(event) => onOptionsChange({ ...options, direction: event.target.value as AnalysisOptions["direction"] })}><option value="upstream">Upstream</option><option value="downstream">Downstream</option><option value="both">Both</option></select></label>
          <label><input type="checkbox" checked={options.includeCandidates} onChange={(event) => onOptionsChange({ ...options, includeCandidates: event.target.checked })} /> Candidates</label>
          <label><input type="checkbox" checked={options.includeRecovery} onChange={(event) => onOptionsChange({ ...options, includeRecovery: event.target.checked })} /> Recovery</label>
        </div>
        <div className="comparison__analysis-counts" aria-label="Analysis counts">
          <span>Shared messages: <strong>{analysis.semanticConnections.length}</strong></span>
          <span>Documented only in A: <strong>{analysis.documentedOnlyA.length}</strong></span>
          <span>Documented only in B: <strong>{analysis.documentedOnlyB.length}</strong></span>
          <span>Unknown boundaries A/B: <strong>{analysis.sides.a.unknownBoundaries.length}/{analysis.sides.b.unknownBoundaries.length}</strong></span>
          <span>Recovery A/B: <strong>{analysis.sides.a.recovery}/{analysis.sides.b.recovery}</strong></span>
        </div>
        {analysis.explicitRelationships.length ? <p className="comparison__relationship">Explicit relationship: {analysis.explicitRelationships.map((relationship) => `${relationship.kind} (${relationship.sourceRole ?? "other"} ↔ ${relationship.targetRole ?? "other"})`).join(", ")}</p> : <p>Explicit relationships: none</p>}
        {analysis.sides.a.effects.length || analysis.sides.b.effects.length ? <p>Effects documented A/B: {analysis.sides.a.effects.length}/{analysis.sides.b.effects.length}</p> : null}
        {analysis.sides.a.effects.length && !analysis.sides.b.effects.length ? <p>Effect documented only in A.</p> : null}
        {analysis.sides.b.effects.length && !analysis.sides.a.effects.length ? <p>Effect documented only in B.</p> : null}
        {analysis.sides.a.cycles || analysis.sides.b.cycles ? <p>Cycle references A/B: {analysis.sides.a.cycles}/{analysis.sides.b.cycles}</p> : null}
        </> : null}
      </>}
      {analysis.candidates.length ? <p className="comparison__candidate">Candidates remain non-authoritative: {analysis.candidates.length}</p> : null}
      {analysis.sides.a.unknownBoundaries.concat(analysis.sides.b.unknownBoundaries).slice(0, 4).map((node) => <button type="button" className="comparison__analysis-item" key={`${node.id}:${node.source?.resourceId}`} onClick={() => node.source && onOpenResource(node.source.resourceId, node.source.nodeId)}>{node.label} · unknown boundary</button>)}
    </section>
    {groups.map(([label, identities, pane, resourceName]) => <section className="comparison__group" key={label} data-testid={`semantic-group-${label.toLowerCase().replaceAll(" ", "-").replace("documented-only-in-", "only-")}`}><h3>{label} <small>{resourceName}</small></h3>{identities.map((identity) => {
      const matchedA = comparison.occurrences.a.filter((entry) => entry.messageId === identity.id).length;
      const matchedB = comparison.occurrences.b.filter((entry) => entry.messageId === identity.id).length;
      const matched = pane === "both" ? matchedA + matchedB : pane === "a" ? matchedA : matchedB;
      return <div className="comparison__identity" key={identity.id}><button type="button" aria-label={`Inspect ${identity.kind} ${identity.name}`} onClick={() => onSelect(pane === "both" ? "a" : pane, identity.id)}>{identity.name} <small>{identity.kind} · {pane === "both" ? `A ${matchedA} · B ${matchedB}` : `${matched} occurrence${matched === 1 ? "" : "s"}`}</small></button>{selected?.messageId === identity.id && pane === "both" ? <div className="comparison__sync-actions" aria-label={`Synchronization actions for ${identity.name}`}><button type="button" onClick={() => { const occurrence = comparison.occurrences[selected.pane === "a" ? "b" : "a"].find((entry) => entry.messageId === identity.id); if (occurrence) onFocus(occurrence); }}>Focus matching occurrence</button><button type="button" onClick={() => onStep(-1)} disabled={matched < 2}>Previous</button><button type="button" onClick={() => onStep(1)} disabled={matched < 2}>Next</button></div> : null}</div>;
    })}</section>)}
    <section className="comparison__group comparison__group--unresolved" data-testid="semantic-group-unresolved"><h3>Unresolved <small>Names are candidates only</small></h3>{[...new Set(comparison.candidates.map((entry) => `${entry.kind} ${entry.name}`))].map((candidate) => <span className="comparison__candidate" key={candidate}>{candidate}</span>)}</section>
  </aside>;
}
