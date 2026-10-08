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
    fireEvent.click(screen.getByTestId("explorer-archived-proposals-toggle"));
    expect(screen.getByText("OPEN")).toBeInTheDocument();
    expect(screen.getByText("PROMOTED")).toBeInTheDocument();
    expect(screen.getByText("WITHDRAWN")).toBeInTheDocument();
    expect(screen.getByText("SUPERSEDED")).toBeInTheDocument();
  });

  it("does not mark withdrawn proposals as revising and moves draft actions into a context menu", () => {
    const onMyWorkMenu = vi.fn();
    const onProposalMenu = vi.fn();
    render(<Explorer {...props} serverMode privateWorkContexts={[{ id: "work", name: "Draft", lifecycle: "active" }]} onMyWorkMenu={onMyWorkMenu} onProposalMenu={onProposalMenu} architecturalProposals={[
      { id: "withdrawn", title: "Withdrawn", authorUserId: "u", status: "withdrawn", baseSharedRevision: "r", lifecycle: { state: "WITHDRAWN" } },
    ]} revisingProposalId="withdrawn" />);

    expect(screen.queryByRole("button", { name: "Submit new proposal" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions for MY WORK Draft" }));
    expect(onMyWorkMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "work" }), expect.any(Object));
    fireEvent.click(screen.getByTestId("explorer-archived-proposals-toggle"));
    fireEvent.click(screen.getByRole("button", { name: "Actions for proposal Withdrawn" }));
    expect(onProposalMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "withdrawn" }), expect.any(Object));
    expect(screen.getByTestId("explorer-proposal")).not.toHaveAttribute("data-revising", "true");
    expect(screen.queryByTestId("explorer-revision-origin")).not.toBeInTheDocument();
  });

  it("uses the MY WORK plus button to add an artifact to the active context", () => {
    const onAddMenu = vi.fn();
    render(<Explorer {...props} serverMode activeContextId="work" onAddMenu={onAddMenu} onCreateMyWork={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Create artifact in MY WORK" }));
    expect(onAddMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "project-1" }), expect.any(Object));
  });

  it("expands populated private work and keeps proposal selection across refreshes", () => {
    const proposal = { id: "proposal-1", title: "Same title", authorUserId: "u", status: "open" as const, baseSharedRevision: "r", submittedAt: "2026-01-01T00:00:00Z" };
    const view = render(<Explorer {...props} serverMode privateWorkContexts={[{ id: "work", name: "Draft", lifecycle: "active" }]} architecturalProposals={[proposal]} selectedProposalId={proposal.id} />);
    expect(screen.getByTestId("explorer-my-work-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("explorer-proposals-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("explorer-proposal")).toHaveClass("explorer__context-item--selected");
    view.rerender(<Explorer {...props} serverMode privateWorkContexts={[{ id: "work", name: "Draft", lifecycle: "active" }]} architecturalProposals={[{ ...proposal, status: "withdrawn" }]} selectedProposalId={proposal.id} />);
    expect(screen.getByTestId("explorer-proposal")).toHaveClass("explorer__context-item--selected");
  });

  it("does not reopen a section after the user collapses it", () => {
    const proposal = { id: "proposal-1", title: "Proposal", authorUserId: "u", status: "open" as const, baseSharedRevision: "r" };
    const view = render(<Explorer {...props} serverMode architecturalProposals={[proposal]} />);
    fireEvent.click(screen.getByTestId("explorer-proposals-toggle"));
    expect(screen.getByTestId("explorer-proposals-toggle")).toHaveAttribute("aria-expanded", "false");
    view.rerender(<Explorer {...props} serverMode architecturalProposals={[{ ...proposal, title: "Updated" }]} />);
    expect(screen.getByTestId("explorer-proposals-toggle")).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps terminal proposals archived and reveals the selected archived proposal", () => {
    const proposals = [
      { id: "open", title: "Open", authorUserId: "u", status: "open" as const, baseSharedRevision: "r" },
      { id: "promoted", title: "Promoted", authorUserId: "u", status: "open" as const, baseSharedRevision: "r", lifecycle: { state: "PROMOTED" as const } },
      { id: "withdrawn", title: "Withdrawn", authorUserId: "u", status: "withdrawn" as const, baseSharedRevision: "r" },
    ];
    const view = render(<Explorer {...props} serverMode architecturalProposals={proposals} />);

    expect(screen.getAllByTestId("explorer-proposal")).toHaveLength(1);
    expect(screen.getByTestId("explorer-archived-proposals-toggle")).toHaveTextContent("Archived · 2");
    view.rerender(<Explorer {...props} serverMode architecturalProposals={proposals} selectedProposalId="withdrawn" />);
    expect(screen.getAllByTestId("explorer-proposal")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Open proposal Withdrawn" })).toHaveAttribute("aria-current", "true");
  });
});
