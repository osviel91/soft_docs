import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useResourceProposalCount } from "../../../src/features/proposals/project-proposals";
import type { ServerApiClient } from "../../../src/workspace/server/api-client";

function client() {
  return {
    listResources: vi.fn().mockResolvedValue([{ id: "123e4567-e89b-42d3-a456-426614174000", path: "alpha.seq" }]),
    listChangeProposals: vi.fn().mockResolvedValue([{ status: "open" }]),
  } as unknown as ServerApiClient & { listResources: ReturnType<typeof vi.fn>; listChangeProposals: ReturnType<typeof vi.fn> };
}

describe("useResourceProposalCount", () => {
  it("does not query MY WORK", async () => {
    const api = client();
    const { result } = renderHook(() => useResourceProposalCount(api, "project", "alpha.seq", "work"));
    await act(async () => {});
    expect(result.current).toBeNull();
    expect(api.listResources).not.toHaveBeenCalled();
    expect(api.listChangeProposals).not.toHaveBeenCalled();
  });

  it("resolves the SHARED UUID and does not expose a previous resource count", async () => {
    const api = client();
    const { result, rerender } = renderHook(({ path }) => useResourceProposalCount(api, "project", path, null), { initialProps: { path: "alpha.seq" } });
    await waitFor(() => expect(result.current).toBe(1));
    expect(api.listChangeProposals).toHaveBeenCalledWith("project", "123e4567-e89b-42d3-a456-426614174000");
    rerender({ path: "missing.seq" });
    expect(result.current).toBeNull();
    await waitFor(() => expect(api.listResources).toHaveBeenCalledTimes(2));
    expect(api.listChangeProposals).toHaveBeenCalledTimes(1);
  });

  it("does not query proposals when the SHARED path is ambiguous", async () => {
    const api = client();
    api.listResources.mockResolvedValue([
      { id: "123e4567-e89b-42d3-a456-426614174000", path: "alpha.seq" },
      { id: "123e4567-e89b-42d3-a456-426614174001", path: "alpha.seq" },
    ]);
    renderHook(() => useResourceProposalCount(api, "project", "alpha.seq", null));
    await waitFor(() => expect(api.listResources).toHaveBeenCalled());
    expect(api.listChangeProposals).not.toHaveBeenCalled();
  });

  it("invalidates an in-flight result when the context changes", async () => {
    const api = client();
    let resolveProposals!: (value: { status: string }[]) => void;
    api.listChangeProposals.mockReturnValueOnce(new Promise((resolve) => { resolveProposals = resolve; }));
    const { result, rerender } = renderHook(({ context }) => useResourceProposalCount(api, "project", "alpha.seq", context), { initialProps: { context: null as string | null } });
    await waitFor(() => expect(api.listChangeProposals).toHaveBeenCalled());
    rerender({ context: "work" });
    await act(async () => resolveProposals([{ status: "open" }]));
    expect(result.current).toBeNull();
  });
});
