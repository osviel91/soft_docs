// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { closeTestDatabase, openTestDatabase } from "./test-database";
import type { SqlClient } from "../../src/persistence/sql-client";
import { createProjectRepository } from "../../src/persistence/project-repository";
import { createWorkspaceRepository } from "../../src/persistence/workspace-repository";
import { createUserRepository } from "../../src/persistence/user-repository";
import { createAuthoritativeBatchRepository } from "../../src/persistence/authoritative-batch-repository";
import { createSemanticBindingRepository } from "../../src/persistence/semantic-binding-repository";

let client: SqlClient;
const projects = () => createProjectRepository(client);

beforeAll(async () => { client = await openTestDatabase(); });
afterAll(async () => { await closeTestDatabase(client); });

async function project(): Promise<{ id: string; userId: string }> {
  const users = createUserRepository(client);
  const user = await users.findOrCreateByExternalIdentity({ issuer: "batch-test", subject: randomUUID(), displayName: "Batch", email: null });
  const workspace = await createWorkspaceRepository(client).create({ ownerId: user.id, name: `Batch ${randomUUID()}` });
  const created = await projects().create({ ownerId: user.id, workspaceId: workspace.id, name: `Project ${randomUUID()}` });
  return { id: created.id, userId: user.id };
}

function audit(userId: string, projectId: string) {
  return { action: "resource.updated" as const, subjectUserId: userId, actorType: "user" as const, actorId: userId, authType: "session" as const, projectId, resourceId: null, requestId: "batch-test" };
}

describe("authoritative batches", () => {
  it("claims multiple resource changes as one SQL-visible journal envelope", async () => {
    const target = await project();
    const batch = createAuthoritativeBatchRepository(client);
    const resourceId = randomUUID();
    const result = await batch.claim({
      batchId: randomUUID(), projectId: target.id,
      actor: { kind: "user", userId: target.userId, subjectUserId: target.userId },
      audit: audit(target.userId, target.id),
      operations: [{ operation: "create", resourceId, path: "batch.md", type: "markdown-document", content: "# Batch" }],
    });
    expect(result.status).toBe("pending");
    expect(result.operations).toHaveLength(1);
    expect((await projects().findResource(target.id, resourceId))?.revision).toBe(1);
  });

  it("rolls back every member when one member is stale", async () => {
    const target = await project();
    const existing = await projects().createResource(target.id, { path: "existing.md", type: "markdown-document" });
    await client.query(`INSERT INTO resource_revisions (resource_id, revision, content, type, metadata, authorship) VALUES ($1, 1, '# Existing', 'markdown-document', '{}'::jsonb, $2::jsonb)`, [existing.id, JSON.stringify({ kind: "system" })]);
    const batch = createAuthoritativeBatchRepository(client);
    await expect(batch.claim({
      batchId: randomUUID(), projectId: target.id,
      actor: { kind: "user", userId: target.userId, subjectUserId: target.userId },
      audit: audit(target.userId, target.id),
      operations: [
        { operation: "create", resourceId: randomUUID(), path: "rolled-back.md", type: "markdown-document", content: "no" },
        { operation: "update", resourceId: existing.id, path: existing.path, expectedRevision: 7, content: "stale" },
      ],
    })).rejects.toBeTruthy();
    expect(await projects().findResourceByPath(target.id, "rolled-back.md")).toBeNull();
    expect((await projects().findResource(target.id, existing.id))?.revision).toBe(1);
  });

  it("rolls back resource writes when the selected semantic binding operation fails", async () => {
    const target = await project();
    const id = randomUUID();
    const binding = {
      id, projectId: target.id,
      left: { version: 1 as const, resourceId: randomUUID(), representation: "conceptual" as const, entityKind: "concept" as const, identity: { kind: "local-id" as const, value: "project" } },
      right: { version: 1 as const, resourceId: randomUUID(), representation: "database" as const, entityKind: "table" as const, identity: { kind: "local-id" as const, value: "projects" } },
      relation: "represents-in" as const, evidence: { version: 1 as const, rationale: "Evidence-backed mapping.", items: [{ kind: "external" as const, reference: "ADR-1", description: "Approved mapping." }] }, revision: 1, status: "ACTIVE" as const,
      provenance: { authorId: target.userId, createdAt: new Date().toISOString() },
    };
    await createSemanticBindingRepository(client).create(binding);
    const resourceId = randomUUID();
    const batch = createAuthoritativeBatchRepository(client);
    await expect(batch.claim({
      batchId: randomUUID(), projectId: target.id,
      actor: { kind: "user", userId: target.userId, subjectUserId: target.userId }, audit: audit(target.userId, target.id),
      operations: [{ operation: "create", resourceId, path: "atomic.md", type: "markdown-document", content: "# Atomic" }],
      semanticBindingChanges: [{ operation: "ADD", binding }],
    })).rejects.toBeTruthy();
    expect(await projects().findResource(target.id, resourceId)).toBeNull();
    expect(await createSemanticBindingRepository(client).list({ projectId: target.id, contextId: null })).toEqual([binding]);
  });
});
