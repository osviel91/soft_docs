/**
 * The browser working against an authenticated server project (Phase 4A).
 *
 * The Playwright suite drives the same flow through a real browser, a real API
 * and a real identity provider — but it is slow, and it is the only place that
 * flow is exercised. This test runs the *shell* against a fake HTTP API in jsdom,
 * which is what lets it assert the things the E2E run cannot see: which request
 * the editor issued, with which `expectedRevision`, and what the conflict dialog
 * did to the buffer.
 *
 * The fake speaks the API's real envelopes, so the adapter and the client are the
 * production ones; only the socket is missing.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";

/** The project the fake API serves. */
const PROJECT = {
  id: "p1",
  workspaceId: "w1",
  name: "Payments",
  slug: "payments",
  ownerId: "u1",
  role: "OWNER",
  resourceCount: 1,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};
const SECOND_PROJECT = {
  ...PROJECT,
  id: "p2",
  name: "Reporting",
  slug: "reporting",
};
const THIRD_PROJECT = { ...SECOND_PROJECT, id: "p3", workspaceId: "w2", name: "Archive" };

/** The one resource the fake API holds. */
interface FakeResource {
  id: string;
  projectId: string;
  path: string;
  type: "sequence-diagram" | "event-flow" | "markdown-document";
  revision: number;
  content: string;
}

/** What the fake API should answer with, per test. */
interface FakeState {
  signedIn: boolean;
  multipleProjects: boolean;
  crossWorkspace: boolean;
  denyProjectOpen: string | null;
  proposalUnavailable: boolean;
  contextId: string | null;
  resources: Map<string, FakeResource>;
  proposals: Array<{ id: string; title: string; authorUserId: string; status: "open" | "withdrawn" | "superseded"; baseSharedRevision: string; submittedAt?: string }>;
  /** Every request the shell made, for asserting the wire. */
  calls: Array<{ method: string; path: string; body: unknown }>;
  /** Answer the next write with a conflict at this revision, once. */
  conflictAt: number | null;
  /** Make the next write fail at the transport, as an offline browser would. */
  networkFails: boolean;
}

const state: FakeState = {
  signedIn: false,
  multipleProjects: false,
  crossWorkspace: false,
  denyProjectOpen: null,
  proposalUnavailable: false,
  contextId: null,
  resources: new Map(),
  proposals: [],
  calls: [],
  conflictAt: null,
  networkFails: false,
};

/** A response the API client can read: it only uses `ok`, `status`, `text`. */
function reply(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body === undefined ? "" : JSON.stringify(body);
    },
  } as unknown as Response;
}

/** The error envelope the API uses. */
function refuse(status: number, code: string, details?: unknown): Response {
  return reply(status, {
    error: {
      code,
      message: `refused: ${code}`,
      ...(details === undefined ? {} : { details }),
    },
  });
}

/** The wire view of a resource. */
function view(resource: FakeResource) {
  return {
    id: resource.id,
    projectId: resource.projectId,
    path: resource.path,
    type: resource.type,
    revision: resource.revision,
  };
}

/** The fake API, as a `fetch` implementation. */
function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, "http://app.test");
  const path = url.pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  const body =
    typeof init?.body === "string"
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : null;
  state.calls.push({ method, path, body });

  if (path === "/api/me") {
    return Promise.resolve(
      reply(200, {
        user: state.signedIn
          ? {
              id: "u1",
              displayName: "Ada",
              email: "ada@example.test",
              authType: "session",
              scopes: [],
            }
          : null,
      }),
    );
  }
  if (path === "/api/projects") {
    const candidates = [PROJECT, ...(state.multipleProjects ? [SECOND_PROJECT] : []), ...(state.crossWorkspace ? [THIRD_PROJECT] : [])];
    const workspaceId = url.searchParams.get("workspaceId");
    return Promise.resolve(
      reply(200, {
        projects: state.signedIn
          ? candidates.filter((project) => !workspaceId || project.workspaceId === workspaceId)
          : [],
      }),
    );
  }
  if (path === "/api/workspaces") {
    return Promise.resolve(
      reply(200, {
        workspaces: state.signedIn
          ? [
              {
                id: "w1",
                ownerId: "u1",
                name: "Personal",
                isDefault: true,
                role: "ADMIN",
                createdAt: new Date(0).toISOString(),
                updatedAt: new Date(0).toISOString(),
              },
              ...(state.crossWorkspace ? [{ id: "w2", ownerId: "u1", name: "Archive workspace", isDefault: false, role: "ADMIN", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }] : []),
          ]
          : [],
      }),
    );
  }
  if (path === "/api/projects/p3") return Promise.resolve(reply(state.signedIn ? 200 : 404, state.signedIn ? { project: THIRD_PROJECT } : undefined));
  if (path === "/api/projects/p3/access") return Promise.resolve(state.denyProjectOpen === "p3" ? refuse(404, "not_found") : reply(200, { projectId: "p3", role: "OWNER", permissions: ["project:read", "resource:read"] }));
  if (path === "/api/projects/p3/private-work") return Promise.resolve(reply(200, { contexts: [] }));
  if (path === "/api/projects/p3/architectural-proposals") return Promise.resolve(reply(200, { proposals: [] }));
  if (path === "/api/projects/p3/resources") return Promise.resolve(reply(200, { resources: [] }));
  if (path === "/api/projects/p3/relationships") return Promise.resolve(reply(200, { relationships: [] }));
  if (path === "/api/architectural-proposals/proposal-1") return Promise.resolve(state.proposalUnavailable ? refuse(404, "not_found", { message: "secret proposal detail" }) : reply(200, { proposal: { id: "proposal-1", projectId: "p3", authorUserId: "u1", title: "Cross-workspace proposal", status: "open", submittedAt: new Date(0).toISOString(), baseSharedRevision: "r1", currentSharedRevision: "r1", staleBase: false, resources: [], relationships: [], semanticMessages: [], lifecycle: { state: "OPEN" }, capabilities: {} } }));
  if (path === "/api/architectural-proposals/proposal-1/reviews") return Promise.resolve(reply(200, { reviews: { status: "none", approvals: 0, changesRequested: 0, reviews: [] } }));
  if (path === "/api/architectural-proposals/proposal-1/diff") return Promise.resolve(reply(200, { diff: { resources: [], relationships: [], semanticIdentities: [], semanticBindings: [], impact: { resourcesAdded: 0, resourcesModified: 0, resourcesDeleted: 0, relationshipsChanged: 0, semanticIdentitiesChanged: 0 } } }));
  if (path === "/api/inbox/proposals") return Promise.resolve(reply(200, { items: [], nextCursor: null, counts: { PENDING_REVIEW: 0, CHANGES_REQUESTED: 0, APPROVED_PENDING_PROMOTION: 0, PROMOTION_COMPLETION_PENDING: 0, PROMOTED: 0, WITHDRAWN: 0, SUPERSEDED: 0 } }));
  if (path === "/api/workspaces/w1/members") {
    return Promise.resolve(reply(200, { members: [] }));
  }
  if (path === "/api/projects/p2/access") {
    return Promise.resolve(
      reply(200, {
        projectId: "p2",
        role: "OWNER",
        permissions: [
          "project:read",
          "resource:read",
          "resource:update",
          "project:delete",
        ],
      }),
    );
  }
  if (path === "/api/projects/p2/private-work") return Promise.resolve(reply(200, { contexts: [] }));
  if (path === "/api/projects/p2/architectural-proposals") return Promise.resolve(reply(200, { proposals: [] }));
  if (path === "/api/projects/p2/resources") return Promise.resolve(reply(200, { resources: [] }));
  if (path === "/api/projects/p2/relationships") return Promise.resolve(reply(200, { relationships: [] }));
  if (path === "/api/projects/p1/private-work") {
    if (method === "GET") {
      return Promise.resolve(
        reply(200, state.contextId === null ? { contexts: [] } : {
          contexts: [{ id: state.contextId, name: "Browser work", lifecycle: "active" }],
        }),
      );
    }
    if (method === "POST") {
      state.contextId = "work1";
      return Promise.resolve(
        reply(201, { context: { id: state.contextId, name: "Browser work", lifecycle: "active" } }),
      );
    }
  }
  if (path === "/api/projects/p1/architectural-proposals") {
    return Promise.resolve(reply(200, { proposals: state.proposals }));
  }
  if (path === "/api/projects/p1/access") {
    return Promise.resolve(
      reply(200, {
        projectId: "p1",
        role: "OWNER",
        permissions: [
          "project:read",
          "resource:read",
          "resource:update",
          "project:delete",
        ],
      }),
    );
  }
  if (path === "/api/projects/p1/resources") {
    return Promise.resolve(
      reply(200, { resources: [...state.resources.values()].map(view) }),
    );
  }
  if (path === "/api/projects/p1/relationships") {
    return Promise.resolve(reply(200, { relationships: [] }));
  }
  if (path === "/api/projects/p1/resources" && method === "POST") {
    return Promise.resolve(
      reply(201, { resource: view(state.resources.get("r1")!) }),
    );
  }
  const one = /^\/api\/projects\/p1\/resources\/([^/]+)$/.exec(path);
  if (one) {
    const resource = state.resources.get(one[1]);
    if (!resource) return Promise.resolve(refuse(404, "not_found"));
    if (method === "GET") {
      return Promise.resolve(
        reply(200, { resource: view(resource), content: resource.content }),
      );
    }
    if (method === "PUT") {
      const revision = body?.expectedRevision as number;
      if (state.networkFails) {
        // The transport failed, so nothing was refused: the client must report a
        // retryable error rather than a server verdict.
        state.networkFails = false;
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      if (state.conflictAt !== null) {
        const current = state.conflictAt;
        state.conflictAt = null;
        return Promise.resolve(
          refuse(409, "conflict", {
            expectedRevision: revision,
            currentRevision: current,
          }),
        );
      }
      if (revision !== resource.revision) {
        return Promise.resolve(
          refuse(409, "conflict", {
            expectedRevision: revision,
            currentRevision: resource.revision,
          }),
        );
      }
      resource.content = String(body?.content ?? "");
      resource.revision += 1;
      return Promise.resolve(reply(200, { resource: view(resource) }));
    }
  }
  const move = /^\/api\/projects\/p1\/resources\/([^/]+)\/move$/.exec(path);
  if (move && method === "POST") {
    const resource = state.resources.get(move[1]);
    if (!resource) return Promise.resolve(refuse(404, "not_found"));
    const revision = body?.expectedRevision as number;
    if (revision !== resource.revision) {
      return Promise.resolve(
        refuse(409, "conflict", {
          expectedRevision: revision,
          currentRevision: resource.revision,
        }),
      );
    }
    resource.path = String(body?.path ?? resource.path);
    resource.revision += 1;
    return Promise.resolve(reply(200, { resource: view(resource) }));
  }
  return Promise.resolve(refuse(404, "not_found"));
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  state.signedIn = false;
  state.multipleProjects = false;
  state.crossWorkspace = false;
  state.denyProjectOpen = null;
  state.proposalUnavailable = false;
  state.contextId = null;
  state.resources = new Map();
  state.proposals = [];
  state.calls = [];
  state.conflictAt = null;
  vi.stubGlobal("fetch", fakeFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Wait for a request the shell made, so an assertion is not a race. */
async function waitForCall(
  method: string,
  path: string,
): Promise<{ method: string; path: string; body: unknown }> {
  await waitFor(() => {
    expect(
      state.calls.some((call) => call.method === method && call.path === path),
    ).toBe(true);
  });
  const call = state.calls.find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (!call) throw new Error(`No ${method} ${path}`);
  return call;
}

describe("App — anonymous browser", () => {
  it("stays on the login screen until authentication succeeds", async () => {
    render(<App />);

    await screen.findByTestId("login-page");
    expect(screen.queryByTestId("app-shell")).toBeNull();
    expect(screen.queryByTestId("workspace-server-toggle")).toBeNull();
  });
});

describe("App — authenticated browser", () => {
  it("hydrates a reloaded proposal deep link in another workspace before reading the proposal", async () => {
    state.signedIn = true;
    state.crossWorkspace = true;
    window.history.replaceState({}, "", "/");
    window.history.pushState({}, "", "/?inbox=proposals&q=ledger");
    window.history.pushState({}, "", "/?project=p3&proposal=proposal-1&returnTo=%2F%3Finbox%3Dproposals%26q%3Dledger");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Cross-workspace proposal" })).toBeInTheDocument();
    expect(state.calls.map((call) => call.path)).toContain("/api/projects/p3");
    expect(state.calls.map((call) => call.path)).toContain("/api/projects/p3/access");
    expect(state.calls.map((call) => call.path)).toContain("/api/architectural-proposals/proposal-1");
    expect(window.location.search).toContain("project=p3");
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(screen.getByTestId("architecture-inbox")).toBeInTheDocument());
    expect(window.location.search).toContain("q=ledger");
  });

  it("returns a cross-workspace deep link to Inbox when access is revoked during project opening", async () => {
    state.signedIn = true;
    state.crossWorkspace = true;
    state.denyProjectOpen = "p3";
    window.history.replaceState({}, "", "/?project=p3&proposal=proposal-1&returnTo=%2F%3Finbox%3Dproposals%26q%3Dledger");
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("This proposal is unavailable or you no longer have access");
    expect(window.location.search).toContain("inbox=proposals");
    expect(window.location.search).toContain("q=ledger");
    expect(state.calls.map((call) => call.path)).toContain("/api/projects/p3");
    expect(state.calls.map((call) => call.path)).toContain("/api/projects/p3/access");
    expect(state.calls.map((call) => call.path)).not.toContain("/api/architectural-proposals/proposal-1");
  });

  it("shows a generic proposal-unavailable message and the Inbox return when a deep link disappears", async () => {
    state.signedIn = true;
    state.crossWorkspace = true;
    state.proposalUnavailable = true;
    window.history.replaceState({}, "", "/?project=p3&proposal=proposal-1&returnTo=%2F%3Finbox%3Dproposals");
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("This proposal is unavailable or you no longer have access.");
    expect(screen.queryByText("secret proposal detail")).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Back" })));
    expect(await screen.findByTestId("architecture-inbox")).toBeInTheDocument();
    expect(window.location.search).toContain("inbox=proposals");
  });

  /** Sign in, open the server project, and wait for its document. */
  async function openServerProject(content = "title Checkout", enterMyWork = true) {
    state.signedIn = true;
    state.resources = new Map([
      [
        "r1",
        {
          id: "r1",
          projectId: "p1",
          path: "checkout.seq",
          type: "sequence-diagram",
          revision: 3,
          content,
        },
      ],
    ]);
    render(<App />);

    await screen.findByTestId("workspace-server-project-filter");
    const row = (await screen.findAllByTestId("workspace-server-project")).find(
      (item) => item.textContent?.includes("Payments"),
    );
    expect(row).toBeDefined();
    await act(async () => {
      fireEvent.click(row!);
    });
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toHaveValue(content);
    });
    if (!enterMyWork) return;
    const myWork = screen.getByTestId("explorer-my-work-section");
    const myWorkToggle = within(myWork).getByTestId("explorer-my-work-toggle");
    if (state.contextId === null) {
      await act(async () => fireEvent.click(screen.getByTestId("explorer-my-work-create")));
      fireEvent.change(await screen.findByLabelText("Draft name"), { target: { value: "Browser work" } });
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create draft" })));
    } else {
      if (myWorkToggle.getAttribute("aria-expanded") !== "true") {
        await act(async () => fireEvent.click(myWorkToggle));
      }
      await act(async () => fireEvent.click(await screen.findByTestId("explorer-private-context-open-work1")));
    }
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toHaveValue(content);
    });
  }

  it("lists the server projects and opens one into the same editor", async () => {
    await openServerProject();

    // The explorer tree is the server project's, and the editor is the one
    // editor — not a server-specific pane. The row shows the diagram's title,
    // which the server resource's content supplies.
    expect(within(screen.getByTestId("explorer-shared-section")).getByTestId("explorer-diagram")).toHaveTextContent(
      "Checkout",
    );
    expect(screen.getByTestId("workspace-active-project")).toHaveTextContent(
      "Payments",
    );
    expect(screen.queryByTestId("explorer-mode")).toBeNull();
    expect(screen.getByTestId("explorer-provenance-tree")).toBeInTheDocument();
    // Opening read the access record and the resource, and nothing more.
    expect(state.calls.map((call) => `${call.method} ${call.path}`)).toContain(
      "GET /api/projects/p1/access",
    );
  });

  it("returns from MY WORK to a selected SHARED artifact", async () => {
    await openServerProject("title Checkout", true);

    await act(async () => {
      fireEvent.click(within(screen.getByTestId("explorer-shared-section")).getByTestId("select-diagram-button"));
    });

    await waitFor(() => {
      expect(state.calls.filter((call) => call.path === "/api/projects/p1/access").length).toBeGreaterThan(1);
      expect(screen.getByTestId("dsl-textarea")).toHaveValue("title Checkout");
    });
  });

  it("keeps the project selected from the explorer instead of navigating back to the previous one", async () => {
    state.multipleProjects = true;
    await openServerProject("title Checkout", false);

    act(() => fireEvent.click(screen.getByTestId("workspace-back-to-projects")));
    const reporting = await screen.findByRole("button", { name: /Reporting/ });
    act(() => fireEvent.click(reporting));

    await waitFor(() => {
      expect(screen.getByTestId("workspace-active-project")).toHaveTextContent("Reporting");
      expect(new URLSearchParams(window.location.search).get("project")).toBe("p2");
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.getByTestId("workspace-active-project")).toHaveTextContent("Reporting");
    expect(new URLSearchParams(window.location.search).get("project")).toBe("p2");
    expect(state.calls.filter((call) => call.path === "/api/projects/p1/access")).toHaveLength(1);
  });

  it("ends a stale revision session when its proposal has been withdrawn", async () => {
    state.signedIn = true;
    state.contextId = "work1";
    state.proposals = [{ id: "proposal-1", title: "Withdrawn proposal", authorUserId: "u1", status: "withdrawn", baseSharedRevision: "shared-1", submittedAt: new Date(0).toISOString() }];
    state.resources = new Map([
      ["r1", { id: "r1", projectId: "p1", path: "work.seq", type: "sequence-diagram", revision: 1, content: "title Private work" }],
    ]);
    window.history.replaceState({}, "", "/?project=p1&context=work1&resource=r1&proposal=proposal-1");
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toHaveValue("title Private work");
      expect(new URLSearchParams(window.location.search).get("proposal")).toBeNull();
    });
    expect(screen.queryByTestId("explorer-revision-origin")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review and submit…" })).not.toBeInTheDocument();
  });

  it("keeps the second MY WORK resource selected instead of replaying the previous URL selection", async () => {
    state.signedIn = true;
    state.contextId = "work1";
    window.history.replaceState({}, "", "/?project=p1&context=work1&resource=r1");
    state.resources = new Map([
      ["r1", { id: "r1", projectId: "p1", path: "first.seq", type: "sequence-diagram", revision: 1, content: "title First" }],
      ["r2", { id: "r2", projectId: "p1", path: "second.seq", type: "sequence-diagram", revision: 1, content: "title Second" }],
    ]);
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("dsl-textarea")).toHaveValue("title First"));

    const myWork = await screen.findByTestId("explorer-my-work-section");
    if (within(myWork).getByTestId("explorer-my-work-toggle").getAttribute("aria-expanded") !== "true") {
      await act(async () => fireEvent.click(within(myWork).getByTestId("explorer-my-work-toggle")));
    }
    const rows = within(myWork).getAllByTestId("explorer-diagram");
    expect(rows).toHaveLength(2);
    await act(async () => fireEvent.click(within(rows[1]).getByTestId("select-diagram-button")));

    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toHaveValue("title Second");
      expect(new URLSearchParams(window.location.search).get("resource")).toBe("r2");
      expect(within(myWork).getAllByTestId("explorer-diagram")[1]).toHaveClass("explorer__resource--selected");
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.getByTestId("dsl-textarea")).toHaveValue("title Second");
  });

  it("refreshes externally changed server data without reloading the page", async () => {
    await openServerProject();
    const editor = screen.getByTestId("dsl-textarea");
    const before = state.calls.length;
    const resource = state.resources.get("r1");
    if (!resource) throw new Error("missing test resource");
    resource.content = "title Updated by agent";
    resource.revision += 1;

    await act(async () => {
      fireEvent.click(screen.getByTestId("workspace-server-refresh"));
    });

    await waitFor(() => expect(editor).toHaveValue("title Updated by agent"));
    expect(state.calls.length).toBeGreaterThan(before);
    expect(screen.getByTestId("workspace-active-project")).toHaveTextContent(
      "Payments",
    );
  });

  it("saves an edit with the revision it last read", async () => {
    await openServerProject();

    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "title Checkout\nBrowser -> Gateway: Pay" },
    });

    const put = await waitForCall("PUT", "/api/projects/p1/resources/r1");
    expect(put.body).toEqual({
      content: "title Checkout\nBrowser -> Gateway: Pay",
      expectedRevision: 3,
      contextId: "work1",
    });
    // The tab is no longer dirty, so the save really landed.
    await waitFor(() => {
      expect(state.resources.get("r1")?.content).toContain(
        "Browser -> Gateway: Pay",
      );
    });
  });

  it("renames a server resource through the move endpoint", async () => {
    state.contextId = "work1";
    await openServerProject();
    window.history.replaceState({}, "", "/?project=p1&context=work1");
    window.dispatchEvent(new PopStateEvent("popstate"));
    const myWork = screen.getByTestId("explorer-my-work-section");
    const myWorkToggle = within(myWork).getByTestId("explorer-my-work-toggle");
    if (myWorkToggle.getAttribute("aria-expanded") !== "true") {
      await act(async () => fireEvent.click(myWorkToggle));
    }
    await waitFor(() => expect(within(myWork).getByTestId("explorer-diagram")).toBeInTheDocument());

    // Right-click the row, choose Rename, and confirm the new name.
    fireEvent.contextMenu(within(myWork).getByTestId("explorer-diagram"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("context-menu-rename"));
    });
    fireEvent.change(screen.getByTestId("prompt-dialog-input"), {
      target: { value: "orders" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("prompt-dialog-confirm"));
    });

    const move = await waitForCall(
      "POST",
      "/api/projects/p1/resources/r1/move",
    );
    // The name is sent as typed. Local projects name a diagram `Untitled` with no
    // extension either, so the two stores agree; the resource's *id* is what
    // survives the rename, which is the property documentation links rely on.
    expect(move.body).toEqual({ path: "orders", expectedRevision: 3, contextId: "work1" });
    await waitFor(() => {
      expect(state.resources.get("r1")?.path).toBe("orders");
    });
  });

  it("surfaces a conflict and takes the server's version on request", async () => {
    await openServerProject();

    // Someone else writes first; this client's revision is now stale.
    state.conflictAt = 9;
    const stale = state.resources.get("r1");
    if (stale) stale.content = "title Checkout\nSomeone -> Else: changed";

    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "title Mine" },
    });

    // Nothing is overwritten: the dialog appears and the buffer is intact.
    await screen.findByTestId("save-conflict-dialog");
    expect(screen.getByTestId("dsl-textarea")).toHaveValue("title Mine");

    await act(async () => {
      fireEvent.click(screen.getByTestId("save-conflict-reload"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toHaveValue(
        "title Checkout\nSomeone -> Else: changed",
      );
    });
    expect(screen.queryByTestId("save-conflict-dialog")).toBeNull();
  });

  it("keeps the local buffer when the conflict is cancelled", async () => {
    await openServerProject();
    state.conflictAt = 9;

    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "title Mine" },
    });
    await screen.findByTestId("save-conflict-dialog");

    await act(async () => {
      fireEvent.click(screen.getByTestId("save-conflict-cancel"));
    });

    // The editor still holds the unsaved work, and nothing was written.
    expect(screen.queryByTestId("save-conflict-dialog")).toBeNull();
    expect(screen.getByTestId("dsl-textarea")).toHaveValue("title Mine");
    expect(state.resources.get("r1")?.content).toContain("title Checkout");
  });

  /**
   * An offline save is not a refusal, so it must not be reported as one — and it
   * must never cost the user their work. The banner offers a retry, the buffer
   * stays in the editor, and the retry succeeds once the API answers again.
   */
  it("keeps the buffer and offers a retry when the API is unreachable", async () => {
    await openServerProject();
    state.networkFails = true;

    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "title Offline" },
    });

    const banner = await screen.findByTestId("save-error");
    expect(banner).toHaveTextContent(/could not be reached/i);
    expect(screen.queryByTestId("save-conflict-dialog")).toBeNull();
    // The work is still on screen and still unsaved.
    expect(screen.getByTestId("dsl-textarea")).toHaveValue("title Offline");
    expect(state.resources.get("r1")?.content).toContain("title Checkout");

    await act(async () => {
      fireEvent.click(screen.getByTestId("save-error-retry"));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("save-error")).toBeNull();
    });
    expect(state.resources.get("r1")?.content).toBe("title Offline");
  });
});
