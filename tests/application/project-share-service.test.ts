import { describe, expect, it } from "vitest";
import { createProjectShareService } from "../../src/application/project-share-service";
import type { ApplicationContext } from "../../src/application/context";
import type { ProjectShareGrant } from "../../src/domain/project/share-grant";

const context: ApplicationContext = { principal: { subjectUserId: "owner", actor: { kind: "user", userId: "owner" }, authType: "session", scopes: [] }, requestId: "request" };

describe("project share authority", () => {
  it("returns the secret only once and exposes only active shared resources", async () => {
    const rows = new Map<string, ProjectShareGrant>();
    let currentTime = new Date("2026-01-01T00:00:00Z");
    const project = { id: "project", name: "Architecture" } as never;
    const shared = { id: "shared-id", projectId: "project", path: "flow.seq", type: "sequence-diagram", revision: 1, lifecycle: "ACTIVE", createdAt: new Date(), updatedAt: new Date() };
    const conceptual = { ...shared, id: "conceptual-id", path: "model.concept", type: "conceptual" };
    const database = { ...shared, id: "database-id", path: "schema.dbschema", type: "database" };
    const privateResource = { ...database, id: "private-id", contextId: "private-context", path: "secret.dbschema" };
    const service = createProjectShareService({
      shares: {
        async create(grant) { rows.set(grant.id, grant); return grant; },
        async list(id) { return [...rows.values()].filter(row => row.projectId === id); },
        async find(id) { return rows.get(id) ?? null; },
         async findByToken(id, hash) { const row = rows.get(id); return row?.tokenHash === hash ? row : null; },
         async revoke(id, actor) { const row = rows.get(id)!; rows.set(id, { ...row, revokedAt: currentTime, revokedByUserId: actor }); },
      },
      projects: {
        async findById() { return project; }, async roleOf() { return "OWNER"; },
          async listResources(_id: string, contextId: string | null) { expect(contextId).toBeNull(); return [shared, conceptual, database, privateResource]; },
         async listResourceRelationships(_id: string, contextId: string | null) { expect(contextId).toBeNull(); return []; },
      } as never,
      storage: () => ({ async read(path: string) { return { ok: true, value: { path, type: "sequence-diagram", content: path } }; } }) as never,
      newId: () => "123e4567-e89b-12d3-a456-426614174000",
      now: () => currentTime,
    });
    const created = await service.create(context, "project");
    expect(created.token).toMatch(/^sdshare_.*\.[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(await service.list(context, "project"))).not.toContain(created.token);
    expect(JSON.stringify(rows.values().next().value)).not.toContain(created.token);
    const projection = await service.read(created.token);
    expect(projection?.resources.map(resource => resource.id)).toEqual(["shared-id", "conceptual-id", "database-id"]);
    expect(await service.read("sdshare_123e4567-e89b-12d3-a456-426614174000.invalid")).toBeNull();
    await service.revoke(context, "project", created.grant.id);
    expect(await service.read(created.token)).toBeNull();
    expect((await service.list(context, "project"))[0].state).toBe("REVOKED");
    const expiring = await service.create(context, "project");
    currentTime = new Date("2026-02-01T00:00:00Z");
    expect(await service.read(expiring.token)).toBeNull();
    expect((await service.list(context, "project")).find(grant => grant.id === expiring.grant.id)?.state).toBe("EXPIRED");
  });

  it("requires explicit project OWNER authority", async () => {
    const service = createProjectShareService({ shares: {} as never, projects: { async findById() { return {}; }, async roleOf() { return "EDITOR"; } } as never, storage: () => ({}) as never });
    await expect(service.create(context, "project")).rejects.toMatchObject({ code: "forbidden" });
  });
});
