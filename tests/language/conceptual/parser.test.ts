import { describe, expect, it } from "vitest";
import { parseConceptual } from "../../../src/language/conceptual/analyze";
import { parseConceptualSyntax } from "../../../src/language/conceptual/parser";

describe("Conceptual DSL", () => {
  it("constructs distinct semantic identities, descriptions, and directions", () => {
    const result = parseConceptual(`# comment
concept buyer "買い手" description "A \\"person\\""
concept order "Order"
relation places buyer -> order "places an order"
relation related buyer -- order "related to"
relation also_places buyer -> order "also places"
`);
    expect(result.diagnostics).toEqual([]);
    expect(result.ast?.declarations).toHaveLength(5);
    expect(result.model?.concepts[0]).toEqual({ id: "buyer", name: "買い手", description: 'A "person"' });
    expect(result.model?.relationships.map(({ direction }) => direction)).toEqual(["directed", "undirected", "directed"]);
    expect(result.model?.relationships[0].label).toBe("places an order");
  });

  it("reports duplicate IDs and unresolved endpoints with stable source locations", () => {
    const source = 'concept x "X"\nconcept x "Another X"\nrelation r x -> missing "looks up"\n';
    const first = parseConceptual(source).diagnostics;
    expect(first.map(({ code }) => code)).toContain("conceptual.duplicate-concept-id");
    expect(first.map(({ code }) => code)).toContain("conceptual.unknown-target");
    expect(first).toEqual(parseConceptual(source).diagnostics);
    expect(first.find(({ code }) => String(code) === "conceptual.unknown-target")?.range?.start.line).toBe(2);
  });

  it("parses syntax separately from semantics and retains declaration spans", () => {
    const parsed = parseConceptualSyntax('concept customer "Customer"\nrelation owns customer -> customer "owns"\n');
    expect(parsed.ast.declarations.map(({ kind }) => kind)).toEqual(["concept", "relation"]);
    expect(parsed.ast.declarations[1].range.start.line).toBe(1);
    expect(parsed).not.toHaveProperty("model");
  });
});
