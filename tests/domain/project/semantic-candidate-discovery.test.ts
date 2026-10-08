import { describe, expect, it } from "vitest";
import { discoverSemanticCandidates, normalizeName } from "../../../src/domain/project/semantic-candidate-discovery";
import type { ProjectIndex } from "../../../src/domain/project/project-index";
import type { EntityAnchor, IndexedEntity, SemanticBinding } from "../../../src/domain/workspace/semantic-binding";

const anchor = (representation: "conceptual" | "database", entityKind: EntityAnchor["entityKind"], value: string): EntityAnchor => ({
  version: 1, resourceId: `${representation}-resource`, representation, entityKind,
  identity: { kind: "local-id", value },
});
const entity = (name: string, a: EntityAnchor): IndexedEntity => ({ name, anchor: a });
const index = (entities: IndexedEntity[]): ProjectIndex => ({
  projectId: "project", resources: [], diagrams: [], eventFlows: [], documents: [], participants: [], usages: [], references: [], entities, diagnostics: [],
});
const concept = anchor("conceptual", "concept", "concept-id");
const table = anchor("database", "table", "table-id");

describe("discoverSemanticCandidates", () => {
  it("discovers exact normalized names without creating bindings and remains deterministic", () => {
    const input = index([entity("Invoice_Record", concept), entity("invoice record", table)]);
    const result = discoverSemanticCandidates(input, [], "v1");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ relation: "represents-in", left: concept, right: table, ranking: 1, ambiguity: { ambiguous: false } });
    expect(discoverSemanticCandidates(index([...input.entities!].reverse()), [], "v1")).toEqual(result);
    expect(normalizeName("  ＩＮＶＯＩＣＥ-record ")).toBe("invoice record");
  });

  it("excludes exact active bindings and incompatible or empty names", () => {
    const binding = { id: "b", projectId: "project", left: concept, right: table, relation: "represents-in", evidence: { version: 1, rationale: "evidence", items: [{ kind: "external", reference: "r", description: "d" }] }, revision: 1, status: "ACTIVE", provenance: { authorId: "u", createdAt: "now" } } satisfies SemanticBinding;
    expect(discoverSemanticCandidates(index([entity("A", concept), entity("A", table)]), [binding], "v1")).toEqual([]);
    expect(discoverSemanticCandidates(index([entity("", concept), entity("", table), entity("A", concept), entity("A", anchor("database", "index", "index"))]), [], "v1")).toEqual([]);
  });

  it("reports ambiguity and keeps identity independent of names and policy", () => {
    const initial = discoverSemanticCandidates(index([entity("Name", concept), entity("Name", table)]), [], "v1")[0];
    const renamed = discoverSemanticCandidates(index([entity("Other", concept), entity("Other", table)]), [], "v1")[0];
    const policy = discoverSemanticCandidates(index([entity("Name", concept), entity("Name", table)]), [], "v2")[0];
    expect(renamed.id).toBe(initial.id);
    expect(renamed.fingerprint).not.toBe(initial.fingerprint);
    expect(policy.id).toBe(initial.id);
    expect(policy.fingerprint).not.toBe(initial.fingerprint);
    const alternative = anchor("database", "table", "second");
    expect(discoverSemanticCandidates(index([entity("Name", concept), entity("Name", table), entity("Name", alternative)]), [], "v1")[0].ambiguity)
      .toEqual({ ambiguous: true, alternativeCount: 1 });
    expect(discoverSemanticCandidates(index([entity("Name", concept), entity("Name", anchor("database", "table", "other"))]), [], "v1")[0].id).not.toBe(initial.id);
  });
});
