// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPgliteClient } from "../../src/persistence/pglite-client";
import { MIGRATIONS, migrate } from "../../src/persistence/migrate";
import { createUserRepository } from "../../src/persistence/user-repository";
import { createWorkspaceRepository } from "../../src/persistence/workspace-repository";
import { createProjectRepository } from "../../src/persistence/project-repository";
import { createKnowledgeContextRepository } from "../../src/persistence/knowledge-context-repository";
import { createArchitecturalProposalRepository } from "../../src/persistence/architectural-proposal-repository";
import { createProposalReviewRepository } from "../../src/persistence/proposal-review-repository";
import { createWorkspaceOperationRepository } from "../../src/persistence/workspace-operation-repository";
import { createAuthoritativeBatchRepository } from "../../src/persistence/authoritative-batch-repository";
import { createPromotionRepository } from "../../src/persistence/promotion-repository";
import { createFsProjectStorage } from "../../src/persistence/fs-project-storage";
import { createProjectCatalog } from "../../src/application/project-catalog";
import { createArchitecturalProposalService } from "../../src/application/architectural-proposal-service";
import { createProjectBootstrapService } from "../../src/application/project-bootstrap-service";
import { createPromotionService } from "../../src/application/promotion-service";
import { createAuthorizationPolicy } from "../../src/application/authorization";
import { ALL_PERMISSIONS } from "../../src/domain/access/permissions";
import type { ApplicationContext } from "../../src/application/context";
import type { SqlClient } from "../../src/persistence/sql-client";

let client: SqlClient;
let volume: string;

const contextFor = (id: string): ApplicationContext => ({
  requestId: "proposal-upgrade-test",
  principal: { subjectUserId: id, actor: { kind: "user", userId: id }, authType: "session", scopes: ALL_PERMISSIONS },
});

beforeAll(async () => {
  client = await createPgliteClient();
  volume = await mkdtemp(path.join(tmpdir(), "sd-proposal-upgrade-"));
  await migrate(client, MIGRATIONS.slice(0, 22));
  await migrate(client);
});

afterAll(async () => {
  await client.close();
  await rm(volume, { recursive: true, force: true });
});

it("creates, reviews, promotes, and restarts after a 0022-to-current upgrade", async () => {
  const projects = createProjectRepository(client);
  const users = createUserRepository(client);
  const knowledgeContexts = createKnowledgeContextRepository(client);
  const architecturalProposals = createArchitecturalProposalRepository(client);
  const reviews = createProposalReviewRepository(client);
  const storage = (projectId: string, contextId?: string | null) => createFsProjectStorage({ root: path.join(volume, projectId, contextId ? ".private" : "", contextId ?? "") });
  const catalog = createProjectCatalog({
    projects,
    workspaces: createWorkspaceRepository(client),
    knowledgeContexts,
    operations: createWorkspaceOperationRepository(client),
    storage,
    architecturalProposals,
  });
  const proposalService = createArchitecturalProposalService({ proposals: architecturalProposals, projects, knowledgeContexts, reviews, storage: (projectId) => createFsProjectStorage({ root: path.join(volume, projectId) }) });
  const promotionService = createPromotionService({
    proposals: architecturalProposals,
    projects,
    reviews,
    batches: createAuthoritativeBatchRepository(client),
    promotions: createPromotionRepository(client),
    storage: (projectId) => createFsProjectStorage({ root: path.join(volume, projectId) }),
    policy: createAuthorizationPolicy(projects),
  });
  const bootstrap = createProjectBootstrapService({
    projects,
    batches: createAuthoritativeBatchRepository(client),
    storage: (projectId) => createFsProjectStorage({ root: path.join(volume, projectId) }),
    createProject: (context, input) => catalog.createProject(context, input),
    policy: createAuthorizationPolicy(projects),
  });

  const owner = (await users.findOrCreateByExternalIdentity({ issuer: "upgrade-test", subject: "owner", displayName: "Owner", email: null })).id;
  const reviewer = (await users.findOrCreateByExternalIdentity({ issuer: "upgrade-test", subject: "reviewer", displayName: "Reviewer", email: null })).id;
  const workspaces = createWorkspaceRepository(client);
  await workspaces.setMember(owner, owner, "ADMIN");
  await workspaces.setMember(owner, reviewer, "EDITOR");
  const ownerContext = contextFor(owner);
  const reviewerContext = contextFor(reviewer);
  const project = await bootstrap.bootstrap(ownerContext, {
    workspaceId: owner,
    name: "Upgrade Proposal",
    resources: [{ path: "shared.md", type: "markdown-document", content: "shared\n" }],
  });
  await catalog.setMember(ownerContext, project.id, reviewer, "EDITOR");
  const work = await catalog.createPrivateWorkContext(ownerContext, project.id, { name: "candidate" });
  const candidate = await catalog.createResource(ownerContext, project.id, { contextId: work.id, path: "shared.md", type: "markdown-document", content: "updated\n" });
  const proposal = await proposalService.submit(ownerContext, {
    projectId: project.id,
    sourcePrivateContextId: work.id,
    resourceIds: [candidate.id],
    title: "Upgraded proposal",
  });

  await expect(proposalService.get(ownerContext, project.id, proposal.id)).resolves.toMatchObject({ id: proposal.id, baseManifestRevision: 0 });
  await proposalService.review(reviewerContext, { projectId: project.id, proposalId: proposal.id, decision: "APPROVE" });
  const promotion = await promotionService.execute(ownerContext, project.id, proposal.id, "upgrade-promotion");
  expect(promotion.status).toBe("COMPLETED");
  const work2 = await catalog.createPrivateWorkContext(ownerContext, project.id, { name: "candidate-2" });
  const candidate2 = await catalog.createResource(ownerContext, project.id, { contextId: work2.id, path: "second.md", type: "markdown-document", content: "second\n" });
  const proposal2 = await proposalService.submit(ownerContext, { projectId: project.id, sourcePrivateContextId: work2.id, resourceIds: [candidate2.id], title: "Manifest-base proposal" });
  await expect(proposalService.get(ownerContext, project.id, proposal2.id)).resolves.toMatchObject({ baseManifestRevision: 1 });
  await proposalService.review(reviewerContext, { projectId: project.id, proposalId: proposal2.id, decision: "APPROVE" });
  const sharedStorage = createFsProjectStorage({ root: path.join(volume, project.id) });
  const manifest = await sharedStorage.read("project.json");
  if (!manifest.ok || !manifest.value) throw new Error("Missing upgraded project manifest.");
  await sharedStorage.write("project.json", JSON.stringify({ ...JSON.parse(manifest.value.content), manifestRevision: 2, semanticMessages: [{ id: crypto.randomUUID(), name: "Changed", kind: "event" }] }, null, 2));
  const preview = await promotionService.preview(ownerContext, project.id, proposal2.id);
  expect(preview.blockers).toEqual(expect.arrayContaining([{ code: "STALE_MANIFEST", message: "The semantic manifest changed since this proposal was submitted." }]));
  expect((await migrate(client)).applied).toEqual([]);
});
