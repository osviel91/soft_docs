import type { SemanticBindingRepository, SemanticBindingScope } from "../application/ports/semantic-binding-repository";
import type { ProjectStorage } from "../application/project-storage";
import type { SemanticBinding } from "../domain/workspace/semantic-binding";
import { validateSemanticBinding } from "../domain/workspace/semantic-binding";
import { isOk } from "../shared/result/result";

const PATH = ".semantic-bindings.json";
interface Registry { version: 1; bindings: SemanticBinding[]; history: SemanticBinding[] }
const empty: Registry = { version: 1, bindings: [], history: [] };

/** Local sidecar implementation of the same scoped binding contract as SQL. */
export function createLocalSemanticBindingRepository(storage: ProjectStorage): SemanticBindingRepository {
  async function read(): Promise<{ registry: Registry; raw: string | null }> {
    const result = await storage.read(PATH);
    if (!isOk(result)) throw result.error;
    if (!result.value) return { registry: empty, raw: null };
    const value: unknown = JSON.parse(result.value.content);
    if (!value || typeof value !== "object" || (value as Registry).version !== 1 || !Array.isArray((value as Registry).bindings) || !Array.isArray((value as Registry).history)) throw new Error("Invalid semantic binding registry.");
    return { registry: value as Registry, raw: result.value.content };
  }
  async function save(previous: string | null, registry: Registry): Promise<void> {
    if (!storage.writeIfUnchanged) throw new Error("Local binding storage must support atomic compare-and-write.");
    const result = await storage.writeIfUnchanged(PATH, previous, JSON.stringify(registry, null, 2));
    if (!isOk(result)) throw result.error;
  }
  const inScope = (binding: SemanticBinding, scope: SemanticBindingScope) => binding.projectId === scope.projectId && (binding.provenance.contextId ?? null) === scope.contextId;
  return {
    async list(scope) { return (await read()).registry.bindings.filter((binding) => inScope(binding, scope)).sort((a, b) => a.id.localeCompare(b.id)); },
    async get(scope, id) { return (await read()).registry.bindings.find((binding) => binding.id === id && inScope(binding, scope)) ?? null; },
    async history(scope, id) { return (await read()).registry.history.filter((binding) => binding.id === id && inScope(binding, scope)).sort((a, b) => a.revision - b.revision); },
    async create(binding) {
      validateSemanticBinding(binding);
      if (binding.revision !== 1 || binding.status !== "ACTIVE") throw new Error("A new semantic binding must be active at revision 1.");
      const { registry, raw } = await read();
      if (registry.bindings.some((entry) => entry.id === binding.id && entry.projectId === binding.projectId && (entry.provenance.contextId ?? null) === (binding.provenance.contextId ?? null))) throw new Error(`Semantic binding ${binding.id} already exists.`);
      await save(raw, { ...registry, bindings: [...registry.bindings, binding], history: [...registry.history, binding] });
      return binding;
    },
    async update(scope, binding, expectedRevision) {
      if (!inScope(binding, scope)) throw new Error("Semantic binding scope does not match the requested scope.");
      const { registry, raw } = await read();
      const index = registry.bindings.findIndex((entry) => entry.id === binding.id && inScope(entry, scope) && entry.revision === expectedRevision);
      if (index < 0) throw new Error(`Semantic binding changed since it was read: expected revision ${expectedRevision}.`);
      const updated = { ...binding, revision: expectedRevision + 1 };
      validateSemanticBinding(updated);
      const bindings = [...registry.bindings]; bindings[index] = updated;
      await save(raw, { ...registry, bindings, history: [...registry.history, updated] });
      return updated;
    },
    async remove(scope, id, expectedRevision) {
      const { registry, raw } = await read();
      const binding = registry.bindings.find((entry) => entry.id === id && inScope(entry, scope) && entry.revision === expectedRevision);
      if (!binding) throw new Error(`Semantic binding changed since it was read: expected revision ${expectedRevision}.`);
      const tombstone = { ...binding, revision: expectedRevision + 1, status: "RETIRED" as const };
      await save(raw, { ...registry, bindings: registry.bindings.filter((entry) => entry !== binding), history: [...registry.history, tombstone] });
      return tombstone;
    },
    async retire(scope, id, expectedRevision) {
      const { registry, raw } = await read();
      const index = registry.bindings.findIndex((entry) => entry.id === id && inScope(entry, scope) && entry.revision === expectedRevision);
      if (index < 0) throw new Error(`Semantic binding changed since it was read: expected revision ${expectedRevision}.`);
      const retired = { ...registry.bindings[index], revision: expectedRevision + 1, status: "RETIRED" as const };
      const bindings = [...registry.bindings]; bindings[index] = retired;
      await save(raw, { ...registry, bindings, history: [...registry.history, retired] });
      return retired;
    },
  };
}
