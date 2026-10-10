// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { openTestDatabase, closeTestDatabase } from "./test-database";
import { createProposalInboxRepository } from "../../src/persistence/proposal-inbox-repository";
import { createUserRepository } from "../../src/persistence/user-repository";
import type { SqlClient } from "../../src/persistence/sql-client";

let db: SqlClient;
let user: string;
let author: string;
let otherUser: string;
const workspace = "20000000-0000-4000-8000-000000000001";
const hiddenWorkspace = "20000000-0000-4000-8000-000000000002";
const project = "30000000-0000-4000-8000-000000000001";
const hiddenProject = "30000000-0000-4000-8000-000000000002";
const context = "40000000-0000-4000-8000-000000000001";
const hiddenContext = "40000000-0000-4000-8000-000000000002";
const proposalIds = ["50000000-0000-4000-8000-000000000001", "50000000-0000-4000-8000-000000000002", "50000000-0000-4000-8000-000000000003"];

beforeAll(async () => {
  db = await openTestDatabase();
  const users = createUserRepository(db);
  user = (await users.findOrCreateByExternalIdentity({ issuer: "test", subject: "reader", displayName: "Reader", email: null })).id;
  author = (await users.findOrCreateByExternalIdentity({ issuer: "test", subject: "author", displayName: "Author", email: null })).id;
  otherUser = (await users.findOrCreateByExternalIdentity({ issuer: "test", subject: "other", displayName: "Other", email: null })).id;
  await db.query("INSERT INTO workspaces (id, owner_id, name) VALUES ($1, $2, 'Visible Workspace'), ($3, $4, 'Hidden Workspace')", [workspace, author, hiddenWorkspace, otherUser]);
  await db.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'VIEWER'), ($3, $4, 'ADMIN')", [workspace, user, hiddenWorkspace, otherUser]);
  await db.query("INSERT INTO projects (id, owner_id, workspace_id, name, slug) VALUES ($1, $2, $3, 'Visible Project', 'visible'), ($4, $5, $6, 'Hidden Project', 'hidden')", [project, author, workspace, hiddenProject, otherUser, hiddenWorkspace]);
  await db.query("INSERT INTO knowledge_contexts (id, project_id, owner_user_id, name) VALUES ($1, $2, $3, 'work'), ($4, $5, $6, 'work')", [context, project, author, hiddenContext, hiddenProject, otherUser]);
  await db.query(`INSERT INTO architectural_proposals (id, project_id, author_user_id, source_private_context_id, title, base_shared_revision, base_shared_resource_revisions, submitted_at)
    VALUES ($1, $2, $3, $4, 'Review me', 'base', '{}'::jsonb, '2026-01-03T00:00:00Z'),
           ($5, $2, $3, $4, 'Approved change', 'base', '{}'::jsonb, '2026-01-02T00:00:00Z'),
           ($6, $7, $8, $9, 'Hidden proposal', 'base', '{}'::jsonb, '2026-01-04T00:00:00Z')`, [proposalIds[0], project, author, context, proposalIds[1], proposalIds[2], hiddenProject, otherUser, hiddenContext]);
  await db.query("INSERT INTO architectural_proposal_reviews (id, proposal_id, reviewer_user_id, decision, proposal_base_revision, observed_shared_revision, created_at, updated_at) VALUES ('60000000-0000-4000-8000-000000000001', $1, $2, 'APPROVE', 'base', 'base', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')", [proposalIds[1], user]);
});

afterAll(async () => { await closeTestDatabase(db); });

it("filters to live workspace access, derives review categories and pages deterministically", async () => {
  const repository = createProposalInboxRepository(db);
  const input = { userId: user, allowedProjectIds: null, filters: { limit: 1 } };
  const first = await repository.query(input);
  expect(first.items.map((item) => item.proposalId)).toEqual([proposalIds[0]]);
  expect(first.items[0]).toMatchObject({ attentionCategory: "PENDING_REVIEW", workspace: { name: "Visible Workspace" }, project: { name: "Visible Project" } });
  expect(first.counts.PENDING_REVIEW).toBe(1);
  expect(first.counts.APPROVED_PENDING_PROMOTION).toBe(1);
  expect(first.items.some((item) => item.proposalId === proposalIds[2])).toBe(false);
  expect(first.hasMore).toBe(true);

  const next = await repository.query({ ...input, after: first.nextPosition! });
  expect(next.items.map((item) => item.proposalId)).toEqual([proposalIds[1]]);
  expect(next.items[0]?.attentionCategory).toBe("APPROVED_PENDING_PROMOTION");
});

it("pages through microsecond timestamps and timestamp ties without omissions or duplicates", async () => {
  const ids = [4, 5, 6, 7].map((n) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
  await db.query(`INSERT INTO architectural_proposals (id, project_id, author_user_id, source_private_context_id, title, base_shared_revision, base_shared_resource_revisions, submitted_at)
    VALUES ($1, $5, $6, $7, 'fraction .123456', 'base', '{}'::jsonb, '2026-02-01T00:00:00.123456Z'),
           ($2, $5, $6, $7, 'tie lower id', 'base', '{}'::jsonb, '2026-02-01T00:00:00.123457Z'),
           ($3, $5, $6, $7, 'tie higher id', 'base', '{}'::jsonb, '2026-02-01T00:00:00.123457Z'),
           ($4, $5, $6, $7, 'fraction .123458', 'base', '{}'::jsonb, '2026-02-01T00:00:00.123458Z')`, [...ids, project, author, context]);
  const repository = createProposalInboxRepository(db);

  for (const limit of [1, 2]) {
    const collected: string[] = [];
    let after: { at: string; id: string } | undefined;
    let page = await repository.query({ userId: user, allowedProjectIds: null, filters: { limit } });
    let hasMore = true;
    while (hasMore) {
      collected.push(...page.items.filter((item) => ids.includes(item.proposalId)).map((item) => item.proposalId));
      hasMore = page.hasMore;
      if (!hasMore) continue;
      const preciseCursor = page.nextPosition!;
      const expectedPrecision = new Map([[ids[3], ".123458Z"], [ids[2], ".123457Z"], [ids[1], ".123457Z"], [ids[0], ".123456Z"]]);
      if (expectedPrecision.has(preciseCursor.id)) expect(preciseCursor.at).toContain(expectedPrecision.get(preciseCursor.id));
      after = page.nextPosition!;
      page = await repository.query({ userId: user, allowedProjectIds: null, filters: { limit }, after });
    }
    expect(collected).toEqual([ids[3], ids[2], ids[1], ids[0]]);
  }
});

it("derives every exclusive category and counts mixed reviews as changes requested", async () => {
  const ids = [8, 9, 10, 11, 12, 13].map((n) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
  await db.query(`INSERT INTO architectural_proposals (id, project_id, author_user_id, source_private_context_id, title, base_shared_revision, status, submitted_at)
    SELECT id, $2, $3, $4, 'category fixture', 'base', 'open', '2026-03-01T00:00:00Z'
      FROM unnest($1::uuid[]) AS id`, [ids, project, author, context]);
  await db.query("UPDATE architectural_proposals SET status = 'withdrawn', withdrawn_at = now() WHERE id = $1", [ids[4]]);
  await db.query("UPDATE architectural_proposals SET status = 'superseded', superseded_at = now() WHERE id = $1", [ids[5]]);
  await db.query(`INSERT INTO architectural_proposal_reviews (id, proposal_id, reviewer_user_id, decision, proposal_base_revision, observed_shared_revision)
    VALUES ('60000000-0000-4000-8000-000000000008', $1, $3, 'REQUEST_CHANGES', 'base', 'base'),
           ('60000000-0000-4000-8000-000000000009', $2, $3, 'REQUEST_CHANGES', 'base', 'base'),
           ('60000000-0000-4000-8000-000000000010', $2, $4, 'APPROVE', 'base', 'base')`, [ids[0], ids[1], user, otherUser]);
  await db.query(`INSERT INTO promotions (id, project_id, proposal_id, actor, base_shared_revision, resulting_shared_revision, status, created_at, completed_at)
    VALUES ('70000000-0000-4000-8000-000000000010', $1, $2, '{}'::jsonb, 'base', 'next', 'COMMITTED_COMPLETION_PENDING', '2026-03-02T00:00:00Z', NULL),
           ('70000000-0000-4000-8000-000000000011', $1, $3, '{}'::jsonb, 'base', 'next', 'COMPLETED', '2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z')`, [project, ids[2], ids[3]]);

  const result = await createProposalInboxRepository(db).query({ userId: user, allowedProjectIds: null, filters: { projectId: project, limit: 100 } });
  expect(result.items.filter((item) => ids.includes(item.proposalId)).map((item) => item.attentionCategory).sort()).toEqual([
    "CHANGES_REQUESTED", "CHANGES_REQUESTED", "PROMOTION_COMPLETION_PENDING", "PROMOTED", "SUPERSEDED", "WITHDRAWN",
  ].sort());
  expect(result.counts.CHANGES_REQUESTED).toBe(2);
  expect(result.counts.PROMOTION_COMPLETION_PENDING).toBe(1);
  expect(result.counts.PROMOTED).toBe(1);
  expect(result.counts.WITHDRAWN).toBe(1);
  expect(result.counts.SUPERSEDED).toBe(1);
  expect(result.items.find((item) => item.proposalId === ids[1])?.review.status).toBe("mixed");
  expect(result.items.find((item) => item.proposalId === ids[2])?.lifecycle).toBe("PROMOTING");

  const statusAndSearch = { projectId: project, status: ["open" as const], search: "category fixture", limit: 100 };
  const scoped = await createProposalInboxRepository(db).query({ userId: user, allowedProjectIds: null, filters: statusAndSearch });
  const oneBucket = await createProposalInboxRepository(db).query({ userId: user, allowedProjectIds: null, filters: { ...statusAndSearch, attentionCategory: ["PROMOTED"], limit: 1 } });
  expect(oneBucket.items).toHaveLength(1);
  expect(oneBucket.items[0]?.attentionCategory).toBe("PROMOTED");
  expect(oneBucket.counts).toEqual(scoped.counts);
  expect(oneBucket.counts.WITHDRAWN).toBe(0);
  expect(oneBucket.counts.SUPERSEDED).toBe(0);
});

it("runs the inbox as one SQL query and produces an analyzed plan at 1,000 proposals", async () => {
  await db.query(`INSERT INTO architectural_proposals (id, project_id, author_user_id, source_private_context_id, title, base_shared_revision, submitted_at)
    SELECT ('80000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, $1, $2, $3, 'plan fixture', 'base', now() - (n || ' seconds')::interval
      FROM generate_series(1, 1000) AS n`, [project, author, context]);
  const statements: Array<{ sql: string; params?: readonly import("../../src/persistence/sql-client").SqlValue[] }> = [];
  const recording = {
    query: async (sql: string, params?: readonly import("../../src/persistence/sql-client").SqlValue[]) => {
      statements.push({ sql, params });
      return db.query(sql, params);
    },
    transaction: db.transaction.bind(db),
    close: db.close.bind(db),
  } as unknown as SqlClient;
  await createProposalInboxRepository(recording).query({ userId: user, allowedProjectIds: null, filters: { projectId: project, limit: 50 } });
  expect(statements).toHaveLength(1);
  const plan = await db.query(`EXPLAIN (ANALYZE, FORMAT TEXT) ${statements[0]!.sql}`, statements[0]!.params);
  expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain("Execution Time");
});
