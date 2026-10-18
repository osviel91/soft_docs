import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DiagramFile, NoteFile } from "../../domain/workspace/types";
import type { ProjectIndex } from "../../domain/project/project-index";
import type { TraceDirection, TraceQueryStart } from "../../domain/project/architecture-trace";
import { analyzeEventFlow } from "../../language/eventflow/parser";
import { resourceRepresentationOfName, resourceRepresentationOfType, type ResourceRepresentation } from "../../domain/workspace/resource-id";
import { diagramDisplayName } from "../../language/diagram-title";
import { noteDisplayName } from "../../language/markdown/note-title";
import Preview from "./Preview";
import EventFlowPreview, { type EventFlowView } from "./EventFlowPreview";
import ConceptualPreview from "./ConceptualPreview";
import DatabasePreview from "./DatabasePreview";
import MarkdownView from "../notes/MarkdownView";
import { diffResources, type ResourceDiff, type SemanticChange } from "../../domain/diff/resource-diff";
import { SourceDiffView } from "../diff/SourceDiffView";
import SemanticMessageInspector from "./SemanticMessageInspector";
import TraceSurface from "./TraceSurface";
import { useDiagram } from "./use-diagram";
import { semanticComparisonAcrossContexts, type ComparisonOccurrence, type ComparisonPane as ComparisonPaneId, type SemanticComparison } from "./semantic-comparison";
import { crossContextAnalysis, type AnalysisOptions, type CrossContextAnalysis } from "./cross-context-analysis";
import type { ResourceRelationship } from "../../domain/workspace/resource-relationship";
import type { AnalysisContext } from "./cross-context-analysis";
import { analysisProvenanceLabel, type KnowledgeContext } from "../../domain/workspace/knowledge-context";
import type { ServerApiClient, ServerProject, ServerResourceRevision, ServerResourceRevisionSummary, ServerResourceType, ServerWorkspace } from "../../workspace/server/api-client";
import type { UiPreferences } from "../../workspace/ui-preferences";

export interface ComparisonViewProps {
  primary: ComparisonResource;
  primarySource: string;
  resources: ComparisonResource[];
  index: ProjectIndex | null;
  resourceIdForFile: (file: ComparisonResource) => string | null;
  onExit: () => void;
  onOpenResource: (resourceId: string, nodeId?: string) => void;
  maximizedPane: "a" | "b" | null;
  onMaximize: (pane: "a" | "b") => void;
  onRestore: () => void;
  maximized: boolean;
  onToggleMaximize: () => void;
  activeProjectId?: string | null;
  activeProjectName?: string | null;
  serverProjects?: ServerProject[];
  serverWorkspaces?: ServerWorkspace[];
  selectedServerWorkspaceId?: string | null;
  onSelectServerWorkspace?: (workspaceId: string) => void;
  onOpenServerProject?: (project: ServerProject) => void;
  relationships?: ResourceRelationship[];
  analysisContexts?: AnalysisContext[];
  comparisonOptions?: ComparisonOption[];
  primaryOptionId?: string;
  revisionClient?: Pick<ServerApiClient, "listResourceRevisions" | "getResourceRevision">;
  revisionResource?: RevisionComparisonResource | null;
  layoutPreferences?: UiPreferences["screens"]["comparison"];
  onLayoutPreferenceChange?: (patch: Partial<UiPreferences["screens"]["comparison"]>) => void;
}

export interface ComparisonOption {
  id: string;
  resource: ComparisonResource;
  resourceId: string;
  representation: ResourceRepresentation;
  source: string;
  context: AnalysisContext;
  label: string;
}

export type ComparisonResource = DiagramFile | NoteFile;

export interface RevisionComparisonResource {
  projectId: string;
  resourceId: string;
  contextId: string | null;
  path: string;
  type: ServerResourceType;
}

type Pane = "a" | "b";

interface Session {
  resource: ComparisonResource;
  resourceId: string | null;
  source: string;
  representation: ResourceRepresentation;
}

function sourceOf(resource: ComparisonResource): string {
  return "markdown" in resource ? resource.markdown : resource.source;
}

function displayName(resource: ComparisonResource, source: string): string {
  return "markdown" in resource
    ? noteDisplayName(resource.name, source)
    : diagramDisplayName(resource.name, source);
}

function representationLabel(representation: ResourceRepresentation): string {
  switch (representation) {
    case "event-flow": return "Event Flow";
    case "conceptual": return "Conceptual";
    case "database": return "Database";
    case "markdown": return "Markdown note";
    default: return "Sequence diagram";
  }
}

function isMessageRepresentation(representation: ResourceRepresentation): boolean {
  return representation === "sequence" || representation === "event-flow";
}

function resourceLabel(resource: ComparisonResource): string {
  return `${displayName(resource, sourceOf(resource))} · ${resource.name}`;
}

function ComparisonPane({
  pane,
  session,
  context,
  index,
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
  onTrace,
}: {
  pane: Pane;
  session: Session;
  context?: AnalysisContext;
  index: ProjectIndex | null;
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
  onTrace: (start: TraceQueryStart, direction: TraceDirection, pane: Pane) => void;
}) {
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [activeSemanticMessageId, setActiveSemanticMessageId] = useState<string | null>(null);
  const [eventFlowView, setEventFlowView] = useState<EventFlowView>("flow");
  const flow = useMemo(
    () => session.representation === "event-flow" ? analyzeEventFlow(session.source).flow : null,
    [session.representation, session.source],
  );
  const { ast: sequence } = useDiagram(
    session.representation === "sequence" ? session.source : "",
  );
  const resourceId = session.resourceId;

  useEffect(() => {
    setActiveNodeId(null);
    setActiveSemanticMessageId(null);
  }, [session.resource.id, session.source]);

  useEffect(() => {
    if (focusOccurrence?.resourceId !== resourceId) return;
    setActiveNodeId(focusOccurrence.nodeId);
    setActiveSemanticMessageId(focusOccurrence.messageId ?? null);
  }, [focusOccurrence, resourceId]);

  const selectNode = (nodeId: string | null) => {
    if (nodeId === null) {
      setActiveNodeId(null);
      setActiveSemanticMessageId(null);
      return;
    }
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
    if (resourceId && name) onTrace({ resourceId, name }, "both", pane);
  };

  return (
    <section className={`comparison__pane${maximized ? " comparison__pane--maximized" : ""}`} aria-label={`Viewer ${pane.toUpperCase()}`} data-testid={`comparison-pane-${pane}`}>
      <header className="comparison__header">
        <div>
          <strong>Viewer {pane.toUpperCase()}</strong>
          {context ? <span className="comparison__provenance">{analysisProvenanceLabel(context.knowledgeContext.kind === "private-work" ? { kind: "private-work", id: context.knowledgeContext.id, label: context.knowledgeContext.name } : { kind: context.knowledgeContext.kind, id: context.knowledgeContext.id })}</span> : null}
          <h2>{displayName(session.resource, session.source)}</h2>
          <span>{session.resource.name} · {representationLabel(session.representation)}</span>
          {session.resource.metadata?.description ? <p>{session.resource.metadata.description}</p> : null}
          {session.resource.metadata?.tags?.length ? <div className="comparison__tags" aria-label="Resource tags">{session.resource.metadata.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
        </div>
        <button type="button" className="icon-button" aria-label={maximized ? `Restore Viewer ${pane.toUpperCase()}` : `Maximize Viewer ${pane.toUpperCase()}`} onClick={maximized ? onRestore : onMaximize}>{maximized ? "⊡" : "⤢"}</button>
      </header>
      <div className="comparison__viewer">
        {session.representation === "markdown" ? (
          <MarkdownView markdown={session.source} />
        ) : session.representation === "conceptual" ? (
          <ConceptualPreview source={session.source} onNodeSelect={selectNode} comparisonMode />
        ) : session.representation === "database" ? (
          <DatabasePreview source={session.source} onNodeSelect={selectNode} comparisonMode />
        ) : session.representation === "event-flow" ? (
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
            comparisonMode
          />
        ) : (
          <Preview
            source={session.source}
            onNodeSelect={selectNode}
            onSemanticMessageSelect={selectIdentity}
            onSemanticOccurrenceSelect={selectOccurrence}
            activeNodeId={activeNodeId}
            activeSemanticMessageId={activeSemanticMessageId ?? selectedMessageId ?? counterpartMessageId}
            comparisonMode
          />
        )}
      </div>
      {isMessageRepresentation(session.representation) ? <SemanticMessageInspector
        index={index}
        sequence={session.representation === "sequence" ? sequence : null}
        eventFlow={flow}
        activeResourceId={resourceId}
        activeNodeId={activeNodeId}
        activeSemanticMessageId={activeSemanticMessageId}
        onOpenResource={onOpenResource}
        onTrace={(start, direction) => onTrace(start, direction, pane)}
        counterpartResourceId={counterpartMessageId ? (pane === "a" ? comparison.occurrences.b[0]?.resourceId : comparison.occurrences.a[0]?.resourceId) ?? null : null}
        counterpartOccurrences={activeSemanticMessageId ? (pane === "a" ? comparison.occurrences.b : comparison.occurrences.a).filter((entry) => entry.messageId === activeSemanticMessageId) : []}
        onFocusOccurrence={onFocusOccurrence}
      /> : null}
    </section>
  );
}

export default function ComparisonView({
  primary,
  primarySource,
  resources,
  index,
  resourceIdForFile,
  onExit,
  onOpenResource,
  maximizedPane,
  onMaximize,
  onRestore,
  maximized,
  onToggleMaximize,
  activeProjectId = null,
  activeProjectName = null,
  serverProjects = [],
  serverWorkspaces = [],
  selectedServerWorkspaceId = null,
  onSelectServerWorkspace,
  onOpenServerProject,
  relationships = [],
  analysisContexts = [],
  comparisonOptions,
  primaryOptionId,
  revisionClient,
  revisionResource = null,
  layoutPreferences,
  onLayoutPreferenceChange,
}: ComparisonViewProps) {
  const comparisonRef = useRef<HTMLDivElement | null>(null);
  const summaryRef = useRef<HTMLElement | null>(null);
  const [localSummaryHeight, setLocalSummaryHeight] = useState<number | null>(null);
  const summaryHeight = layoutPreferences ? layoutPreferences.summaryHeight : localSummaryHeight;
  const setSummaryHeight = (height: number | null) => {
    if (!layoutPreferences) setLocalSummaryHeight(height);
    onLayoutPreferenceChange?.({ summaryHeight: height });
  };
  const [comparisonHeight, setComparisonHeight] = useState(0);
  const [resizingSummary, setResizingSummary] = useState(false);
  const [revisionMode, setRevisionMode] = useState(false);
  const sharedContext: KnowledgeContext = { kind: "shared", id: `shared:${primary.projectId}`, projectId: primary.projectId };
  const localContext: AnalysisContext["knowledgeContext"] = { kind: "local", id: `local:${primary.projectId}`, projectId: primary.projectId };
  const fallbackContext: AnalysisContext["knowledgeContext"] = activeProjectId ? sharedContext : localContext;
  const choices: ComparisonOption[] = comparisonOptions ?? resources.map((resource) => {
    const resourceId = resourceIdForFile(resource) ?? resource.id;
    return {
      id: resource.id,
      resource,
      label: resourceLabel(resource),
      resourceId,
      representation: resourceRepresentationOfName(resource.name),
      source: sourceOf(resource),
      context: { projectId: primary.projectId, knowledgeContext: fallbackContext, index: index ?? emptyIndex, resourceId },
    };
  });
  const [primaryId, setPrimaryId] = useState(primaryOptionId ?? primary.id);
  const [secondaryId, setSecondaryId] = useState<string | null>(() => choices.find((option) => option.id !== (primaryOptionId ?? primary.id))?.id ?? null);
  const primaryOption = choices.find((option) => option.id === primaryId);
  const secondaryOption = choices.find((option) => option.id === secondaryId);
  const primaryResource = primaryOption?.resource ?? (primaryId === primary.id ? primary : null);
  const secondary = secondaryOption?.resource ?? null;
  const contextFor = (resourceId: string | null): AnalysisContext | undefined => analysisContexts.find((context) => context.resourceId === resourceId);
  const contextOrShared = (resourceId: string | null, fallbackIndex: ProjectIndex | null, sessionId: string): AnalysisContext =>
    contextFor(resourceId) ?? { projectId: primary.projectId, knowledgeContext: fallbackContext, index: fallbackIndex ?? emptyIndex, resourceId, sessionId };
  const primaryContext = primaryOption?.context ?? contextOrShared(primaryResource ? resourceIdForFile(primaryResource) : null, index, "a");
  const secondaryContext = secondaryOption?.context ?? contextOrShared(secondary ? resourceIdForFile(secondary) : null, index, "b");
  useEffect(() => {
    if (!primaryResource) setPrimaryId(primaryOptionId ?? primary.id);
    if (secondaryId === primaryId || secondaryId === null) {
      setSecondaryId(choices.find((option) => option.id !== primaryId)?.id ?? null);
    }
  }, [choices, primaryOptionId, primary.id, primaryId, primaryResource, secondaryId]);

  const sourceFor = (optionId: string | null | undefined, optionSource: string) => optionId === (primaryOptionId ?? primary.id) ? primarySource : optionSource;
  const primarySession = primaryResource ? {
    resource: primaryResource,
    resourceId: primaryOption?.resourceId ?? resourceIdForFile(primaryResource),
    source: sourceFor(primaryOption?.id, primaryOption?.source ?? sourceOf(primaryResource)),
    representation: primaryOption?.representation ?? resourceRepresentationOfName(primaryResource.name),
  } satisfies Session : null;
  const secondarySession = secondary ? {
    resource: secondary,
    resourceId: secondaryOption?.resourceId ?? resourceIdForFile(secondary),
    source: sourceFor(secondaryOption?.id, secondaryOption?.source ?? sourceOf(secondary)),
    representation: secondaryOption?.representation ?? resourceRepresentationOfName(secondary.name),
  } satisfies Session : null;
  const semanticComparisonSupported = Boolean(
    primarySession && secondarySession &&
    isMessageRepresentation(primarySession.representation) &&
    isMessageRepresentation(secondarySession.representation),
  );
  const markdownComparisonSupported = Boolean(
    primarySession?.representation === "markdown" && secondarySession?.representation === "markdown",
  );
  const comparison = useMemo(
    () => semanticComparisonSupported ? semanticComparisonAcrossContexts(primaryContext, secondaryContext, relationships) : emptySemanticComparison,
    [index, primaryContext, secondaryContext, primarySession?.resource.id, secondary?.id, resourceIdForFile, relationships, semanticComparisonSupported],
  );
  const [selected, setSelected] = useState<{ pane: ComparisonPaneId; messageId: string } | null>(null);
  const [focused, setFocused] = useState<ComparisonOccurrence | null>(null);
  const [trace, setTrace] = useState<{ start: TraceQueryStart; direction: TraceDirection; pane: Pane } | null>(null);
  const [analysisOptions, setAnalysisOptions] = useState<AnalysisOptions>({ direction: "both", maxDepth: 8, maxNodes: 120, includeCandidates: false, includeRecovery: false });
  useLayoutEffect(() => {
    const root = comparisonRef.current;
    if (!root) return;
    const measure = () => setComparisonHeight(root.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  const analysis = useMemo<CrossContextAnalysis | null>(() => semanticComparisonSupported ? crossContextAnalysis(
    primaryContext,
    secondaryContext,
    comparison,
    selected ? { messageId: selected.messageId } : null,
    analysisOptions,
    relationships,
  ) : null, [index, primary.projectId, primaryContext, secondaryContext, primarySession?.resource.id, secondary?.id, resourceIdForFile, comparison, semanticComparisonSupported, selected?.messageId, analysisOptions, relationships]);
  const markdownDiff = useMemo(() => markdownComparisonSupported && primarySession && secondarySession
    ? diffResources(
        { content: primarySession.source, type: "markdown-document" },
        { content: secondarySession.source, type: "markdown-document" },
      ).source
    : null,
  [markdownComparisonSupported, primarySession?.source, secondarySession?.source]);
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
    setPrimaryId(secondaryId!);
    setSecondaryId(primaryId);
    setSelected((current) => current ? { ...current, pane: current.pane === "a" ? "b" : "a" } : null);
  };
  const openTrace = (start: TraceQueryStart, direction: TraceDirection, pane: Pane) => setTrace({ start, direction, pane });
  const resizeSummary = (clientY: number) => {
    const root = comparisonRef.current?.getBoundingClientRect();
    const summary = summaryRef.current?.getBoundingClientRect();
    if (!root || !summary) return;
    const minimum = 180;
    const maximum = Math.max(minimum, root.bottom - summary.top - 260);
    setSummaryHeight(Math.min(maximum, Math.max(minimum, clientY - summary.top)));
  };
  const resizeSummaryWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const current = summaryHeight ?? summaryRef.current?.getBoundingClientRect().height ?? 320;
    const root = comparisonRef.current?.getBoundingClientRect();
    const summary = summaryRef.current?.getBoundingClientRect();
    const maximum = root && summary ? Math.max(180, root.bottom - summary.top - 260) : Number.POSITIVE_INFINITY;
    setSummaryHeight(Math.min(maximum, Math.max(180, current + (event.key === "ArrowUp" ? 32 : -32))));
  };

  const effectiveSummaryHeight = summaryHeight === null || comparisonHeight <= 0
    ? null
    : Math.min(summaryHeight, Math.max(180, comparisonHeight - 260));

  const canCompareRevisions = Boolean(
    revisionClient && revisionResource &&
    (revisionResource.type === "conceptual" || revisionResource.type === "database"),
  );

  return (
    <div ref={comparisonRef} className={`comparison${maximizedPane ? " comparison--maximized" : ""}`} data-testid="comparison-view">
      <header className="comparison__toolbar">
        <strong>{revisionMode ? "Compare revisions" : "Compare resources"}</strong>
        {serverWorkspaces.length > 0 && onSelectServerWorkspace ? <label>Workspace <select aria-label="Comparison workspace" value={selectedServerWorkspaceId ?? ""} onChange={(event) => onSelectServerWorkspace(event.target.value)}>
          {serverWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select></label> : null}
        {onOpenServerProject ? <label>Project <select aria-label="Comparison project" value={activeProjectId ?? ""} onChange={(event) => {
          const project = serverProjects.find((item) => item.id === event.target.value);
          if (project) onOpenServerProject(project);
        }}>
          {activeProjectName && !serverProjects.some((project) => project.id === activeProjectId) ? <option value={activeProjectId ?? ""}>{activeProjectName}</option> : null}
          {serverProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select></label> : null}
        {!revisionMode ? <>
        <label>Viewer A <select aria-label="Viewer A resource" value={primaryId} onChange={(event) => setPrimaryId(event.target.value)}>
          {choices.filter((option) => option.id !== secondaryId).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select></label>
        <label>Viewer B <select aria-label="Viewer B resource" value={secondaryId ?? ""} onChange={(event) => setSecondaryId(event.target.value || null)}>
          <option value="">Select a resource</option>
          {choices.filter((option) => option.id !== primaryId).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select></label>
         <button type="button" className="icon-button" onClick={swapViewers} disabled={!secondarySession} title="Swap viewers" aria-label="Swap viewers">⇄</button>
        </> : <span>{revisionResource?.path ?? "Selected resource"}</span>}
        {!revisionMode && canCompareRevisions ? <button type="button" className="button button--small" onClick={() => setRevisionMode(true)} aria-label="Compare revisions">Compare revisions</button> : null}
        {revisionMode ? <button type="button" className="button button--small" onClick={() => setRevisionMode(false)} aria-label="Return to parallel views">Parallel views</button> : null}
          <button type="button" className="icon-button" onClick={onToggleMaximize} title={maximized ? "Restore comparison" : "Maximize comparison"} aria-label={maximized ? "Restore comparison" : "Maximize comparison"}>{maximized ? "⊡" : "⤢"}</button>
         <button type="button" className="icon-button" onClick={onExit} title="Close comparison" aria-label="Close comparison">×</button>
      </header>
      {revisionMode ? canCompareRevisions && revisionResource && revisionClient ? <HistoricalRevisionComparison
        key={`${revisionResource.projectId}:${revisionResource.contextId ?? "shared"}:${revisionResource.resourceId}`}
        client={revisionClient}
        resource={revisionResource}
        maximizedPane={maximizedPane}
        onMaximize={onMaximize}
        onRestore={onRestore}
      /> : <p role="status">Revision comparison is unavailable for this resource.</p> : <>
        <section ref={summaryRef} className="comparison__summary" aria-label={semanticComparisonSupported ? "Architectural analysis summary" : "Resource comparison"} data-testid={semanticComparisonSupported ? "semantic-comparison-summary" : "resource-comparison-summary"} style={effectiveSummaryHeight === null ? undefined : { flexBasis: effectiveSummaryHeight }}>
         {semanticComparisonSupported && analysis ? <ComparisonSummary comparison={comparison} analysis={analysis} selected={selected} onSelect={inspectIdentity} onFocus={setFocused} onStep={focusNext} onOpenResource={onOpenResource} options={analysisOptions} onOptionsChange={setAnalysisOptions} resourceNames={{ a: primarySession?.resource.name ?? "Viewer A", b: secondary?.name ?? "Viewer B" }} />
           : !secondarySession ? <p>Select a second resource to compare.</p>
             : markdownDiff ? <section className="comparison__markdown-diff" data-testid="comparison-markdown-diff"><h2>Markdown text diff</h2><p>Textual source comparison only; this does not assert an architectural change.</p><SourceDiffView source={markdownDiff} beforeContent={primarySession!.source} afterContent={secondarySession.source} mode="side-by-side" beforeLabel={primarySession!.resource.name} afterLabel={secondarySession.resource.name} /></section>
               : <section className="comparison__parallel-notice" role="status" data-testid="comparison-parallel-view-notice"><h2>Parallel views · no diff calculated</h2><p>{primarySession?.representation === secondarySession.representation ? `${representationLabel(primarySession.representation)} structural diff is not available in this comparison.` : `${representationLabel(primarySession!.representation)} and ${representationLabel(secondarySession.representation)} are different representations; no compatible diff is calculated.`}</p></section>}
       </section>
       <div
         className="comparison__summary-splitter"
         role="separator"
         tabIndex={0}
         aria-label="Resize architectural analysis panel"
         aria-orientation="horizontal"
         onKeyDown={resizeSummaryWithKeyboard}
         onPointerDown={(event) => {
           event.currentTarget.setPointerCapture(event.pointerId);
           setResizingSummary(true);
           resizeSummary(event.clientY);
         }}
         onPointerMove={(event) => { if (resizingSummary) resizeSummary(event.clientY); }}
         onPointerUp={(event) => {
           if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
           setResizingSummary(false);
         }}
         onPointerCancel={() => setResizingSummary(false)}
       />
       <div className="comparison__content">
      <div className="comparison__panes">
        <div className={maximizedPane === "b" ? "comparison__slot comparison__slot--hidden" : "comparison__slot"}>
           {primarySession ? <ComparisonPane pane="a" session={primarySession} context={primaryContext} index={primaryContext.index} maximized={maximizedPane === "a"} onMaximize={() => onMaximize("a")} onRestore={onRestore} onOpenResource={onOpenResource} comparison={comparison} selectedMessageId={selected?.pane === "a" ? selected.messageId : null} counterpartMessageId={selected?.pane === "b" ? selected.messageId : null} onSelectIdentity={(messageId) => { setSelected({ pane: "a", messageId }); setFocused(null); }} focusOccurrence={focused} onFocusOccurrence={setFocused} onTrace={openTrace} /> : null}
        </div>
           {secondarySession ? <div className={maximizedPane === "a" ? "comparison__slot comparison__slot--hidden" : "comparison__slot"}><ComparisonPane pane="b" session={secondarySession} context={secondaryContext} index={secondaryContext.index} maximized={maximizedPane === "b"} onMaximize={() => onMaximize("b")} onRestore={onRestore} onOpenResource={onOpenResource} comparison={comparison} selectedMessageId={selected?.pane === "b" ? selected.messageId : null} counterpartMessageId={selected?.pane === "a" ? selected.messageId : null} onSelectIdentity={(messageId) => { setSelected({ pane: "b", messageId }); setFocused(null); }} focusOccurrence={focused} onFocusOccurrence={setFocused} onTrace={openTrace} /></div> : <div className="comparison__empty">{secondaryId ? `Viewer B resource ${secondaryId} is no longer available.` : "Choose a second diagram to compare."}</div>}
      </div>
        {trace && index ? <TraceSurface
          index={(trace.pane === "a" ? primaryContext.index : secondaryContext.index)}
          start={trace.start}
          direction={trace.direction}
          provenance={`Viewer ${trace.pane.toUpperCase()}`}
          contextProvenance={trace.pane === "a" ? traceProvenance(primaryContext) : traceProvenance(secondaryContext)}
          onOpenResource={onOpenResource}
          preferredHeight={layoutPreferences?.traceHeight}
          preferredMode={layoutPreferences?.traceMode}
          onLayoutPreferenceChange={(patch) => onLayoutPreferenceChange?.({ ...(patch.height === undefined ? {} : { traceHeight: patch.height }), ...(patch.mode === undefined ? {} : { traceMode: patch.mode }) })}
        /> : null}
      </div>
      </>}
    </div>
  );
}

function HistoricalRevisionComparison({ client, resource, maximizedPane, onMaximize, onRestore }: {
  client: Pick<ServerApiClient, "listResourceRevisions" | "getResourceRevision">;
  resource: RevisionComparisonResource;
  maximizedPane: "a" | "b" | null;
  onMaximize: (pane: "a" | "b") => void;
  onRestore: () => void;
}) {
  const [revisions, setRevisions] = useState<ServerResourceRevisionSummary[]>([]);
  const [revisionA, setRevisionA] = useState<number | null>(null);
  const [revisionB, setRevisionB] = useState<number | null>(null);
  const [snapshotA, setSnapshotA] = useState<ServerResourceRevision | null>(null);
  const [snapshotB, setSnapshotB] = useState<ServerResourceRevision | null>(null);
  const [loadedPair, setLoadedPair] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const pairKey = revisionA === null || revisionB === null ? null : `${revisionA}:${revisionB}`;

  useEffect(() => {
    let active = true;
    setListLoading(true);
    setListError(null);
    setRevisions([]);
    setRevisionA(null);
    setRevisionB(null);
    void client.listResourceRevisions(resource.projectId, resource.resourceId, resource.contextId).then((result) => {
      if (!active) return;
      if (result.some((entry) => !summaryMatchesResource(entry, resource))) {
        setListError("The revision list did not match the selected project, resource and context.");
        return;
      }
      const ordered = [...result].sort((a, b) => a.revision - b.revision);
      setRevisions(ordered);
      setRevisionA(ordered.at(-2)?.revision ?? ordered.at(-1)?.revision ?? null);
      setRevisionB(ordered.at(-1)?.revision ?? null);
    }).catch((error: unknown) => {
      if (active) setListError(error instanceof Error ? error.message : "Could not list resource revisions.");
    }).finally(() => {
      if (active) setListLoading(false);
    });
    return () => { active = false; };
  }, [client, resource.projectId, resource.resourceId, resource.contextId, retry]);

  useEffect(() => {
    let active = true;
    setSnapshotA(null);
    setSnapshotB(null);
    setLoadedPair(null);
    setSnapshotError(null);
    if (revisionA === null || revisionB === null) {
      setSnapshotsLoading(false);
      return () => { active = false; };
    }
    const requestedPair = `${revisionA}:${revisionB}`;
    setSnapshotsLoading(true);
    void Promise.all([
      client.getResourceRevision(resource.projectId, resource.resourceId, resource.contextId, revisionA),
      client.getResourceRevision(resource.projectId, resource.resourceId, resource.contextId, revisionB),
    ]).then(([a, b]) => {
      if (!active) return;
      if (!snapshotMatchesResource(a, resource, revisionA) || !snapshotMatchesResource(b, resource, revisionB)) {
        setSnapshotError("A revision snapshot did not match the selected project, resource, context and revision.");
        return;
      }
      setSnapshotA(a);
      setSnapshotB(b);
      setLoadedPair(requestedPair);
    }).catch((error: unknown) => {
      if (active) setSnapshotError(error instanceof Error ? error.message : "Could not load the selected revisions.");
    }).finally(() => {
      if (active) setSnapshotsLoading(false);
    });
    return () => { active = false; };
  }, [client, resource.projectId, resource.resourceId, resource.contextId, revisionA, revisionB, retry]);

  const snapshotsReady = loadedPair === pairKey && snapshotA !== null && snapshotB !== null;
  const sameRepresentation = snapshotsReady && snapshotA.type === snapshotB.type && (snapshotA.type === "conceptual" || snapshotA.type === "database");
  const diff = useMemo<ResourceDiff | null>(() => {
    if (!snapshotsReady || !sameRepresentation || !snapshotA || !snapshotB) return null;
    return diffResources(
      { content: snapshotA.content, type: snapshotA.type, ...(snapshotA.metadata === undefined ? {} : { metadata: snapshotA.metadata }) },
      { content: snapshotB.content, type: snapshotB.type, ...(snapshotB.metadata === undefined ? {} : { metadata: snapshotB.metadata }) },
    );
  }, [snapshotsReady, sameRepresentation, snapshotA, snapshotB]);

  return <>
    <section className="comparison__summary" aria-label="Structural revision comparison" data-testid="revision-structural-diff">
      <header className="proposal-inspector__header">
        <div><p className="governance-eyebrow">FIXED RESOURCE · {resource.contextId === null ? "SHARED" : "MY WORK"}</p><h2>{resource.path}</h2></div>
        <div className="comparison__analysis-controls">
          <label>Revision A <select aria-label="Revision A" value={revisionA ?? ""} disabled={listLoading || revisions.length === 0} onChange={(event) => setRevisionA(Number(event.target.value))}>
            {revisions.map((entry) => <option key={entry.revision} value={entry.revision}>r{entry.revision} · {entry.type} · {new Date(entry.createdAt).toLocaleString()}</option>)}
          </select></label>
          <label>Revision B <select aria-label="Revision B" value={revisionB ?? ""} disabled={listLoading || revisions.length === 0} onChange={(event) => setRevisionB(Number(event.target.value))}>
            {revisions.map((entry) => <option key={entry.revision} value={entry.revision}>r{entry.revision} · {entry.type} · {new Date(entry.createdAt).toLocaleString()}</option>)}
          </select></label>
          {listError || snapshotError ? <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button> : null}
        </div>
      </header>
      {listLoading ? <p role="status">Loading resource revisions…</p> : listError ? <p role="alert">{listError}</p> : revisions.length === 0 ? <p role="status">No revisions are available for this resource.</p> : null}
      {snapshotsLoading ? <p role="status">Loading selected snapshots…</p> : snapshotError ? <p role="alert">{snapshotError}</p> : null}
      {snapshotsReady && snapshotA && snapshotB && !sameRepresentation ? <p role="status">The selected revisions have incompatible representations; no structural diff was calculated.</p> : null}
      {diff ? <RevisionDiffSummary diff={diff} /> : null}
      {diff?.content.available === false ? <section aria-label="Revision diagnostics"><h3>Validation diagnostics</h3><ul>{diff.content.diagnostics.map((diagnostic, index) => <li key={index}>{diagnosticMessage(diagnostic)}</li>)}</ul></section> : null}
      {diff?.content.changes.length ? <section aria-label="Structural changes"><h3>Changes</h3><ul>{diff.content.changes.map((change, index) => <li key={`${change.entity}:${change.identity}:${index}`} className={`comparison__revision-change comparison__revision-change--${change.kind}`}>
        <strong>{change.kind}</strong> {change.entity} · {change.identity}
      </li>)}</ul></section> : null}
      {diff?.metadata.changes.length ? <section aria-label="Metadata changes"><h3>Metadata changes</h3><ul>{diff.metadata.changes.map((change, index) => <li key={`${change.field}:${change.identity}:${index}`}><strong>{change.kind}</strong> {change.field} · {change.identity}</li>)}</ul></section> : null}
    </section>
    <div className="comparison__content"><div className="comparison__panes">
      <div className={maximizedPane === "b" ? "comparison__slot comparison__slot--hidden" : "comparison__slot"}>
        {snapshotsReady && snapshotA ? <RevisionPreviewPane pane="a" snapshot={snapshotA} reviewChanges={diff?.content.available ? diff.content.changes : []} reviewSide="base" maximized={maximizedPane === "a"} onMaximize={() => onMaximize("a")} onRestore={onRestore} /> : <div className="comparison__empty">Select two revisions to compare.</div>}
      </div>
      <div className={maximizedPane === "a" ? "comparison__slot comparison__slot--hidden" : "comparison__slot"}>
        {snapshotsReady && snapshotB ? <RevisionPreviewPane pane="b" snapshot={snapshotB} reviewChanges={diff?.content.available ? diff.content.changes : []} reviewSide="proposed" maximized={maximizedPane === "b"} onMaximize={() => onMaximize("b")} onRestore={onRestore} /> : <div className="comparison__empty">Select two revisions to compare.</div>}
      </div>
    </div></div>
  </>;
}

function summaryMatchesResource(summary: ServerResourceRevisionSummary, resource: RevisionComparisonResource): boolean {
  return summary.projectId === resource.projectId && summary.resourceId === resource.resourceId && summary.contextId === resource.contextId && summary.representation === resourceRepresentationOfType(summary.type) && Number.isSafeInteger(summary.revision) && summary.revision > 0;
}

function snapshotMatchesResource(snapshot: ServerResourceRevision, resource: RevisionComparisonResource, revision: number): boolean {
  return summaryMatchesResource(snapshot, resource) && snapshot.revision === revision && snapshot.representation === resourceRepresentationOfType(snapshot.type) && typeof snapshot.content === "string";
}

export function RevisionDiffSummary({ diff }: { diff: ResourceDiff }) {
  const structuralChanges = diff.content.totalChanges;
  return <section aria-label="Diff summary" data-testid="revision-diff-summary">
    <h3>Structural diff</h3>
    {!diff.content.available ? <p role="status">Semantic diff unavailable because one or both revisions have validation errors.</p>
      : structuralChanges > 0 ? <p role="status">Structural diff available · {structuralChanges} change(s).</p>
        : diff.metadata.changed || diff.source.changed ? <p role="status">Source/metadata-only changes; no structural changes.</p>
          : <p role="status">No structural changes.</p>}
    <p>{diff.content.truncated ? "Returned change kinds: " : "Change kinds: "}Added {diff.summary.byKind.added} · Removed {diff.summary.byKind.removed} · Modified {diff.summary.byKind.modified}</p>
    <p>Source hunks: {diff.source.totalHunks} · Metadata changes: {diff.metadata.changes.length}</p>
    {diff.content.truncated ? <p role="status">Semantic diff truncated: showing {diff.content.returnedChanges} of {diff.content.totalChanges} changes.</p> : null}
    {diff.source.truncated ? <p role="status">Source diff truncated: showing {diff.source.returnedHunks} of {diff.source.totalHunks} hunks.</p> : null}
  </section>;
}

function RevisionPreviewPane({ pane, snapshot, reviewChanges, reviewSide, maximized, onMaximize, onRestore }: {
  pane: "a" | "b";
  snapshot: ServerResourceRevision;
  reviewChanges: SemanticChange[];
  reviewSide: "base" | "proposed";
  maximized: boolean;
  onMaximize: () => void;
  onRestore: () => void;
}) {
  const representation = resourceRepresentationOfType(snapshot.type);
  return <section className={`comparison__pane${maximized ? " comparison__pane--maximized" : ""}`} aria-label={`Revision ${pane.toUpperCase()}`} data-testid={`revision-pane-${pane}`}>
    <header className="comparison__header"><div><strong>Revision {pane.toUpperCase()}</strong><span>{snapshot.contextId === null ? "SHARED" : "MY WORK"} · r{snapshot.revision} · {new Date(snapshot.createdAt).toLocaleString()}</span><h2>{snapshot.path}</h2><span>{representationLabel(representation)}</span></div>
      <button type="button" className="icon-button" aria-label={maximized ? `Restore revision ${pane.toUpperCase()}` : `Maximize revision ${pane.toUpperCase()}`} onClick={maximized ? onRestore : onMaximize}>{maximized ? "⊡" : "⤢"}</button>
    </header>
    <div className="comparison__viewer">
      {snapshot.type === "conceptual" ? <ConceptualPreview source={snapshot.content} reviewChanges={reviewChanges} reviewSide={reviewSide} comparisonMode />
        : snapshot.type === "database" ? <DatabasePreview source={snapshot.content} reviewChanges={reviewChanges} comparisonMode />
          : <p role="status">This representation has no structural preview in revision comparison.</p>}
    </div>
  </section>;
}

function diagnosticMessage(diagnostic: unknown): string {
  if (typeof diagnostic === "object" && diagnostic !== null && "message" in diagnostic && typeof diagnostic.message === "string") return diagnostic.message;
  return typeof diagnostic === "string" ? diagnostic : JSON.stringify(diagnostic);
}

function traceProvenance(context: AnalysisContext) {
  return context.knowledgeContext.kind === "private-work"
    ? { kind: "private-work" as const, id: context.knowledgeContext.id, label: context.knowledgeContext.name }
    : { kind: context.knowledgeContext.kind, id: context.knowledgeContext.id };
}

const emptySemanticComparison: SemanticComparison = { occurrences: { a: [], b: [] }, identities: new Map(), shared: [], onlyA: [], onlyB: [], candidates: [], relationship: null };
const emptyIndex = { projectId: "", resources: [], diagrams: [], eventFlows: [], documents: [], participants: [], usages: [], references: [], diagnostics: [] } satisfies ProjectIndex;

function ComparisonSummary({ comparison, analysis, selected, onSelect, onFocus, onStep, onOpenResource, options, onOptionsChange, resourceNames }: { comparison: SemanticComparison; analysis: CrossContextAnalysis; selected: { pane: ComparisonPaneId; messageId: string } | null; onSelect: (pane: ComparisonPaneId, id: string) => void; onFocus: (occurrence: ComparisonOccurrence) => void; onStep: (direction: 1 | -1) => void; onOpenResource: (resourceId: string, nodeId?: string) => void; options: AnalysisOptions; onOptionsChange: (options: AnalysisOptions) => void; resourceNames: Record<ComparisonPaneId, string> }) {
  const provenanceA = analysis.contexts.a.knowledgeContext.kind === "private-work" ? `MY WORK · ${analysis.contexts.a.knowledgeContext.name}` : analysis.contexts.a.knowledgeContext.kind.toUpperCase();
  const provenanceB = analysis.contexts.b.knowledgeContext.kind === "private-work" ? `MY WORK · ${analysis.contexts.b.knowledgeContext.name}` : analysis.contexts.b.knowledgeContext.kind.toUpperCase();
  const sameProvenance = provenanceA === provenanceB;
  const groups = [
    [sameProvenance ? "Shared" : "Common authoritative knowledge", comparison.shared, "both", `${provenanceA} + ${provenanceB}`],
    [sameProvenance ? "Documented only in A" : `Documented only in ${provenanceA}`, comparison.onlyA, "a", resourceNames.a],
    [sameProvenance ? "Documented only in B" : `Documented only in ${provenanceB}`, comparison.onlyB, "b", resourceNames.b],
  ] as const;
  return <div>
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
           <span>{sameProvenance ? "Shared messages" : "Common authoritative"}: <strong>{analysis.semanticConnections.length}</strong></span>
           <span>{sameProvenance ? "Documented only in A" : `Only ${provenanceA}`}: <strong>{analysis.documentedOnlyA.length}</strong></span>
           <span>{sameProvenance ? "Documented only in B" : `Only ${provenanceB}`}: <strong>{analysis.documentedOnlyB.length}</strong></span>
          <span>Unknown boundaries A/B: <strong>{analysis.sides.a.unknownBoundaries.length}/{analysis.sides.b.unknownBoundaries.length}</strong></span>
          <span>Recovery A/B: <strong>{analysis.sides.a.recovery}/{analysis.sides.b.recovery}</strong></span>
        </div>
        {analysis.explicitRelationships.length ? <p className="comparison__relationship">Explicit relationship: {analysis.explicitRelationships.map((relationship) => `${relationship.kind} (${relationship.sourceRole ?? "other"} ↔ ${relationship.targetRole ?? "other"})`).join(", ")}</p> : <p>Explicit relationships: none</p>}
        {analysis.sides.a.effects.length || analysis.sides.b.effects.length ? <p>Effects documented A/B: {analysis.sides.a.effects.length}/{analysis.sides.b.effects.length}</p> : null}
         {analysis.sides.a.effects.length && !analysis.sides.b.effects.length ? <p>Effect documented only in {provenanceA}.</p> : null}
         {analysis.sides.b.effects.length && !analysis.sides.a.effects.length ? <p>Effect documented only in {provenanceB}.</p> : null}
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
  </div>;
}
