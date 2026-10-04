import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ApplicationContext } from "./context";
import { forbidden, notFound, conflict } from "./errors";
import type { AuditEvent } from "./ports/audit-repository";
import type { ProjectRepository } from "./ports/project-repository";
import type { ProjectShareRepository } from "./ports/project-share-repository";
import type { ProjectStorage } from "./project-storage";
import { shareGrantState, type ProjectShareGrant } from "../domain/project/share-grant";

const lifetimeMs = 30 * 24 * 60 * 60 * 1000;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const tokenParts = (token: string) => /^sdshare_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
const managed = (grant: ProjectShareGrant) => ({ id: grant.id, projectId: grant.projectId, createdByUserId: grant.createdByUserId, createdAt: grant.createdAt, expiresAt: grant.expiresAt, revokedAt: grant.revokedAt, revokedByUserId: grant.revokedByUserId });

export interface PublicSharedProject {
  project: { name: string };
  resources: Array<{ id: string; path: string; type: string; title?: string; description?: string; content: string }>;
}

export function createProjectShareService(options: {
  shares: ProjectShareRepository;
  projects: ProjectRepository;
  storage: (projectId: string) => ProjectStorage;
  now?: () => Date;
  newId?: () => string;
}) {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const requireOwner = async (context: ApplicationContext, projectId: string) => {
    if (!(await options.projects.findById(projectId))) throw notFound("No project with that id.");
    if ((await options.projects.roleOf(projectId, context.principal.subjectUserId)) !== "OWNER") throw forbidden("Project owner access is required.");
  };
  const audit = (context: ApplicationContext, action: AuditEvent["action"], projectId: string, grantId: string, expiresAt?: Date): AuditEvent => ({
    action, subjectUserId: context.principal.subjectUserId, actorType: "user", actorId: context.principal.subjectUserId,
    authType: context.principal.authType, projectId, requestId: context.requestId,
    detail: { grantId, ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}) },
  });
  return {
    async create(context: ApplicationContext, projectId: string, expiresAt?: Date) {
      await requireOwner(context, projectId);
      const createdAt = now();
      const expiry = expiresAt ?? new Date(createdAt.getTime() + lifetimeMs);
      if (!(expiry > createdAt)) throw conflict("Share expiration must be in the future.");
      const id = newId();
      const token = `sdshare_${id}.${randomBytes(32).toString("base64url")}`;
      const grant: ProjectShareGrant = { id, projectId, tokenHash: digest(token), createdByUserId: context.principal.subjectUserId, createdAt, expiresAt: expiry, revokedAt: null, revokedByUserId: null };
      const stored = await options.shares.create(grant, audit(context, "project.share.created", projectId, id, expiry));
      return { grant: managed(stored), token };
    },
    async list(context: ApplicationContext, projectId: string) {
      await requireOwner(context, projectId);
      return (await options.shares.list(projectId)).map(grant => ({ ...managed(grant), state: shareGrantState(grant, now()) }));
    },
    async revoke(context: ApplicationContext, projectId: string, id: string) {
      await requireOwner(context, projectId);
      const grant = await options.shares.find(id);
      if (!grant || grant.projectId !== projectId) throw notFound("No share grant found.");
      if (shareGrantState(grant, now()) !== "ACTIVE") throw conflict("Only an active share grant can be revoked.");
      await options.shares.revoke(id, context.principal.subjectUserId, audit(context, "project.share.revoked", projectId, id));
    },
    async read(token: string): Promise<PublicSharedProject | null> {
      const match = tokenParts(token);
      if (!match) return null;
      const grant = await options.shares.findByToken(match[1], digest(token));
      if (!grant || shareGrantState(grant, now()) !== "ACTIVE") return null;
      const project = await options.projects.findById(grant.projectId);
      if (!project) return null;
      const records = await options.projects.listResources(project.id, null);
      const storage = options.storage(project.id);
      const resources = await Promise.all(records.filter(resource => resource.lifecycle === "ACTIVE" && resource.contextId === undefined).map(async resource => {
        const stored = await storage.read(resource.path);
        if (!stored.ok || !stored.value) return null;
        const metadata = resource.metadata;
        return { id: resource.id, path: resource.path, type: resource.type, ...(metadata?.description ? { description: metadata.description } : {}), content: stored.value.content };
      }));
      return { project: { name: project.name }, resources: resources.filter((item): item is NonNullable<typeof item> => item !== null) };
    },
  };
}
