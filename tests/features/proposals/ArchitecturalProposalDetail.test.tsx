import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ArchitecturalProposalDetail, ProposalResourceComparison } from "../../../src/features/proposals/ArchitecturalProposalDetail";
import type { ServerApiClient, ServerArchitecturalProposalDiff, ServerArchitecturalProposal } from "../../../src/workspace/server/api-client";
import { diffResources } from "../../../src/domain/diff/resource-diff";

const diff: ServerArchitecturalProposalDiff = {
  proposalId: "proposal-1",
  baseSharedRevision: "shared-1",
  currentSharedRevision: "shared-1",
  staleBase: false,
  resources: [{
    path: "overview.md",
    type: "markdown-document",
    operation: "MODIFIED",
    baseRevision: 2,
    baseContent: "# Existing heading\n\nExisting paragraph\n\nExisting rule",
    proposedContent: "# Existing heading\n\nExisting paragraph\n\nNew explanation\n\nExisting rule",
    changed: true,
    metadata: { changed: false, changes: [] },
    content: { available: true, changes: [], diagnostics: [], truncated: false, totalChanges: 0, returnedChanges: 0 },
    source: { changed: true, hunks: [{ oldStart: 4, newStart: 4, oldLines: [], newLines: ["New explanation"] }], truncated: false, totalHunks: 1, returnedHunks: 1 },
  }],
  relationships: [],
  semanticIdentities: [],
  impact: { resourcesAdded: 0, resourcesModified: 1, resourcesDeleted: 0, relationshipsChanged: 0, semanticIdentitiesChanged: 0 },
};

const proposal: ServerArchitecturalProposal = {
  id: "proposal-1",
  projectId: "project-1",
  authorUserId: "user-1",
  title: "Document governed publication model",
  description: "Explain why publication remains separately governed.",
  status: "open",
  baseSharedRevision: "shared-1",
  baseSharedResourceRevisions: { overview: 2 },
  createdAt: "2026-09-29T10:00:00.000Z",
  submittedAt: "2026-09-29T10:00:00.000Z",
  resources: [{ sourceResourceId: "overview", path: "overview.md", type: "markdown-document", sourceRevision: 3, content: diff.resources[0].proposedContent, operation: "UPDATE" }],
  semanticMessages: [],
  relationships: [],
  revisionContextId: "context-1",
  capabilities: {
    "proposal.review": { capability: "proposal.review", allowed: true },
    "proposal.revise": { capability: "proposal.revise", allowed: false, reason: "not_owner" },
    "proposal.withdraw": { capability: "proposal.withdraw", allowed: false },
  },
};

function client(): ServerApiClient {
  return {
    getArchitecturalProposal: vi.fn().mockResolvedValue(proposal),
    getArchitecturalProposalReviews: vi.fn().mockResolvedValue({ status: "none", approvals: 0, changesRequested: 0, reviews: [] }),
    getArchitecturalProposalDiff: vi.fn().mockResolvedValue(diff),
    reviewArchitecturalProposal: vi.fn(),
  } as unknown as ServerApiClient;
}

describe("ArchitecturalProposalDetail", () => {
  it.each(["withdrawn", "superseded"] as const)("hides promotion controls for a %s proposal", async (status) => {
    const api = client();
    vi.mocked(api.getArchitecturalProposal).mockResolvedValue({
      ...proposal,
      status,
      lifecycle: { state: status === "withdrawn" ? "WITHDRAWN" : "SUPERSEDED" },
      capabilities: {
        ...proposal.capabilities,
        "proposal.previewPromotion": { capability: "proposal.previewPromotion", allowed: true },
      },
    });
    render(<ArchitecturalProposalDetail client={api} projectId="project-1" proposalId="proposal-1" onBack={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: proposal.title })).toBeInTheDocument();
    expect(screen.queryByLabelText("Proposal promotion")).not.toBeInTheDocument();
    expect(screen.getByText(status.toUpperCase())).toBeInTheDocument();
  });

  it("shows proposal actions beside each other and matches the workspace hide-control styling", async () => {
    const api = client();
    const onRevise = vi.fn();
    vi.mocked(api.getArchitecturalProposal).mockResolvedValue({
      ...proposal,
      capabilities: {
        ...proposal.capabilities,
        "proposal.revise": { capability: "proposal.revise", allowed: true },
        "proposal.withdraw": { capability: "proposal.withdraw", allowed: true },
      },
    });
    render(<ArchitecturalProposalDetail client={api} projectId="project-1" proposalId="proposal-1" onBack={vi.fn()} onHideDetails={vi.fn()} onRevise={onRevise} />);

    expect(await screen.findByRole("heading", { name: proposal.title })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide proposal details" })).toHaveClass("button", "button--ghost", "button--small");
    const edit = screen.getByRole("button", { name: "Edit revision" });
    const withdraw = screen.getByRole("button", { name: "Withdraw proposal" });
    expect(edit).toHaveClass("button", "button--ghost", "button--small");
    expect(withdraw).toHaveClass("button", "button--ghost", "button--small", "button--danger-text");
    expect(edit.closest(".proposal-detail__actions")).toBe(withdraw.closest(".proposal-detail__actions"));
    fireEvent.click(edit);
    expect(onRevise).toHaveBeenCalledWith("context-1", "proposal-1", "overview", [{ resourceId: "overview", path: "overview.md", type: "markdown-document", content: diff.resources[0].proposedContent }], proposal.title, proposal.description);
  });

  it("keeps the center concise and sends the selected canonical change to the inspector", async () => {
    const onDiffLoaded = vi.fn();
    render(<ArchitecturalProposalDetail client={client()} projectId="project-1" proposalId="proposal-1" authorDisplayName="Alice Reviewer" selectedDiffPath="overview.md" onDiffLoaded={onDiffLoaded} onBack={vi.fn()} />);

    expect(await screen.findByText("Document governed publication model")).toBeInTheDocument();
    expect(screen.getByText("Alice Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Explain why publication remains separately governed.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Impact" }));
    expect(screen.getByTestId("proposal-impact")).toHaveTextContent("1 modified");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("heading", { name: "Review state" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Comparison for overview.md")).not.toBeInTheDocument();
    expect(onDiffLoaded).toHaveBeenCalledWith(diff);
  });

  it("summarizes Database proposal impact from parsed semantic changes", async () => {
    const baseContent = 'table orders - "Orders"\ncolumn orders order_id "id" {uuid} not-null\nprimary-key orders_pk orders (id)\nindex orders_ix orders (id)';
    const proposedContent = 'table orders - "Sales Orders"\ncolumn orders order_id "id" {uuid} not-null\nprimary-key orders_pk orders (id)';
    const semantic = diffResources({ content: baseContent, type: "database" }, { content: proposedContent, type: "database" });
    const api = client();
    vi.mocked(api.getArchitecturalProposalDiff).mockResolvedValue({ ...diff, resources: [{ ...semantic, path: "orders.dbschema", type: "database", operation: "MODIFIED", baseContent, proposedContent }] });
    vi.mocked(api.getArchitecturalProposal).mockResolvedValue({ ...proposal, resources: [{ sourceResourceId: "orders", path: "orders.dbschema", type: "database", sourceRevision: 2, content: proposedContent, operation: "UPDATE" }] });
    render(<ArchitecturalProposalDetail client={api} projectId="project-1" proposalId="proposal-1" onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Impact" }));
    expect(await screen.findByTestId("database-semantic-impact")).toHaveTextContent("1 table modified, 1 index removed");
  });
});

describe("ProposalResourceComparison", () => {
  it("renders Database Before, After, and Compare from the semantic resource diff", async () => {
    const baseContent = 'table customer - "Customer"';
    const proposedContent = 'table customer - "AccountHolder"';
    const computed = diffResources({ content: baseContent, type: "database" }, { content: proposedContent, type: "database" });
    const resource = { ...computed, path: "billing.dbschema", type: "database" as const, operation: "MODIFIED" as const, baseContent, proposedContent };
    const view = render(<ProposalResourceComparison resource={resource} mode="before" onModeChange={vi.fn()} />);
    expect(await screen.findByTestId("database-preview-svg")).toBeInTheDocument();
    expect(view.container.textContent).toContain("Customer");
    expect(view.container.textContent).not.toContain("AccountHolder");
    view.rerender(<ProposalResourceComparison resource={resource} mode="after" onModeChange={vi.fn()} />);
    expect(await screen.findByTestId("database-preview-svg")).toBeInTheDocument();
    expect(view.container.textContent).toContain("AccountHolder");
    expect(view.container.textContent).not.toContain("Customer");
    view.rerender(<ProposalResourceComparison resource={resource} mode="compare" onModeChange={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByTestId("database-preview-svg")).toHaveLength(2));
  });

  it("switches text modes and aligns unchanged context in side-by-side view", () => {
    let mode: "unified" | "side-by-side" = "unified";
    const view = render(<ProposalResourceComparison resource={diff.resources[0]} mode={mode} onModeChange={(next) => { mode = next as typeof mode; view.rerender(<ProposalResourceComparison resource={diff.resources[0]} mode={mode} onModeChange={(value) => { mode = value as typeof mode; }} />); }} />);
    fireEvent.click(screen.getByRole("button", { name: "Side-by-side" }));
    expect(screen.getAllByText((_, element) => element?.textContent?.includes("# Existing heading") === true).length).toBeGreaterThan(0);
    expect(screen.getAllByText((_, element) => element?.textContent?.includes("Existing paragraph") === true).length).toBeGreaterThan(0);
    expect(screen.getAllByText((_, element) => element?.textContent?.includes("New explanation") === true).length).toBeGreaterThan(0);
    expect(screen.getAllByText("BASE")).toHaveLength(1);
    expect(screen.getAllByText("PROPOSED")).toHaveLength(1);
  });

  it("marks changed Markdown lines in side-by-side even when the source flag is stale", () => {
    const baseContent = "# Data contracts\n\nExisting content";
    const proposedContent = `${baseContent}\n\nREVISIONNOTECHANGE`;
    const computed = diffResources(
      { content: baseContent, type: "markdown-document" },
      { content: proposedContent, type: "markdown-document" },
    );
    const resource = {
      ...computed,
      path: "data-contracts.md",
      type: "markdown-document" as const,
      operation: "MODIFIED" as const,
      baseContent,
      proposedContent,
      source: { ...computed.source, changed: false },
    };
    render(<ProposalResourceComparison resource={resource} mode="side-by-side" onModeChange={vi.fn()} />);

    expect(screen.queryByText("No textual changes.")).not.toBeInTheDocument();
    expect(screen.getByText("REVISIONNOTECHANGE").closest(".proposal-review__line")).toHaveClass("proposal-review__line--added");
  });

  it("leaves the submitted side empty for an artifact added by the proposal", async () => {
    const baseContent = "";
    const proposedContent = "title New artifact\nparticipant AddedOnly\n";
    const computed = diffResources(
      { content: baseContent, type: "sequence-diagram" },
      { content: proposedContent, type: "sequence-diagram" },
    );
    const resource = {
      ...computed,
      path: "new.seq",
      type: "sequence-diagram" as const,
      operation: "ADDED" as const,
      baseContent,
      proposedContent,
    };
    render(<ProposalResourceComparison resource={resource} mode="compare" onModeChange={vi.fn()} beforeLabel="SUBMITTED VERSION" afterLabel="MY WORK NOW" />);

    const basePane = screen.getByRole("heading", { name: "SUBMITTED VERSION" }).closest("section");
    const myWorkPane = screen.getByRole("heading", { name: "MY WORK NOW" }).closest("section");
    expect(basePane).not.toContainHTML("AddedOnly");
    expect(myWorkPane).toContainHTML("AddedOnly");
    expect(basePane?.querySelectorAll(".review-change--added, .review-change--removed")).toHaveLength(0);
    expect(myWorkPane?.querySelectorAll(".review-change--added").length).toBeGreaterThan(0);
  });
});
