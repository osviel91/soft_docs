import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import WorkspaceInvitationPage from "../../../src/features/server/WorkspaceInvitationPage";

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe("WorkspaceInvitationPage", () => {
  it("shows the scoped preview and waits for an explicit authenticated acceptance", async () => {
    window.history.replaceState(null, "", "/invite/sdi_public.secret");
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/me") return Response.json({ user: { id: "u1", displayName: "Ada", email: null, authType: "session", scopes: [], accountStatus: "ACTIVE" } });
      if (input === "/api/invitations/inspect") return Response.json({ workspaceName: "Research", role: "VIEWER", inviterName: "Lin", expiresAt: new Date(Date.now() + 10000).toISOString() });
      if (input === "/api/invitations/accept") {
        expect(JSON.parse(String(init?.body))).toEqual({ token: "sdi_public.secret" });
        return Response.json({ workspaceId: "w1", role: "VIEWER" });
      }
      throw new Error(`Unexpected request ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkspaceInvitationPage />);
    expect(await screen.findByText(/invited you to/)).toHaveTextContent("Research");
    expect(screen.getByText(/does not grant access to any project/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept invitation" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/invitations/accept", expect.anything());
  });
});
