import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./app-harness";
import ComparisonView, { RevisionDiffSummary, type ComparisonOption, type RevisionComparisonResource } from "../src/features/preview/ComparisonView";
import DualView, { compatibleVisualSnapshot, fingerprintVisualSource, type VisualSessionSnapshot } from "../src/features/preview/DualView";
import type { ProjectIndex } from "../src/domain/project/project-index";
import type { DiagramFile, NoteFile, Project } from "../src/domain/workspace/types";
import type { ResourceDiff } from "../src/domain/diff/resource-diff";
import type { ServerResourceRevision, ServerResourceRevisionSummary, ServerResourceType } from "../src/workspace/server/api-client";
import { exportProjectToZip } from "../src/workspace/transfer/project-archive";
import { defaultUiPreferences, UI_PREFERENCES_KEY, writeUiPreferences } from "../src/workspace/ui-preferences";
import { createVisualSessionController } from "../src/features/preview/visual-session-controller";
import { resourceRepresentationOfName, resourceRepresentationOfType } from "../src/domain/workspace/resource-id";

afterEach(() => {
  cleanup();
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
  delete (document as unknown as Record<string, unknown>).exitFullscreen;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen;
  localStorage.removeItem(UI_PREFERENCES_KEY);
});

const FLOW = [
  "event OrderCreated",
  "event PaymentRequested",
  "producer OrderService",
  "consumer BillingService",
  "OrderService publishes OrderCreated",
  "BillingService consumes OrderCreated",
].join("\n");

async function command(label: string): Promise<void> {
  fireEvent.click(screen.getByTestId("command-palette-button"));
  fireEvent.change(screen.getByTestId("palette-input"), { target: { value: label } });
  await act(async () => fireEvent.click(screen.getByTestId("palette-item-button")));
}

async function project(): Promise<void> {
  fireEvent.click(screen.getByTestId("local-create-toggle"));
  fireEvent.change(screen.getByTestId("project-name-input"), { target: { value: "Compare" } });
  fireEvent.click(screen.getByTestId("create-project-button"));
  await waitFor(() => expect(screen.getByTestId("project-name")).toHaveTextContent("Compare"));
}

async function importResources(project: Project, diagrams: DiagramFile[], notes: NoteFile[] = []): Promise<void> {
  const bytes = exportProjectToZip(project, diagrams, notes);
  const file = new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], "comparison.zip", { type: "application/zip" });
  const input = screen.getByTestId("import-file-input") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => fireEvent.change(input));
}

const revisionResource: RevisionComparisonResource = { projectId: "project", resourceId: "stable-resource", contextId: null, path: "model.concept", type: "conceptual" };
const revisionIndex = { projectId: "project", resources: [], diagrams: [], eventFlows: [], documents: [], participants: [], usages: [], references: [], diagnostics: [] } as ProjectIndex;

function visualControllerFor(options: ComparisonOption[], initialOptionId?: string) {
  const first = options[0];
  const knowledgeContext = first?.context.knowledgeContext;
  const scope = {
    projectId: first?.context.projectId ?? "project",
    contextKind: knowledgeContext?.kind ?? "local",
    contextId: knowledgeContext?.id ?? "local:project",
  };
  const controller = createVisualSessionController(scope, initialOptionId);
  controller.reconcile({
    scope,
    availability: "ready",
    initialOptionId,
    options: visualSessionDescriptors(options),
  });
  return controller;
}

function visualSessionDescriptors(options: ComparisonOption[]) {
  return options.map(option => ({
    optionId: option.id,
    identity: {
      projectId: option.context.projectId,
      contextKind: option.context.knowledgeContext.kind,
      contextId: option.context.knowledgeContext.id,
      resourceId: option.resourceId,
    },
    sourceFingerprint: fingerprintVisualSource(option.source),
    representation: option.representation ?? resourceRepresentationOfName(option.resource.name),
  }));
}

function revisionSnapshot(revision: number, content: string, type: ServerResourceType = "conceptual"): ServerResourceRevision {
  return { ...revisionResource, revision, type, representation: resourceRepresentationOfType(type), content, authoredBy: { kind: "user", userId: "owner", subjectUserId: "owner" }, createdAt: `2026-01-0${revision}T00:00:00.000Z` };
}

function revisionClient(snapshots: ServerResourceRevision[]) {
  const summaries: ServerResourceRevisionSummary[] = snapshots.map(({ resourceId, projectId, contextId, revision, type, representation, createdAt }) => ({ resourceId, projectId, contextId, revision, type, representation, createdAt }));
  return {
    listResourceRevisions: async () => summaries,
    getResourceRevision: async (_projectId: string, _resourceId: string, _contextId: string | null, revision: number) => snapshots.find((snapshot) => snapshot.revision === revision)!,
  };
}

function renderRevisionCompare(snapshots: ServerResourceRevision[], type: ServerResourceType = "conceptual") {
  const path = type === "sequence-diagram" ? "model.seq" : type === "event-flow" ? "model.eventseq" : type === "markdown-document" ? "notes.md" : type === "database" ? "schema.dbschema" : "model.concept";
  const resource: DiagramFile | NoteFile = type === "markdown-document"
    ? { id: "file-id", name: path, markdown: snapshots.at(-1)?.content ?? "", projectId: "project" }
    : { id: "file-id", name: path, source: snapshots.at(-1)?.content ?? "", projectId: "project" };
  return render(<ComparisonView
    primary={resource}
    primarySource={"source" in resource ? resource.source : resource.markdown}
    resources={[resource]}
    index={revisionIndex}
    resourceIdForFile={() => revisionResource.resourceId}
    onExit={() => {}}
    onOpenResource={() => {}}
    maximizedPane={null}
    onMaximize={() => {}}
    onRestore={() => {}}
    maximized={false}
    onToggleMaximize={() => {}}
    revisionClient={revisionClient(snapshots)}
    revisionResource={{ ...revisionResource, path, type }}
  />);
}

describe("App — dual viewer foundation", () => {
  it("opens Dual View for independent note and diagram exploration without diff UI", async () => {
    render(<App />);
    const note: NoteFile = { id: "overview-note", name: "overview.md", projectId: "dual", markdown: "# Architecture\n\nIndependent note." };
    const diagram: DiagramFile = { id: "domain-diagram", name: "domain.concept", projectId: "dual", source: 'concept account "Account"' };
    await importResources({ id: "dual", name: "Dual", datasetIds: [diagram.id], noteIds: [note.id] }, [diagram], [note]);
    fireEvent.click(screen.getByTestId("compare-mode-button"));

    expect(screen.getByTestId("dual-view")).toBeInTheDocument();
    expect(screen.getByTestId("dual-pane-a")).toHaveTextContent("LOCAL");
    expect(screen.getByTestId("dual-pane-b")).toHaveTextContent("LOCAL");
    expect(screen.getAllByTestId("dual-pane-a")).toHaveLength(1);
    expect(screen.getByTestId("dual-view")).toHaveTextContent("overview.md");
    expect(screen.getByTestId("dual-view")).toHaveTextContent("domain.concept");
    expect(screen.queryByTestId("comparison-markdown-diff")).toBeNull();
    expect(screen.queryByTestId("semantic-comparison-summary")).toBeNull();
    expect(screen.queryByTestId("comparison-parallel-view-notice")).toBeNull();
  });

  it("maximizes by the current A/B slot without unmounting or disabling the other session", async () => {
    render(<App />);
    const diagrams: DiagramFile[] = [
      { id: "alpha", name: "alpha.concept", projectId: "dual", source: 'concept alpha "Alpha"' },
      { id: "beta", name: "beta.concept", projectId: "dual", source: 'concept beta "Beta"' },
      { id: "gamma", name: "gamma.concept", projectId: "dual", source: 'concept gamma "Gamma"' },
    ];
    await importResources({ id: "dual", name: "Dual", datasetIds: diagrams.map(item => item.id), noteIds: [] }, diagrams);
    fireEvent.click(screen.getByTestId("compare-mode-button"));

    const dualView = screen.getByTestId("dual-view");
    const slot = (pane: "a" | "b") => dualView.querySelector<HTMLElement>(`.comparison__slot[data-pane="${pane}"]`)!;
    const maximizeA = screen.getByRole("button", { name: "Maximize Viewer A" });
    maximizeA.focus();
    fireEvent.click(maximizeA);
    expect(dualView).toHaveAttribute("data-maximized-pane", "a");
    expect(maximizeA).toHaveAttribute("aria-pressed", "true");
    expect(document.activeElement).toBe(maximizeA);
    expect(slot("a")).not.toHaveClass("comparison__slot--hidden");
    expect(slot("b")).toHaveClass("comparison__slot--hidden");
    expect(slot("b")).toHaveAttribute("aria-hidden", "true");
    expect(slot("b")).toHaveAttribute("inert");
    expect(screen.getByTestId("dual-pane-b")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(dualView).toHaveClass("dual-view--focus");
    expect(dualView).toHaveAttribute("data-maximized-pane", "a");
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
    Object.defineProperty(dualView, "requestFullscreen", { configurable: true, value: vi.fn(async () => {
      fullscreenElement = dualView;
      document.dispatchEvent(new Event("fullscreenchange"));
    }) });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: vi.fn(async () => {
      fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    }) });
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));
    expect(await screen.findByRole("button", { name: "Exit fullscreen" })).toHaveAttribute("aria-pressed", "true");
    expect(dualView).toHaveAttribute("data-maximized-pane", "a");
    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
    expect(await screen.findByRole("button", { name: "Fullscreen" })).toHaveAttribute("aria-pressed", "false");
    expect(dualView).toHaveClass("dual-view--focus");
    fireEvent.click(screen.getByRole("button", { name: "Exit Focus" }));
    expect(dualView).not.toHaveClass("dual-view--focus");
    expect(dualView).toHaveAttribute("data-maximized-pane", "a");

    const selectA = screen.getByRole("combobox", { name: "Dual View A resource" });
    const selectB = screen.getByRole("combobox", { name: "Dual View B resource" });
    const gammaId = Array.from((selectA as HTMLSelectElement).options).find(option => option.textContent?.includes("gamma.concept"))?.value;
    const alphaId = Array.from((selectA as HTMLSelectElement).options).find(option => option.textContent?.includes("alpha.concept"))?.value;
    expect(gammaId).toBeDefined();
    expect(alphaId).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Swap dual viewers" }));
    expect(dualView).toHaveAttribute("data-maximized-pane", "a");
    expect(slot("a")).not.toHaveClass("comparison__slot--hidden");
    expect(slot("b")).toHaveClass("comparison__slot--hidden");
    fireEvent.change(selectA, { target: { value: gammaId } });
    expect(screen.getByTestId("dual-pane-a")).toHaveTextContent("gamma.concept");
    expect(dualView).toHaveAttribute("data-maximized-pane", "a");

    const restoreA = screen.getByRole("button", { name: "Restore Viewer A" });
    fireEvent.click(restoreA);
    expect(dualView).toHaveAttribute("data-maximized-pane", "normal");
    expect(document.activeElement).toBe(restoreA);
    expect(slot("a")).not.toHaveClass("comparison__slot--hidden");
    expect(slot("b")).not.toHaveClass("comparison__slot--hidden");
    expect(slot("b")).not.toHaveAttribute("inert");

    fireEvent.change(selectB, { target: { value: alphaId } });
    expect(screen.getByTestId("dual-pane-a")).toHaveTextContent("gamma.concept");
    expect(screen.getByTestId("dual-pane-b")).toHaveTextContent("alpha.concept");
    fireEvent.click(screen.getByRole("button", { name: "Maximize Viewer B" }));
    expect(dualView).toHaveAttribute("data-maximized-pane", "b");
    expect(slot("a")).toHaveClass("comparison__slot--hidden");
    expect(slot("b")).not.toHaveClass("comparison__slot--hidden");
    fireEvent.click(screen.getByRole("button", { name: "Restore Viewer B" }));
    expect(dualView).toHaveAttribute("data-maximized-pane", "normal");

    fireEvent.change(selectA, { target: { value: alphaId } });
    fireEvent.change(selectB, { target: { value: alphaId } });
    expect(screen.getByTestId("dual-pane-a")).toHaveTextContent("alpha.concept");
    expect(screen.getByTestId("dual-pane-b")).toHaveTextContent("alpha.concept");
    fireEvent.click(screen.getByRole("button", { name: "Maximize Viewer A" }));
    expect(screen.getByTestId("dual-pane-a")).toBeInTheDocument();
    expect(screen.getByTestId("dual-pane-b")).toBeInTheDocument();
    expect(slot("b")).toHaveAttribute("aria-hidden", "true");
  });

  it("resets local Dual View maximization when navigating to Analysis and returning", async () => {
    render(<App />);
    const diagrams: DiagramFile[] = [
      { id: "one", name: "one.concept", projectId: "dual", source: 'concept one "One"' },
      { id: "two", name: "two.concept", projectId: "dual", source: 'concept two "Two"' },
    ];
    await importResources({ id: "dual", name: "Dual", datasetIds: diagrams.map(item => item.id), noteIds: [] }, diagrams);
    fireEvent.click(screen.getByTestId("compare-mode-button"));
    fireEvent.click(screen.getByRole("button", { name: "Maximize Viewer B" }));
    expect(screen.getByTestId("dual-view")).toHaveAttribute("data-maximized-pane", "b");
    fireEvent.click(screen.getByRole("button", { name: "Switch to Analysis" }));
    expect(screen.queryByTestId("dual-view")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Switch to Dual View" }));
    expect(screen.getByTestId("dual-view")).toHaveAttribute("data-maximized-pane", "normal");
    fireEvent.click(screen.getByRole("button", { name: "Maximize Viewer A" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Dual View" }));
    fireEvent.click(screen.getByTestId("compare-mode-button"));
    expect(screen.getByTestId("dual-view")).toHaveAttribute("data-maximized-pane", "normal");
  });

  it("changes only one Dual View resource and swaps the rendered sessions", async () => {
    render(<App />);
    const diagrams: DiagramFile[] = [
      { id: "a", name: "a.concept", projectId: "dual", source: 'concept alpha "Alpha"' },
      { id: "b", name: "b.dbschema", projectId: "dual", source: 'table beta - "Beta"' },
      { id: "c", name: "c.seq", projectId: "dual", source: "participant Gamma" },
    ];
    await importResources({ id: "dual", name: "Dual", datasetIds: diagrams.map(item => item.id), noteIds: [] }, diagrams);
    fireEvent.click(screen.getByTestId("compare-mode-button"));
    const selectA = screen.getByRole("combobox", { name: "Dual View A resource" });
    const selectB = screen.getByRole("combobox", { name: "Dual View B resource" });
    const bBefore = (selectB as HTMLSelectElement).value;
    const cId = Array.from((selectA as HTMLSelectElement).options).find(option => option.textContent?.includes("c.seq"))?.value;
    expect(cId).toBeDefined();
    fireEvent.change(selectA, { target: { value: cId } });
    expect(selectA).toHaveValue(cId);
    expect(selectB).toHaveValue(bBefore);
    expect(screen.getByTestId("dual-pane-a")).toHaveTextContent("c.seq");
    expect(screen.getByTestId("dual-pane-b")).toHaveTextContent("b.dbschema");
    fireEvent.click(screen.getByRole("button", { name: "Swap dual viewers" }));
    expect(selectA).toHaveValue(bBefore);
    expect(selectB).toHaveValue(cId);
    expect(screen.getByTestId("dual-pane-a")).toHaveTextContent("b.dbschema");
    expect(screen.getByTestId("dual-pane-b")).toHaveTextContent("c.seq");
  });

  it("disables editor tabs and Explorer artifact opening only while Dual View owns navigation", async () => {
    render(<App />);
    await project();
    const diagrams: DiagramFile[] = [
      { id: "one", name: "one.concept", projectId: "dual", source: 'concept one "One"' },
      { id: "two", name: "two.concept", projectId: "dual", source: 'concept two "Two"' },
    ];
    await importResources({ id: "dual", name: "Dual", datasetIds: diagrams.map(item => item.id), noteIds: [] }, diagrams);
    const editorTabs = ["view-code", "view-outline", "view-problems", "view-overview", "view-history"];
    for (const testId of editorTabs) expect(screen.getByTestId(testId)).toBeEnabled();
    const openers = screen.getAllByTestId("select-diagram-button");
    const selectedBefore = document.querySelector(".explorer__diagram--selected")?.textContent;

    fireEvent.click(screen.getByTestId("compare-mode-button"));
    for (const testId of editorTabs) expect(screen.getByTestId(testId)).toBeDisabled();
    expect(screen.getByTestId("dual-view")).toHaveTextContent("Usa los selectores Viewer A/B para cambiar los recursos mientras comparas");
    expect(screen.getByRole("combobox", { name: "Dual View A resource" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Dual View B resource" })).toBeEnabled();
    for (const opener of openers) expect(opener).toBeDisabled();
    fireEvent.click(openers.find(button => !button.closest(".explorer__diagram--selected"))!);
    expect(document.querySelector(".explorer__diagram--selected")?.textContent).toBe(selectedBefore);
    expect(screen.getByRole("combobox", { name: "Dual View A resource" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Close Dual View" }));
    for (const testId of editorTabs) expect(screen.getByTestId(testId)).toBeEnabled();
    expect(screen.getAllByTestId("select-diagram-button").every(button => !(button as HTMLButtonElement).disabled)).toBe(true);
  });

  it("keeps Analysis immersive regardless of the editor visibility preference", async () => {
    writeUiPreferences({ ...defaultUiPreferences(), screens: { ...defaultUiPreferences().screens, comparison: { ...defaultUiPreferences().screens.comparison, editorHidden: false } } });
    render(<App />);
    await project();
    await command("New Diagram");
    await command("New Diagram");
    const preferencesBefore = localStorage.getItem(UI_PREFERENCES_KEY);
    fireEvent.click(screen.getByTestId("analysis-mode-button"));
    expect(screen.getByTestId("view-overview")).toBeDisabled();
    expect(document.querySelector(".app__workspace")).toHaveClass("app__workspace--immersive");
    expect(localStorage.getItem(UI_PREFERENCES_KEY)).toBe(preferencesBefore);
    fireEvent.click(screen.getByRole("button", { name: "Close comparison" }));
    expect(screen.getByTestId("view-overview")).toBeEnabled();
    expect(localStorage.getItem(UI_PREFERENCES_KEY)).toBe(preferencesBefore);
    cleanup();
    writeUiPreferences(defaultUiPreferences());
    render(<App />);
    await project();
    await command("New Diagram");
    fireEvent.click(screen.getByTestId("analysis-mode-button"));
    for (const testId of ["view-code", "view-outline", "view-problems", "view-overview", "view-history"]) {
      expect(screen.getByTestId(testId)).toBeDisabled();
    }
    expect(screen.getByTestId("comparison-view")).toHaveTextContent("Usa los selectores Viewer A/B para cambiar los recursos mientras comparas");
    fireEvent.click(screen.getByRole("button", { name: "Close comparison" }));
    expect(screen.getByTestId("view-code")).toBeEnabled();
    expect(screen.getAllByTestId("select-diagram-button").every(button => !(button as HTMLButtonElement).disabled)).toBe(true);
  });

  it("isolates camera state and carries it with its resource when panel positions are swapped", async () => {
    render(<App />);
    const diagrams: DiagramFile[] = [
      { id: "one", name: "one.concept", projectId: "dual", source: 'concept alpha "Alpha"' },
      { id: "two", name: "two.concept", projectId: "dual", source: 'concept beta "Beta"' },
    ];
    await importResources({ id: "dual", name: "Dual", datasetIds: diagrams.map(item => item.id), noteIds: [] }, diagrams);
    fireEvent.click(screen.getByTestId("compare-mode-button"));
    const paneA = screen.getByTestId("dual-pane-a");
    await waitFor(() => expect(paneA.querySelector("[data-testid='conceptual-preview-svg']")).not.toBeNull());
    const paneB = screen.getByTestId("dual-pane-b");
    const svgA = paneA.querySelector("[data-testid='conceptual-preview-svg']") as HTMLElement;
    const svgB = paneB.querySelector("[data-testid='conceptual-preview-svg']") as HTMLElement;
    const cameraB = svgB.style.transform;
    fireEvent.click(within(paneA).getByTestId("zoom-in"));
    await waitFor(() => expect(svgA.style.transform).not.toBe("translate(0px, 0px) scale(1)"));
    expect(svgB.style.transform).toBe(cameraB);
    const cameraA = svgA.style.transform;
    fireEvent.click(screen.getByRole("button", { name: "Swap dual viewers" }));
    expect(screen.getByTestId("dual-pane-b").querySelector("[data-testid='conceptual-preview-svg']")?.getAttribute("style")).toContain(cameraA);
    expect(screen.getByTestId("dual-pane-a").querySelector("[data-testid='conceptual-preview-svg']")?.getAttribute("style")).toContain(cameraB);
  });

  it("restores the actual camera and selected node after leaving and returning to a resource", async () => {
    const option = (id: string, source: string): ComparisonOption => {
      const resource: DiagramFile = { id, name: `${id}.concept`, projectId: "project", source };
      return { id, resource, resourceId: id, representation: "conceptual", source, context: { projectId: "project", knowledgeContext: { kind: "local", id: "local:project", projectId: "project" }, index: revisionIndex, resourceId: id }, label: id };
    };
    const options = [option("one", 'concept alpha "Alpha"'), option("two", 'concept beta "Beta"'), option("three", 'concept gamma "Gamma"')];
    render(<DualView options={options} controller={visualControllerFor(options, "one")} projectId="project" onExit={() => {}} />);
    const paneA = () => screen.getByTestId("dual-pane-a");
    const paneB = () => screen.getByTestId("dual-pane-b");
    await waitFor(() => expect(paneA().querySelector("[data-testid='conceptual-preview-svg'] svg")).not.toBeNull());
    const svgA = () => paneA().querySelector("[data-testid='conceptual-preview-svg']") as HTMLElement;
    fireEvent.click(within(paneA()).getByTestId("zoom-in"));
    fireEvent.click(paneA().querySelector('[data-concept-id="alpha"]')!);
    await waitFor(() => expect(paneA().querySelector('[data-concept-id="alpha"]')).toHaveClass("svg-node--active"));
    const originalTransform = svgA().style.transform;
    expect(originalTransform).not.toBe("");

    const selectA = screen.getByRole("combobox", { name: "Dual View A resource" });
    fireEvent.change(selectA, { target: { value: "three" } });
    await waitFor(() => expect(paneA().querySelector("[data-concept-id='gamma']")).not.toBeNull());
    fireEvent.change(selectA, { target: { value: "one" } });
    await waitFor(() => expect(paneA().querySelector('[data-concept-id="alpha"]')).toHaveClass("svg-node--active"));
    expect(svgA().style.transform).toBe(originalTransform);
    expect(paneB().querySelector("[data-concept-id='beta']")).not.toBeNull();
  });

  it("rejects cached camera and selection when the effective source changes", async () => {
    const option = (id: string, source: string): ComparisonOption => {
      const resource: DiagramFile = { id, name: `${id}.concept`, projectId: "project", source };
      return { id, resource, resourceId: id, representation: "conceptual", source, context: { projectId: "project", knowledgeContext: { kind: "local", id: "local:project", projectId: "project" }, index: revisionIndex, resourceId: id }, label: id };
    };
    const first = option("stable-resource", 'concept alpha "Alpha"');
    const second = option("other-resource", 'concept beta "Beta"');
    const controller = visualControllerFor([first, second], first.id);
    const view = render(<DualView options={[first, second]} controller={controller} projectId="project" onExit={() => {}} />);
    const paneA = () => screen.getByTestId("dual-pane-a");
    await waitFor(() => expect(paneA().querySelector("[data-testid='conceptual-preview-svg'] svg")).not.toBeNull());
    fireEvent.click(within(paneA()).getByTestId("zoom-in"));
    fireEvent.click(paneA().querySelector('[data-concept-id="alpha"]')!);
    await waitFor(() => expect(paneA().querySelector('[data-concept-id="alpha"]')).toHaveClass("svg-node--active"));
    const oldTransform = paneA().querySelector('[data-testid="conceptual-preview-svg"]')?.getAttribute("style");
    const priorSnapshot: VisualSessionSnapshot = { sourceFingerprint: fingerprintVisualSource(first.source), transform: { x: 23, y: -14, scale: 1.25 }, selectedNodeId: "alpha" };
    expect(fingerprintVisualSource(first.source)).not.toBe(fingerprintVisualSource('concept beta "Beta"'));
    expect(compatibleVisualSnapshot(priorSnapshot, 'concept beta "Beta"')).toBeNull();
    const updatedOptions = [option("stable-resource", 'concept beta "Beta"'), second];
    controller.reconcile({ scope: controller.getState().scope, availability: "ready", initialOptionId: first.id, options: visualSessionDescriptors(updatedOptions) });
    view.rerender(<DualView options={updatedOptions} controller={controller} projectId="project" onExit={() => {}} />);
    await waitFor(() => expect(paneA().querySelector('[data-concept-id="beta"]')).not.toBeNull());
    expect(paneA().querySelector('[data-concept-id="alpha"]')).toBeNull();
    const invalidatedTransform = paneA().querySelector('[data-testid="conceptual-preview-svg"]')?.getAttribute("style");
    expect(invalidatedTransform).not.toBe(oldTransform);
    expect(paneA().querySelector(".svg-node--active")).toBeNull();
    fireEvent.click(within(paneA()).getByRole("button", { name: "Fit diagram to view" }));
    expect(paneA().querySelector('[data-testid="conceptual-preview-svg"]')?.getAttribute("style")).toBe(invalidatedTransform);
    const selectA = screen.getByRole("combobox", { name: "Dual View A resource" });
    fireEvent.change(selectA, { target: { value: "other-resource" } });
    await waitFor(() => expect(paneA().querySelector('[data-concept-id="beta"]')).toBeNull());
    fireEvent.change(selectA, { target: { value: "stable-resource" } });
    await waitFor(() => expect(paneA().querySelector('[data-concept-id="beta"]')).not.toBeNull());
    expect(paneA().querySelector(".svg-node--active")).toBeNull();
    expect(paneA().querySelector('[data-testid="conceptual-preview-svg"]')?.getAttribute("style")).toBe(invalidatedTransform);
  });

  it("keeps independent visual sessions when the same resource occupies both viewers", async () => {
    const context = { projectId: "project", knowledgeContext: { kind: "local" as const, id: "local:project", projectId: "project" }, index: revisionIndex, resourceId: "same-resource" };
    const source = 'concept alpha "Alpha"\nconcept beta "Beta"';
    const resource: DiagramFile = { id: "same-resource", name: "same.concept", projectId: "project", source };
    const same: ComparisonOption = { id: "same", resource, resourceId: "same-resource", representation: "conceptual", source, context, label: "same" };
    const otherResource: DiagramFile = { id: "other", name: "other.concept", projectId: "project", source: 'concept other "Other"' };
    const other: ComparisonOption = { id: "other", resource: otherResource, resourceId: "other", representation: "conceptual", source: otherResource.source, context: { ...context, resourceId: "other" }, label: "other" };
    render(<DualView options={[same, other]} controller={visualControllerFor([same, other], "same")} projectId="project" onExit={() => {}} />);
    const selectB = screen.getByRole("combobox", { name: "Dual View B resource" });
    fireEvent.change(selectB, { target: { value: "same" } });
    const paneA = () => screen.getByTestId("dual-pane-a");
    const paneB = () => screen.getByTestId("dual-pane-b");
    await waitFor(() => expect(paneA().querySelector('[data-concept-id="alpha"]')).not.toBeNull());
    await waitFor(() => expect(paneB().querySelector('[data-concept-id="alpha"]')).not.toBeNull());
    fireEvent.click(within(paneA()).getByTestId("zoom-in"));
    fireEvent.click(paneA().querySelector('[data-concept-id="alpha"]')!);
    fireEvent.click(within(paneB()).getByTestId("zoom-in"));
    fireEvent.click(within(paneB()).getByTestId("zoom-in"));
    fireEvent.click(paneB().querySelector('[data-concept-id="beta"]')!);
    await waitFor(() => expect(paneA().querySelector('[data-concept-id="alpha"]')).toHaveClass("svg-node--active"));
    await waitFor(() => expect(paneB().querySelector('[data-concept-id="beta"]')).toHaveClass("svg-node--active"));
    const transformA = paneA().querySelector('[data-testid="conceptual-preview-svg"]')?.getAttribute("style");
    const transformB = paneB().querySelector('[data-testid="conceptual-preview-svg"]')?.getAttribute("style");
    expect(transformA).not.toBe(transformB);

    fireEvent.click(screen.getByRole("button", { name: "Swap dual viewers" }));
    await waitFor(() => expect(paneA().querySelector('[data-concept-id="beta"]')).toHaveClass("svg-node--active"));
    expect(paneA().querySelector('[data-testid="conceptual-preview-svg"]')?.getAttribute("style")).toBe(transformB);
    expect(paneB().querySelector('[data-concept-id="alpha"]')).toHaveClass("svg-node--active");
    expect(paneB().querySelector('[data-testid="conceptual-preview-svg"]')?.getAttribute("style")).toBe(transformA);
  });

  it("tracks fullscreen, keeps Focus during Escape dispatch, then restores Focus on exit", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    const preferencesBefore = localStorage.getItem(UI_PREFERENCES_KEY);
    const pane = document.querySelector(".app__pane--preview") as HTMLElement;
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
    Object.defineProperty(pane, "requestFullscreen", { configurable: true, value: vi.fn(async () => {
      fullscreenElement = pane;
      document.dispatchEvent(new Event("fullscreenchange"));
    }) });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: vi.fn(async () => {
      fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    }) });

    fireEvent.click(screen.getByTestId("viewer-fullscreen-toggle"));
    expect(await screen.findByRole("button", { name: "Exit fullscreen" })).toHaveAttribute("aria-pressed", "true");
    fullscreenElement = null;
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(await screen.findByRole("button", { name: "Enter fullscreen" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByTestId("viewer-fullscreen-toggle"));
    expect(await screen.findByRole("button", { name: "Exit fullscreen" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("viewer-focus-toggle"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(document.querySelector(".app__workspace")).toHaveClass("app__workspace--focus");
    fireEvent.click(screen.getByTestId("viewer-fullscreen-toggle"));
    expect(await screen.findByRole("button", { name: "Enter fullscreen" })).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelector(".app__workspace")).toHaveClass("app__workspace--focus");
    fullscreenElement = document.createElement("div");
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(screen.getByTestId("viewer-fullscreen-toggle")).toHaveAttribute("aria-pressed", "false");
    fullscreenElement = null;
    document.dispatchEvent(new Event("fullscreenchange"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(document.querySelector(".app__workspace")).not.toHaveClass("app__workspace--focus");
    expect(localStorage.getItem(UI_PREFERENCES_KEY)).toBe(preferencesBefore);
  });

  it("does not mark fullscreen active when the API is unavailable or rejects", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    const button = screen.getByTestId("viewer-fullscreen-toggle");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute("title", expect.stringContaining("unavailable"));

    const pane = document.querySelector(".app__pane--preview") as HTMLElement;
    Object.defineProperty(pane, "requestFullscreen", { configurable: true, value: vi.fn().mockRejectedValue(new Error("denied")) });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("title", expect.stringContaining("unavailable")));
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("focuses the mounted viewer with the two-key chord and restores camera and focus after Escape", async () => {
    const saved = defaultUiPreferences();
    saved.shell.explorerWidth = 342;
    saved.shell.editorWidth = 390;
    writeUiPreferences(saved);
    render(<App />);
    await project();
    await command("New Diagram");

    const editor = screen.getByTestId("dsl-textarea");
    fireEvent.keyDown(editor, { key: ";", ctrlKey: true });
    expect(document.querySelector(".app__workspace")).not.toHaveClass("app__workspace--focus");
    editor.blur();
    fireEvent.keyDown(document.body, { key: ";", ctrlKey: true });
    expect(document.querySelector(".app__workspace")).toHaveClass("app__workspace--focus");
    fireEvent.keyDown(document.body, { key: ";", ctrlKey: true });
    expect(document.querySelector(".app__workspace")).not.toHaveClass("app__workspace--focus");

    const viewportSvg = await screen.findByTestId("preview-svg");
    fireEvent.click(screen.getByTestId("zoom-in"));
    const cameraBefore = viewportSvg.style.transform;
    const preferencesBefore = localStorage.getItem(UI_PREFERENCES_KEY);
    const focusButton = screen.getByTestId("viewer-focus-toggle");
    fireEvent.keyDown(focusButton, { key: ";", ctrlKey: true });
    expect(document.querySelector(".app__workspace")).not.toHaveClass("app__workspace--focus");

    fireEvent.click(focusButton);
    const workspace = document.querySelector(".app__workspace")!;
    expect(workspace).toHaveClass("app__workspace--focus");
    expect(screen.getByTestId("preview-svg")).toBe(viewportSvg);
    expect(localStorage.getItem(UI_PREFERENCES_KEY)).toBe(preferencesBefore);
    expect(screen.getByRole("button", { name: /Exit focus/ })).toBeInTheDocument();
    expect(screen.getAllByTestId("viewer-focus-toggle")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("command-palette-button"));
    fireEvent.keyDown(screen.getByTestId("palette-input"), { key: "Escape" });
    expect(workspace).toHaveClass("app__workspace--focus");

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(workspace).not.toHaveClass("app__workspace--focus");
    expect(viewportSvg.style.transform).toBe(cameraBefore);
    expect(document.activeElement).toBe(screen.getByTestId("viewer-focus-toggle"));
    expect(screen.getByRole("region", { name: "Project explorer" })).toBeInTheDocument();
    expect(localStorage.getItem(UI_PREFERENCES_KEY)).toBe(preferencesBefore);
  });

  it("labels same-path SHARED and MY WORK diagrams as distinct selectable versions", () => {
    const shared: DiagramFile = { id: "shared-file", name: "checkout.seq", source: "participant Shared", projectId: "p" };
    const work: DiagramFile = { id: "work-file", name: "checkout.seq", source: "participant Work", projectId: "p" };
    const index = { projectId: "p", resources: [], diagrams: [], eventFlows: [], documents: [], participants: [], usages: [], references: [], diagnostics: [] } as ProjectIndex;
    const options: ComparisonOption[] = [
      { id: "shared:r1", resource: shared, resourceId: "r1", representation: "sequence", source: shared.source, label: "SHARED · checkout.seq", context: { projectId: "p", knowledgeContext: { kind: "shared", id: "shared:p", projectId: "p" }, index, resourceId: "r1" } },
      { id: "my-work:work1:r1", resource: work, resourceId: "r1", representation: "sequence", source: work.source, label: "MY WORK · checkout.seq", context: { projectId: "p", knowledgeContext: { kind: "private-work", id: "work1", projectId: "p", ownerUserId: "u", name: "Draft", lifecycle: "active", createdAt: new Date(0), updatedAt: new Date(0) }, index, resourceId: "r1" } },
    ];
    render(<ComparisonView primary={work} primarySource={work.source} resources={[work]} index={index} resourceIdForFile={() => "r1"} comparisonOptions={options} primaryOptionId="my-work:work1:r1" onExit={() => {}} onOpenResource={() => {}} maximizedPane={null} onMaximize={() => {}} onRestore={() => {}} maximized={false} onToggleMaximize={() => {}} />);

    expect(screen.getByRole("option", { name: "SHARED · checkout.seq" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "MY WORK · checkout.seq" })).toBeInTheDocument();
    expect(screen.getByTestId("comparison-pane-a")).toHaveTextContent("MY WORK · Draft");
    fireEvent.click(screen.getByRole("button", { name: "Swap viewers" }));
    expect(screen.getByTestId("comparison-pane-a")).toHaveTextContent("SHARED");
    expect(screen.getByTestId("comparison-pane-a")).toHaveTextContent("Shared");
  });

  it("uses supplied context provenance and drops a pane when its authorized option disappears", async () => {
    const shared: DiagramFile = { id: "shared-file", name: "checkout.seq", source: "participant Shared", projectId: "p" };
    const work: DiagramFile = { id: "work-file", name: "checkout.seq", source: "participant Work", projectId: "p" };
    const index = { projectId: "p", resources: [], diagrams: [], eventFlows: [], documents: [], participants: [], usages: [], references: [], diagnostics: [] } as ProjectIndex;
    const options: ComparisonOption[] = [
      { id: "shared:r1", resource: shared, resourceId: "r1", representation: "sequence", source: shared.source, label: "SHARED · checkout.seq", context: { projectId: "p", knowledgeContext: { kind: "shared", id: "shared:p", projectId: "p" }, index, resourceId: "r1" } },
      { id: "my-work:work1:r1", resource: work, resourceId: "r1", representation: "sequence", source: work.source, label: "MY WORK · Draft", context: { projectId: "p", knowledgeContext: { kind: "private-work", id: "work1", projectId: "p", ownerUserId: "u", name: "Draft", lifecycle: "active", createdAt: new Date(0), updatedAt: new Date(0) }, index, resourceId: "r1" } },
    ];
    const controller = visualControllerFor(options, "my-work:work1:r1");
    const view = render(<DualView options={options} controller={controller} projectId="p" onExit={() => {}} />);
    expect(screen.getByTestId("dual-pane-a")).toHaveTextContent("MY WORK · Draft");
    expect(screen.getByTestId("dual-pane-b")).toHaveTextContent("SHARED");
    const remainingOptions = [options[0]!];
    controller.reconcile({ scope: controller.getState().scope, availability: "ready", options: visualSessionDescriptors(remainingOptions) });
    view.rerender(<DualView options={remainingOptions} controller={controller} projectId="p" onExit={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("dual-pane-a")).toHaveTextContent("SHARED"));
    expect(screen.queryByText("participant Work")).toBeNull();
  });

  it("enters and exits Sequence to Sequence comparison", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    await command("New Diagram");
    fireEvent.click(screen.getByTestId("analysis-mode-button"));

    expect(screen.getByTestId("comparison-view")).toBeInTheDocument();
    expect(screen.getByTestId("comparison-pane-a")).toBeInTheDocument();
    expect(screen.getByTestId("comparison-pane-b")).toBeInTheDocument();
    expect(screen.getAllByTestId("preview-svg")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Close comparison" }));
    expect(screen.queryByTestId("comparison-view")).toBeNull();
    expect(screen.getByLabelText("DSL editor")).toBeInTheDocument();
  });

  it("supports Event Flow to Sequence and isolates Event Flow projection controls", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    await command("New Event Flow");
    await command("New Diagram");
    // Return to the event flow as Viewer A; the sequence remains available as B.
    const eventFlowButton = screen
      .getAllByTestId("select-diagram-button")
      .find((button) => button.getAttribute("aria-label")?.includes("eventseq"));
    expect(eventFlowButton).toBeDefined();
    fireEvent.click(eventFlowButton!);
    fireEvent.change(screen.getByTestId("dsl-textarea"), { target: { value: FLOW } });
    await waitFor(() => expect(screen.getByTestId("preview-svg")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("analysis-mode-button"));

    expect(screen.getByTestId("comparison-pane-a")).toHaveTextContent("Event Flow");
    expect(screen.getByTestId("comparison-pane-b")).toHaveTextContent("Sequence diagram");
    expect(screen.getAllByTestId("comparison-pane-a").length).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Catalog" }));
    expect(screen.getByTestId("event-catalog")).toBeInTheDocument();
    expect(screen.getAllByTestId("event-flow-preview")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Close comparison" }));
  });

  it("opens Compare for a selected Note and shows a real text diff", async () => {
    render(<App />);
    const notes: NoteFile[] = [
      { id: "before", name: "before.md", projectId: "notes", markdown: "# Policy\n\nUnchanged context.\nOld rule.\n" },
      { id: "after", name: "after.md", projectId: "notes", markdown: "# Policy\n\nUnchanged context.\nNew rule.\nAdded rule.\n" },
    ];
    await importResources({ id: "notes", name: "Notes", datasetIds: [], noteIds: notes.map((note) => note.id) }, [], notes);

    expect(screen.getByTestId("analysis-mode-button")).toBeEnabled();
    fireEvent.click(screen.getByTestId("analysis-mode-button"));
    expect(screen.getByTestId("comparison-markdown-diff")).toBeInTheDocument();
    expect(within(screen.getByTestId("comparison-pane-a")).getByText("LOCAL")).toBeInTheDocument();
    expect(within(screen.getByTestId("comparison-pane-b")).getByText("LOCAL")).toBeInTheDocument();
    expect(screen.getByTestId("comparison-markdown-diff")).toHaveTextContent("Unchanged context.");
    expect(screen.getByTestId("comparison-markdown-diff")).toHaveTextContent("Old rule.");
    expect(screen.getByTestId("comparison-markdown-diff")).toHaveTextContent("New rule.");
    expect(screen.getByTestId("comparison-markdown-diff")).toHaveTextContent("Added rule.");
  });

  it("renders Conceptual and Database with their native previews and labels parallel views", async () => {
    render(<App />);
    const diagrams: DiagramFile[] = [
      { id: "concept", name: "model.concept", projectId: "models", source: 'concept customer "Customer"\nconcept order "Order"\nrelation places customer -> order "places"' },
      { id: "database", name: "schema.dbschema", projectId: "models", source: 'table customers - "Customers"\ncolumn customers id "id" {uuid} not-null' },
    ];
    await importResources({ id: "models", name: "Models", datasetIds: diagrams.map((diagram) => diagram.id), noteIds: [] }, diagrams);
    fireEvent.click(screen.getByTestId("analysis-mode-button"));

    await waitFor(() => expect(screen.getAllByTestId("conceptual-preview-svg")).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByTestId("database-preview-svg")).toHaveLength(1));
    expect(screen.getByTestId("comparison-parallel-view-notice")).toHaveTextContent("no compatible diff");
    expect(screen.queryByTestId("semantic-comparison-summary")).toBeNull();
  });

  it("does not carry a Conceptual node selection into a different Database resource", async () => {
    render(<App />);
    const diagrams: DiagramFile[] = [
      { id: "concept", name: "domain.concept", projectId: "models", source: 'concept account "Account"\nconcept invoice "Invoice"\nrelation owns account -> invoice "owns"' },
      { id: "database", name: "schema.dbschema", projectId: "models", source: 'table accounts - "Accounts"\ncolumn accounts accounts_id "id" {uuid} not-null\nprimary-key accounts_pk accounts (id)\ntable invoices - "Invoices"\ncolumn invoices invoices_id "id" {uuid} not-null\ncolumn invoices invoices_account_id "account_id" {uuid} not-null\nprimary-key invoices_pk invoices (id)\nforeign-key invoice_account invoices (account_id) -> accounts (id)' },
    ];
    await importResources({ id: "models", name: "Models", datasetIds: diagrams.map((diagram) => diagram.id), noteIds: [] }, diagrams);

    fireEvent.click(screen.getByRole("button", { name: "Load diagram domain.concept" }));
    const concept = document.querySelector('[data-testid="conceptual-preview-svg"] [data-node-id="account"]');
    expect(concept).not.toBeNull();
    fireEvent.click(concept!);
    await waitFor(() => expect(concept).toHaveClass("svg-node--active"));

    fireEvent.click(screen.getByRole("button", { name: "Load diagram schema.dbschema" }));
    await waitFor(() => expect((screen.getByTestId("dsl-textarea") as HTMLTextAreaElement).value).toBe(diagrams[1]!.source));
    await waitFor(() => expect(screen.getByTestId("database-preview-svg")).toBeInTheDocument());
    expect(screen.getByTestId("database-preview-svg").querySelectorAll(".database__table.is-unrelated")).toHaveLength(0);
  });

  it("clears ComparisonPane's controlled highlight when its blank canvas is clicked", async () => {
    const resources: DiagramFile[] = [
      { id: "sequence-a", name: "a.seq", projectId: "models", source: "participant Client\nparticipant API\nClient -> API: request" },
      { id: "sequence-b", name: "b.seq", projectId: "models", source: "participant Client\nparticipant API\nClient -> API: response" },
    ];
    const index = { projectId: "models", resources: [], diagrams: [], eventFlows: [], documents: [], participants: [], usages: [], references: [], diagnostics: [] } as ProjectIndex;
    render(<ComparisonView primary={resources[0]!} primarySource={resources[0]!.source} resources={resources} index={index} resourceIdForFile={resource => resource.id} onExit={() => {}} onOpenResource={() => {}} maximizedPane={null} onMaximize={() => {}} onRestore={() => {}} maximized={false} onToggleMaximize={() => {}} />);

    const pane = screen.getByTestId("comparison-pane-a");
    await waitFor(() => expect(pane.querySelector('[data-testid="preview-svg"] [data-node-id]')).not.toBeNull());
    const node = pane.querySelector('[data-testid="preview-svg"] [data-node-id]')!;
    fireEvent.click(node);
    await waitFor(() => expect(node).toHaveClass("svg-node--active"));
    fireEvent.click(within(pane).getByTestId("viewport-pane"));
    await waitFor(() => expect(node).not.toHaveClass("svg-node--active"));
  });

  it("does not reuse a node id shared by different Conceptual and Database resources", async () => {
    render(<App />);
    const diagrams: DiagramFile[] = [
      { id: "concept", name: "domain.concept", projectId: "models", source: 'concept account "Account"' },
      { id: "database", name: "schema.dbschema", projectId: "models", source: 'table account - "Stored Account"\ncolumn account account_id "id" {uuid} not-null' },
    ];
    await importResources({ id: "models", name: "Models", datasetIds: diagrams.map((diagram) => diagram.id), noteIds: [] }, diagrams);

    fireEvent.click(screen.getByRole("button", { name: "Load diagram domain.concept" }));
    fireEvent.click(document.querySelector('[data-testid="conceptual-preview-svg"] [data-node-id="account"]')!);
    await waitFor(() => expect(document.querySelector('[data-testid="conceptual-preview-svg"] .svg-node--active')).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Load diagram schema.dbschema" }));
    await waitFor(() => expect(screen.getByTestId("database-preview-svg")).toBeInTheDocument());
    expect(screen.getByTestId("database-preview-svg").querySelector('[data-node-id="account"]')).not.toHaveClass("is-selected");
  });

  it("clears a node selection when moving to a different project with colliding IDs", async () => {
    render(<App />);
    const conceptual: DiagramFile[] = [{ id: "concept", name: "domain.concept", projectId: "domain", source: 'concept account "Account"' }];
    await importResources({ id: "domain", name: "Domain", datasetIds: ["concept"], noteIds: [] }, conceptual);
    fireEvent.click(screen.getByRole("button", { name: "Load diagram domain.concept" }));
    fireEvent.click(document.querySelector('[data-testid="conceptual-preview-svg"] [data-node-id="account"]')!);
    await waitFor(() => expect(document.querySelector('[data-testid="conceptual-preview-svg"] .svg-node--active')).not.toBeNull());

    const database: DiagramFile[] = [{ id: "database", name: "schema.dbschema", projectId: "storage", source: 'table account - "Account row"\ncolumn account account_id "id" {uuid} not-null' }];
    await importResources({ id: "storage", name: "Storage", datasetIds: ["database"], noteIds: [] }, database);
    await waitFor(() => expect(screen.getAllByTestId("explorer-project")).toHaveLength(2));
    const storageProject = screen.getAllByTestId("explorer-project").find((row) => row.textContent?.includes("Storage"));
    expect(storageProject).toBeDefined();
    fireEvent.click(within(storageProject!).getByRole("button", { name: "Load diagram schema.dbschema" }));
    await waitFor(() => expect(screen.getByTestId("database-preview-svg")).toBeInTheDocument());
    expect(screen.getByTestId("database-preview-svg").querySelector('[data-node-id="account"]')).not.toHaveClass("is-selected");
  });

  it("compares revisions of one Conceptual resource and highlights only present entities on each side", async () => {
    const snapshots = [
      revisionSnapshot(1, 'concept account "Account"\nconcept order "Order"\nrelation places account -> order "places"'),
      revisionSnapshot(2, 'concept account "Customer Account"\nconcept invoice "Invoice"\nrelation places account -- invoice "owns"'),
    ];
    renderRevisionCompare(snapshots);
    fireEvent.click(screen.getByRole("button", { name: "Compare revisions" }));

    await waitFor(() => expect(screen.getByTestId("revision-diff-summary")).toHaveTextContent("Structural diff available"));
    expect(screen.getByRole("combobox", { name: "Revision A" })).toHaveValue("1");
    expect(screen.getByRole("combobox", { name: "Revision B" })).toHaveValue("2");
    await waitFor(() => expect(screen.getByTestId("revision-pane-b").querySelector('[data-review-change="concept:invoice"]')).toHaveClass("review-change--added"));
    expect(screen.getByTestId("revision-pane-a").querySelector('[data-review-change="concept:order"]')).toHaveClass("review-change--removed");
    expect(screen.getByTestId("revision-pane-a").querySelector('[data-review-change="concept:account"]')).toHaveClass("review-change--modified");
    expect(screen.getByTestId("revision-pane-b").querySelector('[data-review-change="relationship:places"]')).toHaveClass("review-change--modified");
    expect(screen.getByTestId("revision-pane-b").querySelector('[data-concept-id="order"]')).toBeNull();
    expect(screen.getByTestId("verified-revision-pair")).toHaveTextContent("project / SHARED / stable-resource · r1 → r2");
    expect(screen.getByTestId("revision-change-detail")).toHaveTextContent("Confirmed modification by stable entity ID");
    const initiallySelected = screen.getByTestId("revision-pane-a").querySelector(".review-change--active");
    expect(initiallySelected).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next difference" }));
    fireEvent.click(screen.getByRole("button", { name: "Next difference" }));
    await waitFor(() => expect(screen.getByTestId("revision-change-detail")).toHaveTextContent("concept · invoice"));
    expect(screen.getByTestId("revision-pane-b").querySelector('[data-review-change="concept:invoice"]')).toHaveClass("review-change--active");
  });

  it("compares Database revisions using native row highlights and keeps implicit renames as remove plus add", async () => {
    const snapshots = [
      revisionSnapshot(1, 'table accounts - "Accounts"\ncolumn accounts account_id "id" {uuid} not-null\ncolumn accounts - "old_name" {text} nullable\nprimary-key accounts_pk accounts (id)', "database"),
      revisionSnapshot(2, 'table accounts - "Customer Accounts"\ncolumn accounts account_id "account_id" {uuid} not-null\ncolumn accounts - "new_name" {text} nullable\nprimary-key accounts_pk accounts (account_id)', "database"),
    ];
    renderRevisionCompare(snapshots, "database");
    fireEvent.click(screen.getByRole("button", { name: "Compare revisions" }));

    await waitFor(() => expect(screen.getByTestId("revision-pane-a").querySelector('[data-column-id="accounts:old_name"]')).toHaveClass("review-change--removed"));
    expect(screen.getByTestId("revision-pane-b").querySelector('[data-column-id="accounts:new_name"]')).toHaveClass("review-change--added");
    expect(screen.getByTestId("revision-pane-a").querySelector('[data-column-id="account_id"]')).toHaveClass("review-change--modified");
    expect(screen.getByTestId("revision-pane-a").querySelector('[data-node-id="accounts"]')).toHaveClass("review-change--modified");
  });

  it("does not calculate a structural diff for invalid or incompatible revision snapshots", async () => {
    const invalid = [
      revisionSnapshot(1, 'concept account "Account"'),
      revisionSnapshot(2, "concept invalid"),
    ];
    const invalidView = renderRevisionCompare(invalid);
    fireEvent.click(screen.getByRole("button", { name: "Compare revisions" }));
    await waitFor(() => expect(screen.getByTestId("revision-diff-summary")).toHaveTextContent("Semantic diff unavailable"));
    expect(screen.getByRole("heading", { name: "Validation diagnostics" })).toBeInTheDocument();
    expect(screen.getByTestId("revision-pane-b")).toHaveTextContent("Conceptual source has errors");
    invalidView.unmount();

    const mixed = [revisionSnapshot(1, 'concept account "Account"'), revisionSnapshot(2, 'table accounts - "Accounts"', "database")];
    renderRevisionCompare(mixed);
    fireEvent.click(screen.getByRole("button", { name: "Compare revisions" }));
    await waitFor(() => expect(screen.getByText(/incompatible representations/)).toBeInTheDocument());
    expect(screen.getByTestId("revision-diff-summary")).toHaveTextContent("textual source comparison is shown instead");
    expect(screen.getByTestId("revision-pane-a")).toHaveTextContent("concept account");
    expect(screen.getByTestId("revision-pane-b")).toHaveTextContent("table accounts");
    expect(screen.getAllByText(/Showing source only/)).toHaveLength(2);
  });

  it.each([
    ["Sequence", "sequence-diagram" as const, "participant Client\nparticipant API\nClient -> API: Before", "participant Client\nparticipant API\nClient -> API: After", "Client -> API: Before", "Client -> API: After"],
    ["Event Flow", "event-flow" as const, "event Before\nproducer Client", "event After\nproducer Client", "event Before", "event After"],
    ["Markdown", "markdown-document" as const, "# Before\n\nold text", "# After\n\nnew text", "# Before", "# After"],
  ])("shows verified textual-only evidence for historical %s revisions", async (_label, type, before, after, beforeEvidence, afterEvidence) => {
    renderRevisionCompare([revisionSnapshot(1, before, type), revisionSnapshot(2, after, type)], type);
    fireEvent.click(screen.getByRole("button", { name: "Compare revisions" }));

    expect(await screen.findByTestId("verified-revision-pair")).toHaveTextContent("r1 → r2");
    expect(screen.getByTestId("revision-diff-summary")).toHaveTextContent("textual source comparison is shown instead");
    expect(screen.getByTestId("revision-source-evidence")).toHaveTextContent("Textual source evidence");
    expect(screen.getByTestId("revision-source-evidence")).toHaveTextContent(beforeEvidence);
    expect(screen.getByTestId("revision-source-evidence")).toHaveTextContent(afterEvidence);
    for (const pane of [screen.getByTestId("revision-pane-a"), screen.getByTestId("revision-pane-b")]) {
      expect(pane).toHaveTextContent("Showing source only; no semantic change is asserted.");
      expect(pane.querySelector("svg")).toBeNull();
    }
    expect(screen.queryByTestId("revision-change-list")).toBeNull();
    expect(screen.queryByText(/Confirmed stable-ID match|Confirmed modification/)).toBeNull();
  });

  it.each([
    ["project", { projectId: "different-project" }],
    ["context", { contextId: "different-context" }],
    ["resource", { resourceId: "different-resource" }],
    ["revision", { revision: 99 }],
    ["representation", { representation: "database" as const }],
  ])("rejects a snapshot with a mismatched %s identity field", async (_field, mismatch) => {
    const snapshots = [revisionSnapshot(1, 'concept account "Account"'), revisionSnapshot(2, 'concept account "Account"')];
    const client = revisionClient(snapshots);
    const original = client.getResourceRevision;
    client.getResourceRevision = async (...args) => {
      const result = await original(...args);
      return args[3] === 2 ? { ...result, ...mismatch } : result;
    };
    const resource: DiagramFile = { id: "file-id", name: "model.concept", source: snapshots[1]!.content, projectId: "project" };
    render(<ComparisonView primary={resource} primarySource={resource.source} resources={[resource]} index={revisionIndex} resourceIdForFile={() => revisionResource.resourceId} onExit={() => {}} onOpenResource={() => {}} maximizedPane={null} onMaximize={() => {}} onRestore={() => {}} maximized={false} onToggleMaximize={() => {}} revisionClient={client} revisionResource={revisionResource} />);
    fireEvent.click(screen.getByRole("button", { name: "Compare revisions" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("did not match the selected project, resource, context and revision");
    expect(screen.queryByTestId("revision-pane-a")).toBeNull();
    expect(screen.queryByTestId("revision-pane-b")).toBeNull();
  });

  it("clears loaded snapshots after revalidation is forbidden and does not restore them on return", async () => {
    const snapshots = [revisionSnapshot(1, 'concept account "Protected base"'), revisionSnapshot(2, 'concept account "Protected target"')];
    let revoked = false;
    let lateSnapshot: ((snapshot: ServerResourceRevision) => void) | undefined;
    let listCalls = 0;
    let snapshotCalls = 0;
    const client = {
      listResourceRevisions: async () => {
        listCalls += 1;
        if (revoked) throw new Error("404 not_found");
        return snapshots.map(({ resourceId, projectId, contextId, revision, type, representation, createdAt }) => ({ resourceId, projectId, contextId, revision, type, representation, createdAt }));
      },
      getResourceRevision: async (_projectId: string, _resourceId: string, _contextId: string | null, revision: number) => {
        snapshotCalls += 1;
        if (!revoked) return snapshots.find(snapshot => snapshot.revision === revision)!;
        if (snapshotCalls % 2 === 1) return await new Promise<ServerResourceRevision>(resolve => { lateSnapshot = resolve; });
        throw new Error("403 forbidden: resource:read revoked");
      },
    };
    const resource: DiagramFile = { id: "file-id", name: "model.concept", source: snapshots[1]!.content, projectId: "project" };
    render(<ComparisonView primary={resource} primarySource={resource.source} resources={[resource]} index={revisionIndex} resourceIdForFile={() => revisionResource.resourceId} onExit={() => {}} onOpenResource={() => {}} maximizedPane={null} onMaximize={() => {}} onRestore={() => {}} maximized={false} onToggleMaximize={() => {}} revisionClient={client} revisionResource={revisionResource} />);
    fireEvent.click(screen.getByRole("button", { name: "Compare revisions" }));
    expect(await screen.findByTestId("verified-revision-pair")).toHaveTextContent("r1 → r2");
    await waitFor(() => {
      expect(screen.getByTestId("revision-pane-a")).toHaveTextContent("Protected base");
      expect(screen.getByTestId("revision-pane-b")).toHaveTextContent("Protected target");
    });

    // There is no push notification for authorization revocation. The next user
    // transition that requests snapshots is where the server's denial is seen.
    revoked = true;
    fireEvent.change(screen.getByRole("combobox", { name: "Revision A" }), { target: { value: "2" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("resource may be retired or access may have been revoked");
    await act(async () => { lateSnapshot?.(snapshots[1]!); });
    expect(screen.queryByTestId("revision-pane-a")).toBeNull();
    expect(screen.queryByTestId("revision-pane-b")).toBeNull();
    expect(screen.queryByText(/Protected (base|target)/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Return to parallel views" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare revisions" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("resource may be retired or access may have been revoked");
    expect(listCalls).toBe(2);
    expect(screen.queryByTestId("revision-pane-a")).toBeNull();
    expect(screen.queryByTestId("revision-pane-b")).toBeNull();
    expect(screen.queryByText(/Protected (base|target)/)).toBeNull();
  });

  it("keeps revision cameras pane-local and resets them for either selector, swapped pairs, and re-entry", async () => {
    const snapshots = [
      revisionSnapshot(1, 'concept account "Account"'),
      revisionSnapshot(2, 'concept account "Account"\nconcept invoice "Invoice"'),
      revisionSnapshot(3, 'concept account "Account"\nconcept invoice "Invoice"\nconcept order "Order"'),
    ];
    renderRevisionCompare(snapshots);
    fireEvent.click(screen.getByRole("button", { name: "Compare revisions" }));
    await waitFor(() => expect(screen.getByTestId("revision-pane-a").querySelector("[data-testid='conceptual-preview-svg'] svg")).not.toBeNull());
    const paneA = screen.getByTestId("revision-pane-a");
    const paneB = screen.getByTestId("revision-pane-b");
    fireEvent.click(within(paneA).getByTestId("zoom-in"));
    fireEvent.click(within(paneB).getByTestId("zoom-in"));
    await waitFor(() => expect(paneA.querySelector("[data-testid='conceptual-preview-svg']")?.getAttribute("style")).not.toContain("scale(1)"));
    const zoomedA = paneA.querySelector("[data-testid='conceptual-preview-svg']")?.getAttribute("style");
    const zoomedB = paneB.querySelector("[data-testid='conceptual-preview-svg']")?.getAttribute("style");
    expect(zoomedA).not.toBe(zoomedB);

    fireEvent.change(screen.getByRole("combobox", { name: "Revision A" }), { target: { value: "1" } });
    await waitFor(() => {
      expect(screen.getByTestId("revision-pane-a")).toHaveTextContent("r1");
      expect(screen.getByTestId("revision-pane-b")).toHaveTextContent("r3");
    });
    await waitFor(() => {
      expect(screen.getByTestId("revision-pane-a").querySelector("[data-testid='conceptual-preview-svg'] svg")).not.toBeNull();
      expect(screen.getByTestId("revision-pane-b").querySelector("[data-testid='conceptual-preview-svg'] svg")).not.toBeNull();
    });
    const afterAChange = screen.getByTestId("revision-pane-a").querySelector("[data-testid='conceptual-preview-svg']")?.getAttribute("style");
    const afterAChangeB = screen.getByTestId("revision-pane-b").querySelector("[data-testid='conceptual-preview-svg']")?.getAttribute("style");
    expect(afterAChange).not.toBe(zoomedA);
    expect(afterAChangeB).not.toBe(zoomedB);

    fireEvent.click(within(screen.getByTestId("revision-pane-a")).getByTestId("zoom-in"));
    fireEvent.click(within(screen.getByTestId("revision-pane-b")).getByTestId("zoom-in"));
    const beforeBChangeA = screen.getByTestId("revision-pane-a").querySelector("[data-testid='conceptual-preview-svg']")?.getAttribute("style");
    const beforeBChange = screen.getByTestId("revision-pane-b").querySelector("[data-testid='conceptual-preview-svg']")?.getAttribute("style");
    fireEvent.change(screen.getByRole("combobox", { name: "Revision B" }), { target: { value: "2" } });
    await waitFor(() => {
      expect(screen.getByTestId("revision-pane-a")).toHaveTextContent("r1");
      expect(screen.getByTestId("revision-pane-b")).toHaveTextContent("r2");
    });
    await waitFor(() => expect(screen.getByTestId("revision-pane-b").querySelector("[data-testid='conceptual-preview-svg'] svg")).not.toBeNull());
    expect(screen.getByTestId("revision-pane-a").querySelector("[data-testid='conceptual-preview-svg']")?.getAttribute("style")).not.toBe(beforeBChangeA);
    expect(screen.getByTestId("revision-pane-b").querySelector("[data-testid='conceptual-preview-svg']")?.getAttribute("style")).not.toBe(beforeBChange);

    // Reverse the same pair (A=r2, B=r1) through the two server revision selectors.
    fireEvent.change(screen.getByRole("combobox", { name: "Revision A" }), { target: { value: "2" } });
    await waitFor(() => expect(screen.getByTestId("revision-pane-a")).toHaveTextContent("r2"));
    fireEvent.change(screen.getByRole("combobox", { name: "Revision B" }), { target: { value: "1" } });
    await waitFor(() => {
      expect(screen.getByTestId("revision-pane-a")).toHaveTextContent("r2");
      expect(screen.getByTestId("revision-pane-b")).toHaveTextContent("r1");
    });
    await waitFor(() => expect(screen.getByTestId("revision-pane-a").querySelector("[data-testid='conceptual-preview-svg'] svg")).not.toBeNull());
    fireEvent.click(within(screen.getByTestId("revision-pane-a")).getByTestId("zoom-in"));
    const swappedTransform = screen.getByTestId("revision-pane-a").querySelector("[data-testid='conceptual-preview-svg']")?.getAttribute("style");
    fireEvent.click(screen.getByRole("button", { name: "Return to parallel views" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare revisions" }));
    await waitFor(() => expect(screen.getByTestId("revision-pane-a")).toHaveTextContent("r2"));
    await waitFor(() => expect(screen.getByTestId("revision-pane-a").querySelector("[data-testid='conceptual-preview-svg'] svg")).not.toBeNull());
    expect(screen.getByTestId("revision-pane-b")).toHaveTextContent("r3");
    expect(screen.getByTestId("revision-pane-a").querySelector("[data-testid='conceptual-preview-svg']")?.getAttribute("style")).not.toBe(swappedTransform);
  });

  it("does not read or write Dual View camera sessions while historical cameras change", async () => {
    const snapshots = [
      revisionSnapshot(1, 'concept account "Account"'),
      revisionSnapshot(2, 'concept account "Account"\nconcept invoice "Invoice"'),
      revisionSnapshot(3, 'concept account "Account"\nconcept invoice "Invoice"\nconcept order "Order"'),
    ];
    const resource: DiagramFile = { id: "dual-resource", name: "dual.concept", source: snapshots[2]!.content, projectId: "project" };
    const option: ComparisonOption = {
      id: "dual-option", resource, resourceId: revisionResource.resourceId, representation: "conceptual", source: resource.source, label: "Dual resource",
      context: { projectId: "project", knowledgeContext: { kind: "local", id: "local:project", projectId: "project" }, index: revisionIndex, resourceId: revisionResource.resourceId },
    };
    render(<>
      <DualView options={[option]} controller={visualControllerFor([option], option.id)} projectId="project" onExit={() => {}} />
      <ComparisonView primary={resource} primarySource={resource.source} resources={[resource]} index={revisionIndex} resourceIdForFile={() => revisionResource.resourceId} onExit={() => {}} onOpenResource={() => {}} maximizedPane={null} onMaximize={() => {}} onRestore={() => {}} maximized={false} onToggleMaximize={() => {}} revisionClient={revisionClient(snapshots)} revisionResource={revisionResource} />
    </>);
    const dualPane = screen.getByTestId("dual-pane-a");
    await waitFor(() => expect(dualPane.querySelector("[data-testid='conceptual-preview-svg'] svg")).not.toBeNull());
    fireEvent.click(within(dualPane).getByTestId("zoom-in"));
    const dualTransform = dualPane.querySelector("[data-testid='conceptual-preview-svg']")?.getAttribute("style");

    fireEvent.click(screen.getByRole("button", { name: "Compare revisions" }));
    await waitFor(() => expect(screen.getByTestId("revision-pane-a")).toHaveTextContent("r2"));
    await waitFor(() => expect(screen.getByTestId("revision-pane-a").querySelector("[data-testid='conceptual-preview-svg'] svg")).not.toBeNull());
    fireEvent.click(within(screen.getByTestId("revision-pane-a")).getByTestId("zoom-in"));
    fireEvent.change(screen.getByRole("combobox", { name: "Revision A" }), { target: { value: "1" } });
    await waitFor(() => expect(screen.getByTestId("revision-pane-a")).toHaveTextContent("r1"));
    expect(dualPane.querySelector("[data-testid='conceptual-preview-svg']")?.getAttribute("style")).toBe(dualTransform);

    fireEvent.click(screen.getByRole("button", { name: "Return to parallel views" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare revisions" }));
    await waitFor(() => expect(screen.getByTestId("revision-pane-b")).toHaveTextContent("r3"));
    expect(dualPane.querySelector("[data-testid='conceptual-preview-svg']")?.getAttribute("style")).toBe(dualTransform);
  });

  it("distinguishes source-only changes from revisions with no changes", async () => {
    const sourceOnly = renderRevisionCompare([
      revisionSnapshot(1, 'concept account "Account"'),
      revisionSnapshot(2, '# reviewed\nconcept account "Account"'),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Compare revisions" }));
    await waitFor(() => expect(screen.getByTestId("revision-diff-summary")).toHaveTextContent("Source/metadata-only changes"));
    expect(screen.queryByRole("region", { name: "Structural changes" })).toBeNull();
    sourceOnly.unmount();

    renderRevisionCompare([
      revisionSnapshot(1, 'concept account "Account"'),
      revisionSnapshot(2, 'concept account "Account"'),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Compare revisions" }));
    await waitFor(() => expect(screen.getByTestId("revision-diff-summary")).toHaveTextContent("No structural changes."));
  });

  it("ignores an obsolete snapshot pair after the revision selection changes", async () => {
    const snapshots = [
      revisionSnapshot(1, 'concept account "Revision One"'),
      revisionSnapshot(2, 'concept account "Revision Two"'),
      revisionSnapshot(3, 'concept account "Revision Three"'),
    ];
    const pending: Array<{ revision: number; resolve: (snapshot: ServerResourceRevision) => void }> = [];
    const client = {
      listResourceRevisions: async () => snapshots.map(({ resourceId, projectId, contextId, revision, type, representation, createdAt }) => ({ resourceId, projectId, contextId, revision, type, representation, createdAt })),
      getResourceRevision: (_projectId: string, _resourceId: string, _contextId: string | null, revision: number) => new Promise<ServerResourceRevision>((resolve) => pending.push({ revision, resolve })),
    };
    const resource: DiagramFile = { id: "file-id", name: "model.concept", source: snapshots[2].content, projectId: "project" };
    render(<ComparisonView primary={resource} primarySource={resource.source} resources={[resource]} index={revisionIndex} resourceIdForFile={() => revisionResource.resourceId} onExit={() => {}} onOpenResource={() => {}} maximizedPane={null} onMaximize={() => {}} onRestore={() => {}} maximized={false} onToggleMaximize={() => {}} revisionClient={client} revisionResource={revisionResource} />);
    fireEvent.click(screen.getByRole("button", { name: "Compare revisions" }));
    await waitFor(() => expect(pending).toHaveLength(2));
    fireEvent.change(screen.getByRole("combobox", { name: "Revision A" }), { target: { value: "1" } });
    await waitFor(() => expect(pending).toHaveLength(4));
    await act(async () => {
      pending[2].resolve(snapshots[0]);
      pending[3].resolve(snapshots[2]);
    });
    await waitFor(() => expect(screen.getByTestId("revision-pane-a")).toHaveTextContent("r1"));
    await act(async () => {
      pending[0].resolve(snapshots[1]);
      pending[1].resolve(snapshots[2]);
    });
    await waitFor(() => {
      expect(screen.getByTestId("revision-pane-a")).toHaveTextContent("r1");
      expect(screen.getByTestId("revision-pane-a")).toHaveTextContent("Revision One");
    });
  });

  it("reports semantic truncation instead of implying the returned subset is complete", () => {
    const diff = {
      changed: true,
      metadata: { changed: false, changes: [] },
      content: { representation: "conceptual", available: true, changes: [], diagnostics: [], truncated: true, totalChanges: 2001, returnedChanges: 2000 },
      source: { changed: false, hunks: [], truncated: false, totalHunks: 0, returnedHunks: 0 },
      summary: { semanticChanges: 2001, sourceHunks: 0, byKind: { added: 2000, removed: 0, modified: 0 }, byEntity: { concept: 2000 } },
    } as ResourceDiff;
    render(<RevisionDiffSummary diff={diff} />);
    expect(screen.getByText("Semantic diff truncated: showing 2000 of 2001 changes.")).toBeInTheDocument();
  });

  it("keeps maximize and restore inside comparison mode", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    await command("New Diagram");
    fireEvent.click(screen.getByTestId("analysis-mode-button"));
    fireEvent.click(screen.getByRole("button", { name: "Maximize Viewer A" }));

    expect(screen.getByTestId("comparison-pane-a")).toBeInTheDocument();
    expect(screen.getByTestId("comparison-pane-b").parentElement).toHaveClass("comparison__slot--hidden");
    expect(screen.getByRole("button", { name: "Restore Viewer A" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore Viewer A" }));
    expect(screen.getByTestId("comparison-pane-b")).toBeInTheDocument();
  });

  it("maximizes the comparison area beside its close control", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    await command("New Diagram");
    fireEvent.click(screen.getByTestId("analysis-mode-button"));

    fireEvent.click(screen.getByRole("button", { name: "Maximize comparison" }));
    expect(screen.getByRole("button", { name: "Restore comparison" })).toBeInTheDocument();
    expect(screen.getByTestId("comparison-view").closest("main")).toHaveClass("app__workspace--preview-maximized");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Maximize comparison" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close comparison" }));
    expect(screen.getByTestId("dsl-editor")).toBeInTheDocument();
  });

  it("shows a semantic comparison summary without treating names as identities", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    await command("New Diagram");
    fireEvent.click(screen.getByTestId("analysis-mode-button"));

    expect(screen.getByTestId("semantic-comparison-summary")).toHaveTextContent("Shared: 0");
    expect(screen.getByTestId("semantic-comparison-summary")).toHaveTextContent("Unresolved: 0");
  });

  it("hides and restores the editor without losing a dirty buffer", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    await command("New Diagram");
    fireEvent.click(screen.getByRole("button", { name: "Show editor" }));
    fireEvent.change(screen.getByTestId("dsl-textarea"), { target: { value: "participant Dirty" } });
    fireEvent.click(screen.getByTestId("analysis-mode-button"));

    fireEvent.click(screen.getByRole("button", { name: "Hide editor" }));
    expect(screen.getByTestId("dsl-textarea")).toHaveValue("participant Dirty");
    expect(screen.getByRole("button", { name: "Show editor" })).toBeInTheDocument();
    expect(screen.getByTestId("comparison-view").closest("main")).toHaveClass("app__workspace--comparison-editor-hidden");
    fireEvent.click(screen.getByRole("button", { name: "Show editor" }));
    expect(screen.getByTestId("dsl-textarea")).toHaveValue("participant Dirty");
  });

  it("keeps the editor mounted and restores its buffer, scroll, selection, and preferences around Dual View", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    await command("New Diagram");
    const textarea = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: Array.from({ length: 80 }, (_, i) => `participant P${i}`).join("\n") } });
    textarea.scrollTop = 240;
    textarea.setSelectionRange(12, 19);
    const preferencesBefore = localStorage.getItem(UI_PREFERENCES_KEY);
    fireEvent.click(screen.getByTestId("compare-mode-button"));
    expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
    expect(screen.getByTestId("dual-pane-a")).toBeInTheDocument();
    expect(screen.getByTestId("dual-pane-b")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Project explorer" })).toBeInTheDocument();
    expect(document.querySelector(".app__workspace")).toHaveClass("app__workspace--dual-view");
    expect(document.querySelector(".app__workspace")).toHaveClass("app__workspace--immersive");
    expect(localStorage.getItem(UI_PREFERENCES_KEY)).toBe(preferencesBefore);
    fireEvent.click(screen.getByRole("button", { name: "Close Dual View" }));
    const restored = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    expect(restored).toHaveValue(Array.from({ length: 80 }, (_, i) => `participant P${i}`).join("\n"));
    expect(restored.scrollTop).toBe(240);
    expect(restored.selectionStart).toBe(12);
    expect(restored.selectionEnd).toBe(19);
    expect(document.querySelector(".app__workspace")).not.toHaveClass("app__workspace--dual-view");
    expect(localStorage.getItem(UI_PREFERENCES_KEY)).toBe(preferencesBefore);
  });

  it("switches Dual View and Analysis atomically while preserving the editor and shell preferences", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    await command("New Diagram");
    fireEvent.change(screen.getByTestId("dsl-textarea"), { target: { value: "participant Unsaved" } });
    const preferencesBefore = localStorage.getItem(UI_PREFERENCES_KEY);
    fireEvent.click(screen.getByTestId("compare-mode-button"));
    const workspace = document.querySelector(".app__workspace")!;
    expect(workspace).toHaveClass("app__workspace--immersive");
    expect(screen.getByTestId("dsl-textarea")).toHaveValue("participant Unsaved");
    expect(workspace).toHaveClass("app__workspace--immersive");

    fireEvent.click(screen.getByRole("button", { name: "Switch to Analysis" }));
    expect(screen.queryByTestId("dual-view")).toBeNull();
    expect(screen.getByTestId("comparison-view")).toBeInTheDocument();
    expect(workspace).toHaveClass("app__workspace--immersive");
    expect(screen.getByTestId("dsl-textarea")).toHaveValue("participant Unsaved");
    expect(screen.getByRole("combobox", { name: "Viewer A resource" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Switch to Dual View" }));
    expect(screen.getByTestId("dual-view")).toBeInTheDocument();
    expect(workspace).toHaveClass("app__workspace--immersive");
    expect(screen.getByTestId("dsl-textarea")).toHaveValue("participant Unsaved");
    expect(localStorage.getItem(UI_PREFERENCES_KEY)).toBe(preferencesBefore);
    fireEvent.click(screen.getByRole("button", { name: "Close Dual View" }));
    expect(workspace).not.toHaveClass("app__workspace--immersive");
    expect(screen.getByTestId("dsl-textarea")).toHaveValue("participant Unsaved");
    expect(localStorage.getItem(UI_PREFERENCES_KEY)).toBe(preferencesBefore);
  });

  it("restores real SVG camera and node selection through an Analysis unmount", async () => {
    render(<App />);
    const diagrams: DiagramFile[] = [
      { id: "session-alpha", name: "session-alpha.concept", projectId: "session-project", source: 'concept alpha "Alpha"\nconcept beta "Beta"' },
      { id: "session-gamma", name: "session-gamma.concept", projectId: "session-project", source: 'concept gamma "Gamma"' },
    ];
    await importResources({ id: "session-project", name: "Session project", datasetIds: diagrams.map(item => item.id), noteIds: [] }, diagrams);
    fireEvent.click(screen.getByTestId("compare-mode-button"));
    const paneA = () => screen.getByTestId("dual-pane-a");
    await waitFor(() => expect(paneA().querySelector("[data-testid='conceptual-preview-svg'] svg")).not.toBeNull());
    fireEvent.click(within(paneA()).getByTestId("zoom-in"));
    fireEvent.click(paneA().querySelector('[data-concept-id="alpha"]')!);
    await waitFor(() => expect(paneA().querySelector('[data-concept-id="alpha"]')).toHaveClass("svg-node--active"));
    const before = {
      transform: paneA().querySelector('[data-testid="conceptual-preview-svg"]')?.getAttribute("style"),
      selected: paneA().querySelector(".svg-node--active")?.getAttribute("data-concept-id"),
    };

    fireEvent.click(screen.getByRole("button", { name: "Switch to Analysis" }));
    expect(screen.queryByTestId("dual-view")).toBeNull();
    expect(screen.getByTestId("comparison-view")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Switch to Dual View" }));
    await waitFor(() => expect(paneA().querySelector('[data-concept-id="alpha"]')).toHaveClass("svg-node--active"));
    expect(paneA().querySelector('[data-testid="conceptual-preview-svg"]')?.getAttribute("style")).toBe(before.transform);
    expect(paneA().querySelector(".svg-node--active")?.getAttribute("data-concept-id")).toBe(before.selected);
  });

  it("blocks restored SVG state until authorization is ready, then purges revoked resources", async () => {
    const source = 'concept alpha "Alpha"\nconcept beta "Beta"';
    const diagram: DiagramFile = { id: "authorized", name: "authorized.concept", projectId: "p1", source };
    const other: DiagramFile = { id: "other", name: "other.concept", projectId: "p1", source: 'concept gamma "Gamma"' };
    const options: ComparisonOption[] = [diagram, other].map(item => ({
      id: item.id, resource: item, resourceId: item.id, representation: "conceptual", source: item.source,
      context: { projectId: "p1", knowledgeContext: { kind: "local", id: "local:p1", projectId: "p1" }, index: revisionIndex, resourceId: item.id }, label: item.name,
    }));
    const controller = visualControllerFor(options, diagram.id);
    controller.select("a", visualSessionDescriptors(options)[0]!);
    controller.saveSnapshot(visualSessionDescriptors(options)[0]!.identity, "viewer-a", {
      sourceFingerprint: fingerprintVisualSource(source), representation: "conceptual", transform: { x: 41, y: -17, scale: 1.5 }, selectedNodeId: "alpha",
    }, controller.captureGeneration());
    const callbackFromBeforeLoading = controller.captureGeneration();
    const view = render(<DualView options={options} controller={controller} projectId="P1" onExit={() => {}} />);
    const renderedSvg = () => screen.queryByTestId("dual-pane-a")?.querySelector("[data-testid='conceptual-preview-svg']");
    await waitFor(() => expect(renderedSvg()).not.toBeNull());
    expect(screen.getByRole("combobox", { name: "Dual View A resource" })).toHaveValue(diagram.id);

    controller.reconcile({ scope: controller.getState().scope, availability: "loading" });
    view.rerender(<DualView options={[]} controller={controller} availability="loading" projectId="P1" onExit={() => {}} />);
    expect(screen.getByText("Loading authorized resources…")).toBeInTheDocument();
    expect(renderedSvg()).toBeUndefined();
    expect(controller.getState().selections.a?.optionId).toBe(diagram.id);

    controller.reconcile({ scope: controller.getState().scope, availability: "unavailable" });
    view.rerender(<DualView options={[]} controller={controller} availability="unavailable" projectId="P1" onExit={() => {}} />);
    expect(screen.getByText("Dual View resources are unavailable.")).toBeInTheDocument();
    expect(renderedSvg()).toBeUndefined();
    expect(controller.getSnapshot(visualSessionDescriptors(options)[0]!.identity, "viewer-a", fingerprintVisualSource(source))).toBeNull();

    controller.reconcile({ scope: controller.getState().scope, availability: "ready", options: visualSessionDescriptors(options) });
    view.rerender(<DualView options={options} controller={controller} availability="ready" projectId="P1" onExit={() => {}} />);
    await waitFor(() => expect(renderedSvg()).not.toBeNull());
    expect(screen.getByRole("combobox", { name: "Dual View A resource" })).toHaveValue(diagram.id);
    expect(renderedSvg()?.getAttribute("style")).toContain("translate(41px, -17px) scale(1.5)");
    expect(screen.getByTestId("dual-pane-a").querySelector('[data-concept-id="alpha"]')).toHaveClass("svg-node--active");

    const editedSource = 'concept alpha "Edited Alpha"\nconcept beta "Beta"';
    const editedDiagram: DiagramFile = { ...diagram, source: editedSource };
    const editedOptions = [{ ...options[0]!, resource: editedDiagram, source: editedSource }, options[1]!];
    controller.reconcile({ scope: controller.getState().scope, availability: "ready", options: visualSessionDescriptors(editedOptions) });
    view.rerender(<DualView options={editedOptions} controller={controller} availability="ready" projectId="P1" onExit={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("dual-pane-a")).toHaveTextContent("Edited Alpha"));
    expect(renderedSvg()?.getAttribute("style")).not.toContain("translate(41px, -17px) scale(1.5)");
    expect(screen.getByTestId("dual-pane-a").querySelector(".svg-node--active")).toBeNull();
    expect([...controller.getState().snapshots].some(([key, value]) => key.includes('"authorized"') && value.sourceFingerprint === fingerprintVisualSource(source))).toBe(false);
    expect(controller.saveSnapshot(visualSessionDescriptors(options)[0]!.identity, "viewer-a", {
      sourceFingerprint: fingerprintVisualSource(source), representation: "conceptual", transform: { x: 999, y: 0, scale: 3 }, selectedNodeId: "alpha",
    }, callbackFromBeforeLoading)).toBe(false);

    const authorizedOptions = [editedOptions[1]!];
    controller.reconcile({ scope: controller.getState().scope, availability: "ready", options: visualSessionDescriptors(authorizedOptions) });
    view.rerender(<DualView options={authorizedOptions} controller={controller} availability="ready" projectId="P1" onExit={() => {}} />);
    expect([...controller.getState().snapshots.keys()].some(key => key.includes('"authorized"'))).toBe(false);
    expect(controller.getState().selections.a?.identity.resourceId).not.toBe(diagram.id);
    expect(screen.getByRole("combobox", { name: "Dual View A resource" })).toHaveValue(other.id);
    expect(screen.queryByText("Alpha")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("dual-pane-a")).toHaveTextContent("Gamma"));
  });

  it("invalidates an incompatible fingerprint and isolates a suspended scope from stale callbacks", () => {
    const first = createVisualSessionController({ projectId: "p1", contextKind: "shared", contextId: "shared:p1" });
    const old = { optionId: "alpha", identity: { projectId: "p1", contextKind: "shared", contextId: "shared:p1", resourceId: "alpha" }, sourceFingerprint: fingerprintVisualSource('concept alpha "Alpha"'), representation: "conceptual" as const };
    first.reconcile({ scope: first.getState().scope, availability: "ready", options: [old] });
    first.select("a", old);
    const oldGeneration = first.captureGeneration();
    first.saveSnapshot(old.identity, "viewer-a", { sourceFingerprint: old.sourceFingerprint, representation: old.representation, transform: { x: 22, y: 3, scale: 2 }, selectedNodeId: "alpha" }, oldGeneration);
    first.suspend();

    const changedFingerprint = { ...old, sourceFingerprint: fingerprintVisualSource('concept alpha "Renamed"') };
    const changedScope = { projectId: "p2", contextKind: "private-work", contextId: "work-p2" };
    const next = first.reconcile({ scope: changedScope, availability: "ready", options: [{ ...changedFingerprint, identity: { ...changedFingerprint.identity, ...changedScope } }] });
    expect(next.snapshots.size).toBe(0);
    expect(next.selections.a?.identity).toEqual({ ...changedFingerprint.identity, ...changedScope });
    expect(first.saveSnapshot(old.identity, "viewer-a", { sourceFingerprint: old.sourceFingerprint, representation: old.representation, transform: { x: 999, y: 0, scale: 3 }, selectedNodeId: "alpha" }, oldGeneration)).toBe(false);
    expect(first.getState().snapshots.size).toBe(0);

    first.close();
    const reopened = createVisualSessionController(changedScope);
    reopened.reconcile({ scope: changedScope, availability: "ready", options: [] });
    expect(reopened.getState().selections).toEqual({ a: null, b: null });
    expect(reopened.getState().snapshots.size).toBe(0);
  });

  it("restores Event Flow projections per resource and viewer lineage while keeping camera projections compatible", async () => {
    const eventSource = [
      "event OrderCreated",
      "producer OrderService",
      "consumer BillingService",
      "OrderService publishes OrderCreated",
      "BillingService consumes OrderCreated",
      "handler BillingHandler in BillingService",
      "OrderCreated handled by BillingHandler",
      "effect persist-order on BillingHandler kind database: Store the order",
    ].join("\n");
    const otherSource = eventSource.replaceAll("OrderCreated", "PaymentRequested").replaceAll("OrderService", "PaymentService");
    const resources: DiagramFile[] = [
      { id: "flow-x", name: "x.eventseq", projectId: "project", source: eventSource },
      { id: "flow-y", name: "y.eventseq", projectId: "project", source: otherSource },
    ];
    const options: ComparisonOption[] = resources.map(resource => ({
      id: resource.id, resource, resourceId: resource.id, representation: "event-flow", source: resource.source,
      context: { projectId: "project", knowledgeContext: { kind: "local", id: "local:project", projectId: "project" }, index: revisionIndex, resourceId: resource.id }, label: resource.name,
    }));
    const controller = visualControllerFor(options, "flow-x");
    controller.select("a", visualSessionDescriptors(options)[0]!);
    controller.select("b", visualSessionDescriptors(options)[0]!);
    const view = render(<DualView options={options} controller={controller} projectId="Project" onExit={() => {}} />);
    const paneA = () => screen.getByTestId("dual-pane-a");
    const paneB = () => screen.getByTestId("dual-pane-b");
    const projectionButton = (pane: HTMLElement, label: string) => within(pane).getByRole("button", { name: label });

    await waitFor(() => expect(projectionButton(paneA(), "Flow")).toHaveAttribute("aria-pressed", "true"));
    expect(paneA().querySelector('[data-testid="preview-svg"] svg')).not.toBeNull();
    fireEvent.click(within(paneA()).getByTestId("zoom-in"));
    fireEvent.click(paneA().querySelector('[data-testid="preview-svg"] [data-node-id]')!);
    await waitFor(() => expect(paneA().querySelector('[data-testid="preview-svg"] .svg-node--active')).not.toBeNull());
    const flowTransform = paneA().querySelector('[data-testid="preview-svg"]')?.getAttribute("style");
    fireEvent.click(projectionButton(paneA(), "Catalog"));
    await waitFor(() => expect(paneA().querySelector('[data-testid="event-catalog"]')).not.toBeNull());
    fireEvent.click(projectionButton(paneA(), "Flow"));
    await waitFor(() => expect(projectionButton(paneA(), "Flow")).toHaveAttribute("aria-pressed", "true"));
    expect(paneA().querySelector('[data-testid="preview-svg"] .svg-node--active')).not.toBeNull();
    fireEvent.click(projectionButton(paneA(), "Topology"));
    await waitFor(() => expect(paneA().querySelector('[data-testid="event-topology"] [data-testid="topology-svg"]')).not.toBeNull());
    expect(projectionButton(paneA(), "Topology")).toHaveAttribute("aria-pressed", "true");
    const topologyCamera = paneA().querySelector('[data-testid="topology-svg"]')?.getAttribute("style") ?? "";
    expect(topologyCamera).not.toBe(flowTransform);
    fireEvent.click(within(paneA()).getByTestId("zoom-in"));
    const zoomedTopologyCamera = paneA().querySelector('[data-testid="topology-svg"]')?.getAttribute("style") ?? "";
    fireEvent.click(projectionButton(paneA(), "Causal"));
    await waitFor(() => expect(projectionButton(paneA(), "Causal")).toHaveAttribute("aria-pressed", "true"));
    expect(paneA().querySelector('[data-testid="event-causal"]')).not.toBeNull();
    fireEvent.click(projectionButton(paneA(), "Catalog"));
    await waitFor(() => expect(paneA().querySelector('[data-testid="event-catalog"]')).not.toBeNull());
    fireEvent.click(projectionButton(paneA(), "Flow"));
    await waitFor(() => expect(projectionButton(paneA(), "Flow")).toHaveAttribute("aria-pressed", "true"));
    expect(paneA().querySelector('[data-testid="preview-svg"] svg')).not.toBeNull();
    const returnedFlowTransform = paneA().querySelector('[data-testid="preview-svg"]')?.getAttribute("style") ?? "";
    expect(returnedFlowTransform).not.toBe(zoomedTopologyCamera);
    expect(controller.getSnapshot(visualSessionDescriptors(options)[0]!.identity, "viewer-a", fingerprintVisualSource(eventSource))?.eventFlowProjection).toBe("flow");
    expect(controller.getSnapshot(visualSessionDescriptors(options)[0]!.identity, "viewer-b", fingerprintVisualSource(eventSource))?.eventFlowProjection).toBeUndefined();

    fireEvent.click(projectionButton(paneB(), "Topology"));
    await waitFor(() => expect(projectionButton(paneB(), "Topology")).toHaveAttribute("aria-pressed", "true"));
    expect(projectionButton(paneA(), "Flow")).toHaveAttribute("aria-pressed", "true");
    controller.swap();
    view.rerender(<DualView options={options} controller={controller} projectId="Project" onExit={() => {}} />);
    await waitFor(() => expect(projectionButton(paneA(), "Topology")).toHaveAttribute("aria-pressed", "true"));
    expect(projectionButton(paneB(), "Flow")).toHaveAttribute("aria-pressed", "true");

    // X → Y → X restores the X projection; Y starts at Flow for this lineage.
    fireEvent.change(screen.getByRole("combobox", { name: "Dual View A resource" }), { target: { value: "flow-y" } });
    await waitFor(() => expect(paneA()).toHaveTextContent("PaymentRequested"));
    expect(projectionButton(paneA(), "Flow")).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("combobox", { name: "Dual View A resource" }), { target: { value: "flow-x" } });
    await waitFor(() => expect(projectionButton(paneA(), "Topology")).toHaveAttribute("aria-pressed", "true"));

    view.unmount();
    controller.suspend();
    controller.resume();
    render(<DualView options={options} controller={controller} projectId="Project" onExit={() => {}} />);
    await waitFor(() => expect(projectionButton(screen.getByTestId("dual-pane-a"), "Topology")).toHaveAttribute("aria-pressed", "true"));

    // Topology camera geometry is never applied to Flow (or vice versa).
    expect(topologyCamera).not.toBe(flowTransform);
  });

  it("captures Markdown scroll from the real scroller by lineage and restores it after swap and suspension", async () => {
    const markdown = ["# Long reading", ...Array.from({ length: 60 }, (_, index) => `\n## Section ${index + 1}\n\nA paragraph with enough content to make the reading surface vertically scrollable.`)].join("\n");
    const note: NoteFile = { id: "long-note", name: "long-reading.md", projectId: "project", markdown };
    const options: ComparisonOption[] = [{
      id: "long-note-option", resource: note, resourceId: note.id, representation: "markdown", source: markdown,
      context: { projectId: "project", knowledgeContext: { kind: "local", id: "local:project", projectId: "project" }, index: revisionIndex, resourceId: note.id }, label: note.name,
    }];
    const controller = visualControllerFor(options, note.id);
    controller.select("b", visualSessionDescriptors(options)[0]!);
    const identity = visualSessionDescriptors(options)[0]!.identity;
    const fingerprint = fingerprintVisualSource(markdown);
    const generation = controller.captureGeneration();
    controller.saveSnapshot(identity, "viewer-a", {
      sourceFingerprint: fingerprint, representation: "markdown", transform: { x: 7, y: -3, scale: 1.5 }, selectedNodeId: "retained-a",
      markdownScroll: { scrollTop: 100, scrollRatio: 0.1, maxScroll: 1000 },
    }, generation);
    controller.saveSnapshot(identity, "viewer-b", {
      sourceFingerprint: fingerprint, representation: "markdown", transform: { x: 19, y: -8, scale: 2 }, selectedNodeId: "retained-b",
      markdownScroll: { scrollTop: 400, scrollRatio: 0.4, maxScroll: 1000 },
    }, generation);

    const view = render(<DualView options={options} controller={controller} projectId="Project" onExit={() => {}} />);
    const installScrollerGeometry = (pane: "a" | "b") => {
      const scroller = screen.getByTestId(`dual-pane-${pane}`).querySelector<HTMLElement>(".note-preview")!;
      Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
      return scroller;
    };
    let scrollA = installScrollerGeometry("a");
    let scrollB = installScrollerGeometry("b");
    await waitFor(() => {
      expect(scrollA.scrollTop).toBe(100);
      expect(scrollB.scrollTop).toBe(400);
    });
    expect(scrollA).toHaveClass("note-preview");
    expect(scrollA).not.toBe(screen.getByTestId("dual-pane-a").querySelector(".markdown-body"));

    scrollA.scrollTop = 300;
    fireEvent.scroll(scrollA);
    scrollB.scrollTop = 650;
    fireEvent.scroll(scrollB);
    await waitFor(() => {
      expect(controller.getSnapshot(identity, "viewer-a", fingerprint)?.markdownScroll?.scrollTop).toBe(300);
      expect(controller.getSnapshot(identity, "viewer-b", fingerprint)?.markdownScroll?.scrollTop).toBe(650);
    });
    expect(controller.getSnapshot(identity, "viewer-a", fingerprint)).toMatchObject({ transform: { x: 7, y: -3, scale: 1.5 }, selectedNodeId: "retained-a" });
    expect(controller.getSnapshot(identity, "viewer-b", fingerprint)).toMatchObject({ transform: { x: 19, y: -8, scale: 2 }, selectedNodeId: "retained-b" });

    scrollA.scrollTop = 500;
    fireEvent.scroll(scrollA);
    scrollB.scrollTop = 800;
    fireEvent.scroll(scrollB);
    controller.swap();
    view.rerender(<DualView options={options} controller={controller} projectId="Project" onExit={() => {}} />);
    scrollA = installScrollerGeometry("a");
    scrollB = installScrollerGeometry("b");
    await waitFor(() => {
      expect(scrollA.scrollTop).toBe(800);
      expect(scrollB.scrollTop).toBe(500);
    });
    expect(controller.getSnapshot(identity, "viewer-a", fingerprint)?.markdownScroll?.scrollTop).toBe(500);
    expect(controller.getSnapshot(identity, "viewer-b", fingerprint)?.markdownScroll?.scrollTop).toBe(800);

    view.unmount();
    controller.suspend();
    controller.resume();
    render(<DualView options={options} controller={controller} projectId="Project" onExit={() => {}} />);
    scrollA = installScrollerGeometry("a");
    scrollB = installScrollerGeometry("b");
    await waitFor(() => {
      expect(scrollA.scrollTop).toBe(800);
      expect(scrollB.scrollTop).toBe(500);
    });
  });

  it("gates Markdown offsets through availability, authorization, fingerprint, and representation changes", async () => {
    const markdown = ["# Authorized reading", ...Array.from({ length: 40 }, (_, index) => `\n## Section ${index + 1}\n\nAuthorized content for deterministic availability testing.`)].join("\n");
    const note: NoteFile = { id: "availability-note", name: "availability.md", projectId: "project", markdown };
    const makeOption = (source: string, representation: "markdown" | "conceptual" = "markdown"): ComparisonOption => {
      const resource = representation === "markdown"
        ? { ...note, markdown: source }
        : { id: note.id, name: "availability.concept", projectId: "project", source };
      return {
        id: "availability-option", resource, resourceId: note.id, representation, source,
        context: { projectId: "project", knowledgeContext: { kind: "local", id: "local:project", projectId: "project" }, index: revisionIndex, resourceId: note.id }, label: resource.name,
      } as ComparisonOption;
    };
    const options = [makeOption(markdown)];
    const descriptor = visualSessionDescriptors(options)[0]!;
    const controller = visualControllerFor(options, options[0]!.id);
    const view = render(<DualView options={options} controller={controller} projectId="project" availability="ready" onExit={() => {}} />);
    const scroller = () => screen.getByTestId("dual-view").querySelector<HTMLElement>("[data-testid='dual-pane-a'] .note-preview");
    const installScrollerGeometry = () => {
      const current = scroller();
      if (!current) return null;
      Object.defineProperty(current, "clientHeight", { configurable: true, value: 180 });
      Object.defineProperty(current, "scrollHeight", { configurable: true, value: 1_180 });
      return current;
    };
    await waitFor(() => expect(installScrollerGeometry()).not.toBeNull());
    installScrollerGeometry()!.scrollTop = 320;
    fireEvent.scroll(installScrollerGeometry()!);
    await waitFor(() => expect(controller.getSnapshot(descriptor.identity, "viewer-a", descriptor.sourceFingerprint)?.markdownScroll?.scrollTop).toBe(320));
    const readyGeneration = controller.captureGeneration();

    controller.reconcile({ scope: controller.getState().scope, availability: "loading" });
    view.rerender(<DualView options={[]} controller={controller} projectId="project" availability="loading" onExit={() => {}} />);
    expect(scroller()).toBeNull();
    expect(controller.getSnapshot(descriptor.identity, "viewer-a", descriptor.sourceFingerprint)).toBeNull();
    expect(controller.saveSnapshot(descriptor.identity, "viewer-a", { sourceFingerprint: descriptor.sourceFingerprint, representation: "markdown", markdownScroll: { scrollTop: 777, scrollRatio: 0.777, maxScroll: 1_000 } }, readyGeneration)).toBe(false);

    controller.reconcile({ scope: controller.getState().scope, availability: "ready", options: [descriptor] });
    view.rerender(<DualView options={options} controller={controller} projectId="project" availability="ready" onExit={() => {}} />);
    await waitFor(() => expect(installScrollerGeometry()?.scrollTop).toBe(320));
    expect(controller.getSnapshot(descriptor.identity, "viewer-a", descriptor.sourceFingerprint)?.markdownScroll?.scrollTop).toBe(320);

    controller.reconcile({ scope: controller.getState().scope, availability: "unavailable" });
    view.rerender(<DualView options={[]} controller={controller} projectId="project" availability="unavailable" onExit={() => {}} />);
    expect(scroller()).toBeNull();
    expect(controller.getSnapshot(descriptor.identity, "viewer-a", descriptor.sourceFingerprint)).toBeNull();
    const unavailableGeneration = controller.captureGeneration();
    expect(controller.saveSnapshot(descriptor.identity, "viewer-a", { sourceFingerprint: descriptor.sourceFingerprint, representation: "markdown", markdownScroll: { scrollTop: 777, scrollRatio: 0.777, maxScroll: 1_000 } }, unavailableGeneration)).toBe(false);

    controller.reconcile({ scope: controller.getState().scope, availability: "ready", options: [descriptor] });
    view.rerender(<DualView options={options} controller={controller} projectId="project" availability="ready" onExit={() => {}} />);
    await waitFor(() => expect(installScrollerGeometry()?.scrollTop).toBe(320));

    const revokedGeneration = controller.captureGeneration();
    controller.reconcile({ scope: controller.getState().scope, availability: "ready", options: [] });
    view.rerender(<DualView options={[]} controller={controller} projectId="project" availability="ready" onExit={() => {}} />);
    expect(controller.getState().snapshots.size).toBe(0);
    expect(controller.getState().selections).toEqual({ a: null, b: null });
    expect(controller.saveSnapshot(descriptor.identity, "viewer-a", { sourceFingerprint: descriptor.sourceFingerprint, representation: "markdown", markdownScroll: { scrollTop: 999, scrollRatio: 0.999, maxScroll: 1_000 } }, revokedGeneration)).toBe(false);
    expect(scroller()).toBeNull();

    const fingerprintChanged = makeOption(markdown + "\n\nEdited.");
    const changedFingerprintDescriptor = visualSessionDescriptors([fingerprintChanged])[0]!;
    controller.reconcile({ scope: controller.getState().scope, availability: "ready", options: [changedFingerprintDescriptor] });
    view.rerender(<DualView options={[fingerprintChanged]} controller={controller} projectId="project" availability="ready" onExit={() => {}} />);
    await waitFor(() => expect(installScrollerGeometry()).not.toBeNull());
    expect(controller.getSnapshot(descriptor.identity, "viewer-a", descriptor.sourceFingerprint)).toBeNull();
    expect(controller.getSnapshot(descriptor.identity, "viewer-a", changedFingerprintDescriptor.sourceFingerprint)).toBeNull();

    const sourceChanged = markdown + "\n\nRepresentation changed.";
    const markdownAgain = makeOption(sourceChanged);
    const markdownAgainDescriptor = visualSessionDescriptors([markdownAgain])[0]!;
    controller.reconcile({ scope: controller.getState().scope, availability: "ready", options: [markdownAgainDescriptor] });
    controller.saveSnapshot(markdownAgainDescriptor.identity, "viewer-a", { sourceFingerprint: markdownAgainDescriptor.sourceFingerprint, representation: "markdown", markdownScroll: { scrollTop: 240, scrollRatio: 0.24, maxScroll: 1_000 } }, controller.captureGeneration());
    const conceptual = makeOption(sourceChanged, "conceptual");
    const conceptualDescriptor = visualSessionDescriptors([conceptual])[0]!;
    controller.reconcile({ scope: controller.getState().scope, availability: "ready", options: [conceptualDescriptor] });
    view.rerender(<DualView options={[conceptual]} controller={controller} projectId="project" availability="ready" onExit={() => {}} />);
    expect(controller.getState().snapshots.size).toBe(0);
    expect(controller.getSnapshot(conceptualDescriptor.identity, "viewer-a", conceptualDescriptor.sourceFingerprint)).toBeNull();
    expect(scroller()).toBeNull();
  });

  it("hides an already-collapsed Explorer without changing its persistent preference", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    fireEvent.click(screen.getByRole("button", { name: "Collapse project explorer" }));
    const preferencesBefore = localStorage.getItem(UI_PREFERENCES_KEY);
    fireEvent.click(screen.getByTestId("compare-mode-button"));
    expect(screen.getByRole("button", { name: "Expand project explorer" })).toBeInTheDocument();
    expect(document.querySelector(".app__workspace")).toHaveClass("app__workspace--immersive");
    expect(localStorage.getItem(UI_PREFERENCES_KEY)).toBe(preferencesBefore);
    fireEvent.click(screen.getByRole("button", { name: "Close Dual View" }));
    expect(document.querySelector(".app__workspace")).not.toHaveClass("app__workspace--immersive");
    expect(localStorage.getItem(UI_PREFERENCES_KEY)).toBe(preferencesBefore);
  });

  it("switches both resources symmetrically and swaps their sessions", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    await command("New Diagram");
    await command("New Diagram");
    fireEvent.click(screen.getByTestId("analysis-mode-button"));
    const viewerA = screen.getByRole("combobox", { name: "Viewer A resource" }) as HTMLSelectElement;
    const viewerB = screen.getByRole("combobox", { name: "Viewer B resource" }) as HTMLSelectElement;
    const switchedA = Array.from(viewerA.options).find((option) => option.value !== viewerA.value && option.value !== viewerB.value)?.value;
    expect(switchedA).toBeDefined();
    fireEvent.change(viewerA, { target: { value: switchedA } });
    expect(viewerA).toHaveValue(switchedA);
    const beforeSwapA = viewerA.value;
    const beforeSwapB = viewerB.value;
    fireEvent.click(screen.getByRole("button", { name: "Swap viewers" }));
    expect(viewerA).toHaveValue(beforeSwapB);
    expect(viewerB).toHaveValue(beforeSwapA);
  });

  it("keeps comparison content usable at narrow widths by stacking viewers", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    await command("New Diagram");
    fireEvent.click(screen.getByTestId("analysis-mode-button"));
    expect(screen.getByTestId("comparison-view")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show editor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Maximize Viewer A" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Maximize Viewer B" })).toBeInTheDocument();
  });
});
