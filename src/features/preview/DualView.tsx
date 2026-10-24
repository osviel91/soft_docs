import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { DiagramViewportTransform } from "./DiagramViewport";

type Session = { option: ComparisonOption; source: string; representation: ResourceRepresentation };

type VisualSessionIdentity = {
  projectId: string;
  contextKind: string;
  contextId: string;
  resourceId: string;
};

type VisualSessionLineage = "viewer-a" | "viewer-b";

export type VisualSessionSnapshot = {
  sourceFingerprint: string;
  transform: DiagramViewportTransform | null;
  selectedNodeId: string | null;
};

type VisualSessionStore = Map<string, VisualSessionSnapshot>;

const MAX_VISUAL_SESSIONS = 40;

function identityOf(option: ComparisonOption): VisualSessionIdentity {
  return {
    projectId: option.context.projectId,
    contextKind: option.context.knowledgeContext.kind,
    contextId: option.context.knowledgeContext.id,
    resourceId: option.resourceId,
  };
}

function resourceKey(identity: VisualSessionIdentity): string {
  return JSON.stringify([identity.projectId, identity.contextKind, identity.contextId, identity.resourceId]);
}

function sessionKey(identity: VisualSessionIdentity, lineage: VisualSessionLineage): string {
  return JSON.stringify([lineage, resourceKey(identity)]);
}

/** Deterministic FNV-1a fingerprint; source is never stored in the session cache. */
export function fingerprintVisualSource(source: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= BigInt(source.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function compatibleVisualSnapshot(snapshot: VisualSessionSnapshot | undefined, source: string): VisualSessionSnapshot | null {
  return snapshot?.sourceFingerprint === fingerprintVisualSource(source) ? snapshot : null;
}

function remember(store: VisualSessionStore, key: string, snapshot: VisualSessionSnapshot): void {
  store.delete(key);
  store.set(key, snapshot);
  while (store.size > MAX_VISUAL_SESSIONS) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

function DualPane({ session, pane, snapshot, onSnapshot }: {
  session: Session;
  pane: "a" | "b";
  snapshot: VisualSessionSnapshot | null;
  onSnapshot: (snapshot: VisualSessionSnapshot) => void;
}) {
  const { option, source, representation } = session;
  const [activeNodeId, setActiveNodeId] = useState<string | null>(() => snapshot?.selectedNodeId ?? null);
  const transformRef = useRef<DiagramViewportTransform | null>(snapshot?.transform ?? null);
  const sourceFingerprint = fingerprintVisualSource(source);
  const saveSnapshot = useCallback((patch: Partial<VisualSessionSnapshot>) => {
    onSnapshot({ sourceFingerprint, transform: transformRef.current, selectedNodeId: activeNodeId, ...patch });
  }, [activeNodeId, onSnapshot, sourceFingerprint]);
  const selectNode = useCallback((nodeId: string | null) => {
    setActiveNodeId(nodeId);
    saveSnapshot({ selectedNodeId: nodeId });
  }, [saveSnapshot]);
  const captureTransform = useCallback((transform: DiagramViewportTransform) => {
    transformRef.current = transform;
    saveSnapshot({ transform });
  }, [saveSnapshot]);
  const [eventView, setEventView] = useState<EventFlowView>("flow");
  const flow = useMemo(() => representation === "event-flow" ? analyzeEventFlow(source).flow : null, [representation, source]);
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
        : representation === "conceptual" ? <ConceptualPreview source={source} onNodeSelect={selectNode} activeNodeId={activeNodeId} initialTransform={snapshot?.transform ?? null} onVisualTransformChange={captureTransform} validateRestoredNode />
          : representation === "database" ? <DatabasePreview source={source} onNodeSelect={selectNode} activeNodeId={activeNodeId} initialTransform={snapshot?.transform ?? null} onVisualTransformChange={captureTransform} validateRestoredNode />
            : representation === "event-flow" ? <EventFlowPreview source={source} flow={flow} view={eventView} onViewChange={setEventView} onNodeSelect={selectNode} activeNodeId={activeNodeId} initialTransform={snapshot?.transform ?? null} onVisualTransformChange={captureTransform} validateRestoredNode />
              : <Preview source={source} onNodeSelect={selectNode} activeNodeId={activeNodeId} initialTransform={snapshot?.transform ?? null} onVisualTransformChange={captureTransform} validateRestoredNode />}
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
  const [ids, setIds] = useState<[string, string]>(() => [
    first?.id ?? "",
    options.find((option) => option.id !== first?.id)?.id ?? "",
  ]);
  const [lineages, setLineages] = useState<[VisualSessionLineage, VisualSessionLineage]>(["viewer-a", "viewer-b"]);
  const sessions = useRef<VisualSessionStore>(new Map());
  const identityKeys = useMemo(() => new Map(options.map((option) => [option.id, resourceKey(identityOf(option))])), [options]);
  useEffect(() => {
    setIds(([a, b]) => {
      const nextA = options.some(option => option.id === a) ? a : (options.find(option => option.id === initialOptionId)?.id ?? options[0]?.id ?? "");
      const nextB = options.some(option => option.id === b && option.id !== nextA) ? b : (options.find(option => option.id !== nextA)?.id ?? "");
      return a === nextA && b === nextB ? [a, b] : [nextA, nextB];
    });
    const allowed = new Set(identityKeys.values());
    for (const key of sessions.current.keys()) {
      const [, resourceIdentity] = JSON.parse(key) as [VisualSessionLineage, string];
      if (!allowed.has(resourceIdentity)) sessions.current.delete(key);
    }
  }, [options, initialOptionId, projectId, identityKeys]);
  const a = options.find(option => option.id === ids[0]);
  const b = options.find(option => option.id === ids[1]);
  const swap = () => {
    setIds(([left, right]) => [right, left]);
    setLineages(([left, right]) => [right, left]);
  };
  const select = (pane: 0 | 1, id: string) => setIds(current => pane === 0 ? [id, current[1]] : [current[0], id]);
  const renderPane = (option: ComparisonOption, pane: "a" | "b", lineage: VisualSessionLineage) => {
    const identity = identityOf(option);
    const key = sessionKey(identity, lineage);
    const source = option.source;
    const sourceFingerprint = fingerprintVisualSource(source);
    const cached = sessions.current.get(key);
    const snapshot = compatibleVisualSnapshot(cached, source);
    if (cached && !snapshot) sessions.current.delete(key);
    const save = (next: VisualSessionSnapshot) => remember(sessions.current, key, next);
    const paneKey = `${key}:${sourceFingerprint}`;
    return <div className="comparison__slot" key={paneKey}><DualPane key={paneKey} session={{ option, source, representation: option.representation ?? resourceRepresentationOfName(option.resource.name) }} pane={pane} snapshot={snapshot} onSnapshot={save} /></div>;
  };
  return <div ref={rootRef} className={`comparison dual-view${focusMode ? " dual-view--focus" : ""}`} data-testid="dual-view" aria-hidden={false}>
    <header className="comparison__toolbar"><strong>Dual View · {projectId}</strong>
      <span className="comparison__navigation-hint" role="status" data-testid="comparison-navigation-hint">Usa los selectores Viewer A/B para cambiar los recursos mientras comparas</span>
      <button type="button" className="button button--ghost button--small" aria-pressed={focusMode} onClick={onToggleFocus}>{focusMode ? "Exit Focus" : "Focus"}</button>
      <button type="button" className="button button--ghost button--small" aria-pressed={fullscreen} title={fullscreenError ? "Fullscreen unavailable" : undefined} onClick={onToggleFullscreen}>{fullscreen ? "Exit fullscreen" : "Fullscreen"}</button>
      <label>Viewer A <select aria-label="Dual View A resource" value={a?.id ?? ""} onChange={event => select(0, event.target.value)}>{options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      <label>Viewer B <select aria-label="Dual View B resource" value={b?.id ?? ""} onChange={event => select(1, event.target.value)}><option value="">Select a resource</option>{options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      <button type="button" className="icon-button" aria-label="Swap dual viewers" onClick={swap} disabled={!a || !b}>⇄</button>
      <button type="button" className="icon-button" aria-label="Close Dual View" onClick={onExit}>×</button>
    </header>
    <div className="comparison__content"><div className="comparison__panes">
      {a ? renderPane(a, "a", lineages[0]) : <div className="comparison__empty">Select a resource for Viewer A.</div>}
      {b ? renderPane(b, "b", lineages[1]) : <div className="comparison__empty">Select a resource for Viewer B.</div>}
    </div></div>
  </div>;
}
