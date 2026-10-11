import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ArchitectureInbox from "../../../src/features/proposals/ArchitectureInbox";
import type { ServerApiClient, ServerProposalInbox } from "../../../src/workspace/server/api-client";
import { ResourceNotFoundError } from "../../../src/workspace/server/api-errors";

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
    myReview: { decision: "APPROVE", createdAt: "2026-01-01T01:00:00.000Z", updatedAt: "2026-01-01T01:00:00.000Z" },
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
    render(<ArchitectureInbox client={client} onOpen={onOpen} onBack={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /Governed publication/ })).toHaveTextContent("Platform / Checkout");
    fireEvent.change(screen.getByLabelText("Governance situation"), { target: { value: "APPROVED_PENDING_PROMOTION" } });
    await waitFor(() => expect(client.listProposalInbox).toHaveBeenLastCalledWith(expect.objectContaining({ attentionCategory: ["APPROVED_PENDING_PROMOTION"] })));
    fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "workspace-1" } });
    await waitFor(() => expect(client.listProposalInbox).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: "workspace-1" })));
    expect(window.location.search).toContain("workspace=workspace-1");
    expect(window.location.search).not.toContain("project=");
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Governed publication/ }));
    expect(onOpen).toHaveBeenCalledWith(inbox.items[0], expect.stringContaining("inbox=proposals"));
    expect(screen.getByText(/Your latest decision: Approved/)).toBeInTheDocument();
    expect(screen.getByText(/Last activity/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Governed publication/ })).toHaveTextContent("Approved, promotion not evaluated");
    expect(screen.queryByText(/Assigned to you|Pending review|Unread|New since your last visit/i)).toBeNull();
  });

  it("renders a personal change request separately from the global category, and omits it when absent", async () => {
    const changed = { ...inbox, items: [{ ...inbox.items[0]!, myReview: { decision: "REQUEST_CHANGES" as const, createdAt: "2026-01-01T01:00:00.000Z", updatedAt: "2026-01-01T02:00:00.000Z" } }] };
    const client = {
      listWorkspaces: vi.fn().mockResolvedValue([]),
      listProjects: vi.fn().mockResolvedValue([]),
      listProposalInbox: vi.fn().mockResolvedValue(changed),
    } as unknown as ServerApiClient;
    const view = render(<ArchitectureInbox client={client} onOpen={vi.fn()} onBack={vi.fn()} />);
    expect(await screen.findByText(/Your latest decision: Changes requested/)).toBeInTheDocument();
    expect(screen.getByText(/Changes requested ·/)).toBeInTheDocument();

    view.unmount();
    const withoutReview = { ...inbox, items: [{ ...inbox.items[0]!, myReview: null }] };
    const noReviewClient = { ...client, listProposalInbox: vi.fn().mockResolvedValue(withoutReview) } as unknown as ServerApiClient;
    render(<ArchitectureInbox client={noReviewClient} onOpen={vi.fn()} onBack={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /Governed publication/ })).toBeInTheDocument();
    expect(screen.queryByText(/Your latest decision/)).toBeNull();
  });

  it("distinguishes a globally empty inbox, filtered-empty results and request errors", async () => {
    const empty = { items: [], nextCursor: null, counts: { PENDING_REVIEW: 0, CHANGES_REQUESTED: 0, APPROVED_PENDING_PROMOTION: 0, PROMOTION_COMPLETION_PENDING: 0, PROMOTED: 0, WITHDRAWN: 0, SUPERSEDED: 0 } };
    const client = {
      listWorkspaces: vi.fn().mockResolvedValue([]),
      listProjects: vi.fn().mockResolvedValue([]),
      listProposalInbox: vi.fn().mockResolvedValue(empty),
    } as unknown as ServerApiClient;
    const view = render(<ArchitectureInbox client={client} onOpen={vi.fn()} onBack={vi.fn()} />);
    expect(await screen.findByText("No proposals are available in your accessible workspaces.")).toBeInTheDocument();

    view.unmount();
    window.history.replaceState({}, "", "/?q=not-found");
    const filtered = render(<ArchitectureInbox client={client} onOpen={vi.fn()} onBack={vi.fn()} />);
    expect(await screen.findByText("No proposals match these filters.")).toBeInTheDocument();

    filtered.unmount();
    window.history.replaceState({}, "", "/");
    const failedClient = { ...client, listProposalInbox: vi.fn().mockRejectedValue(new Error("request failed")) } as unknown as ServerApiClient;
    render(<ArchitectureInbox client={failedClient} onOpen={vi.fn()} onBack={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("request failed");
  });

  it("does not present an empty result when the accessible catalog fails", async () => {
    const client = {
      listWorkspaces: vi.fn().mockRejectedValue(new Error("forbidden")),
      listProjects: vi.fn(),
      listProposalInbox: vi.fn().mockResolvedValue({ items: [], nextCursor: null, counts: inbox.counts }),
    } as unknown as ServerApiClient;
    render(<ArchitectureInbox client={client} onOpen={vi.fn()} onBack={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load accessible workspaces and projects.");
    expect(screen.queryByText("No proposals are available in your accessible workspaces.")).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("omits platform-admin workspaces without project membership without failing the accessible catalog", async () => {
    const client = {
      listWorkspaces: vi.fn().mockResolvedValue([
        { id: "workspace-1", name: "Accessible" },
        { id: "workspace-hidden", name: "Not a member" },
      ]),
      listProjects: vi.fn((workspaceId: string) => workspaceId === "workspace-hidden"
        ? Promise.reject(new ResourceNotFoundError("No workspace with id workspace-hidden."))
        : Promise.resolve([{ id: "project-1", workspaceId, name: "Checkout" }])),
      listProposalInbox: vi.fn().mockResolvedValue({ items: [], nextCursor: null, counts: inbox.counts }),
    } as unknown as ServerApiClient;
    render(<ArchitectureInbox client={client} onOpen={vi.fn()} onBack={vi.fn()} />);

    const workspaceFilter = screen.getByLabelText("Workspace");
    expect(await screen.findByRole("option", { name: "Accessible" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Not a member" })).toBeNull();
    expect(screen.getByRole("option", { name: "Checkout" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(workspaceFilter).toHaveValue("");
  });
});
