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

let dependencies: AppDependencies;
let provider: TestProvider;
let volume: string;

beforeAll(async () => {
  volume = await mkdtemp(path.join(tmpdir(), "sd-workspace-api-"));
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
});

afterAll(async () => {
  await closeApp(dependencies);
  await rm(volume, { recursive: true, force: true });
});

function request(
  method: string,
  url: string,
  cookie: string,
  body?: unknown,
): ServerRequest {
  const queryIndex = url.indexOf("?");
  return {
    method,
    path: queryIndex === -1 ? url : url.slice(0, queryIndex),
    query: parseQuery(queryIndex === -1 ? "" : url.slice(queryIndex)),
    headers: {
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    cookies: parseCookies(cookie),
    body: body === undefined ? null : JSON.stringify(body),
  };
}

async function signIn(): Promise<{ cookie: string; userId: string }> {
  const user = await dependencies.users.findOrCreateByExternalIdentity({
    issuer: provider.issuer,
    subject: crypto.randomUUID(),
    displayName: "Ada",
    email: "ada@example.test",
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
  };
}

describe("workspace lifecycle API", () => {
  it("separates member workspaces from the platform policy catalog", async () => {
    const router = createRouter(dependencies);
    const owner = await signIn();
    const memberAdmin = await signIn();
    const editor = await signIn();
    const viewer = await signIn();
    const platformAdmin = await signIn();
    const workspaceResponse = await router.handle(request("POST", "/api/workspaces", owner.cookie, { name: "Private workspace" }));
    const workspaceId = JSON.parse(workspaceResponse.body).workspace.id as string;

    for (const [user, role] of [[memberAdmin, "ADMIN"], [editor, "EDITOR"], [viewer, "VIEWER"]] as const) {
      expect((await router.handle(request("PUT", `/api/workspaces/${workspaceId}/members/${user.userId}`, owner.cookie, { role }))).status).toBe(200);
    }
    await dependencies.sql.query("UPDATE users SET platform_admin = true WHERE id = $1", [platformAdmin.userId]);

    for (const [user, role] of [[owner, "ADMIN"], [memberAdmin, "ADMIN"], [editor, "EDITOR"], [viewer, "VIEWER"]] as const) {
      const listed = await router.handle(request("GET", "/api/workspaces", user.cookie));
      const workspaces = JSON.parse(listed.body).workspaces as Array<{ id: string; role: string }>;
      expect(workspaces.find((workspace) => workspace.id === workspaceId)?.role).toBe(role);
    }

    const platformList = await router.handle(request("GET", "/api/workspaces", platformAdmin.cookie));
    expect(JSON.parse(platformList.body).workspaces.map((workspace: { id: string }) => workspace.id)).not.toContain(workspaceId);

    const deniedAdminCatalog = await router.handle(request("GET", "/api/admin/workspaces", owner.cookie));
    expect(deniedAdminCatalog.status).toBe(403);
    const adminCatalog = await router.handle(request("GET", "/api/admin/workspaces", platformAdmin.cookie));
    expect(adminCatalog.status).toBe(200);
    const adminWorkspace = JSON.parse(adminCatalog.body).workspaces.find((workspace: { id: string }) => workspace.id === workspaceId);
    expect(adminWorkspace).toEqual({ id: workspaceId, name: "Private workspace", allowAuthorSelfReview: false });

    const hiddenProjects = await router.handle(request("GET", `/api/projects?workspaceId=${workspaceId}`, platformAdmin.cookie));
    expect(hiddenProjects.status).toBe(404);
    expect(JSON.parse(hiddenProjects.body).error.code).toBe("not_found");
    const policyUpdate = await router.handle(request("PATCH", `/api/admin/workspaces/${workspaceId}/self-review`, platformAdmin.cookie, { allowed: true }));
    expect(policyUpdate.status).toBe(204);
    expect(await dependencies.workspaces.authorSelfReviewAllowed(workspaceId)).toBe(true);

    expect((await router.handle(request("DELETE", `/api/workspaces/${workspaceId}/members/${viewer.userId}`, owner.cookie))).status).toBe(204);
    const afterRevocation = await router.handle(request("GET", "/api/workspaces", viewer.cookie));
    expect(JSON.parse(afterRevocation.body).workspaces.map((workspace: { id: string }) => workspace.id)).not.toContain(workspaceId);
    expect((await router.handle(request("GET", `/api/projects?workspaceId=${workspaceId}`, viewer.cookie))).status).toBe(404);

    const platformJoined = await router.handle(request("PUT", `/api/workspaces/${workspaceId}/members/${platformAdmin.userId}`, owner.cookie, { role: "VIEWER" }));
    expect(platformJoined.status).toBe(200);
    const platformMemberList = await router.handle(request("GET", "/api/workspaces", platformAdmin.cookie));
    expect(JSON.parse(platformMemberList.body).workspaces.find((workspace: { id: string }) => workspace.id === workspaceId)).toMatchObject({ id: workspaceId, role: "VIEWER" });
  });

  it("creates, previews, and accepts a single-use workspace link via sessions", async () => {
    const router = createRouter(dependencies);
    const owner = await signIn();
    const guest = await signIn();
    const created = await router.handle(request("POST", "/api/workspaces", owner.cookie, { name: "Invite target" }));
    const workspaceId = JSON.parse(created.body).workspace.id as string;
    const projectResponse = await router.handle(request("POST", "/api/projects", owner.cookie, { name: "Invite-visible project", workspaceId }));
    const projectId = JSON.parse(projectResponse.body).project.id as string;
    const minted = await router.handle(request("POST", `/api/workspaces/${workspaceId}/invitations`, owner.cookie, { role: "VIEWER" }));
    expect(minted.status).toBe(201);
    const { token } = JSON.parse(minted.body) as { token: string };
    const preview = await router.handle(request("POST", "/api/invitations/inspect", "", { token }));
    expect(JSON.parse(preview.body)).toMatchObject({ workspaceName: "Invite target", role: "VIEWER" });
    const accepted = await router.handle(request("POST", "/api/invitations/accept", guest.cookie, { token }));
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body)).toMatchObject({ workspaceId, role: "VIEWER" });
    expect(await dependencies.workspaces.roleOf(workspaceId, guest.userId)).toBe("VIEWER");
    const listing = await router.handle(request("GET", `/api/projects?workspaceId=${workspaceId}`, guest.cookie));
    expect(JSON.parse(listing.body).projects.map((project: { id: string }) => project.id)).toContain(projectId);
    expect((await router.handle(request("GET", `/api/projects/${projectId}`, guest.cookie))).status).toBe(200);
    expect((await router.handle(request("POST", "/api/invitations/accept", guest.cookie, { token }))).status).toBe(404);
  });

  it("creates, renames and deletes a non-default workspace", async () => {
    const router = createRouter(dependencies);
    const { cookie } = await signIn();
    const created = await router.handle(
      request("POST", "/api/workspaces", cookie, { name: "Engineering" }),
    );
    expect(created.status).toBe(201);
    const workspace = JSON.parse(created.body).workspace as {
      id: string;
      isDefault: boolean;
    };
    expect(workspace.isDefault).toBe(false);

    const renamed = await router.handle(
      request("PATCH", `/api/workspaces/${workspace.id}`, cookie, {
        name: "Platform",
      }),
    );
    expect(renamed.status).toBe(200);
    expect(JSON.parse(renamed.body).workspace.name).toBe("Platform");

    const deleted = await router.handle(
      request("DELETE", `/api/workspaces/${workspace.id}`, cookie),
    );
    expect(deleted.status).toBe(204);
  });

  it("refuses deletion of the default workspace", async () => {
    const router = createRouter(dependencies);
    const { cookie, userId } = await signIn();
    const deleted = await router.handle(
      request("DELETE", `/api/workspaces/${userId}`, cookie),
    );
    expect(deleted.status).toBe(422);
  });
});
