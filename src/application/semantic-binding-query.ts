import type { ProjectIndex } from "../domain/project/project-index";
import { entityAnchorKey, resolveEntityAnchor, type EntityAnchor, type SemanticBinding } from "../domain/workspace/semantic-binding";

export interface ResolvedSemanticBinding {
  binding: SemanticBinding;
  resolution: { left: "resolved" | "unresolved" | "unavailable"; right: "resolved" | "unresolved" | "unavailable" };
}

/** Query explicitly persisted bindings against the supplied effective index. */
export function listSemanticBindings(bindings: SemanticBinding[], index: ProjectIndex): ResolvedSemanticBinding[] {
  const entities = index.entities ?? [];
  return bindings.filter((binding) => binding.status === "ACTIVE" && binding.projectId === index.projectId)
    .map((binding) => ({ binding, resolution: {
      left: endpointResolution(binding.left, entities, index),
      right: endpointResolution(binding.right, entities, index),
    } }));
}

export function getSemanticBindingsForEntity(anchor: EntityAnchor, bindings: SemanticBinding[], index: ProjectIndex): ResolvedSemanticBinding[] {
  return listSemanticBindings(bindings, index).filter(({ binding }) => entityAnchorKey(binding.left) === entityAnchorKey(anchor) || entityAnchorKey(binding.right) === entityAnchorKey(anchor));
}

function endpointResolution(anchor: EntityAnchor, entities: NonNullable<ProjectIndex["entities"]>, index: ProjectIndex): "resolved" | "unresolved" | "unavailable" {
  if (!index.resources.some((resource) => resource.id === anchor.resourceId)) return "unavailable";
  return resolveEntityAnchor(anchor, entities);
}
