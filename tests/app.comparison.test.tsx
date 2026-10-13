import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./app-harness";
import ComparisonView, { type ComparisonOption } from "../src/features/preview/ComparisonView";
import type { ProjectIndex } from "../src/domain/project/project-index";
import type { DiagramFile, NoteFile, Project } from "../src/domain/workspace/types";
import { exportProjectToZip } from "../src/workspace/transfer/project-archive";

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

describe("App — dual viewer foundation", () => {
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
