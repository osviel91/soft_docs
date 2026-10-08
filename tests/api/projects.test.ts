/**
 * The project API (ADR-040, ADR-041).
 *
 * What these tests establish is the thing the mission insists on: a request that
 * reaches a project operation is authenticated at the edge, authorized inside the
 * use case, and observable in the audit trail — and the same use case is what
 * MCP will call. The authorization half of the mission's list lives here too,
 * asserted over HTTP rather than only over the catalog.
 */
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../apps/api/config";
import { closeApp, createApp, type AppDependencies } from "../../apps/api/app";
import { createRouter } from "../../apps/api/routes";
import {
  SESSION_COOKIE,
  createSessionToken,
  hashSessionToken,
} from "../../apps/api/context";
import {
  parseCookies,
  parseQuery,
  type ServerRequest,
} from "../../apps/api/http/http";
import { createTestProvider, type TestProvider } from "./test-provider";
import { ALL_PERMISSIONS } from "../../src/domain/access/permissions";
import { createDiscoverSemanticCandidatesUseCase } from "../../src/application/discover-semantic-candidates";

let dependencies: AppDependencies;
let volume: string;
let provider: TestProvider;
let router: ReturnType<typeof createRouter>;

beforeAll(async () => {
  volume = await mkdtemp(path.join(tmpdir(), "sd-project-api-"));
  provider = await createTestProvider();
  dependencies = await createApp(
    loadConfig(
      {
        NODE_ENV: "test",
        COOKIE_SECRET: "c".repeat(48),
        PUBLIC_URL: "http://localhost:4000",
        PROJECT_VOLUME: volume,
        PGLITE_DIR: "memory://",
        OIDC_ISSUER: provider.issuer,
        OIDC_CLIENT_ID: provider.clientId,
        OIDC_CLIENT_SECRET: provider.clientSecret,
        OIDC_REDIRECT_URI: provider.redirectUri,
      },
      { oidcFetch: provider.fetch },
    ),
  );
  router = createRouter(dependencies);
});

afterAll(async () => {
  await closeApp(dependencies);
  await rm(volume, { recursive: true, force: true });
});

let subjectCounter = 0;

/**
 * A signed-in user, with the cookie that identifies them.
 *
 * Created through the real identity path, so the API's own mapping from
 * `(issuer, subject)` to an internal user is what these tests exercise.
 */
async function signIn(): Promise<{
  cookie: string;
  userId: string;
  token: string;
}> {
  subjectCounter += 1;
  const user = await dependencies.users.findOrCreateByExternalIdentity({
    issuer: provider.issuer,
    subject: `api-subject-${subjectCounter}`,
    displayName: `User ${subjectCounter}`,
    email: null,
  });
  const sessionId = crypto.randomUUID();
  const token = createSessionToken(sessionId);
  await dependencies.sessions.create({
    id: sessionId,
    userId: user.id,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(Date.now() + 600_000),
  });
  return {
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    userId: user.id,
    token,
  };
}

/** Build a request, as the Node adapter would. */
function request(
  method: string,
  url: string,
  options: { cookie?: string; body?: unknown } = {},
): ServerRequest {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const queryIndex = url.indexOf("?");
  return {
    method,
    path: queryIndex === -1 ? url : url.slice(0, queryIndex),
    query: parseQuery(queryIndex === -1 ? "" : url.slice(queryIndex)),
    headers,
    cookies: parseCookies(headers.cookie),
    body: options.body === undefined ? null : JSON.stringify(options.body),
  };
}

/** Call a route and parse its JSON body. */
async function call(
  method: string,
  url: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const response = await router.handle(request(method, url, options));
  return {
    status: response.status,
    body: response.body === "" ? null : JSON.parse(response.body),
  };
}

/** Create a project for a fresh user and return both. */
async function aProject(name = "Payments") {
  const user = await signIn();
  const created = await call("POST", "/api/projects", {
    cookie: user.cookie,
    body: { name, workspaceId: user.userId },
  });
  const projectId = created.body.project.id as string;
  const work = await call("POST", `/api/projects/${projectId}/private-work`, {
    cookie: user.cookie,
    body: { name: "api-test-work" },
  });
  return { ...user, projectId, contextId: work.body.context.id as string, created };
}

async function addWorkspaceMember(
  owner: { cookie: string; userId: string },
  memberId: string,
  role: "ADMIN" | "EDITOR" | "VIEWER" = "VIEWER",
): Promise<void> {
  const response = await call(
    "PUT",
    `/api/workspaces/${owner.userId}/members/${memberId}`,
    { cookie: owner.cookie, body: { role } },
  );
  expect(response.status).toBe(200);
}

describe("project routes", () => {
  it("refuses every project route without a session", async () => {
    for (const [method, url] of [
      ["GET", "/api/projects"],
      ["POST", "/api/projects"],
      ["GET", "/api/projects/00000000-0000-7000-8000-000000000001"],
      ["DELETE", "/api/projects/00000000-0000-7000-8000-000000000001"],
    ] as const) {
      const response = await call(method, url, { body: { name: "x" } });
      expect(response.status).toBe(401);
    }
  });

  it("creates a project and lists it with the caller's role", async () => {
    const user = await signIn();
    const created = await call("POST", "/api/projects", {
      cookie: user.cookie,
      body: { name: "Payments Platform", workspaceId: user.userId },
    });
    expect(created.status).toBe(201);
    expect(created.body.project).toMatchObject({
      name: "Payments Platform",
      slug: "payments-platform",
      role: "OWNER",
      resourceCount: 0,
    });

    const listed = await call(
      "GET",
      `/api/projects?workspaceId=${user.userId}`,
      {
        cookie: user.cookie,
      },
    );
    expect(listed.body.projects.map((entry: any) => entry.id)).toContain(
      created.body.project.id,
    );
  });

  it("refuses a body with no name", async () => {
    const user = await signIn();
    const created = await call("POST", "/api/projects", {
      cookie: user.cookie,
      body: { workspaceId: user.userId },
    });
    expect(created.status).toBe(422);
  });

  it("requires a workspace for project listing and creation", async () => {
    const user = await signIn();
    const listed = await call("GET", "/api/projects", { cookie: user.cookie });
    expect(listed.status).toBe(422);

    const created = await call("POST", "/api/projects", {
      cookie: user.cookie,
      body: { name: "No workspace" },
    });
    expect(created.status).toBe(422);
  });

  it("hides another user's project behind a 404, not a 403", async () => {
    const { projectId } = await aProject("Mine");
    const stranger = await signIn();
    const seen = await call("GET", `/api/projects/${projectId}`, {
      cookie: stranger.cookie,
    });
    expect(seen.status).toBe(404);
    expect(seen.body.error.code).toBe("not_found");
  });

  it("renames and deletes a project for its owner", async () => {
    const { cookie, projectId } = await aProject("Before");
    const patched = await call("PATCH", `/api/projects/${projectId}`, {
      cookie,
      body: { name: "After" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.project.name).toBe("After");

    const removed = await call("DELETE", `/api/projects/${projectId}`, {
      cookie,
    });
    expect(removed.status).toBe(204);
    const gone = await call("GET", `/api/projects/${projectId}`, { cookie });
    expect(gone.status).toBe(404);
  });

  it("adds and removes a member, and lets the member read", async () => {
    const owner = await aProject("Shared");
    const member = await signIn();
    await addWorkspaceMember(owner, member.userId);

    const added = await call(
      "PUT",
      `/api/projects/${owner.projectId}/members/${member.userId}`,
      { cookie: owner.cookie, body: { role: "VIEWER" } },
    );
    expect(added.status).toBe(204);

    const seen = await call("GET", `/api/projects/${owner.projectId}`, {
      cookie: member.cookie,
    });
    expect(seen.status).toBe(200);
    expect(seen.body.project.role).toBe("VIEWER");

    const removed = await call(
      "DELETE",
      `/api/projects/${owner.projectId}/members/${member.userId}`,
      { cookie: owner.cookie },
    );
    expect(removed.status).toBe(204);
    const after = await call("GET", `/api/projects/${owner.projectId}`, {
      cookie: member.cookie,
    });
    expect(after.status).toBe(200);
    expect(after.body.project.role).toBe("VIEWER");
  });

  it("refuses an unknown role", async () => {
    const owner = await aProject("Roles");
    const member = await signIn();
    const response = await call(
      "PUT",
      `/api/projects/${owner.projectId}/members/${member.userId}`,
      { cookie: owner.cookie, body: { role: "SUPERUSER" } },
    );
    expect(response.status).toBe(422);
  });

  it("stops an editor from administering membership", async () => {
    const owner = await aProject("Editors");
    const editor = await signIn();
    await addWorkspaceMember(owner, editor.userId);
    await call(
      "PUT",
      `/api/projects/${owner.projectId}/members/${editor.userId}`,
      {
        cookie: owner.cookie,
        body: { role: "EDITOR" },
      },
    );
    const someone = await signIn();
    await addWorkspaceMember(owner, someone.userId);
    const response = await call(
      "PUT",
      `/api/projects/${owner.projectId}/members/${someone.userId}`,
      { cookie: editor.cookie, body: { role: "VIEWER" } },
    );
    expect(response.status).toBe(403);
  });
});

describe("resource routes", () => {
  it("creates, reads, updates, moves and deletes a resource", async () => {
    const { cookie, projectId, contextId } = await aProject("Resources");
    const created = await call("POST", `/api/projects/${projectId}/resources`, {
      cookie,
      body: {
        path: "diagrams/checkout.seq",
        type: "sequence-diagram",
        content: "participant A\nA -> B: hi\n",
        contextId,
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.resource).toMatchObject({
      path: "diagrams/checkout.seq",
      type: "sequence-diagram",
      revision: 1,
    });
    const resourceId = created.body.resource.id;

    const read = await call(
      "GET",
      `/api/projects/${projectId}/resources/${resourceId}?contextId=${contextId}`,
      { cookie },
    );
    expect(read.body.content).toContain("A -> B: hi");
    expect(read.body.resource.revision).toBe(1);

    const updated = await call(
      "PUT",
      `/api/projects/${projectId}/resources/${resourceId}`,
      { cookie, body: { content: "participant A\n", expectedRevision: 1, contextId } },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.resource.revision).toBe(2);

    const moved = await call(
      "POST",
      `/api/projects/${projectId}/resources/${resourceId}/move`,
      { cookie, body: { path: "docs/checkout.seq", expectedRevision: 2, contextId } },
    );
    expect(moved.status).toBe(200);
    expect(moved.body.resource.path).toBe("docs/checkout.seq");

    const removed = await call(
      "DELETE",
      `/api/projects/${projectId}/resources/${resourceId}?contextId=${contextId}`,
      { cookie },
    );
    expect(removed.status).toBe(204);
  });

  it("answers 409 for a stale revision and leaves the content alone", async () => {
    const { cookie, projectId, contextId } = await aProject("Conflicts");
    const created = await call("POST", `/api/projects/${projectId}/resources`, {
      cookie,
      body: { path: "a.seq", type: "sequence-diagram", content: "first", contextId },
    });
    const resourceId = created.body.resource.id;
    await call("PUT", `/api/projects/${projectId}/resources/${resourceId}`, {
      cookie,
      body: { content: "second", expectedRevision: 1, contextId },
    });

    const stale = await call(
      "PUT",
      `/api/projects/${projectId}/resources/${resourceId}`,
      { cookie, body: { content: "third", expectedRevision: 1, contextId } },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("conflict");
    expect(stale.body.error.details).toEqual({
      expectedRevision: 1,
      currentRevision: 2,
    });

    const read = await call(
      "GET",
      `/api/projects/${projectId}/resources/${resourceId}?contextId=${contextId}`,
      { cookie },
    );
    expect(read.body.content).toBe("second");
  });

  it("requires expectedRevision on an update and a move", async () => {
    const { cookie, projectId, contextId } = await aProject("Required revision");
    const created = await call("POST", `/api/projects/${projectId}/resources`, {
      cookie,
      body: { path: "a.seq", type: "sequence-diagram", content: "x", contextId },
    });
    const resourceId = created.body.resource.id;
    for (const [method, url] of [
      ["PUT", `/api/projects/${projectId}/resources/${resourceId}`],
      ["POST", `/api/projects/${projectId}/resources/${resourceId}/move`],
    ] as const) {
      const response = await call(method, url, {
        cookie,
        body: { content: "y", path: "b.seq", contextId },
      });
      expect(response.status).toBe(422);
    }
  });

  it("rejects a traversal path as a request error", async () => {
    const { cookie, projectId, contextId } = await aProject("Traversal API");
    const response = await call(
      "POST",
      `/api/projects/${projectId}/resources`,
      {
        cookie,
        body: { path: "../../etc/passwd", type: "sequence-diagram", contextId },
      },
    );
    expect(response.status).toBe(422);
  });

  it("keeps a viewer out of another user's private work", async () => {
    const owner = await aProject("Viewer API");
    const viewer = await signIn();
    await addWorkspaceMember(owner, viewer.userId);
    await call(
      "PUT",
      `/api/projects/${owner.projectId}/members/${viewer.userId}`,
      {
        cookie: owner.cookie,
        body: { role: "VIEWER" },
      },
    );
    const created = await call(
      "POST",
      `/api/projects/${owner.projectId}/resources`,
      {
        cookie: owner.cookie,
        body: { path: "a.seq", type: "sequence-diagram", content: "x", contextId: owner.contextId },
      },
    );

    const read = await call(
      "GET",
      `/api/projects/${owner.projectId}/resources?contextId=${owner.contextId}`,
      { cookie: viewer.cookie },
    );
    expect(read.status).toBe(404);

    const write = await call(
      "PUT",
      `/api/projects/${owner.projectId}/resources/${created.body.resource.id}`,
      { cookie: viewer.cookie, body: { content: "y", expectedRevision: 1, contextId: owner.contextId } },
    );
    expect(write.status).toBe(403);
  });

  it("lists a resource's revision so a client can thread it", async () => {
    const { cookie, projectId, contextId } = await aProject("Listing");
    await call("POST", `/api/projects/${projectId}/resources`, {
      cookie,
      body: { path: "a.seq", type: "sequence-diagram", content: "x", contextId },
    });
    const listed = await call("GET", `/api/projects/${projectId}/resources?contextId=${contextId}`, { cookie });
    expect(listed.body.resources[0]).toMatchObject({
      path: "a.seq",
      revision: 1,
    });
  });

  it("exposes normalized metadata and preserves it when omitted", async () => {
    const { cookie, projectId, contextId } = await aProject("Metadata API");
    const created = await call("POST", `/api/projects/${projectId}/resources`, {
      cookie,
      body: {
        path: "a.seq",
        type: "sequence-diagram",
        content: "title A\n",
        metadata: { description: "  Checkout flow ", tags: ["Core", " core "] },
        contextId,
      },
    });
    expect(created.body.resource.metadata).toEqual({
      description: "Checkout flow",
      tags: ["Core"],
    });

    const contentOnly = await call(
      "PUT",
      `/api/projects/${projectId}/resources/${created.body.resource.id}`,
      { cookie, body: { content: "title B\n", expectedRevision: 1, contextId } },
    );
    expect(contentOnly.body.resource.metadata).toEqual({
      description: "Checkout flow",
      tags: ["Core"],
    });

    const cleared = await call(
      "PUT",
      `/api/projects/${projectId}/resources/${created.body.resource.id}`,
      {
        cookie,
        body: { content: "title B\n", expectedRevision: 2, metadata: {}, contextId },
      },
    );
    expect(cleared.body.resource).not.toHaveProperty("metadata");
  });
});

describe("read-only project shares", () => {
  it("projects only current SHARED resources and revocation is immediate", async () => {
    const owner = await aProject("Public share");
    const sharedContent = "participant Buyer\n";
    const diagram = await dependencies.projects.createResource(owner.projectId, { path: "architecture/checkout.seq", type: "sequence-diagram" });
    const flow = await dependencies.projects.createResource(owner.projectId, { path: "architecture/checkout.eventseq", type: "event-flow" });
    await dependencies.projects.createResourceRelationship(owner.projectId, { kind: "complementary-view", sourceId: diagram.id, targetId: flow.id });
    const sharedWrite = await dependencies.storageFor(owner.projectId).write("architecture/checkout.seq", sharedContent);
    await dependencies.storageFor(owner.projectId).write("architecture/checkout.eventseq", "event Checkout\nproducer Store\nStore publishes Checkout\n");
    const privateResource = await call("POST", `/api/projects/${owner.projectId}/resources`, {
      cookie: owner.cookie,
      body: { path: "private/notes.md", type: "markdown-document", content: "confidential", contextId: owner.contextId },
    });
    expect(sharedWrite.ok).toBe(true);
    expect(privateResource.status).toBe(201);

    const created = await call("POST", `/api/projects/${owner.projectId}/shares`, { cookie: owner.cookie, body: {} });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^sdshare_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(created.body.grant)).not.toContain("tokenHash");
    const usersBeforePublicRead = await dependencies.users.list();
    const publicRead = await call("GET", `/api/public/projects/shared/${created.body.token}`);
    expect(await dependencies.users.list()).toHaveLength(usersBeforePublicRead.length);
    expect(publicRead.status).toBe(200);
    expect(publicRead.body.project.name).toBe("Public share");
    expect(publicRead.body.resources).toHaveLength(2);
    expect(publicRead.body.resources.find((resource: { path: string }) => resource.path === "architecture/checkout.seq")?.content).toContain("participant Buyer");
    expect(publicRead.body.catalog.relationships).toEqual([{ kind: "complementary-view", sourceId: diagram.id, targetId: flow.id }]);
    expect(publicRead.body.catalog.eventFlows).toHaveLength(1);
    expect(publicRead.body.folders).toEqual(["architecture"]);
    expect(JSON.stringify(publicRead.body)).not.toContain("confidential");
    const publicResponse = await router.handle(request("GET", `/api/public/projects/shared/${created.body.token}`));
    expect(publicResponse.headers).toContainEqual({ name: "cache-control", value: "no-store" });
    expect(publicResponse.headers).toContainEqual({ name: "referrer-policy", value: "no-referrer" });
    await dependencies.storageFor(owner.projectId).write("architecture/checkout.seq", "participant Seller\n");
    const updatedPublicRead = await call("GET", `/api/public/projects/shared/${created.body.token}`);
    expect(updatedPublicRead.body.resources.find((resource: { path: string }) => resource.path === "architecture/checkout.seq")?.content).toContain("participant Seller");

    expect((await call("GET", `/api/projects/${owner.projectId}`)).status).toBe(401);
    expect((await call("GET", `/api/projects/${owner.projectId}/resources`)).status).toBe(401);
    const grants = await call("GET", `/api/projects/${owner.projectId}/shares`, { cookie: owner.cookie });
    expect(grants.status).toBe(200);
    expect(grants.body.grants[0]).not.toHaveProperty("token");
    expect(grants.body.grants[0]).not.toHaveProperty("tokenHash");

    const revoked = await call("DELETE", `/api/projects/${owner.projectId}/shares/${created.body.grant.id}`, { cookie: owner.cookie });
    expect(revoked.status).toBe(200);
    const unavailable = await call("GET", `/api/public/projects/shared/${created.body.token}`);
    expect(unavailable.status).toBe(404);
    expect(unavailable.body).toEqual({ error: { code: "not_found", message: "Shared project is unavailable." } });
    const audit = await dependencies.audit.listForProject(owner.projectId, 50);
    expect(audit.map((entry) => entry.action)).toContain("project.share.created");
    expect(audit.map((entry) => entry.action)).toContain("project.share.revoked");
    expect(JSON.stringify(audit)).not.toContain(created.body.token);
  });
});

describe("the access endpoint", () => {
  it("reports the caller's role and capabilities", async () => {
    const owner = await aProject("Capabilities");
    const access = await call(
      "GET",
      `/api/projects/${owner.projectId}/access`,
      {
        cookie: owner.cookie,
      },
    );
    expect(access.status).toBe(200);
    expect(access.body.role).toBe("OWNER");
    expect(access.body.permissions).toContain("project:delete");
  });

  it("tells a viewer exactly what it cannot do", async () => {
    const owner = await aProject("Viewer capabilities");
    const viewer = await signIn();
    await addWorkspaceMember(owner, viewer.userId);
    await call(
      "PUT",
      `/api/projects/${owner.projectId}/members/${viewer.userId}`,
      {
        cookie: owner.cookie,
        body: { role: "VIEWER" },
      },
    );
    const access = await call(
      "GET",
      `/api/projects/${owner.projectId}/access`,
      {
        cookie: viewer.cookie,
      },
    );
    expect(access.body.role).toBe("VIEWER");
    expect(access.body.permissions).toContain("resource:read");
    expect(access.body.permissions).not.toContain("resource:update");
    expect(access.body.permissions).not.toContain("project:delete");
  });

  it("is invisible to a non-member", async () => {
    const owner = await aProject("Private capabilities");
    const stranger = await signIn();
    const access = await call(
      "GET",
      `/api/projects/${owner.projectId}/access`,
      {
        cookie: stranger.cookie,
      },
    );
    expect(access.status).toBe(404);
  });
});

describe("semantic candidate discovery", () => {
  it("uses the authorized effective view, suppresses bindings, paginates, and does not write", async () => {
    const owner = await aProject("Candidate discovery");
    const other = await signIn();
    await addWorkspaceMember(owner, other.userId);
    const otherContext = await dependencies.runtime.knowledgeContexts.createPrivate({
      projectId: owner.projectId,
      ownerUserId: other.userId,
      name: "other private work",
    });
    const addResource = async (contextId: string | null, resourcePath: string, type: "conceptual" | "database", content: string) => {
      await dependencies.runtime.projects.createResource(owner.projectId, {
        path: resourcePath,
        type,
        ...(contextId === null ? {} : { contextId }),
      });
      await dependencies.runtime.storageForContext(owner.projectId, contextId).write(resourcePath, content);
    };
    await addResource(null, "shared.concept", "conceptual", 'concept account "Account"\nconcept invoice "Invoice"');
    await addResource(null, "shared.dbschema", "database", 'table account - "Account"\ntable invoice - "Invoice"');
    await addResource(owner.contextId, "private.concept", "conceptual", 'concept private "PrivateOnly"');
    await addResource(owner.contextId, "private.dbschema", "database", 'table private - "PrivateOnly"');
    await addResource(otherContext.id, "secret.concept", "conceptual", 'concept secret "SecretLedger"');
    await addResource(otherContext.id, "secret.dbschema", "database", 'table secret - "SecretLedger"');

    const sharedRows = await dependencies.runtime.projects.listResources(owner.projectId, null);
    const accountConcept = { version: 1, resourceId: sharedRows.find((row) => row.path === "shared.concept")!.id, representation: "conceptual", entityKind: "concept", identity: { kind: "local-id", value: "account" } } as const;
    const accountTable = { version: 1, resourceId: sharedRows.find((row) => row.path === "shared.dbschema")!.id, representation: "database", entityKind: "table", identity: { kind: "local-id", value: "account" } } as const;
    await dependencies.runtime.semanticBindings.create({
      id: crypto.randomUUID(),
      projectId: owner.projectId,
      left: accountConcept,
      right: accountTable,
      relation: "represents-in",
      evidence: { version: 1, rationale: "Shared schema and concept are explicitly aligned.", items: [{ kind: "external", reference: "test://alignment", description: "Fixture evidence." }] },
      revision: 1,
      status: "ACTIVE",
      provenance: { authorId: owner.userId, contextId: owner.contextId, createdAt: new Date().toISOString() },
    });

    const resourcesBeforeDiscovery = [
      ...await dependencies.runtime.projects.listResources(owner.projectId, null),
      ...await dependencies.runtime.projects.listResources(owner.projectId, owner.contextId),
    ];
    const bindingsBeforeDiscovery = await dependencies.runtime.semanticBindings.list({ projectId: owner.projectId, contextId: owner.contextId });
    const url = `/api/projects/${owner.projectId}/semantic-candidates?contextId=${owner.contextId}&limit=1`;
    const first = await call("GET", url, { cookie: owner.cookie });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "unconfirmed", context: "SHARED+MY_WORK", total: 2 });
    expect(first.body.nextCursor).toBeTruthy();
    const second = await call("GET", `${url}&cursor=${first.body.nextCursor}`, { cookie: owner.cookie });
    expect(second.status).toBe(200);
    const pagedIds = [...first.body.candidates, ...second.body.candidates].map((candidate: { id: string }) => candidate.id);
    expect(new Set(pagedIds).size).toBe(2);
    expect([...first.body.candidates, ...second.body.candidates].map((candidate: { leftPath: string }) => candidate.leftPath).sort()).toEqual(["private.concept", "shared.concept"]);
    expect([...first.body.candidates, ...second.body.candidates].some((candidate: { leftPath: string }) => candidate.leftPath === "secret.concept")).toBe(false);

    const shared = await call("GET", `/api/projects/${owner.projectId}/semantic-candidates`, { cookie: owner.cookie });
    expect(shared.body.total).toBe(2);
    expect(shared.body.candidates.every((candidate: { leftPath: string }) => candidate.leftPath.startsWith("shared."))).toBe(true);
    const contextResponse = await call("GET", `/api/projects/${owner.projectId}/semantic-candidates?contextId=${otherContext.id}`, { cookie: owner.cookie });
    expect(contextResponse.status).toBe(404);
    expect(JSON.stringify(contextResponse.body)).not.toContain("SecretLedger");

    const appContext = {
      requestId: "discovery-test",
      principal: { subjectUserId: owner.userId, actor: { kind: "user" as const, userId: owner.userId }, authType: "session" as const, scopes: [...ALL_PERMISSIONS] },
    };
    const commonResult = await createDiscoverSemanticCandidatesUseCase(dependencies.catalog)(appContext, { projectId: owner.projectId });
    expect(commonResult).toEqual(shared.body);
    expect([
      ...await dependencies.runtime.projects.listResources(owner.projectId, null),
      ...await dependencies.runtime.projects.listResources(owner.projectId, owner.contextId),
    ]).toEqual(resourcesBeforeDiscovery);
    expect(await dependencies.runtime.semanticBindings.list({ projectId: owner.projectId, contextId: owner.contextId })).toEqual(bindingsBeforeDiscovery);
  });
});

describe("the audit trail over HTTP", () => {
  it("records what a session did, with the correlation id and no secrets", async () => {
    const user = await signIn();
    const created = await call("POST", "/api/projects", {
      cookie: user.cookie,
      body: { name: "Audited API", workspaceId: user.userId },
    });
    const projectId = created.body.project.id;
    const work = await call("POST", `/api/projects/${projectId}/private-work`, {
      cookie: user.cookie,
      body: { name: "audit-work" },
    });
    const contextId = work.body.context.id;
    const resource = await call(
      "POST",
      `/api/projects/${projectId}/resources`,
      {
        cookie: user.cookie,
        body: { path: "a.seq", type: "sequence-diagram", content: "x", contextId },
      },
    );
    await call(
      "PUT",
      `/api/projects/${projectId}/resources/${resource.body.resource.id}`,
      { cookie: user.cookie, body: { content: "y", expectedRevision: 1, contextId } },
    );

    const entries = await dependencies.audit.listForProject(projectId, 50);
    const actions = entries.map((entry) => entry.action);
    expect(actions).toContain("project.created");
    expect(actions).toContain("resource.created");
    expect(actions).toContain("resource.updated");
    for (const entry of entries) {
      expect(entry.subjectUserId).toBe(user.userId);
      expect(entry.authType).toBe("session");
      expect(entry.requestId).toBeTruthy();
    }
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(user.token);
    expect(serialized).not.toContain("Bearer");
  });
});
