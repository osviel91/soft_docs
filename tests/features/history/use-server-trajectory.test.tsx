import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useServerTrajectory } from "../../../src/features/history/use-server-trajectory";
import type { ServerApiClient, ServerTrajectoryEntry } from "../../../src/workspace/server/api-client";

function entry(resourceId: string): ServerTrajectoryEntry {
  return { id: `${resourceId}:r1`, projectId: "p1", resourceId, kind: "RESOURCE_CREATED", occurredAt: "2026-01-01T00:00:00Z", actor: null, resultingRevision: 1 };
}

describe("useServerTrajectory context isolation", () => {
  it("requests the selected context and clears old entries immediately when context changes", async () => {
    const client = {
      getProjectTrajectory: vi.fn(async (_projectId: string, _page: unknown, contextId: string | null) => ({ entries: [entry(contextId ?? "shared")], nextCursor: null })),
      getResourceTrajectory: vi.fn(async (_projectId: string, _resourceId: string, _page: unknown, contextId: string | null) => ({ entries: [entry(contextId ?? "shared-resource")], nextCursor: null })),
    } as unknown as ServerApiClient;
    const { result, rerender } = renderHook(({ contextId }) => useServerTrajectory(client, "p1", null, contextId, true), { initialProps: { contextId: "work-a" as string | null } });

    await waitFor(() => expect(result.current.entries.map((row) => row.resourceId)).toEqual(["work-a"]));
    rerender({ contextId: "work-b" });
    expect(result.current.entries).toEqual([]);
    await waitFor(() => expect(result.current.entries.map((row) => row.resourceId)).toEqual(["work-b"]));
    expect(client.getProjectTrajectory).toHaveBeenNthCalledWith(1, "p1", {}, "work-a");
    expect(client.getProjectTrajectory).toHaveBeenNthCalledWith(2, "p1", {}, "work-b");
  });

  it("does not let an older context response overwrite the selected context", async () => {
    const pending: Array<{ contextId: string | null; resolve: (result: { entries: ServerTrajectoryEntry[]; nextCursor: null }) => void }> = [];
    const client = {
      getProjectTrajectory: (_projectId: string, _page: unknown, contextId: string | null) => new Promise<{ entries: ServerTrajectoryEntry[]; nextCursor: null }>((resolve) => pending.push({ contextId, resolve })),
      getResourceTrajectory: vi.fn(),
    } as unknown as ServerApiClient;
    const { result, rerender } = renderHook(({ contextId }) => useServerTrajectory(client, "p1", null, contextId, true), { initialProps: { contextId: "work-a" as string | null } });
    await waitFor(() => expect(pending).toHaveLength(1));
    rerender({ contextId: "work-b" });
    await waitFor(() => expect(pending).toHaveLength(2));

    await act(async () => pending[0].resolve({ entries: [entry("work-a")], nextCursor: null }));
    expect(result.current.entries).toEqual([]);
    await act(async () => pending[1].resolve({ entries: [entry("work-b")], nextCursor: null }));
    expect(result.current.entries.map((row) => row.resourceId)).toEqual(["work-b"]);
  });
});
