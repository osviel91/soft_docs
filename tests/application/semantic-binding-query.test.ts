import { describe, expect, it } from "vitest";
import { analyzeResource } from "../../src/domain/project/resource-analysis";
import { createProjectIndexer } from "../../src/domain/project/indexer";
import { getSemanticBindingsForEntity } from "../../src/application/semantic-binding-query";
import { validateSemanticBinding, type EntityAnchor, type SemanticBinding } from "../../src/domain/workspace/semantic-binding";

const conceptAnchor: EntityAnchor = { version: 1, resourceId: "domain", representation: "conceptual", entityKind: "concept", identity: { kind: "local-id", value: "project" } };
const tableAnchor: EntityAnchor = { version: 1, resourceId: "schema", representation: "database", entityKind: "table", identity: { kind: "local-id", value: "projects" } };
const binding: SemanticBinding = {
  id: "binding-1", projectId: "p", left: conceptAnchor, right: tableAnchor, relation: "represents-in",
  evidence: { version: 1, rationale: "The persistence mapping names this table.", items: [{ kind: "internal", resourceId: "schema", revision: 1, entity: tableAnchor }] },
  revision: 1, status: "ACTIVE", provenance: { authorId: "author", createdAt: "2026-01-01T00:00:00Z" },
};

describe("semantic binding entity anchors", () => {
  const index = () => {
    const concept = analyzeResource({ id: "domain", projectId: "p", path: "domain.concept", type: "conceptual", title: "Domain" }, 'concept project "Project"');
    const database = analyzeResource({ id: "schema", projectId: "p", path: "db.dbschema", type: "database", title: "Database" }, 'table projects - "Projects"');
    return createProjectIndexer().update("p", [
      { descriptor: concept.descriptor, content: 'concept project "Project"' },
      { descriptor: database.descriptor, content: 'table projects - "Projects"' },
    ], { format: "sequencediagrams-project", version: 1, resources: [] });
  };

  it("indexes stable Conceptual and Database identities and resolves the explicit binding", () => {
    const project = index();
    expect(getSemanticBindingsForEntity(conceptAnchor, [binding], project)).toMatchObject([{ resolution: { left: "resolved", right: "resolved" } }]);
  });

  it("keeps a stable ID resolved after display rename and resource path move", () => {
    const concept = analyzeResource({ id: "domain", projectId: "p", path: "renamed.concept", type: "conceptual", title: "Domain" }, 'concept project "Initiative"');
    const database = analyzeResource({ id: "schema", projectId: "p", path: "db.dbschema", type: "database", title: "Database" }, 'table projects - "Projects"');
    const project = createProjectIndexer().update("p", [{ descriptor: concept.descriptor, content: 'concept project "Initiative"' }, { descriptor: database.descriptor, content: 'table projects - "Projects"' }], { format: "sequencediagrams-project", version: 1, resources: [] });
    expect(getSemanticBindingsForEntity(conceptAnchor, [binding], project)[0].resolution.left).toBe("resolved");
  });

  it("reports deleted entities unresolved and does not infer from matching display names", () => {
    const database = analyzeResource({ id: "schema", projectId: "p", path: "db.dbschema", type: "database", title: "Database" }, 'table another - "Project"');
    const concept = analyzeResource({ id: "domain", projectId: "p", path: "domain.concept", type: "conceptual", title: "Domain" }, 'concept another "Project"');
    const project = createProjectIndexer().update("p", [{ descriptor: concept.descriptor, content: 'concept another "Project"' }, { descriptor: database.descriptor, content: 'table another - "Project"' }], { format: "sequencediagrams-project", version: 1, resources: [] });
    expect(getSemanticBindingsForEntity(conceptAnchor, [binding], project)[0].resolution).toEqual({ left: "unresolved", right: "unresolved" });
  });

  it("validates endpoint kind, local identity and evidence", () => {
    expect(() => validateSemanticBinding(binding)).not.toThrow();
    expect(() => validateSemanticBinding({ ...binding, left: { ...conceptAnchor, entityKind: "table" } as EntityAnchor })).toThrow();
    expect(() => validateSemanticBinding({ ...binding, left: { ...conceptAnchor, identity: { kind: "local-id", value: "" } } })).toThrow();
    expect(() => validateSemanticBinding({ ...binding, evidence: { version: 1, rationale: " ", items: [] } })).toThrow();
  });

  it("keeps column fallback identity explicitly tied to exact table id and name", () => {
    const analysis = analyzeResource({ id: "schema", projectId: "p", path: "db.dbschema", type: "database", title: "Database" }, 'table projects - "Projects"\ncolumn projects - "legacy_name" {text} nullable');
    expect(analysis.entities.find((entry) => entry.name === "legacy_name")?.anchor.identity).toEqual({ kind: "table-column-name", tableId: "projects", name: "legacy_name" });
  });

  it("reconstructs the entity index deterministically", () => {
    expect(JSON.stringify(index())).toBe(JSON.stringify(index()));
  });
});
