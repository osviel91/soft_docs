// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { SqlClient } from "../../src/persistence/sql-client";
import { createSemanticBindingRepository } from "../../src/persistence/semantic-binding-repository";
import { createProjectRepository } from "../../src/persistence/project-repository";
import { createUserRepository } from "../../src/persistence/user-repository";
import { createWorkspaceRepository } from "../../src/persistence/workspace-repository";
import { closeTestDatabase, openTestDatabase } from "./test-database";

let client: SqlClient;
beforeAll(async () => { client = await openTestDatabase(); });
afterAll(async () => { await closeTestDatabase(client); });

describe("semantic binding persistence", () => {
  it("round-trips exact payloads by project/context and keeps optimistic immutable history", async () => {
    const users = createUserRepository(client);
    const user = await users.findOrCreateByExternalIdentity({ issuer: "binding-test", subject: randomUUID(), displayName: "Binding", email: null });
    const workspace = await createWorkspaceRepository(client).create({ ownerId: user.id, name: `Binding ${randomUUID()}` });
    const project = await createProjectRepository(client).create({ ownerId: user.id, workspaceId: workspace.id, name: `Project ${randomUUID()}` });
    const contextId = randomUUID();
    await client.query("INSERT INTO knowledge_contexts (id, project_id, owner_user_id, name) VALUES ($1, $2, $3, 'binding-work')", [contextId, project.id, user.id]);
    const repo = createSemanticBindingRepository(client);
    const id = randomUUID();
    const binding = {
      id,
      projectId: project.id,
      left: { version: 1 as const, resourceId: "concept-resource", representation: "conceptual" as const, entityKind: "concept" as const, identity: { kind: "local-id" as const, value: "C-1" } },
      right: { version: 1 as const, resourceId: "database-resource", representation: "database" as const, entityKind: "column" as const, identity: { kind: "table-column-name" as const, tableId: "T-1", name: "account_id" } },
      relation: "represents-in" as const,
      evidence: { version: 1 as const, rationale: "Model mapping", items: [{ kind: "external" as const, reference: "ADR-42#mapping", description: "Approved mapping" }] },
      revision: 1,
      status: "ACTIVE" as const,
      provenance: { authorId: user.id, contextId, proposalId: randomUUID(), createdAt: "2026-10-07T12:00:00.000Z" },
    };
    expect(await repo.create(binding)).toEqual(binding);
    expect(await repo.get({ projectId: project.id, contextId }, id)).toEqual(binding);
    expect(await repo.get({ projectId: project.id, contextId: null }, id)).toBeNull();

    const updated = { ...binding, revision: 2, evidence: { ...binding.evidence, items: [{ kind: "external" as const, reference: "https://example.test/evidence", description: "Exact URI evidence" }] } };
    expect(await repo.update({ projectId: project.id, contextId }, updated, 1)).toEqual(updated);
    await expect(repo.update({ projectId: project.id, contextId }, { ...updated, revision: 3 }, 1)).rejects.toThrow(/expected revision 1/);
    const retired = await repo.retire({ projectId: project.id, contextId }, id, 2);
    expect(retired).toMatchObject({ revision: 3, status: "RETIRED", evidence: updated.evidence });
    const removed = await repo.remove({ projectId: project.id, contextId }, id, 3);
    expect(removed).toMatchObject({ revision: 4, status: "RETIRED" });
    expect(await repo.history({ projectId: project.id, contextId }, id)).toEqual([binding, updated, retired, removed]);
    expect(await repo.get({ projectId: project.id, contextId }, id)).toBeNull();
    expect(await repo.list({ projectId: project.id, contextId })).toHaveLength(0);
  });
});
