import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectShareDialog from "../../src/features/project/ProjectShareDialog";
import PublicProjectReader from "../../src/features/project/PublicProjectReader";
import { ServerApiClient, type PublicSharedProject } from "../../src/workspace/server/api-client";

const project: PublicSharedProject = {
  project: { name: "Checkout" }, folders: [], catalog: {},
  resources: [{ id: "doc", path: "overview.md", type: "markdown-document", revision: 1, title: "Overview", content: "# Welcome\n\n[Architecture](architecture.seq)" }, { id: "seq", path: "architecture.seq", type: "sequence-diagram", revision: 1, title: "Architecture", content: "title: Checkout\nparticipant Browser\nparticipant API\nBrowser->API: submit" }],
};
const api = (overrides: Partial<ServerApiClient>) => Object.assign(Object.create(ServerApiClient.prototype), overrides) as ServerApiClient;
afterEach(() => vi.restoreAllMocks());

describe("project sharing UI", () => {
  it("renders only the public projection and navigates links within it", async () => {
    const client = api({ readPublicSharedProject: vi.fn().mockResolvedValue(project) });
    vi.spyOn(ServerApiClient.prototype, "readPublicSharedProject").mockImplementation(client.readPublicSharedProject);
    render(<PublicProjectReader token="secret" />);
    expect(await screen.findByRole("heading", { name: "Checkout" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Welcome" }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("link", { name: "Architecture" }));
    expect(await screen.findByTestId("diagram-preview")).toBeInTheDocument();
    expect(client.readPublicSharedProject).toHaveBeenCalledWith("secret");
    expect(screen.queryByText(/workspace|sign in|proposal/i)).not.toBeInTheDocument();
  });

  it("shows a safe unavailable state without exposing the token", async () => {
    const client = api({ readPublicSharedProject: vi.fn().mockRejectedValue(new Error("unavailable")) });
    vi.spyOn(ServerApiClient.prototype, "readPublicSharedProject").mockImplementation(client.readPublicSharedProject);
    render(<PublicProjectReader token="secret" />);
    expect(await screen.findByText("This shared project is no longer available.")).toBeInTheDocument();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
  });

  it("creates an ephemeral copyable URL and confirms revocation", async () => {
    const grant = { id: "g1", projectId: "p1", createdByUserId: "u1", createdAt: "2026-01-01", expiresAt: "2026-01-31", revokedAt: null, revokedByUserId: null, state: "ACTIVE" as const };
    const client = api({ listProjectShares: vi.fn().mockResolvedValue([grant]), createProjectShare: vi.fn().mockResolvedValue({ token: "bearer", grant }), revokeProjectShare: vi.fn().mockResolvedValue(undefined) });
    render(<ProjectShareDialog projectId="p1" client={client} onClose={vi.fn()} />);
    await screen.findByText("Active");
    fireEvent.click(screen.getByRole("button", { name: "Create read-only link" }));
    const link = await screen.findByLabelText("Read-only link") as HTMLInputElement;
    expect(link.value).toContain("/share/bearer");
    expect(client.createProjectShare).toHaveBeenCalledWith("p1");
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke link" }));
    await waitFor(() => expect(client.revokeProjectShare).toHaveBeenCalledWith("p1", "g1"));
  });
});
