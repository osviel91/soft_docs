import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ArchitecturalProposalSubmit } from "../../../src/features/proposals/ArchitecturalProposalSubmit";
import { ArchitecturalProposalDetail } from "../../../src/features/proposals/ArchitecturalProposalDetail";
import type { ServerApiClient } from "../../../src/workspace/server/api-client";

function clientWith(overrides: Partial<ServerApiClient>): ServerApiClient {
  return overrides as ServerApiClient;
}

describe("governance UI intent", () => {
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
});
