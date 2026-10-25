#!/usr/bin/env node
/**
 * Browser smoke test (packaging/verification phase).
 *
 * The Vitest suite runs in jsdom, so it never proves that the *built* bundle
 * boots in a real browser: bundling, the production React build, asset paths,
 * and the live editor -> preview wiring are all unverified there. This script
 * closes that gap. It serves `dist/` with `vite preview`, drives it with
 * Chromium via the already-installed `playwright` library, and checks the three
 * things a broken build would break:
 *
 *   1. the app shell mounts and the seeded sample renders as SVG;
 *   2. editing the DSL updates the preview live (React + pipeline wiring);
 *   3. malformed DSL surfaces diagnostics instead of crashing the preview.
 *
 * It deliberately uses the Playwright *library* rather than the `@playwright/test`
 * runner: the checks are a single linear path, and the project keeps its
 * dependency list minimal (see README "Design principles").
 *
 * Usage: `npm run test:e2e` (builds first). Chromium must be installed once via
 * `npx playwright install chromium`; see the README "Testing in a real browser".
 */
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";

import { startIdentityProvider } from "./e2e-identity-provider.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.E2E_PORT ?? 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 30_000;
const UI_TIMEOUT_MS = 10_000;
let e2ePlatformAdminPage = null;

/**
 * The API ports.
 *
 * The browser only ever talks to the preview origin; the proxy forwards
 * `/api` and `/auth` to the API, so the API's own port is an implementation
 * detail. It is nonetheless fixed by default so a manual `vite dev` run and the
 * E2E run agree, and an occupied port falls back to an ephemeral one.
 */
const API_PORT = Number(process.env.E2E_API_PORT ?? 8787);
const IDP_PORT = Number(process.env.E2E_IDP_PORT ?? 8788);
const MCP_PORT = Number(process.env.E2E_MCP_PORT ?? 8789);

/**
 * The secret the API signs its login-state cookie with.
 *
 * Long enough to satisfy `COOKIE_SECRET`'s 32-character floor, and obviously a
 * test value. It is generated per run rather than committed so it cannot be
 * mistaken for a deployment secret.
 */
const COOKIE_SECRET = `e2e-${"0123456789abcdef".repeat(4)}`;

/** A diagram that shares no participant names with the seeded sample. */
const REPLACEMENT_SOURCE = [
  "title Checkout",
  "",
  "participant Browser",
  "participant Gateway",
  "",
  "Browser ->> Gateway: Submit order",
  "activate Gateway",
  "Gateway --> Browser: Accepted",
  "deactivate Gateway",
  "",
].join("\n");

/** Malformed on purpose: a sync arrow with no receiver or label. */
const SYNTAX_ERROR_SOURCE = "Browser ->\n";

/**
 * Semantically invalid on purpose: the message names `Gateway`, which is never
 * declared. The parser produces a coherent tree, so this is the case that makes
 * the preview fall back to its empty state.
 */
const SEMANTIC_ERROR_SOURCE = [
  "participant Browser",
  "",
  "Browser ->> Gateway: Submit order",
  "",
].join("\n");

/**
 * Markers the server scenarios look for on the wire.
 *
 * Each is unique so a check can never pass because a *different* scenario's
 * document happened to be open, and none appears in the seeded sample.
 */
const SERVER_MARKER = "SERVERSAVEDMARKER";
const MARKDOWN_MARKER = "SERVERDOCMARKER";
const CONFLICT_BASE = "CONFLICTSAVEDBASE";
const CONFLICT_OWNER = "CONFLICTOWNERWINS";
const CONFLICT_LOCAL = "CONFLICTLOCALEDIT";
const VIEWER_MARKER = "VIEWERREADONLYBASE";
const LOCAL_MARKER = "LOCALANONMARKER";
/** Written through the remote MCP endpoint and then looked for in the browser. */
const AGENT_MARKER = "REMOTEMCPMARKER";

const failures = [];

/** Record and print one assertion result. */
function check(description, passed, detail = "") {
  const status = passed ? "PASS" : "FAIL";
  console.log(`  ${status}  ${description}${detail ? ` — ${detail}` : ""}`);
  if (!passed) failures.push(description);
}

/**
 * Poll a locator's text until `predicate` accepts it.
 *
 * Playwright's `expect` lives in `@playwright/test`, so waiting for a React
 * re-render (which happens asynchronously after `fill`) is done by polling.
 */
async function waitForText(locator, predicate, description) {
  const deadline = Date.now() + UI_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = (await locator.textContent()) ?? "";
    } catch {
      last = "";
    }
    if (predicate(last)) return last;
    await delay(100);
  }
  throw new Error(
    `${description} timed out after ${UI_TIMEOUT_MS}ms (last text: ${JSON.stringify(
      last.slice(0, 200),
    )})`,
  );
}

/**
 * Child processes this run owns.
 *
 * The API and the preview are killed in `main`'s `finally`, but a hard failure or
 * a Ctrl-C must not leave a listener behind either. Registering every spawn here
 * and killing the set on `exit` is what makes an unexpected end safe.
 */
const liveChildren = new Set();

/** Remember a child process so an unexpected exit can still kill it. */
function trackChild(child) {
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  return child;
}

/** Kill every tracked child, ignoring one that is already gone. */
function killTrackedChildren() {
  for (const child of liveChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already dead.
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    killTrackedChildren();
    process.exit(1);
  });
}
process.on("exit", killTrackedChildren);

/**
 * Find a free loopback port.
 *
 * The preferred port is tried first so a manual run keeps stable URLs; when it is
 * taken an ephemeral port is used instead, so a stray process can never make the
 * suite fail for the wrong reason.
 */
async function findFreePort(preferred) {
  const bind = (port) =>
    new Promise((resolve) => {
      const probe = createNetServer();
      probe.once("error", () => resolve(null));
      probe.listen(port, "127.0.0.1", () => {
        const address = probe.address();
        const bound =
          typeof address === "object" && address !== null ? address.port : null;
        probe.close(() => resolve(bound));
      });
    });
  return (await bind(preferred)) ?? (await bind(0));
}

/**
 * Start the built API against a temporary volume and wait until it serves.
 *
 * Three configuration choices carry the run:
 *
 * - `NODE_ENV=test` is deliberate. Without `DATABASE_URL`, the API refuses to
 *   boot in `development` and `production`; the E2E run must use PGlite rather
 *   than require a PostgreSQL server, and `test` is the environment in which
 *   PGlite is a legitimate driver.
 * - `PUBLIC_URL` is the *browser's* origin, not the API's port. The OIDC
 *   redirect URI must land back on the preview origin so the session cookie
 *   stays same-origin and the `/auth` proxy carries it.
 * - the project volume is a fresh temporary directory per run, so a scenario can
 *   never read another run's files.
 */
async function startApiServer({
  port,
  projectVolume,
  issuer,
  clientId,
  clientSecret,
}) {
  const apiBundle = await import(
    pathToFileURL(join(ROOT, "dist-api", "server.mjs")).href
  );

  const config = apiBundle.loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(port),
    PUBLIC_URL: BASE_URL,
    PROJECT_VOLUME: projectVolume,
    PGLITE_DIR: "memory://",
    COOKIE_SECRET,
    PLATFORM_ADMIN_EMAIL: "platform-admin@e2e.test",
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: clientId,
    OIDC_CLIENT_SECRET: clientSecret,
  });

  // The runtime is built here and *shared* with the MCP service below, so both
  // hosts read and write one database and one project volume. That is the only
  // way the browser↔MCP scenario can prove consistency with an in-process
  // PGlite, which no second process can open.
  const runtime = await apiBundle.createServerRuntime({
    database: config.database,
    projectVolume: config.projectVolume,
    tokenPepper: config.tokenPepper,
  });
  const dependencies = await apiBundle.createApp(config, { runtime });
  const server = apiBundle.createHttpServer({
    router: apiBundle.createRouter(dependencies),
    expectedOrigin: config.publicUrl,
    onError(error, requestId) {
      process.stderr.write(
        `${requestId} unhandled error: ${error?.stack ?? error}\n`,
      );
    },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const apiBase = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBase}/healthz`);
      if (response.ok) {
        const health = await response.json();
        if (health.status === "ok" && health.signIn === "oidc") {
          return {
            runtime,
            config,
            apiBase,
            async close() {
              await new Promise((resolve) => server.close(resolve));
              await apiBundle.closeApp(dependencies);
            },
          };
        }
      }
    } catch {
      // Not listening yet; keep polling.
    }
    await delay(150);
  }
  throw new Error(
    `the API did not report {status:"ok", signIn:"oidc"} within ${READY_TIMEOUT_MS}ms`,
  );
}

/**
 * Start the real MCP service in-process, over the API's own runtime.
 *
 * Phase 6 made the MCP a separate host with its own image and port; running it
 * here in the same process is a test convenience, not an architectural
 * concession — it is still a real HTTP listener with the real handler, the real
 * SDK transport and the real authentication, and it shares storage with the API
 * the way the container composition does through PostgreSQL.
 */
async function startMcpService({ port, runtime, publicUrl, projectVolume }) {
  const mcpBundle = await import(
    pathToFileURL(join(ROOT, "dist-mcp-service", "server.mjs")).href
  );
  const config = mcpBundle.loadMcpConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(port),
    MCP_PUBLIC_URL: publicUrl,
    PROJECT_VOLUME: projectVolume,
    PGLITE_DIR: "memory://",
    TOKEN_PEPPER: `e2e-pepper-${COOKIE_SECRET}`,
  });
  const service = await mcpBundle.createMcpService(config, {
    runtime,
    logger: { log: () => {} },
  });
  const server = mcpBundle.createMcpHttpServer({
    config,
    observability: service.observability,
    handleMcp: service.handleMcp,
    ready: service.ready,
    onError(error, requestId) {
      process.stderr.write(`${requestId} mcp error: ${error}\n`);
    },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const mcpBase = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${mcpBase}/health`);
      if (response.ok) {
        return {
          mcpBase,
          config,
          async close() {
            await new Promise((resolve) => server.close(resolve));
            await service.close();
          },
        };
      }
    } catch {
      // Not listening yet; keep polling.
    }
    await delay(150);
  }
  throw new Error(
    `the MCP service did not become healthy within ${READY_TIMEOUT_MS}ms`,
  );
}

/**
 * Send one request from a page, through the application's own origin.
 *
 * Using the page's `fetch` is what makes the session part of the test: the
 * request is same-origin, so the browser attaches the HttpOnly cookie exactly as
 * the application does, and the preview's proxy forwards `/api` to the API.
 */
async function apiRequest(page, path, init = undefined) {
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, {
        credentials: "same-origin",
        cache: "no-store",
        method: init?.method ?? "GET",
        ...(init?.body === undefined
          ? {}
          : {
              body: init.body,
              headers: { "content-type": "application/json" },
            }),
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: response.status, json, text };
    },
    { path, init },
  );
}

/** Find a server project by name, as the signed-in page sees it. */
async function serverProjectByName(page, projectName) {
  const workspaces = await apiRequest(page, "/api/workspaces");
  for (const workspace of workspaces.json?.workspaces ?? []) {
    const projects = await apiRequest(
      page,
      `/api/projects?workspaceId=${encodeURIComponent(workspace.id)}`,
    );
    const project = (projects.json?.projects ?? []).find(
      (entry) => entry.name === projectName,
    );
    if (project) return project;
  }
  return null;
}

/**
 * Speak one JSON-RPC message to the remote MCP endpoint as a machine client.
 *
 * This goes to the API directly with an `Authorization: Bearer` header, not
 * through the page's cookie: the whole point of the remote MCP surface is that
 * it is a machine credential on a different axis from the browser session, and
 * a test that borrowed the page's session would not prove it.
 */
async function remoteMcp(baseUrl, token, message) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The Streamable HTTP transport requires a client to accept both a JSON
      // body and an event stream, even when the server only ever sends JSON.
      accept: "application/json, text/event-stream",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

/** Call a remote MCP tool and return its result object. */
async function remoteTool(baseUrl, token, id, name, args) {
  const answer = await remoteMcp(baseUrl, token, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return answer.json?.result ?? null;
}

/**
 * Poll the API until one of a project's resources holds content the predicate
 * accepts.
 *
 * Waiting on the *server's* copy rather than the tab's dirty flag is what makes
 * "the save landed" a fact rather than a guess: the tab clears its dirty flag
 * from its own optimistic bookkeeping, while this reads what a second browser
 * would see.
 */
async function waitForServerContent(
  page,
  projectName,
  predicate,
  description,
  contextId = null,
) {
  const deadline = Date.now() + UI_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    const project = await serverProjectByName(page, projectName);
    if (project !== null) {
      const contextQuery = contextId
        ? `?contextId=${encodeURIComponent(contextId)}`
        : "";
      const list = await apiRequest(
        page,
        `/api/projects/${project.id}/resources${contextQuery}`,
      );
      for (const resource of list.json?.resources ?? []) {
        const resourceQuery = contextId
          ? `?contextId=${encodeURIComponent(contextId)}`
          : "";
        const read = await apiRequest(
          page,
          `/api/projects/${project.id}/resources/${resource.id}${resourceQuery}`,
        );
        last = read.json?.content ?? "";
        if (predicate(last)) {
          return {
            projectId: project.id,
            resourceId: resource.id,
            content: last,
          };
        }
      }
    }
    await delay(150);
  }
  throw new Error(
    `${description} timed out after ${UI_TIMEOUT_MS}ms (last content: ${JSON.stringify(
      last.slice(0, 200),
    )})`,
  );
}

/** Create and open the first editable MY WORK document for the active project. */
async function createMyWorkDocument(page, projectName) {
  await page.locator('[data-testid="explorer-my-work-create"]').click();
  const draftName = `work-${projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  await page.getByRole("dialog", { name: "Create MY WORK draft" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  await page.getByLabel("Draft name").fill(draftName);
  await page.getByRole("button", { name: "Create draft" }).click();
  const project = await serverProjectByName(page, projectName);
  if (project === null) throw new Error(`no server project named ${projectName}`);
  const deadline = Date.now() + UI_TIMEOUT_MS;
  let contextId = null;
  while (Date.now() < deadline) {
    const contexts = await apiRequest(page, `/api/projects/${project.id}/private-work`);
    const context = (contexts.json?.contexts ?? []).find((entry) => entry.name === draftName);
    if (context) {
      contextId = context.id;
      break;
    }
    await delay(100);
  }
  if (!contextId) throw new Error(`no MY WORK context was created for ${projectName}`);
  await page.locator(".explorer__context-note").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  const tabsBefore = await page.locator('[data-testid="tab"]').count();
  await page.locator('[data-testid="explorer-my-work-create"]').click();
  await page.getByRole("menuitem", { name: "New diagram" }).click();
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll('[data-testid="tab"]').length === expected,
    tabsBefore + 1,
    { timeout: UI_TIMEOUT_MS },
  );
  return contextId;
}

/** Reopen an existing MY WORK context after a browser reload. */
async function openMyWorkContext(page, contextId) {
  const toggle = page.locator('[data-testid="explorer-my-work-toggle"]');
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  const contextButton = page.locator(`[data-testid="explorer-private-context-open-${contextId}"]`);
  if (await contextButton.count() > 0 && await contextButton.isVisible()) await contextButton.click();
}

/** Seed authoritative SHARED content for a read-only consumer scenario. */
async function bootstrapSharedProject(page, name, content, resources = null) {
  const workspaces = await apiRequest(page, "/api/workspaces");
  const workspace = workspaces.json?.workspaces?.[0];
  if (!workspace) throw new Error("no server workspace is available");
  const created = await apiRequest(page, "/api/projects/bootstrap", {
    method: "POST",
    body: JSON.stringify({
      workspaceId: workspace.id,
      name,
      resources: resources ?? [
        {
          path: "Untitled.seq",
          type: "sequence-diagram",
          content,
        },
      ],
    }),
  });
  if (created.status !== 201) {
    throw new Error(`shared project bootstrap failed: ${created.status} ${created.text}; workspace=${workspace.name} (${workspace.id})`);
  }
}

/** Read a project's first resource, with its id, revision and content. */
async function currentServerResource(page, projectName, contextId = null) {
  const project = await serverProjectByName(page, projectName);
  if (project === null) {
    throw new Error(`no server project named ${JSON.stringify(projectName)}`);
  }
  const contextQuery = contextId
    ? `?contextId=${encodeURIComponent(contextId)}`
    : "";
  const list = await apiRequest(
    page,
    `/api/projects/${project.id}/resources${contextQuery}`,
  );
  const resource = (list.json?.resources ?? [])[0];
  if (resource === undefined) {
    throw new Error(`server project ${projectName} has no resources`);
  }
  const read = await apiRequest(
    page,
    `/api/projects/${project.id}/resources/${resource.id}${contextQuery}`,
  );
  return {
    projectId: project.id,
    resource,
    content: read.json?.content ?? "",
  };
}

/**
 * Poll an input's value until the predicate accepts it.
 *
 * `textContent` does not track a textarea's value, so the textarea-backed
 * editors need this rather than {@link waitForText}.
 */
async function waitForInputValue(locator, predicate, description) {
  const deadline = Date.now() + UI_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = await locator.inputValue();
    } catch {
      last = "";
    }
    if (predicate(last)) return last;
    await delay(100);
  }
  throw new Error(
    `${description} timed out after ${UI_TIMEOUT_MS}ms (last value: ${JSON.stringify(
      last.slice(0, 200),
    )})`,
  );
}

/**
 * Tell the local identity provider who the next authorization signs in as.
 *
 * Going through the provider's HTTP control endpoint (rather than calling the
 * in-process object) exercises the real path a test harness uses, including its
 * loopback and bearer-token guards.
 */
async function setNextIdentity(idp, subject) {
  const response = await fetch(`${idp.issuer}/__control/subject`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-e2e-control": idp.controlToken,
    },
    body: JSON.stringify(subject),
  });
  if (!response.ok) {
    throw new Error(
      `the identity provider refused a subject change: ${response.status}`,
    );
  }
}

/**
 * Sign a page in as a subject.
 *
 * The provider is told who to sign in as *before* the browser leaves for it: the
 * authorization endpoint signs in the subject the control endpoint last chose,
 * which is how one provider serves two different people in one run.
 */
async function signIn(page, idp, subject) {
  await setNextIdentity(idp, subject);
  const button = page
    .locator('[data-testid="login-google"], [data-testid="toolbar-sign-in"]')
    .first();
  await button.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  await button.click();
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="toolbar-account"]')) || ["failed", "pending"].includes(new URLSearchParams(location.search).get("auth")),
    { timeout: UI_TIMEOUT_MS },
  );
  if (["failed", "pending"].includes(new URL(page.url()).searchParams.get("auth")) && e2ePlatformAdminPage && subject.email) {
    const listed = await apiRequest(e2ePlatformAdminPage, "/api/admin/users");
    const user = listed.json?.users?.find((entry) => entry.email === subject.email);
    if (!user) throw new Error(`platform admin could not find pending OIDC user ${subject.email}`);
    const activated = await apiRequest(e2ePlatformAdminPage, `/api/admin/users/${user.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "ACTIVE" }),
    });
    if (activated.status !== 200) throw new Error(`platform admin could not activate ${subject.email}: ${activated.status}`);
    await setNextIdentity(idp, subject);
    await page.locator('[data-testid="login-google"], [data-testid="toolbar-sign-in"]').first().click();
  }
  await page.locator('[data-testid="toolbar-account"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
}

/** Restore the precision editor when a scenario needs to edit source. */
async function showEditor(page) {
  const button = page.getByRole("button", { name: "Show editor" });
  if (await button.count() > 0 && await button.isVisible()) await button.click();
}

/** Wait for either the login gate or the authenticated application shell. */
async function waitForAuthEntry(page) {
  await page
    .locator('[data-testid="login-page"], [data-testid="app-shell"]')
    .first()
    .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
}

/** Create a server project and wait for the Project Explorer to open it. */
async function createServerProject(page, name) {
  let projectCreateFailure = null;
  const captureFailure = async (response) => {
    if (new URL(response.url()).pathname === "/api/projects" && response.status() >= 400) {
      projectCreateFailure = `${response.status()} ${await response.text()}`;
    }
  };
  page.on("response", captureFailure);
  await openServerCreation(page);
  await page
    .locator('[data-testid="workspace-new-server-project-input"]')
    .fill(name);
  await page
    .locator('[data-testid="workspace-new-server-project-button"]')
    .click();
  await page
    .locator('[data-testid="workspace-active-project"]')
    .filter({ hasText: name })
    .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS })
    .catch(async (error) => {
      const selectedWorkspace = await page.locator('[data-testid="workspace-server-workspace-select"]').inputValue().catch(() => "unavailable");
      throw new Error(`${error.message}; selected workspace=${selectedWorkspace}; create response=${projectCreateFailure ?? "none"}`);
    });
  page.off("response", captureFailure);
}

/** Open the compact server-project creation form. */
async function openServerCreation(page) {
  const toggle = page.locator('[data-testid="workspace-new-server-project-toggle"]');
  await toggle.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
}

/** Open a server project from the switcher and wait for its explorer row. */
async function openServerProject(page, name) {
  const back = page.locator('[data-testid="workspace-back-to-projects"]');
  const active = page.locator('[data-testid="workspace-active-project"]');
  if (await active.count() > 0 && await active.isVisible()) {
    if ((await active.textContent())?.includes(name) && await page.locator('.explorer__context-note').count() === 0) return;
    if ((await back.getAttribute("aria-expanded")) !== "true") await back.click();
  }
  await page.locator('[data-testid="workspace-server-projects-loading"]').waitFor({
    state: "detached",
    timeout: UI_TIMEOUT_MS,
  });
  const entry = page
    .locator('[data-testid="workspace-server-project"]')
    .filter({ hasText: name });
  await entry.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  await entry.click();
  await page
    .locator('[data-testid="workspace-active-project"]')
    .filter({ hasText: name })
    .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
}

/** Add a document to the selected project through the command palette. */
async function addDocument(page, menuTestId) {
  await page.locator('[data-testid="command-palette-button"]').click();
  await page.locator('[data-testid="palette-input"]').fill(menuTestId.includes("note") ? "New Note" : "New Diagram");
  await page.locator('[data-testid="palette-item-button"]').first().click();
}

/**
 * Create a document and wait for its tab to appear.
 *
 * Waiting for the editor alone is not enough: a project with no documents still
 * shows the editor, so a `fill` issued while the asynchronous create is in
 * flight would be overwritten the moment the new, empty document becomes active.
 * The new tab is the concrete signal that the created document is on screen.
 */
async function createDocument(page, projectName, menuTestId) {
  const tabsBefore = await page.locator('[data-testid="tab"]').count();
  await addDocument(page, menuTestId);
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll('[data-testid="tab"]').length === expected,
    tabsBefore + 1,
    { timeout: UI_TIMEOUT_MS },
  );
}

/** Run one labelled scenario, recording its completion as a single check. */
async function scenario(name, body) {
  if (process.env.E2E_SCENARIO && process.env.E2E_SCENARIO !== name) return;
  console.log(`\n${name}`);
  try {
    await body();
    check(`${name} completed`, true);
  } catch (error) {
    check(
      `${name} completed`,
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Start `vite preview` for the built bundle and resolve once it serves. */
async function startPreviewServer() {
  const viteBin = join(ROOT, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) {
    throw new Error(`Vite binary not found at ${viteBin}; run npm install.`);
  }

  const child = trackChild(
    spawn(
      process.execPath,
      // Bind explicitly to IPv4: Vite's default `localhost` can resolve to ::1
      // only, which the fetch-based readiness poll below would never reach.
      [
        viteBin,
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        String(PORT),
        "--strictPort",
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );

  let serverLog = "";
  child.stdout.on("data", (chunk) => (serverLog += chunk));
  child.stderr.on("data", (chunk) => (serverLog += chunk));

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `vite preview exited with code ${child.exitCode}:\n${serverLog.trim()}`,
      );
    }
    try {
      const response = await fetch(BASE_URL, { redirect: "manual" });
      if (response.ok) return child;
    } catch {
      // Not listening yet; keep polling.
    }
    await delay(150);
  }

  child.kill("SIGTERM");
  throw new Error(
    `vite preview did not serve ${BASE_URL} within ${READY_TIMEOUT_MS}ms:\n${serverLog.trim()}`,
  );
}

/**
 * Drive the served app and record every check.
 *
 * @param page - The page to drive. The caller owns it (and its context), because
 *   the window size is part of the harness rather than of a check: the workspace
 *   switcher sits above the project tree, and on Playwright's 720px-tall default
 *   viewport the explorer would have to scroll the last project into view before
 *   clicking its add button. A context menu dismisses itself on scroll, so it
 *   would close between Playwright's stability check and the click. A window tall
 *   enough to show the tree needs no scroll, which is why `main` opens the
 *   browser with one.
 */
async function runChecks(page, idp) {
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await waitForAuthEntry(page);
  await signIn(page, idp, {
    sub: "e2e-smoke-editor",
    name: "E2E Smoke Editor",
    email: "smoke-editor@e2e.test",
  });

  console.log("\nShell:");
  await page.locator('[data-testid="app-shell"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("app shell mounts", true);
  check(
    "document title is the product name",
    (await page.title()) === "Software Docs Manager",
    await page.title(),
  );

  console.log("\nSeeded sample renders:");
  const svg = page.locator('[data-testid="preview-svg"]');
  await svg.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  const sampleText = await waitForText(
    svg,
    (text) => text.includes("User") && text.includes("Find user"),
    "seeded sample SVG",
  );
  check("preview renders the seeded sample", true);
  check("participant labels are drawn", sampleText.includes("User"));
  check("message labels are drawn", sampleText.includes("Find user"));
  check("diagram title is drawn", sampleText.includes("Login"));
  await page.getByRole("button", { name: "How to read Sequence" }).click();
  await page.getByRole("heading", { name: "How to read Sequence" }).waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("contextual sequence guidance opens on demand", true);
  await page.getByRole("button", { name: "Close diagram guidance" }).click();
  check(
    "no uncaught page errors",
    consoleErrors.length === 0,
    consoleErrors.join("; "),
  );

  // Text can sit in the DOM yet never be painted — nested in an element that
  // cannot render children, for instance. Measuring what the browser actually
  // lays out makes this a rendering check, not a markup check.
  const unpainted = await page.$$eval(
    '[data-testid="preview-svg"] text',
    (nodes) =>
      nodes
        .filter((node) => node.getBoundingClientRect().width === 0)
        .map((node) => node.textContent ?? ""),
  );
  check(
    "every text label is painted with a non-zero box",
    unpainted.length === 0,
    unpainted.join(", "),
  );

  const arrowHeads = await page
    .locator('[data-testid="preview-svg"] polygon')
    .count();
  check(
    "every message line paints an arrowhead",
    arrowHeads === 4,
    `found ${arrowHeads}`,
  );

  // Every call and every response is numbered in source order; the sample has
  // four messages (two calls, two responses).
  const stepNumbers = await page
    .locator('[data-testid="preview-svg"] [data-sequence-number]')
    .count();
  check(
    "every message carries a circled step number",
    stepNumbers === 4,
    `found ${stepNumbers}`,
  );

  // The code editor starts minimized; the smoke checks it only after exercising
  // the same explicit restore action available to users.
  await page.getByRole("button", { name: "Show editor" }).click();
  await page.locator('[aria-label="DSL editor"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });

  // The gutter must line up with the textarea and keep the step badges in one
  // column. jsdom has no layout, so only a real browser can catch a line-height
  // mismatch (which drifts every number off its line) or a badge column that
  // shifts with the width of the line number beside it.
  console.log("\nEditor gutter:");
  const gutter = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".editor__line-number")];
    const textarea = document.querySelector(".editor__textarea");
    const badges = [...document.querySelectorAll(".editor__step")];
    return {
      rowLineHeight: getComputedStyle(rows[0]).lineHeight,
      textareaLineHeight: getComputedStyle(textarea).lineHeight,
      tops: rows.map((row) => row.getBoundingClientRect().top),
      badgeLefts: badges.map((badge) => badge.getBoundingClientRect().left),
    };
  });
  check(
    "gutter rows use the textarea's line height",
    gutter.rowLineHeight === gutter.textareaLineHeight,
    `${gutter.rowLineHeight} vs ${gutter.textareaLineHeight}`,
  );
  const lineHeight = Number.parseFloat(gutter.textareaLineHeight);
  const firstTop = gutter.tops[0] ?? 0;
  const maxDrift = Math.max(
    ...gutter.tops.map((top, index) =>
      Math.abs(top - (firstTop + index * lineHeight)),
    ),
  );
  check(
    "line numbers do not drift from their lines",
    maxDrift < 0.5,
    `max drift ${maxDrift.toFixed(2)}px`,
  );
  const badgeSpread =
    gutter.badgeLefts.length === 0
      ? 0
      : Math.max(...gutter.badgeLefts) - Math.min(...gutter.badgeLefts);
  check(
    "step badges share one left-aligned column",
    gutter.badgeLefts.length === 4 && badgeSpread < 0.5,
    `${gutter.badgeLefts.length} badges, spread ${badgeSpread.toFixed(2)}px`,
  );

  const editorBounds = await page.evaluate(() => {
    const editor = document.querySelector('[aria-label="DSL editor"]');
    const statusbar = document.querySelector(".app__statusbar");
    const code = document.querySelector(".editor__code");
    const textarea = document.querySelector(".editor__textarea");
    return {
      editorBottom: editor?.getBoundingClientRect().bottom ?? 0,
      statusbarTop: statusbar?.getBoundingClientRect().top ?? 0,
      codeBottom: code?.getBoundingClientRect().bottom ?? 0,
      textareaBottom: textarea?.getBoundingClientRect().bottom ?? 0,
    };
  });
  check(
    "DSL editor stays above the status bar",
    editorBounds.editorBottom <= editorBounds.statusbarTop + 0.5,
    `${editorBounds.editorBottom.toFixed(2)} vs ${editorBounds.statusbarTop.toFixed(2)}`,
  );
  check(
    "DSL textarea stays inside the code area",
    editorBounds.textareaBottom <= editorBounds.codeBottom + 0.5,
    `${editorBounds.textareaBottom.toFixed(2)} vs ${editorBounds.codeBottom.toFixed(2)}`,
  );

  // The suggestion popup must never swallow Enter or the arrow keys. It opens
  // at a statement start (a wall of keywords), and if it captured Enter the
  // editor could never add a blank line; if it captured the arrows the caret
  // could not be moved with the keyboard.
  console.log("\nCompletion never swallows typing:");
  const editor = page.locator('[data-testid="dsl-textarea"]');
  const BLANK_LINE_SOURCE = [
    "title Blank lines",
    "participant A",
    "participant B",
    "A -> B: hi",
  ].join("\n");
  await editor.fill(BLANK_LINE_SOURCE);
  const linesBefore = (await editor.inputValue()).split("\n").length;
  const titlesBefore = ((await editor.inputValue()).match(/title/g) ?? [])
    .length;
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  const afterEnter = await editor.inputValue();
  const linesAfter = afterEnter.split("\n").length;
  const titlesAfter = (afterEnter.match(/title/g) ?? []).length;
  check(
    "Enter adds blank lines instead of accepting a suggestion",
    linesAfter === linesBefore + 2 && titlesAfter === titlesBefore,
    `${linesBefore} -> ${linesAfter} lines, titles ${titlesBefore} -> ${titlesAfter}`,
  );

  await page.keyboard.press("ArrowUp");
  const caretAfterArrow = await editor.evaluate((el) => el.selectionStart);
  check(
    "arrow keys still move the caret",
    caretAfterArrow < afterEnter.length,
    `caret ${caretAfterArrow} of ${afterEnter.length}`,
  );

  await editor.fill("");
  await editor.pressSequentially("part");
  await page.keyboard.press("Tab");
  check(
    "Tab still accepts the highlighted suggestion",
    (await editor.inputValue()) === "participant",
    await editor.inputValue(),
  );

  // Participant names are bolded by a highlight layer behind a transparent
  // textarea. If the two layers' fonts or boxes disagree, the bold names drift
  // off the glyphs, which only a real browser can show.
  console.log("\nParticipant highlighting:");
  await editor.fill("participant API\nAPI -> DB: hi\n");
  const boldNames = await page
    .locator('[data-testid="editor-highlight"] strong')
    .count();
  check(
    "participant names are bolded in the editor",
    boldNames === 3,
    `${boldNames} bold names`,
  );
  check(
    "highlight layer mirrors the source",
    (await page.locator('[data-testid="editor-highlight"]').textContent()) ===
      (await editor.inputValue()),
  );
  const layerMetrics = await page.evaluate(() => {
    const highlight = document.querySelector(".editor__highlight");
    const textarea = document.querySelector(".editor__textarea");
    const a = getComputedStyle(highlight);
    const b = getComputedStyle(textarea);
    const ra = highlight.getBoundingClientRect();
    const rb = textarea.getBoundingClientRect();
    return {
      sameFont: a.fontFamily === b.fontFamily && a.fontSize === b.fontSize,
      sameLineHeight: a.lineHeight === b.lineHeight,
      samePadding: a.padding === b.padding,
      noSoftWrap: textarea.wrap === "off" && a.whiteSpace === "pre",
      sameBox:
        Math.abs(ra.left - rb.left) < 0.5 &&
        Math.abs(ra.top - rb.top) < 0.5 &&
        Math.abs(ra.width - rb.width) < 0.5 &&
        Math.abs(ra.height - rb.height) < 0.5,
    };
  });
  check("highlight layer shares the textarea's font", layerMetrics.sameFont);
  check(
    "highlight layer shares the textarea's line height",
    layerMetrics.sameLineHeight,
  );
  check("editor source lines do not soft-wrap", layerMetrics.noSoftWrap);
  check("highlight layer covers the textarea exactly", layerMetrics.sameBox);

  // Retyping a declaration's name carries its usages with it, so the diagram
  // never collapses into "unknown participant" mid-edit.
  await editor.evaluate((el) => {
    el.focus();
    el.setSelectionRange(15, 15);
  });
  await page.keyboard.type("X");
  check(
    "renaming a declaration rewrites its usages",
    (await editor.inputValue()) === "participant APIX\nAPIX -> DB: hi\n",
    await editor.inputValue(),
  );

  console.log("\nLive editing updates the preview:");
  await page.locator('[data-testid="dsl-textarea"]').fill(REPLACEMENT_SOURCE);
  const editedText = await waitForText(
    svg,
    (text) => text.includes("Submit order"),
    "edited SVG",
  );
  check("new participant appears", editedText.includes("Gateway"));
  check("new message appears", editedText.includes("Submit order"));
  check("previous diagram is replaced", !editedText.includes("Find user"));
  check(
    "editor reports no problems for valid DSL",
    (await page.locator('[data-testid="dsl-diagnostics"]').count()) === 0,
  );

  // Phase 7 activations: the bar is painted as a white-filled, dark-stroked
  // rectangle over the lifeline, distinct from a participant box.
  const bars = await page.$$eval(
    '[data-testid="preview-svg"] rect[stroke="#0f172a"]',
    (nodes) => nodes.map((n) => n.getBoundingClientRect()),
  );
  check("activation bar is painted", bars.length === 1, `found ${bars.length}`);
  check(
    "activation bar has a non-zero box",
    bars.length === 1 && bars[0].height > 0 && bars[0].width > 0,
  );

  console.log("\nCanvas navigation:");
  const zoomLevel = () =>
    page.locator('[data-testid="zoom-level"]').textContent();
  const zoomBefore = await zoomLevel();
  await page.locator('[data-testid="zoom-in"]').click();
  const zoomAfter = await zoomLevel();
  check(
    "zoom in raises the zoom level",
    Number.parseInt(zoomAfter, 10) > Number.parseInt(zoomBefore, 10),
    `${zoomBefore} -> ${zoomAfter}`,
  );

  await page.locator('[data-testid="zoom-reset"]').click();
  check("reset returns to 100%", (await zoomLevel()) === "100%");

  // The zoom transform must actually move the painted diagram, not just the
  // readout: compare the canvas box before and after.
  const boxBefore = await page
    .locator('[data-testid="preview-svg"]')
    .boundingBox();
  await page.locator('[data-testid="zoom-in"]').click();
  const boxAfter = await page
    .locator('[data-testid="preview-svg"]')
    .boundingBox();
  check(
    "zooming enlarges the painted diagram",
    boxAfter.width > boxBefore.width,
    `${Math.round(boxBefore.width)} -> ${Math.round(boxAfter.width)}`,
  );

  // Dragging the canvas pans it without changing the zoom.
  const pane = await page
    .locator('[data-testid="viewport-pane"]')
    .boundingBox();
  const zoomDuringPan = await zoomLevel();
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    pane.x + pane.width / 2 + 80,
    pane.y + pane.height / 2,
    {
      steps: 5,
    },
  );
  await page.mouse.up();
  const boxPanned = await page
    .locator('[data-testid="preview-svg"]')
    .boundingBox();
  check(
    "dragging pans the diagram",
    Math.round(boxPanned.x) !== Math.round(boxAfter.x),
    `x ${Math.round(boxAfter.x)} -> ${Math.round(boxPanned.x)}`,
  );
  check(
    "panning does not change the zoom",
    (await zoomLevel()) === zoomDuringPan,
  );

  check(
    "minimap renders the diagram overview",
    (await page.locator('[data-testid="minimap-image"]').count()) === 1,
  );

  console.log("\nDocumentation page and auto-update:");
  await page.locator('[data-testid="open-docs"]').click();
  await page.locator('[data-testid="docs-page"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("the toolbar opens the documentation page", true);
  check(
    "the reference documents the activation construct",
    (
      await page.locator('[data-testid="dsl-reference"]').textContent()
    ).includes("activate"),
  );

  await page.locator('[data-testid="docs-nav-commands"]').click();
  check(
    "the command reference lists a palette command",
    (
      await page.locator('[data-testid="commands-reference"]').textContent()
    ).includes("New Diagram"),
  );
  await page.locator('[data-testid="docs-nav-mcp"]').click();
  check(
    "the MCP section explains how to build the server",
    (
      await page.locator('[data-testid="mcp-reference"]').textContent()
    ).includes("npm run mcp:build"),
  );

  await page.locator('[data-testid="docs-back"]').click();
  await page.locator('[data-testid="dsl-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("leaving the documentation page restores the editor", true);

  // With auto-update off the canvas must keep the last rendered diagram.
  await page.locator('[data-testid="auto-update-switch"]').click();
  await page
    .locator('[data-testid="dsl-textarea"]')
    .fill("title Frozen\n\nparticipant Icicle\n");
  check(
    "the preview is frozen while paused",
    !(await page.locator('[data-testid="preview-svg"]').textContent()).includes(
      "Icicle",
    ),
  );
  await page.locator('[data-testid="render-button"]').click();
  await waitForText(
    page.locator('[data-testid="preview-svg"]'),
    (text) => text.includes("Icicle"),
    "manually rendered SVG",
  );
  check("Render catches the canvas up", true);
  // Restore live updates for the checks that follow.
  await page.locator('[data-testid="auto-update-switch"]').click();

  console.log("\nNotes expand from their bullet:");
  // A note renders as a bullet on its element; expanding it is a real pointer
  // interaction, so this is where the pan surface's pointer handling is checked
  // (a stray pointer capture would swallow the click).
  const NOTES_SOURCE = [
    "title Notes demo",
    "",
    "participant User",
    "participant API",
    "",
    "User -> API: Login",
    "note right of API : Reads from cache",
    "",
  ].join("\n");
  await page.locator('[data-testid="dsl-textarea"]').fill(NOTES_SOURCE);
  await page.locator('[data-testid="preview-notes"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check(
    "notes toolbar reports the note count",
    (
      (await page.locator('[data-testid="preview-notes"]').textContent()) ?? ""
    ).includes("1 note"),
  );
  const bullet = page.locator(
    '[data-testid="preview-svg"] [data-note-index="0"]',
  );
  check(
    "a bullet is attached to the annotated element",
    (await bullet.count()) === 1,
  );
  check(
    "note text is hidden while collapsed",
    !(await page.locator('[data-testid="preview-svg"]').textContent()).includes(
      "Reads from cache",
    ),
  );

  const canvasBefore = await page
    .locator('[data-testid="preview-svg"]')
    .boundingBox();
  await bullet.click();
  const expanded = await waitForText(
    page.locator('[data-testid="preview-svg"]'),
    (text) => text.includes("Reads from cache"),
    "expanded note",
  );
  check(
    "clicking the bullet expands the note",
    expanded.includes("Reads from cache"),
  );
  const canvasAfter = await page
    .locator('[data-testid="preview-svg"]')
    .boundingBox();
  check(
    "expanding a bullet does not resize the canvas",
    Math.round(canvasAfter.height) === Math.round(canvasBefore.height),
    `${Math.round(canvasBefore.height)} -> ${Math.round(canvasAfter.height)}`,
  );

  await bullet.click();
  check(
    "clicking the bullet again collapses the note",
    !(await page.locator('[data-testid="preview-svg"]').textContent()).includes(
      "Reads from cache",
    ),
  );

  console.log("\nSelf-messages render as loops:");
  // A message whose endpoints are the same participant must draw a cycle, not a
  // zero-length horizontal arrow that disappears.
  const SELF_SOURCE = [
    "title Self loop",
    "",
    "participant API",
    "",
    "API ->> API: Retry",
    "",
  ].join("\n");
  await page.locator('[data-testid="dsl-textarea"]').fill(SELF_SOURCE);
  await waitForText(
    page.locator('[data-testid="preview-svg"]'),
    (text) => text.includes("Retry"),
    "self-message loop",
  );
  const loopPaths = await page
    .locator('[data-testid="preview-svg"] path:not(.sequence-message__hit)')
    .count();
  check(
    "a self-message paints a loop path",
    loopPaths === 1,
    `found ${loopPaths}`,
  );
  const loopHeads = await page
    .locator('[data-testid="preview-svg"] polygon')
    .count();
  check("the loop carries an arrowhead", loopHeads === 1, `found ${loopHeads}`);
  const loopPainted = await page.$$eval(
    '[data-testid="preview-svg"] path',
    (nodes) =>
      nodes.every((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      }),
  );
  check("the loop is painted, not collapsed to a point", loopPainted);

  console.log("\nMermaid-parity constructs:");
  // Actors, labelled ids, every arrow family, inline activation, nested
  // fragments, and a spanning + multiline note in one diagram.
  const PARITY_SOURCE = [
    "title Mermaid parity",
    "",
    "actor User",
    "participant API",
    'participant DB as "User Database"',
    "participant Queue",
    "",
    "User ->>+ API: Login",
    "API -> DB: Cache miss",
    "API -x DB: Dropped",
    "API -) Queue: Publish",
    "API <<->> API: Sync",
    "activate API",
    "API ->> API: Work",
    "deactivate API",
    "API -->>- User: Token",
    "loop retry up to 3 times",
    "  API ->> DB: Query",
    "end",
    "alt found",
    "  DB -->> API: Row",
    "else missing",
    "  API -->> User: 404",
    "end",
    "note over API,DB : Transaction boundary",
    "note right of API:",
    "  Validate JWT",
    "  Check expiration",
    "end note",
    "note on 1 : First step note",
    "",
  ].join("\n");
  await page.locator('[data-testid="dsl-textarea"]').fill(PARITY_SOURCE);
  await page.locator('[data-testid="preview-svg"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  const svgText = await waitForText(
    page.locator('[data-testid="preview-svg"]'),
    (text) => text.includes("Transaction boundary") || text.includes("Query"),
    "parity diagram",
  );
  check("the parity diagram renders", svgText.length > 0);
  check(
    "an actor is drawn as a figure",
    (await page.locator('[data-participant-type="actor"]').count()) === 1,
  );
  check(
    "a loop frame is drawn",
    (await page.locator('[data-fragment-kind="loop"]').count()) === 1,
  );
  check(
    "an alt frame is drawn with both branches",
    (await page.locator('[data-fragment-kind="alt"]').textContent())?.includes(
      "missing",
    ) === true,
  );
  check(
    "an open (async) arrow is drawn",
    (await page.locator(".arrow-open").count()) === 1,
  );
  check(
    "a cross (failed) arrow is drawn",
    (await page.locator(".arrow-cross").count()) === 1,
  );
  // Ten messages: Login, Cache miss, Dropped, Publish, Sync, Work, Token,
  // Query, Row, 404.
  const parityNumbers = await page
    .locator('[data-testid="preview-svg"] [data-sequence-number]')
    .count();
  check(
    "every message is still numbered",
    parityNumbers === 10,
    `found ${parityNumbers}`,
  );
  // The parity source carries three notes: a spanning one, a multiline one, and
  // one attached to message 1 by its step number.
  check(
    "a note can be attached to a message by its number",
    (
      (await page.locator('[data-testid="preview-notes"]').textContent()) ?? ""
    ).includes("3 notes"),
  );

  console.log("\nMarkdown notes:");
  // A project documents a system: create one, add a diagram to link to, then a
  // note that references it.
  await page.locator('[data-testid="local-create-toggle"]').click();
  await page.locator('[data-testid="project-name-input"]').fill("Handbook");
  await page.locator('[data-testid="create-project-button"]').click();
  await page.locator('[data-testid="project-name"]').first().waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("creating a project works with notes", true);

  await page.locator('[data-testid="command-palette-button"]').click();
  await page.locator('[data-testid="palette-input"]').fill("New Diagram");
  await page.locator('[data-testid="palette-item-button"]').first().click();
  await page.locator('[data-testid="dsl-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("a diagram can be created to link to", true);

  await page.locator('[data-testid="project-add-button"]').first().click();
  await page.locator('[data-testid="context-menu-new-note"]').click();
  await page.locator('[data-testid="markdown-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  await page
    .locator('[data-testid="markdown-textarea"]')
    .fill("# Runbook\n\nSee [[Untitled]] for the flow.");
  const markdownBody = page.locator('[data-testid="markdown-body"]');
  const rendered = await waitForText(
    markdownBody,
    (text) => text.includes("Runbook") && text.includes("Untitled"),
    "rendered markdown",
  );
  check("the note renders as markdown", rendered.includes("Runbook"));
  check(
    "a wiki-link to an existing diagram resolves",
    (await page.locator('[data-testid="markdown-body"] h1').textContent()) ===
      "Runbook",
  );
  check(
    "the resolved wiki-link is not marked broken",
    (await page
      .locator('[data-testid="markdown-body"] a[data-diagram-link]')
      .getAttribute("class")) === "markdown__link",
  );

  // The explorer's context menu drives rename / change title / delete.
  await page.locator('[data-testid="explorer-note"]').first().click({
    button: "right",
  });
  await page.locator('[data-testid="context-menu"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("right-clicking a note opens its context menu", true);
  await page.locator('[data-testid="context-menu-title"]').click();
  await page.locator('[data-testid="prompt-dialog-input"]').fill("Operations");
  await page.locator('[data-testid="prompt-dialog-confirm"]').click();
  const noteTitle = await waitForText(
    page.locator('[data-testid="note-title"]'),
    (text) => text.includes("Operations"),
    "note title",
  );
  check(
    "changing a note's title rewrites its heading",
    noteTitle.includes("Operations"),
  );
  check(
    "the context menu closed after choosing an action",
    (await page.locator('[data-testid="context-menu"]').count()) === 0,
  );

  // Duplicate is offered for both kinds of file; a note copy keeps its content.
  await page.locator('[data-testid="explorer-note"]').first().click({
    button: "right",
  });
  await page.locator('[data-testid="context-menu-duplicate"]').click();
  await page.locator('[data-testid="explorer-note"]').nth(1).waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check(
    "duplicating a note adds a copy",
    (await page.locator('[data-testid="explorer-note"]').count()) === 2,
  );

  // Selecting a diagram leaves note mode, which the invalid-DSL checks below
  // need (they drive the DSL editor).
  await page.locator('[data-testid="select-diagram-button"]').first().click();
  await page.locator('[data-testid="dsl-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("selecting a diagram leaves note mode", true);

  console.log("\nInvalid DSL degrades gracefully:");
  // A syntax error is reported, but the parser recovers a partial tree, so the
  // preview keeps rendering rather than blanking out.
  await page.locator('[data-testid="dsl-textarea"]').fill(SYNTAX_ERROR_SOURCE);
  await page.locator('[data-testid="dsl-diagnostics"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("syntax error is listed as a diagnostic", true);

  // A semantic error yields a valid tree with an unresolved participant, which
  // is what drives the preview's empty state.
  await page
    .locator('[data-testid="dsl-textarea"]')
    .fill(SEMANTIC_ERROR_SOURCE);
  const empty = page.locator('[data-testid="preview-empty"]');
  await empty.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  check("unresolved participant shows the empty state", true);
  check(
    "empty state points at the issue count",
    /Fix 1 issue to preview/.test((await empty.textContent()) ?? ""),
  );
  console.log("\nDocumentation workspace:");
  // A fresh project so the tab strip, search, and archive checks below start from
  // a known state. Tabs are workspace-wide, so the count is captured rather than
  // assumed; each creation waits for its tab to appear, because the editor is
  // already on screen when a document is created and waiting for the editor alone
  // would race the new tab.
  const tabs = page.locator('[data-testid="tab"]');
  const tabsBefore = await tabs.count();
  const waitForTabs = (count) =>
    page.waitForFunction(
      (expected) =>
        document.querySelectorAll('[data-testid="tab"]').length === expected,
      count,
      { timeout: UI_TIMEOUT_MS },
    );
  // Locate a project row by name, so the checks do not depend on the
  // repository's project ordering.
  const projectRow = (name) =>
    page.locator('[data-testid="explorer-project"]').filter({ hasText: name });

  await page.locator('[data-testid="local-create-toggle"]').click();
  await page.locator('[data-testid="project-name-input"]').fill("Workspace");
  await page.locator('[data-testid="create-project-button"]').click();

  await projectRow("Workspace")
    .locator('[data-testid="project-add-button"]')
    .click();
  await page.locator('[data-testid="context-menu-new-diagram"]').click();
  await waitForTabs(tabsBefore + 1);
  await page
    .locator('[data-testid="dsl-textarea"]')
    .fill(
      [
        "title Checkout",
        "participant CartService",
        "participant PaymentService",
        "CartService ->> PaymentService: SEARCHMARKER",
      ].join("\n"),
    );

  await projectRow("Workspace")
    .locator('[data-testid="project-add-button"]')
    .click();
  await page.locator('[data-testid="context-menu-new-note"]').click();
  await waitForTabs(tabsBefore + 2);
  await page.locator('[data-testid="markdown-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  await page
    .locator('[data-testid="markdown-textarea"]')
    .fill(
      [
        "# Handbook",
        "",
        "| Step | Owner |",
        "| --- | --- |",
        "| Authorize | PaymentService |",
      ].join("\n"),
    );

  // Both kinds share one strip: the diagram tab and the document tab coexist.
  check(
    "a diagram and a document open in one tab strip",
    (await tabs.count()) === tabsBefore + 2,
    `${tabsBefore} → ${await tabs.count()}`,
  );
  check(
    "each tab names its document kind",
    (await tabs.nth(tabsBefore).getAttribute("data-kind")) === "diagram" &&
      (await tabs.nth(tabsBefore + 1).getAttribute("data-kind")) === "note",
  );
  check(
    "the markdown document renders a table",
    (await page.locator('[data-testid="markdown-body"] table').count()) === 1,
  );
  check(
    "a table cell carries its text",
    (
      (await page
        .locator('[data-testid="markdown-body"] table td')
        .first()
        .textContent()) ?? ""
    ).includes("Authorize"),
  );

  // Project-wide search spans both kinds and lands the caret on the match.
  await page.keyboard.press("Control+Shift+F");
  await page.locator('[data-testid="search-panel"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  await page.locator('[data-testid="search-input"]').fill("SEARCHMARKER");
  await page.locator('[data-testid="search-result"]').first().waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check(
    "search finds text inside a diagram",
    (await page.locator('[data-testid="search-result"]').count()) === 1,
  );
  await page.locator('[data-testid="search-result-button"]').first().click();
  await page.locator('[data-testid="dsl-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  const selection = await page
    .locator('[data-testid="dsl-textarea"]')
    .evaluate((element) => ({
      start: element.selectionStart,
      end: element.selectionEnd,
      selected: element.value.slice(
        element.selectionStart,
        element.selectionEnd,
      ),
    }));
  check(
    "opening a result selects the matching text",
    selection.selected === "SEARCHMARKER",
    `selected ${JSON.stringify(selection.selected)}`,
  );
  // A `participant:` query lists the documents declaring that participant.
  await page.keyboard.press("Control+Shift+F");
  await page
    .locator('[data-testid="search-input"]')
    .fill("participant:CartService");
  await page.locator('[data-testid="search-result"]').first().waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check(
    "a participant query finds the declaring diagram",
    (await page.locator('[data-testid="search-result"]').count()) === 1,
  );
  await page.keyboard.press("Escape");
  check(
    "Escape dismisses the search overlay",
    (await page.locator('[data-testid="search-panel"]').count()) === 0,
  );

  // Export the project as a ZIP and import that exact file back.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    (async () => {
      await page.locator('[data-testid="command-palette-button"]').click();
      await page
        .locator('[data-testid="palette-input"]')
        .fill("Export Project");
      await page.locator('[data-testid="palette-item-button"]').first().click();
    })(),
  ]);
  check(
    "Export Project downloads a named ZIP",
    download.suggestedFilename() === "Workspace.zip",
    download.suggestedFilename(),
  );

  const archivePath = await download.path();
  await page
    .locator('[data-testid="import-file-input"]')
    .setInputFiles(archivePath);
  // The import is asynchronous, so wait for the third project to appear.
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="explorer-project"]').length ===
      3,
    undefined,
    { timeout: UI_TIMEOUT_MS },
  );
  check("importing the exported archive adds the project", true);

  // The imported project becomes the selected one, so the explorer shows its
  // files and the first of them is loaded. Scope the file counts to that
  // project's own row: counting `explorer-diagram` across the whole explorer
  // measures every other project's files too, which is what made this assertion
  // fail once the suite had created projects of its own.
  const importedRow = page.locator(
    '[data-testid="explorer-project"][aria-current="true"]',
  );
  const importedSource = await waitForText(
    page.locator('[data-testid="dsl-textarea"]'),
    (text) => text.includes("SEARCHMARKER"),
    "imported diagram source",
  );
  check(
    "the imported document keeps its content",
    importedSource.includes("CartService"),
  );
  // An import writes its files one by one, so the note can still be arriving when
  // the diagram is already open. Waiting for it makes the count below a fact
  // rather than a race.
  await importedRow
    .locator('[data-testid="explorer-note"]')
    .first()
    .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  const importedDiagrams = await importedRow
    .locator('[data-testid="explorer-diagram"]')
    .count();
  const importedNotes = await importedRow
    .locator('[data-testid="explorer-note"]')
    .count();
  check(
    "the imported project carries its files",
    importedDiagrams === 1 && importedNotes === 1,
    `${importedDiagrams} diagram(s), ${importedNotes} note(s)`,
  );

  console.log("\nProject intelligence:");
  // A dedicated project, so every check below starts from a known state rather
  // than from whichever document the earlier sections happened to leave open.
  const intelRow = page
    .locator('[data-testid="explorer-project"]')
    .filter({ hasText: "Intel" });
  const tabsAtIntel = await page.locator('[data-testid="tab"]').count();
  await page.locator('[data-testid="local-create-toggle"]').click();
  await page.locator('[data-testid="project-name-input"]').fill("Intel");
  await page.locator('[data-testid="create-project-button"]').click();

  await page
    .locator('[data-testid="explorer-project"]')
    .filter({ hasText: "Intel" })
    .locator('[data-testid="project-add-button"]')
    .click();
  await page.locator('[data-testid="context-menu-new-diagram"]').click();
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll('[data-testid="tab"]').length === expected,
    tabsAtIntel + 1,
    { timeout: UI_TIMEOUT_MS },
  );
  await page
    .locator('[data-testid="dsl-textarea"]')
    .fill(
      [
        "title Checkout",
        "participant CartService",
        "participant PaymentService",
        "",
        "CartService ->> PaymentService: Authorize",
      ].join("\n"),
    );

  // The outline describes the diagram's structure.
  await page.locator('[data-testid="view-outline"]').click();
  await page.locator('[data-testid="outline"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  // Section rows start collapsed; the first toggle belongs to "Participants".
  await page.locator('[data-testid="outline-item-toggle"]').first().click();
  const outlineText =
    (await page.locator('[data-testid="outline"]').textContent()) ?? "";
  check(
    "the outline lists the diagram's participants",
    outlineText.includes("CartService") &&
      outlineText.includes("PaymentService"),
  );
  check("the outline lists the diagram's flow", outlineText.includes("Flow"));

  // A document with a broken link becomes a project diagnostic.
  await page.locator('[data-testid="view-code"]').click();
  await page
    .locator('[data-testid="explorer-project"]')
    .filter({ hasText: "Intel" })
    .locator('[data-testid="project-add-button"]')
    .click();
  await page.locator('[data-testid="context-menu-new-note"]').click();
  await page.locator('[data-testid="markdown-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  await page
    .locator('[data-testid="markdown-textarea"]')
    .fill("# Handbook\n\nSee [gone](nowhere.seq).");

  await page.locator('[data-testid="view-problems"]').click();
  await page.locator('[data-testid="problem-item"]').first().waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  const brokenProblem = page
    .locator('[data-testid="problem-item"]')
    .filter({ hasText: "nowhere.seq" })
    .first();
  await brokenProblem.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  check("a broken link raises a project problem", true);
  check(
    "the problem names the link that does not resolve",
    ((await brokenProblem.textContent()) ?? "").includes("nowhere.seq"),
  );
  check(
    "the problem is a warning, not an error",
    (await brokenProblem.getAttribute("data-severity")) === "warning",
  );

  // Quick open reaches a resource by name.
  await page.keyboard.press("Control+p");
  await page.locator('[data-testid="quick-open"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  await page.locator('[data-testid="quick-open-input"]').fill("checkout");
  await page.locator('[data-testid="quick-open-item"]').first().waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  await page.locator('[data-testid="quick-open-item"]').first().click();
  await page.locator('[data-testid="dsl-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("quick open opens a diagram by name", true);

  // Semantic completion offers the project's participants after an arrow.
  await page
    .locator('[data-testid="dsl-textarea"]')
    .fill(
      [
        "title Checkout",
        "participant CartService",
        "participant PaymentService",
        "",
        "CartService ->> PaymentService: Authorize",
        "CartService -> ",
      ].join("\n"),
    );
  // `fill` sets the value without moving the caret reliably, and completion is
  // answered for the caret, so put it at the end of the line first.
  await page.locator('[data-testid="dsl-textarea"]').press("End");
  await page.locator('[data-testid="completions"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  const completionText =
    (await page.locator('[data-testid="completions"]').textContent()) ?? "";
  check(
    "completion offers the participants this project declares",
    completionText.includes("PaymentService"),
  );

  // Clicking a rendered message with a real mouse selects that statement.
  await page.locator('[data-testid="dsl-textarea"]').press("Escape");
  // SVG lines have a zero-height bounding box, so click their painted stroke by
  // transforming a point on the line into screen coordinates.
  const message = page.locator('[data-testid="preview-svg"] [data-node-id^="message@"]');
  const clickPoint = await message.first().evaluate((line) => {
    const point = line.ownerSVGElement.createSVGPoint();
    point.x = (Number(line.getAttribute("x1")) + Number(line.getAttribute("x2"))) / 2;
    point.y = Number(line.getAttribute("y1"));
    const screenPoint = point.matrixTransform(line.getScreenCTM());
    return { x: screenPoint.x, y: screenPoint.y };
  });
  await page.mouse.click(clickPoint.x, clickPoint.y);
  const selectedText = await page
    .locator('[data-testid="dsl-textarea"]')
    .evaluate((element) =>
      element.value.slice(element.selectionStart, element.selectionEnd),
    );
  check(
    "clicking a rendered message selects its source statement",
    selectedText.includes("Authorize"),
    `selected ${JSON.stringify(selectedText)}`,
  );

  // ... and the caret's statement is highlighted on the canvas in return.
  check(
    "the caret's statement is highlighted on the canvas",
    (await page
      .locator('[data-testid="preview-svg"] .svg-node--active')
      .count()) === 1,
  );

  console.log("\nEvent flows:");
  // A second documentation language, created and rendered in the same shell.
  await page.locator('[data-testid="local-create-toggle"]').click();
  await page.locator('[data-testid="project-name-input"]').fill("Orders");
  await page.locator('[data-testid="create-project-button"]').click();
  // Creating a document is asynchronous, and the editor was already on screen, so
  // waiting for the editor alone would let the fill below race the create and be
  // overwritten by the new, empty document. The tab appearing is the concrete
  // signal that the created document is the one on screen (the same wait the
  // "Workspace" and "Intel" sections already use).
  const tabsBeforeFlow = await page.locator('[data-testid="tab"]').count();
  await page
    .locator('[data-testid="explorer-project"]')
    .filter({ hasText: "Orders" })
    .locator('[data-testid="project-add-button"]')
    .click();
  await page.locator('[data-testid="context-menu-new-event-flow"]').click();
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll('[data-testid="tab"]').length === expected,
    tabsBeforeFlow + 1,
    { timeout: UI_TIMEOUT_MS },
  );
  await page.locator('[data-testid="dsl-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check(
    "New Event Flow creates a .eventseq document",
    (
      await page
        .locator('[data-testid="explorer-diagram"]')
        .last()
        .textContent()
    )?.includes(".eventseq") === true,
  );

  await page
    .locator('[data-testid="dsl-textarea"]')
    .fill(
      [
        "title Order Processing",
        "event OrderCreated",
        "topic orders",
        "producer OrderService",
        "consumer BillingService",
        "OrderService publishes OrderCreated to orders",
        "BillingService consumes OrderCreated from orders",
      ].join("\n"),
    );
  await page.locator('[data-testid="preview-svg"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  const eventSvg = await page
    .locator('[data-testid="preview-svg"]')
    .textContent();
  check(
    "an event flow renders its event, producer and consumer",
    (eventSvg ?? "").includes("OrderCreated") &&
      (eventSvg ?? "").includes("OrderService") &&
      (eventSvg ?? "").includes("BillingService"),
  );
  check(
    "the rendered event is addressable for source navigation",
    (await page
      .locator('[data-testid="preview-svg"] [data-node-id^="event@"]')
      .count()) === 1,
  );
  check(
    "the status bar counts the events the flow declares",
    (
      (await page
        .locator('[data-testid="status-participants"]')
        .textContent()) ?? ""
    ).includes("1 event"),
  );

  // A normal laptop viewport must keep the DSL editor inside the workspace;
  // this is the regression for the diagram editor overlapping the status bar.
  await page.setViewportSize({ width: 1440, height: 720 });
  await page
    .locator('[data-testid="dsl-textarea"]')
    .fill(
      Array.from({ length: 80 }, (_, index) => `event Event${index}`).join(
        "\n",
      ),
    );
  const scrollBounds = await page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="dsl-textarea"]');
    const code = document.querySelector(".editor__code");
    if (!(textarea instanceof HTMLTextAreaElement) || !code) return null;
    textarea.scrollTop = textarea.scrollHeight;
    const textareaBounds = textarea.getBoundingClientRect();
    return {
      canScroll: textarea.scrollHeight > textarea.clientHeight,
      didScroll: textarea.scrollTop > 0,
      textareaBottom: textareaBounds.bottom,
      codeBottom: code.getBoundingClientRect().bottom,
    };
  });
  check(
    "event-flow editor scrolls long source",
    scrollBounds?.canScroll === true && scrollBounds.didScroll,
    scrollBounds
      ? `${scrollBounds.canScroll}/${scrollBounds.didScroll}`
      : "missing editor",
  );
  check(
    "event-flow textarea stays inside the code area",
    (scrollBounds?.textareaBottom ?? 0) <=
      (scrollBounds?.codeBottom ?? 0) + 0.5,
    scrollBounds
      ? `${scrollBounds.textareaBottom.toFixed(2)} vs ${scrollBounds.codeBottom.toFixed(2)}`
      : "missing editor",
  );
  const flowEditorBounds = await page.evaluate(() => ({
    editorBottom:
      document
        .querySelector('[aria-label="Event flow editor"]')
        ?.getBoundingClientRect().bottom ?? 0,
    statusbarTop:
      document.querySelector(".app__statusbar")?.getBoundingClientRect().top ??
      0,
  }));
  check(
    "event-flow editor stays above the status bar at laptop height",
    flowEditorBounds.editorBottom <= flowEditorBounds.statusbarTop + 0.5,
    `${flowEditorBounds.editorBottom.toFixed(2)} vs ${flowEditorBounds.statusbarTop.toFixed(2)}`,
  );
  await page
    .locator('[data-testid="dsl-textarea"]')
    .fill(
      [
        "title Order Processing",
        "event OrderCreated",
        "topic orders",
        "producer OrderService",
        "consumer BillingService",
        "OrderService publishes OrderCreated to orders",
        "BillingService consumes OrderCreated from orders",
      ].join("\n"),
    );

  console.log("\nEvent-flow highlighting:");
  const flowEditor = page.locator('[data-testid="dsl-textarea"]');
  const boldEventNames = await page
    .locator('[data-testid="editor-highlight"] strong')
    .allTextContents();
  check(
    "event, broker, channel and service names are bolded",
    ["OrderCreated", "orders", "OrderService", "BillingService"].every((name) =>
      boldEventNames.includes(name),
    ),
    boldEventNames.join(", "),
  );
  check(
    "event-flow highlight mirrors the source",
    (await page.locator('[data-testid="editor-highlight"]').textContent()) ===
      (await flowEditor.inputValue()),
  );
  // Retyping an event's name carries the edges that reference it, so the flow
  // never collapses into "unknown event" mid-edit.
  await flowEditor.evaluate((el) => {
    el.focus();
    const at =
      el.value.indexOf("event OrderCreated") + "event OrderCreated".length;
    el.setSelectionRange(at, at);
  });
  await page.keyboard.type("V2");
  const renamedFlow = await flowEditor.inputValue();
  check(
    "renaming an event rewrites its edges",
    renamedFlow.includes("OrderService publishes OrderCreatedV2 to orders") &&
      renamedFlow.includes(
        "BillingService consumes OrderCreatedV2 from orders",
      ),
    renamedFlow,
  );

  console.log("\nEvent-driven diagnostics:");
  // A design mistake an event-driven review exists to catch.
  await page
    .locator('[data-testid="dsl-textarea"]')
    .fill("event Lonely\nGhost publishes Nowhere");
  await page.locator('[data-testid="view-problems"]').click();
  await page.locator('[data-testid="problem-item"]').first().waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  const problemText =
    (await page.locator('[data-testid="problems"]').textContent()) ?? "";
  check(
    "an undeclared producer is reported",
    problemText.includes("Unknown service"),
  );
  check(
    "an event nothing publishes is reported",
    problemText.includes("has no producer"),
  );

  check(
    "still no uncaught page errors",
    consoleErrors.length === 0,
    consoleErrors.join("; "),
  );

  await page.close();
}

/**
 * Drive the authenticated server scenarios.
 *
 * Each scenario opens its own browser contexts, so cookies and sessions never
 * leak between them: two contexts signed in as different people must not share a
 * session, and an anonymous context must genuinely start with no session.
 */
async function runServerChecks(browser, idp, apiBase, mcpBase) {
  const owner = {
    sub: "e2e-owner",
    name: "E2E Owner",
    email: "owner@e2e.test",
  };
  const platformAdmin = {
    sub: "e2e-platform-admin",
    name: "E2E Platform Admin",
    email: "platform-admin@e2e.test",
  };
  const viewer = {
    sub: "e2e-viewer",
    name: "E2E Viewer",
    email: "viewer@e2e.test",
  };

  await scenario("UX-3B.1 Dual View preserves independent visual sessions", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, hasTouch: true });
    const page = await context.newPage();
    const http500s = [];
    let projectId = null;
    let workId = null;
    let isolationProjectId = null;
    let isolationWorkId = null;
    let isolationResourceId = null;
    page.on("response", (response) => {
      if (response.status() === 500) {
        http500s.push(`${response.request().method()} ${new URL(response.url()).pathname} 500`);
      }
    });

    try {
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(page);
      await signIn(page, idp, owner);

      const projectName = `UX-3B.1 Dual View ${Date.now()}`;
      await createServerProject(page, projectName);
      const project = await serverProjectByName(page, projectName);
      if (!project) throw new Error("Disposable Dual View project was not discoverable.");
      projectId = project.id;

      const workName = `dual-view-${Date.now()}`;
      await page.getByTestId("explorer-my-work-create").click();
      await page.getByRole("dialog", { name: "Create MY WORK draft" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByLabel("Draft name").fill(workName);
      await page.getByRole("button", { name: "Create draft" }).click();
      const workDeadline = Date.now() + UI_TIMEOUT_MS;
      while (Date.now() < workDeadline) {
        const contexts = await apiRequest(page, `/api/projects/${projectId}/private-work`);
        workId = contexts.json?.contexts?.find((entry) => entry.name === workName)?.id ?? null;
        if (workId) break;
        await delay(100);
      }
      if (!workId) throw new Error("Disposable MY WORK context was not created.");

      const resources = [
        {
          path: "alpha.seq",
          type: "sequence-diagram",
          content: [
            "title Alpha",
            "participant Browser",
            "participant Gateway",
            "participant Store",
            "Browser -> Gateway: Request",
            "Gateway -> Store: Read",
            "Store --> Gateway: Result",
            "Gateway --> Browser: Response",
            "Browser -> Browser: Retry locally",
          ].join("\n"),
        },
        {
          path: "beta.seq",
          type: "sequence-diagram",
          content: [
            "title Beta",
            "participant Client",
            "participant API",
            "participant Queue",
            "Client -> API: Submit",
            "API -> Queue: Publish",
            "Queue --> API: Accepted",
            "API --> Client: Done",
          ].join("\n"),
        },
        {
          path: "dual-view-note.md",
          type: "markdown-document",
          content: "# Parallel test note\n\nA disposable note for the Dual View smoke test.\n",
        },
        {
          path: "long-reading.md",
          type: "markdown-document",
          content: ["# Long reading", ...Array.from({ length: 80 }, (_, index) => `\n## Section ${index + 1}\n\nThis disposable paragraph provides enough content to exercise the real Markdown reading scroller in Chromium.`)].join("\n"),
        },
        {
          path: "long-reading-alt.md",
          type: "markdown-document",
          content: ["# Alternate reading", ...Array.from({ length: 80 }, (_, index) => `\n## Alternate section ${index + 1}\n\nA separate disposable document for testing resource identity across viewer swaps.`)].join("\n"),
        },
        {
          path: "orders.eventseq",
          type: "event-flow",
          content: [
            "event OrderCreated",
            "producer OrderService",
            "consumer BillingService",
            "OrderService publishes OrderCreated",
            "BillingService consumes OrderCreated",
            "handler BillingHandler in BillingService",
            "OrderCreated handled by BillingHandler",
            "effect persist-order on BillingHandler kind database: Store the order",
          ].join("\n"),
        },
      ];
      const createdResources = new Map();
      for (const resource of resources) {
        const response = await apiRequest(page, `/api/projects/${projectId}/resources`, {
          method: "POST",
          body: JSON.stringify({ ...resource, contextId: workId }),
        });
        if (response.status !== 201 || !response.json?.resource?.id) {
          throw new Error(`Disposable ${resource.path} creation failed: ${response.status} ${response.text}`);
        }
        createdResources.set(resource.path, response.json.resource.id);
      }

      const isolationProjectName = `UX-3B.2b session isolation ${Date.now()}`;
      const isolationProjectResponse = await apiRequest(page, "/api/projects", {
        method: "POST", body: JSON.stringify({ name: isolationProjectName, workspaceId: project.workspaceId }),
      });
      if (isolationProjectResponse.status !== 201 || !isolationProjectResponse.json?.project?.id) throw new Error(`Isolation project fixture failed: ${isolationProjectResponse.status} ${isolationProjectResponse.text}`);
      isolationProjectId = isolationProjectResponse.json.project.id;
      const isolationWork = await apiRequest(page, `/api/projects/${isolationProjectId}/private-work`, {
        method: "POST", body: JSON.stringify({ name: "Dual View isolation fixture" }),
      });
      if (isolationWork.status !== 201 || !isolationWork.json?.context?.id) throw new Error(`Isolation MY WORK fixture failed: ${isolationWork.status} ${isolationWork.text}`);
      isolationWorkId = isolationWork.json.context.id;
      const isolationResource = await apiRequest(page, `/api/projects/${isolationProjectId}/resources`, {
        method: "POST",
        body: JSON.stringify({ path: "isolation.concept", type: "conceptual", content: 'concept isolated "P2 only"', contextId: isolationWorkId }),
      });
      if (isolationResource.status !== 201 || !isolationResource.json?.resource?.id) throw new Error(`Isolation resource fixture failed: ${isolationResource.status} ${isolationResource.text}`);
      isolationResourceId = isolationResource.json.resource.id;
      const isolationMarkdownContent = ["# P2 isolated reading", ...Array.from({ length: 50 }, (_, index) => `\n## P2 section ${index + 1}\n\nP2-only reading content for real scroller isolation.`)].join("\n");
      const isolationMarkdown = await apiRequest(page, `/api/projects/${isolationProjectId}/resources`, {
        method: "POST",
        body: JSON.stringify({ path: "isolation-reading.md", type: "markdown-document", content: isolationMarkdownContent, contextId: isolationWorkId }),
      });
      if (isolationMarkdown.status !== 201 || !isolationMarkdown.json?.resource?.id) throw new Error(`Isolation Markdown fixture failed: ${isolationMarkdown.status} ${isolationMarkdown.text}`);
      const isolationMarkdownId = isolationMarkdown.json.resource.id;

      // Prepare an actual SHARED artifact only through the disposable project's
      // proposal lifecycle; direct authoritative writes are intentionally refused.
      const sharedSeedTitle = `Navigation SHARED seed ${Date.now()}`;
      const sharedSeed = await apiRequest(page, `/api/projects/${projectId}/architectural-proposals`, {
        method: "POST",
        body: JSON.stringify({ sourcePrivateContextId: workId, resourceIds: [createdResources.get("alpha.seq"), createdResources.get("long-reading.md")], title: sharedSeedTitle, description: "Disposable E2E SHARED navigation fixture." }),
      });
      if (sharedSeed.status !== 201) throw new Error(`SHARED navigation fixture proposal failed: ${sharedSeed.status} ${sharedSeed.text}`);
      const reviewerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const reviewerPage = await reviewerContext.newPage();
      await reviewerPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(reviewerPage);
      const dualReviewer = { sub: `e2e-dual-reviewer-${Date.now()}`, name: "Dual View Reviewer", email: `dual-reviewer-${Date.now()}@e2e.test` };
      await signIn(reviewerPage, idp, dualReviewer);
      const reviewerId = (await apiRequest(reviewerPage, "/api/me")).json.user.id;
      const projectDetails = await apiRequest(page, `/api/projects/${projectId}`);
      const reviewerWorkspaceMembership = await apiRequest(page, `/api/workspaces/${projectDetails.json.project.workspaceId}/members/${reviewerId}`, { method: "PUT", body: JSON.stringify({ role: "EDITOR" }) });
      const reviewerProjectMembership = await apiRequest(page, `/api/projects/${projectId}/members/${reviewerId}`, { method: "PUT", body: JSON.stringify({ role: "EDITOR" }) });
      if (reviewerWorkspaceMembership.status !== 200 || reviewerProjectMembership.status !== 204) throw new Error(`Could not authorize disposable fixture reviewer: workspace=${reviewerWorkspaceMembership.status}, project=${reviewerProjectMembership.status}`);
      await reviewerPage.goto(`${BASE_URL}/?project=${encodeURIComponent(projectId)}`, { waitUntil: "domcontentloaded" });
      await reviewerPage.locator('[data-testid="workspace-active-project"]').filter({ hasText: projectName }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const seedProposal = reviewerPage.locator('[data-testid="explorer-proposal"]').filter({ hasText: sharedSeedTitle }).getByTestId("explorer-proposal-open");
      await seedProposal.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await seedProposal.click();
      await reviewerPage.locator('section[aria-label="Architectural Proposal"]').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await reviewerPage.locator('section[aria-label="Proposal review"] textarea').fill("Disposable test fixture approval.");
      await reviewerPage.locator('section[aria-label="Proposal review"] button').filter({ hasText: "Approve proposal" }).click();
      await waitForText(reviewerPage.locator('section[aria-label="Proposal review"]'), text => text.includes("1 approvals"), "navigation fixture approval");
      await page.goto(`${BASE_URL}/?project=${encodeURIComponent(projectId)}`, { waitUntil: "domcontentloaded" });
      await page.locator('[data-testid="workspace-active-project"]').filter({ hasText: projectName }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const ownerProposalToggle = page.locator('[data-testid="explorer-proposals-toggle"]');
      if ((await ownerProposalToggle.getAttribute("aria-expanded")) !== "true") await ownerProposalToggle.click();
      await page.locator('[data-testid="explorer-proposal"]').filter({ hasText: sharedSeedTitle }).getByTestId("explorer-proposal-open").click();
      await page.locator('section[aria-label="Architectural Proposal"]').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByRole("button", { name: "Preview promotion" }).click();
      await waitForText(page.locator('section[aria-label="Proposal promotion"]'), text => text.includes("Ready to promote"), "navigation fixture promotion preview");
      await page.getByRole("button", { name: "Promote to SHARED" }).click();
      await waitForText(page.locator('section[aria-label="Architectural Proposal"]'), text => text.includes("PROMOTED"), "navigation fixture promotion");
      await reviewerContext.close();

      await page.goto(`${BASE_URL}/?project=${encodeURIComponent(projectId)}`, { waitUntil: "domcontentloaded" });
      await page.locator('[data-testid="workspace-active-project"]').filter({ hasText: projectName }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await openMyWorkContext(page, workId);
      const sharedToggle = page.locator('[data-testid="explorer-shared-toggle"]');
      if ((await sharedToggle.getAttribute("aria-expanded")) !== "true") await sharedToggle.click();
      const privateTree = page.locator('[data-testid="explorer-my-work-section"]');
      const alphaButton = privateTree.getByRole("button", { name: "Load diagram Alpha" });
      const betaButton = privateTree.getByRole("button", { name: "Load diagram Beta" });
      await alphaButton.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await betaButton.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await alphaButton.click();

      await page.getByTestId("compare-mode-button").click();
      const dualView = page.getByTestId("dual-view");
      await dualView.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const editorTabIds = ["view-code", "view-outline", "view-problems", "view-overview", "view-history", "view-changes"];
      const checkEditorTabsDisabled = async () => {
        const states = await Promise.all(editorTabIds.map(async (id) => {
          const tab = page.getByTestId(id);
          return (await tab.count()) === 0 || await tab.isDisabled();
        }));
        return states.every(Boolean);
      };
      const sharedTree = page.locator('[data-testid="explorer-shared-section"]');
      const sharedResourceOpeners = sharedTree.getByTestId("select-diagram-button");
      const myWorkResourceOpeners = privateTree.getByTestId("select-diagram-button");
      check("Dual View uses native disabled on editor tabs", await checkEditorTabsDisabled());
      check("Dual View disables SHARED and MY WORK artifact openers natively", await sharedResourceOpeners.count() > 0 && await myWorkResourceOpeners.count() > 0 &&
        await sharedResourceOpeners.evaluateAll((buttons) => buttons.every((button) => button instanceof HTMLButtonElement && button.disabled)) &&
        await myWorkResourceOpeners.evaluateAll((buttons) => buttons.every((button) => button instanceof HTMLButtonElement && button.disabled)));
      const selectedWorkspaceResourceBeforeAttempt = await page.locator('[data-testid="explorer-diagram"].explorer__resource--selected, [data-testid="explorer-diagram"].explorer__diagram--selected').textContent();
      const viewerBeforeAttempt = await page.getByTestId("dual-pane-a").locator("h2").textContent();
      await myWorkResourceOpeners.first().evaluate((button) => button.click());
      await page.keyboard.press("Tab");
      check("Disabled artifact openers do not change Explorer selection or rendered viewer", await page.locator('[data-testid="explorer-diagram"].explorer__resource--selected, [data-testid="explorer-diagram"].explorer__diagram--selected').textContent() === selectedWorkspaceResourceBeforeAttempt && await page.getByTestId("dual-pane-a").locator("h2").textContent() === viewerBeforeAttempt);
       check("Dual View shows the Viewer A/B navigation hint", await page.getByTestId("comparison-navigation-hint").textContent() === "Usa los selectores Viewer A/B para cambiar los recursos mientras comparas");
       const editorShell = page.locator(".app__pane--editor");
       const immersiveShellState = async () => page.locator(".app__workspace").evaluate((workspace) => {
         const preview = workspace.querySelector(".app__pane--preview");
         const editor = workspace.querySelector(".app__pane--editor");
         const explorer = workspace.querySelector(".app__pane--explorer");
         const splitters = [...workspace.querySelectorAll(":scope > .app__splitter")];
         const rect = (element) => {
           const box = element.getBoundingClientRect();
           return { x: box.x, y: box.y, width: box.width, height: box.height };
         };
         return {
           active: workspace.classList.contains("app__workspace--immersive"),
           preview: rect(preview),
           workspace: rect(workspace),
           editorDisplay: getComputedStyle(editor).display,
           explorerDisplay: explorer ? getComputedStyle(explorer).display : "collapsed",
           splitterDisplays: splitters.map((splitter) => getComputedStyle(splitter).display),
         };
       });
       const dualShell = await immersiveShellState();
       check("Dual View hides editor, Explorer, and splitters while retaining the editor DOM", await editorShell.count() === 1 && dualShell.active && dualShell.editorDisplay === "none" && dualShell.explorerDisplay === "none" && dualShell.splitterDisplays.every((display) => display === "none"));
       check("Dual View preview occupies the available workspace width", dualShell.preview.x === dualShell.workspace.x && Math.abs(dualShell.preview.width - dualShell.workspace.width) <= 1, JSON.stringify(dualShell));
       check("Global toolbar remains visible in the immersive shell", await page.locator(".app__toolbar").isVisible());
       check("Dual View retains project/workspace/context and per-view resource selectors", await page.getByRole("combobox", { name: "Dual View project" }).isVisible() && await page.getByRole("combobox", { name: "Dual View workspace" }).isVisible() && await page.getByRole("combobox", { name: "Dual View context" }).isVisible() && await page.getByRole("combobox", { name: "Dual View A resource" }).isVisible() && await page.getByRole("combobox", { name: "Dual View B resource" }).isVisible());
       const dualContext = page.getByRole("combobox", { name: "Dual View context" });
       const selectedContext = await dualContext.inputValue();
       await dualContext.selectOption("shared");
       await page.waitForFunction(() => document.querySelector('[aria-label="Dual View context"]')?.value === "shared", undefined, { timeout: UI_TIMEOUT_MS });
       await page.getByRole("combobox", { name: "Dual View context" }).selectOption(selectedContext);
       await page.waitForFunction((value) => document.querySelector('[aria-label="Dual View context"]')?.value === value, selectedContext, { timeout: UI_TIMEOUT_MS });
       await dualView.getByRole("button", { name: "Switch to Analysis" }).click();
       await page.getByTestId("comparison-view").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       const analysisShell = await immersiveShellState();
       check("Dual to Analysis switches without exposing the workspace shell", analysisShell.active && analysisShell.editorDisplay === "none" && analysisShell.explorerDisplay === "none" && analysisShell.splitterDisplays.every((display) => display === "none"));
       check("Analysis keeps project, context, and Viewer A/B controls available", await page.getByRole("combobox", { name: "Comparison project" }).count() === 1 && await page.getByRole("combobox", { name: "Comparison context" }).isVisible() && await page.getByRole("combobox", { name: "Viewer A resource" }).isVisible() && await page.getByRole("combobox", { name: "Viewer B resource" }).isVisible());
       await page.getByRole("button", { name: "Switch to Dual View" }).click();
       await page.getByTestId("dual-view").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       check("Analysis to Dual returns directly to the immersive shell", (await immersiveShellState()).active && await page.locator(".app__toolbar").isVisible());
       await page.getByRole("button", { name: "Fullscreen" }).click();
       await page.waitForFunction(() => document.fullscreenElement === document.querySelector("[data-testid='dual-view']"), undefined, { timeout: UI_TIMEOUT_MS });
       await page.getByRole("button", { name: "Switch to Analysis" }).click();
       await page.waitForFunction(() => document.fullscreenElement === null, undefined, { timeout: UI_TIMEOUT_MS });
       await page.getByTestId("comparison-view").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       check("Switching modes exits the previous Fullscreen target before replacing it", await page.evaluate(() => document.fullscreenElement === null) && (await immersiveShellState()).active);
       await page.getByRole("button", { name: "Switch to Dual View" }).click();
       await page.getByTestId("dual-view").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const dualFocus = dualView.getByRole("button", { name: "Focus" });
      await dualFocus.click();
      await page.locator(".app--dual-focus").waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
      check("Dual View Focus hides Explorer and retains both viewers plus essential controls", !(await page.locator(".app__pane--explorer").isVisible()) && await page.getByTestId("dual-pane-a").isVisible() && await page.getByTestId("dual-pane-b").isVisible() && await dualView.getByRole("button", { name: "Close Dual View" }).isVisible());
      await page.keyboard.press("Escape");
      await page.locator(".app--dual-focus").waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
      await dualView.getByRole("button", { name: "Focus" }).click();
      await dualView.getByRole("button", { name: "Fullscreen" }).click();
      await page.waitForFunction(() => document.fullscreenElement === document.querySelector("[data-testid='dual-view']"), undefined, { timeout: UI_TIMEOUT_MS });
      check("Dual View Fullscreen targets the complete dual-view root", await page.evaluate(() => document.fullscreenElement?.getAttribute("data-testid") === "dual-view"));
      await dualView.getByRole("button", { name: "Exit fullscreen" }).click();
      await page.waitForFunction(() => document.fullscreenElement === null, undefined, { timeout: UI_TIMEOUT_MS });
      check("Explicit Fullscreen exit retains Dual View and Focus state", await page.getByTestId("dual-view").isVisible() && await page.locator(".app--dual-focus").count() === 1);
      await page.keyboard.press("Escape");
      await page.locator(".app--dual-focus").waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
      const viewerA = page.getByRole("combobox", { name: "Dual View A resource" });
      const viewerB = page.getByRole("combobox", { name: "Dual View B resource" });
      const alphaId = `my-work:${workId}:${createdResources.get("alpha.seq")}`;
      const betaId = `my-work:${workId}:${createdResources.get("beta.seq")}`;
      const noteId = `my-work:${workId}:${createdResources.get("dual-view-note.md")}`;
      const longNoteId = `my-work:${workId}:${createdResources.get("long-reading.md")}`;
      const alternateLongNoteId = `my-work:${workId}:${createdResources.get("long-reading-alt.md")}`;
      const eventFlowId = `my-work:${workId}:${createdResources.get("orders.eventseq")}`;
       await viewerA.selectOption(alphaId);
       await viewerB.selectOption(betaId);
      check("Dual View selectors hold the two requested resource identities", await viewerA.inputValue() === alphaId && await viewerB.inputValue() === betaId);
      const dualSlot = pane => page.locator(`.comparison__slot[data-pane="${pane}"]`);
      await page.getByRole("button", { name: "Maximize Viewer A" }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="dual-view"]')?.getAttribute("data-maximized-pane") === "a", undefined, { timeout: UI_TIMEOUT_MS });
       const maximizeAState = await Promise.all([dualSlot("a").evaluate(element => ({ display: getComputedStyle(element).display, ...element.getBoundingClientRect().toJSON() })), dualSlot("b").evaluate(element => ({ display: getComputedStyle(element).display, visibility: getComputedStyle(element).visibility, inert: element.inert, ariaHidden: element.getAttribute("aria-hidden"), mountedPane: Boolean(element.querySelector('[data-testid="dual-pane-b"]')), ...element.getBoundingClientRect().toJSON() })), viewerA.isVisible(), page.getByRole("button", { name: "Restore Viewer A" }).evaluate(element => ({ pressed: element.getAttribute("aria-pressed"), focused: document.activeElement === element }))]);
       check("Dual View maximized A is visible, keeps B mounted but inert and measured, and retains global controls", maximizeAState[0].display !== "none" && maximizeAState[0].width > 0 && maximizeAState[0].height > 0 && maximizeAState[1].visibility === "hidden" && maximizeAState[1].width > 0 && maximizeAState[1].height > 0 && maximizeAState[1].inert && maximizeAState[1].ariaHidden === "true" && maximizeAState[1].mountedPane && maximizeAState[2] && maximizeAState[3].pressed === "true" && maximizeAState[3].focused, JSON.stringify(maximizeAState));
       const hiddenPaneAccess = await dualSlot("b").evaluate(element => {
         const rect = element.getBoundingClientRect();
         const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
         const button = element.querySelector("button");
         button?.focus();
         return { position: getComputedStyle(element).position, paneButtons: [...element.querySelectorAll("button")].length, focusUnchanged: !element.contains(document.activeElement), hitIntercepted: Boolean(hit && element.contains(hit)) };
       });
       check("The inert secondary slot is out of layout flow, cannot take focus or intercept pointer hits", hiddenPaneAccess.position === "absolute" && hiddenPaneAccess.paneButtons > 0 && hiddenPaneAccess.focusUnchanged && !hiddenPaneAccess.hitIntercepted, JSON.stringify(hiddenPaneAccess));
       check("The hidden pane's maximize control is absent from the accessibility role tree", await page.getByRole("button", { name: "Maximize Viewer B" }).count() === 0);
       await page.keyboard.press("Tab");
       check("Tab from the visible maximize control does not enter the inert pane", await dualSlot("b").evaluate(element => !element.contains(document.activeElement)));
       await page.getByRole("button", { name: "Swap dual viewers" }).focus();
       await page.keyboard.press("Tab");
       check("Keyboard tab order skips all controls in the secondary pane", await dualSlot("b").evaluate(element => !element.contains(document.activeElement)));
       check("Maximize control exposes an accessible name and pressed state", await page.getByRole("button", { name: "Restore Viewer A" }).getAttribute("aria-pressed") === "true");
       await page.getByRole("button", { name: "Focus" }).click();
       await page.getByRole("button", { name: "Fullscreen" }).click();
       await page.waitForFunction(() => document.fullscreenElement === document.querySelector('[data-testid="dual-view"]'), undefined, { timeout: UI_TIMEOUT_MS });
       await page.getByRole("button", { name: "Exit fullscreen" }).click();
       await page.waitForFunction(() => document.fullscreenElement === null, undefined, { timeout: UI_TIMEOUT_MS });
       await page.getByRole("button", { name: "Exit Focus" }).click();
       check("Focus and Fullscreen can exit without clearing local maximization", await page.getByTestId("dual-view").getAttribute("data-maximized-pane") === "a");
       await page.getByRole("button", { name: "Restore Viewer A" }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="dual-view"]')?.getAttribute("data-maximized-pane") === "normal", undefined, { timeout: UI_TIMEOUT_MS });
      const restoredSlotWidths = await Promise.all([dualSlot("a").evaluate(element => element.getBoundingClientRect().width), dualSlot("b").evaluate(element => element.getBoundingClientRect().width)]);
      check("Dual View restores both responsive pane dimensions without dropping either pane", restoredSlotWidths.every(width => width > 0) && Math.abs(restoredSlotWidths[0] - restoredSlotWidths[1]) < 4, JSON.stringify(restoredSlotWidths));
       await page.getByRole("button", { name: "Maximize Viewer B" }).click();
       await page.waitForFunction(() => document.querySelector('[data-testid="dual-view"]')?.getAttribute("data-maximized-pane") === "b", undefined, { timeout: UI_TIMEOUT_MS });
       check("Dual View can maximize B and preserve the resource selectors", await dualSlot("b").isVisible() && !(await dualSlot("a").isVisible()) && await viewerA.isVisible() && await viewerB.isVisible());
       await page.setViewportSize({ width: 1120, height: 820 });
       check("Resizing while B is maximized keeps its dimensions valid and A mounted", (await dualSlot("b").evaluate(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })) && await page.getByTestId("dual-pane-a").count() === 1);
      await page.getByRole("button", { name: "Restore Viewer B" }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="dual-view"]')?.getAttribute("data-maximized-pane") === "normal", undefined, { timeout: UI_TIMEOUT_MS });
      await page.setViewportSize({ width: 900, height: 1100 });
      const verticalPaneBounds = await Promise.all([dualSlot("a").evaluate(element => element.getBoundingClientRect().toJSON()), dualSlot("b").evaluate(element => element.getBoundingClientRect().toJSON())]);
      check("Responsive Dual View stacks both measured slots vertically", verticalPaneBounds.every(bounds => bounds.width > 0 && bounds.height > 0) && verticalPaneBounds[1].top >= verticalPaneBounds[0].bottom - 1, JSON.stringify(verticalPaneBounds));
      await page.getByRole("button", { name: "Maximize Viewer B" }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="dual-view"]')?.getAttribute("data-maximized-pane") === "b", undefined, { timeout: UI_TIMEOUT_MS });
      check("Responsive vertical layout still maximizes only the selected slot", await dualSlot("b").isVisible() && !(await dualSlot("a").isVisible()) && (await dualSlot("b").evaluate(element => element.getBoundingClientRect().height)) > 0);
      await page.getByRole("button", { name: "Restore Viewer B" }).click();
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.waitForFunction(() => document.querySelector('[data-testid="dual-view"]')?.getAttribute("data-maximized-pane") === "normal", undefined, { timeout: UI_TIMEOUT_MS });
       await viewerA.selectOption(noteId);
      await page.getByTestId("dual-pane-a").getByTestId("markdown-body").getByRole("heading", { name: "Parallel test note" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("Short Markdown content has no effective scroll range", await page.getByTestId("dual-pane-a").locator(".note-preview").evaluate((element) => Math.max(0, element.scrollHeight - element.clientHeight) === 0));
      await viewerA.selectOption(alphaId);
      await page.getByTestId("dual-pane-a").getByRole("heading", { name: "Alpha" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("Viewer A selector changes the actual rendered artifact", await page.getByTestId("dual-pane-a").locator("h2").textContent() === "Alpha");

      await viewerA.selectOption(longNoteId);
      await viewerB.selectOption(longNoteId);
      const notePaneA = page.getByTestId("dual-pane-a");
      const notePaneB = page.getByTestId("dual-pane-b");
      const markdownScroller = (pane) => pane.locator(".note-preview");
      const withinScrollTolerance = (actual, expected) => Math.abs(actual - expected) <= 2;
      await notePaneA.getByTestId("markdown-body").getByRole("heading", { name: "Section 80" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.evaluate(() => {
        const scrollers = [...document.querySelectorAll(".note-preview")];
        scrollers[0].scrollTop = 700;
        scrollers[0].dispatchEvent(new Event("scroll", { bubbles: true }));
        scrollers[1].scrollTop = 1_300;
        scrollers[1].dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await page.waitForTimeout(100);
      const realScrolls = await Promise.all([markdownScroller(notePaneA).evaluate((element) => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight })), markdownScroller(notePaneB).evaluate((element) => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight }))]);
      check("Markdown capture uses the real .note-preview scroller with distinct A/B offsets", realScrolls[0].top === 700 && realScrolls[1].top === 1_300 && realScrolls.every((state) => state.max > state.top), JSON.stringify(realScrolls));
      await page.getByRole("button", { name: "Maximize Viewer A" }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="dual-view"]')?.getAttribute("data-maximized-pane") === "a", undefined, { timeout: UI_TIMEOUT_MS });
      const markdownWhileMaximized = await Promise.all([markdownScroller(notePaneA).evaluate(element => element.scrollTop), markdownScroller(notePaneB).evaluate(element => element.scrollTop)]);
      check("Markdown keeps each real scrollTop while one pane is inert and hidden", withinScrollTolerance(markdownWhileMaximized[0], 700) && withinScrollTolerance(markdownWhileMaximized[1], 1_300) && await page.getByTestId("dual-pane-b").count() === 1, JSON.stringify(markdownWhileMaximized));
       await page.getByRole("button", { name: "Restore Viewer A" }).click();
       await page.waitForFunction(() => Math.abs((document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop ?? 0) - 700) <= 2 && Math.abs((document.querySelector('[data-testid="dual-pane-b"] .note-preview')?.scrollTop ?? 0) - 1_300) <= 2, undefined, { timeout: UI_TIMEOUT_MS });
       check("Restoring Markdown panes retains both measured reading offsets", withinScrollTolerance(await markdownScroller(notePaneA).evaluate(element => element.scrollTop), 700) && withinScrollTolerance(await markdownScroller(notePaneB).evaluate(element => element.scrollTop), 1_300));
       await page.getByRole("button", { name: "Maximize Viewer B" }).click();
       await page.waitForFunction(() => document.querySelector('[data-testid="dual-view"]')?.getAttribute("data-maximized-pane") === "b", undefined, { timeout: UI_TIMEOUT_MS });
       const markdownBMaximized = await Promise.all([markdownScroller(notePaneA).evaluate(element => element.scrollTop), markdownScroller(notePaneB).evaluate(element => element.scrollTop)]);
       await page.getByRole("button", { name: "Restore Viewer B" }).click();
       await page.waitForFunction(() => document.querySelector('[data-testid="dual-view"]')?.getAttribute("data-maximized-pane") === "normal", undefined, { timeout: UI_TIMEOUT_MS });
       check("Markdown maximizing and restoring B preserves both real scrollTop values", withinScrollTolerance(markdownBMaximized[0], 700) && withinScrollTolerance(markdownBMaximized[1], 1_300) && withinScrollTolerance(await markdownScroller(notePaneA).evaluate(element => element.scrollTop), 700) && withinScrollTolerance(await markdownScroller(notePaneB).evaluate(element => element.scrollTop), 1_300), JSON.stringify(markdownBMaximized));
       await page.getByRole("button", { name: "Swap dual viewers" }).click();
       await page.waitForFunction(() => Math.abs((document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop ?? 0) - 1_300) <= 2, undefined, { timeout: UI_TIMEOUT_MS });
       await page.getByRole("button", { name: "Maximize Viewer A" }).click();
       const sameResourceMaximized = await Promise.all([markdownScroller(notePaneA).evaluate(element => element.scrollTop), markdownScroller(notePaneB).evaluate(element => element.scrollTop)]);
       await page.getByRole("button", { name: "Restore Viewer A" }).click();
       await page.waitForFunction(() => document.querySelector('[data-testid="dual-view"]')?.getAttribute("data-maximized-pane") === "normal", undefined, { timeout: UI_TIMEOUT_MS });
       check("Same-resource Markdown sessions retain independent offsets through maximize/restore after Swap", withinScrollTolerance(sameResourceMaximized[0], 1_300) && withinScrollTolerance(sameResourceMaximized[1], 700) && withinScrollTolerance(await markdownScroller(notePaneA).evaluate(element => element.scrollTop), 1_300) && withinScrollTolerance(await markdownScroller(notePaneB).evaluate(element => element.scrollTop), 700), JSON.stringify(sameResourceMaximized));
       await page.getByRole("button", { name: "Swap dual viewers" }).click();
       await page.waitForFunction(() => Math.abs((document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop ?? 0) - 700) <= 2, undefined, { timeout: UI_TIMEOUT_MS });
       await viewerA.selectOption(alphaId);
      await page.getByTestId("dual-pane-a").getByRole("heading", { name: "Alpha" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await viewerA.selectOption(longNoteId);
      await notePaneA.getByTestId("markdown-body").getByRole("heading", { name: "Section 80" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.waitForFunction(() => document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop === 700, undefined, { timeout: UI_TIMEOUT_MS });
      check("Markdown X → Y → X restores real scrollTop for viewer A", await markdownScroller(notePaneA).evaluate((element) => element.scrollTop === 700));
      await markdownScroller(notePaneB).evaluate((element) => { element.scrollTop = 1_300; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
      await page.waitForTimeout(100);
      await page.getByRole("button", { name: "Swap dual viewers" }).click();
      await page.waitForTimeout(100);
      const swappedScrolls = await Promise.all([markdownScroller(notePaneA).evaluate((element) => element.scrollTop), markdownScroller(notePaneB).evaluate((element) => element.scrollTop)]);
      check("Markdown Swap restores independent real scrollTop values with viewer lineage", withinScrollTolerance(swappedScrolls[0], 1_300) && withinScrollTolerance(swappedScrolls[1], 700), JSON.stringify(swappedScrolls));
      await page.getByRole("button", { name: "Swap dual viewers" }).click();
      await page.waitForFunction(() => Math.abs((document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop ?? 0) - 700) <= 2 && Math.abs((document.querySelector('[data-testid="dual-pane-b"] .note-preview')?.scrollTop ?? 0) - 1_300) <= 2, undefined, { timeout: UI_TIMEOUT_MS });
      await page.getByRole("button", { name: "Swap dual viewers" }).click();
      await page.waitForFunction(() => Math.abs((document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop ?? 0) - 1_300) <= 2 && Math.abs((document.querySelector('[data-testid="dual-pane-b"] .note-preview')?.scrollTop ?? 0) - 700) <= 2, undefined, { timeout: UI_TIMEOUT_MS });
      check("Markdown two consecutive Swaps preserve both actual scroller offsets", withinScrollTolerance(await markdownScroller(notePaneA).evaluate((element) => element.scrollTop), 1_300) && withinScrollTolerance(await markdownScroller(notePaneB).evaluate((element) => element.scrollTop), 700));
      await page.getByRole("button", { name: "Swap dual viewers" }).click();
      await page.waitForFunction(() => Math.abs((document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop ?? 0) - 700) <= 2 && Math.abs((document.querySelector('[data-testid="dual-pane-b"] .note-preview')?.scrollTop ?? 0) - 1_300) <= 2, undefined, { timeout: UI_TIMEOUT_MS });

      await viewerA.selectOption(alternateLongNoteId);
      await notePaneA.getByTestId("markdown-body").getByRole("heading", { name: "Alternate reading", level: 1 }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await markdownScroller(notePaneA).evaluate((element) => { element.scrollTop = 600; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
      await page.waitForTimeout(100);
      await page.getByRole("button", { name: "Swap dual viewers" }).click();
      await page.waitForFunction(() => Math.abs((document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop ?? 0) - 1_300) <= 2 && Math.abs((document.querySelector('[data-testid="dual-pane-b"] .note-preview')?.scrollTop ?? 0) - 600) <= 2, undefined, { timeout: UI_TIMEOUT_MS });
      check("Markdown Swap across different resource identities restores each resource's real scroller", withinScrollTolerance(await markdownScroller(notePaneA).evaluate((element) => element.scrollTop), 1_300) && withinScrollTolerance(await markdownScroller(notePaneB).evaluate((element) => element.scrollTop), 600));
      await page.getByRole("button", { name: "Swap dual viewers" }).click();

      await viewerA.selectOption(longNoteId);
      await notePaneA.getByTestId("markdown-body").getByRole("heading", { name: "Long reading", level: 1 }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.waitForFunction(() => Math.abs((document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop ?? 0) - 700) <= 2 && Math.abs((document.querySelector('[data-testid="dual-pane-b"] .note-preview')?.scrollTop ?? 0) - 1_300) <= 2, undefined, { timeout: UI_TIMEOUT_MS });
      await page.getByRole("button", { name: "Switch to Analysis" }).click();
      await page.getByTestId("comparison-view").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByRole("button", { name: "Switch to Dual View" }).click();
      await notePaneA.locator(".note-preview").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.waitForFunction(() => Math.abs((document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop ?? 0) - 700) <= 2 && Math.abs((document.querySelector('[data-testid="dual-pane-b"] .note-preview')?.scrollTop ?? 0) - 1_300) <= 2, undefined, { timeout: UI_TIMEOUT_MS });
      const afterAnalysisScrolls = await Promise.all([markdownScroller(notePaneA).evaluate((element) => element.scrollTop), markdownScroller(notePaneB).evaluate((element) => element.scrollTop)]);
      check("Markdown offsets survive Dual → Analysis → Dual in the real scrollers", withinScrollTolerance(afterAnalysisScrolls[0], 700) && withinScrollTolerance(afterAnalysisScrolls[1], 1_300), JSON.stringify(afterAnalysisScrolls));
      const markdownBeforeResize = await markdownScroller(notePaneA).evaluate((element) => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight }));
      await page.setViewportSize({ width: 1180, height: 1100 });
      await page.waitForTimeout(100);
      const markdownAfterResize = await markdownScroller(notePaneA).evaluate((element) => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight }));
      check("Markdown resize restores normalized reading progress on the real scroller", markdownAfterResize.max > 0 && Math.abs(markdownAfterResize.top / markdownAfterResize.max - markdownBeforeResize.top / markdownBeforeResize.max) < 0.015, JSON.stringify({ markdownBeforeResize, markdownAfterResize }));
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.getByRole("button", { name: "Focus" }).click();
      const focusScrolls = await Promise.all([markdownScroller(notePaneA).evaluate((element) => element.scrollTop), markdownScroller(notePaneB).evaluate((element) => element.scrollTop)]);
      check("Markdown scroll positions remain attached to the real scrollers in Focus", withinScrollTolerance(focusScrolls[0], markdownAfterResize.top) && withinScrollTolerance(focusScrolls[1], 1_300), JSON.stringify({ markdownAfterResize, focusScrolls }));
      await page.getByRole("button", { name: "Fullscreen" }).click();
      await page.waitForFunction(() => document.fullscreenElement === document.querySelector("[data-testid='dual-view']"), undefined, { timeout: UI_TIMEOUT_MS });
      const fullscreenScrolls = await Promise.all([markdownScroller(notePaneA).evaluate((element) => element.scrollTop), markdownScroller(notePaneB).evaluate((element) => element.scrollTop)]);
      check("Markdown scroll positions remain attached to the real scrollers in Fullscreen", withinScrollTolerance(fullscreenScrolls[0], markdownAfterResize.top) && withinScrollTolerance(fullscreenScrolls[1], 1_300), JSON.stringify({ markdownAfterResize, fullscreenScrolls }));
      await page.getByRole("button", { name: "Exit fullscreen" }).click();
      await page.waitForFunction(() => document.fullscreenElement === null, undefined, { timeout: UI_TIMEOUT_MS });
      await page.getByRole("button", { name: "Focus" }).click();
      await viewerA.selectOption(alphaId);
      await viewerB.selectOption(betaId);

      const panes = [page.getByTestId("dual-pane-a"), page.getByTestId("dual-pane-b")];
      for (const pane of panes) await pane.locator('[data-testid="preview-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const paneState = () => page.evaluate(() => ["a", "b"].map((side) => {
        const pane = document.querySelector(`[data-testid="dual-pane-${side}"]`);
        return {
          title: pane?.querySelector("h2")?.textContent ?? "",
          svgText: pane?.querySelector('[data-testid="preview-svg"]')?.textContent ?? "",
          nodes: pane?.querySelectorAll("[data-node-id]").length ?? 0,
          zoom: pane?.querySelector('[data-testid="zoom-level"]')?.textContent ?? "",
          transform: pane?.querySelector('[data-testid="preview-svg"]')?.getAttribute("style") ?? "",
          activeNode: pane?.querySelector(".svg-node--active")?.getAttribute("data-node-id") ?? null,
        };
      }));
      const cameraTransform = (pane) => pane.transform.match(/transform:\s*([^;]+)/)?.[1] ?? pane.transform;
      const initial = await paneState();
      check(
        "Dual View renders two distinct Sequence SVGs with nodes",
        initial[0].title === "Alpha" && initial[1].title === "Beta" && initial.every((pane) => pane.nodes > 0 && pane.svgText.length > 0),
        initial.map(({ title, nodes, zoom }) => `${title}: ${nodes} nodes at ${zoom}`).join("; "),
      );
      const firstSequenceMessage = panes[0].locator('[data-message-node-id]').first();
      const firstMessageId = await firstSequenceMessage.getAttribute("data-message-node-id");
      const firstMessageTargets = [
        firstSequenceMessage.locator("[data-sequence-number] circle"),
        firstSequenceMessage.locator('line[data-node-id]'),
        firstSequenceMessage.locator("polygon").first(),
        firstSequenceMessage.locator(":scope > text").first(),
      ];
      let sequenceSelectionTargetsWork = true;
      for (const target of firstMessageTargets) {
        await target.click({ force: true });
        try {
          await page.waitForFunction((id) => document.querySelector(`[data-testid="dual-pane-a"] .svg-node--active[data-node-id="${CSS.escape(id)}"]`), firstMessageId, { timeout: UI_TIMEOUT_MS });
        } catch {
          throw new Error(`Message target click did not select ${firstMessageId}; target=${await target.evaluate((element) => element.outerHTML)}, active=${await panes[0].locator(".svg-node--active").evaluateAll((elements) => elements.map((element) => element.outerHTML))}`);
        }
        sequenceSelectionTargetsWork &&= await panes[0].locator('.svg-node--active[data-node-id]').getAttribute("data-node-id") === firstMessageId;
      }
      const selfLoop = panes[0].locator('[data-message-label="Retry locally"]');
      const selfLoopId = await selfLoop.getAttribute("data-message-node-id");
      const selfLoopTargets = [selfLoop.locator("[data-sequence-number] circle"), selfLoop.locator("path[data-node-id]")];
      for (let index = 0; index < selfLoopTargets.length; index += 1) {
        const target = selfLoopTargets[index];
        await target.click(index === 1 ? { force: true, position: { x: 20, y: 1 } } : { force: true });
        try {
          await page.waitForFunction((id) => document.querySelector(`[data-testid="dual-pane-a"] .svg-node--active[data-node-id="${CSS.escape(id)}"]`), selfLoopId, { timeout: UI_TIMEOUT_MS });
        } catch {
          throw new Error(`Self-loop target click did not select ${selfLoopId}; target=${await target.evaluate((element) => element.outerHTML)}, active=${await panes[0].locator(".svg-node--active").evaluateAll((elements) => elements.map((element) => element.outerHTML))}`);
        }
      }
      await page.waitForFunction(() => document.querySelector('[data-testid="dual-pane-a"] [data-testid="message-endpoints-hint"]')?.textContent?.includes("Retry locally · From Browser → To Browser"), undefined, { timeout: UI_TIMEOUT_MS });
      const sequenceCameraAfterSelections = await paneState();
      check("Number, line, arrow, label and self-loop segments select their common message without moving either camera", sequenceSelectionTargetsWork && sequenceCameraAfterSelections.every((pane, index) => pane.transform === initial[index].transform));
      const sequenceContext = panes[0].getByTestId("message-endpoints-hint");
      const sequenceContextState = await sequenceContext.evaluate((element) => {
        const hint = element.getBoundingClientRect();
        const viewport = element.closest(".viewport").getBoundingClientRect();
        return { text: element.textContent, fits: hint.left >= viewport.left && hint.top >= viewport.top && hint.right <= viewport.right && hint.bottom <= viewport.bottom && element.scrollHeight <= element.clientHeight };
      });
      check("Selected message context includes its label and endpoints without clipping", sequenceContextState.text.includes("Retry locally") && sequenceContextState.text.includes("From Browser → To Browser") && sequenceContextState.fits, JSON.stringify(sequenceContextState));
      const activeBeforePan = await panes[0].locator('.svg-node--active[data-node-id]').getAttribute("data-node-id");
      const panTargetBox = await firstSequenceMessage.boundingBox();
      if (!panTargetBox) throw new Error("Could not measure the message target for pan regression.");
      const panStart = { x: panTargetBox.x + panTargetBox.width / 2, y: panTargetBox.y + panTargetBox.height / 2 };
      await page.mouse.move(panStart.x, panStart.y);
      await page.mouse.down();
      await page.mouse.move(panStart.x + 28, panStart.y + 18, { steps: 3 });
      await page.mouse.up();
      const panCamera = await paneState();
      check("Dragging from a message pans without selecting it", panCamera[0].transform !== initial[0].transform && await panes[0].locator('.svg-node--active[data-node-id]').getAttribute("data-node-id") === activeBeforePan);
      await page.mouse.move(panStart.x + 28, panStart.y + 18);
      await page.mouse.down();
      await page.mouse.move(panStart.x, panStart.y, { steps: 3 });
      await page.mouse.up();
      const participantLifeline = panes[0].locator('g[data-participant-id="Browser"] line[stroke-dasharray]').first();
      const participantGroup = panes[0].locator('g[data-participant-id="Browser"]');
      const participantId = await panes[0].locator('g[data-participant-id="Browser"] [data-node-id]').getAttribute("data-node-id");
      await participantLifeline.click({ force: true });
      await page.waitForFunction((id) => document.querySelector(`[data-testid="dual-pane-a"] .svg-node--active[data-node-id="${CSS.escape(id)}"]`), participantId, { timeout: UI_TIMEOUT_MS });
      let participantCameraStable = true;
      for (let zoom = 0; zoom < 3; zoom += 1) {
        await panes[0].getByTestId("zoom-in").click();
        const beforeParticipantTap = await paneState();
        await participantLifeline.click({ force: true });
        const afterParticipantTap = await paneState();
        participantCameraStable &&= beforeParticipantTap.every((pane, index) => pane.transform === afterParticipantTap[index].transform);
      }
      for (let zoom = 0; zoom < 3; zoom += 1) await panes[0].getByTestId("zoom-out").click();
      check("Participant lifeline selection is stable at multiple zoom levels and does not change either camera", participantCameraStable);
      const selectionCue = await participantGroup.evaluate((group) => ({
        outline: getComputedStyle(group).outlineStyle,
        lineStroke: getComputedStyle(group.querySelector('line[stroke-dasharray]')).stroke,
        lineFilter: getComputedStyle(group).filter,
      }));
      check("Participant selection uses a local lifeline cue without a group outline or halo", selectionCue.outline === "none" && selectionCue.lineFilter === "none" && selectionCue.lineStroke !== "rgb(0, 0, 0)", JSON.stringify(selectionCue));

      // Capture the selected lifeline at representative zooms. The indicator
      // should remain local to the line rather than becoming a halo around the
      // full participant group as the camera magnifies it.
      const evidenceDir = join(tmpdir(), "ux-seq-3-evidence");
      await mkdir(evidenceDir, { recursive: true });
      const paneA = page.getByTestId("dual-pane-a").getByTestId("viewport-pane");
      const paneBounds = await paneA.boundingBox();
      if (!paneBounds) throw new Error("Dual View A has no visible canvas for pinch verification.");
      const paneCenter = { x: paneBounds.x + paneBounds.width / 2, y: paneBounds.y + paneBounds.height / 2 };
      await page.getByTestId("dual-pane-a").getByTestId("zoom-reset").click();
      await paneA.screenshot({ path: join(evidenceDir, "lifeline-100.png") });
      for (const [zoom, deltaY] of [[200, -277.2588722239781], [400, -277.2588722239781]]) {
        await page.mouse.move(paneCenter.x, paneCenter.y);
        await page.mouse.wheel(0, deltaY);
        const actual = await page.getByTestId("dual-pane-a").getByTestId("zoom-level").textContent();
        check(`Selected participant remains readable at ${zoom}%`, Math.abs(Number.parseInt(actual, 10) - zoom) <= 1, actual);
        await paneA.screenshot({ path: join(evidenceDir, `lifeline-${zoom}.png`) });
      }
      await page.getByTestId("dual-pane-a").getByTestId("zoom-reset").click();

      // CDP touch input generates the browser's real touch Pointer Events in a
      // hasTouch context; unlike a JS-dispatched PointerEvent this exercises
      // Chromium's touch-to-pointer path and CSS touch-action handling.
      const touch = await context.newCDPSession(page);
      const beforePinch = await paneA.locator(".viewport__content").evaluate((element) => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform);
        return { scale: matrix.a, x: matrix.e, y: matrix.f };
      });
      const paneBBeforePinch = (await paneState())[1].transform;
      const start = [
        { x: paneCenter.x - 50, y: paneCenter.y, id: 101 },
        { x: paneCenter.x + 50, y: paneCenter.y, id: 102 },
      ];
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: start });
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: paneCenter.x - 70, y: paneCenter.y + 20, id: 101 },
          { x: paneCenter.x + 130, y: paneCenter.y + 20, id: 102 },
        ],
      });
      const pinchCamera = await paneA.locator(".viewport__content").evaluate((element) => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform);
        return { scale: matrix.a, x: matrix.e, y: matrix.f };
      });
      const localBounds = await paneA.boundingBox();
      const movedMidpoint = { x: paneCenter.x + 30, y: paneCenter.y + 20 };
      const anchoredPoint = {
        x: ((paneCenter.x - localBounds.x) - beforePinch.x) / beforePinch.scale,
        y: ((paneCenter.y - localBounds.y) - beforePinch.y) / beforePinch.scale,
      };
      const anchoredX = anchoredPoint.x * pinchCamera.scale + pinchCamera.x;
      const anchoredY = anchoredPoint.y * pinchCamera.scale + pinchCamera.y;
      check("Two-finger Chromium pinch magnifies the active camera", Math.abs(pinchCamera.scale - 2) < 0.02, `scale=${pinchCamera.scale.toFixed(3)}`);
      check("Pinch zoom follows the translated midpoint without a jump", Math.abs(anchoredX - (movedMidpoint.x - localBounds.x)) < 2 && Math.abs(anchoredY - (movedMidpoint.y - localBounds.y)) < 2, JSON.stringify(pinchCamera));
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
          { x: paneCenter.x - 100, y: paneCenter.y, id: 103 },
          { x: paneCenter.x + 100, y: paneCenter.y, id: 104 },
        ],
      });
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: paneCenter.x - 50, y: paneCenter.y, id: 103 },
          { x: paneCenter.x + 50, y: paneCenter.y, id: 104 },
        ],
      });
      await page.waitForFunction(() => {
        const content = document.querySelector('[data-testid="dual-pane-a"] .viewport__content');
        if (!content) return false;
        return new DOMMatrix(getComputedStyle(content).transform).a < 1.02;
      }, undefined, { timeout: UI_TIMEOUT_MS });
      const reducedCamera = await paneA.locator(".viewport__content").evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
      check("Two-finger Chromium pinch reduces zoom", Math.abs(reducedCamera - 1) < 0.02, `scale=${reducedCamera.toFixed(3)}`);
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

      await touch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
          { x: paneCenter.x - 50, y: paneCenter.y, id: 105 },
          { x: paneCenter.x + 50, y: paneCenter.y, id: 106 },
        ],
      });
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: paneCenter.x - 500, y: paneCenter.y, id: 105 },
          { x: paneCenter.x + 500, y: paneCenter.y, id: 106 },
        ],
      });
      await page.waitForFunction(() => {
        const content = document.querySelector('[data-testid="dual-pane-a"] .viewport__content');
        return Boolean(content && new DOMMatrix(getComputedStyle(content).transform).a >= 7.99);
      }, undefined, { timeout: UI_TIMEOUT_MS });
      const maxTouchScale = await paneA.locator(".viewport__content").evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
      check("Chromium pinch respects the 800% maximum", Math.abs(maxTouchScale - 8) < 0.02, `scale=${maxTouchScale.toFixed(3)}`);
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: paneCenter.x, y: paneCenter.y, id: 105 },
          { x: paneCenter.x + 1, y: paneCenter.y, id: 106 },
        ],
      });
      await page.waitForFunction(() => {
        const content = document.querySelector('[data-testid="dual-pane-a"] .viewport__content');
        return Boolean(content && new DOMMatrix(getComputedStyle(content).transform).a <= 0.101);
      }, undefined, { timeout: UI_TIMEOUT_MS });
      const minTouchScale = await paneA.locator(".viewport__content").evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
      check("Chromium pinch respects the 10% minimum", Math.abs(minTouchScale - 0.1) < 0.002, `scale=${minTouchScale.toFixed(3)}`);
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

      const beforeOneFingerPan = await paneA.locator(".viewport__content").evaluate((element) => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform);
        return { x: matrix.e, y: matrix.f };
      });
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: paneCenter.x, y: paneCenter.y, id: 107 }] });
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: paneCenter.x + 24, y: paneCenter.y + 18, id: 107 }] });
      await page.waitForFunction((origin) => {
        const content = document.querySelector('[data-testid="dual-pane-a"] .viewport__content');
        if (!content) return false;
        const matrix = new DOMMatrix(getComputedStyle(content).transform);
        return matrix.a <= 0.101 && (matrix.e !== origin.x || matrix.f !== origin.y);
      }, beforeOneFingerPan, { timeout: UI_TIMEOUT_MS });
      const afterOneFingerPan = await paneA.locator(".viewport__content").evaluate((element) => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform);
        return { scale: matrix.a, x: matrix.e, y: matrix.f };
      });
      check("Chromium one-finger touch pans at the minimum zoom without zooming", afterOneFingerPan.scale <= 0.101 && (afterOneFingerPan.x !== beforeOneFingerPan.x || afterOneFingerPan.y !== beforeOneFingerPan.y), JSON.stringify({ beforeOneFingerPan, afterOneFingerPan }));
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await touch.detach();
      await page.getByTestId("dual-pane-a").getByTestId("zoom-reset").click();
      check("Pinch completion does not deselect the participant", await paneA.locator('.svg-node--active[data-node-id]').getAttribute("data-node-id") === participantId);
      check("Dual View B camera remains independent during A pinch", (await paneState())[1].transform === paneBBeforePinch);

      const sequenceCameraBeforeMaximize = await paneState();
      await page.getByRole("button", { name: "Maximize Viewer A" }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="dual-view"]')?.getAttribute("data-maximized-pane") === "a", undefined, { timeout: UI_TIMEOUT_MS });
      const cameraWhileMaximized = await paneState();
      check("Maximizing A keeps both mounted Sequence cameras unchanged", cameraWhileMaximized.every((pane, index) => cameraTransform(pane) === cameraTransform(sequenceCameraBeforeMaximize[index])) && await page.getByTestId("dual-pane-b").count() === 1, JSON.stringify(cameraWhileMaximized.map((pane, index) => ({ before: cameraTransform(sequenceCameraBeforeMaximize[index]), after: cameraTransform(pane) }))));
      await page.getByRole("button", { name: "Restore Viewer A" }).click();
       await panes[1].locator('[data-testid="preview-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       const cameraAfterRestore = await paneState();
       check("Restoring A keeps both Sequence camera transforms without implicit Fit", cameraAfterRestore.every((pane, index) => cameraTransform(pane) === cameraTransform(sequenceCameraBeforeMaximize[index])), JSON.stringify(cameraAfterRestore.map((pane, index) => ({ before: cameraTransform(sequenceCameraBeforeMaximize[index]), after: cameraTransform(pane) }))));
       const sequenceCameraBeforeMaximizeB = await paneState();
       await page.getByRole("button", { name: "Maximize Viewer B" }).click();
       const sequenceBMaximized = await paneState();
       await page.getByRole("button", { name: "Restore Viewer B" }).click();
       await page.waitForFunction(() => document.querySelector('[data-testid="dual-view"]')?.getAttribute("data-maximized-pane") === "normal", undefined, { timeout: UI_TIMEOUT_MS });
       const sequenceBAfterRestore = await paneState();
       check("Maximizing/restoring B leaves both Sequence SVG camera transforms unchanged", sequenceBMaximized.every((pane, index) => cameraTransform(pane) === cameraTransform(sequenceCameraBeforeMaximizeB[index])) && sequenceBAfterRestore.every((pane, index) => cameraTransform(pane) === cameraTransform(sequenceCameraBeforeMaximizeB[index])), JSON.stringify(sequenceBAfterRestore.map((pane, index) => ({ before: cameraTransform(sequenceCameraBeforeMaximizeB[index]), after: cameraTransform(pane) }))));
       await page.getByRole("button", { name: "Swap dual viewers" }).click();
       const swappedSequenceInitial = await paneState();
       await page.getByRole("button", { name: "Maximize Viewer A" }).click();
       await page.getByRole("button", { name: "Restore Viewer A" }).click();
       await page.waitForFunction(() => document.querySelector('[data-testid="dual-view"]')?.getAttribute("data-maximized-pane") === "normal", undefined, { timeout: UI_TIMEOUT_MS });
       const swappedSequenceRestored = await paneState();
       check("Sequence maximize/restore after Swap preserves the slot's current camera state", swappedSequenceRestored.every((pane, index) => pane.transform === swappedSequenceInitial[index].transform));
       await panes[0].getByTestId("zoom-in").click();
       const zoomAfterMaximize = await paneState();
       check("Sequence zoom controls remain operational after maximizing and restoring", zoomAfterMaximize[0].zoom !== swappedSequenceRestored[0].zoom && zoomAfterMaximize[1].zoom === swappedSequenceRestored[1].zoom);
       await panes[0].getByTestId("zoom-out").click();
       const zoomReturnedToBaseline = await paneState();
       check("Sequence zoom validation restores the fixture camera baseline", zoomReturnedToBaseline[0].zoom === swappedSequenceRestored[0].zoom);
       await page.getByRole("button", { name: "Swap dual viewers" }).click();

       await viewerA.selectOption(eventFlowId);
      await viewerB.selectOption(eventFlowId);
       const eventPaneA = page.getByTestId("dual-pane-a");
       const eventPaneB = page.getByTestId("dual-pane-b");
       const projection = (pane, label) => pane.getByRole("button", { name: label, exact: true });
       const maximizeRestoreEventProjection = async label => {
         const activeBefore = await projection(eventPaneA, label).getAttribute("aria-pressed");
         const projectedContentBefore = await eventPaneA.locator(`[data-testid="event-flow-preview"]`).innerText();
         await page.getByRole("button", { name: "Maximize Viewer A" }).click();
         await page.waitForFunction(() => document.querySelector('[data-testid="dual-view"]')?.getAttribute("data-maximized-pane") === "a", undefined, { timeout: UI_TIMEOUT_MS });
         let causalBounds = null;
         if (label === "Causal") {
           causalBounds = await eventPaneA.locator(".react-flow").evaluate(element => { const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height, transform: element.querySelector(".react-flow__viewport")?.getAttribute("style") ?? "" }; });
         }
         await page.getByRole("button", { name: "Restore Viewer A" }).click();
         await page.waitForFunction(() => document.querySelector('[data-testid="dual-view"]')?.getAttribute("data-maximized-pane") === "normal", undefined, { timeout: UI_TIMEOUT_MS });
         if (label === "Causal") {
           await page.waitForFunction(() => { const flow = document.querySelector('[data-testid="dual-pane-a"] .react-flow'); return Boolean(flow && flow.getBoundingClientRect().width > 0 && flow.getBoundingClientRect().height > 0 && flow.querySelector(".react-flow__viewport")); }, undefined, { timeout: UI_TIMEOUT_MS });
         }
         const activeAfter = await projection(eventPaneA, label).getAttribute("aria-pressed");
         const projectedContentAfter = await eventPaneA.locator(`[data-testid="event-flow-preview"]`).innerText();
         let causalRestored = true;
         if (label === "Causal") {
           const bounds = await eventPaneA.locator(".react-flow").evaluate(element => { const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height, transform: element.querySelector(".react-flow__viewport")?.getAttribute("style") ?? "" }; });
           causalRestored = bounds.width > 0 && bounds.height > 0 && bounds.transform === causalBounds?.transform;
         }
         check(`Maximize/restore preserves Event Flow ${label} projection and rendered content`, activeBefore === "true" && activeAfter === "true" && projectedContentBefore === projectedContentAfter && causalRestored, label === "Causal" ? JSON.stringify(causalBounds) : undefined);
       };
       await eventPaneA.locator('[data-testid="preview-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       check("Event Flow projection defaults to Flow in both duplicate-resource panes", await projection(eventPaneA, "Flow").getAttribute("aria-pressed") === "true" && await projection(eventPaneB, "Flow").getAttribute("aria-pressed") === "true");
       await maximizeRestoreEventProjection("Flow");
       await projection(eventPaneA, "Topology").click();
       await eventPaneA.locator('[data-testid="event-topology"] [data-testid="topology-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await maximizeRestoreEventProjection("Topology");
      const topologyTransform = await eventPaneA.locator('[data-testid="topology-svg"]').getAttribute("style");
      check("Event Flow Topology selection renders its own SVG and active selector", await projection(eventPaneA, "Topology").getAttribute("aria-pressed") === "true" && await eventPaneA.getByRole("img", { name: "Event topology" }).isVisible());
      await eventPaneA.getByTestId("zoom-in").click();
      const zoomedTopologyTransform = await eventPaneA.locator('[data-testid="topology-svg"]').getAttribute("style");
       await projection(eventPaneA, "Causal").click();
       await eventPaneA.getByTestId("event-causal").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       check("Topology → Causal changes projection and unmounts the topology SVG", await projection(eventPaneA, "Causal").getAttribute("aria-pressed") === "true" && await eventPaneA.locator('[data-testid="topology-svg"]').count() === 0);
       await eventPaneA.locator(".react-flow").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await maximizeRestoreEventProjection("Causal");
       await projection(eventPaneA, "Catalog").click();
       await eventPaneA.getByTestId("event-catalog").getByText("OrderCreated").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       check("Causal → Catalog shows catalog content rather than causal graph", await projection(eventPaneA, "Catalog").getAttribute("aria-pressed") === "true" && await eventPaneA.locator('[data-testid="event-causal"]').count() === 0);
       await maximizeRestoreEventProjection("Catalog");
      await projection(eventPaneA, "Flow").click();
      await eventPaneA.locator('[data-testid="preview-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const flowTransformAfterCatalog = await eventPaneA.locator('[data-testid="preview-svg"]').getAttribute("style");
      check("Catalog → Flow fits Flow geometry instead of applying the Topology camera", flowTransformAfterCatalog !== zoomedTopologyTransform && flowTransformAfterCatalog !== topologyTransform,
        `topology=${zoomedTopologyTransform}; flow=${flowTransformAfterCatalog}`);
      await projection(eventPaneB, "Topology").click();
      await eventPaneB.locator('[data-testid="topology-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("A and B keep independent Event Flow projections for the same resource", await projection(eventPaneA, "Flow").getAttribute("aria-pressed") === "true" && await projection(eventPaneB, "Topology").getAttribute("aria-pressed") === "true");
      await page.getByRole("button", { name: "Swap dual viewers" }).click();
      check("Swap moves each duplicate resource projection with its viewer lineage", await projection(page.getByTestId("dual-pane-a"), "Topology").getAttribute("aria-pressed") === "true" && await projection(page.getByTestId("dual-pane-b"), "Flow").getAttribute("aria-pressed") === "true");
      await page.getByRole("button", { name: "Swap dual viewers" }).click();
      await projection(page.getByTestId("dual-pane-a"), "Catalog").click();
      await page.getByTestId("dual-pane-a").getByTestId("event-catalog").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await viewerA.selectOption(alphaId);
      await page.getByTestId("dual-pane-a").getByRole("heading", { name: "Alpha" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await viewerA.selectOption(eventFlowId);
      await page.getByTestId("dual-pane-a").getByTestId("event-catalog").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("Event Flow projection persists across resource X → Y → X in the same viewer lineage", await projection(page.getByTestId("dual-pane-a"), "Catalog").getAttribute("aria-pressed") === "true");
      await viewerA.selectOption(alphaId);
      await viewerB.selectOption(betaId);
      await page.getByTestId("dual-pane-a").getByRole("heading", { name: "Alpha" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByTestId("dual-pane-b").getByRole("heading", { name: "Beta" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });

      await panes[0].getByTestId("viewport-pane").focus();
      await page.keyboard.press("ArrowRight");
      const pannedA = await paneState();
      check("Panning A changes its actual SVG transform without changing B", pannedA[0].transform !== initial[0].transform && pannedA[1].transform === initial[1].transform,
        `A ${initial[0].transform} → ${pannedA[0].transform}; B unchanged ${pannedA[1].transform}`);
      await panes[0].getByTestId("zoom-in").click();
      const zoomedA = await paneState();
      check(
        "Zooming A leaves B camera and SVG transform unchanged",
        zoomedA[0].zoom !== pannedA[0].zoom && zoomedA[0].transform !== pannedA[0].transform && zoomedA[1].zoom === pannedA[1].zoom && zoomedA[1].transform === pannedA[1].transform,
        `A ${pannedA[0].zoom} ${pannedA[0].transform} → ${zoomedA[0].zoom} ${zoomedA[0].transform}; B unchanged ${zoomedA[1].transform}`,
      );
      await panes[0].locator("g.participant[data-node-id]").first().click();
      await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="dual-pane-a"] .svg-node--active')), undefined, { timeout: UI_TIMEOUT_MS });
      const selectedA = await paneState();
      check(
        "Selecting a node in A leaves B unselected with its camera intact",
        Boolean(selectedA[0].activeNode) && selectedA[1].activeNode === null && selectedA[1].transform === zoomedA[1].transform,
        `A node ${selectedA[0].activeNode}; B node ${selectedA[1].activeNode}`,
      );

      await panes[1].getByTestId("zoom-in").click();
      await panes[1].getByTestId("zoom-in").click();
      await panes[1].locator("g.participant[data-node-id]").last().locator("rect[data-node-id]").click();
      await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="dual-pane-b"] .svg-node--active')), undefined, { timeout: UI_TIMEOUT_MS });
      const beforeSwap = await paneState();
      check(
        "Pre-swap states are distinct in camera and selected node",
        beforeSwap[0].zoom !== beforeSwap[1].zoom && beforeSwap[0].activeNode !== beforeSwap[1].activeNode,
        beforeSwap.map(({ title, zoom, activeNode }) => `${title}: ${zoom}, ${activeNode}`).join("; "),
      );
      await page.getByRole("button", { name: "Swap dual viewers" }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="dual-pane-a"] h2')?.textContent === "Beta", undefined, { timeout: UI_TIMEOUT_MS });
      const afterSwap = await paneState();
      check(
        "Swap preserves each artifact's actual rendered camera transform",
        afterSwap[0].title === beforeSwap[1].title && afterSwap[0].zoom === beforeSwap[1].zoom && afterSwap[0].transform === beforeSwap[1].transform &&
          afterSwap[1].title === beforeSwap[0].title && afterSwap[1].zoom === beforeSwap[0].zoom && afterSwap[1].transform === beforeSwap[0].transform,
        afterSwap.map(({ title, zoom, transform }) => `${title}: ${zoom}, ${transform}`).join("; "),
      );
      check(
        "Swap preserves each artifact's active SVG node",
        afterSwap[0].activeNode === beforeSwap[1].activeNode && afterSwap[1].activeNode === beforeSwap[0].activeNode,
        `${beforeSwap[0].activeNode}, ${beforeSwap[1].activeNode} → ${afterSwap[0].activeNode}, ${afterSwap[1].activeNode}`,
      );

      const noteForSessionRoundTrip = async (selector, resourceId, pane, before) => {
        await selector.selectOption(noteId);
        await page.getByTestId(`dual-pane-${pane}`).getByTestId("markdown-body").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await selector.selectOption(resourceId);
        await page.getByTestId(`dual-pane-${pane}`).locator('[data-testid="preview-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        const restored = await paneState();
        check(`Viewer ${pane.toUpperCase()} restores its SVG transform and selected node after X → Y → X`,
          restored[pane === "a" ? 0 : 1].transform === before.transform && restored[pane === "a" ? 0 : 1].activeNode === before.activeNode,
          `transform ${before.transform} → ${restored[pane === "a" ? 0 : 1].transform}; node ${before.activeNode} → ${restored[pane === "a" ? 0 : 1].activeNode}`);
      };
      await noteForSessionRoundTrip(viewerA, betaId, "a", afterSwap[0]);
      await noteForSessionRoundTrip(viewerB, alphaId, "b", afterSwap[1]);

      await viewerA.selectOption(alphaId);
      await viewerB.selectOption(alphaId);
      await panes[0].locator('[data-testid="preview-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await panes[1].locator('[data-testid="preview-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await panes[0].getByTestId("zoom-in").click();
      await panes[0].locator("g.participant[data-node-id]").first().click();
      await panes[1].getByTestId("zoom-in").click();
      await panes[1].getByTestId("zoom-in").click();
      await panes[1].locator("g.participant[data-node-id]").last().locator("rect[data-node-id]").click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="dual-pane-a"] .svg-node--active').length === 1 && document.querySelectorAll('[data-testid="dual-pane-b"] .svg-node--active').length === 1, undefined, { timeout: UI_TIMEOUT_MS });
      const duplicateBeforeSwap = await paneState();
      check("The same artifact can occupy A and B with independent cameras and node selections",
        duplicateBeforeSwap[0].title === "Alpha" && duplicateBeforeSwap[1].title === "Alpha" &&
          duplicateBeforeSwap[0].transform !== duplicateBeforeSwap[1].transform && duplicateBeforeSwap[0].activeNode !== duplicateBeforeSwap[1].activeNode,
        duplicateBeforeSwap.map(({ title, transform, activeNode }) => `${title}: ${transform} / ${activeNode}`).join(" | "));
      await page.getByRole("button", { name: "Swap dual viewers" }).click();
      const duplicateAfterSwap = await paneState();
      check("Swapping duplicate artifacts swaps their independent visual session lineages",
        duplicateAfterSwap[0].transform === duplicateBeforeSwap[1].transform && duplicateAfterSwap[0].activeNode === duplicateBeforeSwap[1].activeNode &&
          duplicateAfterSwap[1].transform === duplicateBeforeSwap[0].transform && duplicateAfterSwap[1].activeNode === duplicateBeforeSwap[0].activeNode,
        duplicateAfterSwap.map(({ transform, activeNode }) => `${transform} / ${activeNode}`).join(" | "));

      await viewerA.selectOption(betaId);
      await viewerB.selectOption(alphaId);
      await panes[0].locator('[data-testid="preview-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await panes[1].locator('[data-testid="preview-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });

      await panes[0].getByTestId("zoom-in").click();
      await panes[0].locator("g.participant[data-node-id]").last().locator("rect[data-node-id]").click();
      await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="dual-pane-a"] .svg-node--active')), undefined, { timeout: UI_TIMEOUT_MS });
      const beforeFocus = await paneState();
      await page.getByRole("button", { name: "Focus" }).click();
      await page.locator(".app--dual-focus").waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
      const inFocus = await paneState();
      check("Focus preserves both actual SVG camera transforms and distinct selected nodes", inFocus.every((pane, index) => pane.transform === beforeFocus[index].transform && pane.activeNode === beforeFocus[index].activeNode) && inFocus[0].activeNode !== inFocus[1].activeNode,
        `before ${beforeFocus.map(({ transform, activeNode }) => `${transform} / ${activeNode}`).join(" | ")} → focus ${inFocus.map(({ transform, activeNode }) => `${transform} / ${activeNode}`).join(" | ")}`);
      await page.getByRole("button", { name: "Fullscreen" }).click();
      await page.waitForFunction(() => document.fullscreenElement === document.querySelector("[data-testid='dual-view']"), undefined, { timeout: UI_TIMEOUT_MS });
      const inFullscreen = await paneState();
      check("Fullscreen preserves both actual SVG camera transforms and node selections", inFullscreen.every((pane, index) => pane.transform === inFocus[index].transform && pane.activeNode === inFocus[index].activeNode),
        `focus ${inFocus.map(({ transform, activeNode }) => `${transform} / ${activeNode}`).join(" | ")} → fullscreen ${inFullscreen.map(({ transform, activeNode }) => `${transform} / ${activeNode}`).join(" | ")}`);
      await page.getByRole("button", { name: "Exit fullscreen" }).click();
      await page.waitForFunction(() => document.fullscreenElement === null, undefined, { timeout: UI_TIMEOUT_MS });
      const afterFullscreen = await paneState();
      check("Exiting Fullscreen retains Focus and both cameras/selections", await page.locator(".app--dual-focus").count() === 1 && afterFullscreen.every((pane, index) => pane.transform === inFullscreen[index].transform && pane.activeNode === inFullscreen[index].activeNode),
        `fullscreen ${inFullscreen.map(({ transform, activeNode }) => `${transform} / ${activeNode}`).join(" | ")} → exit ${afterFullscreen.map(({ transform, activeNode }) => `${transform} / ${activeNode}`).join(" | ")}`);
        const projectBeforeSwitch = await paneState();
        const p1LongNoteId = `my-work:${workId}:${createdResources.get("long-reading.md")}`;
        await page.getByRole("combobox", { name: "Dual View A resource" }).selectOption(p1LongNoteId);
        await page.getByRole("combobox", { name: "Dual View B resource" }).selectOption(p1LongNoteId);
        const p1MarkdownPaneA = page.getByTestId("dual-pane-a");
        const p1MarkdownPaneB = page.getByTestId("dual-pane-b");
        await p1MarkdownPaneA.getByTestId("markdown-body").getByRole("heading", { name: "Long reading", level: 1 }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await p1MarkdownPaneB.getByTestId("markdown-body").getByRole("heading", { name: "Long reading", level: 1 }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        // Let the panes' post-selection restoration RAFs settle before setting
        // the distinct P1 read positions used as the project-isolation input.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await Promise.all([
          p1MarkdownPaneA.locator(".note-preview").evaluate(element => { element.scrollTop = 450; element.dispatchEvent(new Event("scroll", { bubbles: true })); }),
          p1MarkdownPaneB.locator(".note-preview").evaluate(element => { element.scrollTop = 1_050; element.dispatchEvent(new Event("scroll", { bubbles: true })); }),
        ]);
        await page.waitForFunction(() => Math.abs((document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop ?? 0) - 450) <= 2 && Math.abs((document.querySelector('[data-testid="dual-pane-b"] .note-preview')?.scrollTop ?? 0) - 1_050) <= 2, undefined, { timeout: UI_TIMEOUT_MS });
        const p1ProjectScrolls = await Promise.all([p1MarkdownPaneA.locator(".note-preview").evaluate(element => element.scrollTop), p1MarkdownPaneB.locator(".note-preview").evaluate(element => element.scrollTop)]);
        check("P1 Markdown starts project isolation with distinct real A/B offsets", Math.abs(p1ProjectScrolls[0] - 450) <= 2 && Math.abs(p1ProjectScrolls[1] - 1_050) <= 2, JSON.stringify(p1ProjectScrolls));
        const projectSelector = page.getByRole("combobox", { name: "Dual View project" });
        await page.getByRole("button", { name: "Maximize Viewer A" }).click();
        await projectSelector.selectOption(isolationProjectId);
        await page.waitForFunction((name) => document.querySelector(".comparison__toolbar strong")?.textContent?.includes(name), isolationProjectName, { timeout: UI_TIMEOUT_MS });
        check("Changing project while maximized resets the slot layout", await page.getByTestId("dual-view").getAttribute("data-maximized-pane") === "normal");
        const projectContextSelector = page.getByRole("combobox", { name: "Dual View context" });
        await projectContextSelector.selectOption(`my-work:${isolationWorkId}`);
        await page.waitForFunction((value) => document.querySelector('[aria-label="Dual View context"]')?.value === value, `my-work:${isolationWorkId}`, { timeout: UI_TIMEOUT_MS });
        const isolationOptionId = `my-work:${isolationWorkId}:${isolationResourceId}`;
        await page.getByRole("combobox", { name: "Dual View A resource" }).selectOption(isolationOptionId);
        await page.getByTestId("dual-pane-a").locator('[data-testid="conceptual-preview-svg"] [data-concept-id="isolated"]').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await page.getByTestId("dual-pane-a").getByTestId("zoom-in").click();
        await page.getByTestId("dual-pane-a").locator('[data-concept-id="isolated"]').click();
        const project2VisualState = await paneState();
        check("P1 → P2 project switch renders only P2's authorized fixture resources", project2VisualState[0].activeNode === "isolated");
        const p2MarkdownId = `my-work:${isolationWorkId}:${isolationMarkdownId}`;
        await page.getByRole("combobox", { name: "Dual View A resource" }).selectOption(p2MarkdownId);
        await page.getByRole("combobox", { name: "Dual View B resource" }).selectOption(p2MarkdownId);
        const p2MarkdownPaneA = page.getByTestId("dual-pane-a");
        const p2MarkdownPaneB = page.getByTestId("dual-pane-b");
        await p2MarkdownPaneA.getByTestId("markdown-body").getByRole("heading", { name: "P2 isolated reading", level: 1 }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await page.waitForFunction(() => (document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop ?? -1) === 0 && (document.querySelector('[data-testid="dual-pane-b"] .note-preview')?.scrollTop ?? -1) === 0, undefined, { timeout: UI_TIMEOUT_MS });
        check("P1 offsets do not transfer into P2 Markdown A/B real scrollers", await p2MarkdownPaneA.locator(".note-preview").evaluate(element => element.scrollTop) === 0 && await p2MarkdownPaneB.locator(".note-preview").evaluate(element => element.scrollTop) === 0);
        await page.evaluate(() => [...document.querySelectorAll(".note-preview")].forEach((element, index) => { element.scrollTop = index ? 760 : 280; element.dispatchEvent(new Event("scroll", { bubbles: true })); }));
        await page.waitForFunction(() => Math.abs((document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop ?? 0) - 280) <= 2 && Math.abs((document.querySelector('[data-testid="dual-pane-b"] .note-preview')?.scrollTop ?? 0) - 760) <= 2, undefined, { timeout: UI_TIMEOUT_MS });
        await projectSelector.selectOption(projectId);
        await page.waitForFunction((name) => document.querySelector(".comparison__toolbar strong")?.textContent?.includes(name), projectName, { timeout: UI_TIMEOUT_MS });
        await page.getByRole("combobox", { name: "Dual View context" }).selectOption(`my-work:${workId}`);
        await page.waitForFunction((value) => document.querySelector('[aria-label="Dual View context"]')?.value === value, `my-work:${workId}`, { timeout: UI_TIMEOUT_MS });
        await page.getByTestId("dual-pane-a").locator('[data-testid="preview-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        const project1Returned = await paneState();
        check("P2 → P1 does not resurrect P1's prior camera or node selection", project1Returned.every((pane, index) => pane.activeNode === null && pane.transform !== projectBeforeSwitch[index].transform),
          `before P2 ${projectBeforeSwitch.map(({ transform, activeNode }) => `${transform} / ${activeNode}`).join(" | ")} → returned P1 ${project1Returned.map(({ transform, activeNode }) => `${transform} / ${activeNode}`).join(" | ")}`);

        await page.getByRole("combobox", { name: "Dual View A resource" }).selectOption(p1LongNoteId);
        await page.getByRole("combobox", { name: "Dual View B resource" }).selectOption(p1LongNoteId);
        await page.getByTestId("dual-pane-a").getByTestId("markdown-body").getByRole("heading", { name: "Long reading", level: 1 }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await page.getByTestId("dual-pane-b").getByTestId("markdown-body").getByRole("heading", { name: "Long reading", level: 1 }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await page.waitForFunction(() => (document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop ?? -1) === 0 && (document.querySelector('[data-testid="dual-pane-b"] .note-preview')?.scrollTop ?? -1) === 0, undefined, { timeout: UI_TIMEOUT_MS });
        check("P2 → P1 returns with P1's prior Markdown offsets discarded", await page.getByTestId("dual-pane-a").locator(".note-preview").evaluate(element => element.scrollTop) === 0 && await page.getByTestId("dual-pane-b").locator(".note-preview").evaluate(element => element.scrollTop) === 0);

        await page.waitForFunction((id) => {
          const selector = document.querySelector('[aria-label="Dual View A resource"]');
          return selector instanceof HTMLSelectElement && !selector.disabled && [...selector.options].some(option => option.value === id);
        }, alphaId, { timeout: UI_TIMEOUT_MS });
         await viewerA.selectOption(alphaId);
         await viewerB.selectOption(betaId);
         await page.getByTestId("dual-pane-a").getByTestId("zoom-in").click();
        await page.getByTestId("dual-pane-a").locator("g.participant[data-node-id]").first().click();
        await page.getByTestId("dual-pane-b").getByTestId("zoom-in").click();
        await page.getByTestId("dual-pane-b").locator("g.participant[data-node-id]").last().locator("rect[data-node-id]").click();
        await page.waitForFunction(() => document.querySelectorAll("[data-testid^='dual-pane-'] .svg-node--active").length === 2, undefined, { timeout: UI_TIMEOUT_MS });
        const contextBeforeSwitch = await paneState();
         const contextSelector = page.getByRole("combobox", { name: "Dual View context" });
         await page.getByRole("button", { name: "Maximize Viewer B" }).click();
         await contextSelector.selectOption("shared");
         await page.waitForFunction(() => document.querySelector('[aria-label="Dual View context"]')?.value === "shared", undefined, { timeout: UI_TIMEOUT_MS });
         check("Maximizing then switching to SHARED resets the local layout", await page.getByTestId("dual-view").getAttribute("data-maximized-pane") === "normal");
        await page.getByTestId("dual-pane-a").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await contextSelector.selectOption(`my-work:${workId}`);
        await page.waitForFunction((value) => document.querySelector('[aria-label="Dual View context"]')?.value === value, `my-work:${workId}`, { timeout: UI_TIMEOUT_MS });
        await page.getByTestId("dual-pane-a").locator('[data-testid="preview-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        const afterContextRoundTrip = await paneState();
        check("SHARED ↔ MY WORK context changes discard the previous visual session", contextBeforeSwitch.every(pane => pane.activeNode !== null) && afterContextRoundTrip.every(pane => pane.activeNode === null && pane.transform !== contextBeforeSwitch[0].transform),
          `before ${contextBeforeSwitch.map(({ transform, activeNode }) => `${transform} / ${activeNode}`).join(" | ")} → after ${afterContextRoundTrip.map(({ transform, activeNode }) => `${transform} / ${activeNode}`).join(" | ")}`);
        await viewerA.selectOption(alphaId);
        await viewerB.selectOption(betaId);
        await page.getByTestId("dual-pane-b").locator('[data-testid="preview-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        const beforeModeSuspendAfterContextChange = await paneState();
        await page.getByRole("button", { name: "Maximize Viewer B" }).click();
        await page.getByRole("button", { name: "Switch to Analysis" }).click();
       await page.getByTestId("comparison-view").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       check("Suspending Dual View exits Focus and Fullscreen", await page.locator(".app--dual-focus").count() === 0 && await page.evaluate(() => document.fullscreenElement === null));
        await page.getByRole("button", { name: "Switch to Dual View" }).click();
        await page.getByTestId("dual-view").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        const afterModeResume = await paneState();
        check("Maximize B → Analysis → Dual resets local layout while preserving visual sessions", await page.getByTestId("dual-view").getAttribute("data-maximized-pane") === "normal");
        check("Analysis suspension preserves A/B SVG transforms, selected nodes, and resource identities", afterModeResume.every((pane, index) => pane.title === beforeModeSuspendAfterContextChange[index].title && pane.transform === beforeModeSuspendAfterContextChange[index].transform && pane.activeNode === beforeModeSuspendAfterContextChange[index].activeNode),
           `before ${beforeModeSuspendAfterContextChange.map(({ title, transform, activeNode }) => `${title}: ${transform} / ${activeNode}`).join(" | ")} → resumed ${afterModeResume.map(({ title, transform, activeNode }) => `${title}: ${transform} / ${activeNode}`).join(" | ")}`);
        check("Dual Focus and Fullscreen are not restored after resuming", await page.locator(".app--dual-focus").count() === 0 && await page.evaluate(() => document.fullscreenElement === null));

        await viewerA.selectOption(eventFlowId);
        await page.getByTestId("dual-pane-a").locator('[data-testid="preview-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await projection(page.getByTestId("dual-pane-a"), "Catalog").click();
        await page.getByTestId("dual-pane-a").getByTestId("event-catalog").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await page.getByRole("button", { name: "Maximize Viewer B" }).click();
        await page.getByRole("button", { name: "Switch to Analysis" }).click();
        await page.getByTestId("comparison-view").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await page.getByRole("button", { name: "Switch to Dual View" }).click();
        await page.getByTestId("dual-view").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        check("Maximize B → Analysis → Dual resets layout and restores the Event Flow Catalog projection", await page.getByTestId("dual-view").getAttribute("data-maximized-pane") === "normal" && await projection(page.getByTestId("dual-pane-a"), "Catalog").getAttribute("aria-pressed") === "true" && await page.getByTestId("dual-pane-a").locator('[data-testid="event-catalog"]').isVisible());
        await viewerA.selectOption(alphaId);
        await viewerB.selectOption(betaId);

        const beforeExplicitClose = await paneState();
       await page.getByRole("button", { name: "Maximize Viewer B" }).click();
       await page.getByRole("button", { name: "Fullscreen" }).click();
      await page.waitForFunction(() => document.fullscreenElement === document.querySelector("[data-testid='dual-view']"), undefined, { timeout: UI_TIMEOUT_MS });
      await page.getByRole("button", { name: "Close Dual View" }).click();
      await page.waitForFunction(() => document.fullscreenElement === null, undefined, { timeout: UI_TIMEOUT_MS });
      check("Closing Dual View from native Fullscreen exits the browser mode and restores the workspace", await page.getByTestId("dual-view").count() === 0 && await page.locator(".app__workspace--dual-view").count() === 0);
      check("Closing Dual View restores editor tabs and artifact opening", !(await page.getByTestId("view-code").isDisabled()) && await myWorkResourceOpeners.first().isEnabled());
        await page.getByTestId("compare-mode-button").click();
        await page.getByTestId("dual-view").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        check("Maximize B → close/reopen starts in normal layout", await page.getByTestId("dual-view").getAttribute("data-maximized-pane") === "normal");
       await page.getByTestId("dual-pane-a").locator('[data-testid="preview-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await page.getByTestId("dual-pane-b").locator('[data-testid="preview-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        const afterExplicitReopen = await paneState();
        check("Explicit close and reopen starts clean instead of restoring the closed session", afterExplicitReopen.every(pane => pane.activeNode === null) && afterExplicitReopen.some((pane, index) => pane.transform !== beforeExplicitClose[index].transform),
          `closed ${beforeExplicitClose.map(({ transform, activeNode }) => `${transform} / ${activeNode}`).join(" | ")} → reopened ${afterExplicitReopen.map(({ transform, activeNode }) => `${transform} / ${activeNode}`).join(" | ")}`);
       const reopenViewerA = page.getByRole("combobox", { name: "Dual View A resource" });
       const reopenViewerB = page.getByRole("combobox", { name: "Dual View B resource" });
       await reopenViewerA.selectOption(longNoteId);
       await reopenViewerB.selectOption(longNoteId);
       const reopenPaneA = page.getByTestId("dual-pane-a");
       const reopenPaneB = page.getByTestId("dual-pane-b");
       await reopenPaneA.getByTestId("markdown-body").getByRole("heading", { name: "Section 80" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await page.evaluate(() => [...document.querySelectorAll(".note-preview")].forEach((element, index) => { element.scrollTop = index ? 1_300 : 700; element.dispatchEvent(new Event("scroll", { bubbles: true })); }));
       await page.waitForTimeout(100);
       await page.getByRole("button", { name: "Close Dual View" }).click();
       await page.getByTestId("dual-view").waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
       await page.getByTestId("compare-mode-button").click();
       await page.getByTestId("dual-view").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await reopenViewerA.selectOption(longNoteId);
       await reopenViewerB.selectOption(longNoteId);
       await reopenPaneA.locator(".note-preview").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await page.waitForFunction(() => (document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop ?? -1) === 0 && (document.querySelector('[data-testid="dual-pane-b"] .note-preview')?.scrollTop ?? -1) === 0, undefined, { timeout: UI_TIMEOUT_MS });
       check("Explicit close/reopen clears Markdown read positions in both real scrollers", (await reopenPaneA.locator(".note-preview").evaluate((element) => element.scrollTop)) === 0 && (await reopenPaneB.locator(".note-preview").evaluate((element) => element.scrollTop)) === 0);
       const dualA = page.getByRole("combobox", { name: "Dual View A resource" });
      const dualB = page.getByRole("combobox", { name: "Dual View B resource" });
      await dualA.selectOption(noteId);
      await dualB.selectOption(alphaId);
      const notePane = page.getByTestId("dual-pane-a");
      const diagramPane = page.getByTestId("dual-pane-b");
      await notePane.getByTestId("markdown-body").getByRole("heading", { name: "Parallel test note" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await diagramPane.locator('[data-testid="preview-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       check("Dual View renders a Markdown note beside a Sequence diagram", await notePane.getByTestId("markdown-body").isVisible() && await diagramPane.locator("[data-node-id]").count() > 0);

       const contextMarkdownMyWorkId = `my-work:${workId}:${createdResources.get("long-reading.md")}`;
       const contextSwitch = page.getByRole("combobox", { name: "Dual View context" });
       const waitForMarkdownContextOption = async (optionId) => {
         await page.waitForFunction((id) => {
           const selectors = ["[aria-label='Dual View A resource']", "[aria-label='Dual View B resource']"]
             .map(selector => document.querySelector(selector));
           return selectors.every(selector => selector instanceof HTMLSelectElement && !selector.disabled && [...selector.options].some(option => option.value === id));
         }, optionId, { timeout: UI_TIMEOUT_MS });
       };
       await waitForMarkdownContextOption(contextMarkdownMyWorkId);
       await page.getByRole("combobox", { name: "Dual View A resource" }).selectOption(contextMarkdownMyWorkId);
       await page.getByRole("combobox", { name: "Dual View B resource" }).selectOption(contextMarkdownMyWorkId);
       await page.getByTestId("dual-pane-a").getByTestId("markdown-body").getByRole("heading", { name: "Long reading", level: 1 }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await page.getByTestId("dual-pane-b").getByTestId("markdown-body").getByRole("heading", { name: "Long reading", level: 1 }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await page.evaluate(() => [...document.querySelectorAll(".note-preview")].forEach((element, index) => { element.scrollTop = index ? 920 : 360; element.dispatchEvent(new Event("scroll", { bubbles: true })); }));
       await page.waitForTimeout(100);
        await contextSwitch.selectOption("shared");
        await page.waitForFunction(() => document.querySelector('[aria-label="Dual View context"]')?.value === "shared", undefined, { timeout: UI_TIMEOUT_MS });
        await page.waitForFunction(() => {
          const select = document.querySelector('[aria-label="Dual View A resource"]');
          return select instanceof HTMLSelectElement && !select.disabled && [...select.options].some(option => /reading/i.test(option.textContent ?? ""));
        }, undefined, { timeout: UI_TIMEOUT_MS });
        const sharedOptionState = await page.getByRole("combobox", { name: "Dual View A resource" }).evaluate(select => [...select.options].map(option => ({ value: option.value, label: option.textContent })));
       const sharedLongNoteId = sharedOptionState.find(option => /reading/i.test(option.label ?? ""))?.value ?? "";
       check("SHARED fixture exposes the promoted Markdown resource by its authorized option", sharedLongNoteId !== "", JSON.stringify(sharedOptionState));
       await waitForMarkdownContextOption(sharedLongNoteId);
       await page.getByRole("combobox", { name: "Dual View A resource" }).selectOption(sharedLongNoteId);
       await page.getByRole("combobox", { name: "Dual View B resource" }).selectOption(sharedLongNoteId);
       await page.getByTestId("dual-pane-a").getByTestId("markdown-body").getByRole("heading", { name: "Long reading", level: 1 }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await page.getByTestId("dual-pane-b").getByTestId("markdown-body").getByRole("heading", { name: "Long reading", level: 1 }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await page.waitForFunction(() => (document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop ?? -1) === 0 && (document.querySelector('[data-testid="dual-pane-b"] .note-preview')?.scrollTop ?? -1) === 0, undefined, { timeout: UI_TIMEOUT_MS });
       check("MY WORK offsets do not transfer into SHARED Markdown A/B real scrollers", await page.getByTestId("dual-pane-a").locator(".note-preview").evaluate(element => element.scrollTop) === 0 && await page.getByTestId("dual-pane-b").locator(".note-preview").evaluate(element => element.scrollTop) === 0);
       await page.evaluate(() => [...document.querySelectorAll(".note-preview")].forEach((element, index) => { element.scrollTop = index ? 640 : 210; element.dispatchEvent(new Event("scroll", { bubbles: true })); }));
       await page.waitForTimeout(100);
       await contextSwitch.selectOption(`my-work:${workId}`);
       await page.waitForFunction((value) => document.querySelector('[aria-label="Dual View context"]')?.value === value, `my-work:${workId}`, { timeout: UI_TIMEOUT_MS });
       await waitForMarkdownContextOption(contextMarkdownMyWorkId);
       await page.getByRole("combobox", { name: "Dual View A resource" }).selectOption(contextMarkdownMyWorkId);
       await page.getByRole("combobox", { name: "Dual View B resource" }).selectOption(contextMarkdownMyWorkId);
       await page.getByTestId("dual-pane-a").getByTestId("markdown-body").getByRole("heading", { name: "Long reading", level: 1 }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await page.getByTestId("dual-pane-b").getByTestId("markdown-body").getByRole("heading", { name: "Long reading", level: 1 }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await page.waitForFunction(() => (document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop ?? -1) === 0 && (document.querySelector('[data-testid="dual-pane-b"] .note-preview')?.scrollTop ?? -1) === 0, undefined, { timeout: UI_TIMEOUT_MS });
       check("SHARED offsets do not transfer back into MY WORK Markdown A/B real scrollers", await page.getByTestId("dual-pane-a").locator(".note-preview").evaluate(element => element.scrollTop) === 0 && await page.getByTestId("dual-pane-b").locator(".note-preview").evaluate(element => element.scrollTop) === 0);

       await page.getByRole("button", { name: "Close Dual View" }).click();
      await page.getByTestId("analysis-mode-button").click();
      await page.getByTestId("comparison-view").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByTestId("semantic-comparison-summary").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("Analysis retains semantic comparison summary", await page.getByTestId("semantic-comparison-summary").isVisible());
      check("Analysis starts with tabs disabled when editor preference hides it", await checkEditorTabsDisabled());
      check("Analysis disables SHARED and MY WORK artifact openers", await sharedResourceOpeners.evaluateAll((buttons) => buttons.every((button) => button.disabled)) && await myWorkResourceOpeners.evaluateAll((buttons) => buttons.every((button) => button.disabled)));
       check("Analysis keeps editor tabs disabled while the immersive shell is active", await checkEditorTabsDisabled() && await editorShell.evaluate((editor) => getComputedStyle(editor).display === "none"));
      await page.setViewportSize({ width: 480, height: 1000 });
      await delay(500);
      const responsiveLayoutEvidence = await page.evaluate(() => {
        const workspace = document.querySelector(".app__workspace");
        const preview = workspace?.querySelector(".app__pane--preview");
        const editor = document.querySelector(".app__pane--editor");
        const tabs = ["view-code", "view-outline", "view-problems", "view-overview", "view-history", "view-changes"]
          .map((id) => ({ id, disabled: document.querySelector(`[data-testid="${id}"]`)?.disabled ?? null }));
        const preferences = JSON.parse(localStorage.getItem("sequencediagrams.ui-preferences") ?? "null");
        return {
          viewport: window.innerWidth,
          document: document.documentElement.clientWidth,
          workspace: workspace?.clientWidth ?? -1,
          previewWidth: preview?.getBoundingClientRect().width ?? -1,
          previewLeft: preview?.getBoundingClientRect().left ?? -1,
          reactMeasuredWorkspace: workspace?.getAttribute("data-layout-width"),
          breakpointHidden: workspace?.getAttribute("data-editor-responsive-hidden"),
          analysisOpen: workspace?.getAttribute("data-analysis-open"),
          editorHiddenPreference: preferences?.screens?.comparison?.editorHidden ?? null,
          editorTabsDisabledDerived: workspace?.getAttribute("data-editor-tabs-disabled"),
          workspaceClasses: workspace?.className ?? "",
          appClasses: document.querySelector("[data-testid='app-shell']")?.className ?? "",
          editorDisplay: editor ? getComputedStyle(editor).display : "missing",
          editorVisibility: editor ? getComputedStyle(editor).visibility : "missing",
          tabs,
        };
      });
       check("Analysis retains the immersive layout and full preview width at narrow viewport", await checkEditorTabsDisabled() && !(await editorShell.isVisible()) && await page.locator(".app__workspace--immersive").count() === 1 && responsiveLayoutEvidence.previewLeft === 0 && Math.abs(responsiveLayoutEvidence.previewWidth - responsiveLayoutEvidence.workspace) <= 1, JSON.stringify(responsiveLayoutEvidence));
      await page.setViewportSize({ width: 1440, height: 1100 });
      await delay(500);
       await page.waitForFunction(() => document.querySelector(".app__workspace")?.classList.contains("app__workspace--immersive"), undefined, { timeout: UI_TIMEOUT_MS });
       check("Analysis remains immersive when returning to a wide viewport", await checkEditorTabsDisabled() && !(await editorShell.isVisible()));
       await page.getByRole("button", { name: "Close comparison" }).click();
        check("Closing Analysis restores editor tabs and ordinary resource opening", !(await page.getByTestId("view-code").isDisabled()) && await myWorkResourceOpeners.first().isEnabled());
        const collapseExplorer = page.getByRole("button", { name: "Collapse project explorer" });
        if (await collapseExplorer.isVisible()) await collapseExplorer.click();
        const expandExplorer = page.getByRole("button", { name: "Expand project explorer" });
        await expandExplorer.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        const collapsedPreferenceBefore = await page.evaluate(() => localStorage.getItem("sequencediagrams.ui-preferences"));
       await page.getByTestId("analysis-mode-button").click();
       await page.getByTestId("comparison-view").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        check("Immersive Analysis hides an Explorer that was already collapsed", await page.locator(".app__workspace").evaluate((workspace) => getComputedStyle(workspace.querySelector(".app__explorer-restore")).display === "none"));
        await page.getByRole("button", { name: "Close comparison" }).click();
        await expandExplorer.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        const collapsedPreferenceAfter = await page.evaluate(() => localStorage.getItem("sequencediagrams.ui-preferences"));
        check("Closing Analysis restores the previously collapsed Explorer without preference writes", await expandExplorer.isVisible() && collapsedPreferenceAfter === collapsedPreferenceBefore, JSON.stringify({ before: collapsedPreferenceBefore, after: collapsedPreferenceAfter }));
        await expandExplorer.click();

       const proposalTitle = `Navigation return ${Date.now()}`;
      const proposalResponse = await apiRequest(page, `/api/projects/${projectId}/architectural-proposals`, {
        method: "POST",
        body: JSON.stringify({ sourcePrivateContextId: workId, resourceIds: [createdResources.get("alpha.seq")], title: proposalTitle, description: "Disposable navigation E2E proposal." }),
      });
      if (proposalResponse.status !== 201 || !proposalResponse.json?.proposal?.id) throw new Error(`Disposable proposal creation failed: ${proposalResponse.status} ${proposalResponse.text}`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator('[data-testid="workspace-active-project"]').filter({ hasText: projectName }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await openMyWorkContext(page, workId);
      const proposalsToggle = page.locator('[data-testid="explorer-proposals-toggle"]');
      if ((await proposalsToggle.getAttribute("aria-expanded")) !== "true") await proposalsToggle.click();
       const proposalOpen = page.locator('[data-testid="explorer-proposal"]').filter({ hasText: proposalTitle }).getByTestId("explorer-proposal-open");
       await proposalOpen.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await privateTree.getByRole("button", { name: "Load diagram Alpha" }).click();
        await page.getByTestId("compare-mode-button").click();
         await viewerA.selectOption(alphaId);
         await viewerB.selectOption(betaId);
        await page.getByTestId("dual-pane-a").getByTestId("zoom-in").click();
        await page.getByTestId("dual-pane-a").locator("g.participant[data-node-id]").first().click();
        await page.getByTestId("dual-pane-b").getByTestId("zoom-in").click();
          await page.getByTestId("dual-pane-b").locator("g.participant[data-node-id]").last().locator("rect[data-node-id]").click();
        await page.waitForFunction(() => document.querySelectorAll("[data-testid^='dual-pane-'] .svg-node--active").length === 2, undefined, { timeout: UI_TIMEOUT_MS });
         await viewerA.selectOption(longNoteId);
         await viewerB.selectOption(longNoteId);
         await page.getByTestId("dual-pane-a").getByTestId("markdown-body").getByRole("heading", { name: "Long reading", level: 1 }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
         await page.getByTestId("dual-pane-b").getByTestId("markdown-body").getByRole("heading", { name: "Long reading", level: 1 }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
          await page.evaluate(() => [...document.querySelectorAll(".note-preview")].forEach((element, index) => { element.scrollTop = index ? 970 : 520; element.dispatchEvent(new Event("scroll", { bubbles: true })); }));
          await page.waitForFunction(() => Math.abs((document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop ?? 0) - 520) <= 2 && Math.abs((document.querySelector('[data-testid="dual-pane-b"] .note-preview')?.scrollTop ?? 0) - 970) <= 2, undefined, { timeout: UI_TIMEOUT_MS });
          await page.getByRole("button", { name: "Maximize Viewer B" }).click();
          await page.getByRole("combobox", { name: "Open proposal" }).selectOption(proposalResponse.json.proposal.id);
         await page.getByRole("region", { name: "Architectural Proposal" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
          await page.goBack();
          await page.getByTestId("dual-view").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
          await page.waitForFunction(() => Math.abs((document.querySelector('[data-testid="dual-pane-a"] .note-preview')?.scrollTop ?? 0) - 520) <= 2 && Math.abs((document.querySelector('[data-testid="dual-pane-b"] .note-preview')?.scrollTop ?? 0) - 970) <= 2, undefined, { timeout: UI_TIMEOUT_MS });
          check("Maximize B → proposal → Dual resets local layout and restores independent Markdown positions", await page.getByTestId("dual-view").getAttribute("data-maximized-pane") === "normal" && Math.abs(await page.getByTestId("dual-pane-a").locator(".note-preview").evaluate(element => element.scrollTop) - 520) <= 2 && Math.abs(await page.getByTestId("dual-pane-b").locator(".note-preview").evaluate(element => element.scrollTop) - 970) <= 2);
         await viewerA.selectOption(eventFlowId);
         await page.getByTestId("dual-pane-a").locator('[data-testid="preview-svg"] svg').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
         await projection(page.getByTestId("dual-pane-a"), "Causal").click();
          await page.getByTestId("dual-pane-a").getByTestId("event-causal").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
          const beforeDualProposal = await paneState();
         await page.getByRole("button", { name: "Maximize Viewer A" }).click();
         await page.getByRole("combobox", { name: "Open proposal" }).selectOption(proposalResponse.json.proposal.id);
      const restoreProposalDetails = page.getByRole("button", { name: "Show proposal details" });
      if (await restoreProposalDetails.isVisible()) await restoreProposalDetails.click();
      await page.getByRole("region", { name: "Architectural Proposal" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await waitForText(page.getByRole("region", { name: "Architectural Proposal" }), text => text.includes(proposalTitle), "Dual View proposal title");
      check("Proposal opened from Dual View is displayed", await page.getByRole("region", { name: "Architectural Proposal" }).getByRole("heading", { name: proposalTitle }).isVisible());
         await page.goBack();
         await page.getByTestId("dual-view").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
          const afterDualProposal = await paneState();
          check("Maximize A → proposal → Dual resets layout and restores actual cameras, nodes, resources and shell", await page.getByTestId("dual-view").getAttribute("data-maximized-pane") === "normal" && await checkEditorTabsDisabled() && await page.locator(".app__workspace--immersive").count() === 1 && afterDualProposal.every((pane, index) => pane.title === beforeDualProposal[index].title && pane.transform === beforeDualProposal[index].transform && pane.activeNode === beforeDualProposal[index].activeNode),
           `before ${beforeDualProposal.map(({ title, transform, activeNode }) => `${title}: ${transform} / ${activeNode}`).join(" | ")} → after ${afterDualProposal.map(({ title, transform, activeNode }) => `${title}: ${transform} / ${activeNode}`).join(" | ")}`);
         check("Dual → proposal → Dual restores the Event Flow Causal projection in DOM", await projection(page.getByTestId("dual-pane-a"), "Causal").getAttribute("aria-pressed") === "true" && await page.getByTestId("dual-pane-a").getByTestId("event-causal").isVisible());
       await page.getByRole("button", { name: "Close Dual View" }).click();
       await page.getByTestId("analysis-mode-button").click();
       await page.getByTestId("comparison-view").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await page.getByRole("combobox", { name: "Open proposal" }).selectOption(proposalResponse.json.proposal.id);
      const restoreAnalysisProposalDetails = page.getByRole("button", { name: "Show proposal details" });
      if (await restoreAnalysisProposalDetails.isVisible()) await restoreAnalysisProposalDetails.click();
      await page.getByRole("region", { name: "Architectural Proposal" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await waitForText(page.getByRole("region", { name: "Architectural Proposal" }), text => text.includes(proposalTitle), "Analysis proposal title");
      check("Proposal opened from Analysis is displayed", await page.getByRole("region", { name: "Architectural Proposal" }).getByRole("heading", { name: proposalTitle }).isVisible());
       await page.goBack();
       await page.getByTestId("comparison-view").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        const restoredAnalysis = await page.locator(".app__workspace").evaluate((workspace) => ({ className: workspace.className, tabsDisabled: workspace.getAttribute("data-editor-tabs-disabled"), proposalRegion: Boolean(document.querySelector('[aria-label="Architectural Proposal"]')) }));
        check("Returning from proposal restores Analysis and its immersive controls", await checkEditorTabsDisabled() && await page.locator(".app__workspace--immersive").count() === 1, JSON.stringify(restoredAnalysis));
      await page.getByRole("button", { name: "Close comparison" }).click();

      const focus = page.getByTestId("viewer-focus-toggle");
      await focus.click();
      await page.locator(".app__workspace--focus").waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
      check("Ordinary viewer Focus still enters focus mode", await page.locator(".app__workspace--focus").count() === 1);
      await page.keyboard.press("Escape");
      await page.locator(".app__workspace:not(.app__workspace--focus)").waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });

      const fullscreen = page.getByTestId("viewer-fullscreen-toggle");
      await fullscreen.click();
      await page.waitForFunction(() => document.fullscreenElement === document.querySelector(".app__pane--preview"), undefined, { timeout: UI_TIMEOUT_MS });
      check("Ordinary viewer Fullscreen still targets the preview pane", true);
      await fullscreen.click();
      await page.waitForFunction(() => document.fullscreenElement === null, undefined, { timeout: UI_TIMEOUT_MS });
    } finally {
      await context.close();
    }

    check("No HTTP 500 responses during Dual View E2E", http500s.length === 0, http500s.join(", "));
  });

  await scenario("Universal focus mode preserves viewer state across representations", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    let projectId = null;
    let workId = null;
    try {
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(page);
      await signIn(page, idp, owner);
      const workspaces = await apiRequest(page, "/api/workspaces");
      if (workspaces.status !== 200 || !workspaces.json.workspaces.length) throw new Error("No accessible workspace for viewer fixture.");
      const created = await apiRequest(page, "/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "UX-2A Focus Viewer Fixture", workspaceId: workspaces.json.workspaces[0].id }),
      });
      if (created.status !== 201) throw new Error(`Fixture project creation failed: ${created.status}`);
      projectId = created.json.project.id;
      const work = await apiRequest(page, `/api/projects/${projectId}/private-work`, {
        method: "POST",
        body: JSON.stringify({ name: "UX-2A focus fixture" }),
      });
      if (work.status !== 201) throw new Error(`Fixture MY WORK context creation failed: ${work.status} ${work.text}`);
      workId = work.json.context.id;
      const causalFocusSource = [
        'title "Focus Event Flow"',
        ...Array.from({ length: 9 }, (_, index) => `event Step${index + 1}`),
        ...Array.from({ length: 8 }, (_, index) => `handler Handler${index + 1}`),
        ...Array.from({ length: 8 }, (_, index) => `effect persist-${index + 1} on Handler${index + 1}: persist step ${index + 1}`),
        "producer OrderService", "consumer BillingService", "topic orders",
        "OrderService publishes Step1 to orders", "BillingService consumes Step1 from orders",
        ...Array.from({ length: 8 }, (_, index) => [`Step${index + 1} handled by Handler${index + 1}`, `Handler${index + 1} causes Step${index + 2}`]).flat(),
      ].join("\n");
      const resources = [
        { path: "focus-sequence.seq", type: "sequence-diagram", content: 'title "Focus Sequence"\nparticipant Browser\nparticipant API\nBrowser ->> API: request' },
        { path: "focus-event-flow.eventseq", type: "event-flow", content: causalFocusSource },
        { path: "focus-concept.concept", type: "conceptual", content: 'concept account "Account"\nconcept invoice "Invoice"\nrelation owns account -> invoice "owns"' },
        { path: "focus-schema.dbschema", type: "database", content: 'title "Focus Schema"\ntable users - "users"\ncolumn users user_id "id" {uuid} not-null\nprimary-key users_pk users (id)' },
        { path: "focus-reading.md", type: "markdown-document", content: `# Focus reading\n\n${Array.from({ length: 40 }, (_, index) => `Section ${index + 1}\n\nA readable paragraph in the focus reading fixture.`).join("\n\n")}` },
      ];
      for (const resource of resources) {
        const response = await apiRequest(page, `/api/projects/${projectId}/resources`, { method: "POST", body: JSON.stringify({ ...resource, contextId: workId }) });
        if (response.status !== 201) throw new Error(`Fixture resource ${resource.path} failed: ${response.status} ${response.text}`);
      }

      await page.goto(`${BASE_URL}/?project=${encodeURIComponent(projectId)}`, { waitUntil: "domcontentloaded" });
      await page.locator('[data-testid="workspace-active-project"]').filter({ hasText: "UX-2A Focus Viewer Fixture" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByTestId(`explorer-private-context-open-${workId}`).click();
      const myWorkToggle = page.getByTestId("explorer-my-work-toggle");
      if (await myWorkToggle.getAttribute("aria-expanded") !== "true") await myWorkToggle.click();

      const representations = [
        { path: "focus-sequence.seq", label: "Focus Sequence", view: "Sequence", svg: "preview-svg" },
        { path: "focus-event-flow.eventseq", label: "Focus Event Flow", view: "Event Flow Flow", svg: "preview-svg" },
        { path: "focus-concept.concept", label: "focus-concept.concept", view: "Conceptual", svg: "conceptual-preview-svg" },
        { path: "focus-schema.dbschema", label: "Focus Schema", view: "Database", svg: "database-preview-svg" },
      ];
      for (const [index, representation] of representations.entries()) {
        const row = page.locator('[data-testid="explorer-my-work-section"] [data-testid="explorer-diagram"], [data-testid="explorer-my-work-section"] [data-testid="explorer-note"]').filter({ hasText: representation.label });
        await row.getByTestId("select-diagram-button").click();
        await row.waitFor({ state: "visible" });
        await page.waitForFunction(({ label }) => {
          const selected = document.querySelector('[data-testid="explorer-my-work-section"] .explorer__resource--selected');
          return selected?.textContent?.includes(label) ?? false;
        }, { label: representation.label });
        if (representation.view === "Event Flow Flow") {
          await page.getByTestId("event-flow-preview").getByRole("button", { name: "Flow", exact: true }).click();
        }
        if (representation.svg) {
          await page.getByTestId(representation.svg).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
          const marker = representation.view === "Sequence" ? "Focus Sequence" : "Focus Event Flow";
          if (representation.view === "Sequence" || representation.view.startsWith("Event Flow")) {
            await page.waitForFunction(({ testId, marker }) => {
              const surface = document.querySelector(`[data-testid="${testId}"]`);
              return surface?.textContent?.includes(marker) ?? false;
            }, { testId: representation.svg, marker });
          }
        }
        if (representation.view === "Sequence") {
          const prefsBefore = await page.evaluate(() => localStorage.getItem("sequencediagrams.ui-preferences"));
          const focusChord = await page.evaluate(() => /mac|iphone|ipad/i.test(navigator.platform) ? "Meta+;" : "Control+;");
          const focusButton = page.getByTestId("viewer-focus-toggle");
          const focusLabel = await page.evaluate(() => /mac|iphone|ipad/i.test(navigator.platform) ? "⌘;" : "Ctrl+;");
          check("Focus button and tooltip document the two-key shortcut", (await focusButton.innerText()).includes(focusLabel) && (await focusButton.getAttribute("title")).includes(focusLabel));
          await focusButton.focus();
          await page.keyboard.press(focusChord);
          check("Focus chord is ignored while an interactive button owns focus", !(await page.locator(".app__workspace").evaluate((element) => element.classList.contains("app__workspace--focus"))));
          await page.getByTestId("command-palette-button").click();
          await page.getByTestId("palette-input").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
          await page.keyboard.press(focusChord);
          check("Focus chord is ignored in an editable palette field and active overlay", !(await page.locator(".app__workspace").evaluate((element) => element.classList.contains("app__workspace--focus"))));
          await page.keyboard.press("Escape");
          await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
          await page.keyboard.press(focusChord);
          await page.locator(".app__workspace--focus").waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
          check("Focus chord activates focus from non-editable application space", true);
          await page.keyboard.press("Escape");
          await page.locator(".app__workspace:not(.app__workspace--focus)").waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
          await page.locator("[data-testid=viewport-pane]").focus();
          await page.keyboard.press(focusChord);
          await page.locator(".app__workspace--focus").waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
          check("Focus chord activates focus while the viewer canvas has keyboard focus", true);
          await page.keyboard.press("Escape");
          await page.locator(".app__workspace:not(.app__workspace--focus)").waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
          check("Escape restores focus to the available origin control", await focusButton.evaluate((button) => document.activeElement === button));
          check("Focus chord and Escape leave persisted UI preferences untouched", await page.evaluate(() => localStorage.getItem("sequencediagrams.ui-preferences")) === prefsBefore);
        }
        const focus = page.getByTestId("viewer-focus-toggle");
        check(`${representation.view} exposes one shared viewer expansion control`, await focus.count() === 1 && await page.getByTestId("preview-maximize").count() === 0);
        const fullscreen = page.getByTestId("viewer-fullscreen-toggle");
        check(`${representation.view} exposes shared native fullscreen`, await fullscreen.count() === 1);
        const previewPane = page.locator(".app__pane--preview");
        let fullscreenCamera = null;
        if (index === 0 && process.env.E2E_SCREENSHOT_DIR) {
          await mkdir(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.E2E_SCREENSHOT_DIR, "ux-2b-fullscreen-before.png"), fullPage: true });
        }
        await fullscreen.click();
        await page.waitForFunction((pane) => document.fullscreenElement === pane, await previewPane.elementHandle());
        check(`${representation.view} enters browser fullscreen from normal view`, true);
        if (index === 0 && representation.svg) {
          const fullscreenCanvas = page.getByTestId(representation.svg);
          const beforeGesture = await fullscreenCanvas.getAttribute("style");
          await page.getByTestId("viewport-pane").hover();
          await page.mouse.wheel(0, -120);
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const afterZoom = await fullscreenCanvas.getAttribute("style");
          check("Manual zoom during fullscreen changes the SVG camera", afterZoom !== beforeGesture);
          const canvasBox = await page.getByTestId("viewport-pane").boundingBox();
          if (canvasBox) {
            await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
            await page.mouse.down();
            await page.mouse.move(canvasBox.x + 75, canvasBox.y + 65);
            await page.mouse.up();
          }
          check("Manual pan during fullscreen preserves the adjusted SVG camera", await fullscreenCanvas.getAttribute("style") !== afterZoom);
          fullscreenCamera = await fullscreenCanvas.getAttribute("style");
        }
        if (index === 0 && process.env.E2E_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.E2E_SCREENSHOT_DIR, "ux-2b-fullscreen-active.png"), fullPage: true });
        await fullscreen.click();
        await page.waitForFunction(() => document.fullscreenElement === null);
        await page.waitForFunction(() => document.querySelector('[data-testid="viewer-fullscreen-toggle"]')?.getAttribute("aria-pressed") === "false");
        check(`${representation.view} exits native fullscreen with its preview visible`, await previewPane.isVisible());
        if (fullscreenCamera !== null && representation.svg) check("Fullscreen exit preserves the manually adjusted SVG camera", await page.getByTestId(representation.svg).getAttribute("style") === fullscreenCamera);

        let camera = null;
        let renderedNode = null;
        if (representation.svg) {
          const canvas = page.getByTestId(representation.svg);
          renderedNode = await canvas.elementHandle();
          if (!renderedNode) {
            const previewState = await page.locator(".app__pane--preview").innerText();
            throw new Error(`${representation.view} selected but ${representation.svg} is absent; preview text: ${previewState}`);
          }
          const zoom = page.getByTestId("zoom-in");
          if (await zoom.count()) await zoom.click();
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          camera = await renderedNode.getAttribute("style");
        }
        if (index === 0 && process.env.E2E_SCREENSHOT_DIR) {
          await mkdir(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.E2E_SCREENSHOT_DIR, "ux-2a-focus-normal.png"), fullPage: true });
        }
        await focus.click();
        await page.locator('[data-testid="app-shell"] .app__workspace--focus').waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        check(`${representation.view} renderer remains mounted in focus mode`, !renderedNode || await renderedNode.evaluate((element) => element.isConnected));
        if (representation.svg) {
          const geometry = await page.evaluate((testId) => {
            const content = document.querySelector(`[data-testid="${testId}"]`);
            const viewport = document.querySelector('[data-testid="viewport-pane"]');
            if (!content || !viewport) return null;
            const diagram = content.getBoundingClientRect();
            const pane = viewport.getBoundingClientRect();
            return {
              centerDeltaX: Math.abs((diagram.left + diagram.right) / 2 - (pane.left + pane.right) / 2),
              centerDeltaY: Math.abs((diagram.top + diagram.bottom) / 2 - (pane.top + pane.bottom) / 2),
              contained: diagram.left >= pane.left - 2 && diagram.top >= pane.top - 2 && diagram.right <= pane.right + 2 && diagram.bottom <= pane.bottom + 2,
            };
          }, representation.svg);
          check(`${representation.view} content is centered and fitted in focus`, geometry !== null && geometry.centerDeltaX < 8 && geometry.centerDeltaY < 8 && geometry.contained, JSON.stringify(geometry));
          const fittedCamera = await renderedNode.getAttribute("style");
          await page.locator('[data-testid="viewport-pane"]').hover();
          await page.mouse.wheel(0, -160);
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const manuallyAdjustedCamera = await renderedNode.getAttribute("style");
          await page.waitForTimeout(120);
          check(`${representation.view} manual zoom is not refitted in focus`, manuallyAdjustedCamera !== fittedCamera && await renderedNode.getAttribute("style") === manuallyAdjustedCamera);
        }
        if (index === 0) {
          await fullscreen.click();
          await page.waitForFunction((pane) => document.fullscreenElement === pane, await previewPane.elementHandle());
          await fullscreen.click();
          await page.waitForFunction(() => document.fullscreenElement === null);
          await page.waitForFunction(() => document.querySelector('[data-testid="viewer-fullscreen-toggle"]')?.getAttribute("aria-pressed") === "false");
          check("Fullscreen control exits from Focus without leaving Focus", await page.locator(".app__workspace--focus").count() === 1);
          if (process.env.E2E_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.E2E_SCREENSHOT_DIR, "ux-2b-fullscreen-restored.png"), fullPage: true });
        }
        check(`${representation.view} exit control remains available`, await page.getByRole("button", { name: /Exit focus/ }).isVisible());
        if (index === 0 && process.env.E2E_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.E2E_SCREENSHOT_DIR, "ux-2a-focus-mode.png"), fullPage: true });
        await page.keyboard.press("Escape");
        await page.locator('[data-testid="app-shell"] .app__workspace:not(.app__workspace--focus)').waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        if (representation.svg) check(`${representation.view} camera restores after focus`, await renderedNode.getAttribute("style") === camera);
        if (index === 0 && process.env.E2E_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.E2E_SCREENSHOT_DIR, "ux-2a-focus-restored.png"), fullPage: true });
        check(`${representation.view} restores shell panels`, await page.getByTestId("viewer-focus-toggle").isVisible() && await page.locator('[data-testid="explorer-my-work-section"]').isVisible());

        if (representation.view === "Event Flow Flow") {
          for (const subview of ["Topology", "Causal", "Flow"]) {
            await page.getByRole("button", { name: subview, exact: true }).click();
            let causalCamera = null;
            if (subview === "Causal") {
              const causalViewport = page.locator(".react-flow__viewport");
              await causalViewport.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
              causalCamera = await causalViewport.getAttribute("style");
            }
            await page.getByTestId("viewer-focus-toggle").click();
            await page.locator(".app__workspace--focus").waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            if (subview === "Causal") {
              const graphGeometry = await page.evaluate(() => {
                const pane = document.querySelector(".react-flow");
                const nodes = [...document.querySelectorAll(".react-flow__node")];
                if (!pane || nodes.length === 0) return null;
                const bounds = pane.getBoundingClientRect();
                const rects = nodes.map((node) => node.getBoundingClientRect());
                const graph = {
                  left: Math.min(...rects.map((rect) => rect.left)),
                  top: Math.min(...rects.map((rect) => rect.top)),
                  right: Math.max(...rects.map((rect) => rect.right)),
                  bottom: Math.max(...rects.map((rect) => rect.bottom)),
                };
                return {
                  centerDeltaX: Math.abs((graph.left + graph.right) / 2 - (bounds.left + bounds.right) / 2),
                  centerDeltaY: Math.abs((graph.top + graph.bottom) / 2 - (bounds.top + bounds.bottom) / 2),
                  contained: graph.left >= bounds.left - 2 && graph.top >= bounds.top - 2 && graph.right <= bounds.right + 2 && graph.bottom <= bounds.bottom + 2,
                };
              });
              check("Causal graph is centered and fitted in focus", graphGeometry !== null && graphGeometry.centerDeltaX < 20 && graphGeometry.centerDeltaY < 20 && graphGeometry.contained, JSON.stringify(graphGeometry));
              const causalViewport = page.locator(".react-flow__viewport");
              const fittedCamera = await causalViewport.getAttribute("style");
              await page.locator(".react-flow").hover();
              await page.mouse.wheel(0, -160);
              await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
              const manuallyAdjustedCamera = await causalViewport.getAttribute("style");
              await page.waitForTimeout(120);
              check("Causal manual zoom is not refitted in focus", manuallyAdjustedCamera !== fittedCamera && await causalViewport.getAttribute("style") === manuallyAdjustedCamera);
            }
            await page.keyboard.press("Escape");
            await page.locator(".app__workspace:not(.app__workspace--focus)").waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
            if (subview === "Causal") check("Causal camera restores after focus", await page.locator(".react-flow__viewport").getAttribute("style") === causalCamera);
            if (subview === "Causal") {
              const flowViewport = page.locator(".react-flow__viewport");
              const cameraBeforeFullscreen = await flowViewport.getAttribute("style");
              await page.getByTestId("viewer-fullscreen-toggle").click();
              await page.waitForFunction((pane) => document.fullscreenElement === pane, await page.locator(".app__pane--preview").elementHandle());
              check("Causal React Flow enters native fullscreen without remounting", await flowViewport.count() === 1);
              await page.getByTestId("viewer-fullscreen-toggle").click();
              await page.waitForFunction(() => document.fullscreenElement === null);
              await page.waitForFunction(() => document.querySelector('[data-testid="viewer-fullscreen-toggle"]')?.getAttribute("aria-pressed") === "false");
              check("Causal React Flow fullscreen preserves its camera", await flowViewport.getAttribute("style") === cameraBeforeFullscreen);
            }
          }
        }
      }
      const markdownRow = page.locator('[data-testid="explorer-my-work-section"] [data-testid="explorer-note"]').filter({ hasText: "Focus reading" });
      await markdownRow.getByTestId("select-note-button").click();
      await page.getByTestId("note-preview").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const markdownScroller = page.getByTestId("note-preview");
      await markdownScroller.evaluate((element) => { element.scrollTop = 160; });
      const markdownScroll = await markdownScroller.evaluate((element) => element.scrollTop);
      await page.getByTestId("viewer-focus-toggle").click();
      await page.locator(".app__workspace--focus").waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
      check("Markdown preserves reading scroll in focus", await markdownScroller.evaluate((element) => element.scrollTop) === markdownScroll);
      await page.getByTestId("viewer-fullscreen-toggle").click();
      await page.waitForFunction((pane) => document.fullscreenElement === pane, await page.locator(".app__pane--preview").elementHandle());
      check("Markdown enters native fullscreen without resetting reading scroll", await markdownScroller.evaluate((element) => element.scrollTop) === markdownScroll);
      await page.getByTestId("viewer-fullscreen-toggle").click();
      await page.waitForFunction(() => document.fullscreenElement === null);
      check("Markdown fullscreen exit preserves Focus and scroll", await page.locator(".app__workspace--focus").count() === 1 && await markdownScroller.evaluate((element) => element.scrollTop) === markdownScroll);
      await page.keyboard.press("Escape");
      await page.locator(".app__workspace:not(.app__workspace--focus)").waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
    } finally {
      if (projectId) await apiRequest(page, `/api/projects/${projectId}`, { method: "DELETE" });
      await context.close();
    }
  });

  await scenario("ServerSettings separates administrative and member workspace catalogs", async () => {
    const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const outsiderContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const ownerPage = await ownerContext.newPage();
    const adminPage = await adminContext.newPage();
    const outsiderPage = await outsiderContext.newPage();
    let workspaceId = null;
    try {
      await ownerPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(ownerPage);
      await signIn(ownerPage, idp, owner);
      const createdWorkspace = await apiRequest(ownerPage, "/api/workspaces", {
        method: "POST", body: JSON.stringify({ name: "SEC-UX-1 Private Workspace" }),
      });
      if (createdWorkspace.status !== 201) throw new Error(`Private workspace creation failed: ${createdWorkspace.status}`);
      workspaceId = createdWorkspace.json.workspace.id;
      const createdProject = await apiRequest(ownerPage, "/api/projects", {
        method: "POST", body: JSON.stringify({ name: "Private Project", workspaceId }),
      });
      if (createdProject.status !== 201) throw new Error(`Private project creation failed: ${createdProject.status}`);

      await adminPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(adminPage);
      await signIn(adminPage, idp, platformAdmin);
      const adminMemberCatalog = await apiRequest(adminPage, "/api/workspaces");
      check("platform admin's ordinary workspace catalog excludes the private workspace", adminMemberCatalog.status === 200 && !adminMemberCatalog.json.workspaces.some((entry) => entry.id === workspaceId));
      const adminWorkspaceOptions = await adminPage.getByTestId("workspace-server-workspace-select").locator("option").allTextContents();
      check("global workspace selector excludes the private workspace", !adminWorkspaceOptions.some((name) => name.includes("SEC-UX-1 Private Workspace")), adminWorkspaceOptions.join(", "));
      const inaccessibleProjects = await apiRequest(adminPage, `/api/projects?workspaceId=${workspaceId}`);
      check("platform admin without membership receives 404 for private projects", inaccessibleProjects.status === 404);

      await adminPage.getByTestId("workspace-settings").click();
      await adminPage.getByTestId("workspace-settings-page").waitFor({ state: "visible" });
      const adminWorkspaceRail = await adminPage.locator(".settings-workspace-rail").innerText();
      check("workspace navigation in settings excludes the private workspace", !adminWorkspaceRail.includes("SEC-UX-1 Private Workspace"), adminWorkspaceRail);
      if (process.env.E2E_SCREENSHOT_DIR) {
        await mkdir(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
        await adminPage.screenshot({ path: join(process.env.E2E_SCREENSHOT_DIR, "sec-ux-1-admin-member-catalog.png"), fullPage: true });
      }

      await adminPage.getByTestId("settings-scope-platform").click();
      const policyLabel = "Allow authors to approve proposals in SEC-UX-1 Private Workspace";
      const policyControl = adminPage.getByLabel(policyLabel);
      await policyControl.waitFor({ state: "visible" });
      check("private workspace appears only in platform policy controls", await adminPage.locator(".settings-platform").innerText().then((text) => text.includes("SEC-UX-1 Private Workspace")) && !(await adminPage.locator(".settings-platform").innerText()).includes("VIEWER"));
      const policyRects = await adminPage.locator(".settings-user").evaluateAll((rows) => rows.map((row) => {
        const name = row.querySelector("strong")?.getBoundingClientRect();
        const control = row.querySelector("input")?.getBoundingClientRect();
        return { name: name && { right: name.right, top: name.top, bottom: name.bottom }, control: control && { left: control.left, top: control.top, bottom: control.bottom } };
      }));
      check("policy labels and controls do not overlap", policyRects.every(({ name, control }) => !name || !control || name.right <= control.left || name.bottom <= control.top || control.bottom <= name.top), JSON.stringify(policyRects));
      if (process.env.E2E_SCREENSHOT_DIR) await adminPage.screenshot({ path: join(process.env.E2E_SCREENSHOT_DIR, "sec-ux-1-admin-policy-catalog.png"), fullPage: true });
      const wasChecked = await policyControl.isChecked();
      const policyPatch = adminPage.waitForResponse((response) => response.url().includes(`/api/admin/workspaces/${workspaceId}/self-review`) && response.request().method() === "PATCH");
      await policyControl.click();
      check("platform administrator can update policy without workspace membership", (await policyPatch).status() === 204);
      const policyCatalog = await apiRequest(adminPage, "/api/admin/workspaces");
      const privatePolicy = policyCatalog.json.workspaces.find((entry) => entry.id === workspaceId);
      check("administrative catalog contains only minimal policy fields", JSON.stringify(Object.keys(privatePolicy ?? {}).sort()) === JSON.stringify(["allowAuthorSelfReview", "id", "name"]));
      check("policy update is reflected by the administrative catalog", privatePolicy?.allowAuthorSelfReview === !wasChecked);
      if (process.env.E2E_SCREENSHOT_DIR) await adminPage.screenshot({ path: join(process.env.E2E_SCREENSHOT_DIR, "sec-ux-1-admin-policy-updated.png"), fullPage: true });

      await outsiderPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(outsiderPage);
      await signIn(outsiderPage, idp, viewer);
      await outsiderPage.getByTestId("workspace-settings").click();
      await outsiderPage.getByTestId("workspace-settings-page").waitFor({ state: "visible" });
      const outsiderCatalog = await apiRequest(outsiderPage, "/api/workspaces");
      check("non-admin ordinary catalog contains only the outsider's memberships", outsiderCatalog.status === 200 && outsiderCatalog.json.workspaces.every((entry) => entry.id !== workspaceId));
      const outsiderWorkspaceOptions = await outsiderPage.getByTestId("workspace-server-workspace-select").locator("option").allTextContents();
      check("non-admin global selector contains only member workspaces", !outsiderWorkspaceOptions.some((name) => name.includes("SEC-UX-1 Private Workspace")), outsiderWorkspaceOptions.join(", "));
      check("non-admin cannot access administrative catalog", (await apiRequest(outsiderPage, "/api/admin/workspaces")).status === 403);
      check("non-admin settings expose no platform controls or foreign workspace", !(await outsiderPage.getByTestId("settings-scope-platform").count()) && !(await outsiderPage.locator(".settings-workspace-rail").innerText()).includes("SEC-UX-1 Private Workspace"));
      if (process.env.E2E_SCREENSHOT_DIR) await outsiderPage.screenshot({ path: join(process.env.E2E_SCREENSHOT_DIR, "sec-ux-1-nonadmin-member-catalog.png"), fullPage: true });
    } finally {
      if (workspaceId) await apiRequest(ownerPage, `/api/workspaces/${workspaceId}`, { method: "DELETE" });
      await ownerContext.close();
      await adminContext.close();
      await outsiderContext.close();
    }
  });

  await scenario("Workspace invitations preserve authentication and membership boundaries", async () => {
    const ownerContext = await browser.newContext();
    const adminContext = await browser.newContext();
    const recipientContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    const adminPage = await adminContext.newPage();
    const recipientPage = await recipientContext.newPage();
    const invitationWorkspaceIds = [];
    try {
      await ownerPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(ownerPage);
      await signIn(ownerPage, idp, owner);
      await adminPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(adminPage);
      await signIn(adminPage, idp, platformAdmin);
      const protectedWorkspace = await apiRequest(ownerPage, "/api/workspaces", {
        method: "POST", body: JSON.stringify({ name: "Protected Project Workspace" }),
      });
      invitationWorkspaceIds.push(protectedWorkspace.json.workspace.id);
      const projectResponse = await apiRequest(ownerPage, "/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Invite Boundary Project", workspaceId: protectedWorkspace.json.workspace.id }),
      });
      check("created a protected project for pre-acceptance access checks", projectResponse.status === 201, `${projectResponse.status} ${projectResponse.text}`);
      const ownedProject = projectResponse.json.project;
      const createInvitation = async (name, email) => {
        const workspaceResponse = await apiRequest(ownerPage, "/api/workspaces", {
          method: "POST", body: JSON.stringify({ name }),
        });
        check(`created invitation workspace ${name}`, workspaceResponse.status === 201);
        const workspaceId = workspaceResponse.json.workspace.id;
        invitationWorkspaceIds.push(workspaceId);
        const invitationResponse = await apiRequest(ownerPage, `/api/workspaces/${workspaceId}/invitations`, {
          method: "POST", body: JSON.stringify({ role: "VIEWER" }),
        });
        check(`created a VIEWER invitation for ${email}`, invitationResponse.status === 201);
        return { workspaceId, token: invitationResponse.json.token };
      };

      const oidcInvitation = await createInvitation("OIDC Invite Workspace", viewer.email);
      await recipientPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(recipientPage);
      await setNextIdentity(idp, viewer);
      await recipientPage.getByTestId("login-google").click();
      await recipientPage.waitForURL(url => url.pathname === "/", { timeout: UI_TIMEOUT_MS });
      const invitedOidcUser = (await apiRequest(adminPage, "/api/admin/users")).json.users.find(user => user.email === viewer.email);
      check("OIDC recipient follows the existing account approval policy", Boolean(invitedOidcUser));
      const activated = await apiRequest(adminPage, `/api/admin/users/${invitedOidcUser.id}`, {
        method: "PATCH", body: JSON.stringify({ status: "ACTIVE" }),
      });
      check("platform approval activates the existing OIDC account", activated.status === 200);
      await recipientPage.context().clearCookies();
      await recipientPage.goto(`${BASE_URL}/invite/${oidcInvitation.token}`, { waitUntil: "domcontentloaded" });
      await recipientPage.getByRole("heading", { name: "Join a workspace" }).waitFor({ timeout: UI_TIMEOUT_MS });
      check("invite route renders the focused landing without the full application", await recipientPage.locator('[data-testid="app-shell"]').count() === 0);
      check("invite preview identifies workspace and role", (await recipientPage.locator('[data-testid="invitation-page"]').textContent()).includes("OIDC Invite Workspace") && (await recipientPage.locator('[data-testid="invitation-page"]').textContent()).includes("VIEWER"));
      await setNextIdentity(idp, viewer);
      await recipientPage.getByTestId("login-google").click();
      await recipientPage.getByRole("button", { name: "Accept invitation" }).waitFor({ timeout: UI_TIMEOUT_MS });
      check("OIDC returns to the same invitation route", new URL(recipientPage.url()).pathname === `/invite/${oidcInvitation.token}`);
      const beforeAccept = await apiRequest(recipientPage, `/api/projects/${ownedProject.id}`);
      check("invitee cannot read an existing project before acceptance", beforeAccept.status === 404);
      await recipientPage.getByRole("button", { name: "Accept invitation" }).click();
      await recipientPage.locator('[data-testid="app-shell"]').waitFor({ timeout: UI_TIMEOUT_MS });
      await recipientPage.locator('[data-testid="workspace-server-projects-empty"]').waitFor({ timeout: UI_TIMEOUT_MS });
      check("invited workspace is selected and honestly shows no projects", await recipientPage.locator('[data-testid="workspace-server-workspace-select"]').inputValue() === oidcInvitation.workspaceId);
      const joinedProjects = await apiRequest(recipientPage, `/api/projects?workspaceId=${oidcInvitation.workspaceId}`);
      check("accepted workspace membership grants zero implicit project access", joinedProjects.status === 200 && joinedProjects.json.projects.length === 0);
      const reused = await apiRequest(recipientPage, "/api/invitations/accept", { method: "POST", body: JSON.stringify({ token: oidcInvitation.token }) });
      check("invitation is single use", reused.status === 404);

      const localInvitation = await createInvitation("Local Invite Workspace", "invitee@e2e.test");
      await recipientPage.context().clearCookies();
      await recipientPage.goto(`${BASE_URL}/invite/${localInvitation.token}`, { waitUntil: "domcontentloaded" });
      await recipientPage.getByRole("button", { name: "Create a local account" }).click();
      await recipientPage.getByTestId("login-display-name").fill("Local Invitee");
      await recipientPage.getByTestId("login-email").fill("invitee@e2e.test");
      await recipientPage.getByTestId("login-password").fill("Correct-Horse-Battery-9!");
      await recipientPage.getByRole("button", { name: "Create account" }).click();
      await recipientPage.getByTestId("login-message").waitFor({ timeout: UI_TIMEOUT_MS });
      check("registration uses the existing pending-approval workflow", (await recipientPage.getByTestId("login-message").textContent()).toLowerCase().includes("approval"));
      const users = await apiRequest(adminPage, "/api/admin/users");
      const localUser = users.json.users.find(user => user.email === "invitee@e2e.test");
      check("platform admin can find the registered invitee", Boolean(localUser));
      const approval = await apiRequest(adminPage, `/api/admin/users/${localUser.id}`, { method: "PATCH", body: JSON.stringify({ status: "ACTIVE" }) });
      check("existing account approval activates invitee", approval.status === 200);
      await recipientPage.getByRole("button", { name: "Use an existing account" }).click();
      await recipientPage.getByTestId("login-email").fill("invitee@e2e.test");
      await recipientPage.getByTestId("login-password").fill("Correct-Horse-Battery-9!");
      await recipientPage.getByRole("button", { name: "Sign in", exact: true }).click();
      await recipientPage.getByRole("button", { name: "Accept invitation" }).waitFor({ timeout: UI_TIMEOUT_MS });
      await recipientPage.getByRole("button", { name: "Accept invitation" }).click();
      await recipientPage.locator('[data-testid="app-shell"]').waitFor({ timeout: UI_TIMEOUT_MS });
      await recipientPage.locator('[data-testid="workspace-server-projects-empty"]').waitFor({ timeout: UI_TIMEOUT_MS });
      const localProjects = await apiRequest(recipientPage, `/api/projects?workspaceId=${localInvitation.workspaceId}`);
      check("local registration continuation accepts into a zero-project workspace", localProjects.status === 200 && localProjects.json.projects.length === 0);
    } finally {
      for (const workspaceId of invitationWorkspaceIds) {
        await apiRequest(ownerPage, `/api/workspaces/${workspaceId}`, { method: "DELETE" });
      }
      await ownerContext.close();
      await adminContext.close();
      await recipientContext.close();
    }
  });

  await scenario("Causal navigation keeps large graphs readable and stable", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const projectName = "Causal Navigation E2E";
    const programmedRecharge = [
      'title "Programmed Recharge"',
      "event RechargeRequested", "event BalanceLoaded", "event RechargeAuthorized", "event PaymentCaptured", "event RechargeCompleted", "event NotificationQueued", "event LedgerUpdated",
      "handler LoadBalance", "handler AuthorizeRecharge", "handler CapturePayment", "handler CompleteRecharge", "handler NotifyCustomer",
      "RechargeRequested handled by LoadBalance", "LoadBalance causes BalanceLoaded", "BalanceLoaded handled by AuthorizeRecharge", "AuthorizeRecharge causes RechargeAuthorized", "RechargeAuthorized handled by CapturePayment", "CapturePayment causes PaymentCaptured", "PaymentCaptured handled by CompleteRecharge", "CompleteRecharge causes RechargeCompleted", "RechargeCompleted handled by NotifyCustomer", "NotifyCustomer causes NotificationQueued", "CompleteRecharge causes LedgerUpdated", "LedgerUpdated handled by NotifyCustomer",
      "effect persist-recharge on CompleteRecharge: persist recharge", "effect audit-recharge on CompleteRecharge: append audit record", "failure capture-failed on handler CapturePayment", "retry capture-again for capture-failed {", "  mechanism: handler", "  target: same-execution", "}",
    ].join("\n");
    const smallCausal = [
      'title "Small Causal Fixture"', "event Input", "event Output", "handler Persist", "Input handled by Persist", "Persist causes Output", "effect save on Persist: save state",
    ].join("\n");
    const fanOutSource = [
      'title "Fan-out Causal Fixture"', "event UpOneTransactionRaisedEvent", "event SaveUpOneTransactionCommand", "event AddAccountCommand", "event AddCorporateAccountCommand",
      "handler TransactionsHandler", "handler AccountsHandler", "UpOneTransactionRaisedEvent handled by TransactionsHandler", "UpOneTransactionRaisedEvent handled by AccountsHandler",
      "TransactionsHandler causes SaveUpOneTransactionCommand", "AccountsHandler causes AddAccountCommand", "AccountsHandler causes AddCorporateAccountCommand",
      "effect save-transaction on TransactionsHandler: save transaction", "effect update-account on AccountsHandler: update account",
    ].join("\n");
    let projectId = null;
    const capture = async (name) => {
      if (process.env.E2E_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.E2E_SCREENSHOT_DIR, `gate95c-${name}.png`) });
    };
    const measure = () => page.evaluate(() => {
      const flow = document.querySelector(".causal-flow .react-flow");
      const viewport = flow?.querySelector(".react-flow__viewport");
      if (!flow || !viewport) return null;
      const bounds = flow.getBoundingClientRect();
      const matrix = new DOMMatrix(getComputedStyle(viewport).transform);
      const nodes = [...flow.querySelectorAll(".react-flow__node")];
      const nodeRects = nodes.map((node) => node.getBoundingClientRect());
      const labels = nodes[0]?.querySelector(".causal-node__label");
      const fontSize = labels ? Number.parseFloat(getComputedStyle(labels).fontSize) : 0;
      return {
        width: bounds.width,
        height: bounds.height,
        zoom: matrix.a,
        x: matrix.e,
        y: matrix.f,
        fontSize,
        apparentFontSize: fontSize * matrix.a,
        nodes: nodes.length,
        graph: nodeRects.length ? {
          left: Math.min(...nodeRects.map((rect) => rect.left)) - bounds.left,
          right: Math.max(...nodeRects.map((rect) => rect.right)) - bounds.left,
          top: Math.min(...nodeRects.map((rect) => rect.top)) - bounds.top,
          bottom: Math.max(...nodeRects.map((rect) => rect.bottom)) - bounds.top,
        } : null,
      };
    });
    const withinViewport = (metrics) => metrics?.graph && metrics.graph.left >= -1 && metrics.graph.top >= -1 && metrics.graph.right <= metrics.width + 1 && metrics.graph.bottom <= metrics.height + 1;
    const center = (metrics) => ({ x: (metrics.width / 2 - metrics.x) / metrics.zoom, y: (metrics.height / 2 - metrics.y) / metrics.zoom });

    try {
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(page);
      await signIn(page, idp, owner);
      const workspaceId = (await apiRequest(page, "/api/workspaces")).json.workspaces[0].id;
      const created = await apiRequest(page, "/api/projects/bootstrap", { method: "POST", body: JSON.stringify({
        workspaceId,
        name: projectName,
        resources: [
          { path: "programmed.eventseq", type: "event-flow", content: programmedRecharge },
          { path: "small.eventseq", type: "event-flow", content: smallCausal },
          { path: "fanout.eventseq", type: "event-flow", content: fanOutSource },
        ],
      }) });
      if (created.status !== 201) throw new Error(`Causal navigation project bootstrap failed: ${created.status} ${created.text}`);
      projectId = created.json.project.id;
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAuthEntry(page);
      await openServerProject(page, projectName);
      await page.getByRole("button", { name: "Load diagram Programmed Recharge" }).click();
      await page.getByTestId("event-flow-preview").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByTestId("event-flow-preview").getByRole("button", { name: "Flow", exact: true }).click();
      await page.getByTestId("event-flow-preview").getByRole("button", { name: "Causal", exact: true }).click();
      await page.locator(".causal-flow .react-flow__node").first().waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.waitForFunction(() => {
        const transform = getComputedStyle(document.querySelector(".causal-flow .react-flow__viewport")).transform;
        return transform !== "none" && new DOMMatrix(transform).a >= 0.8;
      });

      let initial = await measure();
      check("Programmed Recharge starts at a legible scale without fitting the full wide graph", initial.zoom >= 0.8 && initial.apparentFontSize >= 10 && initial.graph.right - initial.graph.left > initial.width, `viewport=${initial.width}x${initial.height}; zoom=${initial.zoom}; label=${initial.apparentFontSize.toFixed(2)}px; graphWidth=${(initial.graph.right - initial.graph.left).toFixed(1)}px`);
      if (process.env.E2E_SCREENSHOT_DIR) {
        await mkdir(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.E2E_SCREENSHOT_DIR, "ux-2a-causal-normal.png"), fullPage: true });
      }
      await capture("programmed-initial");

      const flowBounds = await page.locator(".causal-flow .react-flow").boundingBox();
      if (!flowBounds) throw new Error("Causal preview viewport has no browser bounds");
      await page.mouse.move(flowBounds.x + 100, flowBounds.y + 180);
      await page.mouse.down();
      await page.mouse.move(flowBounds.x + 150, flowBounds.y + 200);
      await page.mouse.up();
      const readingFocus = await measure();
      const readingFocusCenter = center(readingFocus);
      check("causal viewport can pan to a region of interest", readingFocus.x !== initial.x || readingFocus.y !== initial.y, `transform ${initial.x}/${initial.y} -> ${readingFocus.x}/${readingFocus.y}`);
      await capture("programmed-region-of-interest");

      const overviewButton = page.getByRole("button", { name: "Show full graph overview" });
      await overviewButton.focus();
      check("overview action has keyboard focus", await overviewButton.evaluate((button) => document.activeElement === button));
      await page.keyboard.press("Space");
      await page.waitForFunction(() => {
        const transform = getComputedStyle(document.querySelector(".causal-flow .react-flow__viewport")).transform;
        return transform !== "none" && new DOMMatrix(transform).a < 0.8;
      });
      const overview = await measure();
      check("overview fits the complete causal graph", withinViewport(overview), `zoom=${overview.zoom}; bounds=${JSON.stringify(overview.graph)}`);
      await capture("programmed-overview");

      const readingButton = page.getByRole("button", { name: "Restore reading scale" });
      await readingButton.focus();
      await page.keyboard.press("Space");
      await page.waitForFunction(() => {
        const transform = getComputedStyle(document.querySelector(".causal-flow .react-flow__viewport")).transform;
        return transform !== "none" && Math.abs(new DOMMatrix(transform).a - 1) < 0.01;
      });
      await page.waitForTimeout(250);
      const reading = await measure();
      const readingCenter = center(reading);
      check("reading view restores 1:1 labels while preserving the prior region of interest", reading.zoom >= 0.99 && Math.hypot(readingCenter.x - readingFocusCenter.x, readingCenter.y - readingFocusCenter.y) < 2, `zoom=${reading.zoom}; center drift=${Math.hypot(readingCenter.x - readingFocusCenter.x, readingCenter.y - readingFocusCenter.y).toFixed(3)} flow px`);
      await capture("programmed-reading");

      const visibleNode = await page.locator(".causal-flow .react-flow__node").evaluateAll((nodes) => {
        const flowElement = document.querySelector(".causal-flow .react-flow");
        if (!flowElement) return null;
        const flow = flowElement.getBoundingClientRect();
        const rect = nodes.map((node) => node.getBoundingClientRect()).find((item) => item.left >= flow.left && item.right <= flow.right && item.top >= flow.top && item.bottom <= flow.bottom);
        return rect ? { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 } : null;
      });
      if (!visibleNode) throw new Error("No causal node is fully visible at reading scale");
      await page.mouse.click(visibleNode.x, visibleNode.y);
      await page.waitForFunction(() => [...document.querySelectorAll(".causal-flow .react-flow__node")].some((node) => node.classList.contains("selected")));
      const selected = await measure();
      check("selecting a causal node does not move the viewport", selected.zoom === reading.zoom && selected.x === reading.x && selected.y === reading.y, `before=${reading.zoom}/${reading.x}/${reading.y}; after=${selected.zoom}/${selected.x}/${selected.y}`);
      await capture("programmed-selected");

      const causalViewport = page.locator(".causal-flow .react-flow__viewport");
      const causalViewportNode = await causalViewport.elementHandle();
      if (!causalViewportNode) throw new Error("Causal React Flow viewport was detached before focus mode.");
      const causalCameraBeforeFocus = await causalViewportNode.getAttribute("style");
      const focusButton = page.getByTestId("viewer-focus-toggle");
      await focusButton.click();
      await page.locator(".app__workspace--focus").waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
      await page.waitForFunction((style) => document.querySelector(".causal-flow .react-flow__viewport")?.getAttribute("style") !== style, causalCameraBeforeFocus);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const causalCameraAtFocus = await causalViewportNode.getAttribute("style");
      const flowWidthBeforeResize = await page.locator(".causal-flow .react-flow").evaluate(element => element.clientWidth);
      const selectedBeforeFocus = await page.locator(".causal-flow .react-flow__node.selected").count();
      check("causal React Flow remains the same mounted instance in focus mode", await causalViewportNode.evaluate((element) => element.isConnected));
      if (process.env.E2E_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.E2E_SCREENSHOT_DIR, "ux-2a-causal-focus.png"), fullPage: true });

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.waitForFunction((width) => document.querySelector(".causal-flow .react-flow")?.clientWidth !== width, flowWidthBeforeResize);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      check("causal React Flow resize does not trigger implicit fitView", await causalViewportNode.getAttribute("style") === causalCameraAtFocus, `before=${causalCameraAtFocus}; after=${await causalViewportNode.getAttribute("style")}`);
      check("causal node selection survives focus and resize", selectedBeforeFocus === 1 && await page.locator(".causal-flow .react-flow__node.selected").count() === 1);
      await page.keyboard.press("Escape");
      await page.locator(".app__workspace:not(.app__workspace--focus)").waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
      const restoredCausal = await measure();
      check("causal zoom and pan survive focus exit", restoredCausal.zoom === selected.zoom && restoredCausal.x === selected.x && restoredCausal.y === selected.y);
      check("causal focus exit restores keyboard focus to its control", await focusButton.evaluate((button) => document.activeElement === button));
      check("causal focus exit restores the workspace panels", await page.locator('[data-testid="explorer-shared-section"]').isVisible());

      await page.locator(".app__workspace:not(.app__workspace--focus)").waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
      let afterEscape = await measure();
      check("Escape restores workspace panels without resetting the causal viewport", afterEscape.zoom === selected.zoom && afterEscape.x === selected.x && afterEscape.y === selected.y);
      await page.locator(".causal-flow .react-flow__pane").click({ position: { x: 400, y: Math.max(20, afterEscape.height - 20) } });
      await page.waitForFunction(() => ![...document.querySelectorAll(".causal-flow .react-flow__node")].some((node) => node.classList.contains("selected")));
      const deselected = await measure();
      check("deselection does not move the causal viewport", deselected.zoom === afterEscape.zoom && deselected.x === afterEscape.x && deselected.y === afterEscape.y);
      await capture("programmed-deselected");

      const showEditor = page.getByRole("button", { name: "Show editor" });
      if (await showEditor.count()) await showEditor.click();
      const splitter = page.getByRole("separator", { name: "Resize editor" });
      await splitter.focus();
      await page.keyboard.press("ArrowRight");
      const resized = await measure();
      check("resizing the editor panel leaves the causal viewport transform unchanged", resized.zoom === deselected.zoom && resized.x === deselected.x && resized.y === deselected.y, `viewport width ${deselected.width} -> ${resized.width}`);
      await capture("programmed-resized");

      const secondPage = await context.newPage();
      await secondPage.goto("about:blank");
      await page.bringToFront();
      const refocused = await measure();
      check("temporarily changing application focus leaves the causal viewport unchanged", refocused.zoom === resized.zoom && refocused.x === resized.x && refocused.y === resized.y);
      await secondPage.close();

      await page.getByRole("button", { name: "Load diagram Small Causal Fixture" }).click();
      await page.waitForFunction(() => document.querySelectorAll(".causal-flow .react-flow__node").length === 4);
      const small = await measure();
      check("a small causal graph uses a readable full-graph initial fit", small.zoom >= 0.8 && small.zoom <= 1 && withinViewport(small), `viewport=${small.width}x${small.height}; zoom=${small.zoom}; label=${small.apparentFontSize.toFixed(2)}px; graph=${(small.graph.right - small.graph.left).toFixed(1)}x${(small.graph.bottom - small.graph.top).toFixed(1)}px`);
      await capture("small-initial");

      await page.getByRole("button", { name: "Zoom in" }).click();
      const zoomedSmall = await measure();
      await page.getByRole("button", { name: "Load diagram Fan-out Causal Fixture" }).click();
      await page.waitForFunction(() => document.querySelectorAll(".causal-flow .react-flow__node").length === 8);
      const fanOutMetrics = await measure();
      check("changing graph identity reinitializes fit instead of retaining the prior zoom", fanOutMetrics.zoom >= 0.8 && fanOutMetrics.zoom <= 1 && withinViewport(fanOutMetrics) && fanOutMetrics.zoom !== zoomedSmall.zoom, `viewport=${fanOutMetrics.width}x${fanOutMetrics.height}; prior=${zoomedSmall.zoom}; new=${fanOutMetrics.zoom}; label=${fanOutMetrics.apparentFontSize.toFixed(2)}px; graph=${(fanOutMetrics.graph.right - fanOutMetrics.graph.left).toFixed(1)}x${(fanOutMetrics.graph.bottom - fanOutMetrics.graph.top).toFixed(1)}px`);
      await capture("fanout-initial");
    } finally {
      if (projectId) await apiRequest(page, `/api/projects/${projectId}`, { method: "DELETE" });
      await context.close();
    }
  });

  await scenario("Project shares provide a governed anonymous read-only reader", async () => {
    const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, permissions: ["clipboard-read", "clipboard-write"] });
    const anonymousContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const authenticatedContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const ownerPage = await ownerContext.newPage();
    const anonymousPage = await anonymousContext.newPage();
    const authenticatedPage = await authenticatedContext.newPage();
    let projectId = null;
    let workspaceId = null;
    let shareUrl = null;
    let secondShareUrl = null;
    try {
      await ownerPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(ownerPage);
      await signIn(ownerPage, idp, owner);
      workspaceId = (await apiRequest(ownerPage, "/api/workspaces")).json.workspaces[0].id;
      const created = await apiRequest(ownerPage, "/api/projects/bootstrap", {
        method: "POST",
        body: JSON.stringify({
          workspaceId,
          name: "Governed Share E2E",
          resources: [
            { path: "overview.md", type: "markdown-document", content: "# Shared overview\n\n[Architecture](architecture.seq)" },
            { path: "architecture.concept", type: "conceptual", content: 'title "Customer model"\nconcept customer "Customer"\nconcept order "Order"\nrelation places customer -> order "places"' },
            { path: "architecture.seq", type: "sequence-diagram", content: "title Shared architecture\nparticipant Browser\nparticipant API\nBrowser->API: request\nnote right of API : authenticated request" },
            { path: "events.eventseq", type: "event-flow", content: [
              'title "Programmed Recharge Lifecycle Causal Flow"',
              "event RechargeRequested", "event BalanceLoaded", "event RechargeAuthorized", "event PaymentCaptured", "event RechargeCompleted", "event NotificationQueued", "event LedgerUpdated",
              "handler LoadBalance", "handler AuthorizeRecharge", "handler CapturePayment", "handler CompleteRecharge", "handler NotifyCustomer",
              "RechargeRequested handled by LoadBalance", "LoadBalance causes BalanceLoaded", "BalanceLoaded handled by AuthorizeRecharge", "AuthorizeRecharge causes RechargeAuthorized", "RechargeAuthorized handled by CapturePayment", "CapturePayment causes PaymentCaptured", "PaymentCaptured handled by CompleteRecharge", "CompleteRecharge causes RechargeCompleted", "RechargeCompleted handled by NotifyCustomer", "NotifyCustomer causes NotificationQueued", "CompleteRecharge causes LedgerUpdated", "LedgerUpdated handled by NotifyCustomer",
              "effect persist-recharge on CompleteRecharge: persist recharge", "effect audit-recharge on CompleteRecharge: append audit record", "failure capture-failed on handler CapturePayment", "retry capture-again for capture-failed {", "  mechanism: handler", "  target: same-execution", "}",
            ].join("\n") },
            { path: "internal.dbschema", type: "database", content: 'title "Internal schema"\ntable users - "users"\ncolumn users user_id "id" {uuid} not-null\nprimary-key users_pk users (id)' },
          ],
        }),
      });
      check("C.4 bootstrap creates the real shared project fixture", created.status === 201, `${created.status}`);
      projectId = created.json.project.id;
      await ownerPage.reload({ waitUntil: "domcontentloaded" });
      await waitForAuthEntry(ownerPage);
      await openServerProject(ownerPage, "Governed Share E2E");
      await ownerPage.getByTestId("workspace-share-project").click();
      await ownerPage.getByRole("dialog", { name: "Share project" }).waitFor({ state: "visible" });
      await ownerPage.getByRole("button", { name: "Create read-only link" }).click();
      const linkInput = ownerPage.getByLabel("Read-only link");
      await linkInput.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      shareUrl = await linkInput.inputValue();
      await ownerPage.getByRole("button", { name: "Copy link" }).click();
      check("owner creates, copies, and sees an active C.4 share", await ownerPage.evaluate(() => navigator.clipboard.readText()) === shareUrl && await ownerPage.getByText("Active", { exact: true }).count() === 1);
      await ownerPage.getByRole("button", { name: "Close share management" }).click();
      await ownerPage.getByRole("button", { name: "Load diagram Programmed Recharge Lifecycle Causal Flow" }).click();
      await ownerPage.getByTestId("event-flow-preview").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await ownerPage.getByTestId("event-flow-preview").getByRole("button", { name: "Causal", exact: true }).click();
      const editorCausalNode = ownerPage.locator(".causal-flow .react-flow__node").first();
      await editorCausalNode.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("authenticated editor displays explicit causal nodes", (await editorCausalNode.boundingBox())?.width > 0);
      await showEditor(ownerPage);
      const editorHeader = ownerPage.getByTestId("resource-header");
      const contextParam = new URL(ownerPage.url()).searchParams.get("context");
      const headerCount = await editorHeader.count();
      const headerVisible = headerCount === 1 && await editorHeader.isVisible();
      const toolbarRepresentations = [
        ["Sequence", ownerPage.getByRole("button", { name: "Load diagram Shared architecture" })],
        ["Conceptual", ownerPage.getByRole("button", { name: "Load diagram Customer model" })],
        ["Database", ownerPage.getByRole("button", { name: "Load diagram Internal schema" })],
        ["Markdown", ownerPage.getByRole("button", { name: "Open note Shared overview" })],
      ];
      for (const [representation, resourceButton] of toolbarRepresentations) {
        await resourceButton.click();
        const sharedToolbarPresent = ownerPage.getByTestId("viewer-present-toggle");
        await sharedToolbarPresent.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        check(`${representation} exposes Present beside Focus and Fullscreen`, await sharedToolbarPresent.isVisible() && await ownerPage.getByTestId("viewer-focus-toggle").isVisible() && await ownerPage.getByTestId("viewer-fullscreen-toggle").isVisible());
      }
      await ownerPage.getByRole("button", { name: "Load diagram Programmed Recharge Lifecycle Causal Flow" }).click();
      await ownerPage.getByTestId("event-flow-preview").getByRole("button", { name: "Causal", exact: true }).click();
      const causalToolbarPresent = ownerPage.getByTestId("viewer-present-toggle");
      await causalToolbarPresent.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("Causal React Flow exposes Present beside Focus and Fullscreen", await causalToolbarPresent.isVisible() && await ownerPage.getByTestId("viewer-focus-toggle").isVisible() && await ownerPage.getByTestId("viewer-fullscreen-toggle").isVisible());
      const presentButton = ownerPage.getByTestId("viewer-present-toggle");
      const presentButtonCount = await presentButton.count();
      check("authenticated Event Flow remains in SHARED context", contextParam === null, `context=${contextParam ?? "SHARED"}`);
      check("authenticated Event Flow resource header is visible", headerVisible, `headers=${headerCount}`);
      check("Present is available for the selected SHARED resource", presentButtonCount === 1, `buttons=${presentButtonCount}`);
      check("Present is absent from the editor header", await editorHeader.getByRole("button", { name: "Present", exact: true }).count() === 0);
      if (presentButtonCount === 1) {
        if (process.env.E2E_SCREENSHOT_DIR) {
          await mkdir(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
          await ownerPage.screenshot({ path: join(process.env.E2E_SCREENSHOT_DIR, "ux-2c-present-event-flow-toolbar.png"), fullPage: true });
        }
        await presentButton.click();
        await ownerPage.getByTestId("presentation-mode").waitFor({ state: "visible" });
        const presentationCausalNode = ownerPage.locator(".causal-flow .react-flow__node").first();
        await presentationCausalNode.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        const presentationCausalBox = await presentationCausalNode.boundingBox();
        check("authenticated Presentation displays explicit causal nodes", presentationCausalBox !== null && presentationCausalBox.width > 0 && presentationCausalBox.height > 0);
        await ownerPage.getByRole("button", { name: /Exit presentation/ }).click();
        await ownerPage.getByTestId("app-shell").waitFor({ state: "visible" });
      }
      await ownerPage.getByTestId("workspace-share-project").click();
      await ownerPage.getByRole("button", { name: "Create read-only link" }).click();
      secondShareUrl = await ownerPage.getByLabel("Read-only link").inputValue();
      await ownerPage.getByText("Active", { exact: true }).nth(1).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("a project can hold multiple independently active share grants", secondShareUrl !== shareUrl && await ownerPage.getByText("Active", { exact: true }).count() === 2);

      await anonymousPage.goto(shareUrl, { waitUntil: "domcontentloaded" });
      await anonymousPage.getByTestId("public-reader").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("anonymous public shell exposes no private controls", await anonymousPage.locator('[data-testid="app-shell"], [data-testid*="my-work"], [data-testid*="proposal"]').count() === 0 && await anonymousPage.getByRole("button", { name: /edit|governance|workspace/i }).count() === 0);
       await anonymousPage.getByRole("link", { name: "Architecture" }).click();
       await anonymousPage.getByTestId("preview-svg").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await anonymousPage.getByRole("button", { name: "How to read Sequence" }).click();
       await anonymousPage.getByRole("heading", { name: "How to read Sequence" }).waitFor({ state: "visible" });
       check("public reader navigates Markdown and renders canonical Sequence with opt-in guidance", true);
       const conceptualNavigation = anonymousPage.getByRole("button", { name: "Customer model" });
       check("public navigation exposes Database within the Share projection", await conceptualNavigation.count() === 1 && await anonymousPage.getByRole("button", { name: "Internal schema" }).count() === 1);
       await anonymousPage.getByRole("button", { name: "Internal schema" }).click();
       await anonymousPage.getByTestId("database-preview-svg").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await anonymousPage.getByRole("button", { name: "How to read Database Diagram" }).click();
       await anonymousPage.getByRole("heading", { name: "How to read Database Diagram" }).waitFor({ state: "visible" });
       check("public reader renders Database with canonical notation guidance", await anonymousPage.getByTestId("database-preview-svg").locator("svg").getAttribute("aria-label") === "Database Diagram");
        await conceptualNavigation.click();
       await anonymousPage.getByTestId("conceptual-preview-svg").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await anonymousPage.getByRole("button", { name: "How to read Conceptual" }).click();
       await anonymousPage.getByRole("heading", { name: "How to read Conceptual" }).waitFor({ state: "visible" });
       check("public reader renders Conceptual through its canonical visual preview", true);
       await anonymousPage.getByRole("button", { name: "Present", exact: true }).click();
       await anonymousPage.getByTestId("presentation-mode").waitFor({ state: "visible" });
       check("public presentation starts with Overview and carries refresh-safe selection", anonymousPage.url().includes("presentation=1") && anonymousPage.url().includes("resource="));
        await anonymousPage.reload({ waitUntil: "domcontentloaded" });
        await anonymousPage.getByTestId("presentation-mode").waitFor({ state: "visible" });
        await anonymousPage.getByTestId("conceptual-preview-svg").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        check("public presentation renders Conceptual after refresh", true);
        await anonymousPage.getByRole("button", { name: "Architecture", exact: true }).click();
        const presentationNavigator = anonymousPage.getByRole("navigation", { name: "Presentation resources" });
        const closeNavigator = presentationNavigator.getByRole("button", { name: "Close navigator" });
        const closeBox = await closeNavigator.boundingBox();
        const navigatorBox = await presentationNavigator.boundingBox();
        check("presentation navigator close control is compact and top-right", closeBox !== null && navigatorBox !== null && closeBox.width <= 40 && Math.abs(closeBox.x + closeBox.width - navigatorBox.x - navigatorBox.width) <= 20);
        await closeNavigator.click();
        await anonymousPage.getByRole("button", { name: "Architecture", exact: true }).click();
        await anonymousPage.getByRole("navigation", { name: "Presentation resources" }).getByRole("button", { name: "Internal schema" }).click();
        await anonymousPage.getByTestId("database-preview-svg").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await anonymousPage.getByRole("button", { name: "How to read Database Diagram" }).click();
        await anonymousPage.getByRole("heading", { name: "How to read Database Diagram" }).waitFor({ state: "visible" });
        await anonymousPage.reload({ waitUntil: "domcontentloaded" });
        await anonymousPage.getByTestId("database-preview-svg").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        check("public Database Presentation renders canonical output and survives refresh", anonymousPage.url().includes("resource=") && anonymousPage.url().includes("presentation=1"));
        await anonymousPage.getByRole("button", { name: "Architecture", exact: true }).click();
        await anonymousPage.getByRole("navigation", { name: "Presentation resources" }).getByRole("button", { name: "Customer model" }).click();
        await anonymousPage.getByTestId("conceptual-preview-svg").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        check("presentation navigator stays open after selecting a resource", await anonymousPage.getByRole("navigation", { name: "Presentation resources" }).count() === 1);
        await anonymousPage.getByRole("button", { name: "Next presentation item" }).click();
        await anonymousPage.getByTestId("preview-svg").waitFor({ state: "visible" });
        const notesBox = await anonymousPage.getByTestId("preview-notes").boundingBox();
        const sequenceGuidanceBox = await anonymousPage.getByRole("button", { name: "How to read Sequence" }).boundingBox();
        check("Sequence guidance control does not overlap note controls in Presentation", notesBox !== null && sequenceGuidanceBox !== null && (sequenceGuidanceBox.x + sequenceGuidanceBox.width <= notesBox.x || notesBox.x + notesBox.width <= sequenceGuidanceBox.x || sequenceGuidanceBox.y + sequenceGuidanceBox.height <= notesBox.y || notesBox.y + notesBox.height <= sequenceGuidanceBox.y));
        await anonymousPage.getByRole("button", { name: "Next presentation item" }).click();
        await anonymousPage.getByTestId("event-flow-preview").waitFor({ state: "visible" });
        await anonymousPage.getByTestId("event-flow-preview").getByRole("button", { name: "Causal", exact: true }).click();
        const causalNode = anonymousPage.locator(".causal-flow .react-flow__node").first();
        await causalNode.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        const causalNodeBox = await causalNode.boundingBox();
        check("public Presentation paints the explicit Programmed Recharge causal graph", await anonymousPage.locator(".causal-flow .react-flow__node").count() >= 2 && causalNodeBox !== null && causalNodeBox.width > 0 && causalNodeBox.height > 0);
       check("public presentation navigates canonical resources and survives refresh", anonymousPage.url().includes("resource="));
      await anonymousPage.goBack();
      await anonymousPage.getByTestId("public-reader").waitFor({ state: "visible" });
      check("browser Back exits presentation to the public reader", !anonymousPage.url().includes("presentation=1"));
      await anonymousPage.getByRole("button", { name: "Programmed Recharge Lifecycle Causal Flow" }).click();
      await anonymousPage.getByTestId("event-flow-preview").waitFor({ state: "visible" });
      await anonymousPage.getByRole("button", { name: "Topology" }).click();
      await anonymousPage.getByTestId("event-topology").waitFor({ state: "visible" });
       await anonymousPage.getByTestId("event-flow-preview").getByRole("button", { name: "Causal" }).click();
       await anonymousPage.locator(".causal-flow .react-flow__node").first().waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await anonymousPage.getByRole("button", { name: "Catalog" }).click();
      await anonymousPage.getByTestId("event-catalog").waitFor({ state: "visible" });
      check("public Event Flow exposes canonical Topology, Causal, and Catalog views", true);

      const beforeUsers = (await apiRequest(e2ePlatformAdminPage, "/api/admin/users")).json.users.length;
      const beforeMembers = (await apiRequest(ownerPage, `/api/workspaces/${workspaceId}/members`)).json.members.length;
      await authenticatedPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(authenticatedPage);
      await signIn(authenticatedPage, idp, owner);
      await authenticatedPage.goto(shareUrl, { waitUntil: "domcontentloaded" });
      await authenticatedPage.getByTestId("public-reader").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("authenticated recipient still gets only public reader", await authenticatedPage.locator('[data-testid="app-shell"]').count() === 0 && await authenticatedPage.getByRole("heading", { name: "Governed Share E2E" }).count() === 1);
      check("anonymous retrieval creates no user or workspace membership", (await apiRequest(e2ePlatformAdminPage, "/api/admin/users")).json.users.length === beforeUsers && (await apiRequest(ownerPage, `/api/workspaces/${workspaceId}/members`)).json.members.length === beforeMembers);

      await ownerPage.getByRole("button", { name: "Close share management" }).click();
      await ownerPage.getByTestId("workspace-share-project").click();
      await ownerPage.getByRole("button", { name: "Revoke" }).first().click();
      await ownerPage.getByRole("button", { name: "Revoke link" }).click();
      await ownerPage.getByText("Revoked", { exact: true }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await anonymousPage.goto(secondShareUrl, { waitUntil: "domcontentloaded" });
      await anonymousPage.getByText("This shared project is no longer available.").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await authenticatedPage.goto(shareUrl, { waitUntil: "domcontentloaded" });
      await authenticatedPage.getByTestId("public-reader").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("revoking one link updates management, blocks next retrieval, and preserves the other grant", true);
    } finally {
      if (projectId) await apiRequest(ownerPage, `/api/projects/${projectId}`, { method: "DELETE" });
      await ownerContext.close();
      await anonymousContext.close();
      await authenticatedContext.close();
    }
  });

  await scenario("SHARED navigation selects the clicked artifact", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    let projectId = null;
    try {
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(page);
      await signIn(page, idp, owner);
      const workspaceId = (await apiRequest(page, "/api/workspaces")).json.workspaces[0].id;
      const created = await apiRequest(page, "/api/projects/bootstrap", {
        method: "POST",
        body: JSON.stringify({
          workspaceId,
          name: "Shared Navigation E2E",
          resources: [
            { path: "first.seq", type: "sequence-diagram", content: "title First artifact\nparticipant A\nparticipant B\nA->B: first" },
            { path: "second.seq", type: "sequence-diagram", content: "title Second artifact\nparticipant A\nparticipant B\nA->B: second" },
          ],
        }),
      });
      projectId = created.json.project.id;
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAuthEntry(page);
      await openServerProject(page, "Shared Navigation E2E");
      const first = page.getByRole("button", { name: "Load diagram First artifact" });
      const second = page.getByRole("button", { name: "Load diagram Second artifact" });
      await first.click();
      await second.click();
      check("the clicked SHARED row becomes the selected artifact", (await second.locator("xpath=..").getAttribute("class"))?.includes("explorer__resource--selected") === true);
      await page.getByRole("button", { name: "Show editor" }).click();
      const presentButton = page.getByTestId("viewer-present-toggle");
      check("Present shares the viewer toolbar with Focus and Fullscreen", await presentButton.isVisible() && await page.getByTestId("viewer-focus-toggle").isVisible() && await page.getByTestId("viewer-fullscreen-toggle").isVisible());
      check("Present is absent from the editor header", await page.locator('[data-testid="resource-header"] button').filter({ hasText: "Present" }).count() === 0);
      if (process.env.E2E_SCREENSHOT_DIR) {
        await mkdir(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.E2E_SCREENSHOT_DIR, "ux-2c-present-viewer-toolbar.png"), fullPage: true });
      }
      await presentButton.click();
      await page.getByTestId("presentation-mode").waitFor({ state: "visible" });
      check("authenticated presentation opens only from the authoritative SHARED selection", (await page.locator(".presentation__stage").getAttribute("aria-label"))?.startsWith("Second artifact") === true);
      await page.keyboard.press("Escape");
      await page.getByTestId("app-shell").waitFor({ state: "visible" });
      check("authenticated Escape exits without changing the selected SHARED artifact", (await second.locator("xpath=..").getAttribute("class"))?.includes("explorer__resource--selected") === true);
    } finally {
      if (projectId) await apiRequest(page, `/api/projects/${projectId}`, { method: "DELETE" });
      await context.close();
    }
  });

  await scenario("Server scenario 8: Architecture Inbox cross-workspace navigation is stable", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    let sourceProjectId = null;
    let sameWorkspaceProjectId = null;
    let destinationProjectId = null;
    let destinationWorkspaceId = null;
    const sourceAccessCount = { value: 0 };
    const targetAccessCount = { value: 0 };
    const sameWorkspaceAccessCount = { value: 0 };
    const catalogStatuses = [];
    const browserErrors = [];
    try {
      await page.addInitScript(() => {
        const writes = [];
        for (const method of ["pushState", "replaceState"]) {
          const original = history[method].bind(history);
          history[method] = (...args) => {
            const result = original(...args);
            writes.push({ url: `${location.pathname}${location.search}` });
            return result;
          };
        }
        Object.defineProperty(window, "__inboxHistoryWrites", { value: writes });
      });
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(page);
      await signIn(page, idp, owner);

      const sourceWorkspace = (await apiRequest(page, "/api/workspaces")).json?.workspaces?.[0];
      if (!sourceWorkspace) throw new Error("the authenticated workspace catalog was empty");
      const createProject = async (workspaceId, name) => {
        const response = await apiRequest(page, "/api/projects", {
          method: "POST",
          body: JSON.stringify({ workspaceId, name }),
        });
        if (response.status !== 201) throw new Error(`project setup failed (${response.status}): ${response.text}`);
        return response.json.project;
      };
      const sourceProject = await createProject(sourceWorkspace.id, "Inbox navigation source");
      sourceProjectId = sourceProject.id;
      const sameWorkspaceProject = await createProject(sourceWorkspace.id, "Inbox same-workspace project");
      sameWorkspaceProjectId = sameWorkspaceProject.id;
      const sameWorkspace = await apiRequest(page, `/api/projects/${sameWorkspaceProjectId}/private-work`, { method: "POST", body: JSON.stringify({ name: "Same workspace proposal draft" }) });
      if (sameWorkspace.status !== 201) throw new Error(`same-workspace proposal context setup failed (${sameWorkspace.status}): ${sameWorkspace.text}`);
      const sameWorkspaceResource = await apiRequest(page, `/api/projects/${sameWorkspaceProjectId}/resources`, {
        method: "POST",
        body: JSON.stringify({ contextId: sameWorkspace.json.context.id, path: "same-workspace-proposal.seq", type: "sequence-diagram", content: "title Same workspace proposal\nparticipant Browser\n" }),
      });
      if (sameWorkspaceResource.status !== 201) throw new Error(`same-workspace proposal resource setup failed (${sameWorkspaceResource.status}): ${sameWorkspaceResource.text}`);
      const sameWorkspaceProposal = await apiRequest(page, `/api/projects/${sameWorkspaceProjectId}/architectural-proposals`, {
        method: "POST",
        body: JSON.stringify({ sourcePrivateContextId: sameWorkspace.json.context.id, resourceIds: [sameWorkspaceResource.json.resource.id], title: "Inbox same-workspace proposal", description: "Same-workspace navigation E2E fixture" }),
      });
      if (sameWorkspaceProposal.status !== 201) throw new Error(`same-workspace proposal setup failed (${sameWorkspaceProposal.status}): ${sameWorkspaceProposal.text}`);
      const workspaceResponse = await apiRequest(page, "/api/workspaces", { method: "POST", body: JSON.stringify({ name: "Inbox destination workspace" }) });
      if (workspaceResponse.status !== 201) throw new Error(`destination workspace setup failed (${workspaceResponse.status}): ${workspaceResponse.text}`);
      destinationWorkspaceId = workspaceResponse.json.workspace.id;
      const destinationProject = await createProject(destinationWorkspaceId, "Inbox destination project");
      destinationProjectId = destinationProject.id;
      const work = await apiRequest(page, `/api/projects/${destinationProjectId}/private-work`, { method: "POST", body: JSON.stringify({ name: "Inbox proposal draft" }) });
      if (work.status !== 201) throw new Error(`proposal context setup failed (${work.status}): ${work.text}`);
      const resource = await apiRequest(page, `/api/projects/${destinationProjectId}/resources`, {
        method: "POST",
        body: JSON.stringify({ contextId: work.json.context.id, path: "proposal.seq", type: "sequence-diagram", content: "title Inbox proposal\nparticipant Browser\n" }),
      });
      if (resource.status !== 201) throw new Error(`proposal resource setup failed (${resource.status}): ${resource.text}`);
      const proposalResponse = await apiRequest(page, `/api/projects/${destinationProjectId}/architectural-proposals`, {
        method: "POST",
        body: JSON.stringify({ sourcePrivateContextId: work.json.context.id, resourceIds: [resource.json.resource.id], title: "Inbox cross-workspace proposal", description: "Inbox E2E fixture" }),
      });
      if (proposalResponse.status !== 201) throw new Error(`proposal setup failed (${proposalResponse.status}): ${proposalResponse.text}`);
      const proposalId = proposalResponse.json.proposal.id;

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAuthEntry(page);
      page.on("response", async (response) => {
        const url = new URL(response.url());
        if (url.pathname === "/api/workspaces" || (url.pathname === "/api/projects" && url.searchParams.has("workspaceId"))) catalogStatuses.push(`${response.status()} ${url.pathname}${url.search}`);
        if (response.status() >= 400) browserErrors.push(`${response.status()} ${url.pathname}${url.search} ${await response.text().catch(() => "")}`);
      });
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === `/api/projects/${sourceProjectId}/access`) sourceAccessCount.value += 1;
        if (url.pathname === `/api/projects/${destinationProjectId}/access`) targetAccessCount.value += 1;
        if (url.pathname === `/api/projects/${sameWorkspaceProjectId}/access`) sameWorkspaceAccessCount.value += 1;
      });
      page.on("pageerror", (error) => browserErrors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
      await openServerProject(page, "Inbox navigation source");

      await page.getByTestId("workspace-back-to-projects").click();
      await page.getByTestId("workspace-server-workspace-select").selectOption(destinationWorkspaceId);
      const destinationProjectRow = page.getByTestId("workspace-server-project").filter({ hasText: "Inbox destination project" });
      try {
        await destinationProjectRow.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      } catch {
        throw new Error(`workspace switch did not load destination project: selected=${await page.getByTestId("workspace-server-workspace-select").inputValue().catch(() => "missing")}; active=${await page.getByTestId("workspace-active-project").innerText().catch(() => "none")}; loading=${await page.getByTestId("workspace-server-projects-loading").innerText().catch(() => "none")}; error=${await page.getByTestId("workspace-server-projects-error").innerText().catch(() => "none")}; catalog=${catalogStatuses.join(" | ")}`);
      }
      await destinationProjectRow.click();
      await page.getByTestId("workspace-active-project").getByText("Inbox destination project").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("explorer switches from workspace A to project B", (await page.getByTestId("workspace-active-project").innerText()).includes("Inbox destination project") && (await page.getByTestId("workspace-active-project").innerText()).includes("Inbox destination workspace"));
      check("switching workspaces does not reopen the stale project A URL", sourceAccessCount.value === 1, `project A access requests=${sourceAccessCount.value}`);

      await page.locator('[data-testid="open-architecture-inbox"]').click();
      await page.locator('[data-testid="architecture-inbox"]').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByRole("button", { name: "Back to workspace" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const workspaces = page.locator(".architecture-inbox__filters select").nth(0);
      const projects = page.locator(".architecture-inbox__filters select").nth(1);
      await page.waitForFunction(() => {
        const [workspace, project] = document.querySelectorAll(".architecture-inbox__filters select");
        const options = [...(project?.options ?? [])];
        return workspace?.options.length >= 3 && options.some((option) => option.textContent === "Inbox navigation source");
      }, null, { timeout: UI_TIMEOUT_MS });
      const destinationProjects = await apiRequest(page, `/api/projects?workspaceId=${encodeURIComponent(destinationWorkspaceId)}`);
      const workspaceOptions = await workspaces.locator("option").allTextContents();
      const projectOptions = await projects.locator("option").allTextContents();
      check("Inbox catalog includes accessible workspaces and projects", workspaceOptions.length >= 3 && projectOptions.includes("Inbox navigation source") && projectOptions.includes("Inbox same-workspace project") && projectOptions.includes("Inbox destination project") && destinationProjects.status === 200 && catalogStatuses.every((status) => status.startsWith("200 ")), `workspace/project catalog responses=${catalogStatuses.length}`);

      const sameWorkspaceRow = page.getByRole("button", { name: /Inbox same-workspace proposal/ });
      await sameWorkspaceRow.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await sameWorkspaceRow.click();
      await page.waitForFunction(() => document.querySelector('section[aria-label="Architectural Proposal"]')?.textContent?.includes("Inbox same-workspace proposal"), null, { timeout: UI_TIMEOUT_MS });
      await page.waitForFunction((id) => new URL(location.href).searchParams.get("project") === id, sameWorkspaceProjectId, { timeout: UI_TIMEOUT_MS });
      const sameWorkspaceUrl = page.url();
      await delay(700);
      const sameWorkspaceProposalReads = await page.evaluate((proposalId) => window.performance.getEntriesByType("resource")
        .map((entry) => new URL(entry.name))
        .filter((url) => url.pathname === `/api/architectural-proposals/${proposalId}` || url.pathname === `/api/architectural-proposals/${proposalId}/reviews` || url.pathname === `/api/architectural-proposals/${proposalId}/diff`)
        .map((url) => url.searchParams.get("projectId")), sameWorkspaceProposal.json.proposal.id);
      check("Inbox opens workspace A proposal from active workspace B", page.url() === sameWorkspaceUrl && new URL(sameWorkspaceUrl).searchParams.get("project") === sameWorkspaceProjectId && sameWorkspaceAccessCount.value === 1 && sameWorkspaceProposalReads.length >= 3 && sameWorkspaceProposalReads.every((id) => id === sameWorkspaceProjectId), `active=${await page.getByTestId("workspace-active-project").innerText()}; access=${sameWorkspaceAccessCount.value}; detail projectIds=${sameWorkspaceProposalReads}`);

      await page.goBack();
      await page.locator('[data-testid="architecture-inbox"]').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByRole("button", { name: "Back to workspace" }).click();
      await page.getByTestId("workspace-switcher").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("return to explorer preserves proposal project A", (await page.getByTestId("workspace-active-project").innerText()).includes("Inbox same-workspace project"));
      await page.getByTestId("workspace-back-to-projects").click();
      await page.getByTestId("workspace-server-workspace-select").selectOption(destinationWorkspaceId);
      await page.getByTestId("workspace-server-projects-loading").waitFor({ state: "hidden", timeout: UI_TIMEOUT_MS });
      await page.getByTestId("workspace-server-project").filter({ hasText: "Inbox destination project" }).click();
      await page.getByTestId("workspace-active-project").getByText("Inbox destination project").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("explorer switches back from workspace A to project B", (await page.getByTestId("workspace-active-project").innerText()).includes("Inbox destination project") && (await page.getByTestId("workspace-active-project").innerText()).includes("Inbox destination workspace"));
      check("second workspace switch opens project B once", targetAccessCount.value === 2, `access requests=${targetAccessCount.value}`);
      await page.locator('[data-testid="open-architecture-inbox"]').click();
      await page.locator('[data-testid="architecture-inbox"]').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.waitForFunction(() => [...document.querySelectorAll(".architecture-inbox__filters select")[1]?.options ?? []].some((option) => option.textContent === "Inbox destination project"), null, { timeout: UI_TIMEOUT_MS });

      await workspaces.selectOption(destinationWorkspaceId);
      await projects.selectOption(destinationProjectId);
      await page.locator(".architecture-inbox__filters select").nth(2).selectOption("PENDING_REVIEW");
      await page.getByLabel("Proposal title").fill("Inbox cross-workspace");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      const proposalRow = page.getByRole("button", { name: /Inbox cross-workspace proposal/ });
      await proposalRow.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const filteredUrl = new URL(page.url());
      check("filters update the Inbox URL without navigating", filteredUrl.searchParams.get("workspace") === destinationWorkspaceId && filteredUrl.searchParams.get("projectFilter") === destinationProjectId && filteredUrl.searchParams.get("project") === null && targetAccessCount.value === 2);

      const destinationWritesBeforeProposal = await page.evaluate((id) => window.__inboxHistoryWrites.filter((entry) => new URL(entry.url, location.origin).searchParams.get("project") === id).length, destinationProjectId);
      await proposalRow.click();
      const proposalDetail = page.locator('section[aria-label="Architectural Proposal"]');
      await page.waitForFunction(() => document.querySelector('section[aria-label="Architectural Proposal"]')?.textContent?.includes("Inbox cross-workspace proposal"), null, { timeout: UI_TIMEOUT_MS });
      await page.waitForFunction((id) => new URL(location.href).searchParams.get("project") === id, destinationProjectId, { timeout: UI_TIMEOUT_MS });
      check("cross-workspace navigation shows the selected proposal in the destination project", (await proposalDetail.innerText()).includes("Inbox cross-workspace proposal") && (await page.locator('[data-testid="workspace-switcher"]').innerText()).includes("Inbox destination project"));
      const proposalUrl = page.url();
      await delay(700);
      check("proposal opens the destination and its URL settles", page.url() === proposalUrl && new URL(proposalUrl).searchParams.get("proposal") === proposalId);
      check("same-project proposal navigation does not reopen the destination", targetAccessCount.value === 2, `openProject access requests=${targetAccessCount.value}`);
      const destinationWrites = await page.evaluate((id) => window.__inboxHistoryWrites.filter((entry) => new URL(entry.url, location.origin).searchParams.get("project") === id).length, destinationProjectId);
      check("the proposal causes one destination URL write", destinationWrites - destinationWritesBeforeProposal === 1, `writes before=${destinationWritesBeforeProposal}; after=${destinationWrites}`);

      await page.goBack();
      await page.locator('[data-testid="architecture-inbox"]').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const returnedUrl = new URL(page.url());
      check("browser Back restores Inbox filters", returnedUrl.searchParams.get("workspace") === destinationWorkspaceId && returnedUrl.searchParams.get("projectFilter") === destinationProjectId && returnedUrl.searchParams.get("attention") === "PENDING_REVIEW" && returnedUrl.searchParams.get("q") === "Inbox cross-workspace");
      await page.getByRole("button", { name: "Back to workspace" }).click();
      await page.locator('[data-testid="workspace-switcher"]').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const workspaceUrl = page.url();
      await delay(700);
      check("return to explorer is stable and does not reopen the project", page.url() === workspaceUrl && new URL(workspaceUrl).searchParams.get("project") === destinationProjectId && targetAccessCount.value === 2 && sameWorkspaceAccessCount.value === 1 && sourceAccessCount.value === 1, `url=${workspaceUrl}; project A opens=${sourceAccessCount.value}; Inbox A opens=${sameWorkspaceAccessCount.value}; project B opens=${targetAccessCount.value}`);
      check("navigation has no browser console, page, or HTTP errors", browserErrors.length === 0, browserErrors.join(" | "));
      console.log(`  TRACE URLs: ${await page.evaluate(() => window.__inboxHistoryWrites.map((entry) => entry.url).join(" -> "))}`);
      console.log(`  TRACE catalog: ${catalogStatuses.join(" | ")}`);
      console.log(`  TRACE project opens: A=${sourceAccessCount.value}, proposal A=${sameWorkspaceAccessCount.value}, B=${targetAccessCount.value}; final active=${await page.getByTestId("workspace-active-project").innerText()}`);
      console.log(`  TRACE browser errors: ${browserErrors.length ? browserErrors.join(" | ") : "none"}`);
    } finally {
      if (sourceProjectId) await apiRequest(page, `/api/projects/${sourceProjectId}`, { method: "DELETE" });
      if (sameWorkspaceProjectId) await apiRequest(page, `/api/projects/${sameWorkspaceProjectId}`, { method: "DELETE" });
      if (destinationProjectId) await apiRequest(page, `/api/projects/${destinationProjectId}`, { method: "DELETE" });
      if (destinationWorkspaceId) await apiRequest(page, `/api/workspaces/${destinationWorkspaceId}`, { method: "DELETE" });
      await context.close();
    }
  });

  if (process.env.E2E_SCENARIO !== "governed-proposal") {
  await scenario(
    "Server scenario 1: a server project's diagram survives a reload",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        await waitForAuthEntry(page);

        await signIn(page, idp, owner);
        check(
          "signing in through the local provider exposes the session",
          true,
        );

        await createServerProject(page, "Alpha Server");
        const contextId = await createMyWorkDocument(page, "Alpha Server");
        check("creating a server project opens it in the explorer", true);
        await showEditor(page);
        await page.locator('[data-testid="dsl-textarea"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        check("a sequence diagram can be created in a server project", true);

        await page
          .locator('[data-testid="dsl-textarea"]')
          .fill(
            [
              "title Alpha Server",
              "participant Client",
              "participant Service",
              `Client ->> Service: ${SERVER_MARKER}`,
              "",
            ].join("\n"),
          );
        const saved = await waitForServerContent(
          page,
          "Alpha Server",
          (content) => content.includes(SERVER_MARKER),
          "the server-side save",
          contextId,
        );
        check(
          "the edit reaches the server, not just the browser",
          saved.content.includes(SERVER_MARKER),
        );

        await page.reload({ waitUntil: "domcontentloaded" });
        await openServerProject(page, "Alpha Server");
        await openMyWorkContext(page, contextId);
        await showEditor(page);
        await page.locator('[data-testid="dsl-textarea"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        const reopened = await waitForInputValue(
          page.locator('[data-testid="dsl-textarea"]'),
          (value) => value.includes(SERVER_MARKER),
          "the reopened diagram",
        );
        check(
          "after a reload the project reopens its document",
          reopened.includes(`Client ->> Service: ${SERVER_MARKER}`),
        );
      } finally {
        await context.close();
      }
    },
  );

  await scenario(
    "Server scenario 2: a server project's markdown document survives a reload",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        await waitForAuthEntry(page);
        await signIn(page, idp, owner);

        await createServerProject(page, "Docs Server");
        const contextId = await createMyWorkDocument(page, "Docs Server");
        await createDocument(page, "Docs Server", "context-menu-new-note");
        await showEditor(page);
        await page.locator('[data-testid="markdown-textarea"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        check("a markdown document can be created in a server project", true);

        await page
          .locator('[data-testid="markdown-textarea"]')
          .fill(
            ["# Server Handbook", "", `Runbook ${MARKDOWN_MARKER}.`].join("\n"),
          );
        const saved = await waitForServerContent(
          page,
          "Docs Server",
          (content) => content.includes(MARKDOWN_MARKER),
          "the markdown save",
          contextId,
        );
        check(
          "the markdown edit reaches the server",
          saved.content.includes(MARKDOWN_MARKER),
        );

        await page.reload({ waitUntil: "domcontentloaded" });
        await openServerProject(page, "Docs Server");
        await openMyWorkContext(page, contextId);
        await page.locator('[data-testid="select-note-button"]').click();
        await showEditor(page);
        await page.locator('[data-testid="markdown-textarea"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        const reopened = await waitForInputValue(
          page.locator('[data-testid="markdown-textarea"]'),
          (value) => value.includes(MARKDOWN_MARKER),
          "the reopened markdown document",
        );
        check(
          "after a reload the markdown document reopens with its content",
          reopened.includes(MARKDOWN_MARKER),
        );
      } finally {
        await context.close();
      }
    },
  );

  await scenario(
    "Server scenario 3: a stale write raises the conflict dialog",
    async () => {
      const ownerContext = await browser.newContext();
      const otherContext = await browser.newContext();
      const ownerPage = await ownerContext.newPage();
      const otherPage = await otherContext.newPage();
      try {
        // The owner creates the shared document.
        await ownerPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        await waitForAuthEntry(ownerPage);
        await signIn(ownerPage, idp, owner);
        await createServerProject(ownerPage, "Conflict Server");
        const contextId = await createMyWorkDocument(ownerPage, "Conflict Server");
        await showEditor(ownerPage);
        await ownerPage.locator('[data-testid="dsl-textarea"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        await ownerPage
          .locator('[data-testid="dsl-textarea"]')
          .fill(
            [
              "title Conflict",
              "participant A",
              "participant B",
              `A ->> B: ${CONFLICT_BASE}`,
              "",
            ].join("\n"),
          );
        await waitForServerContent(
          ownerPage,
          "Conflict Server",
          (content) => content.includes(CONFLICT_BASE),
          "the first save",
          contextId,
        );

        // The second context reads the same document, and so holds the revision
        // the first save produced.
        await otherPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        await waitForAuthEntry(otherPage);
        await signIn(otherPage, idp, owner);
        await openServerProject(otherPage, "Conflict Server");
        await openMyWorkContext(otherPage, contextId);
        await showEditor(otherPage);
        await otherPage.locator('[data-testid="dsl-textarea"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        await waitForInputValue(
          otherPage.locator('[data-testid="dsl-textarea"]'),
          (value) => value.includes(CONFLICT_BASE),
          "the second editor's read",
        );
        check("a second context opens the same server document", true);

        // The owner writes first, moving the server past the revision the second
        // context read.
        await ownerPage
          .locator('[data-testid="dsl-textarea"]')
          .fill(
            [
              "title Conflict",
              "participant A",
              "participant B",
              `A ->> B: ${CONFLICT_OWNER}`,
              "",
            ].join("\n"),
          );
        await waitForServerContent(
          ownerPage,
          "Conflict Server",
          (content) => content.includes(CONFLICT_OWNER),
          "the owner's second save",
          contextId,
        );

        // The second context saves from its now-stale revision.
        await otherPage
          .locator('[data-testid="dsl-textarea"]')
          .fill(
            [
              "title Conflict",
              "participant A",
              "participant B",
              `A ->> B: ${CONFLICT_LOCAL}`,
              "",
            ].join("\n"),
          );
        await otherPage
          .locator('[data-testid="save-conflict-dialog"]')
          .waitFor({
            state: "visible",
            timeout: UI_TIMEOUT_MS,
          });
        check("a write from a stale revision raises the conflict dialog", true);
        check(
          "the local edit is still in the editor while the dialog is open",
          (
            await otherPage.locator('[data-testid="dsl-textarea"]').inputValue()
          ).includes(CONFLICT_LOCAL),
        );

        const afterConflict = await waitForServerContent(
          otherPage,
          "Conflict Server",
          (content) => content.includes(CONFLICT_OWNER),
          "the owner's content after the refused write",
          contextId,
        );
        check(
          "the refused write did not reach the server",
          !afterConflict.content.includes(CONFLICT_LOCAL),
        );

        await otherPage.locator('[data-testid="save-conflict-reload"]').click();
        await otherPage
          .locator('[data-testid="save-conflict-dialog"]')
          .waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
        const reloaded = await waitForInputValue(
          otherPage.locator('[data-testid="dsl-textarea"]'),
          (value) => value.includes(CONFLICT_OWNER),
          "the reloaded server version",
        );
        check(
          "reloading the server version shows the owner's content",
          reloaded.includes(CONFLICT_OWNER),
        );
        check(
          "the local edit is gone after taking the server version",
          !reloaded.includes(CONFLICT_LOCAL),
        );
      } finally {
        await ownerContext.close();
        await otherContext.close();
      }
    },
  );

  await scenario(
    "Server scenario 4: a VIEWER can read but cannot write",
    async () => {
      const ownerContext = await browser.newContext();
      const viewerContext = await browser.newContext();
      const ownerPage = await ownerContext.newPage();
      const viewerPage = await viewerContext.newPage();
      try {
        await ownerPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        await waitForAuthEntry(ownerPage);
        await signIn(ownerPage, idp, owner);
        await bootstrapSharedProject(
          ownerPage,
          "Viewer Server",
          [
            "title Viewer",
            "participant A",
            "participant B",
            `A ->> B: ${VIEWER_MARKER}`,
            "",
          ].join("\n"),
        );
        await ownerPage.reload({ waitUntil: "domcontentloaded" });
        await openServerProject(ownerPage, "Viewer Server");
        await showEditor(ownerPage);
        await ownerPage.locator('[data-testid="dsl-textarea"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        await waitForServerContent(
          ownerPage,
          "Viewer Server",
          (content) => content.includes(VIEWER_MARKER),
          "the owner's save",
        );

        // The second person signs in, and the owner adds them as a viewer.
        await viewerPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        await waitForAuthEntry(viewerPage);
        await signIn(viewerPage, idp, viewer);
        const me = await apiRequest(viewerPage, "/api/me");
        const viewerId = me.json?.user?.id;
        check(
          "the second sign-in created a distinct account",
          typeof viewerId === "string" && viewerId !== "",
        );

        const owned = await currentServerResource(ownerPage, "Viewer Server");
        const projectDetails = await apiRequest(
          ownerPage,
          `/api/projects/${owned.projectId}`,
        );
        const workspaceId = projectDetails.json?.project?.workspaceId;
        const workspaceMembership = await apiRequest(
          ownerPage,
          `/api/workspaces/${workspaceId}/members/${viewerId}`,
          { method: "PUT", body: JSON.stringify({ role: "VIEWER" }) },
        );
        check(
          "the owner can add the second user to the project workspace",
          workspaceMembership.status === 200,
          `status ${workspaceMembership.status}`,
        );
        const membership = await apiRequest(
          ownerPage,
          `/api/projects/${owned.projectId}/members/${viewerId}`,
          { method: "PUT", body: JSON.stringify({ role: "VIEWER" }) },
        );
        check(
          "the owner can add the second user as a VIEWER",
          membership.status === 204,
          `status ${membership.status}`,
        );

        // The viewer's project list was read before the membership existed, so a
        // reload is what makes the shared project appear.
        await viewerPage.reload({ waitUntil: "domcontentloaded" });
        await openServerProject(viewerPage, "Viewer Server");
        await showEditor(viewerPage);
        await viewerPage.locator('[data-testid="dsl-textarea"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        const read = await waitForInputValue(
          viewerPage.locator('[data-testid="dsl-textarea"]'),
          (value) => value.includes(VIEWER_MARKER),
          "the viewer's read",
        );
        check(
          "a viewer can open and read the project",
          read.includes(VIEWER_MARKER),
        );
        check(
          "a read-only viewer retains Present in the SHARED viewer toolbar",
          await viewerPage.getByTestId("viewer-present-toggle").isVisible() &&
            await viewerPage.getByTestId("viewer-focus-toggle").isVisible() &&
            await viewerPage.getByTestId("viewer-fullscreen-toggle").isVisible(),
        );

        // The viewer's edit is refused before it ever leaves the browser, and the
        // shell says so rather than failing silently.
        await viewerPage
          .locator('[data-testid="dsl-textarea"]')
          .fill(
            [
              "title Viewer",
              "participant A",
              "participant B",
              "A ->> B: VIEWEREDIT",
              "",
            ].join("\n"),
          );
        await viewerPage.locator('[data-testid="save-error"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        check("the read-only editor surfaces the refused save", true);

        const afterEdit = await currentServerResource(
          viewerPage,
          "Viewer Server",
        );
        check(
          "the viewer's edit never reached the server",
          afterEdit.content.includes(VIEWER_MARKER) &&
            !afterEdit.content.includes("VIEWEREDIT"),
        );

        // More important than the UI: the server refuses the write itself, even
        // with the revision it currently holds.
        const refused = await apiRequest(
          viewerPage,
          `/api/projects/${afterEdit.projectId}/resources/${afterEdit.resource.id}`,
          {
            method: "PUT",
            body: JSON.stringify({
              content: "VIEWEROVERRIDE",
              expectedRevision: afterEdit.resource.revision,
            }),
          },
        );
        check(
          "the server refuses a viewer's write with 403",
          refused.status === 403,
          `status ${refused.status}`,
        );

        // The command palette create action is refused too, which is what an
        // operator can use without adding controls to the clean Explorer.
        const viewerResources = viewerPage.locator('[data-testid="explorer-resources"]');
        const before = await viewerResources
          .locator('[data-testid="explorer-diagram"]')
          .count();
        await addDocument(viewerPage, "context-menu-new-diagram");
        await viewerPage.locator('[data-testid="workspace-error"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        check(
          "the read-only project refuses a create with a visible error",
          true,
        );
        check(
          "no diagram was created in the read-only project",
          (await viewerResources
            .locator('[data-testid="explorer-diagram"]')
            .count()) === before,
          `${before} -> ${await viewerResources
            .locator('[data-testid="explorer-diagram"]')
            .count()}`,
        );
      } finally {
        await ownerContext.close();
        await viewerContext.close();
      }
    },
  );

  await scenario(
    "Server scenario 5: an anonymous visitor keeps the local workspace",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        await page.locator('[data-testid="login-page"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        check(
          "an anonymous visitor is kept on the login screen",
          true,
        );
        check(
          "the application shell is hidden while signed out",
          (await page.locator('[data-testid="app-shell"]').count()) === 0,
        );
        check(
          "Google sign-in is available on the login screen",
          (await page.locator('[data-testid="login-google"]').count()) === 1,
        );
        check(
          "local workspace controls are hidden while signed out",
          (await page.locator('[data-testid="project-name-input"]').count()) === 0,
        );
      } finally {
        await context.close();
      }
    },
  );

  await scenario(
    "Server scenario 6: an agent credential reads, cannot write, and revokes",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        await waitForAuthEntry(page);
        await signIn(page, idp, owner);

        // Bootstrap authoritative content the agent will read. Agent credentials
        // intentionally cannot see a user's private MY WORK context.
        await bootstrapSharedProject(
          page,
          "Agent Project",
          [
            "title Agent Project",
            "participant One",
            "participant Two",
            `One ->> Two: ${AGENT_MARKER}`,
            "",
          ].join("\n"),
        );
        await page.reload({ waitUntil: "domcontentloaded" });
        await openServerProject(page, "Agent Project");
        await showEditor(page);
        await page.locator('[data-testid="dsl-textarea"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        await waitForServerContent(
          page,
          "Agent Project",
          (content) => content.includes(AGENT_MARKER),
          "the browser's save",
        );
        check("the browser opens a document the agent will read", true);

        // 1. The user creates an agent and a read-only credential.
        await page.locator('[data-testid="workspace-settings"]').click();
        await page.locator('[data-testid="settings-tab-agents"]').click();
        await page.locator('[data-testid="agent-name"]').fill("E2E Agent");
        await page.locator('[data-testid="agent-create"]').click();
        const card = page
          .locator('li[data-testid^="agent-"]')
          .filter({ hasText: "E2E Agent" });
        await card.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await card
          .locator('[data-testid^="agent-credentials-"]')
          .first()
          .click();
        const createButton = card.locator(
          '[data-testid^="credential-create-"]',
        );
        await createButton.waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        await createButton.click();
        const secret = await page
          .locator('[data-testid="credential-secret"]')
          .inputValue();
        check(
          "an agent credential is created and its secret is shown once",
          secret.startsWith("sdm_pat_"),
          secret.slice(0, 16),
        );
        await page.locator('[data-testid="credential-dismiss"]').click();

        const project = await serverProjectByName(page, "Agent Project");
        if (project === null) throw new Error("Agent Project was not created");

        // 2. A machine client authenticates with the credential alone.
        const handshake = await remoteMcp(mcpBase, secret, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          // A complete initialize: the SDK's schema requires the client's
          // capabilities and identity as well as the requested version.
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "sequencediagrams-e2e", version: "1.0.0" },
          },
        });
        check(
          "the agent authenticates with its credential",
          handshake.status === 200 &&
            handshake.json?.result?.serverInfo?.name === "sequencediagrams-mcp",
          `status ${handshake.status}`,
        );

        // 3. A read-only credential is not even offered the write tools.
        const tools = await remoteMcp(mcpBase, secret, {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
        });
        const names = (tools.json?.result?.tools ?? []).map(
          (tool) => tool.name,
        );
        check(
          "a read-only credential is offered reads and not writes",
          names.includes("read_resource") && !names.includes("create_resource"),
          names.join(", "),
        );

        // 4. It reads the document the browser wrote.
        const resources = await remoteTool(
          mcpBase,
          secret,
          3,
          "list_resources",
          { projectId: project.id },
        );
        const resource = resources?.structuredContent?.resources?.[0];
        const read = await remoteTool(mcpBase, secret, 4, "read_resource", {
          projectId: project.id,
          resource: resource?.id,
        });
        check(
          "the agent reads the document on the server",
          (read?.structuredContent?.content ?? "").includes(AGENT_MARKER),
        );

        // 5. It cannot write.
        const write = await remoteTool(mcpBase, secret, 5, "create_resource", {
          projectId: project.id,
          path: "agent-created.seq",
          type: "sequence-diagram",
          content: "One ->> Two: nope",
        });
        // The write tool is not even registered for this credential, so the
        // refusal is a tool error rather than a successful call.
        check(
          "the read-only credential is refused every write",
          write?.isError === true,
          write?.content?.[0]?.text,
        );

        // 6. Revoking the credential stops it immediately.
        const revokeButton = card
          .locator('[data-testid^="credential-revoke-"]')
          .first();
        await revokeButton.click();
        await card
          .locator('[data-testid^="credential-revoke-confirm-"]')
          .click();
        await waitForText(
          card,
          (text) => text.includes("revoked"),
          "the revoked credential row",
        );
        check("the credential can be revoked from the agents screen", true);

        const afterRevoke = await remoteMcp(mcpBase, secret, {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/list",
        });
        check(
          "the revoked credential is rejected immediately",
          afterRevoke.status === 401,
          `status ${afterRevoke.status}`,
        );
      } finally {
        await context.close();
      }
    },
  );
  }

  await scenario(
    "Server scenario 7: governed proposal revision and independent review stays durable",
    async () => {
      const context = await browser.newContext();
      const reviewerContext = await browser.newContext();
      const page = await context.newPage();
      const reviewerPage = await reviewerContext.newPage();
      const projectName = "Governed Proposal Lifecycle";
      const proposalTitle = "Governed proposal lifecycle";
      const sharedMarker = "GOVERNEDSHAREDBASE";
      const v1Marker = "GOVERNEDV1";
      const v2Marker = "GOVERNEDV2";

      const projectProposals = async (projectId) => {
        const response = await apiRequest(
          page,
          `/api/projects/${projectId}/architectural-proposals`,
        );
        return response.json?.proposals ?? [];
      };
      const proposalById = async (projectId, proposalId) => {
        const response = await apiRequest(
          page,
          `/api/architectural-proposals/${proposalId}?projectId=${projectId}`,
        );
        if (response.status !== 200) {
          throw new Error(`proposal ${proposalId} read failed: ${response.status}`);
        }
        return response.json?.proposal;
      };
      const openProposalFromExplorer = async (state) => {
        const proposalsToggle = page.locator('[data-testid="explorer-proposals-toggle"]');
        if ((await proposalsToggle.getAttribute("aria-expanded")) !== "true") await proposalsToggle.click();
        const row = page
          .locator('[data-testid="explorer-proposal"]')
          .filter({ hasText: proposalTitle })
          .filter({ hasText: state });
        await row.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await row.locator('[data-testid="explorer-proposal-menu"]').click();
        await page.getByRole("menuitem", { name: "Copy proposal ID" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        if (state === "OPEN") {
          await page.getByRole("menuitem", { name: "Edit revision…" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
          await page.getByRole("menuitem", { name: "Withdraw proposal…" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        }
        await page.keyboard.press("Escape");
        await row.locator('[data-testid="explorer-proposal-open"]').click();
        await waitForText(
          page.locator('section[aria-label="Architectural Proposal"]'),
          (text) => text.includes(state),
          `${state} proposal detail`,
        );
      };
      const submitFromMyWork = async (title, description, revision = false) => {
        const myWorkToggle = page.locator('[data-testid="explorer-my-work-toggle"]');
        if ((await myWorkToggle.getAttribute("aria-expanded")) !== "true") await myWorkToggle.click();
        const work = page.locator('[data-testid="explorer-private-context"]');
        await work.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await work.getByRole("button", { name: /Actions for MY WORK/ }).click();
        await page.getByRole("menuitem", { name: "Copy MY WORK ID" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await page.getByRole("menuitem", { name: "Delete MY WORK" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await page.getByRole("menuitem", { name: revision ? "Review and submit revision…" : "Create proposal from this draft…" }).click();
        await page.locator('section[aria-label="Submit architectural proposal"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        await page.getByLabel("Proposal title").fill(title);
        await page.getByLabel("Proposal description").fill(description);
        const resourceCheckboxList = page.locator('section[aria-label="Submit architectural proposal"] input[type="checkbox"]');
        await resourceCheckboxList.first().waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        const resourceCheckboxes = await resourceCheckboxList.all();
        for (const checkbox of resourceCheckboxes) await checkbox.check();
        await page
          .getByRole("button", { name: revision ? "Submit revision" : "Submit proposal for review" })
          .click();
        if (revision) {
          await page.getByRole("button", { name: "Confirm revision" }).click();
        }
        await page.locator('section[aria-label="Architectural Proposal"] h2').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
      };
      const createGovernedMyWorkDocument = async () => {
        await page.locator('[data-testid="explorer-my-work-create"]').click();
        await page.getByRole("dialog", { name: "Create MY WORK draft" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await page.getByLabel("Draft name").fill("work-governed-lifecycle");
        await page.getByRole("button", { name: "Create draft" }).click();
        const deadline = Date.now() + UI_TIMEOUT_MS;
        let createdContextId = null;
        while (Date.now() < deadline) {
          const contexts = await apiRequest(
            page,
            `/api/projects/${(await serverProjectByName(page, projectName)).id}/private-work`,
          );
          const context = (contexts.json?.contexts ?? []).find((entry) =>
            entry.name === "work-governed-lifecycle",
          );
          if (context) {
            createdContextId = context.id;
            break;
          }
          await delay(100);
        }
        if (!createdContextId) throw new Error("the governed MY WORK context was not created");
        await page.locator(".explorer__context-note").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await page.locator('[data-testid="explorer-my-work-create"]').click();
        await page.getByRole("menuitem", { name: "New diagram" }).click();
        await page.locator('[data-testid="explorer-my-work-section"] [data-testid="explorer-diagram"]').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        return createdContextId;
      };

      try {
        await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        await waitForAuthEntry(page);
        await signIn(page, idp, owner);
        await bootstrapSharedProject(
          page,
          projectName,
          [
            "title Governed shared base",
            "participant Shared",
            "participant Authority",
            `Shared ->> Authority: ${sharedMarker}`,
            "",
          ].join("\n"),
        );
        await page.reload({ waitUntil: "domcontentloaded" });
        await openServerProject(page, projectName);
        const project = await serverProjectByName(page, projectName);
        if (project === null) throw new Error(`no server project named ${projectName}`);
        const sharedBefore = await currentServerResource(page, projectName);
        const contextId = await createGovernedMyWorkDocument();
        const companionDocument = await apiRequest(page, `/api/projects/${project.id}/resources`, {
          method: "POST",
          body: JSON.stringify({
            path: "governance-context.md",
            type: "markdown-document",
            content: "# Governance context\n\nCompanion proposal resource.\n",
            contextId,
          }),
        });
        check("MY WORK can contain a second proposal artifact", companionDocument.status === 201);
        const initialMyWorkToggle = page.locator('[data-testid="explorer-my-work-toggle"]');
        if ((await initialMyWorkToggle.getAttribute("aria-expanded")) !== "true") await initialMyWorkToggle.click();
        await page.locator('.explorer__context-note').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
         await page.locator('[data-testid="explorer-my-work-section"] [data-testid="explorer-diagram"]').first().click();
        await showEditor(page);
        const editor = page.locator('[data-testid="dsl-textarea"]');
        await editor.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await editor.fill(
          [
            "title Governed proposal v1",
            "participant Browser",
            "participant Service",
            `Browser ->> Service: ${v1Marker}`,
            "",
          ].join("\n"),
        );
        await waitForServerContent(
          page,
          projectName,
          (content) => content.includes(v1Marker),
          "the v1 MY WORK edit",
          contextId,
        );

        await openServerProject(page, projectName);
        await submitFromMyWork(proposalTitle, "Initial governed snapshot");
        const v1 = (await projectProposals(project.id)).find(
          (proposal) => proposal.title === proposalTitle,
        );
        if (!v1?.id) throw new Error("v1 proposal id was not returned by the API");
        check("v1 is tracked by its proposal id", typeof v1.id === "string");
        check(
          "SHARED is unchanged after v1 submission",
          (await currentServerResource(page, projectName)).content === sharedBefore.content,
        );

        await openServerProject(page, projectName);
        await openProposalFromExplorer("OPEN");
          check(
            "v1 opens from PROPOSALS as OPEN",
            (await page.locator('section[aria-label="Architectural Proposal"]').textContent()).includes("OPEN"),
          );
          check(
            "proposal decision workspace shows the human-readable author",
            (await page.locator('section[aria-label="Architectural Proposal"]').textContent()).includes(owner.name),
          );
          check(
            "proposal decision workspace shows its intent",
            (await page.locator('section[aria-label="Architectural Proposal"]').textContent()).includes("Initial governed snapshot") &&
              (await page.locator('[data-testid="proposal-impact"]').count()) === 0,
          );
          await page.getByRole("button", { name: "Impact", exact: true }).click();
          check("proposal decision workspace shows impact in its tab", (await page.locator('[data-testid="proposal-impact"]').count()) === 1);
         check(
           "proposal decision workspace exposes its first canonical change",
           /(?:ADDED|MODIFIED|DELETED)/.test(await page.locator('section[aria-label="Architectural Proposal"]').textContent() ?? ""),
         );
          const v1Change = page.locator('section[aria-label="Changes"] button').filter({ hasText: /\.seq/ }).first();
          await v1Change.click();
          await page.getByRole("button", { name: "Review", exact: true }).click();
         check(
           "v1 has no reviews",
           (await page.locator('section[aria-label="Proposal review"]').textContent()).includes("none · 0 approvals"),
         );
         check(
           "proposal decision workspace keeps author review unavailable",
           (await page.locator('section[aria-label="Proposal review"]').textContent()).includes("cannot approve your own proposal"),
         );
          const v1Inspector = page.locator('section[aria-label^="Comparison for "]');
         await v1Inspector.getByRole("button", { name: "Compare", exact: true }).click();
         check("selecting a change leaves the proposal selected", await page.locator('[data-testid="explorer-proposal-open"][aria-current="true"]').count() === 1);

           await page.getByRole("button", { name: "Edit revision" }).click();
            await page.locator('[data-testid="tab-bar"] [data-testid="tab"]').nth(1).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
            check("revision session opens every proposal artifact in tabs", await page.locator('[data-testid="tab-bar"] [data-testid="tab"]').count() === 2);
            check("revision session shows proposal-level resource scope", (await page.getByLabel("Proposal revision session").textContent() ?? "").includes("2 proposal resources open"));
            const revisionInspector = page.locator('section[aria-label^="Comparison for "]');
            await revisionInspector.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
            check("revision inspector compares submitted content with MY WORK", (await revisionInspector.textContent() ?? "").includes("SUBMITTED VERSION") && (await revisionInspector.textContent() ?? "").includes("MY WORK NOW"));
            await page.locator('[data-testid="tab-bar"] [data-testid="tab"]').nth(1).click();
            await waitForText(revisionInspector, (text) => text.includes("governance-context.md"), "companion artifact comparison");
            const revisionNote = page.locator('[data-testid="markdown-textarea"]');
            await revisionNote.fill("# Governance context\n\nCompanion proposal resource.\n\nREVISIONNOTECHANGE");
            await waitForServerContent(page, projectName, (content) => content.includes("REVISIONNOTECHANGE"), "the revision markdown edit", contextId);
            await waitForText(revisionInspector, (text) => text.includes("REVISIONNOTECHANGE"), "revision markdown diff refresh");
            const addedNoteLines = revisionInspector.locator(".proposal-detail__side-by-side .proposal-review__line--added").filter({ hasText: "REVISIONNOTECHANGE" });
            check("side-by-side marks changed note lines as additions", await addedNoteLines.count() === 1, `added=${await addedNoteLines.count()}`);
            await page.locator('[data-testid="tab-bar"] [data-testid="tab"]').first().click();
            await waitForText(revisionInspector, (text) => text.includes(".seq"), "diagram comparison restored");
            await page.getByRole("button", { name: /Review and submit/ }).click();
            const revisionReview = page.locator('section[aria-label="Submit architectural proposal"]');
            await revisionReview.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
            await waitForText(revisionReview, (text) => text.includes("governance-context.md"), "revision resource scope hydration");
            check("final submission review keeps editor tabs and comparison mounted", await page.locator('[data-testid="tab-bar"] [data-testid="tab"]').count() === 2 && await revisionInspector.isVisible());
            check("revision review is prefilled with proposal metadata and scope", await page.getByLabel("Proposal title").inputValue() === proposalTitle && await revisionReview.locator('input[type="checkbox"]:checked').count() === 2);
            await page.getByLabel("Proposal description").fill("Revision review survives returning to the editor.");
            await page.getByRole("button", { name: "Back to editing" }).click();
            check("returning from submission review keeps both artifact tabs", await page.locator('[data-testid="tab-bar"] [data-testid="tab"]').count() === 2);
            await page.getByRole("button", { name: /Review and submit/ }).click();
            check("submission review retains edits made before returning", await page.getByLabel("Proposal description").inputValue() === "Revision review survives returning to the editor.");
             await page.getByRole("button", { name: "Back to editing" }).click();
         const myWorkToggle = page.locator('[data-testid="explorer-my-work-toggle"]');
        if ((await myWorkToggle.getAttribute("aria-expanded")) !== "true") await myWorkToggle.click();
        await page.locator('.explorer__context-note').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
         await page.locator('[data-testid="explorer-my-work-section"] [data-testid="explorer-diagram"]').first().click();
         await editor.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
          const afterRevise = await proposalById(project.id, v1.id);
          check("Revise opens MY WORK for editing", await editor.isVisible());
          check("revision context remains visible after resource selection", await page.getByRole("button", { name: "Back to proposal" }).isVisible());
           await page.getByRole("button", { name: "Back to proposal" }).click();
            await page.getByRole("button", { name: "Impact", exact: true }).click();
            const restoredChange = page.locator('section[aria-label="Changes"] button').filter({ hasText: /\.seq/ }).first();
          const restoredInspector = page.locator('section[aria-label^="Comparison for "]');
          check("back restores the selected change", await restoredChange.getAttribute("aria-pressed") === "true");
          check("back restores the inspector mode", await restoredInspector.getByRole("button", { name: "Compare", exact: true }).getAttribute("aria-pressed") === "true");
          check("back to proposal does not submit revision", (await proposalById(project.id, v1.id)).lifecycle?.state === "OPEN");
           await page.getByRole("button", { name: "Edit revision" }).click();
         await page.locator('[data-testid="explorer-my-work-section"] [data-testid="explorer-diagram"]').first().click();
         await editor.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        check("Revise alone leaves v1 OPEN", afterRevise.lifecycle?.state === "OPEN");
        check(
          "Revise alone leaves SHARED unchanged",
          (await currentServerResource(page, projectName)).content === sharedBefore.content,
        );

        await editor.fill(
          [
            "title Governed proposal v2",
            "participant Browser",
            "participant Service",
            `Browser ->> Service: ${v2Marker}`,
            "",
          ].join("\n"),
        );
        await waitForServerContent(
          page,
          projectName,
          (content) => content.includes(v2Marker),
          "the v2 MY WORK edit",
          contextId,
        );
        await openServerProject(page, projectName);
        await submitFromMyWork(proposalTitle, "Revised governed snapshot", true);
        const proposalsAfterRevision = await projectProposals(project.id);
        const v2 = proposalsAfterRevision.find(
          (proposal) => proposal.supersedesProposalId === v1.id,
        );
        if (!v2?.id) throw new Error("v2 proposal id was not linked to v1");
        check("v2 is tracked by a distinct proposal id", v2.id !== v1.id);
        const v1AfterRevision = await proposalById(project.id, v1.id);
        const v2AfterRevision = await proposalById(project.id, v2.id);
        check("revised submission supersedes v1", v1AfterRevision.lifecycle?.state === "SUPERSEDED");
        check("revised submission leaves v2 OPEN", v2AfterRevision.lifecycle?.state === "OPEN");
        check("v2 references predecessor v1", v2AfterRevision.supersedes?.id === v1.id);
        const v2Reviews = await apiRequest(
          page,
          `/api/architectural-proposals/${v2.id}/reviews?projectId=${project.id}`,
        );
        check("v2 starts with zero reviews", (v2Reviews.json?.reviews?.reviews ?? []).length === 0);
        check(
          "SHARED is unchanged after revised submission",
          (await currentServerResource(page, projectName)).content === sharedBefore.content,
        );

        await openServerProject(page, projectName);
        await openProposalFromExplorer("OPEN");
        await page.locator('section[aria-label="Architectural Proposal"]')
          .getByRole("button", { name: proposalTitle })
          .click();
        await waitForText(
          page.locator('section[aria-label="Architectural Proposal"]'),
          (text) => text.includes("SUPERSEDED"),
          "v1 superseded detail",
        );
        const v1Detail = await proposalById(project.id, v1.id);
        check("v1 remains readable after supersession", v1Detail.resources.length > 0);
        check("v1 references successor v2", v1Detail.supersededBy?.id === v2.id);

        await page.locator('section[aria-label="Architectural Proposal"]')
          .getByRole("button", { name: proposalTitle })
          .click();
         await waitForText(
           page.locator('section[aria-label="Architectural Proposal"]'),
           (text) => text.includes("OPEN"),
           "v2 open detail",
         );
        const v2AuthorDetail = page.locator('section[aria-label="Architectural Proposal"]');
         check(
           "author cannot approve v2",
           (await v2AuthorDetail.getByRole("button", { name: "Approve proposal" }).count()) === 0,
        );
        check(
          "v2 communicates independent review is required",
          (await page.locator('section[aria-label="Proposal review"]').textContent() ?? "").includes("cannot approve your own proposal"),
        );
         check(
            "v2 exposes its canonical diff in the right-hand inspector",
            await page.locator('section[aria-label^="Comparison for "]').count() > 0 &&
              await page.locator('.proposal-detail__comparison').count() === 0,
          );
           await page.getByRole("button", { name: "Impact", exact: true }).click();
           await v2AuthorDetail.locator('section[aria-label="Changes"] button').filter({ hasText: /\.seq/ }).first().click();
           await page.getByRole("button", { name: "Review", exact: true }).click();
          const inspector = page.locator('section[aria-label^="Comparison for "]');
         await inspector.getByRole("button", { name: "Compare", exact: true }).click();
         check("diagram inspector switches comparison mode", await inspector.getByRole("button", { name: "Compare", exact: true }).getAttribute("aria-pressed") === "true");
           await page.getByRole("button", { name: "Preview promotion" }).click();
        await waitForText(
          page.locator('section[aria-label="Proposal promotion"]'),
          (text) => text.includes("REVIEW REQUIRED"),
          "pre-review promotion preview",
        );
        check("promotion is blocked by REVIEW_REQUIRED before independent approval", true);

        await reviewerPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        await waitForAuthEntry(reviewerPage);
        await signIn(reviewerPage, idp, viewer);
        const reviewerMe = await apiRequest(reviewerPage, "/api/me");
        const reviewerId = reviewerMe.json?.user?.id;
        check(
          "Reviewer B is a distinct authenticated identity",
          typeof reviewerId === "string" && reviewerId !== "" && reviewerId !== v1.authorUserId,
        );
        const projectDetails = await apiRequest(
          page,
          `/api/projects/${project.id}`,
        );
        const workspaceId = projectDetails.json?.project?.workspaceId;
        const reviewerWorkspaceMembership = await apiRequest(
          page,
          `/api/workspaces/${workspaceId}/members/${reviewerId}`,
          { method: "PUT", body: JSON.stringify({ role: "EDITOR" }) },
        );
        check(
          "the owner establishes Reviewer B workspace authority",
          reviewerWorkspaceMembership.status === 200,
          `status ${reviewerWorkspaceMembership.status}`,
        );
        const reviewerMembership = await apiRequest(
          page,
          `/api/projects/${project.id}/members/${reviewerId}`,
          { method: "PUT", body: JSON.stringify({ role: "EDITOR" }) },
        );
        check(
          "the owner establishes Reviewer B project authority",
          reviewerMembership.status === 204,
          `status ${reviewerMembership.status}`,
        );

        await reviewerPage.reload({ waitUntil: "domcontentloaded" });
        await openServerProject(reviewerPage, projectName);
        const reviewerProposalsToggle = reviewerPage.locator('[data-testid="explorer-proposals-toggle"]');
        if ((await reviewerProposalsToggle.getAttribute("aria-expanded")) !== "true") await reviewerProposalsToggle.click();
        const reviewerRow = reviewerPage
          .locator('[data-testid="explorer-proposal"]')
          .filter({ hasText: proposalTitle })
          .filter({ hasText: "OPEN" });
        await reviewerRow.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await reviewerRow.locator('[data-testid="explorer-proposal-open"]').click();
        await waitForText(
          reviewerPage.locator('section[aria-label="Architectural Proposal"]'),
          (text) => text.includes("OPEN"),
          "Reviewer B opens v2",
        );
        const reviewerDetail = reviewerPage.locator('section[aria-label="Architectural Proposal"]');
        await waitForText(
          reviewerPage.locator('section[aria-label="Proposal review"]'),
          (text) => text.includes("Review state"),
          "Reviewer B proposal review hydration",
        );
        await reviewerPage.locator('[aria-label^="Comparison for "]').waitFor({
          state: "attached",
          timeout: UI_TIMEOUT_MS,
        });
        check(
          "Reviewer B opens exactly v2",
          (await reviewerDetail.locator("h2").textContent() ?? "") === proposalTitle &&
            new URL(reviewerPage.url()).searchParams.get("proposal") === v2.id,
        );
        check(
           "Reviewer B sees the canonical proposal diff in the inspector",
           await reviewerPage.locator('section[aria-label^="Comparison for "]').count() > 0 &&
             await reviewerPage.locator('.proposal-detail__comparison').count() === 0,
        );
        const reviewerProposal = await apiRequest(
          reviewerPage,
          `/api/architectural-proposals/${v2.id}?projectId=${project.id}`,
        );
        check(
          "Reviewer B has the existing review capability",
          reviewerProposal.json?.proposal?.capabilities?.["proposal.review"]?.allowed === true,
          JSON.stringify(reviewerProposal.json?.proposal?.capabilities?.["proposal.review"] ?? null),
        );
        await waitForText(
          reviewerPage.locator('section[aria-label="Proposal review"]'),
          (text) => text.includes("Approve proposal") || text.includes("Request changes") || text.includes("Review unavailable"),
          "Reviewer B review action hydration",
        );
        const reviewButtonTexts = await reviewerPage.locator('section[aria-label="Proposal review"] button').allTextContents();
        check("Reviewer B can approve v2", reviewButtonTexts.includes("Approve proposal"), JSON.stringify(reviewButtonTexts));
        await reviewerDetail.locator("textarea").fill("Independent review approved.", { force: true });
        await reviewerPage.locator('section[aria-label="Proposal review"] button').filter({ hasText: "Approve proposal" }).evaluate((button) => button.click());
        await waitForText(
          reviewerPage.locator('section[aria-label="Proposal review"]'),
          (text) => text.includes("1 approvals"),
          "Reviewer B approval evidence",
        );
        const approvedReviews = await apiRequest(
          reviewerPage,
          `/api/architectural-proposals/${v2.id}/reviews?projectId=${project.id}`,
        );
        const reviewEntries = approvedReviews.json?.reviews?.reviews ?? [];
        check("approval is recorded against v2", reviewEntries.length === 1 && reviewEntries[0].decision === "APPROVE");
        check(
          "approval identifies Reviewer B",
          reviewEntries[0]?.reviewerUserId === reviewerId &&
            (reviewEntries[0]?.reviewerDisplayName === viewer.name || reviewEntries[0]?.reviewerDisplayName === undefined),
        );
        check(
          "v1 has no transferred reviews",
          ((await apiRequest(page, `/api/architectural-proposals/${v1.id}/reviews?projectId=${project.id}`)).json?.reviews?.reviews ?? []).length === 0,
        );
        await reviewerPage.reload({ waitUntil: "domcontentloaded" });
        await waitForAuthEntry(reviewerPage);
        await reviewerPage.locator('[data-testid="workspace-active-project"]')
          .filter({ hasText: projectName })
          .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        const reloadedReviewerToggle = reviewerPage.locator('[data-testid="explorer-proposals-toggle"]');
        if ((await reloadedReviewerToggle.getAttribute("aria-expanded")) !== "true") await reloadedReviewerToggle.click();
        const reloadedReviewerRow = reviewerPage
          .locator('[data-testid="explorer-proposal"]')
          .filter({ hasText: proposalTitle })
          .filter({ hasText: "APPROVED" });
        await reloadedReviewerRow.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await reloadedReviewerRow.locator('[data-testid="explorer-proposal-open"]').evaluate((button) => button.click());
        await waitForText(
          reviewerPage.locator('section[aria-label="Proposal review"]'),
          (text) => text.includes("1 approvals"),
          "approval evidence after reload",
        );
        check("approval survives Reviewer B reload", true);
        check(
          "approval leaves SHARED unchanged",
          (await currentServerResource(reviewerPage, projectName)).content === sharedBefore.content,
        );

        await page.reload({ waitUntil: "domcontentloaded" });
        await waitForAuthEntry(page);
        await page.locator('[data-testid="workspace-active-project"]')
          .filter({ hasText: projectName })
          .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await openProposalFromExplorer("APPROVED");
        const postReviewPreview = await apiRequest(
          page,
          `/api/architectural-proposals/${v2.id}/promotion?projectId=${project.id}`,
        );
        const promotion = postReviewPreview.json?.promotion;
        check("promotion preview is available after independent approval", postReviewPreview.status === 200);
        check(
          "REVIEW_REQUIRED is absent after independent approval",
          !promotion?.blockers?.some((blocker) => blocker.code === "REVIEW_REQUIRED"),
        );
        check("promotion was not executed", !(await proposalById(project.id, v2.id)).promotion);

      } finally {
        await context.close();
        await reviewerContext.close();
      }
    },
  );

  await scenario("Authenticated Conceptual authoring and promotion lifecycle", async () => {
    const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
    const reviewerContext = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
    const page = await ownerContext.newPage();
    const reviewerPage = await reviewerContext.newPage();
    const projectName = "Conceptual Authenticated E2E";
    const proposalTitle = "Rename customer concept";
    const base = 'title "Customer model"\nconcept customer "Customer"\nconcept order "Order"\nrelation places customer -> order "places"\n';
    const renamed = base.replace('concept customer "Customer"', 'concept customer "Account Holder"');
    let projectId = null;

    try {
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(page);
      await signIn(page, idp, owner);
      const workspaceId = (await apiRequest(page, "/api/workspaces")).json.workspaces[0].id;
      const created = await apiRequest(page, "/api/projects/bootstrap", {
        method: "POST",
        body: JSON.stringify({ workspaceId, name: projectName, resources: [{ path: "customers.concept", type: "conceptual", content: base }] }),
      });
      if (created.status !== 201) throw new Error(`Conceptual bootstrap failed: ${created.status} ${created.text}`);
      projectId = created.json.project.id;
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAuthEntry(page);
      await page.locator('[data-testid="workspace-server-projects-loading"]').waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
      await openServerProject(page, projectName);

      const sharedButton = page.getByRole("button", { name: "Load diagram Customer model" });
      await sharedButton.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await sharedButton.click();
      await page.getByTestId("conceptual-preview-svg").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const sharedSvg = page.getByTestId("conceptual-preview-svg");
      await waitForText(sharedSvg, text => text.includes("Customer") && text.includes("Order") && text.includes("places"), "SHARED Conceptual preview");
      const conceptualPane = await page.getByTestId("viewport-pane").evaluate(element => {
        const pane = element.getBoundingClientRect();
        const minimap = element.parentElement.querySelector('[data-testid="minimap"]').getBoundingClientRect();
        return { paneHeight: pane.height, paneTop: pane.top, paneBottom: pane.bottom, minimapTop: minimap.top, minimapBottom: minimap.bottom };
      });
      check("Conceptual canvas has real viewport height", conceptualPane.paneHeight > 100, `height=${conceptualPane.paneHeight}`);
      check("Conceptual minimap stays inside its canvas", conceptualPane.minimapTop >= conceptualPane.paneTop && conceptualPane.minimapBottom <= conceptualPane.paneBottom);
      check("authenticated SHARED selects and renders its Conceptual artifact", true);
      check("SHARED directed relationship is visible", await sharedSvg.locator("marker").count() > 0);
      check("authenticated workspace shell remains mounted", await page.getByTestId("app-shell").isVisible());
      check("resource header identifies the selected Conceptual resource", (await page.getByTestId("resource-header").textContent()).includes("customers.concept"));
      const sharedBefore = await currentServerResource(page, projectName);

      // Resource creation is intentionally API/bootstrap-backed today; from this point
      // selection, editing, submission, review and promotion use the production UI.
      await page.getByTestId("explorer-my-work-create").click();
      await page.getByRole("dialog", { name: "Create MY WORK draft" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByLabel("Draft name").fill("conceptual-authoring-work");
      await page.getByRole("button", { name: "Create draft" }).click();
      const contexts = await apiRequest(page, `/api/projects/${projectId}/private-work`);
      const work = contexts.json.contexts.find(entry => entry.name === "conceptual-authoring-work");
      if (!work) throw new Error("MY WORK context was not created");
      const workResource = await apiRequest(page, `/api/projects/${projectId}/resources`, {
        method: "POST",
        body: JSON.stringify({ contextId: work.id, path: "customers.concept", type: "conceptual", content: base }),
      });
      if (workResource.status !== 201) throw new Error(`MY WORK Conceptual creation failed: ${workResource.status} ${workResource.text}`);
      // The resource is added outside the UI, so reopen the project to refresh its resource tree.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator('[data-testid="workspace-active-project"]').filter({ hasText: projectName }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.locator(".explorer__context-note").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.locator('[data-testid="explorer-my-work-section"] [data-testid="explorer-diagram"]').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.locator('[data-testid="explorer-my-work-section"] [data-testid="select-diagram-button"]').click();
      await showEditor(page);
      const editor = page.getByTestId("dsl-textarea");
      await editor.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByTestId("conceptual-preview-svg").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("MY WORK Conceptual resource is selected with editor and preview", true);

      await editor.fill(renamed);
      const editedSvg = page.getByTestId("conceptual-preview-svg");
      await waitForText(editedSvg, text => text.includes("Account Holder") && text.includes("Order") && text.includes("places"), "renamed Conceptual preview");
      check("stable customer ID rename updates canonical preview and preserves relationship", true);
      const selectedConcept = editedSvg.locator('[data-node-id="customer"]');
      await selectedConcept.click();
      await page.waitForFunction(() => {
        const editor = document.querySelector('[data-testid="dsl-textarea"]');
        return editor instanceof HTMLTextAreaElement && editor.value.slice(editor.selectionStart, editor.selectionEnd).includes("concept customer");
      }, undefined, { timeout: UI_TIMEOUT_MS });
      check("Conceptual preview selection reveals its source declaration", true);
      check("editing MY WORK leaves SHARED source unchanged", (await currentServerResource(page, projectName)).content === sharedBefore.content);

      await editor.fill(renamed.replace('relation places customer -> order "places"', 'relation places customer -> missing "places"'));
      await page.locator('[data-testid="dsl-diagnostics"]').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("invalid Conceptual source reports semantic diagnostics without crashing", await page.getByTestId("conceptual-preview-invalid").isVisible() && await page.getByTestId("app-shell").isVisible());
      await editor.fill(renamed);
      await waitForText(page.getByTestId("conceptual-preview-svg"), text => text.includes("Account Holder") && text.includes("places"), "restored valid Conceptual preview");

      const myWorkToggle = page.getByTestId("explorer-my-work-toggle");
      if ((await myWorkToggle.getAttribute("aria-expanded")) !== "true") await myWorkToggle.click();
      const workRow = page.getByTestId("explorer-private-context");
      await workRow.getByRole("button", { name: /Actions for MY WORK/ }).click();
      await page.getByRole("menuitem", { name: "Create proposal from this draft…" }).click();
      const submitDialog = page.locator('section[aria-label="Submit architectural proposal"]');
      await submitDialog.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByLabel("Proposal title").fill(proposalTitle);
      await page.getByLabel("Proposal description").fill("Stable-ID Conceptual rename.");
      await submitDialog.locator('input[type="checkbox"]').check();
      await page.getByRole("button", { name: "Submit proposal for review" }).click();
      await page.locator('section[aria-label="Architectural Proposal"] h2').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const proposalList = (await apiRequest(page, `/api/projects/${projectId}/architectural-proposals`)).json.proposals;
      const proposal = proposalList.find(entry => entry.title === proposalTitle);
      if (!proposal) throw new Error("submitted Conceptual proposal was not discoverable");
      const snapshot = await apiRequest(page, `/api/architectural-proposals/${proposal.id}?projectId=${projectId}`);
      check("proposal submission stores the Conceptual snapshot while SHARED stays unchanged", snapshot.status === 200 && snapshot.json.proposal.resources.some(resource => resource.content === renamed) && (await currentServerResource(page, projectName)).content === sharedBefore.content);
      const proposalDiff = await apiRequest(page, `/api/architectural-proposals/${proposal.id}/diff?projectId=${projectId}`);
      const diffResource = proposalDiff.json.diff.resources.find(resource => resource.path === "customers.concept");
      check("proposal diff uses immutable SHARED base and submitted snapshot", diffResource.baseContent === base && diffResource.proposedContent === renamed);

      const reviewer = { sub: "e2e-conceptual-reviewer", name: "Conceptual Reviewer B", email: "conceptual-reviewer@e2e.test" };
      await reviewerPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(reviewerPage);
      await signIn(reviewerPage, idp, reviewer);
      const reviewerId = (await apiRequest(reviewerPage, "/api/me")).json.user.id;
      check("Reviewer B is an independent identity", reviewerId !== proposal.authorUserId);
      const projectDetails = await apiRequest(page, `/api/projects/${projectId}`);
      const workspaceMembership = await apiRequest(page, `/api/workspaces/${projectDetails.json.project.workspaceId}/members/${reviewerId}`, { method: "PUT", body: JSON.stringify({ role: "EDITOR" }) });
      check("owner establishes Reviewer B workspace authority", workspaceMembership.status === 200, `status ${workspaceMembership.status}`);
      const projectMembership = await apiRequest(page, `/api/projects/${projectId}/members/${reviewerId}`, { method: "PUT", body: JSON.stringify({ role: "EDITOR" }) });
      check("owner establishes Reviewer B project authority", projectMembership.status === 204, `status ${projectMembership.status}`);
      await reviewerPage.reload({ waitUntil: "domcontentloaded" });
      await openServerProject(reviewerPage, projectName);
      const proposalToggle = reviewerPage.getByTestId("explorer-proposals-toggle");
      if ((await proposalToggle.getAttribute("aria-expanded")) !== "true") await proposalToggle.click();
      const proposalRow = reviewerPage.getByTestId("explorer-proposal").filter({ hasText: proposalTitle }).filter({ hasText: "OPEN" });
      await proposalRow.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await proposalRow.getByTestId("explorer-proposal-open").click();
      await reviewerPage.waitForFunction(id => new URL(location.href).searchParams.get("proposal") === id, proposal.id, { timeout: UI_TIMEOUT_MS });
      const restoreDetails = reviewerPage.getByRole("button", { name: "Show proposal details" });
      if (await restoreDetails.isVisible()) await restoreDetails.click();
      const reviewerDetail = reviewerPage.locator('section[aria-label="Architectural Proposal"]');
      await waitForText(reviewerDetail, text => text.includes(proposalTitle) || text.includes("could not be loaded"), "Reviewer B proposal detail hydration");
      check("Reviewer B proposal detail loaded", (await reviewerDetail.textContent()).includes(proposalTitle), await reviewerDetail.textContent());
      await reviewerDetail.locator('nav[aria-label="Proposal details"] button').filter({ hasText: "Impact" }).evaluate(button => button.click());
      await reviewerPage.locator('[data-testid="proposal-impact"]').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const impactText = await reviewerPage.locator('[data-testid="proposal-impact"]').textContent();
      check("Reviewer B sees Conceptual semantic impact", impactText.includes("1 modified") && impactText.includes("semantic identities affected"), impactText);
      await reviewerPage.locator('section[aria-label="Changes"] button').filter({ hasText: "customers.concept" }).click();
      await reviewerDetail.locator('nav[aria-label="Proposal details"] button').filter({ hasText: "Review" }).click({ force: true });
      const inspector = reviewerPage.locator('section[aria-label^="Comparison for "]');
      await inspector.getByRole("button", { name: "Compare", exact: true }).click();
      await reviewerPage.getByTestId("conceptual-preview-svg").first().waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("Reviewer B can inspect Conceptual visual comparison", (await inspector.getByRole("button", { name: "Compare", exact: true }).getAttribute("aria-pressed")) === "true");
      check("stable-ID rename remains visible in the Conceptual comparison", (await inspector.textContent()).includes("Account Holder") && (await inspector.textContent()).includes("Customer"));

      const promotionPreview = await apiRequest(reviewerPage, `/api/architectural-proposals/${proposal.id}/promotion?projectId=${projectId}`);
      check("approval action requires independent review capability", promotionPreview.status === 200);
      await reviewerDetail.locator("textarea").fill("Reviewed Conceptual identity and relationship.", { force: true });
      await reviewerPage.locator('section[aria-label="Proposal review"] button').filter({ hasText: "Approve proposal" }).click();
      await waitForText(reviewerPage.locator('section[aria-label="Proposal review"]'), text => text.includes("1 approvals"), "Reviewer B approval evidence");
      check("approval records Reviewer B and leaves SHARED source and render unchanged", (await currentServerResource(reviewerPage, projectName)).content === sharedBefore.content && (await page.getByTestId("conceptual-preview-svg").first().textContent()).includes("Customer"));

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAuthEntry(page);
      await page.locator('[data-testid="workspace-active-project"]')
        .filter({ hasText: projectName })
        .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByTestId("workspace-back-to-projects").click();
      const workspaceSelect = page.getByTestId("workspace-server-workspace-select");
      await workspaceSelect.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await workspaceSelect.selectOption(projectDetails.json.project.workspaceId);
      const ownerProjectsReload = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "GET"
          && url.pathname === "/api/projects"
          && url.searchParams.get("workspaceId") === projectDetails.json.project.workspaceId;
      });
      await page.getByTestId("workspace-server-refresh").click();
      await ownerProjectsReload;
      await page.locator('[data-testid="workspace-server-projects-loading"]').waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
      await openServerProject(page, projectName);
      const ownerProposalsToggle = page.getByTestId("explorer-proposals-toggle");
      if ((await ownerProposalsToggle.getAttribute("aria-expanded")) !== "true") await ownerProposalsToggle.click();
      await page.getByTestId("explorer-proposal").filter({ hasText: proposalTitle }).getByTestId("explorer-proposal-open").click();
      const ownerRestoreDetails = page.getByRole("button", { name: "Show proposal details" });
      if (await ownerRestoreDetails.isVisible()) await ownerRestoreDetails.click();

      await page.getByRole("button", { name: "Preview promotion" }).click();
      await waitForText(page.locator('section[aria-label="Proposal promotion"]'), text => text.includes("Ready to promote"), "promotion readiness");
      await page.getByRole("button", { name: "Promote to SHARED" }).click();
      await waitForText(page.locator('section[aria-label="Architectural Proposal"]'), text => text.includes("PROMOTED"), "proposal promotion");
      const promoted = await currentServerResource(reviewerPage, projectName);
      check("explicit promotion updates authoritative SHARED Conceptual source", promoted.content === renamed);
      await page.getByRole("button", { name: "Base status", exact: true }).click();
      await page.getByRole("button", { name: "Open resulting SHARED knowledge" }).click();
      await page.locator('[data-testid="explorer-shared-section"] [data-testid="select-diagram-button"]').click();
      await waitForText(page.getByTestId("conceptual-preview-svg"), text => text.includes("Account Holder") && text.includes("Order") && text.includes("places"), "promoted SHARED Conceptual rendering");
      check("post-promotion SHARED render shows the new Conceptual state", true);
    } finally {
      if (projectId) await apiRequest(page, `/api/projects/${projectId}`, { method: "DELETE" });
      await ownerContext.close();
      await reviewerContext.close();
    }
  });

  await scenario("Authenticated Database authoring and promotion lifecycle", async () => {
    const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
    const reviewerContext = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
    const page = await ownerContext.newPage();
    const reviewerPage = await reviewerContext.newPage();
    const projectName = "Database Authenticated E2E";
    const proposalTitle = "Rename customer table";
    const base = [
      'title "Billing schema"', 'schema billing "billing"',
      'table customer billing "Customer"', 'column customer customer_id "id" {uuid} not-null', 'primary-key customer_pk customer (id)',
      'table invoice billing "Invoice"', 'column invoice invoice_id "id" {uuid} not-null', 'column invoice invoice_customer_id "customer_id" {uuid} not-null',
      'primary-key invoice_pk invoice (id)', 'foreign-key invoice_customer invoice (customer_id) -> customer (id)',
    ].join("\n");
    const renamed = base.replace('table customer billing "Customer"', 'table customer billing "AccountHolder"');
    let projectId = null;

    try {
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(page);
      await signIn(page, idp, owner);
      const workspaceId = (await apiRequest(page, "/api/workspaces")).json.workspaces[0].id;
      const created = await apiRequest(page, "/api/projects/bootstrap", {
        method: "POST",
        body: JSON.stringify({ workspaceId, name: projectName, resources: [{ path: "billing.dbschema", type: "database", content: base }] }),
      });
      if (created.status !== 201) throw new Error(`Database bootstrap failed: ${created.status} ${created.text}`);
      projectId = created.json.project.id;
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAuthEntry(page);
      await page.locator('[data-testid="workspace-server-projects-loading"]').waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
      await openServerProject(page, projectName);

      await page.getByRole("button", { name: "Load diagram Billing schema" }).click();
      const sharedSvg = page.getByTestId("database-preview-svg");
      await sharedSvg.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await waitForText(sharedSvg, text => text.includes("Customer") && text.includes("Invoice") && text.includes("customer_id"), "SHARED Database preview");
      check("authenticated SHARED Database uses canonical renderer and retains schema facts", await page.getByTestId("app-shell").isVisible() && (await sharedSvg.locator("svg").getAttribute("aria-label")) === "Database Diagram" && (await sharedSvg.textContent()).includes("billing.Customer") && (await sharedSvg.locator('[data-edge-id="invoice_customer"]').count()) === 1);
      const sharedBefore = await currentServerResource(page, projectName);
      check("SHARED Database source starts at the canonical fixture", sharedBefore.content === base);
      const sharedObserver = await ownerContext.newPage();
      await sharedObserver.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(sharedObserver);
      await openServerProject(sharedObserver, projectName);
      await sharedObserver.getByRole("button", { name: "Load diagram Billing schema" }).click();
      const observedSharedSvg = sharedObserver.getByTestId("database-preview-svg");
      await observedSharedSvg.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const sharedRenderBefore = await observedSharedSvg.textContent();

      await page.getByTestId("explorer-my-work-create").click();
      await page.getByRole("dialog", { name: "Create MY WORK draft" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByLabel("Draft name").fill("database-authoring-work");
      await page.getByRole("button", { name: "Create draft" }).click();
      const contexts = await apiRequest(page, `/api/projects/${projectId}/private-work`);
      const work = contexts.json.contexts.find(entry => entry.name === "database-authoring-work");
      if (!work) throw new Error("Database MY WORK context was not created");
      const workResource = await apiRequest(page, `/api/projects/${projectId}/resources`, {
        method: "POST",
        body: JSON.stringify({ contextId: work.id, path: "billing.dbschema", type: "database", content: base }),
      });
      if (workResource.status !== 201) throw new Error(`MY WORK Database creation failed: ${workResource.status} ${workResource.text}`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator('[data-testid="workspace-active-project"]').filter({ hasText: projectName }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.locator(".explorer__context-note").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const privateRow = page.locator('[data-testid="explorer-my-work-section"] [data-testid="explorer-diagram"]');
      await privateRow.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await privateRow.locator('[data-testid="select-diagram-button"]').click();
      await showEditor(page);
      const editor = page.getByTestId("dsl-textarea");
      await editor.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByTestId("database-preview-svg").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const databasePaneHeight = await page.getByTestId("viewport-pane").evaluate(element => element.getBoundingClientRect().height);
      check("Database canvas retains real viewport height", databasePaneHeight > 100, `height=${databasePaneHeight}`);
      check("MY WORK Database retains its source editor and canonical preview", true);

      await editor.fill(renamed);
      await waitForText(page.getByTestId("database-preview-svg"), text => text.includes("AccountHolder") && text.includes("Invoice") && text.includes("invoice_customer"), "renamed MY WORK Database preview");
      check("stable table ID rename updates MY WORK render and preserves FK", true);
      check("MY WORK edit leaves SHARED Database source unchanged", (await currentServerResource(page, projectName)).content === sharedBefore.content);
      const selectedTable = page.getByTestId("database-preview-svg").locator('[data-node-id="customer"]');
      await selectedTable.click();
      await page.waitForFunction(() => {
        const sourceEditor = document.querySelector('[data-testid="dsl-textarea"]');
        return sourceEditor instanceof HTMLTextAreaElement && sourceEditor.value.slice(sourceEditor.selectionStart, sourceEditor.selectionEnd).includes("table customer");
      }, undefined, { timeout: UI_TIMEOUT_MS });
      check("Database table selection navigates by stable table ID to source", true);

      const myWorkToggle = page.getByTestId("explorer-my-work-toggle");
      if ((await myWorkToggle.getAttribute("aria-expanded")) !== "true") await myWorkToggle.click();
      const workRow = page.getByTestId("explorer-private-context");
      await workRow.getByRole("button", { name: /Actions for MY WORK/ }).click();
      await page.getByRole("menuitem", { name: "Create proposal from this draft…" }).click();
      const submitDialog = page.locator('section[aria-label="Submit architectural proposal"]');
      await submitDialog.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByLabel("Proposal title").fill(proposalTitle);
      await page.getByLabel("Proposal description").fill("Stable-ID Database table rename; preserve invoice FK.");
      await submitDialog.locator('input[type="checkbox"]').check();
      await page.getByRole("button", { name: "Submit proposal for review" }).click();
      await page.locator('section[aria-label="Architectural Proposal"] h2').waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const proposalList = (await apiRequest(page, `/api/projects/${projectId}/architectural-proposals`)).json.proposals;
      const proposal = proposalList.find(entry => entry.title === proposalTitle);
      if (!proposal) throw new Error("submitted Database proposal was not discoverable");
      const snapshot = await apiRequest(page, `/api/architectural-proposals/${proposal.id}?projectId=${projectId}`);
      check("Database proposal snapshot contains MY WORK rename and SHARED remains unchanged", snapshot.status === 200 && snapshot.json.proposal.resources.some(resource => resource.content === renamed) && (await currentServerResource(page, projectName)).content === base);
      const laterMyWork = renamed.replace('table customer billing "AccountHolder"', 'table customer billing "OwnerWorkOnly"');
      const currentMyWorkBeforeUpdate = await apiRequest(page, `/api/projects/${projectId}/resources/${workResource.json.resource.id}?contextId=${work.id}`);
      const workAfterSubmit = await apiRequest(page, `/api/projects/${projectId}/resources/${workResource.json.resource.id}`, {
        method: "PUT",
        body: JSON.stringify({ content: laterMyWork, contextId: work.id, expectedRevision: currentMyWorkBeforeUpdate.json.resource.revision }),
      });
      const currentMyWork = await apiRequest(page, `/api/projects/${projectId}/resources/${workResource.json.resource.id}?contextId=${work.id}`);
      check("post-submission MY WORK edit is accepted", workAfterSubmit.status === 200 && currentMyWork.json.content === laterMyWork, `${workAfterSubmit.status} ${workAfterSubmit.text}`);
      const readProposalDiff = async () => apiRequest(page, `/api/architectural-proposals/${proposal.id}/diff?projectId=${projectId}`);
      let proposalDiff = (await readProposalDiff()).json.diff;
      let diffResource = proposalDiff.resources.find(resource => resource.path === "billing.dbschema");
      check("Database diff uses immutable SHARED base and submitted snapshot, not current MY WORK", diffResource.baseContent === base && diffResource.proposedContent === renamed && !diffResource.proposedContent.includes("OwnerWorkOnly"));
      check("Database semantic diff classifies the stable-ID rename as one modified table", diffResource.content.changes.some(change => change.entity === "table" && change.identity === "customer" && change.kind === "modified") && !diffResource.content.changes.some(change => change.entity === "table" && change.kind === "added"));

      const reviewer = { sub: "e2e-database-reviewer", name: "Database Reviewer B", email: "database-reviewer@e2e.test" };
      await reviewerPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(reviewerPage);
      await signIn(reviewerPage, idp, reviewer);
      const reviewerId = (await apiRequest(reviewerPage, "/api/me")).json.user.id;
      check("Database Reviewer B is an independent identity", reviewerId !== proposal.authorUserId);
      const projectDetails = await apiRequest(page, `/api/projects/${projectId}`);
      const workspaceMembership = await apiRequest(page, `/api/workspaces/${projectDetails.json.project.workspaceId}/members/${reviewerId}`, { method: "PUT", body: JSON.stringify({ role: "EDITOR" }) });
      check("owner grants Database Reviewer B workspace access", workspaceMembership.status === 200);
      const projectMembership = await apiRequest(page, `/api/projects/${projectId}/members/${reviewerId}`, { method: "PUT", body: JSON.stringify({ role: "EDITOR" }) });
      check("owner grants Database Reviewer B project access", projectMembership.status === 204);
      await reviewerPage.reload({ waitUntil: "domcontentloaded" });
      await openServerProject(reviewerPage, projectName);
      const proposalToggle = reviewerPage.getByTestId("explorer-proposals-toggle");
      if ((await proposalToggle.getAttribute("aria-expanded")) !== "true") await proposalToggle.click();
      const proposalRow = reviewerPage.getByTestId("explorer-proposal").filter({ hasText: proposalTitle }).filter({ hasText: "OPEN" });
      await proposalRow.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await proposalRow.getByTestId("explorer-proposal-open").click();
      await reviewerPage.waitForFunction(id => new URL(location.href).searchParams.get("proposal") === id, proposal.id, { timeout: UI_TIMEOUT_MS });
      const restoreReviewerDetails = reviewerPage.getByRole("button", { name: "Show proposal details" });
      if (await restoreReviewerDetails.isVisible()) await restoreReviewerDetails.click();
      const reviewerDetail = reviewerPage.locator('section[aria-label="Architectural Proposal"]');
      await waitForText(reviewerDetail, text => text.includes(proposalTitle), "Database Reviewer B proposal detail");
      await reviewerDetail.locator('nav[aria-label="Proposal details"] button').filter({ hasText: "Impact" }).evaluate(button => button.click());
      const semanticImpact = reviewerPage.getByTestId("database-semantic-impact");
      await semanticImpact.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("Reviewer B sees Database stable-ID semantic impact", (await semanticImpact.textContent()).includes("1 table modified"));
      await reviewerPage.locator('section[aria-label="Changes"] button').filter({ hasText: "billing.dbschema" }).click();
      await reviewerDetail.locator('nav[aria-label="Proposal details"] button').filter({ hasText: "Review" }).click({ force: true });
      const inspector = reviewerPage.locator('section[aria-label="Comparison for billing.dbschema"]');
      await inspector.getByRole("button", { name: "Compare", exact: true }).click();
      await reviewerPage.getByTestId("database-preview-svg").first().waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const compared = await inspector.textContent();
      check("Reviewer B Compare renders the same table with its modified name", (await inspector.getByRole("button", { name: "Compare", exact: true }).getAttribute("aria-pressed")) === "true" && compared.includes("Customer") && compared.includes("AccountHolder"));
      check("Reviewer B comparison retains the invoice FK", compared.includes("invoice_customer") || (await inspector.locator('[data-edge-id="invoice_customer"]').count()) > 0);

      const prePromotion = await apiRequest(page, `/api/architectural-proposals/${proposal.id}/promotion?projectId=${projectId}`);
      await reviewerDetail.locator("textarea").fill("Reviewed stable table identity and preserved FK.", { force: true });
      await reviewerPage.locator('section[aria-label="Proposal review"] button').filter({ hasText: "Approve proposal" }).click();
      await waitForText(reviewerPage.locator('section[aria-label="Proposal review"]'), text => text.includes("1 approvals"), "Database Reviewer B approval evidence");
      const approved = await apiRequest(page, `/api/architectural-proposals/${proposal.id}/reviews?projectId=${projectId}`);
      const approvedReviews = approved.json?.reviews?.reviews ?? [];
      const approvedState = await currentServerResource(reviewerPage, projectName);
      check("Database approval is recorded and leaves SHARED source unchanged", approved.status === 200 && approvedReviews.some(review => review.decision === "APPROVE" && review.reviewerUserId === reviewerId) && approvedState.content === base);
      check("Database approval leaves the SHARED render unchanged", (await observedSharedSvg.textContent()) === sharedRenderBefore && (await observedSharedSvg.textContent()).includes("Customer"));

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAuthEntry(page);
      await page.locator('[data-testid="workspace-active-project"]').filter({ hasText: projectName }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByTestId("workspace-back-to-projects").click();
      const workspaceSelect = page.getByTestId("workspace-server-workspace-select");
      await workspaceSelect.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await workspaceSelect.selectOption(projectDetails.json.project.workspaceId);
      const ownerProjectsReload = page.waitForResponse(response => {
        const url = new URL(response.url());
        return response.request().method() === "GET" && url.pathname === "/api/projects" && url.searchParams.get("workspaceId") === projectDetails.json.project.workspaceId;
      });
      await page.getByTestId("workspace-server-refresh").click();
      await ownerProjectsReload;
      await page.locator('[data-testid="workspace-server-projects-loading"]').waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
      await openServerProject(page, projectName);
      const ownerProposalsToggle = page.getByTestId("explorer-proposals-toggle");
      if ((await ownerProposalsToggle.getAttribute("aria-expanded")) !== "true") await ownerProposalsToggle.click();
      await page.getByTestId("explorer-proposal").filter({ hasText: proposalTitle }).getByTestId("explorer-proposal-open").click();
      const restoreDetails = page.getByRole("button", { name: "Show proposal details" });
      if (await restoreDetails.isVisible()) await restoreDetails.click();
      await page.getByRole("button", { name: "Preview promotion" }).click();
      await waitForText(page.locator('section[aria-label="Proposal promotion"]'), text => text.includes("Ready to promote"), "Database promotion readiness");
      const readiness = await apiRequest(page, `/api/architectural-proposals/${proposal.id}/promotion?projectId=${projectId}`);
      const readinessBlockers = readiness.json?.promotion?.blockers ?? [];
      check("Database promotion readiness is separate and review requirement is satisfied", prePromotion.status === 200 && readiness.status === 200 && !readinessBlockers.some(blocker => blocker.code === "REVIEW_REQUIRED") && (await currentServerResource(page, projectName)).content === base);
      await page.getByRole("button", { name: "Promote to SHARED" }).click();
      await waitForText(page.locator('section[aria-label="Architectural Proposal"]'), text => text.includes("PROMOTED"), "Database proposal promotion");
      const promoted = await currentServerResource(page, projectName);
      check("explicit promotion applies submitted snapshot, not later MY WORK, and preserves FK", promoted.content === renamed && promoted.content.includes("invoice_customer") && promoted.content !== laterMyWork);
      await page.getByRole("button", { name: "Base status", exact: true }).click();
      await page.getByRole("button", { name: "Open resulting SHARED knowledge" }).click();
      await page.locator('[data-testid="explorer-shared-section"] [data-testid="select-diagram-button"]').click();
      const promotedSvg = page.getByTestId("database-preview-svg");
      await waitForText(promotedSvg, text => text.includes("AccountHolder") && text.includes("Invoice"), "promoted SHARED Database rendering");
      check("promoted SHARED Database render shows the renamed table and FK", (await promotedSvg.textContent()).includes("invoice_customer") || (await promotedSvg.locator('[data-edge-id="invoice_customer"]').count()) === 1);
      proposalDiff = (await readProposalDiff()).json.diff;
      diffResource = proposalDiff.resources.find(resource => resource.path === "billing.dbschema");
      check("promotion preserves immutable Database proposal base and snapshot", diffResource.baseContent === base && diffResource.proposedContent === renamed);
    } finally {
      if (projectId) await apiRequest(page, `/api/projects/${projectId}`, { method: "DELETE" });
      await ownerContext.close();
      await reviewerContext.close();
    }
  });

  await scenario("Semantic Binding Workspace authoring, governance, MCP and scoped Share", async () => {
    const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
    const reviewerContext = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
    const page = await ownerContext.newPage();
    const reviewerPage = await reviewerContext.newPage();
    const projectName = "Semantic Binding D03.2B E2E";
    const proposalTitle = "Explicit Project persistence representation";
    const conceptual = 'title "Domain"\nconcept project "Project"\nconcept project_settings "Project settings"\n';
    const privateConceptual = conceptual.replace('title "Domain"', 'title "MY WORK Domain"');
    const database = 'title "Persistence"\ntable projects - "projects"\ntable project_settings - "project settings"\n';
    let projectId = null;

    try {
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(page);
      await signIn(page, idp, owner);
      const workspaceId = (await apiRequest(page, "/api/workspaces")).json.workspaces[0].id;
      const created = await apiRequest(page, "/api/projects/bootstrap", { method: "POST", body: JSON.stringify({
        workspaceId, name: projectName, resources: [
          { path: "domain.concept", type: "conceptual", content: conceptual },
          { path: "schema.dbschema", type: "database", content: database },
          { path: "private-evidence.md", type: "markdown-document", content: "Sensitive evidence text outside the Share grant." },
        ],
      }) });
      if (created.status !== 201) throw new Error(`Semantic Binding project bootstrap failed: ${created.status} ${created.text}`);
      projectId = created.json.project.id;
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAuthEntry(page);
      await page.locator('[data-testid="workspace-server-projects-loading"]').waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
      await openServerProject(page, projectName);
      await page.getByRole("button", { name: "Load diagram Domain" }).click();
      await page.getByTestId("conceptual-preview-svg").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const panel = page.getByTestId("semantic-bindings");
      await page.getByRole("button", { name: "Restore analysis panels" }).click();
      await panel.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByTestId("conceptual-preview-svg").locator('[data-node-id="project"]').click();
      await panel.getByText("No explicit bindings for this entity.").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("initial Project has no explicit binding while any suggestion remains labeled unconfirmed", (await panel.getByTestId("semantic-candidates").textContent()).includes("Candidate · not a binding") && (await panel.locator('[data-testid^="semantic-binding-"]').count()) === 0 && (await panel.textContent()).includes("No explicit bindings"));
      await page.getByRole("button", { name: "Load diagram Persistence" }).click();
      const sharedDatabaseSvg = page.getByTestId("database-preview-svg");
      await sharedDatabaseSvg.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const databaseSelectionStyles = await sharedDatabaseSvg.locator(".database__table, .database__column, .database__fk").evaluateAll(nodes => nodes.map(node => ({
        className: node.getAttribute("class") ?? "",
        opacity: getComputedStyle(node).opacity,
      })));
      check("changing from Conceptual to Database clears the previous resource selection", databaseSelectionStyles.length > 0 && databaseSelectionStyles.every(node => !node.className.includes("is-unrelated") && node.opacity === "1"));
      await page.getByRole("button", { name: "Load diagram Domain" }).click();
      await page.getByTestId("conceptual-preview-svg").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });

      const myWorkButton = page.getByTestId("explorer-my-work-create");
      await myWorkButton.click();
      await page.getByRole("dialog", { name: "Create MY WORK draft" }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByLabel("Draft name").fill("binding-author-work");
      await page.getByRole("button", { name: "Create draft" }).click();
      const contexts = await apiRequest(page, `/api/projects/${projectId}/private-work`);
      const work = contexts.json.contexts.find(entry => entry.name === "binding-author-work");
      if (!work) throw new Error("Semantic Binding MY WORK context was not created");
       const privateConcept = await apiRequest(page, `/api/projects/${projectId}/resources`, { method: "POST", body: JSON.stringify({ contextId: work.id, path: "domain-work.concept", type: "conceptual", content: privateConceptual }) });
      if (privateConcept.status !== 201) throw new Error(`MY WORK Conceptual fixture failed: ${privateConcept.status} ${privateConcept.text}`);
      const privateDatabase = await apiRequest(page, `/api/projects/${projectId}/resources`, { method: "POST", body: JSON.stringify({ contextId: work.id, path: "schema-work.dbschema", type: "database", content: database }) });
      if (privateDatabase.status !== 201) throw new Error(`MY WORK Database fixture failed: ${privateDatabase.status} ${privateDatabase.text}`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator('[data-testid="workspace-active-project"]').filter({ hasText: projectName }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.locator(".explorer__context-note").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByTestId("explorer-private-context").getByRole("button", { name: "Load diagram MY WORK Domain" }).click();
      await page.getByTestId("conceptual-preview-svg").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.getByTestId("conceptual-preview-svg").locator('[data-node-id="project"]').click();
      await panel.getByText("No explicit bindings for this entity.").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      if (!(await panel.getByLabel("Exact indexed endpoint").count())) throw new Error(`MY WORK binding editor unavailable: context=${await panel.getAttribute("data-context-id")} writable=${await panel.getAttribute("data-writable")} contextNote=${await page.locator(".explorer__context-note").textContent()}`);
      const endpointOptions = await panel.getByLabel("Exact indexed endpoint").locator("option").allTextContents();
      const projectsOption = endpointOptions.find(label => /database table.*projects.*schema-work\.dbschema/i.test(label));
      if (!projectsOption) throw new Error(`Typed Database endpoint missing from index options: ${JSON.stringify(endpointOptions)}`);
      await panel.getByLabel("Exact indexed endpoint").selectOption({ label: projectsOption.trim() });
      await panel.getByLabel("Evidence rationale").fill("The approved domain-to-storage mapping names the projects table.");
      await panel.getByLabel("Evidence kind").selectOption("internal");
      await panel.getByLabel("Evidence resource").selectOption({ label: "private-evidence.md · revision 1" });
      await panel.getByRole("button", { name: "Create binding" }).click();
      await panel.getByText("represents-in", { exact: true }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      check("User A explicitly creates Project represents-in projects in MY WORK with Evidence", (await panel.textContent()).includes("private-evidence.md") && (await panel.textContent()).includes("represents-in"));
       const privateBindings = await apiRequest(page, `/api/projects/${projectId}/semantic-bindings?contextId=${work.id}`);
       const binding = privateBindings.json.bindings.find(entry => entry.provenance.contextId === work.id);
       if (!binding) throw new Error("Created MY WORK Semantic Binding was not returned");
       check("indexed selection preserves server-backed resource IDs in both binding anchors", binding.left.resourceId === privateConcept.json.resource.id && binding.right.resourceId === privateDatabase.json.resource.id, `left=${binding.left.resourceId}, right=${binding.right.resourceId}`);
       const directSharedWrite = await apiRequest(page, `/api/projects/${projectId}/semantic-bindings`, { method: "POST", body: JSON.stringify({ binding }) });
       check("direct SHARED binding write remains rejected", directSharedWrite.status >= 400 && directSharedWrite.status < 500, `HTTP ${directSharedWrite.status}`);

       await panel.getByRole("button", { name: "Open related entity" }).click();
      await page.getByTestId("database-preview-svg").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page.waitForFunction(() => document.querySelector('[data-testid="database-preview-svg"] [data-node-id="projects"]')?.classList.contains("svg-node--active") ?? true, undefined, { timeout: UI_TIMEOUT_MS });
      check("Conceptual Project navigates to and selects Database projects by stable identity", (await page.getByTestId("resource-header").textContent()).includes("schema-work.dbschema") && (await page.locator('[data-testid="database-preview-svg"] [data-node-id="projects"]').getAttribute("class") ?? "").includes("svg-node--active"));
      await page.getByTestId("database-preview-svg").locator('[data-node-id="projects"]').click();
      await panel.getByRole("button", { name: "Open related entity" }).click();
      await page.getByTestId("conceptual-preview-svg").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       check("Database projects navigates back to Conceptual Project", (await page.getByTestId("resource-header").textContent()).includes("domain-work.concept"));

      const reviewer = { sub: "e2e-binding-reviewer", name: "Binding Reviewer", email: "binding-reviewer@e2e.test" };
      await reviewerPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await waitForAuthEntry(reviewerPage);
      await signIn(reviewerPage, idp, reviewer);
      const reviewerId = (await apiRequest(reviewerPage, "/api/me")).json.user.id;
      const projectDetails = await apiRequest(page, `/api/projects/${projectId}`);
      await apiRequest(page, `/api/workspaces/${projectDetails.json.project.workspaceId}/members/${reviewerId}`, { method: "PUT", body: JSON.stringify({ role: "EDITOR" }) });
      await apiRequest(page, `/api/projects/${projectId}/members/${reviewerId}`, { method: "PUT", body: JSON.stringify({ role: "EDITOR" }) });
      await reviewerPage.reload({ waitUntil: "domcontentloaded" });
      await openServerProject(reviewerPage, projectName);
      await reviewerPage.getByRole("button", { name: "Load diagram Domain" }).click();
      await reviewerPage.getByRole("button", { name: "Restore analysis panels" }).click();
      await reviewerPage.getByTestId("conceptual-preview-svg").locator('[data-node-id="project"]').click();
      await reviewerPage.getByTestId("semantic-bindings").getByText("No explicit bindings for this entity.").waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      const anotherContext = await apiRequest(reviewerPage, `/api/projects/${projectId}/semantic-bindings?contextId=${work.id}`);
      check("another user's MY WORK binding is not visible", anotherContext.status === 404);

       const submitted = await apiRequest(page, `/api/projects/${projectId}/architectural-proposals`, { method: "POST", body: JSON.stringify({
         sourcePrivateContextId: work.id, resourceIds: [privateConcept.json.resource.id, privateDatabase.json.resource.id], title: proposalTitle,
         description: "Explicit evidenced domain-to-persistence representation.",
         semanticBindings: [{ bindingId: binding.id, operation: "ADD", sourceRevision: binding.revision }],
       }) });
       if (submitted.status !== 201) throw new Error(`Explicit binding proposal selection failed: ${submitted.status} ${submitted.text}`);
       check("proposal submission explicitly selects the binding ADD operation", submitted.json.proposal.semanticBindings?.some(entry => entry.operation === "ADD" && entry.binding.id === binding.id));
      const proposalList = (await apiRequest(page, `/api/projects/${projectId}/architectural-proposals`)).json.proposals;
      const proposal = proposalList.find(entry => entry.title === proposalTitle);
      if (!proposal) throw new Error("Semantic Binding proposal was not submitted");
       const proposalSnapshot = await apiRequest(page, `/api/architectural-proposals/${proposal.id}?projectId=${projectId}`);
       check("proposal explicitly snapshots the selected binding and leaves SHARED unchanged", proposalSnapshot.json.proposal.semanticBindings?.some(entry => entry.operation === "ADD" && entry.binding.id === binding.id) && (await apiRequest(page, `/api/projects/${projectId}/semantic-bindings`)).json.bindings.length === 0);

       await reviewerPage.reload({ waitUntil: "domcontentloaded" });
       const reviewerIdentity = await apiRequest(reviewerPage, "/api/me");
       const reviewerProjectAccess = await apiRequest(reviewerPage, `/api/projects/${projectId}`);
       const reviewerWorkspaces = await apiRequest(reviewerPage, "/api/workspaces");
       check("reviewer remains authenticated and authorized after reload", reviewerIdentity.status === 200 && reviewerProjectAccess.status === 200, `me=${reviewerIdentity.status}, project=${reviewerProjectAccess.status}, url=${reviewerPage.url()}, user=${reviewerIdentity.json?.user?.id}, workspaces=${(reviewerWorkspaces.json?.workspaces ?? []).map(entry => entry.id).join(",")}`);
       await reviewerPage.goto(`${BASE_URL}/?project=${encodeURIComponent(projectId)}`, { waitUntil: "domcontentloaded" });
       await reviewerPage.locator('[data-testid="workspace-active-project"]').filter({ hasText: projectName }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       check("reviewer project is restored by its stable project URL", new URL(reviewerPage.url()).searchParams.get("project") === projectId && (await reviewerPage.locator('[data-testid="workspace-active-project"]').textContent()).includes(projectName));
       const proposalsToggle = reviewerPage.getByTestId("explorer-proposals-toggle");
       if ((await proposalsToggle.getAttribute("aria-expanded")) !== "true") await proposalsToggle.click();
       const proposalRow = reviewerPage.getByTestId("explorer-proposal").filter({ hasText: proposalTitle }).filter({ hasText: "OPEN" });
       await proposalRow.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await proposalRow.getByTestId("explorer-proposal-open").click();
       await reviewerPage.waitForURL(url => url.searchParams.get("proposal") === proposal.id, { timeout: UI_TIMEOUT_MS });
       const detail = reviewerPage.locator('section[aria-label="Architectural Proposal"]');
       await reviewerPage.getByRole("button", { name: "Show proposal details" }).click();
       await detail.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await waitForText(detail, text => text.includes(proposalTitle), "binding proposal review detail");
       await reviewerPage.locator('[aria-label^="Comparison for "]').waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
       await detail.locator('nav[aria-label="Proposal details"] button').filter({ hasText: "Impact" }).click();
       await detail.getByText(/ADD.*conceptual concept project.*database table projects/s).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       check("reviewer reads ADD, both exact endpoints, relation and Evidence without JSON", (await detail.textContent()).includes(binding.evidence.items[0].resourceId) && (await detail.textContent()).includes("represents-in"));
       await detail.locator('nav[aria-label="Proposal details"] button').filter({ hasText: "Review" }).click();
       await detail.locator("textarea").fill("Evidence supports the explicit directional representation.");
      await reviewerPage.locator('section[aria-label="Proposal review"] button').filter({ hasText: "Approve proposal" }).click();
      await waitForText(reviewerPage.locator('section[aria-label="Proposal review"]'), text => text.includes("1 approvals"), "binding proposal approval");
       check("approval records review only and does not publish the binding", (await apiRequest(reviewerPage, `/api/projects/${projectId}/semantic-bindings`)).json.bindings.length === 0);

       await page.goto(`${BASE_URL}/?project=${encodeURIComponent(projectId)}`, { waitUntil: "domcontentloaded" });
       await page.locator('[data-testid="workspace-active-project"]').filter({ hasText: projectName }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       check("author project is restored by its stable project URL for promotion", new URL(page.url()).searchParams.get("project") === projectId);
       const authorProposalsToggle = page.getByTestId("explorer-proposals-toggle");
       if ((await authorProposalsToggle.getAttribute("aria-expanded")) !== "true") await authorProposalsToggle.click();
       const authorProposalRow = page.getByTestId("explorer-proposal").filter({ hasText: proposalTitle });
       await authorProposalRow.getByTestId("explorer-proposal-open").click();
       await page.waitForURL(url => url.searchParams.get("proposal") === proposal.id, { timeout: UI_TIMEOUT_MS });
       await page.getByRole("button", { name: "Show proposal details" }).click();
       const ownerDetail = page.locator('section[aria-label="Architectural Proposal"]');
       await ownerDetail.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await waitForText(ownerDetail, text => text.includes(proposalTitle), "owner binding proposal detail");
      await page.getByRole("button", { name: "Preview promotion" }).click();
      await waitForText(page.locator('section[aria-label="Proposal promotion"]'), text => text.includes("Ready to promote"), "binding promotion preview");
      await page.getByRole("button", { name: "Promote to SHARED" }).click();
      await waitForText(ownerDetail, text => text.includes("PROMOTED"), "binding promotion");
      const sharedBindings = (await apiRequest(page, `/api/projects/${projectId}/semantic-bindings`)).json.bindings;
      check("explicit promotion publishes the same binding to SHARED", sharedBindings.length === 1 && sharedBindings[0].id === binding.id && sharedBindings[0].provenance.contextId === undefined);

      await page.getByRole("button", { name: "Base status", exact: true }).click();
      await page.getByRole("button", { name: "Open resulting SHARED knowledge" }).click();
       await page.locator('[data-testid="explorer-shared-section"] [data-testid="explorer-diagram"]').filter({ hasText: "MY WORK Domain" }).getByTestId("select-diagram-button").click();
       await page.getByTestId("conceptual-preview-svg").locator('[data-node-id="project"]').click();
       const sharedPanel = page.getByTestId("semantic-bindings");
       await sharedPanel.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       await sharedPanel.getByText("represents-in", { exact: true }).waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
       const sharedPanelText = await sharedPanel.textContent();
       check("Workspace SHARED renders the promoted binding, resolved endpoint and Evidence", sharedPanelText.includes("resolved") && sharedPanelText.includes("private-evidence.md"), sharedPanelText);

      const agent = await apiRequest(page, "/api/agents", { method: "POST", body: JSON.stringify({ name: "Binding Query Agent" }) });
      const credential = await apiRequest(page, `/api/agents/${agent.json.agent.id}/credentials`, { method: "POST", body: JSON.stringify({ name: "binding-query", scopes: ["project:read", "resource:read", "project:search"], allowedProjectIds: [projectId] }) });
      const conceptResource = (await apiRequest(page, `/api/projects/${projectId}/resources`)).json.resources.find(resource => resource.path === "domain-work.concept");
      const dbResource = (await apiRequest(page, `/api/projects/${projectId}/resources`)).json.resources.find(resource => resource.path === "schema-work.dbschema");
      const query = await remoteTool(mcpBase, credential.json.secret, 1, "get_semantic_bindings_for_entity", { projectId, anchor: { version: 1, resourceId: conceptResource.id, representation: "conceptual", entityKind: "concept", identity: { kind: "local-id", value: "project" } } });
      check("MCP exact-anchor query returns the authoritative Project binding only", query?.structuredContent?.bindings?.length === 1 && query.structuredContent.bindings[0].binding.id === binding.id);
      check("similar project_settings entity is not presented as a relation", query?.structuredContent?.bindings?.every(entry => entry.binding.right.identity.value !== "project_settings"));

       const completeShare = await apiRequest(page, `/api/projects/${projectId}/shares`, { method: "POST", body: JSON.stringify({ resourceIds: [conceptResource.id, dbResource.id] }) });
       const completeProjection = await (await fetch(`${BASE_URL}/api/public/projects/shared/${encodeURIComponent(completeShare.json.token)}`)).json();
       check("Share with both endpoint resources exposes the explicit binding", completeProjection.catalog.semanticBindings?.some(entry => entry.id === binding.id));
       const partialShare = await apiRequest(page, `/api/projects/${projectId}/shares`, { method: "POST", body: JSON.stringify({ resourceIds: [conceptResource.id] }) });
       const partialProjection = await (await fetch(`${BASE_URL}/api/public/projects/shared/${encodeURIComponent(partialShare.json.token)}`)).json();
       check("Share with one endpoint does not expose the binding", partialProjection.catalog.semanticBindings?.length === 0);
       const sharedBinding = completeProjection.catalog.semanticBindings?.find(entry => entry.id === binding.id);
       const sharedEvidence = (await apiRequest(page, `/api/projects/${projectId}/resources`)).json.resources.find(resource => resource.path === "private-evidence.md");
       const serializedPartialProjection = JSON.stringify(partialProjection);
       check("public Share redacts ungranted Evidence without exposing resource identity or content", sharedBinding?.evidence.items[0]?.kind === "unavailable" && !JSON.stringify(completeProjection).includes(sharedEvidence.id) && !JSON.stringify(completeProjection).includes("private-evidence.md") && !JSON.stringify(completeProjection).includes("Sensitive evidence text") && !serializedPartialProjection.includes(sharedEvidence.id) && !serializedPartialProjection.includes("private-evidence.md") && !serializedPartialProjection.includes("Sensitive evidence text"));
    } finally {
      if (projectId) await apiRequest(page, `/api/projects/${projectId}`, { method: "DELETE" });
      await ownerContext.close();
      await reviewerContext.close();
    }
  });
}

async function main() {
  if (!existsSync(join(ROOT, "dist", "index.html"))) {
    throw new Error(
      "dist/index.html is missing; run `npm run build` first (npm run test:e2e does it for you).",
    );
  }

  const apiPort = await findFreePort(API_PORT);
  const idpPort = await findFreePort(IDP_PORT);
  const idp = await startIdentityProvider({ port: idpPort });
  const projectVolume = await mkdtemp(join(tmpdir(), "sdm-e2e-projects-"));

  // `vite preview` reads this while it builds its proxy table, and the child
  // inherits the environment, so the browser's `/api` and `/auth` calls reach the
  // API that belongs to *this* run.
  process.env.SDM_API_TARGET = `http://127.0.0.1:${apiPort}`;

  const mcpPort = await findFreePort(MCP_PORT);

  let api;
  let mcp;
  let server;
  let browser;
  let platformAdminContext;
  try {
    api = await startApiServer({
      port: apiPort,
      projectVolume,
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
    });
    // The MCP service is a real host on its own port, sharing the API's runtime
    // so a browser write and an agent read see the same project.
    mcp = await startMcpService({
      port: mcpPort,
      runtime: api.runtime,
      publicUrl: `http://127.0.0.1:${mcpPort}`,
      projectVolume,
    });
    server = await startPreviewServer();
    browser = await chromium.launch();
    platformAdminContext = await browser.newContext();
    e2ePlatformAdminPage = await platformAdminContext.newPage();
    await e2ePlatformAdminPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await waitForAuthEntry(e2ePlatformAdminPage);
    await setNextIdentity(idp, {
      sub: "e2e-platform-admin",
      name: "E2E Platform Admin",
      email: "platform-admin@e2e.test",
    });
    await e2ePlatformAdminPage.getByTestId("login-google").click();
    await e2ePlatformAdminPage.locator('[data-testid="toolbar-account"]').waitFor({ timeout: UI_TIMEOUT_MS });
    // The existing checks run in a window tall enough that the whole explorer
    // tree is visible without scrolling; see `runChecks` for why that matters.
    const checksContext = await browser.newContext({
      viewport: { width: 1440, height: 1600 },
    });
    const checksPage = await checksContext.newPage();
    if (!process.env.E2E_SCENARIO || process.env.E2E_SCENARIO === "browser-smoke") {
      await runChecks(checksPage, idp);
    }
    await checksContext.close();
    if (!process.env.E2E_SCENARIO || process.env.E2E_SCENARIO !== "browser-smoke") {
      await runServerChecks(browser, idp, `http://127.0.0.1:${apiPort}`, mcp.mcpBase);
    }
  } finally {
    await browser?.close().catch(() => {});
    e2ePlatformAdminPage = null;
    await platformAdminContext?.close().catch(() => {});
    server?.kill("SIGTERM");
    await mcp?.close().catch(() => {});
    await api?.close().catch(() => {});
    await idp.close().catch(() => {});
    await rm(projectVolume, { recursive: true, force: true });
  }

  console.log("");
  if (failures.length > 0) {
    console.error(`E2E smoke test FAILED (${failures.length} check(s))`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("E2E smoke test passed.");
}

main().catch((error) => {
  console.error(`\nE2E smoke test could not run: ${error.message}`);
  if (
    /Executable doesn't exist|browserType\.launch/.test(String(error.message))
  ) {
    console.error(
      "Install the browser once with: npx playwright install chromium",
    );
  }
  process.exitCode = 1;
});
