import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SemanticBindingsPanel } from "../../../src/features/resource/SemanticBindingsPanel";
import type { EntityAnchor, IndexedEntity, SemanticBinding } from "../../../src/domain/workspace/semantic-binding";

const concept: EntityAnchor = { version: 1, resourceId: "concept-resource", representation: "conceptual", entityKind: "concept", identity: { kind: "local-id", value: "project" } };
const projects: EntityAnchor = { version: 1, resourceId: "database-resource", representation: "database", entityKind: "table", identity: { kind: "local-id", value: "projects" } };
const projectSettings: EntityAnchor = { ...projects, identity: { kind: "local-id", value: "project-settings" } };
const entities: IndexedEntity[] = [{ anchor: concept, name: "Project" }, { anchor: projects, name: "projects" }, { anchor: projectSettings, name: "project settings" }];
const resources = [{ id: "concept-resource", path: "domain.concept", type: "conceptual" }, { id: "database-resource", path: "schema.dbschema", type: "database" }];
const binding: SemanticBinding = { id: "binding-1", projectId: "project", left: concept, right: projects, relation: "represents-in", evidence: { version: 1, rationale: "The data architecture names this representation.", items: [{ kind: "external", reference: "ADR-8", description: "Approved persistence mapping" }] }, revision: 1, status: "ACTIVE", provenance: { authorId: "user-a", contextId: "work-a", createdAt: "2026-01-01" } };
const client = () => ({ listSemanticBindings: vi.fn<() => Promise<SemanticBinding[]>>(async () => []), listResources: vi.fn(async () => [] as never[]), createSemanticBinding: vi.fn(async () => binding), updateSemanticBinding: vi.fn(async (_project: string, _context: string, value: SemanticBinding) => ({ ...value, revision: 2 })), removeSemanticBinding: vi.fn(async () => binding) });

function mount(api = client(), initial: SemanticBinding[] = []) {
  api.listSemanticBindings.mockResolvedValue(initial);
  const onOpenEntity = vi.fn();
  const result = render(<SemanticBindingsPanel client={api as never} projectId="project" contextId="work-a" entities={entities} resources={resources} selectedAnchor={concept} writable onOpenEntity={onOpenEntity} />);
  return { ...result, api, onOpenEntity };
}

describe("SemanticBindingsPanel", () => {
  it("does not infer a relationship from similar names and creates only the exact selected indexed anchor", async () => {
    const { api } = mount();
    expect(await screen.findByText("No explicit bindings for this entity.")).toBeTruthy();
    expect(screen.queryByText(/represents-in/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Exact indexed endpoint"), { target: { value: JSON.stringify([1, "database-resource", "database", "table", { kind: "local-id", value: "projects" }]) } });
    fireEvent.change(screen.getByLabelText("Evidence rationale"), { target: { value: "Approved mapping" } });
    fireEvent.change(screen.getByLabelText("Evidence reference"), { target: { value: "ADR-8" } });
    fireEvent.change(screen.getByLabelText("Evidence description"), { target: { value: "The approved architecture decision" } });
    fireEvent.click(screen.getByRole("button", { name: "Create binding" }));
    await waitFor(() => expect(api.createSemanticBinding).toHaveBeenCalledWith("project", "work-a", expect.objectContaining({ left: concept, right: projects, relation: "represents-in" })));
  });

  it("navigates through a resolved binding and keeps an unresolved endpoint visible without repair", async () => {
    const api = client();
    const view = mount(api, [binding]);
    const related = await screen.findByRole("button", { name: "Open related entity" });
    fireEvent.click(related);
    expect(view.onOpenEntity).toHaveBeenCalledWith(projects);
    const unresolved = { ...binding, right: { ...projects, resourceId: "retired-database-resource" } };
    api.listSemanticBindings.mockResolvedValue([unresolved]);
    view.unmount();
    mount(api, [unresolved]);
    expect(await screen.findByText(/Binding exists but endpoint is unresolved/)).toBeTruthy();
    expect(screen.getByText(/Evidence: The data architecture names this representation/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open related entity" })).toBeNull();
    expect(view.onOpenEntity).toHaveBeenCalledTimes(1);
  });

  it("updates and removes with the revision read from the binding; stale writes remain visible", async () => {
    const api = client();
    api.updateSemanticBinding.mockRejectedValue(new Error("Conflict: expected revision 1 is stale."));
    mount(api, [binding]);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Evidence rationale"), { target: { value: "Updated evidence rationale" } });
    fireEvent.click(screen.getByRole("button", { name: "Save binding" }));
    await waitFor(() => expect(api.updateSemanticBinding).toHaveBeenCalledWith("project", "work-a", expect.objectContaining({ id: binding.id }), 1));
    expect(await screen.findByRole("alert")).toHaveTextContent(/stale/i);
    api.updateSemanticBinding.mockResolvedValue({ ...binding, revision: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.removeSemanticBinding).toHaveBeenCalledWith("project", "work-a", binding.id, 1));
  });
});
