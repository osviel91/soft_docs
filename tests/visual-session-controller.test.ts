import { describe, expect, it } from "vitest";
import {
  createVisualSessionController,
  compatibleVisualSnapshot,
  fingerprintVisualSource,
  MAX_VISUAL_SESSIONS,
  type VisualResourceIdentity,
  type VisualSessionOption,
  type VisualSessionScope,
  type VisualSessionSnapshot,
} from "../src/features/preview/visual-session-controller";

const scope: VisualSessionScope = { projectId: "p1", contextKind: "shared", contextId: "shared" };
const identity = (resourceId: string, override: Partial<VisualResourceIdentity> = {}): VisualResourceIdentity => ({ ...scope, resourceId, ...override });
const option = (resourceId: string, source: string, optionId = resourceId, override: Partial<VisualResourceIdentity> = {}): VisualSessionOption => ({
  optionId, identity: identity(resourceId, override), sourceFingerprint: fingerprintVisualSource(source), representation: "conceptual",
});
const snapshot = (source: string, x: number, selectedNodeId: string | null = null): VisualSessionSnapshot & { representation: "conceptual" } => ({
  sourceFingerprint: fingerprintVisualSource(source), representation: "conceptual", transform: { x, y: -x, scale: 1.5 }, selectedNodeId,
});

describe("visual session controller", () => {
  it("creates, suspends, resumes after an unmount, and closes explicitly", () => {
    const controller = createVisualSessionController(scope);
    const a = option("a", "source-a");
    controller.reconcile({ scope, availability: "ready", options: [a] });
    controller.select("a", a);
    const generation = controller.captureGeneration();
    controller.saveSnapshot(a.identity, "viewer-a", snapshot("source-a", 12, "node-a"), generation);
    expect(controller.suspend().suspended).toBe(true);

    // Simulate component unmount/remount: only the independent controller survives.
    const restored = controller.resume();
    expect(restored.selections.a?.optionId).toBe("a");
    expect(controller.getSnapshot(a.identity, "viewer-a", a.sourceFingerprint)).toEqual(snapshot("source-a", 12, "node-a"));

    controller.close();
    expect(controller.getState().snapshots.size).toBe(0);
    expect(controller.getState().selections).toEqual({ a: null, b: null });
    expect(controller.resume().suspended).toBe(true);
  });

  it("discards state on project or context change", () => {
    const controller = createVisualSessionController(scope);
    const a = option("a", "source-a");
    controller.reconcile({ scope, availability: "ready", options: [a] });
    controller.select("a", a);
    controller.saveSnapshot(a.identity, "viewer-a", snapshot("source-a", 2), controller.captureGeneration());

    const changedScope = { ...scope, projectId: "p2" };
    const changed = controller.reconcile({ scope: changedScope, availability: "ready", options: [] });
    expect(changed.snapshots.size).toBe(0);
    expect(changed.selections).toEqual({ a: null, b: null });
    expect(changed.generation).toBeGreaterThan(1);
    const changedContext = { ...scope, contextId: "work-1", contextKind: "private-work" };
    expect(controller.reconcile({ scope: changedContext, availability: "ready", options: [] }).snapshots.size).toBe(0);
  });

  it("preserves selections while loading and removes missing resources only after ready authorization", () => {
    const controller = createVisualSessionController(scope);
    const a = option("a", "source-a");
    const b = option("b", "source-b");
    controller.reconcile({ scope, availability: "ready", options: [a, b] });
    controller.select("a", a);
    controller.select("b", b);
    controller.saveSnapshot(a.identity, "viewer-a", snapshot("source-a", 1), controller.captureGeneration());
    const preLoadingGeneration = controller.captureGeneration();

    controller.suspend();
    expect(controller.reconcile({ scope, availability: "loading" }).selections.a?.optionId).toBe("a");
    expect(controller.getSnapshot(a.identity, "viewer-a", a.sourceFingerprint)).toBeNull();
    expect(controller.reconcile({ scope, availability: "unavailable" }).selections.a?.optionId).toBe("a");
    expect(controller.reconcile({ scope, availability: "ready", options: [b] }).selections).toEqual({
      a: { optionId: "b", identity: b.identity, lineage: "viewer-a" },
      b: { optionId: "b", identity: b.identity, lineage: "viewer-b" },
    });
    expect(controller.saveSnapshot(a.identity, "viewer-a", snapshot("source-a", 99), preLoadingGeneration)).toBe(false);
    expect(controller.getState().snapshots.size).toBe(0);
  });

  it("does not resume a suspended proposal-return session while its original scope is unavailable", () => {
    const controller = createVisualSessionController(scope);
    const a = option("a", "source-a");
    controller.reconcile({ scope, availability: "ready", options: [a] });
    controller.select("a", a);
    controller.saveSnapshot(a.identity, "viewer-a", snapshot("source-a", 5, "node-a"), controller.captureGeneration());
    controller.suspend();

    const unavailable = controller.reconcile({ scope, availability: "unavailable" });
    expect(controller.resume().suspended).toBe(true);
    expect(unavailable.selections.a?.optionId).toBe("a");
    expect(controller.getSnapshot(a.identity, "viewer-a", a.sourceFingerprint)).toBeNull();

    const noLongerAuthorized = controller.reconcile({ scope, availability: "ready", options: [] });
    expect(noLongerAuthorized.selections).toEqual({ a: null, b: null });
    expect(noLongerAuthorized.snapshots.size).toBe(0);
    expect(controller.resume().suspended).toBe(false);
  });

  it("rejects selecting or restoring an option that is not currently authorized", () => {
    const controller = createVisualSessionController(scope);
    const allowed = option("allowed", "allowed-source");
    const denied = option("denied", "denied-source");
    controller.reconcile({ scope, availability: "ready", options: [allowed] });
    controller.select("a", denied);
    expect(controller.getState().selections.a?.optionId).toBe("allowed");
    expect(controller.getSnapshot(denied.identity, "viewer-a", denied.sourceFingerprint)).toBeNull();
  });

  it("invalidates snapshots when their source fingerprint changes", () => {
    const controller = createVisualSessionController(scope);
    const old = option("a", "old-source");
    controller.reconcile({ scope, availability: "ready", options: [old] });
    controller.select("a", old);
    controller.saveSnapshot(old.identity, "viewer-a", snapshot("old-source", 9), controller.captureGeneration());
    const updated = option("a", "new-source");
    controller.reconcile({ scope, availability: "ready", options: [updated] });
    expect(controller.getSnapshot(updated.identity, "viewer-a", updated.sourceFingerprint)).toBeNull();
  });

  it("keeps legacy camera snapshots valid when optional view and scroll fields are absent", () => {
    const legacy: VisualSessionSnapshot = {
      sourceFingerprint: fingerprintVisualSource("source-a"),
      transform: { x: 4, y: 8, scale: 1.25 },
      selectedNodeId: "node-a",
    };
    expect(compatibleVisualSnapshot(legacy, "source-a")).toEqual(legacy);
  });

  it("merges partial projection and Markdown scroll updates without replacing camera or selection", () => {
    const controller = createVisualSessionController(scope);
    const eventFlow = { ...option("flow", "flow-source"), representation: "event-flow" as const };
    controller.reconcile({ scope, availability: "ready", options: [eventFlow] });
    controller.select("a", eventFlow);
    const generation = controller.captureGeneration();
    const fingerprint = eventFlow.sourceFingerprint;
    const base = { sourceFingerprint: fingerprint, representation: "event-flow" as const };
    controller.saveSnapshot(eventFlow.identity, "viewer-a", {
      ...base, transform: { x: 14, y: -3, scale: 1.75 }, selectedNodeId: "handler-a",
    }, generation);
    expect(controller.saveSnapshot(eventFlow.identity, "viewer-a", { ...base, eventFlowProjection: "causal" }, generation)).toBe(true);
    let saved = controller.getSnapshot(eventFlow.identity, "viewer-a", fingerprint)!;
    expect(saved.eventFlowProjection).toBe("causal");
    expect(saved.transform).toEqual({ x: 14, y: -3, scale: 1.75 });
    expect(saved.selectedNodeId).toBe("handler-a");

    expect(saved.eventFlowProjection).toBe("causal");
    expect(saved.transform).toEqual({ x: 14, y: -3, scale: 1.75 });
    expect(saved.selectedNodeId).toBe("handler-a");

    const markdown = { ...option("note", "# Read me"), representation: "markdown" as const };
    controller.reconcile({ scope, availability: "ready", options: [markdown] });
    controller.select("a", markdown);
    const markdownBase = { sourceFingerprint: markdown.sourceFingerprint, representation: "markdown" as const };
    controller.saveSnapshot(markdown.identity, "viewer-a", {
      ...markdownBase, transform: { x: 14, y: -3, scale: 1.75 }, selectedNodeId: "legacy-shared-selection",
    }, generation);
    expect(controller.saveSnapshot(markdown.identity, "viewer-a", { ...markdownBase, markdownScroll: { scrollTop: 120, scrollRatio: 0.4, maxScroll: 300 } }, generation)).toBe(true);
    saved = controller.getSnapshot(markdown.identity, "viewer-a", markdown.sourceFingerprint)!;
    expect(saved.markdownScroll).toEqual({ scrollTop: 120, scrollRatio: 0.4, maxScroll: 300 });
    expect(saved.transform).toEqual({ x: 14, y: -3, scale: 1.75 });
    expect(saved.selectedNodeId).toBe("legacy-shared-selection");
  });

  it("does not merge a partial update across a changed fingerprint or representation", () => {
    const controller = createVisualSessionController(scope);
    const flow = { ...option("stable", "source"), representation: "event-flow" as const };
    controller.reconcile({ scope, availability: "ready", options: [flow] });
    controller.select("a", flow);
    const generation = controller.captureGeneration();
    controller.saveSnapshot(flow.identity, "viewer-a", {
      sourceFingerprint: flow.sourceFingerprint, representation: flow.representation,
      transform: { x: 25, y: 10, scale: 2 }, selectedNodeId: "event-node", eventFlowProjection: "topology",
    }, generation);
    const markdown = { ...flow, sourceFingerprint: fingerprintVisualSource("source"), representation: "markdown" as const };
    controller.reconcile({ scope, availability: "ready", options: [markdown] });
    controller.select("a", markdown);
    expect(controller.getState().snapshots.size).toBe(0);
    controller.saveSnapshot(flow.identity, "viewer-a", {
      sourceFingerprint: markdown.sourceFingerprint, representation: "markdown", markdownScroll: { scrollTop: 8, scrollRatio: 0.2, maxScroll: 40 },
    }, generation);
    const saved = controller.getSnapshot(markdown.identity, "viewer-a", markdown.sourceFingerprint)!;
    expect(saved.transform).toBeNull();
    expect(saved.selectedNodeId).toBeNull();
    expect(saved.eventFlowProjection).toBeUndefined();
    expect(saved.markdownScroll).toEqual({ scrollTop: 8, scrollRatio: 0.2, maxScroll: 40 });
  });

  it("rejects Event Flow projection fields for other representations and invalid projection values", () => {
    const controller = createVisualSessionController(scope);
    const markdown = { ...option("note", "# Note"), representation: "markdown" as const };
    controller.reconcile({ scope, availability: "ready", options: [markdown] });
    controller.select("a", markdown);
    expect(controller.saveSnapshot(markdown.identity, "viewer-a", {
      sourceFingerprint: markdown.sourceFingerprint, representation: "markdown", eventFlowProjection: "flow",
    }, controller.captureGeneration())).toBe(false);
    expect(controller.saveSnapshot(markdown.identity, "viewer-a", {
      sourceFingerprint: markdown.sourceFingerprint, representation: "markdown", transformProjection: "flow",
    }, controller.captureGeneration())).toBe(false);
    expect(controller.saveSnapshot(markdown.identity, "viewer-a", {
      sourceFingerprint: markdown.sourceFingerprint, representation: "markdown", markdownScroll: { scrollTop: 15, scrollRatio: Number.NaN, maxScroll: 20 },
    }, controller.captureGeneration())).toBe(false);

    const flow = { ...option("flow", "event A"), representation: "event-flow" as const };
    controller.reconcile({ scope, availability: "ready", options: [flow] });
    controller.select("a", flow);
    expect(controller.saveSnapshot(flow.identity, "viewer-a", {
      sourceFingerprint: flow.sourceFingerprint, representation: "event-flow", eventFlowProjection: "unknown" as never,
    }, controller.captureGeneration())).toBe(false);
  });

  it("rejects a delayed projection callback after suspension and explicit close", () => {
    const controller = createVisualSessionController(scope);
    const flow = { ...option("flow", "event A"), representation: "event-flow" as const };
    controller.reconcile({ scope, availability: "ready", options: [flow] });
    controller.select("a", flow);
    const beforeSuspend = controller.captureGeneration();
    controller.suspend();
    expect(controller.saveSnapshot(flow.identity, "viewer-a", {
      sourceFingerprint: flow.sourceFingerprint, representation: "event-flow", eventFlowProjection: "causal",
    }, beforeSuspend)).toBe(false);
    controller.resume();
    const beforeClose = controller.captureGeneration();
    controller.close();
    expect(controller.saveSnapshot(flow.identity, "viewer-a", {
      sourceFingerprint: flow.sourceFingerprint, representation: "event-flow", eventFlowProjection: "topology",
    }, beforeClose)).toBe(false);
    expect(controller.getState().snapshots.size).toBe(0);
  });

  it("keeps duplicate A/B resources independent and swaps resource plus lineage", () => {
    const controller = createVisualSessionController(scope);
    const shared = option("same", "source");
    const other = option("other", "other-source");
    controller.reconcile({ scope, availability: "ready", options: [shared, other] });
    controller.select("a", shared);
    controller.select("b", shared);
    controller.saveSnapshot(shared.identity, "viewer-a", snapshot("source", 10, "A"), controller.captureGeneration());
    controller.saveSnapshot(shared.identity, "viewer-b", snapshot("source", 20, "B"), controller.captureGeneration());
    expect(controller.getSnapshot(shared.identity, "viewer-a", shared.sourceFingerprint)?.transform?.x).toBe(10);
    expect(controller.getSnapshot(shared.identity, "viewer-b", shared.sourceFingerprint)?.transform?.x).toBe(20);

    controller.select("b", other);
    const before = controller.getState().selections;
    const after = controller.swap().selections;
    expect(after.a).toEqual(before.b);
    expect(after.b).toEqual(before.a);
    expect(after.a?.lineage).toBe("viewer-b");
    expect(after.b?.lineage).toBe("viewer-a");
    controller.select("a", shared);
    expect(controller.getState().selections.a?.lineage).toBe("viewer-b");
  });

  it("enforces a deterministic 40-entry LRU", () => {
    const controller = createVisualSessionController(scope);
    const options = Array.from({ length: MAX_VISUAL_SESSIONS + 1 }, (_, index) => option(`r${index}`, `source-${index}`));
    controller.reconcile({ scope, availability: "ready", options });
    const generation = controller.captureGeneration();
    options.forEach(item => {
      controller.select("a", item);
      controller.saveSnapshot(item.identity, "viewer-a", snapshot(`source-${item.optionId.slice(1)}`, Number(item.optionId.slice(1))), generation);
    });
    const state = controller.getState();
    expect(state.snapshots.size).toBe(MAX_VISUAL_SESSIONS);
    expect(state.snapshots.has(JSON.stringify(["viewer-a", JSON.stringify(["p1", "shared", "shared", "r0"])]))).toBe(false);
    expect(state.snapshots.has(JSON.stringify(["viewer-a", JSON.stringify(["p1", "shared", "shared", "r40"])]))).toBe(true);
  });

  it("ignores stale callbacks after close and keeps reconcile from reopening the closed session", () => {
    const controller = createVisualSessionController(scope);
    const a = option("a", "source-a");
    controller.reconcile({ scope, availability: "ready", options: [a] });
    controller.select("a", a);
    const staleGeneration = controller.captureGeneration();
    controller.close();
    expect(controller.saveSnapshot(a.identity, "viewer-a", snapshot("source-a", 3), staleGeneration)).toBe(false);
    expect(controller.reconcile({ scope, availability: "ready", options: [a] }).selections.a).toBeNull();
    expect(controller.getState().snapshots.size).toBe(0);
  });

  it("reconciles deterministically for identical authorized options", () => {
    const controller = createVisualSessionController(scope);
    const a = option("a", "source-a");
    const b = option("b", "source-b");
    const first = controller.reconcile({ scope, availability: "ready", options: [a, b], initialOptionId: "b" });
    const second = controller.reconcile({ scope, availability: "ready", options: [a, b], initialOptionId: "b" });
    expect(second.selections).toEqual(first.selections);
    expect(second.snapshots).toEqual(first.snapshots);
  });
});
