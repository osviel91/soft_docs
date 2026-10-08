import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SemanticBindingsPanel } from "../../../src/features/resource/SemanticBindingsPanel";
import type { EntityAnchor, IndexedEntity, SemanticBinding } from "../../../src/domain/workspace/semantic-binding";
import type { ServerSemanticCandidate } from "../../../src/workspace/server/api-client";

const concept: EntityAnchor = { version: 1, resourceId: "concept-resource", representation: "conceptual", entityKind: "concept", identity: { kind: "local-id", value: "project" } };
const projects: EntityAnchor = { version: 1, resourceId: "database-resource", representation: "database", entityKind: "table", identity: { kind: "local-id", value: "projects" } };
const projectSettings: EntityAnchor = { ...projects, identity: { kind: "local-id", value: "project-settings" } };
const entities: IndexedEntity[] = [{ anchor: concept, name: "Project" }, { anchor: projects, name: "projects" }, { anchor: projectSettings, name: "project settings" }];
const resources = [{ id: "concept-resource", path: "domain.concept", type: "conceptual" }, { id: "database-resource", path: "schema.dbschema", type: "database" }];
const binding: SemanticBinding = { id: "binding-1", projectId: "project", left: concept, right: projects, relation: "represents-in", evidence: { version: 1, rationale: "The data architecture names this representation.", items: [{ kind: "external", reference: "ADR-8", description: "Approved persistence mapping" }] }, revision: 1, status: "ACTIVE", provenance: { authorId: "user-a", contextId: "work-a", createdAt: "2026-01-01" } };
const candidate: ServerSemanticCandidate = { id: "candidate-1", relation: "represents-in", left: concept, right: projects, leftName: "Project", rightName: "Project", leftType: "concept", rightType: "table", leftPath: "domain.concept", rightPath: "schema.dbschema", fingerprint: "fingerprint-1", policyVersion: "v1", ranking: 1, ambiguity: { ambiguous: false, alternativeCount: 0 }, signals: [{ code: "normalized-name-exact", description: "Names match after normalization." }] };
const client = () => ({ listSemanticBindings: vi.fn<() => Promise<SemanticBinding[]>>(async () => []), listResources: vi.fn(async () => [] as never[]), listSemanticCandidates: vi.fn(async () => ({ status: "unconfirmed" as const, notice: "Candidates are suggestions only", candidates: [candidate], total: 1 })), listCandidateAssessments: vi.fn(async () => ({ assessments: [], total: 0 })), assessSemanticCandidate: vi.fn(async () => ({ assessment: { candidateId: candidate.id } as never, bindingCreated: false as const })), createSemanticBinding: vi.fn(async () => binding), updateSemanticBinding: vi.fn(async (_project: string, _context: string, value: SemanticBinding) => ({ ...value, revision: 2 })), removeSemanticBinding: vi.fn(async () => binding) });

function mount(api = client(), initial: SemanticBinding[] = []) {
  api.listSemanticBindings.mockResolvedValue(initial);
  const onOpenEntity = vi.fn();
  const result = render(<SemanticBindingsPanel client={api as never} projectId="project" contextId="work-a" entities={entities} resources={resources} resourceAliases={new Map()} selectedAnchor={concept} writable onOpenEntity={onOpenEntity} />);
  return { ...result, api, onOpenEntity };
}

describe("SemanticBindingsPanel", () => {
  it("shows Account -> accounts when indexed IDs are local aliases of server IDs", async () => {
    const account: EntityAnchor = { ...concept, identity: { kind: "local-id", value: "account" } };
    const accounts: EntityAnchor = { ...projects, identity: { kind: "local-id", value: "accounts" } };
    const serverAccount = { ...account, resourceId: "server-concept-resource" };
    const serverAccounts = { ...accounts, resourceId: "server-database-resource" };
    const serverBinding = { ...binding, left: serverAccount, right: serverAccounts };
    const api = client();
    api.listSemanticBindings.mockResolvedValue([serverBinding]);
    render(<SemanticBindingsPanel client={api as never} projectId="project" contextId="work-a" entities={[{ anchor: account, name: "Account" }, { anchor: accounts, name: "accounts" }]} resources={resources} resourceAliases={new Map([["server-concept-resource", "concept-resource"], ["server-database-resource", "database-resource"]])} selectedAnchor={account} writable={false} onOpenEntity={vi.fn()} />);

    expect(await screen.findByText(/conceptual concept Account · account · domain\.concept/)).toBeInTheDocument();
    expect(screen.getByText("database table accounts · accounts · schema.dbschema")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open related entity" })).toBeInTheDocument();
  });

  it("does not infer a relationship from similar names and creates only the exact selected indexed anchor", async () => {
    const { api } = mount();
    expect(await screen.findByText("No explicit bindings for this entity.")).toBeTruthy();
    expect(screen.queryByTestId("semantic-binding-binding-1")).toBeNull();
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

  it("clears the prior resource selection when navigation supplies no selected entity", async () => {
    const api = client();
    api.listSemanticBindings.mockResolvedValue([binding]);
    const view = render(<SemanticBindingsPanel client={api as never} projectId="project" contextId="work-a" entities={entities} resources={resources} resourceAliases={new Map()} selectedAnchor={concept} writable={false} onOpenEntity={vi.fn()} />);
    await screen.findByTestId("semantic-binding-binding-1");

    view.rerender(<SemanticBindingsPanel client={api as never} projectId="project" contextId="work-a" entities={entities} resources={resources} resourceAliases={new Map()} selectedAnchor={null} writable={false} onOpenEntity={vi.fn()} />);

    expect(screen.getByText(/Select a Conceptual or Database entity/)).toBeInTheDocument();
    expect(screen.queryByTestId("semantic-binding-binding-1")).toBeNull();
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

  it("keeps discovery distinct from bindings, supports explicit assessment and materialization in MY WORK", async () => {
    const api = client();
    api.assessSemanticCandidate.mockResolvedValue({ assessment: { candidateId: candidate.id, candidate: { left: concept, right: projects }, decision: "READY_FOR_BINDING", status: "CURRENT", staleReasons: [], rationale: "Migration confirms the mapping.", evidence: { version: 1, rationale: "Migration confirms the mapping.", items: [{ kind: "external", reference: "migration-42", description: "Defines the project table." }] }, revision: 1 } as never, bindingCreated: false });
    const { onOpenEntity } = mount(api);
    expect(await screen.findByText("Candidate · not a binding")).toBeTruthy();
    expect(screen.queryByText(/No explicit bindings for this entity\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Database entity" }));
    expect(onOpenEntity).toHaveBeenCalledWith(projects);
    fireEvent.change(screen.getByLabelText("Rationale", { selector: "textarea" }), { target: { value: "Migration confirms the mapping." } });
    fireEvent.change(screen.getByLabelText("Evidence reference for READY"), { target: { value: "migration-42" } });
    fireEvent.change(screen.getByLabelText("Evidence description for READY"), { target: { value: "Defines the project table." } });
    fireEvent.click(screen.getByRole("button", { name: "Ready for binding" }));
    await waitFor(() => expect(api.assessSemanticCandidate).toHaveBeenCalledWith("project", "work-a", "candidate-1", expect.objectContaining({ decision: "READY_FOR_BINDING", fingerprint: "fingerprint-1", expectedRevision: 0, evidence: expect.objectContaining({ items: [{ kind: "external", reference: "migration-42", description: "Defines the project table." }] }) })));
  });

  it("disables candidate decisions in SHARED", async () => {
    render(<SemanticBindingsPanel client={client() as never} projectId="project" contextId={null} entities={entities} resources={resources} resourceAliases={new Map()} selectedAnchor={concept} writable={false} onOpenEntity={vi.fn()} />);
    expect(await screen.findByText("Candidate · not a binding")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.getByText(/SHARED \(read-only\)/)).toBeTruthy();
  });
});
