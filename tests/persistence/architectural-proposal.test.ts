// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openTestDatabase, closeTestDatabase } from "./test-database";
import { createProjectRepository } from "../../src/persistence/project-repository";
import { createWorkspaceRepository } from "../../src/persistence/workspace-repository";
import { createUserRepository } from "../../src/persistence/user-repository";
import { createKnowledgeContextRepository } from "../../src/persistence/knowledge-context-repository";
import { createArchitecturalProposalRepository } from "../../src/persistence/architectural-proposal-repository";
import { createProposalReviewRepository } from "../../src/persistence/proposal-review-repository";
import { createWorkspaceOperationRepository } from "../../src/persistence/workspace-operation-repository";
import { createFsProjectStorage } from "../../src/persistence/fs-project-storage";
import { createProjectCatalog } from "../../src/application/project-catalog";
import { createArchitecturalProposalService } from "../../src/application/architectural-proposal-service";
import { createAuthoritativeBatchRepository } from "../../src/persistence/authoritative-batch-repository";
import { createPromotionRepository } from "../../src/persistence/promotion-repository";
import { createPromotionService } from "../../src/application/promotion-service";
import { createAuthorizationPolicy } from "../../src/application/authorization";
import { ALL_PERMISSIONS } from "../../src/domain/access/permissions";
import type { ApplicationContext } from "../../src/application/context";
import type { SqlClient } from "../../src/persistence/sql-client";

let client: SqlClient;
let volume: string;
let users: ReturnType<typeof createUserRepository>;
let catalog: ReturnType<typeof createProjectCatalog>;
let service: ReturnType<typeof createArchitecturalProposalService>;
let architecturalProposals: ReturnType<typeof createArchitecturalProposalRepository>;
let promotionService: ReturnType<typeof createPromotionService>;

const contextFor = (id: string): ApplicationContext => ({
  requestId: "proposal-test",
  principal: { subjectUserId: id, actor: { kind: "user", userId: id }, authType: "session", scopes: ALL_PERMISSIONS },
});

beforeAll(async () => {
  client = await openTestDatabase();
  volume = await mkdtemp(path.join(tmpdir(), "sd-proposal-"));
  const projects = createProjectRepository(client);
  users = createUserRepository(client);
  const knowledgeContexts = createKnowledgeContextRepository(client);
  architecturalProposals = createArchitecturalProposalRepository(client);
  catalog = createProjectCatalog({
    projects,
    workspaces: createWorkspaceRepository(client),
    knowledgeContexts,
    operations: createWorkspaceOperationRepository(client),
    storage: (projectId, contextId) => createFsProjectStorage({ root: path.join(volume, projectId, contextId ? ".private" : "", contextId ?? "") }),
    architecturalProposals,
  });
  service = createArchitecturalProposalService({
    proposals: architecturalProposals,
    projects,
    knowledgeContexts,
    reviews: createProposalReviewRepository(client),
  });
  promotionService = createPromotionService({
    proposals: architecturalProposals,
    projects,
    reviews: createProposalReviewRepository(client),
    batches: createAuthoritativeBatchRepository(client),
    promotions: createPromotionRepository(client),
    storage: (projectId) => createFsProjectStorage({ root: path.join(volume, projectId) }),
    policy: createAuthorizationPolicy(projects),
  });
});

afterAll(async () => { await closeTestDatabase(client); await rm(volume, { recursive: true, force: true }); });

async function user(subject: string): Promise<string> {
  return (await users.findOrCreateByExternalIdentity({ issuer: "proposal-test", subject, displayName: subject, email: null })).id;
}

it("submits a selective immutable snapshot and exposes stale base without rebasing", async () => {
  const owner = await user("proposal-owner");
  const project = (await catalog.createProject(contextFor(owner), { name: "Proposal", workspaceId: owner })).project;
  const work = await catalog.createPrivateWorkContext(contextFor(owner), project.id, { name: "payment-retry" });
  const selected = await catalog.createResource(contextFor(owner), project.id, { contextId: work.id, path: "payment-retry.eventseq", type: "event-flow", content: "event PaymentRequested\n" });
  await catalog.createResource(contextFor(owner), project.id, { contextId: work.id, path: "abandoned.md", type: "markdown-document", content: "# Abandoned\n" });
  const proposal = await service.submit(contextFor(owner), { projectId: project.id, sourcePrivateContextId: work.id, resourceIds: [selected.id], title: "Payment Retry Architecture" });
  expect(proposal.resources.map((resource) => resource.path)).toEqual(["payment-retry.eventseq"]);
  await catalog.updateResource(contextFor(owner), project.id, selected.id, { contextId: work.id, content: "event Changed\n", expectedRevision: selected.revision });
  const afterPrivateEdit = await service.get(contextFor(owner), project.id, proposal.id);
  expect(afterPrivateEdit.resources[0]?.content).toBe("event PaymentRequested\n");
  const shared = await catalog.createResource(contextFor(owner), project.id, { path: "shared.seq", type: "sequence-diagram", content: "title Shared\n" });
  await catalog.updateResource(contextFor(owner), project.id, shared.id, { content: "title Shared Later\n", expectedRevision: shared.revision });
  const stale = await service.get(contextFor(owner), project.id, proposal.id);
  expect(stale.staleBase).toBe(true);
  expect(stale.baseSharedRevision).not.toBe(stale.currentSharedRevision);
  await expect(catalog.deletePrivateWorkContext(contextFor(owner), project.id, work.id)).rejects.toMatchObject({ code: "invalid" });
});

it("does not expose a private proposal to another project member", async () => {
  const owner = await user("proposal-private-owner");
  const member = await user("proposal-private-member");
  const project = (await catalog.createProject(contextFor(owner), { name: "Private Proposal", workspaceId: owner })).project;
  await catalog.setMember(contextFor(owner), project.id, member, "EDITOR");
  const work = await catalog.createPrivateWorkContext(contextFor(owner), project.id, { name: "only-owner" });
  const resource = await catalog.createResource(contextFor(owner), project.id, { contextId: work.id, path: "private.md", type: "markdown-document", content: "# Private\n" });
  const proposal = await service.submit(contextFor(owner), { projectId: project.id, sourcePrivateContextId: work.id, resourceIds: [resource.id], title: "Visible Proposal" });
  expect("sourcePrivateContextId" in proposal).toBe(false);
  expect((await service.list(contextFor(member), project.id)).some((item) => item.id === proposal.id)).toBe(true);
  await expect(catalog.listPrivateWorkContexts(contextFor(member), project.id)).rejects.toMatchObject({ code: "not_found" });
  await expect(service.get(contextFor(member), project.id, proposal.id)).resolves.toMatchObject({ id: proposal.id });
});

it("marks a proposal stale when an included SHARED resource is retired", async () => {
  const owner = await user("retirement-stale-owner");
  const project = (await catalog.createProject(contextFor(owner), { name: "Retirement Stale", workspaceId: owner })).project;
  const shared = await catalog.createResource(contextFor(owner), project.id, { path: "current.md", type: "markdown-document", content: "# Current\n" });
  const work = await catalog.createPrivateWorkContext(contextFor(owner), project.id, { name: "candidate" });
  const privateResource = await catalog.createResource(contextFor(owner), project.id, { contextId: work.id, path: "candidate.md", type: "markdown-document", content: "# Candidate\n" });
  const proposal = await service.submit(contextFor(owner), { projectId: project.id, sourcePrivateContextId: work.id, resourceIds: [privateResource.id], title: "Retirement base" });

  await catalog.deleteResource(contextFor(owner), project.id, shared.id);

  await expect(service.get(contextFor(owner), project.id, proposal.id)).resolves.toMatchObject({ staleBase: true });
});

it("captures explicit SHARED retirement intent without treating omission as retirement", async () => {
  const owner = await user("explicit-retirement-owner");
  const project = (await catalog.createProject(contextFor(owner), { name: "Explicit Retirement", workspaceId: owner })).project;
  const shared = await catalog.createResource(contextFor(owner), project.id, { path: "legacy.md", type: "markdown-document", content: "# Legacy\n" });
  const work = await catalog.createPrivateWorkContext(contextFor(owner), project.id, { name: "retirement-intent" });
  const candidate = await catalog.createResource(contextFor(owner), project.id, { contextId: work.id, path: "new.md", type: "markdown-document", content: "# New\n" });

  const omittedProposal = await service.submit(contextFor(owner), { projectId: project.id, sourcePrivateContextId: work.id, resourceIds: [candidate.id], title: "No retirement" });
  expect(omittedProposal.resources.find((resource) => resource.sourceResourceId === shared.id)).toBeUndefined();

  const proposal = await service.submit(contextFor(owner), { projectId: project.id, sourcePrivateContextId: work.id, resourceIds: [], retireResourceIds: [shared.id], title: "Retire legacy knowledge" });
  expect(proposal.resources).toMatchObject([{ sourceResourceId: shared.id, operation: "RETIRE", baseResourceId: shared.id, baseRevision: shared.revision, content: "# Legacy\n" }]);
  expect((await service.get(contextFor(owner), project.id, proposal.id)).resources[0]?.operation).toBe("RETIRE");
});

it("promotes UPDATE, RETIRE and CREATE with one recoverable lineage record", async () => {
  const owner = await user("promotion-owner");
  const reviewer = await user("promotion-reviewer");
  const project = (await catalog.createProject(contextFor(owner), { name: "Promotion", workspaceId: owner })).project;
  await catalog.setMember(contextFor(owner), project.id, reviewer, "EDITOR");
  const sharedA = await catalog.createResource(contextFor(owner), project.id, { path: "a.md", type: "markdown-document", content: "A3\n" });
  const sharedB = await catalog.createResource(contextFor(owner), project.id, { path: "b.md", type: "markdown-document", content: "B5\n" });
  const work = await catalog.createPrivateWorkContext(contextFor(owner), project.id, { name: "promotion-work" });
  const privateA = await catalog.createResource(contextFor(owner), project.id, { contextId: work.id, path: "a.md", type: "markdown-document", content: "A4\n" });
  const privateC = await catalog.createResource(contextFor(owner), project.id, { contextId: work.id, path: "c.md", type: "markdown-document", content: "C1\n" });
  const proposal = await service.submit(contextFor(owner), { projectId: project.id, sourcePrivateContextId: work.id, resourceIds: [privateA.id, privateC.id], retireResourceIds: [sharedB.id], title: "A4 B retired C1" });
  expect(proposal.resources.map((resource) => resource.operation).sort()).toEqual(["CREATE", "RETIRE", "UPDATE"]);
  await service.review(contextFor(reviewer), { projectId: project.id, proposalId: proposal.id, decision: "APPROVE" });
  const preview = await promotionService.preview(contextFor(owner), project.id, proposal.id);
  expect(preview.creates).toHaveLength(1);
  expect(preview.updates).toHaveLength(1);
  expect(preview.retires).toHaveLength(1);
  const promotion = await promotionService.execute(contextFor(owner), project.id, proposal.id, "promotion-test-key");
  expect(promotion.status).toBe("COMPLETED");
  expect(promotion.entries.map((entry) => entry.operation).sort()).toEqual(["CREATE", "RETIRE", "UPDATE"]);
  expect((await catalog.readResource(contextFor(owner), project.id, sharedA.id)).resource.revision).toBe(sharedA.revision + 1);
  await expect(catalog.readResource(contextFor(owner), project.id, sharedB.id)).rejects.toMatchObject({ code: "not_found" });
  expect(await (createProjectRepository(client).findHistoricalResource?.(project.id, sharedB.id))).toMatchObject({ lifecycle: "RETIRED", revision: sharedB.revision });
  const promotedStorage = createFsProjectStorage({ root: path.join(volume, project.id) });
  expect((await promotedStorage.read("b.md"))).toMatchObject({ ok: true, value: null });
  const manifest = await promotedStorage.read("project.json");
  expect(manifest).toMatchObject({ ok: true });
  expect(JSON.parse(manifest.ok && manifest.value ? manifest.value.content : "{}").resources.map((resource: { id: string }) => resource.id)).toEqual(expect.arrayContaining([sharedA.id]));
  expect(JSON.parse(manifest.ok && manifest.value ? manifest.value.content : "{}").resources.map((resource: { id: string }) => resource.id)).not.toContain(sharedB.id);
  const retry = await promotionService.execute(contextFor(owner), project.id, proposal.id, "promotion-test-key");
  expect(retry.id).toBe(promotion.id);
  expect((await createPromotionRepository(client).listForResource(project.id, sharedA.id))).toHaveLength(1);
});

it("recovers a committed promotion after a manifest-stage crash and settles it once", async () => {
  const owner = await user("promotion-recovery-owner");
  const project = (await catalog.createProject(contextFor(owner), { name: "Promotion Recovery", workspaceId: owner })).project;
  const shared = await catalog.createResource(contextFor(owner), project.id, { path: "recover.md", type: "markdown-document", content: "before\n" });
  const work = await catalog.createPrivateWorkContext(contextFor(owner), project.id, { name: "recovery-work" });
  const candidate = await catalog.createResource(contextFor(owner), project.id, { contextId: work.id, path: "recover.md", type: "markdown-document", content: "after\n" });
  const proposal = await service.submit(contextFor(owner), { projectId: project.id, sourcePrivateContextId: work.id, resourceIds: [candidate.id], title: "Recoverable update" });
  const storage = createFsProjectStorage({ root: path.join(volume, project.id) });
  const batchRepository = createAuthoritativeBatchRepository(client);
  const promotionRepository = createPromotionRepository(client);
  const batchId = "00000000-0000-4000-8000-000000000101";
  const promotionId = "00000000-0000-4000-8000-000000000102";
  const stagedPath = `.sdd-staging/${batchId}/recover.md`;
  const manifestPath = `.sdd-staging/${batchId}/project.json`;
  await storage.write(stagedPath, "after\n");
  await storage.write(manifestPath, JSON.stringify({ format: "sequencediagrams-project", version: 1, resources: [{ id: shared.id, path: "recover.md", type: "markdown-document" }] }, null, 2));
  await batchRepository.claim({
    batchId, projectId: project.id,
    actor: { kind: "user", userId: owner, subjectUserId: owner },
    audit: { action: "proposal.promoted", subjectUserId: owner, actorType: "user", actorId: owner, authType: "session", projectId: project.id },
    operations: [{ operation: "update", resourceId: shared.id, path: "recover.md", expectedRevision: shared.revision, content: "after\n", stagedPath }],
    manifest: { expectedRevision: 0, expectedContent: null, content: JSON.stringify({ format: "sequencediagrams-project", version: 1, resources: [{ id: shared.id, path: "recover.md", type: "markdown-document" }] }, null, 2), stagedPath: manifestPath },
    promotion: { id: promotionId, proposalId: proposal.id, baseSharedRevision: proposal.baseSharedRevision, entries: [{ id: "00000000-0000-4000-8000-000000000103", proposalResourceId: candidate.id, operation: "UPDATE", path: "recover.md", type: "markdown-document", baseResourceId: shared.id, baseRevision: shared.revision, resultingResourceId: shared.id, resultingRevision: shared.revision + 1, resultingLifecycle: "ACTIVE" }], relationships: [] },
  });
  const first = await promotionService.recover();
  expect(first.completed).toBeGreaterThanOrEqual(1);
  expect((await storage.read("recover.md"))).toMatchObject({ ok: true, value: { content: "after\n" } });
  expect((await promotionRepository.getForProposal(project.id, proposal.id))).toMatchObject({ id: promotionId, status: "COMPLETED" });
  const second = await promotionService.recover();
  expect(second.examined).toBe(0);
});

it("persists append-only review history, aggregates latest decisions, and keeps the snapshot immutable", async () => {
  const owner = await user("review-owner");
  const reviewer = await user("reviewer");
  const project = (await catalog.createProject(contextFor(owner), { name: "Review", workspaceId: owner })).project;
  await catalog.setMember(contextFor(owner), project.id, reviewer, "EDITOR");
  const work = await catalog.createPrivateWorkContext(contextFor(owner), project.id, { name: "retry" });
  const resource = await catalog.createResource(contextFor(owner), project.id, { contextId: work.id, path: "retry.eventseq", type: "event-flow", content: "event PaymentRequested\n" });
  const proposal = await service.submit(contextFor(owner), { projectId: project.id, sourcePrivateContextId: work.id, resourceIds: [resource.id], title: "Retry review" });
  await expect(service.review(contextFor(owner), { projectId: project.id, proposalId: proposal.id, decision: "APPROVE" })).rejects.toMatchObject({ code: "invalid" });
  await service.review(contextFor(reviewer), { projectId: project.id, proposalId: proposal.id, decision: "REQUEST_CHANGES", summary: "Recovery remains unknown." });
  await service.review(contextFor(reviewer), { projectId: project.id, proposalId: proposal.id, decision: "APPROVE", summary: "The documented boundary is acceptable." });
  const result = await service.reviews(contextFor(owner), project.id, proposal.id);
  expect(result.status).toBe("approved");
  expect(result.reviews).toHaveLength(2);
  expect(result.reviews[0]?.decision).toBe("REQUEST_CHANGES");
  expect((await service.get(contextFor(owner), project.id, proposal.id)).resources[0]?.content).toBe("event PaymentRequested\n");
});
