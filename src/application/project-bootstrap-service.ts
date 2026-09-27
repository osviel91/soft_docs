import type { ApplicationContext } from "./context";
import { actorIdOf, actorTypeOf, credentialIdOf } from "./context";
import type { AuthorizationPolicy } from "./authorization";
import type { ServerProject } from "../domain/project/server-project";
import type { ProjectRepository } from "./ports/project-repository";
import type { AuthoritativeBatchRepository, AuthoritativeBatchOperation } from "./ports/authoritative-batch-repository";
import type { ProjectStorage } from "./project-storage";
import type { ResourceType } from "../domain/workspace/resource-id";
import type { ProjectMetadata } from "../domain/workspace/metadata";
import { createEmptyMetadata } from "../domain/workspace/metadata";
import { createIdGenerator } from "../shared/ids/uuid";
import { invalid, unavailable } from "./errors";

export interface ProjectBootstrapService {
  bootstrap(context: ApplicationContext, input: { workspaceId: string; name: string; resources: Array<{ path: string; type: ResourceType; content: string }> }): Promise<ServerProject>;
}

export function createProjectBootstrapService(options: {
  projects: ProjectRepository;
  batches: AuthoritativeBatchRepository;
  storage: (projectId: string) => ProjectStorage;
  createProject: (context: ApplicationContext, input: { workspaceId: string; name: string }) => Promise<{ project: ServerProject }>;
  policy: AuthorizationPolicy<ServerProject>;
  audit?: import("./ports/audit-repository").AuditRepository;
}): ProjectBootstrapService {
  const newId = createIdGenerator();
  return {
    async bootstrap(context, input) {
      if (!input.name.trim() || input.resources.length === 0) throw invalid("A bootstrap requires a project name and at least one resource.");
      const paths = new Set<string>();
      for (const resource of input.resources) {
        if (paths.has(resource.path)) throw invalid(`Duplicate bootstrap path: ${resource.path}.`);
        paths.add(resource.path);
      }
      const created = await options.createProject(context, { workspaceId: input.workspaceId, name: input.name.trim() });
      const project = created.project;
      const storage = options.storage(project.id);
      const metadata: ProjectMetadata = createEmptyMetadata();
      const operations: AuthoritativeBatchOperation[] = [];
      const stagedRoot = `.bootstrap/${newId()}`;
      for (const resource of input.resources) {
        const resourceId = newId();
        const stagedPath = `${stagedRoot}/${resourceId}`;
        const written = await storage.write(stagedPath, resource.content);
        if (!written.ok) throw unavailable("The bootstrap could not stage a resource.");
        operations.push({ operation: "create", resourceId, path: resource.path, type: resource.type, content: resource.content, stagedPath });
        metadata.resources.push({ id: resourceId, path: resource.path, type: resource.type, title: resource.path });
      }
      const manifestContent = JSON.stringify(metadata, null, 2);
      const manifestStagedPath = `${stagedRoot}/project.json`;
      const stagedManifest = await storage.write(manifestStagedPath, manifestContent);
      if (!stagedManifest.ok) throw unavailable("The bootstrap could not stage the project manifest.");
      const batch = await options.batches.claim({
        batchId: newId(), projectId: project.id,
        actor: context.principal.actor.kind === "agent" ? { kind: "agent", agentId: context.principal.actor.agentId, credentialId: context.principal.actor.credentialId, subjectUserId: context.principal.subjectUserId } : { kind: "user", userId: context.principal.actor.userId, subjectUserId: context.principal.subjectUserId },
        audit: { action: "project.bootstrapped", subjectUserId: context.principal.subjectUserId, actorType: actorTypeOf(context.principal), actorId: actorIdOf(context.principal), credentialId: credentialIdOf(context.principal), authType: context.principal.authType, projectId: project.id, resourceId: null, requestId: context.requestId, detail: { resourceCount: operations.length } },
        operations,
        manifest: { expectedRevision: 0, expectedContent: null, content: manifestContent, stagedPath: manifestStagedPath },
        idempotencyKey: `bootstrap:${project.id}`,
      });
      for (const operation of batch.operations) if (operation.stagedPath && operation.targetPath) {
        const promoted = await storage.promote({ from: operation.stagedPath, to: operation.targetPath });
        if (!promoted.ok) throw unavailable("The bootstrap is awaiting filesystem recovery.");
      }
      const promotedManifest = await storage.promote({ from: manifestStagedPath, to: "project.json" });
      if (!promotedManifest.ok) throw unavailable("The bootstrap is awaiting manifest recovery.");
      await options.batches.complete(batch.id);
      return project;
    },
  };
}
