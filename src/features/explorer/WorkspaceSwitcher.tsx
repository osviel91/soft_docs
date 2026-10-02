/** The two navigation headers used by the Workspace Explorer. */
import { useMemo, useState } from "react";
import type { ServerProject, ServerWorkspace } from "../../workspace/server/api-client";

export type WorkspaceMode = "local" | "folder" | "server";

export interface WorkspaceSwitcherProps {
  mode: WorkspaceMode;
  folderName?: string | null;
  folderSupported?: boolean;
  serverProjects?: ServerProject[];
  serverWorkspaces?: ServerWorkspace[];
  selectedServerWorkspaceId?: string | null;
  serverProjectsLoading?: boolean;
  serverProjectsError?: string | null;
  activeServerProjectId?: string | null;
  activeServerProjectName?: string | null;
  serverOpenError?: string | null;
  onOpenLocal: () => void;
  onOpenFolder: () => void;
  onOpenServerProject: (project: ServerProject) => void;
  onCreateServerProject: (name: string) => void;
  onSelectServerWorkspace?: (workspaceId: string) => void;
  onReloadServerProjects?: () => void;
}

export default function WorkspaceSwitcher({
  mode,
  folderName = null,
  folderSupported = false,
  serverProjects = [],
  serverWorkspaces = [],
  selectedServerWorkspaceId = null,
  serverProjectsLoading = false,
  serverProjectsError = null,
  activeServerProjectId = null,
  activeServerProjectName = null,
  serverOpenError = null,
  onOpenLocal,
  onOpenFolder,
  onOpenServerProject,
  onCreateServerProject,
  onSelectServerWorkspace,
  onReloadServerProjects,
}: WorkspaceSwitcherProps) {
  const [projectFilter, setProjectFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [pendingName, setPendingName] = useState("");
  const query = projectFilter.trim().toLowerCase();
  const visibleProjects = useMemo(
    () => query === "" ? serverProjects : serverProjects.filter((project) => project.name.toLowerCase().includes(query)),
    [query, serverProjects],
  );

  if (activeServerProjectId !== null && activeServerProjectId !== undefined) {
    const activeProject = serverProjects.find((project) => project.id === activeServerProjectId);
    const workspace = serverWorkspaces.find((item) => item.id === selectedServerWorkspaceId);
    return (
      <nav className="workspaces workspaces--project" data-testid="workspace-switcher" aria-label="Project explorer header">
        <div className="workspaces__active-project" data-testid="workspace-active-project">
          <strong title={activeServerProjectName ?? activeProject?.name}>{activeServerProjectName ?? activeProject?.name ?? "Project"}</strong>
          <span>{workspace?.name ?? "Workspace"}</span>
        </div>
        <button type="button" className="workspaces__back" data-testid="workspace-back-to-projects" aria-expanded={projectPickerOpen} onClick={() => setProjectPickerOpen((open) => !open)}>
          {projectPickerOpen ? "Hide projects" : "Switch project"}
        </button>
        {onReloadServerProjects ? (
          <button type="button" className="workspaces__reload" data-testid="workspace-server-refresh" onClick={onReloadServerProjects} title="Refresh project data" aria-label="Refresh project data">
            ↻
          </button>
        ) : null}
        {projectPickerOpen ? <>
          {serverWorkspaces.length > 0 && onSelectServerWorkspace ? <label className="workspaces__workspace-select"><span className="visually-hidden">Workspace</span><select data-testid="workspace-server-workspace-select" value={selectedServerWorkspaceId ?? ""} onChange={(event) => onSelectServerWorkspace(event.target.value)}>{serverWorkspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
          <label className="workspaces__filter"><span className="visually-hidden">Search projects</span><input className="explorer__input" data-testid="workspace-server-project-filter" type="search" placeholder="Search projects…" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} /></label>
          <ul className="workspaces__list">{visibleProjects.map((project) => <li key={project.id}><button type="button" className="workspaces__item" data-testid="workspace-server-project" aria-current={project.id === activeServerProjectId ? "true" : undefined} onClick={() => onOpenServerProject(project)}><span className="workspaces__item-icon" aria-hidden="true">☁</span><span>{project.name}</span></button></li>)}</ul>
        </> : null}
      </nav>
    );
  }

  const create = (): void => {
    const name = pendingName.trim();
    if (name === "") return;
    onCreateServerProject(name);
    setPendingName("");
    setCreateOpen(false);
  };

  return (
    <nav className="workspaces" data-testid="workspace-switcher" aria-label="Project browser">
      <header className="workspaces__browser-header">
        <span className="workspaces__eyebrow">Workspace</span>
        {onReloadServerProjects ? (
          <button type="button" className="workspaces__reload" data-testid="workspace-server-refresh" onClick={onReloadServerProjects} title="Refresh workspace projects" aria-label="Refresh workspace projects">↻</button>
        ) : null}
      </header>
      {serverWorkspaces.length > 0 && onSelectServerWorkspace ? (
        <label className="workspaces__workspace-select">
          <span className="visually-hidden">Workspace</span>
          <select data-testid="workspace-server-workspace-select" value={selectedServerWorkspaceId ?? ""} onChange={(event) => onSelectServerWorkspace(event.target.value)}>
            {serverWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
        </label>
      ) : null}
      <label className="workspaces__filter">
        <span className="visually-hidden">Search projects</span>
        <input className="explorer__input" data-testid="workspace-server-project-filter" type="search" placeholder="Search projects…" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} />
      </label>
      <div className="workspaces__projects-heading">
        <span>Projects</span>
        <button type="button" className="workspaces__add" data-testid="workspace-new-server-project-toggle" aria-label="Create server project" aria-expanded={createOpen} onClick={() => setCreateOpen((open) => !open)}>+</button>
      </div>
      {createOpen ? (
        <form className="workspaces__create" onSubmit={(event) => { event.preventDefault(); create(); }}>
          <label className="visually-hidden" htmlFor="server-project-name">New server project name</label>
          <input id="server-project-name" className="explorer__input" data-testid="workspace-new-server-project-input" value={pendingName} onChange={(event) => setPendingName(event.target.value)} placeholder="Project name" autoFocus />
          <button type="submit" className="workspaces__create-button" data-testid="workspace-new-server-project-button" disabled={pendingName.trim() === ""}>Create</button>
        </form>
      ) : null}
      {serverProjectsLoading ? <p className="workspaces__note" data-testid="workspace-server-projects-loading">Loading projects…</p> : null}
      {serverProjectsError !== null ? <p className="workspaces__error" data-testid="workspace-server-projects-error">{serverProjectsError}{onReloadServerProjects ? <button type="button" className="workspaces__retry" data-testid="workspace-server-projects-retry" onClick={onReloadServerProjects}>Retry</button> : null}</p> : null}
      {!serverProjectsLoading && serverProjectsError === null && serverProjects.length === 0 ? <p className="workspaces__note" data-testid="workspace-server-projects-empty">No projects in this workspace.</p> : null}
      {serverProjects.length > 0 ? (
        <div className="workspaces__projects-scroll" data-testid="workspace-server-projects-scroll">
          <ul className="workspaces__list">
            {visibleProjects.map((project) => <li key={project.id}><button type="button" className="workspaces__item" data-testid="workspace-server-project" onClick={() => onOpenServerProject(project)}><span className="workspaces__item-icon" aria-hidden="true">☁</span><span>{project.name}</span></button></li>)}
          </ul>
          {visibleProjects.length === 0 ? <p className="workspaces__note">No projects match this filter.</p> : null}
        </div>
      ) : null}
      {serverOpenError !== null ? <p className="workspaces__error" data-testid="workspace-server-error">{serverOpenError}</p> : null}
      <section className="workspaces__local-entry" aria-label="Local">
        <h2>Local</h2>
        <button type="button" className="workspaces__item" data-testid="workspace-open-folder" disabled={!folderSupported} onClick={onOpenFolder}>
          <span className="workspaces__item-icon" aria-hidden="true">⌸</span>
          <span>{folderName ? `Folder: ${folderName}` : "Open local folder…"}</span>
        </button>
        {mode === "local" ? <button type="button" className="workspaces__item" data-testid="workspace-local" onClick={onOpenLocal}><span className="workspaces__item-icon" aria-hidden="true">▤</span><span>Browser projects</span></button> : null}
      </section>
    </nav>
  );
}
