// @vitest-environment node
import { expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openTestDatabase, closeTestDatabase } from "./test-database";
import { createProjectRepository } from "../../src/persistence/project-repository";
import { createWorkspaceRepository } from "../../src/persistence/workspace-repository";
import { createUserRepository } from "../../src/persistence/user-repository";
import { createKnowledgeContextRepository } from "../../src/persistence/knowledge-context-repository";
import { createWorkspaceOperationRepository } from "../../src/persistence/workspace-operation-repository";
import { createFsProjectStorage } from "../../src/persistence/fs-project-storage";
import { createProjectCatalog } from "../../src/application/project-catalog";
import { ALL_PERMISSIONS } from "../../src/domain/access/permissions";
import type { ApplicationContext } from "../../src/application/context";
import type { SqlClient } from "../../src/persistence/sql-client";

let client: SqlClient;
let catalog: ReturnType<typeof createProjectCatalog>;
let users: ReturnType<typeof createUserRepository>;
let volume: string;

const contextFor = (id: string): ApplicationContext => ({
  requestId: "private-test",
  principal: { subjectUserId: id, actor: { kind: "user", userId: id }, authType: "session", scopes: ALL_PERMISSIONS },
});

beforeAll(async () => {
  client = await openTestDatabase();
  volume = await mkdtemp(path.join(tmpdir(), "sd-private-"));
  const projects = createProjectRepository(client);
  users = createUserRepository(client);
  catalog = createProjectCatalog({
    projects,
    workspaces: createWorkspaceRepository(client),
    knowledgeContexts: createKnowledgeContextRepository(client),
    operations: createWorkspaceOperationRepository(client),
    storage: (projectId, contextId) => createFsProjectStorage({ root: path.join(volume, projectId, contextId ? ".private" : "", contextId ?? "") }),
  });
});

afterAll(async () => { await closeTestDatabase(client); await rm(volume, { recursive: true, force: true }); });

async function user(subject: string): Promise<string> {
  return (await users.findOrCreateByExternalIdentity({ issuer: "test", subject, displayName: subject, email: null })).id;
}

it("keeps private work owner-only and separate from SHARED", async () => {
  const owner = await user("owner"); const member = await user("member");
  const project = (await catalog.createProject(contextFor(owner), { name: "Private", workspaceId: owner })).project;
  await catalog.setMember(contextFor(owner), project.id, member, "EDITOR");
  const work = await catalog.createPrivateWorkContext(contextFor(owner), project.id, { name: "payment-retry" });
  const resource = await catalog.createResource(contextFor(owner), project.id, { contextId: work.id, path: "retry.md", type: "markdown-document", content: "# Retry" });
  expect((await catalog.listResources(contextFor(owner), project.id)).some((item) => item.id === resource.id)).toBe(false);
  expect((await catalog.listResources(contextFor(owner), project.id, work.id)).map((item) => item.id)).toEqual([resource.id]);
  await expect(catalog.listPrivateWorkContexts(contextFor(member), project.id)).rejects.toMatchObject({ code: "not_found" });
  await expect(catalog.readResource(contextFor(member), project.id, resource.id, work.id)).rejects.toMatchObject({ code: "not_found" });
  await catalog.deletePrivateWorkContext(contextFor(owner), project.id, work.id);
  await expect(catalog.listResources(contextFor(owner), project.id, work.id)).rejects.toMatchObject({ code: "not_found" });
});
