import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ArchitecturalProposalSubmit } from "../../../src/features/proposals/ArchitecturalProposalSubmit";
import { ArchitecturalProposalDetail } from "../../../src/features/proposals/ArchitecturalProposalDetail";
import type { ServerApiClient } from "../../../src/workspace/server/api-client";
import { diffResources } from "../../../src/domain/diff/resource-diff";

function clientWith(overrides: Partial<ServerApiClient>): ServerApiClient {
  return overrides as ServerApiClient;
}

describe("governance UI intent", () => {
  it("opens the first canonical proposal change and offers text comparison modes", async () => {
    const base = "# Base\n\nold";
    const proposed = "# Base\n\nnew";
    const client = clientWith({
      getArchitecturalProposal: vi.fn().mockResolvedValue({ id: "p1", projectId: "p1", authorUserId: "u1", title: "Docs", status: "open", baseSharedRevision: "base", baseSharedResourceRevisions: { r1: 1 }, createdAt: "2026-01-01", submittedAt: "2026-01-01", resources: [{ sourceResourceId: "r1", path: "overview.md", type: "markdown-document", sourceRevision: 2, content: proposed, operation: "UPDATE" }], semanticMessages: [], relationships: [], capabilities: { "proposal.review": { capability: "proposal.review", allowed: true } } }),
      getArchitecturalProposalReviews: vi.fn().mockResolvedValue({ status: "none", approvals: 0, changesRequested: 0, reviews: [] }),
      getArchitecturalProposalDiff: vi.fn().mockResolvedValue({ proposalId: "p1", baseSharedRevision: "base", currentSharedRevision: "base", staleBase: false, resources: [{ ...diffResources({ content: base, type: "markdown-document" }, { content: proposed, type: "markdown-document" }), path: "overview.md", type: "markdown-document", operation: "MODIFIED", baseRevision: 1, baseContent: base, proposedContent: proposed }], relationships: [], semanticIdentities: [], impact: { resourcesAdded: 0, resourcesModified: 1, resourcesDeleted: 0, relationshipsChanged: 0, semanticIdentitiesChanged: 0 } }),
    });
    render(<ArchitecturalProposalDetail client={client} projectId="p1" proposalId="p1" onBack={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "MODIFIED overview.md" })).toBeInTheDocument();
    expect(screen.getAllByText("- old").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Side-by-side" }));
    expect(screen.getByText("BASE")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rendered" }));
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  it("confirms a non-authoritative submission without a SHARED write", async () => {
    const submit = vi.fn().mockResolvedValue({});
    const client = clientWith({
      listResources: vi.fn().mockResolvedValue([{ id: "r1", path: "checkout.seq", type: "sequence-diagram", revision: 2 }]),
      submitArchitecturalProposal: submit,
    });
    render(<ArchitecturalProposalSubmit client={client} projectId="p1" contextId="work" onCancel={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText("checkout.seq");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText("Proposal title"), { target: { value: "Checkout" } });
    expect(screen.getByText(/SHARED is not modified/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Submit proposal for review" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("p1", expect.objectContaining({ sourcePrivateContextId: "work", resourceIds: ["r1"], title: "Checkout" })));
  });

  it("keeps review separate and displays promotion operation categories and blockers", async () => {
    const review = vi.fn().mockResolvedValue({});
    const client = clientWith({
      getArchitecturalProposal: vi.fn().mockResolvedValue({ id: "p1", projectId: "p1", authorUserId: "u1", title: "Checkout", status: "open", baseSharedRevision: "r1", baseSharedResourceRevisions: {}, createdAt: "2026-01-01", submittedAt: "2026-01-01", resources: [{ sourceResourceId: "r1", path: "checkout.seq", type: "sequence-diagram", sourceRevision: 1, content: "", operation: "UPDATE" }], semanticMessages: [], relationships: [], staleBase: true, capabilities: { "proposal.review": { capability: "proposal.review", allowed: true }, "proposal.promote": { capability: "proposal.promote", allowed: true }, "proposal.previewPromotion": { capability: "proposal.previewPromotion", allowed: true } } }),
      getArchitecturalProposalReviews: vi.fn().mockResolvedValue({ status: "none", approvals: 0, changesRequested: 0, reviews: [] }),
      reviewArchitecturalProposal: review,
      previewArchitecturalProposalPromotion: vi.fn().mockResolvedValue({ eligible: false, reviewStatus: "none", staleBase: true, blockers: [{ code: "STALE_BASE", message: "Resource changed in SHARED since proposal submission" }], creates: [{ path: "new.seq", operation: "CREATE" }], updates: [], retires: [], semanticChanges: [], relationships: [] }),
    });
    render(<ArchitecturalProposalDetail client={client} projectId="p1" proposalId="p1" onBack={vi.fn()} />);
    await screen.findByText("Checkout");
    fireEvent.click(screen.getByRole("button", { name: "Preview promotion" }));
    expect(await screen.findByText(/CREATE/)).toBeInTheDocument();
    expect(screen.getByText(/Resource changed in SHARED/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Approve"));
    fireEvent.change(screen.getByPlaceholderText("Review summary (recommended)"), { target: { value: "Looks good" } });
    fireEvent.click(screen.getByRole("button", { name: "Record approval" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("p1", "p1", { decision: "APPROVE", summary: "Looks good" }));
  });

  it("submits a revision only through the explicit revision API", async () => {
    const revise = vi.fn().mockResolvedValue({ id: "p2" });
    const client = clientWith({
      listResources: vi.fn().mockResolvedValue([{ id: "r1", path: "checkout.seq", type: "sequence-diagram", revision: 3 }]),
      reviseArchitecturalProposal: revise,
    });
    const onDone = vi.fn();
    render(<ArchitecturalProposalSubmit client={client} projectId="p1" contextId="work" revisionProposalId="p1" onCancel={vi.fn()} onDone={onDone} />);
    await screen.findByText("checkout.seq");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText("Proposal title"), { target: { value: "Checkout v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit revision" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm revision" }));
    await waitFor(() => expect(revise).toHaveBeenCalledWith("p1", "p1", expect.objectContaining({ title: "Checkout v2" })));
    expect(onDone).toHaveBeenCalledWith("p2");
  });

  it("waits for the proposal read-model refresh before completing a revision", async () => {
    const revise = vi.fn().mockResolvedValue({ id: "p2" });
    let completeRefresh!: () => void;
    const refresh = new Promise<void>((resolve) => {
      completeRefresh = resolve;
    });
    const onDone = vi.fn(() => refresh);
    const client = clientWith({
      listResources: vi.fn().mockResolvedValue([{ id: "r1", path: "checkout.seq", type: "sequence-diagram", revision: 3 }]),
      reviseArchitecturalProposal: revise,
    });
    render(<ArchitecturalProposalSubmit client={client} projectId="p1" contextId="work" revisionProposalId="p1" onCancel={vi.fn()} onDone={onDone} />);
    await screen.findByText("checkout.seq");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText("Proposal title"), { target: { value: "Checkout v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit revision" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm revision" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("p2"));
    expect(screen.getByRole("button", { name: "Submit revision" })).toBeDisabled();
    completeRefresh();
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit revision" })).not.toBeDisabled());
  });

  it.each(["PROMOTED", "PROMOTING"] as const)("reconstructs %s from the detail read model after reload", async (state) => {
    const get = vi.fn().mockResolvedValue({ id: "p1", projectId: "p1", authorUserId: "u1", title: "Checkout", status: "open", lifecycle: { state }, baseSharedRevision: "r1", baseSharedResourceRevisions: {}, createdAt: "2026-01-01", submittedAt: "2026-01-01", resources: [], semanticMessages: [], relationships: [], capabilities: {} });
    const client = clientWith({ getArchitecturalProposal: get, getArchitecturalProposalReviews: vi.fn().mockResolvedValue({ status: "none", approvals: 0, changesRequested: 0, reviews: [] }) });
    const view = render(<ArchitecturalProposalDetail client={client} projectId="p1" proposalId="p1" onBack={vi.fn()} />);
    expect(await screen.findByText(state, { exact: false })).toBeInTheDocument();
    view.unmount();
    render(<ArchitecturalProposalDetail client={client} projectId="p1" proposalId="p1" onBack={vi.fn()} />);
    expect(await screen.findByText(state, { exact: false })).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
  });
});
