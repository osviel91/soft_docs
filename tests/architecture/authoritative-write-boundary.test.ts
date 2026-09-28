import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (file: string) => readFile(path.join(root, file), "utf8");

describe("authoritative write boundary", () => {
  it("rejects SHARED resource mutations at the application seam", async () => {
    const text = await source("src/application/project-catalog.ts");
    expect(text).toContain("Authoritative resources can only be changed through proposal promotion.");
    expect(text.match(/Authoritative resources can only be changed through proposal promotion/g)?.length).toBe(4);
  });

  it("keeps authoritative persistence behind the two classified writers", async () => {
    const promotion = await source("src/application/promotion-service.ts");
    const bootstrap = await source("src/application/project-bootstrap-service.ts");
    expect(promotion).toContain("options.batches.claim");
    expect(bootstrap).toContain("options.batches.claim");
    expect(await source("src/application/workspace-mutations.ts")).not.toContain("AuthoritativeBatchRepository");
  });

  it("keeps the MCP adapter above application use cases", async () => {
    const files = [
      "apps/mcp/app.ts",
      "apps/mcp/mcp/handler.ts",
      "apps/mcp/mcp/server.ts",
      "apps/mcp/mcp/tools.ts",
    ];
    for (const file of files) {
      const text = await source(file);
      expect(text).not.toContain("AuthoritativeBatchRepository");
      expect(text).not.toContain("authoritative-batch-repository");
      expect(text).not.toContain("options.batches.claim");
    }
  });

  it("requires MY WORK in remote MCP mutation tools", async () => {
    const text = await source("apps/mcp/mcp/tools.ts");
    for (const name of ["create_resource", "update_resource", "move_resource", "delete_resource", "create_resource_relationship"]) {
      const start = text.indexOf(`name: "${name}"`);
      const end = text.indexOf("name:", start + 6);
      const block = text.slice(start, end === -1 ? undefined : end);
      expect(block).toContain("contextId: z.string().uuid()");
      expect(block).not.toContain("contextId: z.string().uuid().optional()");
    }
  });

  it("retires ChangeProposal publication", async () => {
    const text = await source("src/application/change-proposal-service.ts");
    expect(text).toContain("ChangeProposal merge is retired");
    expect(text).toContain('reason: "legacy_publication"');
  });
});
