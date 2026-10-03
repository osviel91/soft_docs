import { useState } from "react";
import type { AuthState } from "./use-auth";
import type {
  ServerAdminUser,
  ServerWorkspace,
  ServerWorkspaceMember,
  ServerWorkspaceInvitation,
} from "../../workspace/server/api-client";

type SettingsArea = "workspaces" | "platform";
type WorkspaceTopic = "overview" | "members" | "governance";

export interface ServerSettingsProps {
  auth: AuthState;
  adminUsers: ServerAdminUser[];
  onSetUserStatus: (userId: string, status: ServerAdminUser["status"]) => void;
  workspaces: ServerWorkspace[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
  workspaceMembersByWorkspaceId: Record<string, ServerWorkspaceMember[]>;
  onSetWorkspaceMemberRole: (
    workspaceId: string,
    userId: string,
    role: ServerWorkspaceMember["role"],
  ) => void;
  onRemoveWorkspaceMember: (workspaceId: string, userId: string) => void;
  workspaceInvitationsByWorkspaceId?: Record<string, ServerWorkspaceInvitation[]>;
  onCreateWorkspaceInvitation?: (workspaceId: string, role: ServerWorkspaceMember["role"]) => Promise<string>;
  onRevokeWorkspaceInvitation?: (workspaceId: string, invitationId: string) => void;
  onCreateWorkspace: (name: string) => void;
  onRenameWorkspace: (workspaceId: string, name: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onSetWorkspaceAuthorSelfReview: (workspaceId: string, allowed: boolean) => void;
  onBack: () => void;
}

export default function ServerSettings({
  auth,
  adminUsers,
  onSetUserStatus,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  workspaceMembersByWorkspaceId,
  onSetWorkspaceMemberRole,
  onRemoveWorkspaceMember,
  workspaceInvitationsByWorkspaceId,
  onCreateWorkspaceInvitation,
  onRevokeWorkspaceInvitation,
  onCreateWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
  onSetWorkspaceAuthorSelfReview,
  onBack,
}: ServerSettingsProps) {
  const user = auth.user;
  const isPlatformAdmin = user?.platformAdmin === true;
  const [area, setArea] = useState<SettingsArea>("workspaces");
  const activeArea = area === "platform" && isPlatformAdmin ? "platform" : "workspaces";
  const [topic, setTopic] = useState<WorkspaceTopic>("overview");
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState("");
  const [inviteRole, setInviteRole] = useState<ServerWorkspaceMember["role"]>("VIEWER");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const workspace = workspaces.find((item) => item.id === selectedWorkspaceId) ?? workspaces[0] ?? null;
  const invitations = workspace ? workspaceInvitationsByWorkspaceId?.[workspace.id] ?? [] : [];
  const members = workspace ? workspaceMembersByWorkspaceId[workspace.id] ?? [] : [];
  const filteredWorkspaces = workspaces.filter((item) => item.name.toLowerCase().includes(workspaceFilter.trim().toLowerCase()));

  const chooseWorkspace = (workspaceId: string) => {
    onSelectWorkspace(workspaceId);
    setTopic("overview");
  };

  return (
    <main className="settings-page" data-testid="workspace-settings-page">
      <header className="settings-page__header">
        <div>
          <p className="settings-page__eyebrow">Server settings</p>
          <h1 className="settings-page__title">Settings</h1>
          <p className="settings-page__lead">
            Choose a workspace to manage its members and policies, or open platform-wide controls.
          </p>
        </div>
        <button
          type="button"
          className="button"
          data-testid="workspace-settings-back"
          onClick={onBack}
        >
          ← Back to workspace
        </button>
      </header>

      {isPlatformAdmin && <nav className="settings-scope" aria-label="Settings scope">
        <button
          type="button"
          aria-current={activeArea === "workspaces" ? "page" : undefined}
          data-testid="settings-scope-workspaces"
          onClick={() => setArea("workspaces")}
        >
          Workspaces
        </button>
        <button
          type="button"
          aria-current={activeArea === "platform" ? "page" : undefined}
          data-testid="settings-scope-platform"
          onClick={() => setArea("platform")}
        >
          Platform
        </button>
      </nav>}

      {activeArea === "platform" ? (
        <section className="settings-card settings-platform" aria-labelledby="settings-platform-title">
          <div className="settings-card__heading">
            <div>
              <p className="settings-card__eyebrow">Platform administration</p>
              <h2 id="settings-platform-title">Account approval</h2>
            </div>
            <span className="settings-card__count">{adminUsers.length} accounts</span>
          </div>
          <p className="settings-card__muted">
            Server-wide access control. Approve accounts before they can use server workspaces, or suspend access.
          </p>
          <div className="settings-users" role="list">
            {adminUsers.map((adminUser) => (
              <div className="settings-user" role="listitem" key={adminUser.id}>
                <div>
                  <strong>{adminUser.displayName}</strong>
                  <span>{adminUser.email ?? "No email address"}</span>
                </div>
                <select
                  aria-label={`Status for ${adminUser.email ?? adminUser.displayName}`}
                  value={adminUser.status}
                  onChange={(event) => onSetUserStatus(adminUser.id, event.target.value as ServerAdminUser["status"])}
                >
                  <option value="PENDING">Pending</option>
                  <option value="ACTIVE">Active</option>
                  <option value="SUSPENDED">Suspended</option>
                </select>
              </div>
            ))}
            {adminUsers.length === 0 && <p className="settings-card__empty">No accounts to manage.</p>}
          </div>
        </section>
      ) : (
        <section className="settings-workspace-layout" aria-label="Workspace settings">
          <aside className="settings-workspace-rail">
            <div className="settings-workspace-rail__heading">
              <div>
                <p className="settings-card__eyebrow">Workspace scope</p>
                <h2>Workspaces</h2>
              </div>
              <span className="settings-card__count">{workspaces.length}</span>
            </div>
            {auth.status === "authenticated" && (
              <form
                className="settings-create-workspace"
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = newWorkspaceName.trim();
                  if (!name) return;
                  onCreateWorkspace(name);
                  setNewWorkspaceName("");
                }}
              >
                <label className="visually-hidden" htmlFor="new-server-workspace-name">New workspace name</label>
                <input
                  id="new-server-workspace-name"
                  className="explorer__input"
                  data-testid="workspace-new-server-workspace-input"
                  value={newWorkspaceName}
                  onChange={(event) => setNewWorkspaceName(event.target.value)}
                  placeholder="Create a workspace"
                />
                <button type="submit" className="button button--small" disabled={!newWorkspaceName.trim()}>
                  Create
                </button>
              </form>
            )}
            {workspaces.length > 0 ? (
              <>
                <label className="visually-hidden" htmlFor="settings-workspace-filter">Filter workspaces</label>
                <input
                  id="settings-workspace-filter"
                  className="explorer__input settings-workspace-filter"
                  type="search"
                  value={workspaceFilter}
                  onChange={(event) => setWorkspaceFilter(event.target.value)}
                  placeholder="Find a workspace"
                />
                <label className="visually-hidden" htmlFor="settings-workspace-select">Select workspace</label>
                <select
                  id="settings-workspace-select"
                  className="settings-workspace-select"
                  value={workspace?.id ?? ""}
                  onChange={(event) => chooseWorkspace(event.target.value)}
                >
                  {workspaces.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
                </select>
                <nav className="settings-workspace-list" aria-label="Choose workspace">
                  {filteredWorkspaces.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      aria-current={workspace?.id === item.id ? "page" : undefined}
                      onClick={() => chooseWorkspace(item.id)}
                    >
                      <span>{item.name}</span>
                      <small>{item.role}</small>
                    </button>
                  ))}
                  {filteredWorkspaces.length === 0 && <p className="settings-card__empty">No matching workspaces.</p>}
                </nav>
              </>
            ) : (
              <p className="settings-card__empty">
                {auth.status === "authenticated"
                  ? "You do not have access to any workspaces yet."
                  : "Sign in to manage server workspaces."}
              </p>
            )}
          </aside>

          {workspace ? (
            <div className="settings-workspace-content">
              <header className="settings-workspace-heading">
                <div>
                  <p className="settings-page__eyebrow">{workspace.isDefault ? "Personal workspace" : "Workspace"}</p>
                  <h2>{workspace.name}</h2>
                </div>
                <span className="settings-card__badge">{workspace.role}</span>
              </header>
              <nav className="settings-topic-nav" aria-label={`${workspace.name} settings topics`}>
                <button type="button" aria-current={topic === "overview" ? "page" : undefined} onClick={() => setTopic("overview")}>General</button>
                <button type="button" aria-current={topic === "members" ? "page" : undefined} onClick={() => setTopic("members")}>Members &amp; roles</button>
                <button type="button" aria-current={topic === "governance" ? "page" : undefined} onClick={() => setTopic("governance")}>Governance</button>
              </nav>

              {topic === "overview" ? (
                <section className="settings-card" aria-labelledby="settings-general-title">
                  <div className="settings-card__heading">
                    <div>
                      <p className="settings-card__eyebrow">General</p>
                      <h3 id="settings-general-title">Workspace details</h3>
                    </div>
                  </div>
                  <p className="settings-card__muted">Name and lifecycle for this workspace.</p>
                  {workspace.role === "ADMIN" ? (
                    <form
                      className="settings-inline-form"
                      key={workspace.id}
                      onSubmit={(event) => {
                        event.preventDefault();
                        const name = new FormData(event.currentTarget).get("name");
                        if (typeof name === "string" && name.trim()) onRenameWorkspace(workspace.id, name.trim());
                      }}
                    >
                      <label className="visually-hidden" htmlFor={`workspace-name-${workspace.id}`}>Workspace name</label>
                      <input id={`workspace-name-${workspace.id}`} name="name" className="explorer__input" defaultValue={workspace.name} />
                      <button type="submit" className="button button--small">Save name</button>
                      {workspace.ownerId === user?.id && !workspace.isDefault && (
                        <button
                          type="button"
                          className="button button--small button--danger-text"
                          onClick={() => {
                            if (window.confirm(`Delete ${workspace.name}?`)) onDeleteWorkspace(workspace.id);
                          }}
                        >
                          Delete workspace
                        </button>
                      )}
                    </form>
                  ) : (
                    <p className="settings-readonly-value">{workspace.name}</p>
                  )}
                </section>
              ) : null}

              {topic === "members" ? (
                <section className="settings-card" aria-labelledby="settings-members-title">
                  <div className="settings-card__heading">
                    <div>
                      <p className="settings-card__eyebrow">Access</p>
                      <h3 id="settings-members-title">Members &amp; roles</h3>
                    </div>
                    <span className="settings-card__count">{members.length} members</span>
                  </div>
                  <p className="settings-card__muted">Workspace members and their access level.</p>
                  {workspace.role === "ADMIN" && <>
                    <form className="settings-inline-form" onSubmit={event => {
                      event.preventDefault(); setInviteError(null); setInviteLink(null); setInviteCopied(false);
                      if (onCreateWorkspaceInvitation) void onCreateWorkspaceInvitation(workspace.id, inviteRole).then(setInviteLink).catch(reason => setInviteError(reason instanceof Error ? reason.message : "Invitation could not be created."));
                    }}>
                      <label htmlFor="workspace-invite-role">Invite collaborator as</label>
                      <select id="workspace-invite-role" value={inviteRole} onChange={event => setInviteRole(event.target.value as ServerWorkspaceMember["role"])}>
                        <option value="ADMIN">Admin</option><option value="EDITOR">Editor</option><option value="VIEWER">Viewer</option>
                      </select>
                      <button className="button button--small" type="submit">Create invitation link</button>
                    </form>
                    {inviteLink && <div className="settings-invitation-link" aria-label="Invitation link">
                      <p>Copy this link now. It can be used once and expires in 7 days.</p>
                      <input aria-label="One-time invitation link" readOnly value={inviteLink} onFocus={event => event.currentTarget.select()} />
                      <button type="button" className="button button--small" onClick={async () => {
                        const input = document.querySelector<HTMLInputElement>('.settings-invitation-link input');
                        input?.select();
                        try {
                          if (!navigator.clipboard) throw new Error("Clipboard unavailable");
                          await navigator.clipboard.writeText(inviteLink);
                          setInviteCopied(true);
                        } catch { setInviteCopied(false); }
                      }}>Copy link</button>
                      <span role="status" aria-live="polite">{inviteCopied ? "Invitation link copied." : ""}</span>
                    </div>}
                    {inviteError && <p role="alert" className="login-card__error">{inviteError}</p>}
                    <h4>Invitation history</h4>
                    <div className="settings-users" role="list">
                      {invitations.map(invitation => <div className="settings-user" role="listitem" key={invitation.id}>
                        <div><strong>{invitation.role} · {invitation.state.toLowerCase()}</strong><span>Created {new Date(invitation.createdAt).toLocaleString()} · expires {new Date(invitation.expiresAt).toLocaleString()}</span></div>
                        {invitation.state === "ACTIVE" && <button type="button" className="button button--small button--danger-text" onClick={() => { if (window.confirm("Revoke this invitation link? Anyone holding it will lose access.")) onRevokeWorkspaceInvitation?.(workspace.id, invitation.id); }}>Revoke</button>}
                      </div>)}
                      {invitations.length === 0 && <p className="settings-card__empty">No invitations yet.</p>}
                    </div>
                  </>}
                  {members.length > 0 ? (
                    <div className="settings-users" role="list">
                      {members.map((member) => (
                        <div className="settings-user" role="listitem" key={member.userId}>
                          <div>
                            <strong>{member.displayName}</strong>
                            <span>{member.email ?? "No email address"}</span>
                          </div>
                          {workspace.role === "ADMIN" ? (
                            <div className="settings-user__actions">
                              <select
                                aria-label={`Workspace role for ${member.email ?? member.displayName}`}
                                value={member.role}
                                onChange={(event) => onSetWorkspaceMemberRole(workspace.id, member.userId, event.target.value as ServerWorkspaceMember["role"])}
                              >
                                <option value="ADMIN">Admin</option>
                                <option value="EDITOR">Editor</option>
                                <option value="VIEWER">Viewer</option>
                              </select>
                              {member.userId !== user?.id && (
                                <button type="button" className="button button--small button--danger-text" onClick={() => onRemoveWorkspaceMember(workspace.id, member.userId)}>Remove</button>
                              )}
                            </div>
                          ) : <span className="settings-user__role">{member.role}</span>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="settings-card__empty">Member details are available to workspace members.</p>
                  )}
                </section>
              ) : null}

              {topic === "governance" ? (
                <section className="settings-card" aria-labelledby="settings-governance-title">
                  <div className="settings-card__heading">
                    <div>
                      <p className="settings-card__eyebrow">Proposal policy</p>
                      <h3 id="settings-governance-title">Governance</h3>
                    </div>
                  </div>
                  <div className="settings-policy-row">
                    <div>
                      <strong>Author self-approval</strong>
                      <p className="settings-card__muted">Allow proposal authors to approve their own proposals. Approval does not promote a proposal or change SHARED.</p>
                      {!isPlatformAdmin && <small>Managed by a platform administrator.</small>}
                    </div>
                    {isPlatformAdmin ? (
                      <input
                        type="checkbox"
                        aria-label={`Allow authors to approve proposals in ${workspace.name}`}
                        checked={workspace.allowAuthorSelfReview}
                        onChange={(event) => onSetWorkspaceAuthorSelfReview(workspace.id, event.target.checked)}
                      />
                    ) : <span className="settings-card__badge">{workspace.allowAuthorSelfReview ? "Enabled" : "Disabled"}</span>}
                  </div>
                </section>
              ) : null}
            </div>
          ) : null}
        </section>
      )}
    </main>
  );
}
