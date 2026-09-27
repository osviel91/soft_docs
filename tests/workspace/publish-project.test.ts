import { describe, expect, it, vi } from "vitest";
import type { WorkspaceRepository } from "../../src/workspace/WorkspaceRepository";
import type { ServerApiClient } from "../../src/workspace/server/api-client";
import { publishProject } from "../../src/workspace/server/publish-project";

describe("publishProject", () => {
  it("copies diagrams and notes into a newly created server project", async () => {
    const bootstrapProject = vi.fn(async () => ({ id: "server-project", name: "Test" }));
    const client = {
      listWorkspaces: vi.fn(async () => [
        { id: "workspace-1", isDefault: true },
      ]),
      bootstrapProject,
    } as unknown as ServerApiClient;
    const source = {
      listDiagramFiles: vi.fn(async () => ({
        ok: true as const,
        value: [
          {
            id: "diagram-1",
            projectId: "local-project",
            name: "order.eventseq",
            source: "event OrderCreated",
          },
        ],
      })),
      listNoteFiles: vi.fn(async () => ({
        ok: true as const,
        value: [
          {
            id: "note-1",
            projectId: "local-project",
            name: "overview.md",
            markdown: "# Overview",
          },
        ],
      })),
    } as unknown as WorkspaceRepository;

    await publishProject(client, source, {
      id: "local-project",
      name: "Test",
      datasetIds: ["diagram-1"],
      noteIds: ["note-1"],
    });

    expect(bootstrapProject).toHaveBeenCalledWith("Test", "workspace-1", [
      { path: "order.eventseq", type: "event-flow", content: "event OrderCreated" },
      { path: "overview.md", type: "markdown-document", content: "# Overview" },
    ]);
  });
});
