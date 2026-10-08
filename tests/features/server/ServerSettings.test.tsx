import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import ServerSettings from "../../../src/features/server/ServerSettings";

function renderSettings(platformAdmin: boolean, agentsPanel = <div data-testid="agents-panel">Agent access settings</div>) {
  const actions = {
    onSetUserStatus: vi.fn(),
    onCreatePasswordRecovery: vi.fn().mockResolvedValue("recovery-token"),
    onSelectWorkspace: vi.fn(),
    onSetWorkspaceMemberRole: vi.fn(),
    onSetWorkspaceAuthorSelfReview: vi.fn(),
    onCreateWorkspaceInvitation: vi.fn().mockResolvedValue("invite-token"),
    onRevokeWorkspaceInvitation: vi.fn(),
  };
  const view = render(
    <ServerSettings
      auth={{
        status: "authenticated",
        user: {
          id: "admin",
          displayName: "Ada",
          email: "ada@example.test",
          authType: "session",
          scopes: [],
          accountStatus: "ACTIVE",
          platformAdmin,
        },
      }}
      agentsPanel={agentsPanel}
      adminUsers={[{
        id: "pending",
        displayName: "Grace",
        email: "grace@example.test",
        status: "PENDING",
        platformAdmin: false,
      }]}
      onSetUserStatus={actions.onSetUserStatus}
      onCreatePasswordRecovery={actions.onCreatePasswordRecovery}
      workspaces={[
        {
          id: "workspace-1",
          ownerId: "admin",
          name: "Ada Workspace",
          isDefault: true,
          allowAuthorSelfReview: false,
          role: platformAdmin ? "ADMIN" : "VIEWER",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        {
          id: "workspace-2",
          ownerId: "other",
          name: "Research",
          isDefault: false,
          allowAuthorSelfReview: true,
          role: "VIEWER",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      ]}
      selectedWorkspaceId="workspace-1"
      onSelectWorkspace={actions.onSelectWorkspace}
      workspaceMembersByWorkspaceId={{
        "workspace-1": [{
          workspaceId: "workspace-1",
          userId: "pending",
          displayName: "Grace",
          email: "grace@example.test",
          role: "EDITOR",
          createdAt: new Date(0).toISOString(),
        }],
      }}
      onSetWorkspaceMemberRole={actions.onSetWorkspaceMemberRole}
      workspaceInvitationsByWorkspaceId={{
        "workspace-1": [{
          id: "invitation-1",
          workspaceId: "workspace-1",
          workspaceName: "Ada Workspace",
          inviterName: "Ada",
          role: "EDITOR",
          state: "ACTIVE",
          createdAt: new Date(0).toISOString(),
          expiresAt: new Date(86400000).toISOString(),
        }],
      }}
      onCreateWorkspaceInvitation={actions.onCreateWorkspaceInvitation}
      onRevokeWorkspaceInvitation={actions.onRevokeWorkspaceInvitation}
      onRemoveWorkspaceMember={vi.fn()}
      onCreateWorkspace={vi.fn()}
      onRenameWorkspace={vi.fn()}
      onDeleteWorkspace={vi.fn()}
      onSetWorkspaceAuthorSelfReview={actions.onSetWorkspaceAuthorSelfReview}
      onBack={vi.fn()}
    />,
  );
  return { ...actions, ...view };
}

describe("ServerSettings", () => {
  it("separates workspace topics from platform-wide account controls", async () => {
    const { onSetUserStatus, onSelectWorkspace, onSetWorkspaceMemberRole, onSetWorkspaceAuthorSelfReview, onCreateWorkspaceInvitation, onRevokeWorkspaceInvitation } = renderSettings(true);

    expect(screen.getByTestId("workspace-settings-page")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ada Workspace" })).toBeInTheDocument();
    expect(screen.queryByText("Account approval")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Research/ }));
    expect(onSelectWorkspace).toHaveBeenCalledWith("workspace-2");

    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    fireEvent.change(screen.getByLabelText("Workspace role for grace@example.test"), { target: { value: "VIEWER" } });
    expect(onSetWorkspaceMemberRole).toHaveBeenCalledWith("workspace-1", "pending", "VIEWER");
    expect(screen.queryByText("Invitation history")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Invitations" }));
    expect(screen.getByText("Invitation history")).toBeInTheDocument();
    expect(screen.queryByLabelText("Workspace role for grace@example.test")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create invitation link" }));
    expect(onCreateWorkspaceInvitation).toHaveBeenCalledWith("workspace-1", "VIEWER");
    expect(await screen.findByLabelText("One-time invitation link")).toHaveValue("invite-token");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(onRevokeWorkspaceInvitation).toHaveBeenCalledWith("workspace-1", "invitation-1");

    fireEvent.click(screen.getByRole("button", { name: "Governance" }));
    fireEvent.click(screen.getByLabelText("Allow authors to approve proposals in Ada Workspace"));
    expect(onSetWorkspaceAuthorSelfReview).toHaveBeenCalledWith("workspace-1", true);

    fireEvent.click(screen.getByTestId("settings-scope-platform"));
    fireEvent.change(screen.getByLabelText("Status for grace@example.test"), { target: { value: "ACTIVE" } });
    expect(onSetUserStatus).toHaveBeenCalledWith("pending", "ACTIVE");
    expect(screen.getByText("Account approval")).toBeInTheDocument();
  });

  it("hides platform settings from non-platform admins and reports governance read-only", () => {
    renderSettings(false);
    expect(screen.queryByTestId("settings-scope-platform")).toBeNull();
    expect(screen.queryByText("Account approval")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Governance" }));
    const governance = screen.getByRole("region", { name: "Governance" });
    expect(within(governance).getByText("Managed by a platform administrator.")).toBeInTheDocument();
    expect(within(governance).getByText("Disabled")).toBeInTheDocument();
    expect(within(governance).queryByRole("checkbox")).toBeNull();
  });

  it("opens agent access inside its own settings tab", () => {
    renderSettings(false);
    expect(screen.queryByTestId("agents-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-tab-agents"));
    expect(screen.getByTestId("agents-panel")).toBeInTheDocument();
    expect(screen.getByTestId("settings-tab-agents")).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByTestId("settings-tab-workspaces"));
    expect(screen.queryByTestId("agents-panel")).toBeNull();
  });
});
