import { describe, expect, it, vi } from "vitest";
import { createResourceTrajectoryService } from "../../src/application/resource-trajectory-service";
import type { ApplicationContext } from "../../src/application/context";
import type { AuthorizationPolicy } from "../../src/application/authorization";
import type { KnowledgeContextRepository } from "../../src/application/ports/knowledge-context-repository";
import type { ProjectRepository, ResourceRecord } from "../../src/application/ports/project-repository";

const ownerA: ApplicationContext = { requestId: "a", principal: { subjectUserId: "user-a", actor: { kind: "user", userId: "user-a" }, authType: "session", scopes: ["resource:read", "project:read"] } };
const ownerB: ApplicationContext = { requestId: "b", principal: { subjectUserId: "user-b", actor: { kind: "user", userId: "user-b" }, authType: "session", scopes: ["resource:read", "project:read"] } };

function makeResource(id: string, contextId: string | null, lifecycle: "ACTIVE" | "RETIRED" = "ACTIVE"): ResourceRecord {
  return { id, projectId: "project", ...(contextId === null ? {} : { contextId }), path: `${id}.md`, type: "markdown-document", revision: 1, lifecycle, ...(lifecycle === "RETIRED" ? { retiredAt: new Date("2026-01-02T00:00:00Z") } : {}), createdAt: new Date(), updatedAt: new Date() };
}

function harness() {
  const resources = [makeResource("shared", null), makeResource("private-a", "work-a"), makeResource("private-b", "work-b"), makeResource("retired-shared", null, "RETIRED")];
  const projects = {
    findResource: vi.fn(async (projectId: string, resourceId: string, contextId: string | null) => resources.find((resource) => resource.projectId === projectId && resource.id === resourceId && (resource.contextId ?? null) === contextId && resource.lifecycle === "ACTIVE") ?? null),
    findHistoricalResource: vi.fn(async (projectId: string, resourceId: string, contextId?: string | null) => resources.find((resource) => resource.projectId === projectId && resource.id === resourceId && (resource.contextId ?? null) === (contextId ?? null)) ?? null),
    listTrajectory: vi.fn(async (_projectId: string, options: { contextId?: string | null; resourceId?: string; limit?: number; cursor?: number } = {}) => ({
      entries: resources.filter((resource) => (resource.contextId ?? null) === (options.contextId ?? null) && (options.resourceId === undefined || resource.id === options.resourceId)).map((resource) => ({ resourceId: resource.id, projectId: resource.projectId, resourcePath: resource.path, resultingRevision: resource.revision })) as never,
      nextCursor: null,
    })),
  } as unknown as ProjectRepository;
  const knowledgeContexts = { findPrivate: vi.fn(async (projectId: string, contextId: string, ownerUserId: string) => projectId === "project" && ((contextId === "work-a" && ownerUserId === "user-a") || (contextId === "work-b" && ownerUserId === "user-b")) ? { id: contextId } : null) } as unknown as KnowledgeContextRepository;
  const policy = { requirePermission: vi.fn(async () => ({ allowed: true as const, role: "VIEWER" as const, project: { id: "project" } })) } as unknown as AuthorizationPolicy;
  const service = createResourceTrajectoryService({ projects, knowledgeContexts, policy });
  return { projects, knowledgeContexts, policy, service };
}

describe("resource trajectory context authorization", () => {
  it("defaults a project trajectory to SHARED only", async () => {
    const { service, projects, knowledgeContexts } = harness();
    const result = await service.getProjectTrajectory(ownerA, "project");

    expect(knowledgeContexts.findPrivate).not.toHaveBeenCalled();
    expect(projects.listTrajectory).toHaveBeenCalledWith("project", expect.objectContaining({ contextId: null }));
    expect(result.entries.map((entry) => entry.resourceId)).toEqual(["shared", "retired-shared"]);
  });

  it("authorizes an explicitly selected private context before listing its trajectory", async () => {
    const { service, projects, policy, knowledgeContexts } = harness();
    const result = await service.getProjectTrajectory(ownerA, "project", {}, "work-a");

    expect(knowledgeContexts.findPrivate).toHaveBeenCalledWith("project", "work-a", "user-a");
    expect(policy.requirePermission).toHaveBeenCalledWith(ownerA, "project", "resource:read");
    expect(policy.requirePermission).toHaveBeenCalledWith(ownerA, "project", "project:read");
    expect(projects.listTrajectory).toHaveBeenCalledWith("project", expect.objectContaining({ contextId: "work-a" }));
    expect(result.entries.map((entry) => entry.resourceId)).toEqual(["private-a"]);
  });

  it("does not query an unowned context or a resource from another context", async () => {
    const { service, projects } = harness();
    await expect(service.getProjectTrajectory(ownerA, "project", {}, "work-b")).rejects.toMatchObject({ code: "not_found" });
    await expect(service.getResourceTrajectory(ownerA, "project", "private-b", {}, "work-a")).rejects.toMatchObject({ code: "not_found" });
    expect(projects.listTrajectory).not.toHaveBeenCalled();

    await expect(service.getProjectTrajectory(ownerB, "project", {}, "work-b")).resolves.toMatchObject({ entries: [expect.objectContaining({ resourceId: "private-b" })] });
  });

  it("keeps retired SHARED history available but does not resolve retired MY WORK", async () => {
    const { service, projects } = harness();
    const shared = await service.getResourceTrajectory(ownerA, "project", "retired-shared", {}, null);
    expect(shared.entries).toEqual([expect.objectContaining({ resourceId: "retired-shared" })]);
    expect(projects.findHistoricalResource).toHaveBeenCalledWith("project", "retired-shared", null);

    vi.mocked(projects.findHistoricalResource!).mockResolvedValue(null);
    await expect(service.getResourceTrajectory(ownerA, "project", "private-b", {}, "work-b")).rejects.toMatchObject({ code: "not_found" });
  });
});
