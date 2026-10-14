import type { ApplicationContext } from "./context";
import { createAuthorizationPolicy, type AuthorizationPolicy } from "./authorization";
import type { ProjectRepository } from "./ports/project-repository";
import type { TrajectoryEntry } from "../domain/workspace/resource-trajectory";
import type { KnowledgeContextRepository } from "./ports/knowledge-context-repository";
import { findReadableResource, requireResourceReadContext } from "./resource-read-authorization";

export function normalizeTrajectoryContextId(contextId?: string | null): string | null {
  return contextId === undefined || contextId === null || contextId === "shared" ? null : contextId;
}

export interface ResourceTrajectoryService {
  getProjectTrajectory(
    context: ApplicationContext,
    projectId: string,
    options?: { limit?: number; cursor?: number },
    contextId?: string | null,
  ): Promise<{ entries: TrajectoryEntry[]; nextCursor: number | null }>;
  getResourceTrajectory(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
    options?: { limit?: number; cursor?: number },
    contextId?: string | null,
  ): Promise<{ entries: TrajectoryEntry[]; nextCursor: number | null }>;
}

export function createResourceTrajectoryService(options: {
  projects: ProjectRepository;
  knowledgeContexts: KnowledgeContextRepository;
  policy?: AuthorizationPolicy;
}): ResourceTrajectoryService {
  const policy = options.policy ?? createAuthorizationPolicy(options.projects);
  const access = { ...options, policy };
  return {
    async getProjectTrajectory(context, projectId, page = {}, requestedContextId) {
      const contextId = normalizeTrajectoryContextId(requestedContextId);
      await requireResourceReadContext(context, projectId, contextId, access);
      return options.projects.listTrajectory(projectId, { ...page, contextId });
    },
    async getResourceTrajectory(context, projectId, resourceId, page = {}, requestedContextId) {
      const contextId = normalizeTrajectoryContextId(requestedContextId);
      const resource = await findReadableResource(context, projectId, resourceId, contextId, access, true);
      return options.projects.listTrajectory(projectId, { ...page, resourceId: resource.id, contextId });
    },
  };
}
