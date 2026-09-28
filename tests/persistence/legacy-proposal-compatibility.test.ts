// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPgliteClient } from "../../src/persistence/pglite-client";
import { MIGRATIONS, migrate } from "../../src/persistence/migrate";
import { createProjectRepository } from "../../src/persistence/project-repository";
import { createWorkspaceRepository } from "../../src/persistence/workspace-repository";
import { createKnowledgeContextRepository } from "../../src/persistence/knowledge-context-repository";
import { createArchitecturalProposalRepository } from "../../src/persistence/architectural-proposal-repository";
import { createProposalReviewRepository } from "../../src/persistence/proposal-review-repository";
import { createWorkspaceOperationRepository } from "../../src/persistence/workspace-operation-repository";
import { createAuthoritativeBatchRepository } from "../../src/persistence/authoritative-batch-repository";
import { createPromotionRepository } from "../../src/persistence/promotion-repository";
import { createFsProjectStorage } from "../../src/persistence/fs-project-storage";
import { createProjectCatalog } from "../../src/application/project-catalog";
import { createArchitecturalProposalService } from "../../src/application/architectural-proposal-service";
import { createPromotionService } from "../../src/application/promotion-service";
import { createAuthorizationPolicy } from "../../src/application/authorization";
import { ALL_PERMISSIONS } from "../../src/domain/access/permissions";
import { testUuid } from "./test-database";
import type { ApplicationContext } from "../../src/application/context";
import type { SqlClient } from "../../src/persistence/sql-client";

let client: SqlClient;
let volume: string;
const ownerId = testUuid(950);
const reviewerId = testUuid(951);
let fixtureCounter = 0;
const contextFor = (id: string): ApplicationContext => ({ requestId: "legacy-proposal-compatibility", principal: { subjectUserId: id, actor: { kind: "user", userId: id }, authType: "session", scopes: ALL_PERMISSIONS } });

beforeAll(async () => {
  client = await createPgliteClient();
  volume = await mkdtemp(path.join(tmpdir(), "sd-legacy-proposals-"));
  await migrate(client, MIGRATIONS.slice(0, 22));
  await client.query("INSERT INTO users (id, display_name) VALUES ($1, 'Legacy Owner'), ($2, 'Legacy Reviewer')", [ownerId, reviewerId]);
  await client.query("INSERT INTO user_identities (user_id, issuer, subject) VALUES ($1, 'legacy-test', 'owner'), ($2, 'legacy-test', 'reviewer')", [ownerId, reviewerId]);
  await client.query("INSERT INTO workspaces (id, owner_id, name, is_default) VALUES ($1, $1, 'Legacy Workspace', true)", [ownerId]);
  await client.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $1, 'ADMIN'), ($1, $2, 'EDITOR')", [ownerId, reviewerId]);
});

afterAll(async () => { await client.close(); await rm(volume, { recursive: true, force: true }); });

it("preserves legacy category A/B behavior and rejects unsupported semantic edits", async () => {
  const projects = createProjectRepository(client);
  const knowledgeContexts = createKnowledgeContextRepository(client);
  const proposals = createArchitecturalProposalRepository(client);
  const storage = (projectId: string, contextId?: string | null) => createFsProjectStorage({ root: path.join(volume, projectId, ...(contextId ? [".private", contextId] : [])) });
  const catalog = createProjectCatalog({ projects, workspaces: createWorkspaceRepository(client), knowledgeContexts, operations: createWorkspaceOperationRepository(client), storage, architecturalProposals: proposals });
  const ownerContext = contextFor(ownerId);
  const reviewerContext = contextFor(reviewerId);
  const reviewRepository = createProposalReviewRepository(client);
  const proposalService = createArchitecturalProposalService({ proposals, projects, knowledgeContexts, reviews: reviewRepository });
  const promotionService = createPromotionService({ proposals, projects, reviews: reviewRepository, batches: createAuthoritativeBatchRepository(client), promotions: createPromotionRepository(client), storage: (projectId) => storage(projectId), policy: createAuthorizationPolicy(projects) });

  const createLegacyFixture = async (name: string, semantic: boolean) => {
    fixtureCounter += 1;
    const project = (await catalog.createProject(ownerContext, { name, workspaceId: ownerId })).project;
    await catalog.setMember(ownerContext, project.id, reviewerId, "EDITOR");
    const shared = await projects.createResource(project.id, { path: "shared.md", type: "markdown-document" });
    const work = await catalog.createPrivateWorkContext(ownerContext, project.id, { name: "legacy-work" });
    const candidate = await catalog.createResource(ownerContext, project.id, { contextId: work.id, path: semantic ? "new.md" : "shared.md", type: "markdown-document", content: semantic ? "new\n" : "updated\n" });
    const message = semantic ? await knowledgeContexts.createPrivateMessage({ projectId: project.id, contextId: work.id, id: testUuid(960 + fixtureCounter), name: "LegacyEvent", kind: "event" }) : null;
    const manifest = { resources: [{ id: shared.id, path: shared.path, type: shared.type, title: shared.path }], semanticMessages: [], relationships: [], manifestRevision: 1 };
    await storage(project.id).write(shared.path, "shared\n");
    await storage(project.id).write("project.json", JSON.stringify(manifest, null, 2));
    const base = await proposals.currentSharedRevision(project.id);
    const proposalId = testUuid(980 + fixtureCounter);
    await client.query(
      `INSERT INTO architectural_proposals (id, project_id, author_user_id, source_private_context_id, title, base_shared_revision, base_shared_resource_revisions)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [proposalId, project.id, ownerId, work.id, name, base.revision, JSON.stringify(base.resources)],
    );
    await client.query(
      `INSERT INTO architectural_proposal_resources (proposal_id, source_resource_id, path, type, source_revision, content, metadata, operation, base_resource_id, base_revision)
       VALUES ($1, $2, $3, $4, 1, $5, '{}'::jsonb, $6, $7, $8)`,
      [proposalId, candidate.id, candidate.path, candidate.type, semantic ? "new\n" : "updated\n", semantic ? "CREATE" : "UPDATE", semantic ? null : shared.id, semantic ? null : shared.revision],
    );
    if (message) await client.query("INSERT INTO architectural_proposal_messages (proposal_id, message_id, name, kind, source_context_id) VALUES ($1, $2, $3, $4, $5)", [proposalId, message.id, message.name, message.kind, work.id]);
    return { projectId: project.id, proposalId, messageId: message?.id };
  };

  const categoryA = await createLegacyFixture("Legacy Resource Proposal", false);
  const categoryB = await createLegacyFixture("Legacy Semantic Addition", true);
  await migrate(client);

  for (const fixture of [categoryA, categoryB]) {
    const proposal = await proposalService.get(ownerContext, fixture.projectId, fixture.proposalId);
    expect(proposal.baseManifestRevision).toBeNull();
    await proposalService.review(reviewerContext, { projectId: fixture.projectId, proposalId: fixture.proposalId, decision: "APPROVE" });
  }
  const categoryAPreview = await promotionService.preview(ownerContext, categoryA.projectId, categoryA.proposalId);
  expect(categoryAPreview.blockers).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "STALE_MANIFEST" })]));
  await expect(promotionService.execute(ownerContext, categoryA.projectId, categoryA.proposalId, "legacy-a-promotion")).resolves.toMatchObject({ status: "COMPLETED" });
  const categoryBPreview = await promotionService.preview(ownerContext, categoryB.projectId, categoryB.proposalId);
  expect(categoryBPreview.blockers).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "STALE_MANIFEST" })]));
  await expect(promotionService.execute(ownerContext, categoryB.projectId, categoryB.proposalId, "legacy-b-promotion")).resolves.toMatchObject({ status: "COMPLETED" });

  const categoryC = await createLegacyFixture("Legacy Unsupported Semantic Edit", true);
  await client.query("UPDATE architectural_proposal_messages SET operation = 'UPDATE' WHERE proposal_id = $1", [categoryC.proposalId]);
  await proposalService.review(reviewerContext, { projectId: categoryC.projectId, proposalId: categoryC.proposalId, decision: "APPROVE" });
  const categoryCPreview = await promotionService.preview(ownerContext, categoryC.projectId, categoryC.proposalId);
  expect(categoryCPreview.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "LEGACY_SEMANTIC_REBASE_REQUIRED" })]));
  expect(await createPromotionRepository(client).getForProposal(categoryC.projectId, categoryC.proposalId)).toBeNull();
});
