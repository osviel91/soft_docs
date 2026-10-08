// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { SqlClient } from "../../src/persistence/sql-client";
import { createCandidateAssessmentRepository } from "../../src/persistence/candidate-assessment-repository";
import { createProjectRepository } from "../../src/persistence/project-repository";
import { createUserRepository } from "../../src/persistence/user-repository";
import { createWorkspaceRepository } from "../../src/persistence/workspace-repository";
import { closeTestDatabase, openTestDatabase } from "./test-database";

let client: SqlClient;
beforeAll(async () => { client = await openTestDatabase(); });
afterAll(async () => { await closeTestDatabase(client); });

describe("candidate assessment persistence", () => {
  it("stores private snapshots with optimistic revisions and append-only history", async () => {
    const users = createUserRepository(client);
    const user = await users.findOrCreateByExternalIdentity({ issuer: "assessment-test", subject: randomUUID(), displayName: "Assessment", email: null });
    const workspace = await createWorkspaceRepository(client).create({ ownerId: user.id, name: `Assessment ${randomUUID()}` });
    const project = await createProjectRepository(client).create({ ownerId: user.id, workspaceId: workspace.id, name: `Project ${randomUUID()}` });
    const contextId = randomUUID();
    await client.query("INSERT INTO knowledge_contexts (id, project_id, owner_user_id, name) VALUES ($1, $2, $3, 'assessment-work')", [contextId, project.id, user.id]);
    const repo = createCandidateAssessmentRepository(client);
    const candidate = { left: { version: 1 as const, resourceId: "concept", representation: "conceptual" as const, entityKind: "concept" as const, identity: { kind: "local-id" as const, value: "account" } }, right: { version: 1 as const, resourceId: "table", representation: "database" as const, entityKind: "table" as const, identity: { kind: "local-id" as const, value: "account" } }, fingerprint: "fp-v1", policyVersion: "policy-v1", signals: [{ code: "normalized-name-exact", description: "Names match." }] };
    const base = { projectId: project.id, contextId, candidateId: "candidate-1", candidate, decision: "NEEDS_EVIDENCE" as const, rationale: "Need migration evidence.", authorId: user.id, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
    const first = { ...base, revision: 1 };
    await repo.create(first);
    expect(await repo.get({ projectId: project.id, contextId }, first.candidateId)).toEqual(first);
    expect(await repo.get({ projectId: project.id, contextId: null as never }, first.candidateId)).toBeNull();
    const second = await repo.update({ projectId: project.id, contextId }, { ...first, decision: "REJECTED", rationale: "Different meanings." }, 1);
    expect(second).toMatchObject({ revision: 2, decision: "REJECTED" });
    await expect(repo.update({ projectId: project.id, contextId }, second, 1)).rejects.toThrow("expected revision 1");
    expect(await repo.history({ projectId: project.id, contextId }, first.candidateId)).toEqual([first, second]);
    expect(await repo.list({ projectId: project.id, contextId })).toEqual([second]);
  });

  it("requires evidence only for an explicit READY_FOR_BINDING decision", async () => {
    const repo = createCandidateAssessmentRepository(client);
    const users = createUserRepository(client);
    const user = await users.findOrCreateByExternalIdentity({ issuer: "assessment-validation", subject: randomUUID(), displayName: "Assessment", email: null });
    const workspace = await createWorkspaceRepository(client).create({ ownerId: user.id, name: `Assessment ${randomUUID()}` });
    const project = await createProjectRepository(client).create({ ownerId: user.id, workspaceId: workspace.id, name: "Assessment validation" });
    const contextId = randomUUID();
    await client.query("INSERT INTO knowledge_contexts (id, project_id, owner_user_id, name) VALUES ($1, $2, $3, 'assessment-work')", [contextId, project.id, user.id]);
    const assessment = { projectId: project.id, contextId, candidateId: "candidate-ready", candidate: { left: { version: 1 as const, resourceId: "c", representation: "conceptual" as const, entityKind: "concept" as const, identity: { kind: "local-id" as const, value: "a" } }, right: { version: 1 as const, resourceId: "d", representation: "database" as const, entityKind: "table" as const, identity: { kind: "local-id" as const, value: "a" } }, fingerprint: "fp", policyVersion: "policy", signals: [] }, decision: "READY_FOR_BINDING" as const, rationale: "Evidence supports an explicit mapping.", authorId: user.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 1 };
    await expect(repo.create(assessment)).rejects.toThrow("requires valid version 1 evidence");
    const ready = { ...assessment, evidence: { version: 1 as const, rationale: "Migration and domain contract.", items: [{ kind: "external" as const, reference: "ADR-2", description: "Defines this mapping." }] } };
    await expect(repo.create(ready)).resolves.toEqual(ready);
  });
});
