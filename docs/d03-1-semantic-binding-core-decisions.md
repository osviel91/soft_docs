# D03.1 — Semantic Binding Core Decisions

**Status:** implementation contract
**Baseline:** `master` after D03.0 (`3ebe4fb`)
**Normative input:** [D03.0 cross-artifact semantic linking](d03-0-cross-artifact-semantic-linking.md)

## Decisions

### EntityAnchor serialization (version 1)

An anchor is a versioned, typed address, not an entity object:

```json
{
  "version": 1,
  "resourceId": "stable-resource-id",
  "representation": "conceptual",
  "entityKind": "concept",
  "identity": { "kind": "local-id", "value": "project" }
}
```

`resourceId` is the durable project resource identity, never its path. Representation and entity kind are closed, validated discriminators; local identity is an explicit tagged union. V1 admits only artifact-native entities with authored stable local IDs: Conceptual concepts and other semantically meaningful Conceptual entities, and Database tables, foreign keys, keys, and indexes. Database columns may use either `{kind:"local-id", value}` for an authored column ID or `{kind:"table-column-name", tableId, name}` for the exact-name fallback. The latter explicitly does not promise rename continuity. No Sequence, Event Flow, or Markdown source occurrence is bindable in V1. Existing SemanticMessageIdentity/messageRef stays independent.

Extractors remain in each artifact's parser/model analysis; no shared AST or generated identity is introduced. Resolution requires exact resource, representation, kind and tagged identity. Never repair an anchor by name.

### Relation registry

Registry entries have stable machine IDs; display text is not semantics. V1 registers only `represents-in` (directional): “the entity at the source endpoint is represented in the target endpoint.” Reversing endpoint order reverses the assertion. The entailment does not claim equivalence, implementation, completeness, exclusivity, cardinality, ownership, or runtime causality. This is intentionally narrower than “represents” and more informative than `related-to`; it is suitable for an explicit Conceptual-to-Database assertion without implying that a table fully implements a concept. Relation semantics come only from this registry.

### Evidence schema (version 1)

Evidence is a required, versioned list separate from human rationale:

```json
{
  "version": 1,
  "rationale": "The approved persistence mapping names this table.",
  "items": [{
    "kind": "internal",
    "resourceId": "stable-resource-id",
    "revision": 4,
    "entity": { "version": 1, "resourceId": "stable-resource-id", "representation": "database", "entityKind": "table", "identity": { "kind": "local-id", "value": "projects" } },
    "range": { "start": { "line": 12, "column": 1 }, "end": { "line": 12, "column": 20 } }
  }]
}
```

An internal item addresses a resource revision and may include an entity anchor and source range. An external item carries a stable reference/description rather than fabricated source coordinates. Rationale is concise human justification, not machine evidence. Ranges support navigation/provenance only and never identify a binding endpoint. Evidence edits are binding edits. At least one evidence item and non-empty rationale are required; matching names alone are never evidence.

### Persistence and governance

Do not place bindings in `project.json`: manifest reconciliation is resource/file-oriented, drops removed resource records, and manifest-wide edits would couple binding concurrency/history to unrelated identity metadata. Use a dedicated versioned local binding registry sidecar and a dedicated server registry/table. Both implement the same project/context-scoped repository contract with immutable revisions/history, optimistic concurrency, and active/retired state. Proposal snapshots explicitly select binding operations; promotion validates exact endpoints, evidence revisions/fingerprints, stale bases and permissions and applies resource and binding changes atomically. Historical bindings survive endpoint deletion/retirement; current resolution is derived and may be unresolved/unavailable. The ProjectIndex is a deterministic query projection, never authority.

This adds domain, application, persistence, and host integration at their existing seams; it does not change the semantics or schemas of ResourceRelationship, SemanticMessageIdentity, artifact grammars/models, or renderers. If an implementation step would require such a boundary change, stop rather than weaken this contract.

## D03.1B boundary

The current application read/query surface requires an owned active MY WORK context and returns SHARED overlaid by that context; one user's other MY WORK contexts remain inaccessible. No public/Share projection exposes SemanticBinding in D03.1A/B. Share filtering and evidence redaction remain D03.2 work; public project projections must not include these records until that authorization filtering is implemented.
