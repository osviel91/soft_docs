import type { ApplicationContext } from "./context";
import { createAuthorizationPolicy, type AuthorizationPolicy } from "./authorization";
import { ApplicationError, notFound } from "./errors";
import type { KnowledgeContextRepository } from "./ports/knowledge-context-repository";
import type { ProjectRepository, ResourceRecord } from "./ports/project-repository";
import { resourceRepresentationOfType, type ResourceRepresentation, type ResourceType } from "../domain/workspace/resource-id";
import type { ResourceRevision, ResourceAuthorship } from "../domain/workspace/resource-revision";
import type { ResourceMetadata } from "../domain/workspace/resource-metadata";

export interface ResourceRevisionSummary {
  resourceId: string;
  projectId: string;
  contextId: string | null;
  revision: number;
  type: ResourceType;
  representation: ResourceRepresentation;
  createdAt: Date;
}

export interface ResourceRevisionSnapshot extends ResourceRevisionSummary {
  path: string;
  content: string;
  metadata?: ResourceMetadata;
  authoredBy: ResourceAuthorship;
}

export interface ResourceRevisionService {
  list(context: ApplicationContext, projectId: string, resourceId: string, contextId: string | null): Promise<ResourceRevisionSummary[]>;
  get(context: ApplicationContext, projectId: string, resourceId: string, contextId: string | null, revision: number): Promise<ResourceRevisionSnapshot>;
}

export function createResourceRevisionService(options: {
  projects: ProjectRepository;
  knowledgeContexts: KnowledgeContextRepository;
  policy?: AuthorizationPolicy;
}): ResourceRevisionService {
  const policy = options.policy ?? createAuthorizationPolicy(options.projects);

  const authorizeResource = async (
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
    contextId: string | null,
  ): Promise<ResourceRecord> => {
    await policy.requirePermission(context, projectId, "resource:read");
    if (contextId !== null) {
      await policy.requirePermission(context, projectId, "project:read");
      const privateContext = await options.knowledgeContexts.findPrivate(
        projectId,
        contextId,
        context.principal.subjectUserId,
      );
      if (!privateContext) throw notFound(`No resource with id ${resourceId}.`);
    }
    const resource = await options.projects.findResource(projectId, resourceId, contextId);
    if (!resource) throw notFound(`No resource with id ${resourceId}.`);
    return resource;
  };

  const snapshot = (
    resource: ResourceRecord,
    revision: ResourceRevision,
  ): ResourceRevisionSnapshot => ({
    resourceId: resource.id,
    projectId: resource.projectId,
    contextId: resource.contextId ?? null,
    path: resource.path,
    revision: revision.revision,
    type: revision.type,
    representation: resourceRepresentationOfType(revision.type),
    content: revision.content,
    ...(revision.metadata === undefined ? {} : { metadata: revision.metadata }),
    authoredBy: revision.authoredBy,
    createdAt: revision.createdAt,
  });

  const checkedRevision = (resourceId: string, revision: ResourceRevision): void => {
    if (revision.resourceId !== resourceId) {
      throw new ApplicationError("internal", "The revision did not match its authorized resource.");
    }
  };

  return {
    async list(context, projectId, resourceId, contextId) {
      const resource = await authorizeResource(context, projectId, resourceId, contextId);
      // ponytail: reuse the existing history query; add paged summaries if histories become large.
      const revisions = await options.projects.listRevisions(resource.id);
      if (revisions.some((revision) => revision.resourceId !== resource.id)) {
        throw new ApplicationError("internal", "Revision history contained another resource.");
      }
      return revisions.map((revision) => ({
        resourceId: resource.id,
        projectId: resource.projectId,
        contextId: resource.contextId ?? null,
        revision: revision.revision,
        type: revision.type,
        representation: resourceRepresentationOfType(revision.type),
        createdAt: revision.createdAt,
      }));
    },
    async get(context, projectId, resourceId, contextId, revisionNumber) {
      const resource = await authorizeResource(context, projectId, resourceId, contextId);
      if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1) {
        throw notFound(`No revision ${revisionNumber} for resource ${resourceId}.`);
      }
      const revision = await options.projects.getRevision(resource.id, revisionNumber);
      if (!revision) throw notFound(`No revision ${revisionNumber} for resource ${resourceId}.`);
      checkedRevision(resource.id, revision);
      return snapshot(resource, revision);
    },
  };
}
