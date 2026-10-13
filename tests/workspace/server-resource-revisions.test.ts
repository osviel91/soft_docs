import { describe, expect, it } from "vitest";
import { ServerApiClient } from "../../src/workspace/server/api-client";
import { AccessDeniedError } from "../../src/workspace/server/api-errors";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

describe("ServerApiClient resource revisions", () => {
  it("lists light revision summaries and reads a snapshot in the explicit MY WORK context", async () => {
    const calls: string[] = [];
    const client = new ServerApiClient({ fetch: async (input) => {
      calls.push(String(input));
      if (String(input).endsWith("/revisions?contextId=work%2Fone")) {
        return reply(200, { revisions: [{ resourceId: "r1", projectId: "p1", contextId: "work/one", revision: 2, type: "conceptual", representation: "conceptual", createdAt: "2026-01-02T00:00:00.000Z" }] });
      }
      return reply(200, { snapshot: { resourceId: "r1", projectId: "p1", contextId: "work/one", path: "model.concept", revision: 2, type: "conceptual", representation: "conceptual", content: 'concept c "Concept"', authoredBy: { kind: "user", userId: "u1", subjectUserId: "u1" }, createdAt: "2026-01-02T00:00:00.000Z" } });
    } });

    const summaries = await client.listResourceRevisions("p1", "r1/encoded", "work/one");
    const snapshot = await client.getResourceRevision("p1", "r1/encoded", "work/one", 2);

    expect(calls[0]).toContain("/resources/r1%2Fencoded/revisions?contextId=work%2Fone");
    expect(calls[1]).toContain("/resources/r1%2Fencoded/revisions/2?contextId=work%2Fone");
    expect(summaries[0]).not.toHaveProperty("content");
    expect(snapshot).toMatchObject({ resourceId: "r1", projectId: "p1", contextId: "work/one", revision: 2, content: 'concept c "Concept"' });
  });

  it("identifies SHARED explicitly and preserves authorization errors", async () => {
    const calls: string[] = [];
    const client = new ServerApiClient({ fetch: async (input) => {
      calls.push(String(input));
      return reply(403, { error: { code: "forbidden", message: "Not allowed" } });
    } });

    await expect(client.listResourceRevisions("p1", "r1", null)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(calls[0]).toContain("/resources/r1/revisions?contextId=shared");
  });
});
