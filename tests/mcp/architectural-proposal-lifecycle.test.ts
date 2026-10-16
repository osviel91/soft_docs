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
  it("lists an explicit proposalId and preserves the persisted status", async () => {
    const architecturalProposals = { list: async () => [proposal] } as unknown as ArchitecturalProposalService;
    const context = { architecturalProposals } as unknown as ToolContext;
    const tool = createMcpTools().find((entry) => entry.name === "list_architectural_proposals")!;
    const result = await tool.run({ projectId: proposal.projectId }, context);
    const structured = (result.structured?.proposals as Array<Record<string, unknown>>)[0]!;

    expect(structured.status).toBe("open");
    expect(structured.id).toBe(proposal.id);
    expect((structured.lifecycle as { state: string }).state).toBe("PROMOTED");
    expect(result.text).toContain(`Promoted proposal — proposalId: ${proposal.id} — effectiveStatus: PROMOTED — recordedStatus: open`);
    expect(tool.requiredPermissions).toEqual(["project:read"]);
  });

  it("navigates from list text to exact details for each lifecycle state", async () => {
    const statuses = [
      { title: "Open", status: "open", effectiveStatus: "OPEN", lifecycle: { state: "OPEN" } },
      { title: "Promoted", status: "open", effectiveStatus: "PROMOTED", lifecycle: { state: "PROMOTED", promotionStatus: "COMPLETED" }, promotion: { id: "40000000-0000-4000-8000-000000000001", status: "COMPLETED", createdAt: new Date(0), completedAt: new Date(1), resultingSharedRevision: "shared-2" } },
      { title: "Pending promotion", status: "open", effectiveStatus: "PROMOTING", lifecycle: { state: "PROMOTING", promotionStatus: "COMMITTED_COMPLETION_PENDING" }, promotion: { id: "40000000-0000-4000-8000-000000000002", status: "COMMITTED_COMPLETION_PENDING", createdAt: new Date(0), resultingSharedRevision: "shared-pending" } },
      { title: "Superseded", status: "superseded", effectiveStatus: "SUPERSEDED", lifecycle: { state: "SUPERSEDED" }, supersedes: { id: "10000000-0000-4000-8000-000000000099", title: "Predecessor" }, supersededBy: { id: "10000000-0000-4000-8000-000000000098", title: "Successor" } },
      { title: "Withdrawn", status: "withdrawn", effectiveStatus: "WITHDRAWN", lifecycle: { state: "WITHDRAWN" } },
    ];
    const proposals = statuses.map((state, index) => ({
      ...proposal,
      ...state,
      recordedStatus: state.status,
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      resources: [],
      lineage: { entries: [
        ...(state.supersedes ? [{ id: state.supersedes.id, title: state.supersedes.title, status: "superseded", supersedesProposalId: null }] : []),
        { id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, title: state.title, status: state.status, supersedesProposalId: state.supersedes?.id ?? null },
        ...(state.supersededBy ? [{ id: state.supersededBy.id, title: state.supersededBy.title, status: "open", supersedesProposalId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` }] : []),
      ], complete: true, diagnostics: [] },
      consistency: state.title === "Open"
        ? { state: "INCONSISTENT", diagnostics: [{ code: "OPEN_PROPOSAL_HAS_SUCCESSOR", message: "Open proposal has a successor." }] }
        : { state: "CONSISTENT", diagnostics: [] },
      ...(state.supersedes ? { supersedes: state.supersedes } : {}),
      ...(state.supersededBy ? { supersededBy: state.supersededBy } : {}),
      ...(state.promotion ? { promotion: state.promotion } : {}),
    }));
    const architecturalProposals = {
      list: async () => proposals,
      get: async (_context: unknown, _projectId: string, proposalId: string) => proposals.find((item) => item.id === proposalId),
    } as unknown as ArchitecturalProposalService;
    const context = { architecturalProposals, capabilities: { proposal: async () => ({}) } } as unknown as ToolContext;
    const tools = createMcpTools();
    const listTool = tools.find((entry) => entry.name === "list_architectural_proposals")!;
    const getTool = tools.find((entry) => entry.name === "get_architectural_proposal")!;
    const listed = await listTool.run({ projectId: proposal.projectId }, context);

    for (const line of listed.text!.split("\n")) {
      const id = line.match(/proposalId: ([0-9a-f-]{36})/)?.[1];
      expect(id).toBeTruthy();
      const detail = await getTool.run({ projectId: proposal.projectId, proposalId: id }, context);
      const result = detail.structured?.proposal as Record<string, any>;
      const expected = proposals.find((item) => item.id === id)!;
      const text = detail.text;
      expect(text).toContain(`Proposal ${id}: ${expected.title}`);
      expect(text).toContain(`recordedStatus: ${expected.status}; effectiveStatus: ${expected.effectiveStatus}; lifecycle.state: ${expected.lifecycle.state}`);
      expect(text).toContain(`Promotion: ${expected.promotion ? expected.promotion.status : "not available"}`);
      expect(text).toContain(`supersedes: ${expected.supersedes ? `${expected.supersedes.title} (${expected.supersedes.id})` : "none"}`);
      expect(text).toContain(`supersededBy: ${expected.supersededBy ? `${expected.supersededBy.title} (${expected.supersededBy.id})` : "none"}`);
      expect(text).toContain(`Consistency: ${expected.consistency.state}; diagnostics: ${expected.consistency.diagnostics.length ? `${expected.consistency.diagnostics[0].code}: ${expected.consistency.diagnostics[0].message}` : "none"}`);
      expect(text).not.toContain("sourcePrivateContextId");
      expect(text).not.toContain("submitted resource content");
      expect(result.id).toBe(id);
      expect(result.title).toBe(expected.title);
      expect(result.status).toBe(expected.status);
      expect(result.effectiveStatus).toBe(expected.effectiveStatus);
      expect(result.lifecycle.state).toBe(expected.lifecycle.state);
      expect(result.lineage).toEqual(expected.lineage);
      expect(result.consistency).toEqual(expected.consistency);
      expect(detail.structured).toEqual({ proposal: expected, capabilities: {} });
      if (expected.promotion) expect(result.promotion).toEqual(expected.promotion);
    }
    const promotedText = (await getTool.run({ projectId: proposal.projectId, proposalId: proposals[1]!.id }, context)).text;
    expect(promotedText).toContain("recordedStatus: open; effectiveStatus: PROMOTED; lifecycle.state: PROMOTED");
    expect(promotedText).toContain("completedAt: 1970-01-01T00:00:00.001Z");
    const pendingText = (await getTool.run({ projectId: proposal.projectId, proposalId: proposals[2]!.id }, context)).text;
    expect(pendingText).toContain("COMMITTED_COMPLETION_PENDING");
    expect(pendingText).not.toContain("completedAt:");
    const diagnosticText = (await getTool.run({ projectId: proposal.projectId, proposalId: proposals[0]!.id }, context)).text;
    expect(diagnosticText).toContain("OPEN_PROPOSAL_HAS_SUCCESSOR: Open proposal has a successor.");
    expect(getTool.requiredPermissions).toEqual(["project:read"]);

    // Structured-content clients retain the same IDs as text-only clients.
    const structured = listed.structured?.proposals as Array<Record<string, unknown>>;
    expect(structured.map((item) => item.id)).toEqual(proposals.map((item) => item.id));
  });
});
