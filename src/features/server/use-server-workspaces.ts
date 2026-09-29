/**
 * The server side of the workspace switcher.
 *
 * This hook owns what `useWorkspace` deliberately does not: the *list* of
 * authenticated server projects, creating one, and opening one. A
 * {@link ServerWorkspaceRepository} addresses exactly one project, so "which
 * server project is open" is a decision made here and handed down as a single
 * active binding.
 *
 * Opening is asynchronous in a way a local project's is not: the caller's
 * permissions must be read before an editor is built, because a viewer's
 * repository must be genuinely read-only rather than merely hidden. The binding
 * is therefore only published once both the project and its access are known, so
 * no render ever shows a writable editor for a project the account cannot write.
 *
 * Signing out, or losing the session, closes the binding: a stale repository
 * would keep issuing requests that can only fail, and would leave another
 * person's project on screen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ServerApiClient,
  ServerProject,
  ServerPrivateWorkContext,
  ServerArchitecturalProposal,
} from "../../workspace/server/api-client";
import {
  createServerWorkspaceRepository,
  type ServerWorkspaceRepository,
} from "../../workspace/server/server-workspace-repository";
import type { AuthState } from "./use-auth";

/** The one server project the editor is currently bound to. */
export interface ActiveServerWorkspace {
  project: ServerProject;
  repository: ServerWorkspaceRepository;
  /** The explicit private context being edited, or null for SHARED. */
  contextId: string | null;
  /** Whether this account may change the project's resources. */
  writable: boolean;
}

/** The server project list and the active binding. */
export interface ServerWorkspacesHook {
  projects: ServerProject[];
  projectsLoading: boolean;
  projectsError: string | null;
  /** The open binding, or `null` when the editor is on a local workspace. */
  active: ActiveServerWorkspace | null;
  /** True while a project is being opened (access is being read). */
  opening: boolean;
  /** A failure from the last open or create attempt, for the UI to show. */
  openError: string | null;
  refresh(): Promise<void>;
  openProject(project: ServerProject): Promise<void>;
  openPrivateWork(contextId: string): Promise<void>;
  createProject(name: string): Promise<void>;
  close(): void;
  privateWorkContexts: ServerPrivateWorkContext[];
  architecturalProposals: ServerArchitecturalProposal[];
}

/** The permission a writable repository requires. */
/**
 * Track the caller's server projects.
 *
 * @param client - The API client, shared with the rest of the app.
 * @param auth - The current session state; the list is loaded when it becomes
 *   authenticated and dropped when it stops being.
 */
export function useServerWorkspaces(
  client: ServerApiClient,
  auth: AuthState,
  selectedWorkspaceId: string | null,
): ServerWorkspacesHook {
  const [projects, setProjects] = useState<ServerProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveServerWorkspace | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [privateWorkContexts, setPrivateWorkContexts] = useState<ServerPrivateWorkContext[]>([]);
  const [architecturalProposals, setArchitecturalProposals] = useState<ServerArchitecturalProposal[]>([]);
  const activeRef = useRef<ActiveServerWorkspace | null>(null);
  // Repository authority changes only when the project/session/workspace changes.
  // Same-project navigation refreshes the read model without replacing it.
  const repositoryGeneration = useRef(0);
  const projectReadModelGeneration = useRef(0);
  const authenticated = auth.status === "authenticated";
  activeRef.current = active;

  const refresh = useCallback(async (): Promise<void> => {
    if (!authenticated || selectedWorkspaceId === null) {
      projectReadModelGeneration.current += 1;
      setProjects([]);
      setProjectsError(null);
      setPrivateWorkContexts([]);
      setArchitecturalProposals([]);
      return;
    }
    const generation = ++projectReadModelGeneration.current;
    const workspaceId = selectedWorkspaceId;
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const nextProjects = await client.listProjects(selectedWorkspaceId);
      if (generation !== projectReadModelGeneration.current || workspaceId !== selectedWorkspaceId) return;
      setProjects(nextProjects);
      const current = activeRef.current;
      if (current) {
        const [contexts, proposals] = await Promise.all([
          client.listPrivateWorkContexts(current.project.id),
          client.listArchitecturalProposals(current.project.id),
        ]);
        if (
          generation !== projectReadModelGeneration.current ||
          workspaceId !== selectedWorkspaceId ||
          activeRef.current?.project.id !== current.project.id
        ) return;
        setPrivateWorkContexts(contexts);
        setArchitecturalProposals(proposals);
      }
    } catch (error) {
      if (generation === projectReadModelGeneration.current) setProjects([]);
      if (generation === projectReadModelGeneration.current) {
        setProjectsError(
          error instanceof Error
            ? error.message
            : "The projects could not be loaded.",
        );
      }
    } finally {
      if (generation === projectReadModelGeneration.current) setProjectsLoading(false);
    }
  }, [client, authenticated, selectedWorkspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Losing the session closes whatever it had open. Keeping the binding would
  // leave one person's project rendered for the next person at the browser.
  useEffect(() => {
    if (!authenticated) {
      repositoryGeneration.current += 1;
      projectReadModelGeneration.current += 1;
      setActive(null);
      setOpenError(null);
      setOpening(false);
      setPrivateWorkContexts([]);
      setArchitecturalProposals([]);
    }
  }, [authenticated]);

  useEffect(() => {
    if (active !== null && active.project.workspaceId !== selectedWorkspaceId) {
      repositoryGeneration.current += 1;
      projectReadModelGeneration.current += 1;
      setActive(null);
      setOpenError(null);
      setPrivateWorkContexts([]);
      setArchitecturalProposals([]);
    }
  }, [active?.project.workspaceId, selectedWorkspaceId]);

  const openProject = useCallback(
    async (project: ServerProject): Promise<void> => {
      const sameProject = activeRef.current?.project.id === project.id;
      const changesRepository =
        !sameProject || activeRef.current?.contextId !== null;
      const repositoryGenerationAtStart = changesRepository
        ? ++repositoryGeneration.current
        : repositoryGeneration.current;
      const readModelGeneration = ++projectReadModelGeneration.current;
      setOpening(true);
      setOpenError(null);
      try {
         await client.access(project.id);
        if (
          repositoryGeneration.current !== repositoryGenerationAtStart ||
          readModelGeneration !== projectReadModelGeneration.current
        ) return;
        // One decision, used twice: the UI's read-only affordances and the
        // repository's own refusal must never disagree.
         // SHARED is authoritative and is read-only in the ordinary workspace.
         // Editing requires an explicit MY WORK context.
         const writable = false;
         try {
           const [contexts, proposals] = await Promise.all([
             client.listPrivateWorkContexts(project.id),
             client.listArchitecturalProposals(project.id),
           ]);
           if (
             repositoryGeneration.current !== repositoryGenerationAtStart ||
             readModelGeneration !== projectReadModelGeneration.current
           ) return;
           setPrivateWorkContexts(contexts);
           setArchitecturalProposals(proposals);
         } catch {
           // Older API clients may not expose private work yet; SHARED remains readable.
           if (
             repositoryGeneration.current === repositoryGenerationAtStart &&
             readModelGeneration === projectReadModelGeneration.current
           ) {
             setPrivateWorkContexts([]);
             setArchitecturalProposals([]);
           }
         }
         if (
           repositoryGeneration.current !== repositoryGenerationAtStart ||
           readModelGeneration !== projectReadModelGeneration.current
         ) return;
         if (changesRepository) {
           setActive({
             project,
             writable,
             contextId: null,
             repository: createServerWorkspaceRepository({
               client,
               projectId: project.id,
               projectName: project.name,
               writable,
             }),
           });
         }
      } catch (error) {
        if (
          repositoryGeneration.current !== repositoryGenerationAtStart ||
          readModelGeneration !== projectReadModelGeneration.current
        ) return;
        setActive(null);
        setOpenError(
          error instanceof Error
            ? error.message
            : "The project could not be opened.",
        );
      } finally {
        if (
          repositoryGeneration.current === repositoryGenerationAtStart &&
          readModelGeneration === projectReadModelGeneration.current
        ) setOpening(false);
      }
    },
    [client],
  );

  const openPrivateWork = useCallback(
    async (contextId: string): Promise<void> => {
      if (!active || active.project.id === "") return;
      const contexts = privateWorkContexts.length > 0
        ? privateWorkContexts
        : await client.listPrivateWorkContexts(active.project.id);
      if (!contexts.some((context) => context.id === contextId)) return;
      const access = await client.access(active.project.id);
      setActive({
        ...active,
        contextId,
        repository: createServerWorkspaceRepository({
          client,
          projectId: active.project.id,
          projectName: active.project.name,
         writable: access.permissions.includes("resource:update"),
          contextId,
        }),
      });
    },
    [active, client, privateWorkContexts],
  );

  const createProject = useCallback(
    async (name: string): Promise<void> => {
      if (selectedWorkspaceId === null) return;
      setOpenError(null);
      try {
        const created = await client.createProject(name, selectedWorkspaceId);
        await refresh();
        await openProject(created);
      } catch (error) {
        setOpenError(
          error instanceof Error
            ? error.message
            : "The project could not be created.",
        );
      }
    },
    [client, openProject, refresh, selectedWorkspaceId],
  );

  const close = useCallback((): void => {
    repositoryGeneration.current += 1;
    projectReadModelGeneration.current += 1;
    setActive(null);
    setOpenError(null);
    setPrivateWorkContexts([]);
    setArchitecturalProposals([]);
  }, []);

  return {
    projects,
    projectsLoading,
    projectsError,
    active,
    opening,
    openError,
    refresh,
    openProject,
    openPrivateWork,
    createProject,
    close,
    privateWorkContexts,
    architecturalProposals,
  };
}
