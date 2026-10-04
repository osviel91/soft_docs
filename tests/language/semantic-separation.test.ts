import { describe, expect, it } from "vitest";
import { analyzeResource } from "../../src/domain/project/resource-analysis";
import { parseConceptual } from "../../src/language/conceptual/analyze";
import { parseDatabase } from "../../src/language/database/analyze";

describe("Conceptual and Database semantic separation", () => {
  it("keeps authored names and labels local identities with no visual or causal projection", () => {
    const source = 'concept account "Account"\nconcept user "Account"\nrelation owns account -> user "owns"\nrelation owned_by user -> account "owns"\n';
    const first = parseConceptual(source), second = parseConceptual(source);
    expect(first.ast).not.toHaveProperty("participants");
    expect(first.ast).not.toHaveProperty("events");
    expect(Object.keys(first.model ?? {})).not.toEqual(expect.arrayContaining(["x", "y", "width", "height", "layout"]));
    expect(first.model?.concepts.map(({ id }) => id)).toEqual(["account", "user"]);
    expect(first.model?.concepts[0].name).toBe(first.model?.concepts[1].name);
    expect(first.model?.relationships.map(({ id, label }) => [id, label])).toEqual([["owns", "owns"], ["owned_by", "owns"]]);
    expect(first.model).toEqual(second.model);
    const analysis = analyzeResource({ id: "concept-a", projectId: "p", path: "a.concept", type: "conceptual", title: "A" }, source);
    expect(analysis.semanticOccurrences).toEqual([]);
    expect(analysis.eventFlowMessages).toEqual([]);
  });

  it("keeps foreign keys as database facts, not service dependency evidence", () => {
    const source = 'table account - "Account"\ncolumn account id "id" {uuid} not-null\nprimary-key account_pk account (id)\ntable invoice - "Invoice"\ncolumn invoice id "id" {uuid} not-null\nprimary-key invoice_pk invoice (id)\nforeign-key invoice_account invoice (id) -> account (id)\n';
    const first = parseDatabase(source), second = parseDatabase(source);
    expect(first.ast).not.toHaveProperty("concepts");
    expect(first.model?.foreignKeys).toHaveLength(1);
    expect(Object.keys(first.model ?? {})).not.toEqual(expect.arrayContaining(["x", "y", "width", "height", "layout"]));
    expect(first.model).toEqual(second.model);
    const analysis = analyzeResource({ id: "database-a", projectId: "p", path: "a.dbschema", type: "database", title: "A" }, source);
    expect(analysis.semanticOccurrences).toEqual([]);
    expect(analysis.eventFlowMessages).toEqual([]);
  });
});
