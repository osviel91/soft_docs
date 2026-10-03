// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApplicationContext } from "../../src/application/context";
import { createWorkspaceInvitationService } from "../../src/application/workspace-invitation-service";
import { ApplicationError } from "../../src/application/errors";
import { ALL_PERMISSIONS } from "../../src/domain/access/permissions";
import { createUserRepository } from "../../src/persistence/user-repository";
import { createWorkspaceRepository } from "../../src/persistence/workspace-repository";
import { createWorkspaceInvitationRepository } from "../../src/persistence/workspace-invitation-repository";
import type { SqlClient } from "../../src/persistence/sql-client";
import { openTestDatabase, closeTestDatabase } from "./test-database";

let sql: SqlClient;
let users: ReturnType<typeof createUserRepository>;
let workspaces: ReturnType<typeof createWorkspaceRepository>;
let service: ReturnType<typeof createWorkspaceInvitationService>;

beforeAll(async () => {
  sql = await openTestDatabase();
  users = createUserRepository(sql);
  workspaces = createWorkspaceRepository(sql);
service = createWorkspaceInvitationService({ invitations: createWorkspaceInvitationRepository(sql), workspaces });
});
afterAll(async () => closeTestDatabase(sql));

async function user(subject: string): Promise<string> {
  return (await users.findOrCreateByExternalIdentity({ issuer: "https://idp.test", subject, displayName: subject, email: null })).id;
}
const context = (userId: string): ApplicationContext => ({ requestId: "invite-test", principal: { subjectUserId: userId, actor: { kind: "user", userId }, authType: "session", scopes: ALL_PERMISSIONS } });

describe("workspace invitation links", () => {
  it("is transferable, single-use, role-bound, and audited atomically", async () => {
    const ownerId = await user("invite-owner");
    const guestId = await user("invite-guest");
    const workspace = await workspaces.create({ ownerId, name: "Invited workspace" });
    const created = await service.create(context(ownerId), workspace.id, "VIEWER");
    expect(created.token).toMatch(/^sdi_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(created.invitation)).not.toContain(created.token);
    expect((await service.inspect(created.token))?.invitation.role).toBe("VIEWER");
    await service.accept(context(guestId), created.token);
    expect(await workspaces.roleOf(workspace.id, guestId)).toBe("VIEWER");
    await expect(service.accept(context(await user("invite-third")), created.token)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.accept(context(guestId), created.token)).rejects.toMatchObject({ code: "not_found" });
    const events = await sql.query("SELECT action FROM audit_events WHERE detail->>'invitationId'=$1", [created.invitation.id]);
    expect(events.rows.map(row => row.action).sort()).toEqual(["workspace.invitation.accepted", "workspace.member.added", "workspace.invitation.created"].sort());
  });

  it("requires an admin and revokes without exposing an active preview", async () => {
    const ownerId = await user("revoke-owner");
    const memberId = await user("revoke-member");
    const workspace = await workspaces.create({ ownerId, name: "Revocable" });
    await workspaces.setMember(workspace.id, memberId, "EDITOR");
    await expect(service.create(context(memberId), workspace.id, "VIEWER")).rejects.toBeInstanceOf(ApplicationError);
    const created = await service.create(context(ownerId), workspace.id, "EDITOR");
    await service.revoke(context(ownerId), workspace.id, created.invitation.id);
    expect(await service.inspect(created.token)).toBeNull();
    await expect(service.accept(context(memberId), created.token)).rejects.toMatchObject({ code: "not_found" });
  });
});
