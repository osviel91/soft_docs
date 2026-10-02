/**
 * The workspace switcher's contract (Phase 4A).
 *
 * The two things worth pinning down are the ones a user notices: anonymous people
 * can see local sources and server projects. Everything else is layout.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import WorkspaceSwitcher from "../../../src/features/explorer/WorkspaceSwitcher";
import type { ServerProject } from "../../../src/workspace/server/api-client";

/** A server project listing. */
function project(id: string, name: string): ServerProject {
  return {
    id,
    workspaceId: "w1",
    name,
    slug: name.toLowerCase(),
    ownerId: "u1",
    role: "OWNER",
    resourceCount: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function workspace(id: string, name: string) {
  return {
    id,
    ownerId: "u1",
    name,
    isDefault: id === "w1",
    allowAuthorSelfReview: false,
    role: "ADMIN" as const,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

/** Render the switcher with sensible defaults for the case under test. */
function renderSwitcher(
  overrides: Partial<React.ComponentProps<typeof WorkspaceSwitcher>> = {},
) {
  const handlers = {
    onOpenLocal: vi.fn(),
    onOpenFolder: vi.fn(),
    onOpenServerProject: vi.fn(),
    onCreateServerProject: vi.fn(),
  };
  render(<WorkspaceSwitcher mode="local" {...handlers} {...overrides} />);
  return handlers;
}

describe("WorkspaceSwitcher", () => {
  it("lists local entry points", () => {
    const handlers = renderSwitcher({ folderSupported: true });
    fireEvent.click(screen.getByTestId("workspace-local"));
    expect(handlers.onOpenLocal).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("workspace-open-folder"));
    expect(handlers.onOpenFolder).toHaveBeenCalledTimes(1);
  });

  it("does not render a resizable competing source region", () => {
    renderSwitcher();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.queryByTestId("workspace-server-toggle")).toBeNull();
  });

  it("lists the signed-in user's projects and opens the chosen one", () => {
    const handlers = renderSwitcher({
      mode: "local",
      serverProjects: [project("p1", "Payments"), project("p2", "OSIRIS")],
    });

    const rows = screen.getAllByTestId("workspace-server-project");
    expect(rows.map((row) => row.textContent?.replace("☁", ""))).toEqual([
      "Payments",
      "OSIRIS",
    ]);
    fireEvent.click(rows[0]);
    expect(handlers.onOpenServerProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p1" }),
    );
  });

  it("keeps the active project and reveals the project picker without closing it", () => {
    const onReloadServerProjects = vi.fn();
    renderSwitcher({
      mode: "server",
      serverProjects: [project("p1", "Payments")],
      activeServerProjectId: "p1",
      onReloadServerProjects,
    });
    expect(screen.getByTestId("workspace-active-project")).toHaveTextContent("Payments");
    expect(screen.queryByTestId("workspace-server-project")).toBeNull();
    fireEvent.click(screen.getByTestId("workspace-back-to-projects"));
    expect(screen.getByTestId("workspace-server-project")).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByTestId("workspace-server-refresh"));
    expect(onReloadServerProjects).toHaveBeenCalledTimes(1);
  });

  it("progressively discloses server project creation", () => {
    const handlers = renderSwitcher({
      mode: "server",
    });

    expect(screen.queryByTestId("workspace-new-server-project-input")).toBeNull();
    fireEvent.click(screen.getByTestId("workspace-new-server-project-toggle"));

    const input = screen.getByTestId(
      "workspace-new-server-project-input",
    ) as HTMLInputElement;
    const submit = screen.getByTestId("workspace-new-server-project-button");
    // A blank name is not a project.
    expect(submit).toBeDisabled();

    fireEvent.change(input, { target: { value: "  Payments  " } });
    fireEvent.click(submit);

    expect(handlers.onCreateServerProject).toHaveBeenCalledWith("Payments");
    expect(screen.queryByTestId("workspace-new-server-project-input")).toBeNull();
  });

  it("marks the selected server workspace", () => {
    const onSelectServerWorkspace = vi.fn();
    renderSwitcher({
      mode: "server",
      serverWorkspaces: [
        workspace("w1", "Personal"),
        workspace("w2", "Engineering"),
      ],
      selectedServerWorkspaceId: "w1",
      onSelectServerWorkspace,
    });

    fireEvent.change(screen.getByTestId("workspace-server-workspace-select"), {
      target: { value: "w2" },
    });
    expect(onSelectServerWorkspace).toHaveBeenCalledWith("w2");
  });

  it("shows a load failure with a way to retry", () => {
    const onReloadServerProjects = vi.fn();
    renderSwitcher({
      mode: "server",
      serverProjectsError: "The projects could not be loaded.",
      onReloadServerProjects,
    });

    expect(
      screen.getByTestId("workspace-server-projects-error"),
    ).toHaveTextContent("The projects could not be loaded.");
    fireEvent.click(screen.getByTestId("workspace-server-projects-retry"));
    expect(onReloadServerProjects).toHaveBeenCalledTimes(1);
  });

  it("filters server projects without changing the active project", () => {
    renderSwitcher({
      mode: "server",
      serverProjects: [project("p1", "Payments"), project("p2", "Docs")],
    });
    fireEvent.change(screen.getByTestId("workspace-server-project-filter"), {
      target: { value: "doc" },
    });
    expect(screen.getAllByTestId("workspace-server-project")).toHaveLength(1);
    expect(screen.getByTestId("workspace-server-project")).toHaveTextContent("Docs");
    expect(screen.getByTestId("workspace-server-project")).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("keeps the project browser as one scroll surface", () => {
    renderSwitcher({ serverProjects: [project("p1", "Payments")] });
    expect(screen.getByTestId("workspace-server-projects-scroll")).toBeInTheDocument();
    expect(screen.queryByRole("separator")).toBeNull();
  });

});
