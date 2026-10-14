import { describe, expect, it } from "vitest";
import { ServerApiClient } from "../../src/workspace/server/api-client";

describe("ServerApiClient trajectory context", () => {
  it("sends SHARED explicitly by default and includes a selected MY WORK context", async () => {
    const requests: string[] = [];
    const client = new ServerApiClient({ fetch: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ entries: [], nextCursor: null }), { status: 200, headers: { "content-type": "application/json" } });
    } });

    await client.getProjectTrajectory("project", { limit: 5, cursor: 10 });
    await client.getProjectTrajectory("project", {}, "work/a");
    await client.getResourceTrajectory("project", "resource/one", {}, "work/a");

    expect(requests).toEqual([
      "/api/projects/project/trajectory?contextId=shared&limit=5&cursor=10",
      "/api/projects/project/trajectory?contextId=work%2Fa",
      "/api/projects/project/resources/resource%2Fone/trajectory?contextId=work%2Fa",
    ]);
  });
});
