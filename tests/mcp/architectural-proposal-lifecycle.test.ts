import { describe, expect, it } from "vitest";
import { createMcpTools, type ToolContext } from "../../apps/mcp/mcp/tools";
import type { ArchitecturalProposalService, PublicArchitecturalProposalSummary } from "../../src/application/architectural-proposal-service";

const proposal: PublicArchitecturalProposalSummary & { lifecycle?: { state: "PROMOTED"; promotionStatus: "COMPLETED" } } = {
  id: "10000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000001",
  authorUserId: "30000000-0000-4000-8000-000000000001",
  title: "Promoted proposal",
  status: "open",
  supersedesProposalId: null,
  withdrawnAt: null,
  withdrawnBy: null,
  withdrawalReason: null,
  supersededAt: null,
  baseSharedRevision: "base",
  baseSharedResourceRevisions: {},
  baseManifestRevision: 1,
  createdAt: new Date(0),
  submittedAt: new Date(0),
  staleBase: true,
  currentSharedRevision: "later",
  reviewStatus: "approved",
  approvals: 1,
  changesRequested: 0,
  recordedStatus: "open",
  effectiveStatus: "PROMOTED",
  actionable: false,
  lineage: { entries: [{ id: "10000000-0000-4000-8000-000000000001", title: "Promoted proposal", status: "open", supersedesProposalId: null }], complete: true, diagnostics: [] },
  consistency: { state: "CONSISTENT", diagnostics: [] },
  lifecycle: { state: "PROMOTED", promotionStatus: "COMPLETED" },
};

describe("MCP architectural proposal lifecycle wording", () => {
  it("states the effective lifecycle without changing the recorded status field", async () => {
    const architecturalProposals = { list: async () => [proposal] } as unknown as ArchitecturalProposalService;
    const context = { architecturalProposals } as unknown as ToolContext;
    const tool = createMcpTools().find((entry) => entry.name === "list_architectural_proposals")!;
    const result = await tool.run({ projectId: proposal.projectId }, context);
    const structured = (result.structured?.proposals as Array<Record<string, unknown>>)[0]!;

    expect(structured.status).toBe("open");
    expect((structured.lifecycle as { state: string }).state).toBe("PROMOTED");
    expect(result.text).toContain("Promoted proposal (PROMOTED; recorded status open)");
  });
});
