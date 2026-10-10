import { expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createProposalInboxService, proposalInboxCursor } from "../../src/application/proposal-inbox-service";
import type { ApplicationContext } from "../../src/application/context";
import type { ProposalInboxRepository } from "../../src/application/ports/proposal-inbox-repository";
import type { Permission } from "../../src/domain/access/permissions";

const context = (scopes: Permission[]): ApplicationContext => ({
  requestId: "inbox-test",
  principal: { subjectUserId: "user", actor: { kind: "user", userId: "user" }, authType: "session", scopes },
});

it("requires project read scope, bounds filters and forwards token project restrictions", async () => {
  const repository = { query: vi.fn().mockResolvedValue({ items: [], hasMore: false, nextPosition: null, counts: {} }) } as unknown as ProposalInboxRepository;
  const inbox = createProposalInboxService({ repository, cursorSecret: "test-secret" });
  await expect(inbox.list(context([]), {})).rejects.toMatchObject({ code: "forbidden" });
  await expect(inbox.list(context(["project:read"]), { limit: 101 })).rejects.toMatchObject({ code: "invalid" });
  await expect(inbox.list(context(["project:read"]), { cursor: "tampered.signature" })).rejects.toMatchObject({ code: "invalid" });
  await inbox.list({ ...context(["project:read"]), principal: { ...context(["project:read"]).principal, allowedProjectIds: ["project-a"] } }, { attentionCategory: ["PENDING_REVIEW"] });
  expect(repository.query).toHaveBeenCalledWith(expect.objectContaining({ userId: "user", allowedProjectIds: ["project-a"] }));

  const filterKey = JSON.stringify({ attentionCategory: ["PENDING_REVIEW"], limit: undefined });
  const cursor = proposalInboxCursor("test-secret", { at: "2026-01-01T00:00:00.000Z", id: "50000000-0000-4000-8000-000000000001", filterKey });
  await expect(inbox.list(context(["project:read"]), { cursor })).rejects.toMatchObject({ code: "invalid" });

  const incompatible = Buffer.from(JSON.stringify({ v: 2, at: "2026-01-01T00:00:00.000000Z", id: "50000000-0000-4000-8000-000000000001", filterKey: JSON.stringify({ filters: { limit: undefined }, userId: "user", allowedProjectIds: null }) })).toString("base64url");
  const signature = createHmac("sha256", "test-secret").update(`proposal-inbox-cursor:${incompatible}`).digest("base64url");
  await expect(inbox.list(context(["project:read"]), { cursor: `${incompatible}.${signature}` })).rejects.toMatchObject({ code: "invalid" });
});
