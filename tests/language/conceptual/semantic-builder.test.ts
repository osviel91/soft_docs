import { describe, expect, it } from "vitest";
import { parseConceptualSyntax } from "../../../src/language/conceptual/parser";
import { buildConceptualModel } from "../../../src/language/conceptual/semantic-builder";
import { validateConceptual } from "../../../src/domain/conceptual/validate";

describe("Conceptual semantic construction", () => {
  it("constructs the approved model without changing authored identities or provenance", () => {
    const syntax = parseConceptualSyntax('title "Commerce"\nconcept customer "Account Holder" description "A buyer"\nconcept order "Order"\nrelation purchases customer -> order "purchases" description "One or more"\nrelation related customer -- order "related to"\n').ast;
    const { model, ranges } = buildConceptualModel(syntax);
    expect(model).toEqual({
      title: "Commerce",
      concepts: [{ id: "customer", name: "Account Holder", description: "A buyer" }, { id: "order", name: "Order" }],
      relationships: [
        { id: "purchases", sourceConceptId: "customer", targetConceptId: "order", label: "purchases", direction: "directed", description: "One or more" },
        { id: "related", sourceConceptId: "customer", targetConceptId: "order", label: "related to", direction: "undirected" },
      ],
    });
    expect(ranges.get("concept:customer")?.start.line).toBe(1);
  });

  it("validates semantic identity and endpoint invariants after construction", () => {
    const { model } = buildConceptualModel(parseConceptualSyntax('concept customer "Customer"\nrelation missing customer -> absent "links"\n').ast);
    expect(validateConceptual({ ...model, concepts: [...model.concepts, { id: "customer", name: "Duplicate" }] }).map(({ code }) => code)).toEqual([
      "conceptual.duplicate-concept-id",
      "conceptual.unknown-target",
    ]);
  });
});
