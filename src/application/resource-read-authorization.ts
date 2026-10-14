import type { ApplicationContext } from "./context";
import type { AuthorizationPolicy } from "./authorization";
import { notFound } from "./errors";
import type { KnowledgeContextRepository } from "./ports/knowledge-context-repository";
import type { ProjectRepository, ResourceRecord } from "./ports/project-repository";

export interface ResourceReadAccess {
  projects: ProjectRepository;
  knowledgeContexts: KnowledgeContextRepository;
  policy: AuthorizationPolicy;
}

export async function requireResourceReadContext(
  context: ApplicationContext,
  projectId: string,
  contextId: string | null,
  access: ResourceReadAccess,
): Promise<void> {
  await access.policy.requirePermission(context, projectId, "resource:read");
  if (contextId === null) return;

  await access.policy.requirePermission(context, projectId, "project:read");
  const ownedContext = await access.knowledgeContexts.findPrivate(
    projectId,
    contextId,
    context.principal.subjectUserId,
  );
  if (!ownedContext) throw notFound("No resource is available in the selected context.");
}

export async function findReadableResource(
  context: ApplicationContext,
  projectId: string,
  resourceId: string,
  contextId: string | null,
  access: ResourceReadAccess,
  includeRetiredShared = false,
): Promise<ResourceRecord> {
  await requireResourceReadContext(context, projectId, contextId, access);
  const resource = contextId === null && includeRetiredShared && access.projects.findHistoricalResource
    ? await access.projects.findHistoricalResource(projectId, resourceId, null)
    : await access.projects.findResource(projectId, resourceId, contextId);
  if (!resource) throw notFound(`No resource with id ${resourceId}.`);
  return resource;
}
