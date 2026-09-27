/** Choose the local or authenticated server workspace that feeds the editor. */
import { useMemo, useRef, useState, type PointerEvent, type KeyboardEvent } from "react";
import type {
  ServerProject,
  ServerWorkspace,
} from "../../workspace/server/api-client";

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
  serverOpenError?: string | null;
  onOpenLocal: () => void;
  onOpenFolder: () => void;
  onOpenServerProject: (project: ServerProject) => void;
  onCreateServerProject: (name: string) => void;
  onSelectServerWorkspace?: (workspaceId: string) => void;
  onReloadServerProjects?: () => void;
  onBackToProjects?: () => void;
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
  serverOpenError = null,
  onOpenLocal,
  onOpenFolder,
  onOpenServerProject,
  onCreateServerProject,
  onSelectServerWorkspace,
  onReloadServerProjects,
  onBackToProjects,
}: WorkspaceSwitcherProps) {
  const [pendingName, setPendingName] = useState("");
  const [localExpanded, setLocalExpanded] = useState(false);
  const [serverExpanded, setServerExpanded] = useState(true);
  const [projectFilter, setProjectFilter] = useState("");
  const [regionHeight, setRegionHeight] = useState<number | null>(null);
  const regionRef = useRef<HTMLElement>(null);
  const resizing = useRef(false);
  const name = pendingName.trim();
  const visibleProjects = useMemo(() => {
    const query = projectFilter.trim().toLowerCase();
    return query === ""
      ? serverProjects
      : serverProjects.filter((project) =>
          project.name.toLowerCase().includes(query),
        );
  }, [projectFilter, serverProjects]);

  const resizeRegion = (clientY: number): void => {
    const region = regionRef.current;
    if (!region) return;
    const parent = region.parentElement?.getBoundingClientRect();
    if (!parent) return;
    if (!Number.isFinite(clientY)) return;
    const maximum = Math.max(150, parent.height * 0.72);
    setRegionHeight(Math.min(maximum, Math.max(150, clientY - parent.top)));
  };

  const onSplitterKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const current = regionRef.current?.getBoundingClientRect().height ?? 240;
    setRegionHeight(Math.max(150, current + (event.key === "ArrowUp" ? -16 : 16)));
  };

  const onSplitterPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    resizing.current = true;
    resizeRegion(event.clientY);
  };

  const create = (): void => {
    if (name === "") return;
    onCreateServerProject(name);
    setPendingName("");
  };

  if (activeServerProjectId !== null && activeServerProjectId !== undefined) {
    const activeProject = serverProjects.find((project) => project.id === activeServerProjectId);
    const workspace = serverWorkspaces.find((item) => item.id === selectedServerWorkspaceId);
    return (
      <nav className="workspaces workspaces--project" data-testid="workspace-switcher" aria-label="Project navigation">
        <button type="button" className="workspaces__back" data-testid="workspace-back-to-projects" onClick={onBackToProjects}>
          ‹ Projects
        </button>
        <div className="workspaces__active-project" data-testid="workspace-active-project">
          <strong title={activeProject?.name}>{activeProject?.name ?? "Project"}</strong>
          <span>{workspace?.name ?? "Workspace"}</span>
        </div>
        {onReloadServerProjects && (
          <button
            type="button"
            className="workspaces__reload"
            data-testid="workspace-server-refresh"
            onClick={onReloadServerProjects}
            title="Refresh project data"
          >
            ↻ Refresh
          </button>
        )}
      </nav>
    );
  }

  return (
    <nav
      className="workspaces"
      data-testid="workspace-switcher"
      aria-label="Workspaces"
      ref={regionRef}
      style={regionHeight === null ? undefined : { flexBasis: regionHeight }}
    >
      <h2 className="workspaces__title">Workspaces</h2>

      <section className="workspaces__group" aria-label="Server workspaces">
        <h3 className="workspaces__group-title">
          <span className="workspaces__group-heading">
            <button
              type="button"
              className="workspaces__group-toggle"
              data-testid="workspace-server-toggle"
              aria-expanded={serverExpanded}
              onClick={() => setServerExpanded((expanded) => !expanded)}
            >
              Server{" "}
              <span aria-hidden="true">{serverExpanded ? "▾" : "▸"}</span>
            </button>
          </span>
          {onReloadServerProjects && (
            <button
              type="button"
              className="workspaces__reload"
              data-testid="workspace-server-refresh"
              onClick={onReloadServerProjects}
              title="Refresh server workspace data"
            >
              ↻ Refresh
            </button>
          )}
        </h3>

        {serverExpanded && (
          <>
            {serverWorkspaces.length > 0 && onSelectServerWorkspace && (
              <label className="workspaces__create">
                <span className="visually-hidden">
                  Selected server workspace
                </span>
                <select
                  className="explorer__input"
                  data-testid="workspace-server-workspace-select"
                  value={selectedServerWorkspaceId ?? ""}
                  onChange={(event) =>
                    onSelectServerWorkspace(event.target.value)
                  }
                >
                  {serverWorkspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <form
              className="workspaces__create"
              onSubmit={(event) => {
                event.preventDefault();
                create();
              }}
            >
              <label className="visually-hidden" htmlFor="server-project-name">
                New server project name
              </label>
              <input
                id="server-project-name"
                className="explorer__input"
                data-testid="workspace-new-server-project-input"
                value={pendingName}
                onChange={(event) => setPendingName(event.target.value)}
                placeholder="New server project"
              />
              <button
                type="submit"
                className="workspaces__create-button"
                data-testid="workspace-new-server-project-button"
                disabled={name === ""}
              >
                Create
              </button>
            </form>

            <label className="workspaces__filter">
              <span className="visually-hidden">Filter server projects</span>
              <input
                className="explorer__input"
                data-testid="workspace-server-project-filter"
                type="search"
                placeholder="Filter server projects…"
                value={projectFilter}
                onChange={(event) => setProjectFilter(event.target.value)}
              />
            </label>

            {serverProjectsLoading && (
              <p
                className="workspaces__note"
                data-testid="workspace-server-projects-loading"
              >
                Loading projects…
              </p>
            )}
            {serverProjectsError !== null && (
              <p
                className="workspaces__error"
                data-testid="workspace-server-projects-error"
              >
                {serverProjectsError}
                {onReloadServerProjects && (
                  <button
                    type="button"
                    className="workspaces__retry"
                    data-testid="workspace-server-projects-retry"
                    onClick={onReloadServerProjects}
                  >
                    Retry
                  </button>
                )}
              </p>
            )}
            {!serverProjectsLoading &&
              serverProjectsError === null &&
              serverProjects.length === 0 && (
                <p
                  className="workspaces__note"
                  data-testid="workspace-server-projects-empty"
                >
                  No server projects yet.
                </p>
              )}
            {serverProjects.length > 0 && (
              <div className="workspaces__projects-scroll" data-testid="workspace-server-projects-scroll">
                <ul className="workspaces__list">
                {visibleProjects.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      className={`workspaces__item${project.id === activeServerProjectId ? " workspaces__item--active" : ""}`}
                      data-testid="workspace-server-project"
                      aria-current={
                        project.id === activeServerProjectId
                          ? "true"
                          : undefined
                      }
                      onClick={() => onOpenServerProject(project)}
                    >
                      <span
                        className="workspaces__item-icon"
                        aria-hidden="true"
                      >
                        ☁
                      </span>
                      {project.name}
                    </button>
                  </li>
                ))}
                </ul>
                {visibleProjects.length === 0 && (
                  <p className="workspaces__note">No server projects match.</p>
                )}
              </div>
            )}
            {serverOpenError !== null && (
              <p
                className="workspaces__error"
                data-testid="workspace-server-error"
              >
                {serverOpenError}
              </p>
            )}
          </>
        )}
        {serverExpanded && (
          <div
            className="workspaces__splitter"
            role="separator"
            tabIndex={0}
            aria-label="Resize workspace project browser"
            aria-orientation="horizontal"
            aria-valuemin={150}
            aria-valuenow={Math.round(regionRef.current?.getBoundingClientRect().height ?? 240)}
            onKeyDown={onSplitterKeyDown}
            onPointerDown={onSplitterPointerDown}
            onPointerMove={(event) => {
              if (resizing.current) resizeRegion(event.clientY);
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              resizing.current = false;
            }}
            onPointerCancel={() => { resizing.current = false; }}
          />
        )}
      </section>

      <section className="workspaces__group" aria-label="Local workspaces">
        <h3 className="workspaces__group-title">
          <button
            type="button"
            className="workspaces__group-toggle"
            data-testid="workspace-local-toggle"
            aria-expanded={localExpanded}
            onClick={() => setLocalExpanded((expanded) => !expanded)}
          >
            Local <span aria-hidden="true">{localExpanded ? "▾" : "▸"}</span>
          </button>
        </h3>
        {localExpanded && (
          <ul className="workspaces__list">
            <li>
              <button
                type="button"
                className={`workspaces__item${mode === "local" ? " workspaces__item--active" : ""}`}
                data-testid="workspace-local"
                aria-current={mode === "local" ? "true" : undefined}
                onClick={onOpenLocal}
              >
                <span className="workspaces__item-icon" aria-hidden="true">
                  ▤
                </span>
                Browser projects
              </button>
            </li>
            <li>
              <button
                type="button"
                className={`workspaces__item${mode === "folder" ? " workspaces__item--active" : ""}`}
                data-testid="workspace-open-folder"
                aria-current={mode === "folder" ? "true" : undefined}
                disabled={!folderSupported}
                onClick={onOpenFolder}
              >
                <span className="workspaces__item-icon" aria-hidden="true">
                  ⌸
                </span>
                {folderName ? `Folder: ${folderName}` : "Open local folder…"}
              </button>
            </li>
          </ul>
        )}
      </section>
    </nav>
  );
}
