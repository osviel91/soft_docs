import { describe, expect, it } from "vitest";
import { activeNodeScopeKey, type ActiveNodeScope } from "../../../src/features/preview/active-node-scope";

const scope: ActiveNodeScope = {
  workspaceMode: "server",
  projectId: "project-a",
  contextId: null,
  resourceId: "resource-a",
  representation: "conceptual",
};

describe("active node selection scope", () => {
  it.each([
    ["workspaceMode", "local"],
    ["projectId", "project-b"],
    ["contextId", "work-1"],
    ["resourceId", "resource-b"],
    ["representation", "database"],
  ] as const)("changes when %s changes", (key, value) => {
    expect(activeNodeScopeKey({ ...scope, [key]: value })).not.toBe(activeNodeScopeKey(scope));
  });
});
