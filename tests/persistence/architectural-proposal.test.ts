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
import { createProjectBootstrapService } from "../../src/application/project-bootstrap-service";
import { createAuthorizationPolicy, createWorkspaceAdminGovernance } from "../../src/application/authorization";
import { ALL_PERMISSIONS } from "../../src/domain/access/permissions";
import type { ApplicationContext } from "../../src/application/context";
import type { SqlClient } from "../../src/persistence/sql-client";
import type { ServerProject } from "../../src/domain/project/server-project";

let client: SqlClient;
let volume: string;
let users: ReturnType<typeof createUserRepository>;
let catalog: ReturnType<typeof createProjectCatalog>;
let service: ReturnType<typeof createArchitecturalProposalService>;
let architecturalProposals: ReturnType<typeof createArchitecturalProposalRepository>;
let promotionService: ReturnType<typeof createPromotionService>;
let bootstrapService: ReturnType<typeof createProjectBootstrapService>;

const contextFor = (id: string): ApplicationContext => ({
  requestId: "proposal-test",
  principal: { subjectUserId: id, actor: { kind: "user", userId: id }, authType: "session", scopes: ALL_PERMISSIONS },
});

beforeAll(async () => {
  client = await openTestDatabase();
  volume = await mkdtemp(path.join(tmpdir(), "sd-proposal-"));
  const projects = createProjectRepository(client);
  const workspaces = createWorkspaceRepository(client);
  const policy = createAuthorizationPolicy<ServerProject>(projects);
  const workspaceAdmin = createWorkspaceAdminGovernance({ policy, workspaces });
  users = createUserRepository(client);
  const knowledgeContexts = createKnowledgeContextRepository(client);
  architecturalProposals = createArchitecturalProposalRepository(client);
  catalog = createProjectCatalog({
    projects,
     workspaces,
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
    policy,
    workspaceAdmin,
  });
  promotionService = createPromotionService({
    proposals: architecturalProposals,
    projects,
    reviews: createProposalReviewRepository(client),
    batches: createAuthoritativeBatchRepository(client),
    promotions: createPromotionRepository(client),
    storage: (projectId) => createFsProjectStorage({ root: path.join(volume, projectId) }),
    policy,
    workspaceAdmin,
  });
  bootstrapService = createProjectBootstrapService({
    projects,
    batches: createAuthoritativeBatchRepository(client),
    storage: (projectId) => createFsProjectStorage({ root: path.join(volume, projectId) }),
    createProject: (context, input) => catalog.createProject(context, input),
    policy: createAuthorizationPolicy(projects),
  });
});

afterAll(async () => { await closeTestDatabase(client); await rm(volume, { recursive: true, force: true }); });

async function user(subject: string): Promise<string> {
  return (await users.findOrCreateByExternalIdentity({ issuer: "proposal-test", subject, displayName: subject, email: null })).id;
}

it("submits a selective immutable snapshot without allowing direct SHARED edits", async () => {
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
  await expect(catalog.createResource(contextFor(owner), project.id, { path: "shared.seq", type: "sequence-diagram", content: "title Shared\n" })).rejects.toMatchObject({ code: "invalid" });
  const stale = await service.get(contextFor(owner), project.id, proposal.id);
  expect(stale.staleBase).toBe(false);
  expect(stale.baseSharedRevision).toBe(stale.currentSharedRevision);
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
  const project = await bootstrapService.bootstrap(contextFor(owner), { workspaceId: owner, name: "Retirement Stale", resources: [{ path: "current.md", type: "markdown-document", content: "# Current\n" }] });
  const shared = (await catalog.listResources(contextFor(owner), project.id))[0];
  if (!shared) throw new Error("Bootstrap did not create the shared fixture.");
  const work = await catalog.createPrivateWorkContext(contextFor(owner), project.id, { name: "candidate" });
  const privateResource = await catalog.createResource(contextFor(owner), project.id, { contextId: work.id, path: "candidate.md", type: "markdown-document", content: "# Candidate\n" });
  const proposal = await service.submit(contextFor(owner), { projectId: project.id, sourcePrivateContextId: work.id, resourceIds: [privateResource.id], title: "Retirement base" });

  await expect(service.get(contextFor(owner), project.id, proposal.id)).resolves.toMatchObject({ staleBase: false });
});

it("captures explicit SHARED retirement intent without treating omission as retirement", async () => {
  const owner = await user("explicit-retirement-owner");
  const project = await bootstrapService.bootstrap(contextFor(owner), { workspaceId: owner, name: "Explicit Retirement", resources: [{ path: "legacy.md", type: "markdown-document", content: "# Legacy\n" }] });
  const shared = (await catalog.listResources(contextFor(owner), project.id))[0];
  if (!shared) throw new Error("Bootstrap did not create the shared fixture.");
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
  const project = await bootstrapService.bootstrap(contextFor(owner), { workspaceId: owner, name: "Promotion", resources: [{ path: "a.md", type: "markdown-document", content: "A3\n" }, { path: "b.md", type: "markdown-document", content: "B5\n" }] });
  await catalog.setMember(contextFor(owner), project.id, reviewer, "EDITOR");
  const sharedResources = await catalog.listResources(contextFor(owner), project.id);
  const sharedA = sharedResources.find((resource) => resource.path === "a.md");
  const sharedB = sharedResources.find((resource) => resource.path === "b.md");
  if (!sharedA || !sharedB) throw new Error("Bootstrap did not create promotion fixtures.");
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

it("allows a workspace ADMIN project member to approve and promote without OWNER project role", async () => {
  const owner = await user("workspace-governance-owner");
  const administrator = await user("workspace-governance-admin");
  const project = await bootstrapService.bootstrap(contextFor(owner), {
    workspaceId: owner,
    name: "Workspace Governance",
    resources: [{ path: "governance.md", type: "markdown-document", content: "Before\n" }],
  });
  const workspaceId = project.workspaceId;
  await createWorkspaceRepository(client).setMember(workspaceId, administrator, "ADMIN");
  await catalog.setMember(contextFor(owner), project.id, administrator, "VIEWER");
  const work = await catalog.createPrivateWorkContext(contextFor(owner), project.id, { name: "governance-review" });
  const shared = (await catalog.listResources(contextFor(owner), project.id))[0];
  if (!shared) throw new Error("Bootstrap did not create a SHARED governance fixture.");
  const candidate = await catalog.createResource(contextFor(owner), project.id, { contextId: work.id, path: "governance.md", type: "markdown-document", content: "After\n" });
  const proposal = await service.submit(contextFor(owner), { projectId: project.id, sourcePrivateContextId: work.id, resourceIds: [candidate.id], title: "Workspace admin review" });

  await service.review(contextFor(administrator), { projectId: project.id, proposalId: proposal.id, decision: "APPROVE" });
  const promoted = await promotionService.execute(contextFor(administrator), project.id, proposal.id, "workspace-admin-promotion");

  expect(promoted.status).toBe("COMPLETED");
  await expect(catalog.readResource(contextFor(owner), project.id, shared.id)).resolves.toMatchObject({ resource: { revision: shared.revision + 1 } });
  await expect(catalog.readResource(contextFor(owner), project.id, shared.id)).resolves.toMatchObject({ content: "After\n" });
});

it("promotes a governed path-only move with content in the same update", async () => {
  const owner = await user("promotion-move-owner");
  const reviewer = await user("promotion-move-reviewer");
  const project = await bootstrapService.bootstrap(contextFor(owner), { workspaceId: owner, name: "Promotion Move", resources: [{ path: "before.md", type: "markdown-document", content: "before\n" }] });
  await catalog.setMember(contextFor(owner), project.id, reviewer, "EDITOR");
  const shared = (await catalog.listResources(contextFor(owner), project.id))[0];
  if (!shared) throw new Error("Bootstrap did not create the move fixture.");
  const work = await catalog.createPrivateWorkContext(contextFor(owner), project.id, { name: "move-work" });
  const candidate = await catalog.createResource(contextFor(owner), project.id, { contextId: work.id, path: "before.md", type: "markdown-document", content: "after\n" });
  const proposal = await service.submit(contextFor(owner), { projectId: project.id, sourcePrivateContextId: work.id, resourceIds: [candidate.id], resourceOperations: [{ resourceId: candidate.id, operation: "UPDATE", baseResourceId: shared.id, path: "after.md", baseRevision: shared.revision }], title: "Move documentation" });
  await service.review(contextFor(reviewer), { projectId: project.id, proposalId: proposal.id, decision: "APPROVE" });
  await promotionService.execute(contextFor(owner), project.id, proposal.id, "promotion-move-key");
  await expect(catalog.readResource(contextFor(owner), project.id, shared.id)).resolves.toMatchObject({ resource: { path: "after.md", revision: shared.revision + 1 } });
  const storage = createFsProjectStorage({ root: path.join(volume, project.id) });
  await expect(storage.read("before.md")).resolves.toMatchObject({ ok: true, value: null });
  await expect(storage.read("after.md")).resolves.toMatchObject({ ok: true, value: { content: "after\n" } });
});

it("recovers a committed promotion after a manifest-stage crash and settles it once", async () => {
  const owner = await user("promotion-recovery-owner");
  const project = await bootstrapService.bootstrap(contextFor(owner), { workspaceId: owner, name: "Promotion Recovery", resources: [{ path: "recover.md", type: "markdown-document", content: "before\n" }] });
  const shared = (await catalog.listResources(contextFor(owner), project.id))[0];
  if (!shared) throw new Error("Bootstrap did not create recovery fixture.");
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
  const currentManifest = await storage.read("project.json");
  if (!currentManifest.ok || !currentManifest.value) throw new Error("Bootstrap manifest is missing.");
  const nextManifest = JSON.stringify({ format: "sequencediagrams-project", version: 1, resources: [{ id: shared.id, path: "recover.md", type: "markdown-document" }] }, null, 2);
  await storage.write(manifestPath, nextManifest);
  await batchRepository.claim({
    batchId, projectId: project.id,
    actor: { kind: "user", userId: owner, subjectUserId: owner },
    audit: { action: "proposal.promoted", subjectUserId: owner, actorType: "user", actorId: owner, authType: "session", projectId: project.id },
    operations: [{ operation: "update", resourceId: shared.id, path: "recover.md", expectedRevision: shared.revision, content: "after\n", stagedPath }],
    manifest: { expectedRevision: 1, expectedContent: currentManifest.value.content, content: nextManifest, stagedPath: manifestPath },
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

it("revises from current MY WORK with a fresh base and no transferred reviews", async () => {
  const owner = await user("revision-owner");
  const reviewer = await user("revision-reviewer");
  const project = (await catalog.createProject(contextFor(owner), { name: "Revision", workspaceId: owner })).project;
  await catalog.setMember(contextFor(owner), project.id, reviewer, "EDITOR");
  const work = await catalog.createPrivateWorkContext(contextFor(owner), project.id, { name: "revision-work" });
  const resource = await catalog.createResource(contextFor(owner), project.id, { contextId: work.id, path: "revision.md", type: "markdown-document", content: "one\n" });
  const first = await service.submit(contextFor(owner), { projectId: project.id, sourcePrivateContextId: work.id, resourceIds: [resource.id], title: "First" });
  await service.review(contextFor(reviewer), { projectId: project.id, proposalId: first.id, decision: "APPROVE" });
  const current = await catalog.updateResource(contextFor(owner), project.id, resource.id, { contextId: work.id, content: "two\n", expectedRevision: resource.revision });
  const second = await service.revise(contextFor(owner), { projectId: project.id, proposalId: first.id, sourcePrivateContextId: work.id, resourceIds: [resource.id], title: "Second" });
  expect(second.id).not.toBe(first.id);
  expect(second.status).toBe("open");
  expect(second.supersedesProposalId).toBe(first.id);
  expect(second.baseSharedRevision).toBe((await service.get(contextFor(owner), project.id, second.id)).currentSharedRevision);
  expect(second.resources[0]?.content).toBe("two\n");
  expect(second.resources[0]?.sourceRevision).toBe(current.revision);
  expect((await service.reviews(contextFor(owner), project.id, second.id)).reviews).toHaveLength(0);
  expect((await service.reviews(contextFor(owner), project.id, first.id)).reviews).toHaveLength(1);
  expect((await service.get(contextFor(owner), project.id, first.id)).status).toBe("superseded");
  await expect(service.revise(contextFor(owner), { projectId: project.id, proposalId: first.id, sourcePrivateContextId: work.id, resourceIds: [resource.id], title: "Third" })).rejects.toMatchObject({ code: "conflict" });
  expect((await catalog.listResources(contextFor(owner), project.id)).some((item) => item.id === resource.id)).toBe(false);
});

it("withdraws an open proposal without deleting evidence or changing SHARED", async () => {
  const owner = await user("withdraw-owner");
  const reviewer = await user("withdraw-reviewer");
  const project = (await catalog.createProject(contextFor(owner), { name: "Withdrawal", workspaceId: owner })).project;
  await catalog.setMember(contextFor(owner), project.id, reviewer, "EDITOR");
  const work = await catalog.createPrivateWorkContext(contextFor(owner), project.id, { name: "withdraw-work" });
  const resource = await catalog.createResource(contextFor(owner), project.id, { contextId: work.id, path: "withdraw.md", type: "markdown-document", content: "preserved\n" });
  const proposal = await service.submit(contextFor(owner), { projectId: project.id, sourcePrivateContextId: work.id, resourceIds: [resource.id], title: "Withdraw me" });
  await service.review(contextFor(reviewer), { projectId: project.id, proposalId: proposal.id, decision: "APPROVE" });
  const withdrawn = await service.withdraw(contextFor(owner), { projectId: project.id, proposalId: proposal.id, reason: "Superseded by a private redesign." });
  expect(withdrawn.status).toBe("withdrawn");
  expect(withdrawn.withdrawnBy).toBe(owner);
  expect(withdrawn.withdrawalReason).toContain("private redesign");
  expect(withdrawn.resources[0]?.content).toBe("preserved\n");
  expect((await service.reviews(contextFor(owner), project.id, proposal.id)).reviews).toHaveLength(1);
  await expect(service.review(contextFor(reviewer), { projectId: project.id, proposalId: proposal.id, decision: "APPROVE" })).rejects.toMatchObject({ code: "conflict" });
  await expect(service.withdraw(contextFor(owner), { projectId: project.id, proposalId: proposal.id })).rejects.toMatchObject({ code: "conflict" });
  const preview = await promotionService.preview(contextFor(owner), project.id, proposal.id);
  expect(preview.eligible).toBe(false);
  expect(preview.blockers.some((blocker) => blocker.code === "PROPOSAL_WITHDRAWN")).toBe(true);
  await expect(promotionService.execute(contextFor(owner), project.id, proposal.id)).rejects.toMatchObject({ code: "conflict" });
});
