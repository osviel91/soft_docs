import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ArchitectureInbox from "../../../src/features/proposals/ArchitectureInbox";
import type { ServerApiClient, ServerProposalInbox } from "../../../src/workspace/server/api-client";

const inbox: ServerProposalInbox = {
  items: [{
    proposalId: "proposal-1",
    title: "Governed publication",
    status: "open",
    author: { userId: "author-1", displayName: "Ada" },
    workspace: { id: "workspace-1", name: "Platform" },
    project: { id: "project-1", name: "Checkout" },
    createdAt: "2026-01-01T00:00:00.000Z",
    submittedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-02T00:00:00.000Z",
    review: { status: "approved", approvals: 1, changesRequested: 0 },
    promotion: { status: null, createdAt: null, completedAt: null },
    lifecycle: "APPROVED",
    attentionCategory: "APPROVED_PENDING_PROMOTION",
  }],
  nextCursor: "cursor-next",
  counts: { PENDING_REVIEW: 2, CHANGES_REQUESTED: 1, APPROVED_PENDING_PROMOTION: 1, PROMOTION_COMPLETION_PENDING: 0, PROMOTED: 0, WITHDRAWN: 0, SUPERSEDED: 0 },
};

describe("ArchitectureInbox", () => {
  beforeEach(() => window.history.replaceState({}, "", "/"));

  it("shows cross-project context, filters on the server and opens a stable proposal destination", async () => {
    const client = {
      listWorkspaces: vi.fn().mockResolvedValue([{ id: "workspace-1", name: "Platform" }]),
      listProjects: vi.fn().mockResolvedValue([{ id: "project-1", workspaceId: "workspace-1", name: "Checkout" }]),
      listProposalInbox: vi.fn().mockResolvedValue(inbox),
    } as unknown as ServerApiClient;
    const onOpen = vi.fn();
    render(<ArchitectureInbox client={client} onOpen={onOpen} />);

    expect(await screen.findByRole("button", { name: /Governed publication/ })).toHaveTextContent("Platform / Checkout");
    fireEvent.change(screen.getByLabelText("Situation"), { target: { value: "APPROVED_PENDING_PROMOTION" } });
    await waitFor(() => expect(client.listProposalInbox).toHaveBeenLastCalledWith(expect.objectContaining({ attentionCategory: ["APPROVED_PENDING_PROMOTION"] })));
    fireEvent.click(screen.getByRole("button", { name: /Governed publication/ }));
    expect(onOpen).toHaveBeenCalledWith(inbox.items[0], expect.stringContaining("inbox=proposals"));
  });

  it("distinguishes a globally empty inbox, filtered-empty results and request errors", async () => {
    const empty = { items: [], nextCursor: null, counts: { PENDING_REVIEW: 0, CHANGES_REQUESTED: 0, APPROVED_PENDING_PROMOTION: 0, PROMOTION_COMPLETION_PENDING: 0, PROMOTED: 0, WITHDRAWN: 0, SUPERSEDED: 0 } };
    const client = {
      listWorkspaces: vi.fn().mockResolvedValue([]),
      listProjects: vi.fn().mockResolvedValue([]),
      listProposalInbox: vi.fn().mockResolvedValue(empty),
    } as unknown as ServerApiClient;
    const view = render(<ArchitectureInbox client={client} onOpen={vi.fn()} />);
    expect(await screen.findByText("No proposals are available in your accessible workspaces.")).toBeInTheDocument();

    view.unmount();
    window.history.replaceState({}, "", "/?q=not-found");
    const filtered = render(<ArchitectureInbox client={client} onOpen={vi.fn()} />);
    expect(await screen.findByText("No proposals match these filters.")).toBeInTheDocument();

    filtered.unmount();
    window.history.replaceState({}, "", "/");
    const failedClient = { ...client, listProposalInbox: vi.fn().mockRejectedValue(new Error("request failed")) } as unknown as ServerApiClient;
    render(<ArchitectureInbox client={failedClient} onOpen={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("request failed");
  });
});
