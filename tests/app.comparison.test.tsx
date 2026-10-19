import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./app-harness";
import ComparisonView, { RevisionDiffSummary, type ComparisonOption, type RevisionComparisonResource } from "../src/features/preview/ComparisonView";
import type { ProjectIndex } from "../src/domain/project/project-index";
import type { DiagramFile, NoteFile, Project } from "../src/domain/workspace/types";
import type { ResourceDiff } from "../src/domain/diff/resource-diff";
import type { ServerResourceRevision, ServerResourceRevisionSummary } from "../src/workspace/server/api-client";
import { exportProjectToZip } from "../src/workspace/transfer/project-archive";
import { defaultUiPreferences, UI_PREFERENCES_KEY, writeUiPreferences } from "../src/workspace/ui-preferences";

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

function revisionSnapshot(revision: number, content: string, type: "conceptual" | "database" = "conceptual"): ServerResourceRevision {
  return { ...revisionResource, revision, type, representation: type, content, authoredBy: { kind: "user", userId: "owner", subjectUserId: "owner" }, createdAt: `2026-01-0${revision}T00:00:00.000Z` };
}

function revisionClient(snapshots: ServerResourceRevision[]) {
  const summaries: ServerResourceRevisionSummary[] = snapshots.map(({ resourceId, projectId, contextId, revision, type, representation, createdAt }) => ({ resourceId, projectId, contextId, revision, type, representation, createdAt }));
  return {
    listResourceRevisions: async () => summaries,
    getResourceRevision: async (_projectId: string, _resourceId: string, _contextId: string | null, revision: number) => snapshots.find((snapshot) => snapshot.revision === revision)!,
  };
}

function renderRevisionCompare(snapshots: ServerResourceRevision[], type: "conceptual" | "database" = "conceptual") {
  const resource: DiagramFile = { id: "file-id", name: type === "conceptual" ? "model.concept" : "schema.dbschema", source: snapshots.at(-1)?.content ?? "", projectId: "project" };
  return render(<ComparisonView
    primary={resource}
    primarySource={resource.source}
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
    revisionResource={{ ...revisionResource, type }}
  />);
}

describe("App — dual viewer foundation", () => {
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

  it("enters and exits Sequence to Sequence comparison", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    await command("New Diagram");
    fireEvent.click(screen.getByTestId("compare-mode-button"));

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
    fireEvent.click(screen.getByTestId("compare-mode-button"));

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

    expect(screen.getByTestId("compare-mode-button")).toBeEnabled();
    fireEvent.click(screen.getByTestId("compare-mode-button"));
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
    fireEvent.click(screen.getByTestId("compare-mode-button"));

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
    expect(screen.queryByTestId("revision-diff-summary")).toBeNull();
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
    fireEvent.click(screen.getByTestId("compare-mode-button"));
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
    fireEvent.click(screen.getByTestId("compare-mode-button"));

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
    fireEvent.click(screen.getByTestId("compare-mode-button"));

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
    fireEvent.click(screen.getByTestId("compare-mode-button"));

    fireEvent.click(screen.getByRole("button", { name: "Hide editor" }));
    expect(screen.getByTestId("dsl-textarea")).toHaveValue("participant Dirty");
    expect(screen.getByRole("button", { name: "Show editor" })).toBeInTheDocument();
    expect(screen.getByTestId("comparison-view").closest("main")).toHaveClass("app__workspace--comparison-editor-hidden");
    fireEvent.click(screen.getByRole("button", { name: "Show editor" }));
    expect(screen.getByTestId("dsl-textarea")).toHaveValue("participant Dirty");
  });

  it("switches both resources symmetrically and swaps their sessions", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    await command("New Diagram");
    await command("New Diagram");
    fireEvent.click(screen.getByTestId("compare-mode-button"));
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
    fireEvent.click(screen.getByTestId("compare-mode-button"));
    expect(screen.getByTestId("comparison-view")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show editor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Maximize Viewer A" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Maximize Viewer B" })).toBeInTheDocument();
  });
});
