import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Explorer from "../../../src/features/explorer/Explorer";

const props = {
  projects: [{ id: "project-1", name: "Project", datasetIds: ["one", "two"] }],
  diagrams: [
    { id: "one", name: "one.seq", source: "title One", projectId: "project-1" },
    { id: "two", name: "two.seq", source: "title Two", projectId: "project-1" },
  ],
  selectedProjectId: "project-1",
  selectedDiagramId: null,
  isLoading: false,
  onCreateProject: vi.fn(),
  onLoadDiagram: vi.fn(),
};

describe("Explorer proposal indicators", () => {
  it("marks resources with open proposals and includes counts", () => {
    render(<Explorer {...props} openProposalCounts={{ one: 1, two: 2 }} />);
    expect(screen.getByTitle("1 open change")).toBeInTheDocument();
    expect(screen.getByTitle("2 open changes")).toBeInTheDocument();
    expect(screen.getAllByTestId("explorer-status-slot")).toHaveLength(2);
    expect(
      screen.getAllByTestId("explorer-status-slot")[0].parentElement,
    ).toHaveClass("explorer__diagram-button");
  });

  it("does not render a marker for resources without open proposals", () => {
    render(<Explorer {...props} />);
    expect(screen.queryByText("◆")).toBeNull();
  });

  it("keeps historical and promotion lifecycle labels discoverable", () => {
    render(<Explorer {...props} serverMode architecturalProposals={[
      { id: "open", title: "Open", authorUserId: "u", status: "open", baseSharedRevision: "r", lifecycle: { state: "OPEN" } },
      { id: "promoted", title: "Promoted", authorUserId: "u", status: "open", baseSharedRevision: "r", lifecycle: { state: "PROMOTED" } },
      { id: "withdrawn", title: "Withdrawn", authorUserId: "u", status: "withdrawn", baseSharedRevision: "r", lifecycle: { state: "WITHDRAWN" } },
      { id: "superseded", title: "Superseded", authorUserId: "u", status: "superseded", baseSharedRevision: "r", lifecycle: { state: "SUPERSEDED" } },
    ]} />);
    fireEvent.click(screen.getByTestId("explorer-proposals-toggle"));
    expect(screen.getByText("OPEN")).toBeInTheDocument();
    expect(screen.getByText("PROMOTED")).toBeInTheDocument();
    expect(screen.getByText("WITHDRAWN")).toBeInTheDocument();
    expect(screen.getByText("SUPERSEDED")).toBeInTheDocument();
  });
});
