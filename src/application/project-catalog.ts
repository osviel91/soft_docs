/**
 * The project catalog: server-mode use cases over projects and resources.
 *
 * The server counterpart of "open a project and edit it". It owns the operations
 * that need the database and the project volume together — create a project and
 * its storage directory, list a user's projects with their roles, add a member,
 * rename a resource and keep its record in step — and it is the layer both the
 * HTTP API and the remote MCP server call.
 *
 * Authorization is enforced *here*, not in a controller and not in a tool: the
 * methods take an {@link ApplicationContext} and resolve the caller's role from
 * membership before doing anything. That is what makes it impossible for an MCP
 * tool to reach a project its principal cannot see, however the tool is invoked.
 *
 * Failures are {@link ApplicationError}s with transport-neutral codes, so the
 * API maps `not_found` to a 404 and the MCP adapter maps it to a tool error
 * without either re-deciding what happened.
 */
import type { ApplicationContext } from "./context";
import { actorIdOf, actorTypeOf, credentialIdOf } from "./context";
import { ApplicationError, conflict, forbidden, invalid, notFound } from "./errors";
import type {
  ProjectListing,
  ServerProject,
} from "../domain/project/server-project";
import { slugify } from "../domain/project/server-project";
import type { Permission, ProjectRole } from "../domain/access/permissions";
import {
  createAuthorizationPolicy,
  credentialGrants,
  grantedPermissions,
  restrictionOf,
  type AuthorizationPolicy,
} from "./authorization";
import type {
  ProjectRepository,
  ResourceRecord,
} from "./ports/project-repository";
import type { ProjectStorage } from "./project-storage";
import { InvalidResourcePathError } from "./ports/resource-path";
import type { AuditAction, AuditRepository } from "./ports/audit-repository";
import type { WorkspaceOperationRepository } from "./ports/workspace-operation-repository";
import type { WorkspaceRepository } from "./ports/workspace-repository";
import {
  createWorkspaceMutationService,
  type ResourceView,
  type WorkspaceMutationService,
} from "./workspace-mutations";
import type { JsonObject } from "../shared/json/json-value";
import type { ResourceMetadata } from "../domain/workspace/resource-metadata";
import type { ResourceRelationship } from "../domain/workspace/resource-relationship";
import {
  createEmptyMetadata,
  parseProjectMetadata,
  type ProjectMetadata,
  type SemanticMessageIdentity,
} from "../domain/workspace/metadata";
import { validateResourceRelationship } from "../domain/workspace/resource-relationship";
import { isOk } from "../shared/result/result";
import { defaultIdFactory } from "../shared/ids/ids";
import type { KnowledgeContextRepository } from "./ports/knowledge-context-repository";
import type { PrivateWorkContext } from "../domain/workspace/knowledge-context";
import type { ArchitecturalProposalRepository } from "./ports/architectural-proposal-repository";
import type { SemanticBinding, EntityAnchor } from "../domain/workspace/semantic-binding";
import { entityAnchorKey, validateSemanticBinding } from "../domain/workspace/semantic-binding";
import type { SemanticBindingRepository } from "./ports/semantic-binding-repository";
import { analyzeResource } from "../domain/project/resource-analysis";
import { buildProjectIndex } from "../domain/project/project-index";

/**
 * A resource as the API and MCP surface it: identity, path, type, revision.
 *
 * Structurally the mutation service's {@link ResourceView}; named here because
 * this is the vocabulary every host already imports.
 */
export type CatalogResource = ResourceView;

/**
 * How to open a project's storage.
 *
 * The catalog never builds a filesystem path from a request: it asks this
 * factory for the store belonging to a project *it has already authorized*, and
 * the factory decides where that project lives (a volume today, an object store
 * later). No caller can pass a path in.
 */
export type ProjectStorageFactory = (projectId: string, contextId?: string | null) => ProjectStorage;

/** What the catalog needs to run. */
export interface ProjectCatalogOptions {
  projects: ProjectRepository;
  workspaces: WorkspaceRepository;
  storage: ProjectStorageFactory;
  audit?: AuditRepository;
  /**
   * The durable operation journal every resource mutation commits through.
   *
   * Supplying it is what turns a mutation into the durable sequence — claim the
   * revision, journal the intent, promote the staged bytes, settle — rather than
   * a check followed by a write. A test or a host that omits it gets a service
   * that refuses resource mutations rather than one that silently falls back to
   * the racy path.
   */
  operations?: WorkspaceOperationRepository;
  /** A pre-built mutation service, for a host that shares one with its provider. */
  mutations?: WorkspaceMutationService;
  knowledgeContexts?: KnowledgeContextRepository;
  architecturalProposals?: ArchitecturalProposalRepository;
  semanticBindings?: SemanticBindingRepository;
  /** Content digest for the journal's staging verification. */
  hashContent?: (content: string) => string;
  /**
   * The authorization policy. Injectable so a test can prove a use case refuses
   * when the policy does — and so a different deployment can supply a different
   * policy without any use case changing.
   */
  policy?: AuthorizationPolicy<ServerProject>;
  /**
   * Called when an audit entry could not be written.
   *
   * Project and membership mutations still write their audit entry after the
   * change, because their whole change is one database transaction that the
   * audit row cannot join through this port. Resource mutations no longer take
   * this path at all: their audit row commits *with* the change, inside the
   * operation journal's transaction.
   */
  onAuditFailure?: (error: unknown, event: AuditFailureContext) => void;
}

/** What a failed audit write was trying to record. */
export interface AuditFailureContext {
  action: AuditAction;
  subjectUserId: string;
  projectId: string | null;
  resourceId: string | null;
  requestId: string;
}

/** The default reporter: one line on stderr, with the correlation id. */
function reportAuditFailure(error: unknown, event: AuditFailureContext): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${event.requestId} audit ${event.action} failed: ${message}\n`,
  );
}

/** The server project use cases. */
export interface ProjectCatalog {
  /** Every project the caller is a member of, newest first. */
  listProjects(
    context: ApplicationContext,
    workspaceId: string,
  ): Promise<ProjectListing[]>;

  /** The caller's default workspace, for hosts without a workspace selector. */
  defaultWorkspaceId(context: ApplicationContext): Promise<string>;

  /** One project and the caller's role in it. */
  getProject(
    context: ApplicationContext,
    projectId: string,
  ): Promise<ProjectListing>;

  /** Create a project, its membership and its storage directory. */
  createProject(
    context: ApplicationContext,
    input: { name: string; workspaceId: string; slug?: string },
  ): Promise<ProjectListing>;

  /**
   * What the caller may do in this project.
   *
   * A browser needs this to render the right affordances, and an agent uses it
   * to decide whether a write is worth attempting. It is *advisory*: every
   * operation re-checks, so a stale or forged answer here grants nothing.
   */
  describeAccess(
    context: ApplicationContext,
    projectId: string,
  ): Promise<{
    projectId: string;
    role: ProjectRole;
    permissions: readonly Permission[];
  }>;

  /**
   * Whether the caller may perform `permission` in this project.
   *
   * The non-throwing form of the same decision every use case makes, for an
   * adapter that must ask *before* it offers an operation rather than after it
   * fails — the server workspace provider uses it to make a read-only caller's
   * repository genuinely read-only, so a write cannot slip past the policy by
   * arriving through the shared documentation service instead of the catalog.
   */
  can(
    context: ApplicationContext,
    projectId: string,
    permission: Permission,
  ): Promise<boolean>;

  /** Rename a project, or change its slug. */
  updateProject(
    context: ApplicationContext,
    projectId: string,
    changes: { name?: string; slug?: string },
  ): Promise<ServerProject>;

  /** Delete a project and everything it holds. */
  deleteProject(context: ApplicationContext, projectId: string): Promise<void>;

  /** Add a member or change a member's role. */
  setMember(
    context: ApplicationContext,
    projectId: string,
    userId: string,
    role: ProjectRole,
  ): Promise<void>;

  /** Remove a member. */
  removeMember(
    context: ApplicationContext,
    projectId: string,
    userId: string,
  ): Promise<void>;

  /** Transfer ownership to an active member; only a workspace ADMIN may do so. */
  transferOwnership(context: ApplicationContext, projectId: string, userId: string): Promise<void>;

  /** Every resource a project records. */
  listResources(
    context: ApplicationContext,
    projectId: string,
    contextId?: string | null,
  ): Promise<CatalogResource[]>;
  listEffectiveResources(context: ApplicationContext, projectId: string, contextId: string): Promise<CatalogResource[]>;
  listPrivateWorkContexts(context: ApplicationContext, projectId: string): Promise<PrivateWorkContext[]>;
  createPrivateWorkContext(context: ApplicationContext, projectId: string, input: { name: string; description?: string }): Promise<PrivateWorkContext>;
  updatePrivateWorkContext(context: ApplicationContext, projectId: string, contextId: string, input: { name?: string; description?: string; lifecycle?: "active" | "archived" }): Promise<PrivateWorkContext>;
  deletePrivateWorkContext(context: ApplicationContext, projectId: string, contextId: string): Promise<void>;
  listResourceRelationships(
    context: ApplicationContext,
    projectId: string,
    contextId?: string | null,
  ): Promise<ResourceRelationship[]>;
  createResourceRelationship(
    context: ApplicationContext,
    projectId: string,
    relationship: ResourceRelationship,
    contextId?: string | null,
  ): Promise<ResourceRelationship>;

  listSemanticMessages(
    context: ApplicationContext,
    projectId: string,
    contextId?: string | null,
  ): Promise<SemanticMessageIdentity[]>;
  createSemanticMessage(
    context: ApplicationContext,
    projectId: string,
    input: { name: string; kind: "event" | "command" },
    contextId?: string | null,
  ): Promise<{ message: SemanticMessageIdentity; manifestRevision: number }>;
  updateSemanticMessages(
    context: ApplicationContext,
    projectId: string,
    messages: SemanticMessageIdentity[],
    expectedManifestRevision: number,
  ): Promise<{ messages: SemanticMessageIdentity[]; manifestRevision: number }>;
  updatePrivateSemanticMessages(context: ApplicationContext, projectId: string, contextId: string, messages: SemanticMessageIdentity[]): Promise<SemanticMessageIdentity[]>;
  listSemanticBindings(context: ApplicationContext, projectId: string, contextId?: string | null): Promise<SemanticBinding[]>;
  getSemanticBinding(context: ApplicationContext, projectId: string, contextId: string | null, id: string): Promise<SemanticBinding>;
  createSemanticBinding(context: ApplicationContext, projectId: string, contextId: string, binding: Omit<SemanticBinding, "projectId" | "revision" | "status" | "provenance">): Promise<SemanticBinding>;
  updateSemanticBinding(context: ApplicationContext, projectId: string, contextId: string, binding: SemanticBinding, expectedRevision: number): Promise<SemanticBinding>;
  removeSemanticBinding(context: ApplicationContext, projectId: string, contextId: string, id: string, expectedRevision: number): Promise<SemanticBinding>;

  /** One resource's record. */
  getResource(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
    contextId?: string | null,
  ): Promise<CatalogResource>;

  /** Read a resource's text. */
  readResource(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
    contextId?: string | null,
  ): Promise<{ resource: CatalogResource; content: string }>;

  /**
   * Create a resource, refusing a path that is already taken.
   *
   * `idempotencyKey` is optional; when present, a retry with the same key by the
   * same actor in the same project returns the first result instead of creating a
   * second resource.
   */
  createResource(
    context: ApplicationContext,
    projectId: string,
    input: {
      path: string;
      type: ResourceRecord["type"];
      content: string;
      metadata?: ResourceMetadata;
      contextId?: string | null;
      idempotencyKey?: string;
    },
  ): Promise<CatalogResource>;

  /**
   * Replace a resource's text.
   *
   * `expectedRevision` is required: a write that does not say which revision it
   * read is refused rather than allowed to overwrite a concurrent change.
   */
  updateResource(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
    input: {
      content: string;
      expectedRevision: number;
      metadata?: ResourceMetadata;
      contextId?: string | null;
      idempotencyKey?: string;
    },
  ): Promise<CatalogResource>;

  /** Move a resource to another path, keeping its id. */
  moveResource(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
    input: {
      path: string;
      expectedRevision: number;
      contextId?: string | null;
      idempotencyKey?: string;
    },
  ): Promise<CatalogResource>;

  /** Delete a resource's file and its record. */
  deleteResource(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
    input?: { expectedRevision?: number; contextId?: string | null; idempotencyKey?: string },
  ): Promise<void>;
}

/**
 * Run a path-addressed operation, reporting a refused path as `invalid`.
 *
 * The path boundary throws (`InvalidResourcePathError`) rather than returning a
 * `Result`, because a traversal attempt is a programming or hostile input error,
 * not a value a caller branches on. Translating it here is what keeps that
 * detail out of every transport.
 *
 * Resource mutations now take this path inside the mutation service; this
 * re-export keeps the translation available to the project-level use cases that
 * still run here.
 */
export async function withPath<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof InvalidResourcePathError) {
      // The `kind` is machine-readable on purpose: a transport can tell "this
      // path is not allowed" from an ordinary validation failure without
      // parsing an English message, and an MCP agent can act on it.
      throw invalid(error.message, { kind: "invalid_path" });
    }
    throw error;
  }
}

/** Map a resource row onto the catalog's view. */
function toCatalogResource(record: ResourceRecord): CatalogResource {
  return {
    id: record.id,
    projectId: record.projectId,
    path: record.path,
    type: record.type,
    revision: record.revision,
    ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
  };
}

/** Build the project catalog over a repository, storage factory and audit log. */
export function createProjectCatalog(
  options: ProjectCatalogOptions,
): ProjectCatalog {
  const { projects, workspaces, storage, audit } = options;
  const knowledgeContexts = options.knowledgeContexts;
  const architecturalProposals = options.architecturalProposals;
  const policy =
    options.policy ?? createAuthorizationPolicy<ServerProject>(projects);

  /**
   * The one authoritative resource-mutation path.
   *
   * A host may inject a pre-built service so the catalog and the documentation
   * provider cannot end up with two; otherwise it is built here from the same
   * repositories. A host that supplies neither gets a catalog that refuses
   * resource mutations loudly rather than a second, racy implementation.
   */
  const mutations: WorkspaceMutationService | null =
    options.mutations ??
    (options.operations === undefined
      ? null
      : createWorkspaceMutationService({
          projects,
          storage,
          operations: options.operations,
          policy,
          ...(options.hashContent === undefined
            ? {}
            : { hashContent: options.hashContent }),
        }));

  /** The mutation service, or a refusal that names the misconfiguration. */
  const requireMutations = (): WorkspaceMutationService => {
    if (mutations === null) {
      throw new ApplicationError(
        "internal",
        "This deployment has no workspace operation journal, so resource mutations are disabled.",
      );
    }
    return mutations;
  };

  /**
   * Authorize an operation, then hand back the project it acted on.
   *
   * The permission is named, not a role list: the mapping from role to
   * capability lives in `src/domain/access/permissions.ts` and is applied by the
   * policy, so a use case never asks "is this user an editor?".
   */
  const requirePermission = async (
    context: ApplicationContext,
    projectId: string,
    permission: Permission,
  ): Promise<{ project: ServerProject; role: ProjectRole }> => {
    const grant = await policy.requirePermission(
      context,
      projectId,
      permission,
    );
    // The policy resolved the project on the way to its decision, so there is no
    // second read here and no window in which the row could change underneath it.
    const workspaceRole = await workspaces.roleOf(
      grant.project.workspaceId,
      context.principal.subjectUserId,
    );
    if (workspaceRole === null) {
      throw notFound(`No project with id ${projectId}.`);
    }
    return { project: grant.project, role: grant.role };
  };

  const requireWorkspaceMember = async (
    context: ApplicationContext,
    workspaceId: string,
  ): Promise<void> => {
    const role = await workspaces.roleOf(
      workspaceId,
      context.principal.subjectUserId,
    );
    if (role === null) throw notFound(`No workspace with id ${workspaceId}.`);
  };

  const requirePrivateContext = async (context: ApplicationContext, projectId: string, contextId: string): Promise<PrivateWorkContext> => {
    await requirePermission(context, projectId, "project:read");
    if (!knowledgeContexts) throw new ApplicationError("internal", "Private work contexts are unavailable.");
    const found = await knowledgeContexts.findPrivate(projectId, contextId, context.principal.subjectUserId);
    if (!found) throw notFound(`No private work context with id ${contextId}.`);
    return found;
  };

  const readManifest = async (
    projectId: string,
  ): Promise<ProjectMetadata & { raw: string | null }> => {
    const stored = await storage(projectId).read("project.json");
    if (!isOk(stored)) throw new ApplicationError("internal", stored.error.message);
    const raw = stored.value?.content ?? null;
    if (raw === null) return { ...createEmptyMetadata(), raw };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new ApplicationError("invalid", "The project manifest is not valid JSON."); }
    return { ...(parseProjectMetadata(parsed) ?? createEmptyMetadata()), raw };
  };

  const requireBindingEndpoints = async (projectId: string, contextId: string, anchors: EntityAnchor[]): Promise<void> => {
    const [shared, privateResources] = await Promise.all([projects.listResources(projectId, null), projects.listResources(projectId, contextId)]);
    const effective = new Map(shared.map((resource) => [resource.id, resource]));
    privateResources.forEach((resource) => effective.set(resource.id, resource));
    const files = await Promise.all([...effective.values()].map(async (resource) => {
      const revision = await projects.getRevision(resource.id, resource.revision);
      return revision ? analyzeResource({ id: resource.id, projectId, path: resource.path, type: resource.type, title: resource.path }, revision.content) : null;
    }));
    const index = buildProjectIndex(projectId, files.filter((file): file is NonNullable<typeof file> => file !== null), createEmptyMetadata(), () => []);
    const indexed = new Set((index.entities ?? []).map((entity) => entityAnchorKey(entity.anchor)));
    if (anchors.some((anchor) => !indexed.has(entityAnchorKey(anchor)))) throw invalid("Both semantic binding endpoints must resolve exactly in effective project resources.");
  };

  const writeAudit = async (
    context: ApplicationContext,
    event: {
      action: AuditAction;
      projectId?: string;
      resourceId?: string;
      detail?: JsonObject;
    },
  ): Promise<void> => {
    if (!audit) return;
    const failureContext: AuditFailureContext = {
      action: event.action,
      subjectUserId: context.principal.subjectUserId,
      projectId: event.projectId ?? null,
      resourceId: event.resourceId ?? null,
      requestId: context.requestId,
    };
    try {
      await audit.record({
        action: event.action,
        // The subject is the user whose authority bounded the request; the
        // actor is who actually asked. For a session they coincide; for an
        // agent credential they differ, and the trail must show both.
        subjectUserId: context.principal.subjectUserId,
        actorType: actorTypeOf(context.principal),
        actorId: actorIdOf(context.principal),
        credentialId: credentialIdOf(context.principal),
        authType: context.principal.authType,
        projectId: event.projectId ?? null,
        resourceId: event.resourceId ?? null,
        requestId: context.requestId,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
      });
    } catch (error) {
      // The mutation has already committed. Reporting a failure here would be
      // false, and swallowing it silently would hide a compliance problem, so it
      // is reported and the successful mutation stands.
      (options.onAuditFailure ?? reportAuditFailure)(error, failureContext);
    }
  };

  return {
    async listProjects(context, workspaceId) {
      await requireWorkspaceMember(context, workspaceId);
      const listings = await projects.listForUser(
        context.principal.subjectUserId,
        workspaceId,
      );
      const restricted = restrictionOf(context.principal);
      if (restricted === null) return listings;
      return listings.filter((entry) => restricted.includes(entry.project.id));
    },

    async defaultWorkspaceId(context) {
      const workspace = (
        await workspaces.listForUser(context.principal.subjectUserId)
      ).find((entry) => entry.isDefault);
      if (!workspace) throw notFound("No default workspace is available.");
      return workspace.id;
    },

    async getProject(context, projectId) {
      const { project, role } = await requirePermission(
        context,
        projectId,
        "project:read",
      );
      const listing = (
        await projects.listForUser(
          context.principal.subjectUserId,
          project.workspaceId,
        )
      ).find((entry) => entry.project.id === project.id);
      return {
        project,
        role,
        resourceCount: listing?.resourceCount ?? 0,
      };
    },

    async describeAccess(context, projectId) {
      const { role } = await requirePermission(
        context,
        projectId,
        "project:read",
      );
      // Both grants are reported, not just the role's: a read-only agent token
      // whose user happens to own the project must not be told it may write.
      const permissions = grantedPermissions(role).filter((permission) =>
        credentialGrants(context.principal, permission),
      );
      return { projectId, role, permissions };
    },

    async can(context, projectId, permission) {
      const outcome = await policy.decide(context, projectId, permission);
      return outcome.allowed;
    },

    async createProject(context, input) {
      // There is no project to resolve a role in yet, so the credential's own
      // capability is the whole check. A session carries the full vocabulary; a
      // read-only machine token does not, which keeps project creation a
      // privileged act.
      if (!credentialGrants(context.principal, "project:create")) {
        throw forbidden(
          "This credential does not carry the project:create permission.",
        );
      }
      const name = input.name.trim();
      if (name === "") throw invalid("A project name is required.");
      await requireWorkspaceMember(context, input.workspaceId);
      const project = await projects.create({
        ownerId: context.principal.subjectUserId,
        workspaceId: input.workspaceId,
        name,
        ...(input.slug === undefined ? {} : { slug: input.slug }),
      });
      // Materialise the storage directory immediately, so the project is a real
      // place to write before the first resource exists.
      await storage(project.id).list();
      await writeAudit(context, {
        action: "project.created",
        projectId: project.id,
      });
      return { project, role: "OWNER", resourceCount: 0 };
    },

    async updateProject(context, projectId, changes) {
      await requirePermission(context, projectId, "project:update");
      if (
        changes.slug !== undefined &&
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(changes.slug)
      ) {
        throw invalid(
          "A slug must be lower-case letters, digits and single hyphens.",
        );
      }
      const updated = await projects.update(projectId, changes);
      await writeAudit(context, {
        action: "project.updated",
        projectId: projectId,
      });
      return updated;
    },

    async deleteProject(context, projectId) {
      await requirePermission(context, projectId, "project:delete");
      // The database cascades members and resource rows; the files are removed
      // explicitly, because a volume is not part of a transaction.
      const store = storage(projectId);
      const listed = await store.list();
      if (listed.ok) {
        for (const resource of listed.value) await store.remove(resource.path);
      }
      await projects.delete(projectId);
      await writeAudit(context, {
        action: "project.deleted",
        projectId: projectId,
      });
    },

    async setMember(context, projectId, userId, role) {
      await requirePermission(context, projectId, "project:members:write");
      await projects.setMember(projectId, userId, role);
      await writeAudit(context, {
        action: "project.member.added",
        projectId: projectId,
      });
    },

    async removeMember(context, projectId, userId) {
      const { project } = await requirePermission(
        context,
        projectId,
        "project:members:write",
      );
      if (project.ownerId === userId) {
        throw invalid(
          "The project owner cannot be removed. Transfer ownership first.",
        );
      }
      await projects.removeMember(projectId, userId);
      await writeAudit(context, {
        action: "project.member.removed",
        projectId: projectId,
      });
    },

    async transferOwnership(context, projectId, userId) {
      const { project } = await requirePermission(context, projectId, "project:read");
      if (!credentialGrants(context.principal, "project:members:write")) {
        throw forbidden("This credential does not carry the project:members:write permission.");
      }
      if (userId === project.ownerId) throw invalid("The selected user already owns this project.");
      const workspaceRole = await workspaces.roleOf(project.workspaceId, context.principal.subjectUserId);
      if (workspaceRole !== "ADMIN") throw forbidden("Only a workspace ADMIN may transfer project ownership.");
      const transferred = await projects.transferOwnership(projectId, userId);
      if (!transferred) throw invalid("The new owner must be an active member of this workspace.");
      await writeAudit(context, {
        action: "project.owner.transferred",
        projectId,
        detail: { previousOwnerId: project.ownerId, newOwnerId: userId },
      });
    },

    async listResources(context, projectId, contextId = null) {
      await requirePermission(context, projectId, "resource:read");
      if (contextId !== null) await requirePrivateContext(context, projectId, contextId);
      const records = await projects.listResources(projectId, contextId);
      return records.map(toCatalogResource);
    },

    async listEffectiveResources(context, projectId, contextId) {
      await requirePrivateContext(context, projectId, contextId);
      const [shared, privateResources] = await Promise.all([
        projects.listResources(projectId, null),
        projects.listResources(projectId, contextId),
      ]);
      return [...shared, ...privateResources].map(toCatalogResource);
    },

    async listPrivateWorkContexts(context, projectId) {
      await requirePermission(context, projectId, "project:read");
      if (!knowledgeContexts) throw new ApplicationError("internal", "Private work contexts are unavailable.");
      return knowledgeContexts.listPrivate(projectId, context.principal.subjectUserId);
    },

    async createPrivateWorkContext(context, projectId, input) {
      await requirePermission(context, projectId, "project:read");
      if (!knowledgeContexts) throw new ApplicationError("internal", "Private work contexts are unavailable.");
      const created = await knowledgeContexts.createPrivate({ projectId, ownerUserId: context.principal.subjectUserId, ...input });
      await storage(projectId, created.id).list();
      return created;
    },

    async updatePrivateWorkContext(context, projectId, contextId, input) {
      await requirePrivateContext(context, projectId, contextId);
      return knowledgeContexts!.updatePrivate(contextId, context.principal.subjectUserId, input);
    },

    async deletePrivateWorkContext(context, projectId, contextId) {
      await requirePrivateContext(context, projectId, contextId);
      if (architecturalProposals && await architecturalProposals.hasForContext(projectId, contextId)) {
        throw invalid("Private work cannot be deleted while it is the source of a submitted Architectural Proposal.");
      }
      const store = storage(projectId, contextId);
      const listed = await store.list();
      if (listed.ok) for (const resource of listed.value) await store.remove(resource.path);
      await knowledgeContexts!.deletePrivate(contextId, context.principal.subjectUserId);
    },

    async listResourceRelationships(context, projectId, contextId = null) {
      await requirePermission(context, projectId, "resource:read");
      if (contextId !== null) await requirePrivateContext(context, projectId, contextId);
      return projects.listResourceRelationships(projectId, contextId);
    },

    async createResourceRelationship(context, projectId, relationship, contextId = null) {
      await requirePermission(context, projectId, "resource:update");
      if (contextId === null) throw invalid("Authoritative relationships can only be changed through proposal promotion.", { reason: "authoritative_context" });
      await requirePrivateContext(context, projectId, contextId);
      const resources = [...await projects.listResources(projectId, null), ...await projects.listResources(projectId, contextId)];
      try {
        return await projects.createResourceRelationship(
          projectId,
          validateResourceRelationship({ ...relationship, contextId }, resources),
        );
      } catch (error) {
        if (error instanceof Error && error.message === "Both relationship resources must exist.") {
          throw notFound(error.message);
        }
        throw invalid(error instanceof Error ? error.message : "Invalid resource relationship.");
      }
      },

    async listSemanticMessages(context, projectId, contextId = null) {
      await requirePermission(context, projectId, "project:read");
      if (contextId !== null) {
        await requirePrivateContext(context, projectId, contextId);
        return knowledgeContexts!.listPrivateMessages(projectId, contextId);
      }
      const metadata = await readManifest(projectId);
      return metadata.semanticMessages ?? [];
    },

    async createSemanticMessage(context, projectId, input, contextId = null) {
      await requirePermission(context, projectId, "project:update");
      if (contextId === null) throw invalid("Authoritative semantic identities can only be changed through proposal promotion.", { reason: "authoritative_context" });
      await requirePrivateContext(context, projectId, contextId);
      let id = defaultIdFactory();
      const existing = await knowledgeContexts!.listPrivateMessages(projectId, contextId);
      while (existing.some((message) => message.id === id)) id = defaultIdFactory();
      const message = await knowledgeContexts!.createPrivateMessage({ projectId, contextId, id, ...input });
      return { message, manifestRevision: 0 };
    },

    async updateSemanticMessages(context, projectId, _messages, _expectedManifestRevision) {
      void _messages;
      void _expectedManifestRevision;
      await requirePermission(context, projectId, "project:update");
      throw invalid("The authoritative semantic manifest can only be changed through proposal promotion.", { reason: "authoritative_context" });
    },

    async updatePrivateSemanticMessages(context, projectId, contextId, messages) {
      await requirePrivateContext(context, projectId, contextId);
      return knowledgeContexts!.updatePrivateMessages(projectId, contextId, messages);
    },

    async listSemanticBindings(context, projectId, contextId = null) {
      await requirePermission(context, projectId, "project:read");
      if (!options.semanticBindings) throw new ApplicationError("internal", "Semantic bindings are unavailable.");
      if (contextId === null) return options.semanticBindings.list({ projectId, contextId: null });
      await requirePrivateContext(context, projectId, contextId);
      const [shared, privateBindings] = await Promise.all([
        options.semanticBindings.list({ projectId, contextId: null }),
        options.semanticBindings.list({ projectId, contextId }),
      ]);
      const effective = new Map(shared.map((binding) => [binding.id, binding]));
      privateBindings.forEach((binding) => effective.set(binding.id, binding));
      return [...effective.values()].sort((a, b) => a.id.localeCompare(b.id));
    },

    async getSemanticBinding(context, projectId, contextId, id) {
      await requirePermission(context, projectId, "project:read");
      if (!options.semanticBindings) throw new ApplicationError("internal", "Semantic bindings are unavailable.");
      if (contextId !== null) await requirePrivateContext(context, projectId, contextId);
      const binding = (contextId === null ? null : await options.semanticBindings.get({ projectId, contextId }, id)) ?? await options.semanticBindings.get({ projectId, contextId: null }, id);
      if (!binding) throw notFound(`No semantic binding with id ${id}.`);
      return binding;
    },

    async createSemanticBinding(context, projectId, contextId, input) {
      await requirePermission(context, projectId, "resource:update");
      if (!options.semanticBindings) throw new ApplicationError("internal", "Semantic bindings are unavailable.");
      if (!contextId) throw invalid("Semantic bindings cannot be written directly to SHARED.", { reason: "authoritative_context" });
      await requirePrivateContext(context, projectId, contextId);
      const binding: SemanticBinding = { ...input, projectId, revision: 1, status: "ACTIVE", provenance: { authorId: context.principal.subjectUserId, contextId, createdAt: new Date().toISOString() } };
      try { validateSemanticBinding(binding); } catch (error) { throw invalid(error instanceof Error ? error.message : "Invalid semantic binding."); }
      await requireBindingEndpoints(projectId, contextId, [binding.left, binding.right]);
      let created: SemanticBinding;
      try { created = await options.semanticBindings.create(binding); } catch (error) { throw conflict(error instanceof Error ? error.message : "Semantic binding creation conflicted."); }
      await writeAudit(context, { action: "resource.updated", projectId, resourceId: binding.left.resourceId, detail: { kind: "semantic-binding.created", bindingId: binding.id, contextId } });
      return created;
    },

    async updateSemanticBinding(context, projectId, contextId, input, expectedRevision) {
      await requirePermission(context, projectId, "resource:update");
      if (!options.semanticBindings) throw new ApplicationError("internal", "Semantic bindings are unavailable.");
      if (!contextId) throw invalid("Semantic bindings cannot be written directly to SHARED.", { reason: "authoritative_context" });
      await requirePrivateContext(context, projectId, contextId);
      const binding = { ...input, projectId, revision: expectedRevision + 1, provenance: { authorId: context.principal.subjectUserId, contextId, createdAt: input.provenance.createdAt } };
      try { validateSemanticBinding(binding); } catch (error) { throw invalid(error instanceof Error ? error.message : "Invalid semantic binding."); }
      await requireBindingEndpoints(projectId, contextId, [binding.left, binding.right]);
      let updated: SemanticBinding;
      try { updated = await options.semanticBindings.update({ projectId, contextId }, binding, expectedRevision); } catch (error) { throw conflict(error instanceof Error ? error.message : "Semantic binding update conflicted."); }
      await writeAudit(context, { action: "resource.updated", projectId, resourceId: binding.left.resourceId, detail: { kind: "semantic-binding.updated", bindingId: binding.id, contextId, expectedRevision } });
      return updated;
    },

    async removeSemanticBinding(context, projectId, contextId, id, expectedRevision) {
      await requirePermission(context, projectId, "resource:update");
      if (!options.semanticBindings) throw new ApplicationError("internal", "Semantic bindings are unavailable.");
      if (!contextId) throw invalid("Semantic bindings cannot be written directly to SHARED.", { reason: "authoritative_context" });
      await requirePrivateContext(context, projectId, contextId);
      let removed: SemanticBinding;
      try { removed = await options.semanticBindings.remove({ projectId, contextId }, id, expectedRevision); } catch (error) { throw conflict(error instanceof Error ? error.message : "Semantic binding removal conflicted."); }
      await writeAudit(context, { action: "resource.updated", projectId, resourceId: removed.left.resourceId, detail: { kind: "semantic-binding.removed", bindingId: id, contextId, expectedRevision } });
      return removed;
    },

    async getResource(context, projectId, resourceId, contextId = null) {
      await requirePermission(context, projectId, "resource:read");
      if (contextId !== null) await requirePrivateContext(context, projectId, contextId);
      const record = await projects.findResource(projectId, resourceId, contextId);
      if (!record) throw notFound(`No resource with id ${resourceId}.`);
      return toCatalogResource(record);
    },

    async readResource(context, projectId, resourceId, contextId = null) {
      await requirePermission(context, projectId, "resource:read");
      if (contextId !== null) await requirePrivateContext(context, projectId, contextId);
      const record = await projects.findResource(projectId, resourceId, contextId);
      if (!record) throw notFound(`No resource with id ${resourceId}.`);
      const read = await storage(projectId, contextId).read(record.path);
      if (!read.ok) throw read.error;
      if (read.value === null) {
        throw notFound(
          `Resource ${resourceId} is recorded at "${record.path}" but its file is missing.`,
        );
      }
      return {
        resource: toCatalogResource(record),
        content: read.value.content,
      };
    },

    /**
     * Create a resource through the one authoritative mutation path.
     *
     * Everything below this line — authorization, staging, the revision claim,
     * the durable journal record, the transactional audit row and the final
     * promote — lives in {@link createWorkspaceMutationService}, so the HTTP API,
     * the remote MCP tools and the shared documentation service all get the same
     * sequence rather than three near-copies of it.
     */
    async createResource(context, projectId, input) {
      await requirePermission(context, projectId, "resource:create");
      if (input.contextId === undefined || input.contextId === null) throw invalid("Authoritative resources can only be changed through proposal promotion.", { reason: "authoritative_context" });
      await requirePrivateContext(context, projectId, input.contextId);
      return requireMutations().createResource(context, projectId, input);
    },

    async updateResource(context, projectId, resourceId, input) {
      await requirePermission(context, projectId, "resource:update");
      if (input.contextId === undefined || input.contextId === null) throw invalid("Authoritative resources can only be changed through proposal promotion.", { reason: "authoritative_context" });
      await requirePrivateContext(context, projectId, input.contextId);
      return requireMutations().updateResource(
        context,
        projectId,
        resourceId,
        input,
      );
    },

    async moveResource(context, projectId, resourceId, input) {
      await requirePermission(context, projectId, "resource:update");
      if (input.contextId === undefined || input.contextId === null) throw invalid("Authoritative resources can only be changed through proposal promotion.", { reason: "authoritative_context" });
      await requirePrivateContext(context, projectId, input.contextId);
      return requireMutations().moveResource(
        context,
        projectId,
        resourceId,
        input,
      );
    },

    async deleteResource(context, projectId, resourceId, input) {
      await requirePermission(context, projectId, "resource:delete");
      if (input?.contextId === undefined || input.contextId === null) throw invalid("Authoritative resources can only be changed through proposal promotion.", { reason: "authoritative_context" });
      await requirePrivateContext(context, projectId, input.contextId);
      return requireMutations().deleteResource(
        context,
        projectId,
        resourceId,
        input ?? {},
      );
    },
  };
}

/** Export the slug rule so an API validator and the catalog agree. */
export { slugify };
