/**
 * Project explorer for diagrams, event flows, and notes.
 *
 * Renders the workspace tree: projects, each with its diagrams and markdown
 * notes. Creating, renaming, deleting, and selecting all flow through callbacks
 * so the component stays a pure function of its props; {@link useWorkspace}
 * supplies them. Selection is driven by the parent (it owns the editor buffer),
 * so clicking a row just reports the file.
 *
 * Every project header offers a `＋` that opens the add menu (diagram, note,
 * event flow) and a `⋯` that opens the project's own actions menu (rename,
 * delete).
 * Right-clicking the header opens the same actions menu. Project and file
 * deletion therefore live in menus, never on a bare row button.
 *
 * Every diagram and note row offers two affordances: the row itself opens the
 * document and a `⋯` opens its actions menu (rename, change title, duplicate,
 * delete). Right-clicking the row opens the same menu, and the menu position is
 * reported so the shell can place it.
 */
import {
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type {
  DiagramFile,
  NoteFile,
  Project,
} from "../../domain/workspace/types";
import { diagramDisplayName } from "../../language/diagram-title";
import { noteDisplayName } from "../../language/markdown/note-title";
import { proposalLifecycle } from "../proposals/proposal-lifecycle";

/** Viewport coordinates for a context menu. */
export interface MenuPosition {
  x: number;
  y: number;
}

export interface ExplorerProps {
  /** Every project, in storage order. */
  projects: Project[];
  /** Diagram files of the selected project, in display order. */
  diagrams: DiagramFile[];
  /** SHARED diagrams, kept separate while MY WORK is active. */
  sharedDiagrams?: DiagramFile[];
  /** Markdown notes of the selected project, in display order. */
  notes?: NoteFile[];
  sharedNotes?: NoteFile[];
  /**
   * Every file in the workspace, across all projects. Used only to filter by
   * name when the search box is non-empty, so the search can match files outside
   * the currently selected project.
   */
  allDiagrams?: DiagramFile[];
  allNotes?: NoteFile[];
  /** The selected project id, or `null` when none is selected. */
  selectedProjectId: string | null;
  /** The loaded diagram id, or `null` when none is loaded. */
  selectedDiagramId: string | null;
  /** The loaded note id, or `null` when none is loaded. */
  selectedNoteId?: string | null;
  /** Open proposal counts keyed by server resource id. */
  openProposalCounts?: Record<string, number>;
  /** True while the initial load or any action is in flight. */
  isLoading: boolean;
  /** Called with a proposed project name when the user creates one. */
  onCreateProject: (name: string) => void;
  /**
   * Called when the user asks to add a file to a project. The shell opens a menu
   * offering a new diagram or a new markdown note, anchored at the position.
   */
  onAddMenu?: (project: Project, position: MenuPosition) => void;
  /** Called when the user selects a diagram to load it into the editor. */
  onLoadDiagram: (diagram: DiagramFile) => void;
  /** Called when the user selects a note to load it into the editor. */
  onLoadNote?: (note: NoteFile) => void;
  /** Open the actions menu for a diagram at the reported position. */
  onDiagramMenu?: (diagram: DiagramFile, position: MenuPosition) => void;
  /** Open the actions menu for a note at the reported position. */
  onNoteMenu?: (note: NoteFile, position: MenuPosition) => void;
  /**
   * Open the actions menu for a project (rename, delete) at the reported
   * position. Right-clicking the header requests the same menu.
   */
  onProjectMenu?: (project: Project, position: MenuPosition) => void;
  /**
   * How many paths the user has removed from the app but left on disk. When
   * greater than zero the header offers to restore them, so a "remove from app"
   * is never a dead end.
   */
  hiddenCount?: number;
  /** Reveal every path that was removed from the app. */
  onUnhideAll?: () => void;
  /**
   * Called when the user clicks "Open folder…". Opens a local folder via the
   * File System Access API. Absent when the feature is hidden.
   */
  onOpenFolder?: () => void;
  /** The opened folder's name, or `null` for in-browser projects. */
  folderName?: string | null;
  /** Human-readable description of the workspace backing the current tree. */
  workspaceLabel?: string;
  /** Whether the browser supports the File System Access API. */
  folderSupported?: boolean;
  /**
   * The workspace switcher, supplied by the shell.
   *
   * Passed in rather than built here so the explorer stays a pure function of the
   * workspace it renders: which *sources* exist (local, folder, server) is a
   * session concern the shell owns, and the tree below is only ever about the one
   * source that is active.
   */
  switcher?: ReactNode;
  /** Private server-side work contexts owned by the current user. */
  privateWorkContexts?: Array<{ id: string; name: string; lifecycle: "active" | "archived" }>;
  architecturalProposals?: Array<{ id: string; title: string; authorUserId: string; status: "open" | "withdrawn" | "superseded"; staleBase?: boolean; baseSharedRevision: string; currentSharedRevision?: string; reviewStatus?: "none" | "approved" | "changes-requested" | "mixed"; lifecycle?: { state: "OPEN" | "CHANGES_REQUESTED" | "APPROVED" | "PROMOTING" | "PROMOTED" | "WITHDRAWN" | "SUPERSEDED" }; approvals?: number; changesRequested?: number; submittedAt?: string }>;
  onOpenArchitecturalProposal?: (proposalId: string) => void;
  selectedProposalId?: string | null;
  revisingProposalId?: string | null;
  onSubmitArchitecturalProposal?: (contextId: string) => void;
  /** Create a resource in a private MY WORK context. */
  onCreateMyWork?: () => void;
  /** @deprecated Proposal creation is intentionally routed through MY WORK. */
  onCreateProposal?: () => void;
  onOpenMyWork?: (contextId: string) => void;
  projectBrowser?: boolean;
  serverMode?: boolean;
  /** Active server context; null/undefined means SHARED. */
  activeContextId?: string | null;
}

/** Navigation nodes are organizational only; containment is not architecture. */
export interface ExplorerNode {
  id: string;
  label: string;
  kind: "group" | "project" | "resource";
  children?: ExplorerNode[];
}

function ServerResourceTree({
  diagrams,
  notes,
  selectedDiagramId,
  selectedNoteId,
  openProposalCounts,
  onLoadDiagram,
  onLoadNote,
  onDiagramMenu,
  onNoteMenu,
}: Pick<ExplorerProps, "diagrams" | "notes" | "selectedDiagramId" | "selectedNoteId" | "openProposalCounts" | "onLoadDiagram" | "onLoadNote" | "onDiagramMenu" | "onNoteMenu">) {
  const safeNotes = notes ?? [];
  return (
    <ul className="explorer__resource-list" data-testid="explorer-resources">
      {diagrams.map((diagram) => (
        <li key={diagram.id} className={diagram.id === selectedDiagramId ? "explorer__resource explorer__resource--selected" : "explorer__resource"} data-testid="explorer-diagram" onContextMenu={(event) => { if (!onDiagramMenu) return; event.preventDefault(); onDiagramMenu(diagram, { x: event.clientX, y: event.clientY }); }}>
          <button type="button" className="explorer__resource-button" data-testid="select-diagram-button" aria-label={`Load diagram ${diagramDisplayName(diagram.name, diagram.source)}`} onClick={() => onLoadDiagram(diagram)}>
            <span className="explorer__diagram-kind" aria-hidden="true">{diagram.name.toLowerCase().endsWith(".eventseq") ? "□" : "○"}</span>
            <span className="explorer__item-name">{diagramDisplayName(diagram.name, diagram.source)}</span>
            {(openProposalCounts?.[diagram.id] ?? 0) > 0 ? <span className="explorer__status-slot" title={`${openProposalCounts?.[diagram.id]} open changes`}>◆</span> : null}
          </button>
          {onDiagramMenu ? <button type="button" className="explorer__diagram-menu" data-testid="diagram-menu-button" aria-label={`Actions for diagram ${diagramDisplayName(diagram.name, diagram.source)}`} onClick={(event) => onDiagramMenu(diagram, positionBelow(event.currentTarget))}>⋯</button> : null}
        </li>
      ))}
      {safeNotes.map((note) => (
        <li key={note.id} className={note.id === selectedNoteId ? "explorer__resource explorer__resource--selected" : "explorer__resource"} data-testid="explorer-note" onContextMenu={(event) => { if (!onNoteMenu) return; event.preventDefault(); onNoteMenu(note, { x: event.clientX, y: event.clientY }); }}>
          <button type="button" className="explorer__resource-button" data-testid="select-note-button" aria-label={`Open note ${noteDisplayName(note.name, note.markdown)}`} onClick={() => onLoadNote?.(note)}>
            <span className="explorer__item-icon" aria-hidden="true">¶</span>
            <span className="explorer__item-name">{noteDisplayName(note.name, note.markdown)}</span>
          </button>
          {onNoteMenu ? <button type="button" className="explorer__note-menu" data-testid="note-menu-button" aria-label={`Actions for note ${noteDisplayName(note.name, note.markdown)}`} onClick={(event) => onNoteMenu(note, positionBelow(event.currentTarget))}>⋯</button> : null}
        </li>
      ))}
      {diagrams.length === 0 && safeNotes.length === 0 ? <li className="explorer__diagram-empty" data-testid="explorer-shared-empty">No shared project knowledge yet.</li> : null}
    </ul>
  );
}

/** Small recursive seam for future grouped project knowledge. */
export function ExplorerNodeList({
  nodes,
  render,
}: {
  nodes: ExplorerNode[];
  render: (node: ExplorerNode) => ReactNode;
}): ReactNode {
  return nodes.map((node) => (
    <li key={node.id} data-node-kind={node.kind}>
      {render(node)}
      {node.children?.length ? (
        <ul className="explorer__node-children">
          <ExplorerNodeList nodes={node.children} render={render} />
        </ul>
      ) : null}
    </li>
  ));
}

const EMPTY_HINT =
  "No projects yet. Create one to start saving diagrams and notes.";

/** The viewport position just below a button, for anchoring a menu. */
function positionBelow(element: HTMLElement): MenuPosition {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

function ServerWorkspaceExplorer({
  diagrams,
  sharedDiagrams = diagrams,
  notes = [],
  sharedNotes = notes,
  selectedDiagramId,
  selectedNoteId = null,
  openProposalCounts = {},
  onLoadDiagram,
  onLoadNote,
  onDiagramMenu,
  onNoteMenu,
  switcher,
  privateWorkContexts = [],
  architecturalProposals = [],
  onOpenArchitecturalProposal,
  selectedProposalId = null,
  revisingProposalId = null,
  onSubmitArchitecturalProposal,
  onCreateMyWork,
  onOpenMyWork,
  activeContextId = null,
  folderName = null,
  isLoading,
}: ExplorerProps) {
  const [search, setSearch] = useState("");
  const [sharedExpanded, setSharedExpanded] = useState(true);
  const [myWorkExpanded, setMyWorkExpanded] = useState(false);
  const [proposalsExpanded, setProposalsExpanded] = useState(false);
  const [localExpanded, setLocalExpanded] = useState(false);
  const [sectionChoicesTouched, setSectionChoicesTouched] = useState({ shared: false, myWork: false, proposals: false });
  useEffect(() => {
    if (!sectionChoicesTouched.myWork && privateWorkContexts.length > 0) setMyWorkExpanded(true);
    if (!sectionChoicesTouched.proposals && architecturalProposals.length > 0) setProposalsExpanded(true);
  }, [architecturalProposals.length, privateWorkContexts.length, sectionChoicesTouched.myWork, sectionChoicesTouched.proposals]);
  const resourceQuery = search.trim().toLowerCase();
  const visibleDiagrams = diagrams.filter((diagram) => `${diagramDisplayName(diagram.name, diagram.source)} ${diagram.name}`.toLowerCase().includes(resourceQuery));
  const visibleNotes = notes.filter((note) => `${noteDisplayName(note.name, note.markdown)} ${note.name}`.toLowerCase().includes(resourceQuery));

  return (
    <nav className="explorer explorer--project" data-testid="explorer" aria-label="Project explorer">
      {switcher}
      <div className="explorer__search" data-testid="explorer-search">
        <label className="visually-hidden" htmlFor="diagram-search-input">Search resources</label>
        <input id="diagram-search-input" className="explorer__search-input" data-testid="diagram-search-input" type="search" placeholder="Search resources…" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      <div className="explorer__provenance-tree" data-testid="explorer-provenance-tree">
         <section className="explorer__provenance-section" data-testid="explorer-shared-section">
          <h2 className="explorer__section-title"><button type="button" className="explorer__section-toggle" data-testid="explorer-shared-toggle" aria-expanded={sharedExpanded} onClick={() => { setSectionChoicesTouched((choices) => ({ ...choices, shared: true })); setSharedExpanded((expanded) => !expanded); }}>SHARED <span className="explorer__section-meta">authoritative</span><span aria-hidden="true">{sharedExpanded ? "▾" : "▸"}</span></button></h2>
          {sharedExpanded ? <ServerResourceTree diagrams={sharedDiagrams.filter((diagram) => `${diagramDisplayName(diagram.name, diagram.source)} ${diagram.name}`.toLowerCase().includes(resourceQuery))} notes={sharedNotes.filter((note) => `${noteDisplayName(note.name, note.markdown)} ${note.name}`.toLowerCase().includes(resourceQuery))} selectedDiagramId={activeContextId === null ? selectedDiagramId : null} selectedNoteId={activeContextId === null ? selectedNoteId : null} openProposalCounts={openProposalCounts} onLoadDiagram={activeContextId === null ? onLoadDiagram : () => undefined} onLoadNote={activeContextId === null ? onLoadNote : undefined} onDiagramMenu={activeContextId === null ? onDiagramMenu : undefined} onNoteMenu={activeContextId === null ? onNoteMenu : undefined} /> : null}
        </section>
           <section className="explorer__provenance-section" data-testid="explorer-my-work-section">
            <h2 className="explorer__section-title"><button type="button" className="explorer__section-toggle" data-testid="explorer-my-work-toggle" aria-expanded={myWorkExpanded} onClick={() => { setSectionChoicesTouched((choices) => ({ ...choices, myWork: true })); setMyWorkExpanded((expanded) => !expanded); }}>MY WORK <span className="explorer__section-meta">private · editable</span><span aria-hidden="true">{myWorkExpanded ? "▾" : "▸"}</span></button>{onCreateMyWork ? <button type="button" className="explorer__section-add" data-testid="explorer-my-work-create" aria-label="Create artifact in MY WORK" title="Create artifact in MY WORK" onClick={onCreateMyWork}>+</button> : null}</h2>
              {myWorkExpanded ? activeContextId !== null ? <><p className="explorer__context-note">Private draft. Changes are not authoritative.</p>{!isLoading ? <ServerResourceTree diagrams={visibleDiagrams} notes={visibleNotes} selectedDiagramId={selectedDiagramId} selectedNoteId={selectedNoteId} openProposalCounts={openProposalCounts} onLoadDiagram={onLoadDiagram} onLoadNote={onLoadNote} onDiagramMenu={onDiagramMenu} onNoteMenu={onNoteMenu} /> : null}</> : <ul className="explorer__context-list">{privateWorkContexts.length > 0 ? privateWorkContexts.map((work) => <li key={work.id} data-testid="explorer-private-context"><button type="button" data-testid={`explorer-private-context-open-${work.id}`} onClick={() => onOpenMyWork?.(work.id)}>{work.name}{work.lifecycle === "archived" ? " (archived)" : ""}</button>{work.lifecycle === "active" ? <button type="button" onClick={() => onSubmitArchitecturalProposal?.(work.id)}>Submit for review</button> : null}</li>) : <li className="explorer__diagram-empty">No private work yet. Create a draft to propose changes without modifying SHARED.</li>}</ul> : null}
        </section>
        <section className="explorer__provenance-section">
            <h2 className="explorer__section-title"><button type="button" className="explorer__section-toggle" data-testid="explorer-proposals-toggle" aria-expanded={proposalsExpanded} onClick={() => { setSectionChoicesTouched((choices) => ({ ...choices, proposals: true })); setProposalsExpanded((expanded) => !expanded); }}>PROPOSALS <span className="explorer__section-meta">team review · non-authoritative</span><span aria-hidden="true">{proposalsExpanded ? "▾" : "▸"}</span></button></h2>
              {proposalsExpanded ? <ul className="explorer__context-list">{architecturalProposals.length > 0 ? architecturalProposals.map((proposal) => <li key={proposal.id} data-testid="explorer-proposal" className={proposal.id === selectedProposalId ? "explorer__context-item explorer__context-item--selected" : "explorer__context-item"} data-revising={proposal.id === revisingProposalId ? "true" : undefined}><button type="button" className="explorer__context-item-button" data-testid="explorer-proposal-open" aria-current={proposal.id === selectedProposalId ? "true" : undefined} aria-label={`Open proposal ${proposal.title}`} onClick={() => onOpenArchitecturalProposal?.(proposal.id)}>{proposal.title}</button><span>{proposalLifecycle(proposal, proposal.reviewStatus ? { status: proposal.reviewStatus } : null)}</span><small>{proposal.submittedAt ? new Date(proposal.submittedAt).toLocaleDateString() : "undated"} · {proposal.id.slice(0, 8)}</small>{proposal.id === revisingProposalId ? <small data-testid="explorer-revision-origin">REVISING</small> : null}</li>) : <li className="explorer__diagram-empty">No proposals yet. Submit work from MY WORK for review.</li>}</ul> : null}
        </section>
        {folderName ? <section className="explorer__provenance-section">
          <h2 className="explorer__section-title"><button type="button" className="explorer__section-toggle" data-testid="explorer-local-toggle" aria-expanded={localExpanded} onClick={() => setLocalExpanded((expanded) => !expanded)}>LOCAL <span aria-hidden="true">{localExpanded ? "▾" : "▸"}</span></button></h2>
          {localExpanded ? <p className="explorer__local-binding">{folderName}</p> : null}
        </section> : null}
      </div>
    </nav>
  );
}

function LocalWorkspaceExplorer({
  projects,
  diagrams,
  notes = [],
  allDiagrams = [],
  allNotes = [],
  selectedProjectId,
  selectedDiagramId,
  selectedNoteId = null,
  openProposalCounts = {},
  isLoading,
  onCreateProject,
  onAddMenu,
  onLoadDiagram,
  onLoadNote,
  onDiagramMenu,
  onNoteMenu,
  onProjectMenu,
  hiddenCount = 0,
  onUnhideAll,
  onOpenFolder,
  folderName = null,
  workspaceLabel,
  folderSupported = false,
  switcher,
}: ExplorerProps) {
  const [pendingName, setPendingName] = useState<string>("");
  // The search filters files by name across all projects. It is local UI state:
  // clearing it restores the normal selected-project view.
  const [search, setSearch] = useState<string>("");
  const [contentExpanded, setContentExpanded] = useState(true);
  const [createExpanded, setCreateExpanded] = useState(false);

  const create = (): void => {
    const name = pendingName.trim();
    if (name) {
      onCreateProject(name);
      setPendingName("");
      setCreateExpanded(false);
    }
  };

  // With a non-empty query, match names across every project; otherwise keep the
  // normal view of the selected project's files. Matching is a case-insensitive
  // substring test on the trimmed query. A diagram's name is the `title` in its
  // source and a note's is its first heading, so renaming either renames it here;
  // the backing file name is matched too, so a search by file name works.
  const query = search.trim().toLowerCase();
  const diagramName = (diagram: DiagramFile): string =>
    diagramDisplayName(diagram.name, diagram.source);
  const noteName = (note: NoteFile): string =>
    noteDisplayName(note.name, note.markdown);
  const matchesDiagram = (diagram: DiagramFile): boolean =>
    query === "" ||
    `${diagramName(diagram)} ${diagram.name}`.toLowerCase().includes(query);
  const matchesNote = (note: NoteFile): boolean =>
    query === "" ||
    `${noteName(note)} ${note.name}`.toLowerCase().includes(query);
  // Matches are computed across every project only while searching. With an
  // empty query each project shows its own files: the selected project's lists
  // preserve their display order, and every other project reads the
  // workspace-wide lists. Without that second half a non-selected project's row
  // would always look empty, even when expanded.
  //
  // The projectId filter is applied even to the selected project's own lists.
  // They are loaded per project, but a filter here means a transient mismatch
  // can never draw one project's file under another project's header.
  const matchedDiagrams =
    query === "" ? null : allDiagrams.filter(matchesDiagram);
  const matchedNotes = query === "" ? null : allNotes.filter(matchesNote);
  const noMatches =
    matchedDiagrams !== null &&
    matchedDiagrams.length === 0 &&
    (matchedNotes?.length ?? 0) === 0;

  const diagramsOf = (projectId: string): DiagramFile[] =>
    matchedDiagrams
      ? matchedDiagrams.filter((diagram) => diagram.projectId === projectId)
      : projectId === selectedProjectId
        ? diagrams.filter((diagram) => diagram.projectId === projectId)
        : allDiagrams.filter((diagram) => diagram.projectId === projectId);
  const notesOf = (projectId: string): NoteFile[] =>
    matchedNotes
      ? matchedNotes.filter((note) => note.projectId === projectId)
      : projectId === selectedProjectId
        ? notes.filter((note) => note.projectId === projectId)
        : allNotes.filter((note) => note.projectId === projectId);

  const modeLabel = workspaceLabel ?? (folderName ? `“${folderName}”` : null);

  return (
    <nav className="explorer" data-testid="explorer">
      {switcher}
      {modeLabel && (
        <div
          className="explorer__header"
          data-testid="explorer-header"
          role="region"
          aria-label="Workspace source"
        >
          <span className="explorer__mode" data-testid="explorer-mode">
            {modeLabel}
          </span>
          {onOpenFolder && (
            <button
              type="button"
              className="explorer__open-button"
              data-testid="open-folder-button"
              aria-label={folderName ? "Close folder" : "Open a local folder"}
              disabled={!folderSupported}
              onClick={onOpenFolder}
            >
              {folderName ? "Close folder" : "Open folder…"}
            </button>
          )}
        </div>
      )}

      {hiddenCount > 0 && onUnhideAll && (
        <div className="explorer__hidden" data-testid="explorer-hidden">
          <span className="explorer__hidden-label">
            {hiddenCount} removed from app
          </span>
          <button
            type="button"
            className="explorer__hidden-button"
            data-testid="unhide-all-button"
            onClick={onUnhideAll}
          >
            Restore
          </button>
        </div>
      )}

      <section className="explorer__content-region" aria-label="Active project content">
      <h2 className="explorer__section-title">
        <button
          type="button"
          className="explorer__section-toggle"
          data-testid="explorer-content-toggle"
          aria-expanded={contentExpanded}
          onClick={() => setContentExpanded((expanded) => !expanded)}
        >
          Projects <span aria-hidden="true">{contentExpanded ? "▾" : "▸"}</span>
        </button>
        <button type="button" className="explorer__section-add" data-testid="local-create-toggle" aria-label="Create local project" aria-expanded={createExpanded} onClick={() => setCreateExpanded((expanded) => !expanded)}>+</button>
      </h2>
      {contentExpanded && <>
      {createExpanded && <form
        className="explorer__create"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <label className="visually-hidden" htmlFor="project-name-input">
          New project name
        </label>
        <input
          id="project-name-input"
          className="explorer__input"
          data-testid="project-name-input"
          value={pendingName}
          onChange={(event) => setPendingName(event.target.value)}
          placeholder="New project"
        />
        <button
          type="submit"
          className="explorer__create-button"
          data-testid="create-project-button"
          disabled={pendingName.trim() === ""}
        >
          Add project
        </button>
      </form>}

      <div className="explorer__search" data-testid="explorer-search">
        <label className="visually-hidden" htmlFor="diagram-search-input">
          Search diagrams and notes
        </label>
        <input
          id="diagram-search-input"
          className="explorer__search-input"
          data-testid="diagram-search-input"
          type="search"
          placeholder="Search diagrams and notes…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {isLoading ? (
        <p className="explorer__loading" data-testid="explorer-loading">
          Loading projects…
        </p>
      ) : query !== "" && noMatches ? (
        <p className="explorer__empty" data-testid="explorer-empty">
          No diagrams or notes match “{search.trim()}”.
        </p>
      ) : projects.length === 0 ? (
        <p className="explorer__empty" data-testid="explorer-empty">
          {EMPTY_HINT}
        </p>
      ) : (
        <ul className="explorer__projects" data-testid="explorer-projects">
          {projects.map((project) => {
            const projectDiagrams = diagramsOf(project.id);
            const projectNotes = notesOf(project.id);
            return (
              <li
                key={project.id}
                className={`explorer__project${
                  project.id === selectedProjectId
                    ? " explorer__project--selected"
                    : ""
                }`}
                data-testid="explorer-project"
                aria-current={
                  project.id === selectedProjectId ? "true" : undefined
                }
              >
                <div
                  className="explorer__project-header"
                  onContextMenu={(event) => {
                    if (!onProjectMenu) return;
                    event.preventDefault();
                    onProjectMenu(project, {
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  <span
                    className="explorer__project-name"
                    data-testid="project-name"
                  >
                    {project.name}
                  </span>
                  {onAddMenu && (
                    <button
                      type="button"
                      className="explorer__project-add"
                      data-testid="project-add-button"
                      aria-label={`Add diagram or note to ${project.name}`}
                      aria-haspopup="menu"
                      title="Add diagram or note"
                      onClick={(event) =>
                        onAddMenu(project, positionBelow(event.currentTarget))
                      }
                    >
                      ＋
                    </button>
                  )}
                  {onProjectMenu && (
                    <button
                      type="button"
                      className="explorer__project-menu"
                      data-testid="project-menu-button"
                      aria-label={`Actions for project ${project.name}`}
                      aria-haspopup="menu"
                      title="Project actions…"
                      onClick={(event) =>
                        onProjectMenu(
                          project,
                          positionBelow(event.currentTarget),
                        )
                      }
                    >
                      ⋯
                    </button>
                  )}
                </div>

                <ul
                    className="explorer__diagrams"
                    data-testid="explorer-diagrams"
                  >
                    {projectDiagrams.length === 0 &&
                    query === "" &&
                    selectedProjectId === project.id ? (
                      <li
                        className="explorer__diagram-empty"
                        data-testid="explorer-diagram-empty"
                      >
                        No diagrams.
                      </li>
                    ) : (
                      projectDiagrams.map((diagram) => (
                        <li
                          key={diagram.id}
                          className={`explorer__diagram${
                            diagram.id === selectedDiagramId
                              ? " explorer__diagram--selected"
                              : ""
                          }`}
                          data-testid="explorer-diagram"
                          aria-current={
                            diagram.id === selectedDiagramId
                              ? "true"
                              : undefined
                          }
                          onContextMenu={(
                            event: ReactMouseEvent<HTMLLIElement>,
                          ) => {
                            if (!onDiagramMenu) return;
                            event.preventDefault();
                            onDiagramMenu(diagram, {
                              x: event.clientX,
                              y: event.clientY,
                            });
                          }}
                        >
                          <button
                            type="button"
                            className="explorer__diagram-button"
                            data-testid="select-diagram-button"
                            aria-label={`Load diagram ${diagramName(diagram)}`}
                            onClick={() => onLoadDiagram(diagram)}
                          >
                            <span
                              className={`explorer__diagram-kind ${
                                diagram.name.toLowerCase().endsWith(".eventseq")
                                  ? "explorer__diagram-kind--event-flow"
                                  : "explorer__diagram-kind--sequence"
                              }`}
                              aria-hidden="true"
                              title={
                                diagram.name.toLowerCase().endsWith(".eventseq")
                                  ? "Event Flow"
                                  : "Sequence diagram"
                              }
                            >
                              {diagram.name.toLowerCase().endsWith(".eventseq")
                                ? "□"
                                : "○"}
                            </span>
                            <span className="explorer__item-name">
                              {diagramName(diagram)}
                            </span>
                            <span
                              className="explorer__status-slot"
                              data-testid="explorer-status-slot"
                            >
                              {(openProposalCounts[diagram.id] ?? 0) > 0 && (
                                <span
                                  className="explorer__proposal-indicator"
                                  title={`${openProposalCounts[diagram.id]} open change${openProposalCounts[diagram.id] === 1 ? "" : "s"}`}
                                  aria-label={`${openProposalCounts[diagram.id]} open change${openProposalCounts[diagram.id] === 1 ? "" : "s"}`}
                                >
                                  ◆
                                  {openProposalCounts[diagram.id] > 1
                                    ? ` ${openProposalCounts[diagram.id]}`
                                    : ""}
                                </span>
                              )}
                            </span>
                          </button>
                          {onDiagramMenu && (
                            <button
                              type="button"
                              className="explorer__diagram-menu"
                              data-testid="diagram-menu-button"
                              aria-label={`Actions for diagram ${diagramName(
                                diagram,
                              )}`}
                              title="More actions…"
                              onClick={(event) =>
                                onDiagramMenu(
                                  diagram,
                                  positionBelow(event.currentTarget),
                                )
                              }
                            >
                              ⋯
                            </button>
                          )}
                        </li>
                      ))
                    )}
                  </ul>

                 <ul className="explorer__notes" data-testid="explorer-notes">
                    {projectNotes.length === 0 &&
                    query === "" &&
                    selectedProjectId === project.id ? (
                      <li
                        className="explorer__diagram-empty"
                        data-testid="explorer-note-empty"
                      >
                        No notes.
                      </li>
                    ) : (
                      projectNotes.map((note) => (
                        <li
                          key={note.id}
                          className={`explorer__note${
                            note.id === selectedNoteId
                              ? " explorer__note--selected"
                              : ""
                          }`}
                          data-testid="explorer-note"
                          aria-current={
                            note.id === selectedNoteId ? "true" : undefined
                          }
                          onContextMenu={(
                            event: ReactMouseEvent<HTMLLIElement>,
                          ) => {
                            if (!onNoteMenu) return;
                            event.preventDefault();
                            onNoteMenu(note, {
                              x: event.clientX,
                              y: event.clientY,
                            });
                          }}
                        >
                          <button
                            type="button"
                            className="explorer__note-button"
                            data-testid="select-note-button"
                            aria-label={`Open note ${noteName(note)}`}
                            onClick={() => onLoadNote?.(note)}
                          >
                            <span
                              className="explorer__item-icon"
                              aria-hidden="true"
                            >
                              ¶
                            </span>
                            <span className="explorer__item-name">
                              {noteName(note)}
                            </span>
                            <span
                              className="explorer__status-slot"
                              data-testid="explorer-status-slot"
                            >
                              {(openProposalCounts[note.id] ?? 0) > 0 && (
                                <span
                                  className="explorer__proposal-indicator"
                                  title={`${openProposalCounts[note.id]} open change${openProposalCounts[note.id] === 1 ? "" : "s"}`}
                                  aria-label={`${openProposalCounts[note.id]} open change${openProposalCounts[note.id] === 1 ? "" : "s"}`}
                                >
                                  ◆
                                  {openProposalCounts[note.id] > 1
                                    ? ` ${openProposalCounts[note.id]}`
                                    : ""}
                                </span>
                              )}
                            </span>
                          </button>
                          {onNoteMenu && (
                            <button
                              type="button"
                              className="explorer__note-menu"
                              data-testid="note-menu-button"
                              aria-label={`Actions for note ${noteName(note)}`}
                              title="More actions…"
                              onClick={(event) =>
                                onNoteMenu(
                                  note,
                                  positionBelow(event.currentTarget),
                                )
                              }
                            >
                              ⋯
                            </button>
                          )}
                        </li>
                      ))
                    )}
                  </ul>
              </li>
            );
          })}
        </ul>
      )}
      </>}
      </section>
    </nav>
  );
}

export default function Explorer(props: ExplorerProps) {
  if (props.projectBrowser) return props.switcher;
  return props.serverMode ? <ServerWorkspaceExplorer {...props} /> : <LocalWorkspaceExplorer {...props} />;
}
