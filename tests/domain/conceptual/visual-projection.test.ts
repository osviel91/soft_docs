import { describe, expect, it } from "vitest";
import type { ConceptualModel } from "../../../src/domain/conceptual/model";
import { projectConceptual } from "../../../src/domain/conceptual/visual-projection";

describe("Conceptual visual projection", () => {
  it("preserves identities, labels, direction, descriptions, and all graph shapes", () => {
    const model: ConceptualModel = {
      concepts: [
        { id: "a", name: "A long customer concept", description: "An isolated concept with a description." },
        { id: "b", name: "B" }, { id: "c", name: "C" }, { id: "d", name: "D" }, { id: "isolated", name: "Isolated" },
      ],
      relationships: [
        { id: "chain", sourceConceptId: "a", targetConceptId: "b", label: "directed label", direction: "directed" },
        { id: "star", sourceConceptId: "a", targetConceptId: "c", label: "branch", direction: "directed" },
        { id: "cycle-1", sourceConceptId: "b", targetConceptId: "c", label: "cycle", direction: "directed" },
        { id: "cycle-2", sourceConceptId: "c", targetConceptId: "b", label: "back", direction: "directed" },
        { id: "parallel-1", sourceConceptId: "a", targetConceptId: "b", label: "parallel one", direction: "undirected" },
        { id: "parallel-2", sourceConceptId: "a", targetConceptId: "b", label: "parallel two", direction: "directed" },
        { id: "self", sourceConceptId: "d", targetConceptId: "d", label: "self", direction: "undirected" },
      ],
    };
    const projected = projectConceptual(model);
    expect(projected.items).toHaveLength(5);
    expect(projected.connections).toHaveLength(7);
    expect(projected.items.map(item => item.semanticConceptId)).toEqual(["a", "b", "c", "d", "isolated"]);
    expect(projected.connections.map(item => item.semanticRelationshipId)).toEqual(model.relationships.map(item => item.id));
    expect(projected.connections.map(item => item.direction)).toEqual(model.relationships.map(item => item.direction));
    expect(projected.connections[4]?.visualId).not.toBe(projected.connections[5]?.visualId);
    expect(projected.items[0]?.description).toBe(model.concepts[0]?.description);
    expect(projected.items[0]?.requiredWidth).toBeGreaterThanOrEqual(140);
    expect(projected.geometry.connections[6]?.source.itemId).toBe(projected.geometry.connections[6]?.target.itemId);
    expect(projected.items[4]?.semanticConceptId).toBe("isolated");
    expect(model.concepts[0]).toEqual({ id: "a", name: "A long customer concept", description: "An isolated concept with a description." });
  });

  it("keeps same display names resource-local and descriptions out of identity", () => {
    const first = projectConceptual({ concepts: [{ id: "same", name: "Account" }], relationships: [] });
    const other = projectConceptual({ concepts: [{ id: "same", name: "Account", description: "Changed note" }], relationships: [] });
    expect(first.visualIdByConceptId.same).toBe(other.visualIdByConceptId.same);
    expect(first.items[0]?.semanticConceptId).toBe("same");
    expect(first.items[0]?.visualId).not.toBe("same");
  });
});
