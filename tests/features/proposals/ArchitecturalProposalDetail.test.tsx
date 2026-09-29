import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ArchitecturalProposalDetail, ProposalResourceComparison } from "../../../src/features/proposals/ArchitecturalProposalDetail";
import type { ServerApiClient, ServerArchitecturalProposalDiff, ServerArchitecturalProposal } from "../../../src/workspace/server/api-client";

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
  it("keeps the center concise and sends the selected canonical change to the inspector", async () => {
    const onDiffLoaded = vi.fn();
    render(<ArchitecturalProposalDetail client={client()} projectId="project-1" proposalId="proposal-1" authorDisplayName="Alice Reviewer" selectedDiffPath="overview.md" onDiffLoaded={onDiffLoaded} onBack={vi.fn()} />);

    expect(await screen.findByText("Document governed publication model")).toBeInTheDocument();
    expect(screen.getByText("Alice Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Explain why publication remains separately governed.")).toBeInTheDocument();
    expect(screen.getByTestId("proposal-impact")).toHaveTextContent("1 modified");
    expect(screen.getByRole("heading", { name: "Review state" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Comparison for overview.md")).not.toBeInTheDocument();
    expect(onDiffLoaded).toHaveBeenCalledWith(diff);
  });
});

describe("ProposalResourceComparison", () => {
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
});
