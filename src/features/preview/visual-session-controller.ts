import type { ViewportTransform as DiagramViewportTransform } from "./viewport";
import type { ResourceRepresentation } from "../../domain/workspace/resource-id";
import { isValidMarkdownScrollSnapshot } from "./markdown-scroll-snapshot";

export type EventFlowProjection = "flow" | "catalog" | "topology" | "causal";

export type MarkdownScrollSnapshot = {
  scrollTop: number;
  /** Scroll progress in the 0..1 range, using the available vertical scroll distance. */
  scrollRatio: number;
  /** Scrollable range at capture time; used to choose absolute vs proportional restoration. */
  maxScroll: number;
};

export function isEventFlowProjection(value: unknown): value is EventFlowProjection {
  return value === "flow" || value === "catalog" || value === "topology" || value === "causal";
}

export type VisualSessionLineage = "viewer-a" | "viewer-b";
export type VisualPane = "a" | "b";

export type VisualResourceIdentity = {
  projectId: string;
  contextKind: string;
  contextId: string;
  resourceId: string;
};

export type VisualSessionScope = Pick<VisualResourceIdentity, "projectId" | "contextKind" | "contextId">;

export type VisualSessionSnapshot = {
  sourceFingerprint: string;
  /** Guards representation-specific visual state when a stable resource id is renamed/reclassified. */
  representation?: ResourceRepresentation;
  transform: DiagramViewportTransform | null;
  /** For Event Flow only: projection whose SVG geometry this camera describes. */
  transformProjection?: EventFlowProjection;
  selectedNodeId: string | null;
  eventFlowProjection?: EventFlowProjection;
  markdownScroll?: MarkdownScrollSnapshot;
};

/** Partial updates are merged only into a snapshot for the same source and representation. */
export type VisualSessionSnapshotUpdate = {
  sourceFingerprint: string;
  representation: ResourceRepresentation;
} & Partial<Pick<VisualSessionSnapshot, "transform" | "transformProjection" | "selectedNodeId" | "eventFlowProjection" | "markdownScroll">>;

export type VisualSessionOption = {
  optionId: string;
  identity: VisualResourceIdentity;
  sourceFingerprint: string;
  representation: ResourceRepresentation;
};

export type VisualSessionAvailability = "loading" | "ready" | "unavailable";

export type VisualSessionSelection = {
  optionId: string;
  identity: VisualResourceIdentity;
  lineage: VisualSessionLineage;
};

export type VisualSessionState = {
  scope: VisualSessionScope;
  suspended: boolean;
  selections: Record<VisualPane, VisualSessionSelection | null>;
  lineages: Record<VisualPane, VisualSessionLineage>;
  snapshots: ReadonlyMap<string, VisualSessionSnapshot>;
  availability: VisualSessionAvailability;
  generation: number;
  preferredOptionId?: string;
};

export const MAX_VISUAL_SESSIONS = 40;

/** Deterministic FNV-1a fingerprint; source is never stored by the controller. */
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

export function visualResourceKey(identity: VisualResourceIdentity): string {
  return JSON.stringify([identity.projectId, identity.contextKind, identity.contextId, identity.resourceId]);
}

export function visualSnapshotKey(identity: VisualResourceIdentity, lineage: VisualSessionLineage): string {
  return JSON.stringify([lineage, visualResourceKey(identity)]);
}

function sameScope(left: VisualSessionScope, right: VisualSessionScope): boolean {
  return left.projectId === right.projectId && left.contextKind === right.contextKind && left.contextId === right.contextId;
}

function copySnapshot(snapshot: VisualSessionSnapshot): VisualSessionSnapshot {
  return {
    ...snapshot,
    transform: snapshot.transform ? { ...snapshot.transform } : null,
    ...(snapshot.markdownScroll ? { markdownScroll: { ...snapshot.markdownScroll } } : {}),
  };
}

function mergeSnapshotUpdate(previous: VisualSessionSnapshot | undefined, update: VisualSessionSnapshotUpdate): VisualSessionSnapshot {
  const compatible = previous?.sourceFingerprint === update.sourceFingerprint
    && previous.representation === update.representation;
  const base: VisualSessionSnapshot = compatible
    ? copySnapshot(previous!)
    : { sourceFingerprint: update.sourceFingerprint, representation: update.representation, transform: null, selectedNodeId: null };
  const merged: VisualSessionSnapshot = { ...base, sourceFingerprint: update.sourceFingerprint, representation: update.representation };
  for (const field of ["transform", "transformProjection", "selectedNodeId", "eventFlowProjection", "markdownScroll"] as const) {
    if (Object.prototype.hasOwnProperty.call(update, field)) {
      const value = update[field];
      if (field === "markdownScroll") {
        const scroll = value as MarkdownScrollSnapshot | undefined;
        merged.markdownScroll = scroll ? { ...scroll } : undefined;
      } else {
        // Explicit null is meaningful for camera/selection; undefined means no update.
        if (value !== undefined) Object.assign(merged, { [field]: value });
      }
    }
  }
  return merged;
}

function copyState(state: VisualSessionState): VisualSessionState {
  return {
    ...state,
    selections: { a: state.selections.a ? { ...state.selections.a, identity: { ...state.selections.a.identity } } : null,
      b: state.selections.b ? { ...state.selections.b, identity: { ...state.selections.b.identity } } : null },
    lineages: { ...state.lineages },
    snapshots: new Map([...state.snapshots].map(([key, snapshot]) => [key, copySnapshot(snapshot)])),
  };
}

export function rememberVisualSnapshot(store: Map<string, VisualSessionSnapshot>, key: string, snapshot: VisualSessionSnapshot): void {
  store.delete(key);
  store.set(key, snapshot);
  while (store.size > MAX_VISUAL_SESSIONS) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export type VisualSessionController = {
  getState(): VisualSessionState;
  /** Token captured by async UI work; invalidated by close or scope change. */
  captureGeneration(): number;
  suspend(): VisualSessionState;
  resume(): VisualSessionState;
  close(): void;
  reconcile(input: { scope: VisualSessionScope; availability: VisualSessionAvailability; options?: readonly VisualSessionOption[]; initialOptionId?: string }): VisualSessionState;
  select(pane: VisualPane, option: VisualSessionOption | null): VisualSessionState;
  swap(): VisualSessionState;
  getSnapshot(identity: VisualResourceIdentity, lineage: VisualSessionLineage, sourceFingerprint: string): VisualSessionSnapshot | null;
  saveSnapshot(identity: VisualResourceIdentity, lineage: VisualSessionLineage, snapshot: VisualSessionSnapshotUpdate, generation: number): boolean;
};

/** In-memory, single-scope owner for Dual View's serializable exploration state. */
export function createVisualSessionController(scope: VisualSessionScope, initialOptionId?: string): VisualSessionController {
  let closed = false;
  let authorizedOptions = new Map<string, VisualSessionOption>();
  let state: VisualSessionState = {
    scope: { ...scope }, suspended: false,
    selections: { a: null, b: null }, lineages: { a: "viewer-a", b: "viewer-b" },
    snapshots: new Map(), availability: "loading", generation: 1,
    preferredOptionId: initialOptionId,
  };

  const getState = () => copyState(state);
  const captureGeneration = () => state.generation;
  const suspend = () => {
    if (!closed && !state.suspended) state = { ...state, suspended: true, generation: state.generation + 1 };
    return getState();
  };
  const resume = () => {
    if (!closed && state.availability === "ready") state = { ...state, suspended: false };
    return getState();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    authorizedOptions = new Map();
    // Advance the generation before clearing state: late callbacks cannot repopulate it.
    state = { ...state, generation: state.generation + 1, suspended: true,
      selections: { a: null, b: null }, lineages: { a: "viewer-a", b: "viewer-b" },
      snapshots: new Map(), availability: "unavailable" };
  };
  const reconcile: VisualSessionController["reconcile"] = ({ scope: nextScope, availability, options = [], initialOptionId: nextInitialId }) => {
    if (closed) return getState();
    if (!sameScope(state.scope, nextScope)) {
      authorizedOptions = new Map();
      state = { scope: { ...nextScope }, suspended: false, selections: { a: null, b: null },
        lineages: { a: "viewer-a", b: "viewer-b" }, snapshots: new Map(), availability,
        generation: state.generation + 1, preferredOptionId: nextInitialId };
    }
    if (availability === "loading") {
      state = { ...state, availability, generation: state.availability === availability ? state.generation : state.generation + 1 };
      return getState();
    }
    if (availability === "unavailable") {
      state = { ...state, availability, generation: state.availability === availability ? state.generation : state.generation + 1 };
      return getState();
    }

    const allowed = new Map(options.map(option => [visualResourceKey(option.identity), option]));
    authorizedOptions = allowed;
    const snapshots = new Map(state.snapshots);
    for (const key of snapshots.keys()) {
      const [, resourceKey] = JSON.parse(key) as [VisualSessionLineage, string];
      const option = allowed.get(resourceKey);
      const existing = snapshots.get(key);
      if (!option || existing?.sourceFingerprint !== option.sourceFingerprint || existing.representation !== option.representation) snapshots.delete(key);
    }
    const reconcileSelection = (selection: VisualSessionSelection | null): VisualSessionSelection | null => {
      if (!selection) return null;
      const option = allowed.get(visualResourceKey(selection.identity));
      return option ? { ...selection, optionId: option.optionId, identity: { ...option.identity } } : null;
    };
    let a = reconcileSelection(state.selections.a);
    let b = reconcileSelection(state.selections.b);
    if (!a && options.length) {
      const option = options.find(item => item.optionId === (nextInitialId ?? state.preferredOptionId)) ?? options[0];
      a = { optionId: option.optionId, identity: { ...option.identity }, lineage: state.lineages.a };
    }
    if (!b && options.length) {
      const option = options.find(item => item.optionId !== a?.optionId);
      if (option) b = { optionId: option.optionId, identity: { ...option.identity }, lineage: state.lineages.b };
    }
    if (b && a && visualResourceKey(b.identity) === visualResourceKey(a.identity) && b.lineage === a.lineage) b = null;
    state = { ...state, availability, selections: { a, b }, snapshots };
    return getState();
  };
  const select: VisualSessionController["select"] = (pane, option) => {
    if (closed || state.availability !== "ready") return getState();
    if (option) {
      const authorized = authorizedOptions.get(visualResourceKey(option.identity));
      if (!authorized || authorized.optionId !== option.optionId) return getState();
    }
    const other = pane === "a" ? state.selections.b : state.selections.a;
    const lineage = state.lineages[pane];
    const selection = option ? { optionId: option.optionId, identity: { ...option.identity }, lineage } : null;
    state = { ...state, selections: pane === "a" ? { a: selection, b: other } : { a: other, b: selection } };
    return getState();
  };
  const swap = () => {
    if (closed || state.availability !== "ready") return getState();
    const a = state.selections.a;
    const b = state.selections.b;
    state = { ...state, selections: {
      a: b ? { ...b } : null,
      b: a ? { ...a } : null,
    }, lineages: { a: state.lineages.b, b: state.lineages.a } };
    return getState();
  };
  const getSnapshot = (identity: VisualResourceIdentity, lineage: VisualSessionLineage, sourceFingerprint: string) => {
    if (closed || state.availability !== "ready") return null;
    const selected = [state.selections.a, state.selections.b].some(selection => selection !== null &&
      selection.lineage === lineage && visualResourceKey(selection.identity) === visualResourceKey(identity));
    if (!selected) return null;
    const key = visualSnapshotKey(identity, lineage);
    const cached = state.snapshots.get(key);
    if (!cached) return null;
    const option = authorizedOptions.get(visualResourceKey(identity));
    if (cached.sourceFingerprint !== sourceFingerprint || (option && cached.representation !== option.representation)) {
      const snapshots = new Map(state.snapshots);
      snapshots.delete(key);
      state = { ...state, snapshots };
      return null;
    }
    const result = copySnapshot(cached);
    if (result.eventFlowProjection !== undefined && (result.representation !== "event-flow" || !isEventFlowProjection(result.eventFlowProjection))) {
      delete result.eventFlowProjection;
    }
    if (result.transformProjection !== undefined && (result.representation !== "event-flow" || !isEventFlowProjection(result.transformProjection))) {
      delete result.transformProjection;
    }
    return result;
  };
  const saveSnapshot = (identity: VisualResourceIdentity, lineage: VisualSessionLineage, snapshot: VisualSessionSnapshotUpdate, generation: number) => {
    if (closed || generation !== state.generation || state.availability !== "ready") return false;
    const allowed = [state.selections.a, state.selections.b].some(selection => selection !== null &&
      selection.lineage === lineage && visualResourceKey(selection.identity) === visualResourceKey(identity));
    if (!allowed) return false;
    const authorized = authorizedOptions.get(visualResourceKey(identity));
    if (!authorized || authorized.sourceFingerprint !== snapshot.sourceFingerprint || authorized.representation !== snapshot.representation) return false;
    if (Object.prototype.hasOwnProperty.call(snapshot, "eventFlowProjection") && authorized.representation !== "event-flow") return false;
    if (Object.prototype.hasOwnProperty.call(snapshot, "transformProjection") && authorized.representation !== "event-flow") return false;
    if (Object.prototype.hasOwnProperty.call(snapshot, "markdownScroll") && authorized.representation !== "markdown") return false;
    if (snapshot.markdownScroll !== undefined && !isValidMarkdownScrollSnapshot(snapshot.markdownScroll)) return false;
    if (snapshot.eventFlowProjection !== undefined && !isEventFlowProjection(snapshot.eventFlowProjection)) return false;
    if (snapshot.transformProjection !== undefined && !isEventFlowProjection(snapshot.transformProjection)) return false;
    const snapshots = new Map(state.snapshots);
    const key = visualSnapshotKey(identity, lineage);
    rememberVisualSnapshot(snapshots, key, mergeSnapshotUpdate(snapshots.get(key), snapshot));
    state = { ...state, snapshots };
    return true;
  };

  return { getState, captureGeneration, suspend, resume, close, reconcile, select, swap, getSnapshot, saveSnapshot };
}
