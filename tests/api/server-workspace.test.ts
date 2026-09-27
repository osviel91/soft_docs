// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentationWorkspace } from "../../mcp/workspace";
import { ALL_PERMISSIONS } from "../../src/domain/access/permissions";
import type { ApplicationContext } from "../../src/application/context";
import { createProjectCatalog } from "../../src/application/project-catalog";
import { createWorkspaceMutationService } from "../../src/application/workspace-mutations";
import { createAuditRepository } from "../../src/persistence/audit-repository";
import { createFsProjectStorage } from "../../src/persistence/fs-project-storage";
import { createKnowledgeContextRepository } from "../../src/persistence/knowledge-context-repository";
import { createProjectRepository } from "../../src/persistence/project-repository";
import { createServerWorkspaceProvider } from "../../src/persistence/server-workspace-provider";
import { hashWorkspaceContent } from "../../src/persistence/server-runtime";
import { createUserRepository } from "../../src/persistence/user-repository";
import { createWorkspaceOperationRepository } from "../../src/persistence/workspace-operation-repository";
import { createWorkspaceRepository } from "../../src/persistence/workspace-repository";
import { createEmptyMetadata } from "../../src/domain/workspace/metadata";
import type { ProjectRepository } from "../../src/persistence/project-repository";
import type { SqlClient } from "../../src/persistence/sql-client";
import { closeTestDatabase, openTestDatabase } from "../persistence/test-database";

let client: SqlClient;
let projects: ProjectRepository;
let users: ReturnType<typeof createUserRepository>;
let volume: string;

beforeAll(async () => {
  client = await openTestDatabase();
  volume = await mkdtemp(path.join(tmpdir(), "sd-server-workspace-"));
  projects = createProjectRepository(client);
  users = createUserRepository(client);
});

afterAll(async () => {
  await closeTestDatabase(client);
  await rm(volume, { recursive: true, force: true });
});

async function aContext(): Promise<ApplicationContext> {
  const user = await users.findOrCreateByExternalIdentity({
    issuer: "https://idp.test",
    subject: `subject-${Math.random().toString(36).slice(2)}`,
    displayName: "Server User",
    email: null,
  });
  return {
    requestId: "req-workspace",
    principal: {
      subjectUserId: user.id,
      actor: { kind: "user", userId: user.id },
      authType: "session",
      scopes: [...ALL_PERMISSIONS],
    },
  };
}

function storageFor(projectId: string, contextId?: string | null) {
  return createFsProjectStorage({
    root: path.join(volume, projectId, ...(contextId ? [".private", contextId] : [])),
  });
}

function serviceOver(context: ApplicationContext, contextId: string | null = null): DocumentationWorkspace {
  const operations = createWorkspaceOperationRepository(client);
  const mutations = createWorkspaceMutationService({
    projects,
    storage: storageFor,
    operations,
    hashContent: hashWorkspaceContent,
  });
  const catalog = createProjectCatalog({
    projects,
    workspaces: createWorkspaceRepository(client),
    audit: createAuditRepository(client),
    storage: storageFor,
    mutations,
    knowledgeContexts: createKnowledgeContextRepository(client),
  });
  const provider = createServerWorkspaceProvider({
    context,
    catalog,
    projects,
    mutations,
    contextId,
    location: (projectId, selectedContextId) => ({
      storage: storageFor(projectId, selectedContextId),
      root: path.join(volume, projectId, ...(selectedContextId ? [".private", selectedContextId] : [])),
    }),
  });
  return DocumentationWorkspace.over(provider);
}

async function aPrivateWorkspace(name: string) {
  const context = await aContext();
  const catalog = createProjectCatalog({
    projects,
    workspaces: createWorkspaceRepository(client),
    audit: createAuditRepository(client),
    storage: storageFor,
    mutations: createWorkspaceMutationService({
      projects,
      storage: storageFor,
      operations: createWorkspaceOperationRepository(client),
      hashContent: hashWorkspaceContent,
    }),
    knowledgeContexts: createKnowledgeContextRepository(client),
  });
  const listing = await catalog.createProject(context, {
    name,
    workspaceId: await catalog.defaultWorkspaceId(context),
  });
  const work = await catalog.createPrivateWorkContext(context, listing.project.id, { name: "test work" });
  return { context, project: { id: listing.project.id, name: listing.project.name, datasetIds: [] }, workspace: serviceOver(context, work.id), contextId: work.id };
}

describe("server workspace contexts", () => {
  it("reads authoritative SHARED data but rejects ordinary mutation", async () => {
    const context = await aContext();
    const catalog = createProjectCatalog({
      projects,
      workspaces: createWorkspaceRepository(client),
      audit: createAuditRepository(client),
      storage: storageFor,
      mutations: createWorkspaceMutationService({
        projects,
        storage: storageFor,
        operations: createWorkspaceOperationRepository(client),
        hashContent: hashWorkspaceContent,
      }),
    });
    const listing = await catalog.createProject(context, {
      name: "Shared fixture",
      workspaceId: await catalog.defaultWorkspaceId(context),
    });
    const resource = await projects.createResource(listing.project.id, { path: "shared.seq", type: "sequence-diagram" });
    await storageFor(listing.project.id).write(resource.path, "participant A\n");
    const metadata = createEmptyMetadata();
    metadata.resources.push({ id: resource.id, path: resource.path, type: resource.type, title: resource.path });
    await storageFor(listing.project.id).write("project.json", JSON.stringify(metadata, null, 2));
    const workspace = serviceOver(context);
    const project = await workspace.resolveProject(listing.project.id);
    expect((await workspace.readResource(project, "shared.seq")).content).toContain("participant A");
    await expect(workspace.updateResource(project, "shared.seq", { content: "changed" })).rejects.toThrow(/may not change|read-only/);
    expect((await workspace.readResource(project, "shared.seq")).content).toContain("participant A");
  });

  it("reads and mutates only inside explicit MY WORK", async () => {
    const { workspace, project } = await aPrivateWorkspace("Private fixture");
    const created = await workspace.createResource(project, { kind: "diagram", name: "checkout", content: "participant A\n" });
    expect(created.resource.path).toBe("checkout.seq");
    const updated = await workspace.updateResource(project, "checkout.seq", { content: "participant B\n", expectedRevision: 1 });
    expect(updated.revision).toBe(2);
    const moved = await workspace.renameResource(project, "checkout.seq", "renamed.seq");
    expect(moved.resource.path).toBe("renamed.seq");
    await workspace.deleteResource(project, "renamed.seq", true);
    await expect(workspace.readResource(project, "renamed.seq")).rejects.toThrow();
  });

  it("keeps MY WORK contexts isolated", async () => {
    const first = await aPrivateWorkspace("First private fixture");
    const second = await aPrivateWorkspace("Second private fixture");
    await first.workspace.createResource(first.project, { kind: "diagram", name: "only-first", content: "participant A\n" });
    await expect(second.workspace.readResource(second.project, "only-first.seq")).rejects.toThrow();
    expect(first.contextId).not.toBe(second.contextId);
  });
});
