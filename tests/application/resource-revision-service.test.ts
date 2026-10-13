import { describe, expect, it, vi } from "vitest";
import { ApplicationError } from "../../src/application/errors";
import { createResourceRevisionService } from "../../src/application/resource-revision-service";
import type { ApplicationContext } from "../../src/application/context";
import type { AuthorizationPolicy } from "../../src/application/authorization";
import type { KnowledgeContextRepository } from "../../src/application/ports/knowledge-context-repository";
import type { ProjectRepository } from "../../src/application/ports/project-repository";

const context: ApplicationContext = {
  requestId: "test",
  principal: { subjectUserId: "owner", actor: { kind: "user", userId: "owner" }, authType: "session", scopes: ["resource:read", "project:read"] },
};

function harness() {
  const resource = { id: "resource", projectId: "project", contextId: "work", path: "model.concept", type: "conceptual", revision: 2, lifecycle: "ACTIVE", createdAt: new Date(), updatedAt: new Date() };
  const revisions = [1, 2].map((revision) => ({ resourceId: "resource", revision, content: `concept c${revision} "Concept"`, type: "conceptual" as const, authoredBy: { kind: "user" as const, userId: "owner", subjectUserId: "owner" }, createdAt: new Date(`2026-01-0${revision}T00:00:00Z`) }));
  const projects = {
    findResource: vi.fn(async (projectId: string, resourceId: string, contextId: string | null) => projectId === resource.projectId && resourceId === resource.id && contextId === resource.contextId ? resource : null),
    listRevisions: vi.fn(async () => revisions),
    getRevision: vi.fn(async (resourceId: string, revision: number) => resourceId === "resource" ? revisions.find((entry) => entry.revision === revision) ?? null : null),
  } as unknown as ProjectRepository;
  const knowledgeContexts = { findPrivate: vi.fn(async (projectId: string, contextId: string, ownerUserId: string) => projectId === "project" && contextId === "work" && ownerUserId === "owner" ? { id: contextId } : null) } as unknown as KnowledgeContextRepository;
  const policy = { requirePermission: vi.fn(async () => ({ allowed: true as const, role: "OWNER" as const, project: { id: "project" } })) } as unknown as AuthorizationPolicy;
  return { resource, revisions, projects, knowledgeContexts, policy, service: createResourceRevisionService({ projects, knowledgeContexts, policy }) };
}

describe("resource revision service", () => {
  it("lists light revision summaries only after exact-context resource authorization", async () => {
    const { service, projects, knowledgeContexts } = harness();
    const revisions = await service.list(context, "project", "resource", "work");

    expect(knowledgeContexts.findPrivate).toHaveBeenCalledWith("project", "work", "owner");
    expect(projects.findResource).toHaveBeenCalledWith("project", "resource", "work");
    expect(revisions).toEqual([
      expect.objectContaining({ projectId: "project", resourceId: "resource", contextId: "work", revision: 1, type: "conceptual", representation: "conceptual" }),
      expect.objectContaining({ projectId: "project", resourceId: "resource", contextId: "work", revision: 2, type: "conceptual", representation: "conceptual" }),
    ]);
    expect(revisions[0]).not.toHaveProperty("content");
  });

  it("retrieves a typed snapshot for an authorized SHARED resource only with explicit shared scope", async () => {
    const { service, projects, knowledgeContexts } = harness();
    const sharedResource = { id: "shared", projectId: "project", path: "schema.dbschema", type: "database", revision: 1, lifecycle: "ACTIVE", createdAt: new Date(), updatedAt: new Date() };
    const sharedRevision = { resourceId: "shared", revision: 1, content: 'table accounts - "Accounts"', type: "database" as const, metadata: { description: "Schema" }, authoredBy: { kind: "system" as const }, createdAt: new Date("2026-01-01T00:00:00Z") };
    vi.mocked(projects.findResource).mockResolvedValue(sharedResource as never);
    vi.mocked(projects.getRevision).mockResolvedValue(sharedRevision as never);

    const snapshot = await service.get(context, "project", "shared", null, 1);

    expect(knowledgeContexts.findPrivate).not.toHaveBeenCalled();
    expect(projects.findResource).toHaveBeenCalledWith("project", "shared", null);
    expect(snapshot).toMatchObject({ projectId: "project", resourceId: "shared", contextId: null, revision: 1, type: "database", representation: "database", content: sharedRevision.content, metadata: sharedRevision.metadata, authoredBy: sharedRevision.authoredBy });
  });

  it("does not query revision content for a foreign context or a resource from another context", async () => {
    const { service, projects, knowledgeContexts } = harness();

    await expect(service.get(context, "project", "resource", "foreign-context", 1)).rejects.toMatchObject({ code: "not_found" });
    vi.mocked(knowledgeContexts.findPrivate).mockResolvedValue({ id: "work" } as never);
    await expect(service.get(context, "project", "resource", null, 1)).rejects.toMatchObject({ code: "not_found" });

    expect(projects.getRevision).not.toHaveBeenCalled();
  });

  it("does not query history when project resource:read is denied", async () => {
    const { service, projects, knowledgeContexts, policy } = harness();
    vi.mocked(policy.requirePermission).mockRejectedValue(new ApplicationError("forbidden", "resource:read denied"));

    await expect(service.list(context, "project", "resource", null)).rejects.toMatchObject({ code: "forbidden" });
    expect(projects.findResource).not.toHaveBeenCalled();
    expect(projects.listRevisions).not.toHaveBeenCalled();
    expect(knowledgeContexts.findPrivate).not.toHaveBeenCalled();
  });

  it("returns not_found for a missing revision and rejects a mismatched repository result", async () => {
    const { service, projects } = harness();
    await expect(service.get(context, "project", "resource", "work", 99)).rejects.toMatchObject({ code: "not_found" });
    vi.mocked(projects.getRevision).mockResolvedValue({ resourceId: "other", revision: 1 } as never);
    await expect(service.get(context, "project", "resource", "work", 1)).rejects.toMatchObject({ code: "internal" });
  });
});
