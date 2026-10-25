import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { markdownRestoreScrollTop, markdownScrollSnapshot } from "./markdown-scroll-snapshot";
import { analysisProvenanceLabel } from "../../domain/workspace/knowledge-context";
import type { DiagramViewportTransform } from "./DiagramViewport";
import type { ServerProject, ServerWorkspace } from "../../workspace/server/api-client";
import {
  fingerprintVisualSource,
  isEventFlowProjection,
  type VisualSessionAvailability,
  type VisualSessionController,
  type VisualResourceIdentity,
  type VisualSessionLineage,
  type VisualSessionSnapshot,
} from "./visual-session-controller";
export { compatibleVisualSnapshot, fingerprintVisualSource } from "./visual-session-controller";
export type { VisualSessionSnapshot } from "./visual-session-controller";

type Session = { option: ComparisonOption; source: string; representation: ResourceRepresentation };

function identityOf(option: ComparisonOption): VisualResourceIdentity {
  return {
    projectId: option.context.projectId,
    contextKind: option.context.knowledgeContext.kind,
    contextId: option.context.knowledgeContext.id,
    resourceId: option.resourceId,
  };
}

function DualPane({ session, pane, lineage, snapshot, controller }: {
  session: Session;
  pane: "a" | "b";
  lineage: VisualSessionLineage;
  snapshot: VisualSessionSnapshot | null;
  controller: VisualSessionController;
}) {
  const { option, source, representation } = session;
  const resourceIdentity = useMemo(() => identityOf(option), [option.context.knowledgeContext.id, option.context.knowledgeContext.kind, option.context.projectId, option.resourceId]);
  const sourceFingerprint = fingerprintVisualSource(source);
  const sessionSnapshot = controller.getSnapshot(resourceIdentity, lineage, sourceFingerprint) ?? snapshot;
  const eventFlowView = representation === "event-flow" && isEventFlowProjection(sessionSnapshot?.eventFlowProjection)
    ? sessionSnapshot.eventFlowProjection
    : "flow";
  const compatibleTransform = representation === "event-flow"
    ? sessionSnapshot?.transformProjection === eventFlowView ? sessionSnapshot.transform : null
    : sessionSnapshot?.transform ?? null;
  const [activeNodeId, setActiveNodeId] = useState<string | null>(() => sessionSnapshot?.selectedNodeId ?? null);
  const transformRef = useRef<DiagramViewportTransform | null>(compatibleTransform);
  const [, setSnapshotRevision] = useState(0);
  const generation = controller.captureGeneration();
  const controllerSuspended = controller.getState().suspended;
  const markdownRestoreKey = JSON.stringify([resourceIdentity, lineage, sourceFingerprint, generation]);
  const markdownScrollerRef = useRef<HTMLDivElement>(null);
  const markdownFrameRef = useRef<number | null>(null);
  const markdownRestoreFrameRef = useRef<number | null>(null);
  const pendingMarkdownSnapshotRef = useRef<VisualSessionSnapshot["markdownScroll"]>(undefined);
  const expectedProgrammaticScrollRef = useRef<number | null>(null);
  const saveSnapshot = useCallback((patch: Partial<VisualSessionSnapshot>) => {
    const saved = controller.saveSnapshot(resourceIdentity, lineage, { sourceFingerprint, representation, ...patch }, generation);
    if (saved && Object.prototype.hasOwnProperty.call(patch, "eventFlowProjection")) setSnapshotRevision(revision => revision + 1);
  }, [controller, generation, lineage, representation, resourceIdentity, sourceFingerprint]);
  const selectNode = useCallback((nodeId: string | null) => {
    setActiveNodeId(nodeId);
    saveSnapshot({ selectedNodeId: nodeId });
  }, [saveSnapshot]);
  const captureTransform = useCallback((transform: DiagramViewportTransform) => {
    transformRef.current = transform;
    saveSnapshot(representation === "event-flow" ? { transform, transformProjection: eventFlowView } : { transform });
  }, [eventFlowView, representation, saveSnapshot]);
  const changeEventView = useCallback((view: EventFlowView) => {
    saveSnapshot({ eventFlowProjection: view });
  }, [saveSnapshot]);
  const captureMarkdownScroll = useCallback(() => {
    const scroller = markdownScrollerRef.current;
    if (!scroller || representation !== "markdown") return;
    if (expectedProgrammaticScrollRef.current !== null && Math.abs(scroller.scrollTop - expectedProgrammaticScrollRef.current) < 1) {
      expectedProgrammaticScrollRef.current = null;
      return;
    }
    pendingMarkdownSnapshotRef.current = markdownScrollSnapshot(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight);
    if (markdownFrameRef.current !== null) return;
    const view = scroller.ownerDocument.defaultView;
    const commit = () => {
      markdownFrameRef.current = null;
      const markdownScroll = pendingMarkdownSnapshotRef.current;
      pendingMarkdownSnapshotRef.current = undefined;
      if (markdownScroll) saveSnapshot({ markdownScroll });
    };
    markdownFrameRef.current = view?.requestAnimationFrame(commit) ?? -1;
    if (!view?.requestAnimationFrame) queueMicrotask(commit);
  }, [representation, saveSnapshot]);

  useLayoutEffect(() => {
    const scroller = markdownScrollerRef.current;
    if (!scroller || representation !== "markdown") return;
    const captureBeforeSuspend = () => {
      const state = controller.getState();
      if (state.suspended || state.availability !== "ready") return;
      const markdownScroll = markdownScrollSnapshot(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight);
      pendingMarkdownSnapshotRef.current = undefined;
      saveSnapshot({ markdownScroll });
    };
    scroller.addEventListener("scroll", captureBeforeSuspend);
    return () => scroller.removeEventListener("scroll", captureBeforeSuspend);
  }, [controller, representation, saveSnapshot]);

  useLayoutEffect(() => {
    if (representation !== "markdown") return;
    const scroller = markdownScrollerRef.current;
    const controllerState = controller.getState();
    if (!scroller || controllerSuspended || controllerState.suspended || controllerState.availability !== "ready") return;
    const view = scroller.ownerDocument.defaultView;
    const restore = () => {
      markdownRestoreFrameRef.current = null;
      const currentState = controller.getState();
      if (controller.captureGeneration() !== generation || currentState.suspended || currentState.availability !== "ready") return;
      const current = controller.getSnapshot(resourceIdentity, lineage, sourceFingerprint)?.markdownScroll;
      if (!current) return;
      const target = markdownRestoreScrollTop(current, scroller.scrollHeight, scroller.clientHeight);
      if (Math.abs(scroller.scrollTop - target) >= 1) {
        expectedProgrammaticScrollRef.current = target;
        scroller.scrollTop = target;
      }
    };
    if (view?.requestAnimationFrame) markdownRestoreFrameRef.current = view.requestAnimationFrame(restore);
    else queueMicrotask(restore);
    return () => {
      const pendingMarkdownScroll = pendingMarkdownSnapshotRef.current;
      pendingMarkdownSnapshotRef.current = undefined;
      if (pendingMarkdownScroll && controller.captureGeneration() === generation
        && !controller.getState().suspended && controller.getState().availability === "ready") {
        saveSnapshot({ markdownScroll: pendingMarkdownScroll });
      }
      if (markdownFrameRef.current !== null && markdownFrameRef.current >= 0) view?.cancelAnimationFrame(markdownFrameRef.current);
      if (markdownRestoreFrameRef.current !== null) view?.cancelAnimationFrame(markdownRestoreFrameRef.current);
      markdownFrameRef.current = null;
      markdownRestoreFrameRef.current = null;
      pendingMarkdownSnapshotRef.current = undefined;
    };
  }, [controller, controllerSuspended, generation, lineage, markdownRestoreKey, pane, representation, resourceIdentity, saveSnapshot, sourceFingerprint]);
  const flow = useMemo(() => representation === "event-flow" ? analyzeEventFlow(source).flow : null, [representation, source]);
  const name = "markdown" in option.resource
    ? noteDisplayName(option.resource.name, source)
    : diagramDisplayName(option.resource.name, source);
  const provenance = analysisProvenanceLabel(option.context.knowledgeContext.kind === "private-work"
    ? { kind: "private-work", id: option.context.knowledgeContext.id, label: option.context.knowledgeContext.name }
    : { kind: option.context.knowledgeContext.kind, id: option.context.knowledgeContext.id });

  return <section className="comparison__pane" aria-label={`Dual viewer ${pane.toUpperCase()}`} data-testid={`dual-pane-${pane}`}>
    <header className="comparison__header"><div><strong>Viewer {pane.toUpperCase()}</strong><span className="comparison__provenance">{provenance}</span><h2>{name}</h2><span>{option.resource.name}</span></div></header>
    <div className={`comparison__viewer${representation === "markdown" ? " comparison__viewer--markdown" : ""}`}>
      {representation === "markdown" ? <MarkdownView markdown={source} scrollerRef={markdownScrollerRef} onScroll={captureMarkdownScroll} />
        : representation === "conceptual" ? <ConceptualPreview source={source} onNodeSelect={selectNode} activeNodeId={activeNodeId} initialTransform={compatibleTransform} onVisualTransformChange={captureTransform} validateRestoredNode />
          : representation === "database" ? <DatabasePreview source={source} onNodeSelect={selectNode} activeNodeId={activeNodeId} initialTransform={compatibleTransform} onVisualTransformChange={captureTransform} validateRestoredNode />
            : representation === "event-flow" ? <EventFlowPreview source={source} flow={flow} view={eventFlowView} onViewChange={changeEventView} onNodeSelect={selectNode} activeNodeId={activeNodeId} initialTransform={compatibleTransform} onVisualTransformChange={captureTransform} validateRestoredNode />
              : <Preview source={source} onNodeSelect={selectNode} activeNodeId={activeNodeId} initialTransform={compatibleTransform} onVisualTransformChange={captureTransform} validateRestoredNode />}
    </div>
  </section>;
}

export default function DualView({ options, projectId, activeProjectId, activeProjectName, serverProjects = [], serverWorkspaces = [], selectedServerWorkspaceId, onSelectServerWorkspace, activeContextId, privateWorkContexts = [], onSelectContext, onOpenServerProject, proposals = [], onOpenProposal, onExit, onSwitchToAnalysis, focusMode = false, onToggleFocus = () => {}, fullscreen = false, onToggleFullscreen = () => {}, fullscreenError = false, rootRef, controller, availability = "ready" }: {
  options: ComparisonOption[];
  projectId: string;
  activeProjectId?: string | null;
  activeProjectName?: string | null;
  serverProjects?: ServerProject[];
  serverWorkspaces?: ServerWorkspace[];
  selectedServerWorkspaceId?: string | null;
  onSelectServerWorkspace?: (workspaceId: string) => void;
  activeContextId?: string | null;
  privateWorkContexts?: Array<{ id: string; name: string }>;
  onSelectContext?: (contextId: string | null) => void;
  onOpenServerProject?: (project: ServerProject) => void;
  proposals?: Array<{ id: string; title: string }>;
  onOpenProposal?: (proposalId: string) => void;
  onExit: () => void;
  onSwitchToAnalysis?: () => void;
  focusMode?: boolean;
  onToggleFocus?: () => void;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  fullscreenError?: boolean;
  rootRef?: (node: HTMLDivElement | null) => void;
  controller: VisualSessionController;
  availability?: VisualSessionAvailability;
}) {
  const [, setRenderVersion] = useState(0);
  const updateFromController = () => setRenderVersion(version => version + 1);
  const sessionState = controller.getState();
  const a = availability === "ready" ? options.find(option => option.id === sessionState.selections.a?.optionId) : undefined;
  const b = availability === "ready" ? options.find(option => option.id === sessionState.selections.b?.optionId) : undefined;
  const lineages = sessionState.lineages;
  const select = (pane: "a" | "b", id: string) => {
    const option = options.find(item => item.id === id);
    controller.select(pane, option ? { optionId: option.id, identity: identityOf(option), sourceFingerprint: fingerprintVisualSource(option.source), representation: option.representation ?? resourceRepresentationOfName(option.resource.name) } : null);
    updateFromController();
  };
  const swap = () => { controller.swap(); updateFromController(); };
  const renderPane = (option: ComparisonOption, pane: "a" | "b", lineage: VisualSessionLineage) => {
    const identity = identityOf(option);
    const source = option.source;
    const sourceFingerprint = fingerprintVisualSource(source);
    const snapshot = controller.getSnapshot(identity, lineage, sourceFingerprint);
    const paneKey = `${option.id}:${lineage}:${sourceFingerprint}`;
    return <div className="comparison__slot" key={paneKey}><DualPane key={paneKey} session={{ option, source, representation: option.representation ?? resourceRepresentationOfName(option.resource.name) }} pane={pane} lineage={lineage} snapshot={snapshot} controller={controller} /></div>;
  };
  return <div ref={rootRef} className={`comparison dual-view${focusMode ? " dual-view--focus" : ""}`} data-testid="dual-view" aria-hidden={false}>
    <header className="comparison__toolbar"><strong>Dual View · {projectId}</strong>
      <span className="comparison__navigation-hint" role="status" data-testid="comparison-navigation-hint">Usa los selectores Viewer A/B para cambiar los recursos mientras comparas</span>
      {serverWorkspaces.length > 0 && onSelectServerWorkspace ? <label>Workspace <select aria-label="Dual View workspace" value={selectedServerWorkspaceId ?? ""} onChange={event => onSelectServerWorkspace(event.target.value)}>{serverWorkspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label> : null}
      {onOpenServerProject ? <label>Project <select aria-label="Dual View project" value={activeProjectId ?? ""} onChange={event => { const project = serverProjects.find(item => item.id === event.target.value); if (project) onOpenServerProject(project); }}>
        {activeProjectName && !serverProjects.some(project => project.id === activeProjectId) ? <option value={activeProjectId ?? ""}>{activeProjectName}</option> : null}
        {serverProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label> : null}
      {onSelectContext && (activeContextId != null || privateWorkContexts.length > 0) ? <label>Context <select aria-label="Dual View context" value={activeContextId ? `my-work:${activeContextId}` : "shared"} onChange={event => onSelectContext(event.target.value === "shared" ? null : event.target.value.slice("my-work:".length))}><option value="shared">SHARED</option>{privateWorkContexts.map(context => <option key={context.id} value={`my-work:${context.id}`}>MY WORK · {context.name}</option>)}</select></label> : null}
      <button type="button" className="button button--ghost button--small" aria-pressed={focusMode} onClick={onToggleFocus}>{focusMode ? "Exit Focus" : "Focus"}</button>
      <button type="button" className="button button--ghost button--small" aria-pressed={fullscreen} title={fullscreenError ? "Fullscreen unavailable" : undefined} onClick={onToggleFullscreen}>{fullscreen ? "Exit fullscreen" : "Fullscreen"}</button>
      {onSwitchToAnalysis ? <button type="button" className="button button--ghost button--small" aria-label="Switch to Analysis" onClick={onSwitchToAnalysis}>Analysis</button> : null}
      {onOpenProposal && proposals.length ? <label>Proposal <select aria-label="Open proposal" value="" onChange={event => { if (event.target.value) onOpenProposal(event.target.value); }}><option value="">Open proposal…</option>{proposals.map(proposal => <option key={proposal.id} value={proposal.id}>{proposal.title}</option>)}</select></label> : null}
      <label>Viewer A <select aria-label="Dual View A resource" value={a?.id ?? ""} onChange={event => select("a", event.target.value)} disabled={availability !== "ready"}>{options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      <label>Viewer B <select aria-label="Dual View B resource" value={b?.id ?? ""} onChange={event => select("b", event.target.value)} disabled={availability !== "ready"}><option value="">Select a resource</option>{options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      <button type="button" className="icon-button" aria-label="Swap dual viewers" onClick={swap} disabled={!a || !b}>⇄</button>
      <button type="button" className="icon-button" aria-label="Close Dual View" onClick={onExit}>×</button>
    </header>
    <div className="comparison__content"><div className="comparison__panes">
      {availability !== "ready" ? <div className="comparison__empty" role="status">{availability === "loading" ? "Loading authorized resources…" : "Dual View resources are unavailable."}</div> : <>
        {a ? renderPane(a, "a", lineages.a) : <div className="comparison__empty">Select a resource for Viewer A.</div>}
        {b ? renderPane(b, "b", lineages.b) : <div className="comparison__empty">Select a resource for Viewer B.</div>}
      </>}
    </div></div>
  </div>;
}
