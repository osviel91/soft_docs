# D02 — Conceptual and Database Artifact Architecture

**Status:** architecture approved by D02; semantic/source decisions resolved in [D02.1](d02-1-semantic-contract.md); no artifact support implemented
**Scope:** semantic models, extension boundaries, graphical infrastructure, and lifecycle integration for future Conceptual and Database resources.

This document is based on the repository at `1f879c050c50da1b0fee34dcc7a17fb2089381b3` (`origin/master` matched); the starting worktree was clean. No production artifact support is introduced here. The normative representation and evidence rules remain in [`documentation-model.md`](documentation-model.md); this document narrows the architecture needed to implement its future Conceptual and Database contracts.

## 1. Executive recommendation

Introduce two independently modeled resource representations. Conceptual is a graph-native model of named architectural/domain concepts and explicit structural relationships. Database is a schema-native model of schemas, tables, columns, keys, and constraints. Each has its own source parser, validation, analysis contribution, projection, rendering, and semantic diff. Both may eventually target a small geometry-only graph-layout contract, but neither semantic model is that graph contract.

Keep the existing `Resource` lifecycle, context separation, immutable proposal snapshots, review/promotion governance, ShareGrant authority, and Presentation authority. Extend finite representation registries and explicitly handle artifact-specific review/render behavior. Do not infer identity or cross-artifact relations from matching names, and do not turn ordinary Conceptual or Database relationships into Event Flow topology or Causal evidence.

## 2. Existing architecture audit

### 2.1 Actual end-to-end path

```text
Resource type / path
  -> local diagram-or-note storage, or server Resource record/content/revision
  -> ResourceRepresentation classification
  -> language-specific parser/analyzer
  -> artifact AST / semantic model
  -> per-resource ResourceAnalysis
  -> project-wide ProjectIndex + metadata identity/relationship resolution
  -> artifact-specific projection (where applicable)
  -> artifact-specific layout -> deterministic SVG renderer
  -> ResourceDiff / proposal diff and review decorations
  -> LOCAL / SHARED / MY WORK / immutable PROPOSAL lifecycle
  -> public SHARED projection under ShareGrant
  -> Presentation over the authorized projection
  -> stdio/remote MCP through workspace/application services
```

The resource storage and lifecycle envelope is broad enough to transport source, type, revision, metadata, and identity. Interpretation is not broad: `resource-id.ts`, metadata validation, `resource-analysis.ts`, `ProjectIndex`, `resource-diff.ts`, editor/preview paths, public projection, presentation, and MCP contain explicit current-representation handling. Persisting a file is therefore not equivalent to integrating a representation.

### 2.2 Current artifact matrix

| Concern | Sequence (`.seq`) | Event Flow (`.eventseq`) | Markdown (`.md`) |
|---|---|---|---|
| Source syntax | Line-oriented sequence DSL with participants, messages, fragments, notes and semantic message occurrence metadata | Event Flow DSL; declaration/topology facts plus explicit causal declarations, failures/retries and metadata | Markdown plus recognized resource links/embeds |
| Parser / validation | `src/language/parser`, `analyze`, `validator`; syntax and sequence rules | `src/language/eventflow/parser` / lexer; parser diagnostics and Event Flow semantic validation | `src/language/markdown/markdown`; link extraction; heading/title helpers |
| AST / model | `src/domain/diagram/ast.ts`, temporal statements and source ranges | `src/domain/eventflow/ast.ts`; intentionally separate semantic model | Text, extracted headings/references; no document-wide semantic AST |
| Analyzer | Sequence analysis in `domain/project/resource-analysis.ts` | Event Flow analysis and causal-view projection in the same per-resource analysis | Heading, word-count and reference analysis |
| Semantic identities | Participant ids local to source; optional occurrence binding to manifest-backed semantic message identity | Event and handler/effect local IDs/names; optional event binding to same manifest-backed message identity | Resource identity, not extracted domain identities |
| Relationships | Ordered message endpoints; identity binding is not a resource relationship | Publication/subscription topology and separate authored causal relationships; message binding remains separate | Resolved resource references; typed resource relationships are separate metadata |
| Index contribution | participant symbols/usages, message occurrences, diagnostics and metrics | event/service/channel/broker symbols, event occurrences, causal index, diagnostics/metrics | headings, resource references, diagnostics and word metrics |
| Renderer / projections | AST → sequence layout → SVG | EventFlow AST → Flow projection/layout/SVG; separate Catalog, Topology and Causal projections/renderers | Markdown UI renderer; not SVG diagram pipeline |
| Diff | Positional message alignment; participant identity; source hunks; invalid source disables semantic diff | Event Flow semantic diff using event-oriented matching; source hunks retained | deterministic line/block source diff |
| Review | Proposal Decision Workspace's before/after/compare; sequence-specific change targets and SVG decorations | Before/after/compare; typed Event Flow entity targets and SVG decorations | textual/Markdown review; no semantic graph decoration |
| Explorer / MY WORK | Shared Resource descriptors and same content in private context; type-specific labels/icons may be selected by consumers | Same lifecycle, distinct representation display and Event Flow views | Same lifecycle; document-specific title/outline behavior |
| Proposal | Resource snapshot and CREATE/UPDATE/RETIRE intent; shared immutable base and submitted content | Same governance envelope; analysis/review must recognize type | Same governance envelope; text-oriented comparison |
| Sharing / public reader | `buildPublicProjectProjection` analyzes supplied active SHARED source and emits resource/index facts; public reader renders supported representation | Same source authority and index; view selector preserves Event Flow view | Same projection authority; Markdown UI |
| Presentation | Current Stage falls back to `Preview` for non-Markdown/non-Event-Flow; thus Sequence | Stage selects Event Flow preview and Event Flow view | Stage selects Markdown renderer |
| MCP | Existing generic resource tools plus Sequence-specific semantic/render tools | Generic resource tools plus Event Flow-specific discovery/validation/render/view tools | Generic resource operations and documentation tools |
| Contextual guidance | `DIAGRAM_GUIDES.sequence` | Event Flow, Topology, Catalog and Causal entries | No diagram notation guide |

This matrix describes differing paths, not a requirement that every representation share every capability. Event Flow is particularly instructive: one authored semantic model feeds different projections; Causal is not a generic graph AST and does not consume Sequence semantics.

### 2.3 Lifecycle and authority findings

- `Resource` and server resource records carry stable resource identity, path, type/representation, content and revision. Local stable IDs survive ordinary rename; server resources use project-scoped records and optimistic revisions. Existing stored diagram/note collections and API type unions are finite.
- Indexing is shared through `ProjectIndexer` and `analyzeResource`; the latter branches by representation. The index is rebuilt from source plus project metadata and is reused by UI/MCP rather than re-parsing independently.
- SHARED/MY WORK context resolution and server authorization live at the application/server boundary. MY WORK can read SHARED; SHARED cannot read MY WORK. Proposal snapshots are selected from MY WORK, immutable, and non-authoritative. Review records evidence; only explicit independent promotion mutates SHARED. New content types need not create a new authority or auth model.
- Public ShareGrant projection is a bounded SHARED-only source projection. `buildPublicProjectProjection` calls the shared analyzer and builder; new types will appear only after those switches/types and public reader capability handling are extended. It must not add MY WORK/proposal visibility.
- Presentation is already authority-agnostic over an authorized resource list, but `PresentationMode` branches Markdown/Event Flow/Sequence explicitly. It is not a new authority, and should dispatch to a supported representation renderer.

## 3. Coupling hotspots

| Evidence in current code | Class | D02 finding |
|---|---|---|
| `ResourceRepresentation`, `ResourceType`, conversions and suffix detection in `domain/workspace/resource-id.ts`; type parsing in `metadata.ts`; API/client type unions | C — acceptable finite registry, currently duplicated across boundaries | Add explicit representations without fallback-to-Sequence behavior; audit persisted/API compatibility and file detection together. A small central descriptor/registry may be justified only if it removes real divergent switches. |
| `analyzeResource` representation branches; representation-specific descriptor/symbol unions in `project-index.ts`; metrics and validation aggregation | C/B — established analysis seam, no full registry | Keep per-artifact analyzers independent. Add explicit analysis output contracts and typed symbols; do not make parser ASTs polymorphic. |
| `resource-diff.ts` `Record<ResourceRepresentation, Strategy>` | C — good finite registry | Add dedicated semantic diff strategy per new artifact; unavailable semantics on parser errors, retain source hunks. |
| `merge-analysis.ts`, `review-targets.ts`, `review-decorations.ts`, proposal review preview branching | B — missing semantic-diff/review extension point | Existing resource lifecycle accepts types, but proposals do not automatically obtain graph-level meaning. Add artifact-specific diff target mapping and renderer decoration adapters. |
| `ResourceRelationshipKind = "complementary-view"` and validator hard-coded Sequence/Event Flow pair | A — legitimate semantic constraint | This relation means substantially the same execution behavior shown as Sequence and causal Event Flow. Do not generalize it to Conceptual/Database; future relation kinds need their own evidence/validation semantics. |
| `project-index.ts` `SymbolKind`, descriptor unions, `resourceSummaries`/resource kind branches | C/B — finite index taxonomy with explicit artifact outputs | Extend typed categories (`concept`, `database-table` as warranted); do not flatten them into participant/event. Keep internal columns/relationships out of global symbol index unless querying/reference use cases justify them. |
| Sequence and Event Flow render pipelines, each joining parse/projection/layout/render; Causal ELK adapter/worker | A — legitimate domain-specific pipelines; possible geometry seam | Do not borrow a complete pipeline. Investigate layout-only interface from distinct projections. ELK worker is browser module and its graph adapter is Causal-specific. |
| `DiagramViewport` accepts finished SVG + dimensions, selection/review callbacks; shared by Sequence/Event Flow previews | C — useful UI infrastructure | Reuse viewport and camera where interaction semantics fit. Add node/edge selection callbacks only when stable renderer IDs and source mapping exist; keep viewport semantic-free. |
| `PresentationMode` type/path checks and reader/render selection | B — missing renderer capability dispatch | Extend to supported renderers while using same authorized resource list and Stage; no new Presentation model. |
| Guidance `DIAGRAM_GUIDES` closed `GuidanceView` record | C — finite presentation registry | Add separate Conceptual/Database guidance entries and their actual active views. Not a semantic or parser extension point. |
| public projection's message-reference pruning and returned Event Flow fields | D — current-artifact assumptions | Keep generic source filtering; extract only representation-specific projection output. New categories must be returned without granting new authority and without message-specific sanitization being applied incorrectly. |
| MCP generic resource operations plus representation-specific tool set | C/B — generic governance path, semantic tools intentionally specialized | Extend capabilities/schema/read/validate/render semantically. Prefer generic resource mutation path where valid, and do not bypass existing service authorization/revision checks. |

No switch alone proves that polymorphism is needed. A finite registry is suitable for known representations; a geometry boundary is suitable for shared layout; domain behavior stays specialized.

## 4. Semantic separation and concepts

```text
Resource (identity, type, source, revision, context)
   ├── Sequence semantic model       (ordered collaboration / time)
   ├── Event Flow semantic model     (message, handler, effects / causal facts)
   ├── Conceptual semantic model     (domain and architecture structure)
   └── Database semantic model       (persisted schema and constraints)
```

Every implementation should retain five distinct layers:

```text
SOURCE MODEL -> SEMANTIC MODEL -> ANALYSIS / INDEX MODEL
                         \                 /
                          -> VISUAL PROJECTION -> layout -> RENDER MODEL
```

Source ranges and stable local IDs connect these layers. The visual projection may omit semantic details or group them, but cannot create facts. Layout consumes geometry and routing constraints, not domain vocabulary.

### 4.1 Conceptual product meaning

Conceptual describes a coherent structural/domain question: concepts, responsibilities, entities, business ideas and their meaningful relationships. `Customer --places--> Order` describes a structural/domain assertion, not a runtime call, Event Flow edge, causal proof, schema FK, or implementation dependency. Use Sequence for time-ordered execution, Event Flow for asynchronous reactions and authored causal facts, Conceptual for structural meaning, and Database for persisted structure.

“Order depends on Customer” is Conceptual only if it is an explicitly authored structural claim. It does not imply that Customer executes before Order or emits an event. “OrderService publishes OrderCreated” is Event Flow/topology or message evidence. “HandlePayment causes PaymentCaptured” is explicit Event Flow causality. A Conceptual edge never supplies that evidence.

### 4.2 Conceptual alternatives

| Alternative | Benefits | Costs / decision |
|---|---|---|
| A. Dedicated graph-native `ConceptualModel` (`Concept[]`, `ConceptualRelationship[]`) | Matches structural domain semantics; explicit endpoint, identity and relationship fields; straightforward graph projection and semantic diff | **Recommend.** Graph-native is a good semantic model for this artifact, not a universal platform AST. |
| B. UML-like association/aggregation/composition/generalization/realization/dependency | Recognizable standardized notation; some type/ownership constraints | Brings UML ontology and implied semantics not required by product; excludes or awkwardly maps domain verbs such as `places`, `owns`, `grants`. Do not make it V1-complete. A future UML import/export profile can map into richer explicit semantics if needed. |
| C. Generic `Graph<Node,Edge>` with arbitrary `type/data` | Reuses graph algorithms and storage/render code | Semantic dilution, weak validation, opaque MCP schemas, and loss of domain-specific diff/index constraints. Reject as domain model; use geometry graph only after projection. |
| D. Typed concept with labeled relation and structural flags | Keeps author vocabulary while giving platform limited canonical properties | Best form within A: identity-bearing concepts and directed/bidirectional structural relation with authored label; optional explicit structural classification only where a concrete validation/query/render use exists. |

### 4.3 Concept relationship vocabulary

Recommend **D: structurally typed, semantically labeled**. Canonical fields initially answer only graph-structure questions (endpoints and direction); a required authored label such as `places` communicates domain meaning. Do not require a closed relationship enum or make every verb platform-level. Optional relation classes such as association/composition should be deferred until users and analyses need their specific constraints. Preserve exact label for diff and search; do not equate different labels by synonym matching.

This balances extensibility and useful future querying. Platform queries can reliably ask about endpoint/direction and explicitly declared optional category, while free labels remain visible, diffable and MCP-authorable without an ontology explosion. Renderers can render arrow direction and label consistently. A self-relation or duplicate relation is not inherently invalid; validation should flag only ambiguous duplicate identity or impossible endpoint structure, not reject domain meaning by taste.

### 4.4 Concept kinds and identity

V1 recommendation: **no required concept kind**. A `kind` would initially risk acting only as a visual styling enum while inviting an unstable ontology. If classification later supports real search/validation, introduce an optional open-vocabulary classification distinct from identity and appearance; retain unknown values. Do not start with a closed `actor|domain|capability|entity|process|external-system` enum.

Concept identity is stable and authored **within the resource by default**. Use a required local key distinct from display label; rename label without changing identity. For cross-resource intentional sameness, add an explicit reference to a project-scoped authoritative identity or an explicit evidence-backed binding mechanism, not an implicit global identity. Two `Customer` labels are candidates, not proof. A Concept may later explicitly correspond to Service/Event identities, but it remains a distinct typed identity and the relation records evidence; it is not identity-equality by name. No aliases or automatic rename matching in V1. Semantic diff pairs by stable local identity; absent a stable ID, conservatively report add/remove and optional non-authoritative candidate suggestions.

## 5. Database semantics

### 5.1 Product boundary and alternatives

Database Diagrams model persistence structure, not business-domain meaning and not a generic graph. A `Customer` concept and a `customers` table may correspond only through an explicit future mapping. A service-to-table use (“Billing Service uses invoices table”) is not a foreign key and must not be inferred from a table/service name. It is a future cross-artifact architectural relationship backed by source evidence or remains unknown.

| Alternative | Benefits | Costs / decision |
|---|---|---|
| A. Dedicated schema model: database/schema/table/column/key/constraint/FK | Models column attributes and constraint facts directly; supports schema validation, import and semantic diff | **Recommend.** This is the product meaning of Database Diagram. It need not model vendor-specific SQL exhaustively. |
| B. ER entities/attributes/relationships/cardinality | Familiar conceptual data modeling | Can describe logical data independent of persisted physical schema; may omit type/default/nullability/constraint truth expected by “Database Diagram”. Use only for a future logical ER representation/profile if product need is established. |
| C. Generic graph (`Table=Node`, `FK=Edge`) | Simple layout and traversal | Cannot preserve columns, composite keys, uniqueness, optionality or constraint ownership without hidden payload semantics. Use only as projection. |
| D. DDL-derived model | Source-derived accuracy; potential PostgreSQL/MySQL/etc. import | DDL dialects and migration histories vary. Keep semantic model source-neutral enough for future DDL/import/introspection, but do not build importer or make SQL the source syntax now. |

### 5.2 Database V1 scope

“MUST” describes semantic V1 support, not a demand to implement every validation rule at once. Incomplete scope must be represented honestly; omissions do not assert absence.

| Element | Scope | Rationale |
|---|---|---|
| Database identity/container | SHOULD | Useful when one resource contains more than one database; allow omission for a single implicit database. |
| Schema/namespace | SHOULD | Support explicit schemas; permit one implicit/default schema without asserting it is the only deployed schema. |
| Table | MUST | Primary persisted relation and useful indexable unit. |
| Column | MUST | Include stable local identity, display/name, declared type text, nullability (`true/false/unknown`), optional default expression text. |
| Primary key | MUST | Single/composite columns with named or anonymous constraint identity. |
| Foreign key | MUST | Explicit source table/columns and target table/columns; composite mappings supported. |
| Unique constraint | SHOULD | Common integrity and cardinality evidence; distinct from index. |
| Index | SHOULD in V1 (resolved by D02.1) | Model as a typed schema fact distinct from unique constraints; defer vendor-specific method/include/partial options. Omission is not absence. |
| Check constraint | LATER | Expression semantics and dialect differences; preserve unknown expression only when explicitly represented later. |
| Generated column | LATER | Vendor and expression semantics; do not conflate with default. |
| View | LATER | Useful but requires query/source dependencies and distinct update semantics. |
| Materialized view | LATER | Refresh semantics make it more than a table-shaped box. |
| Stored procedure | OUT OF SCOPE | Moves toward SQL IDE/routine documentation. |
| Trigger | OUT OF SCOPE | Runtime execution/cascade semantics deserve a separate deliberate model; not a plain schema edge. |

Types are authored strings in V1 (e.g. `uuid`, `varchar(100)`), not a platform SQL type algebra. Diff treats changed spelling as type modification unless a later dialect-aware normalization is evidence-backed. Defaults are source text and do not imply generated behavior.

### 5.3 FK fact, visual relation and cardinality

The FK is the source-of-truth constraint: ordered source/target column lists, optional stable identity/name, and its source range. A renderer projects it as a line and can choose routing/crow's-foot marks based on justified facts. Deleting a visual line must never delete or redefine a foreign key.

FK target uniqueness gives a safe **maximum** cardinality at the referenced side; nullability and constraint semantics can inform optional participation only when fully known. In practice, derive a simple `many-to-one` / `one-to-one` display only if target columns are a declared PK/unique key and source FK columns are unique for one-to-one. `1:N` is the inverse presentation of a many-to-one FK. `N:M` is not inferred from a pair of tables; it is represented by an explicit junction table and its two FKs, or by an explicitly authored logical relation in a future logical model. Missing uniqueness, nullable/partial scope, unknown constraint state, or incomplete artifact means cardinality is unknown, not guessed. Do not render unsupported crow's-foot certainty.

### 5.4 Database identity

Use stable authored local IDs for table and foreign key, independent of display names. Table key remains stable across rename and schema movement; FK identity persists while its source/target mapping is edited. Column ID is optional: use it to retain continuity across a column rename; absent one, `(tableId, exact column name)` is identity and rename is conservatively remove/add. Database and explicitly declared schema similarly use stable local IDs. Name/path composite is a display/lookup key, not cross-resource semantic identity. Future importers report uncertain matches rather than claiming continuity without identity evidence.

## 6. Analysis, index and cross-artifact relations

### 6.1 Index contribution

Extend ProjectIndex with discriminated categories. Concept definitions and explicit relation facts may be indexed as `concept` and `conceptual-relationship`; Database tables may be `database-table`, with constraints/FKs represented as typed database facts. Columns should initially remain addressable inside their resource analysis and source navigation; promote to global symbols only if completion/references/search/MCP use cases establish value. Never encode Concept and Table as generic `node`, or Event as interchangeable with either.

The index should preserve resource ID, typed identity, local ID, source range, provenance/context, and explicit relationship kind. Cross-resource resolution should require typed IDs and explicit binding evidence. Equal names can be surfaced as candidates only, with provenance and no authoritative edges. A FK is internal to the database model; it does not create a service dependency. A Conceptual relation does not create Event Flow publication/consumption, handler causality, or complementary-view relationship.

Current semantic-message identity is a typed, project-manifest-backed identity, not a universal symbol registry. Do not overload `messageRef`; a future namespace/category extension should be explicit, e.g. distinct typed identity category for concept/table if shared identity is proven useful. Check collision/isolation rules in the manifest API before choosing serialized syntax. Keep local object IDs namespaced by resource to prevent accidental collision.

### 6.2 Cross-artifact relationship policy

Cross-artifact links (Concept implemented by Service, Capability realized by Service, Concept emits Event, Service uses Table) require an explicit typed relationship with evidence/provenance. They may live in a future project-level typed relationship registry if they cross resource boundaries, analogous to—but semantically distinct from—current resource relationships and semantic-message identity bindings. Do not place them into Conceptual edges or Database FKs as an escape hatch. Do not infer from matching labels. Evidence absence remains unknown.

## 7. Validation and incomplete evidence

Reuse the existing structured diagnostic envelope (`error|warning|info`, code, resource ID, source range), while keeping validators artifact-specific.

| Diagnostic class | Conceptual examples | Database examples |
|---|---|---|
| Structural error | Duplicate local identity; malformed endpoint reference; invalid source shape | Duplicate table/column identity; FK missing table/column; PK/FK references missing column; incompatible source/target tuple lengths |
| Semantic error | Relationship endpoint does not resolve; duplicate stable relation identity | Duplicate constraint identity; duplicate column in key; structurally invalid key definition |
| Warning | Unused concept; suspicious duplicate relationship; unsupported optional classification | Unknown/unparsed type syntax; a declared FK target not known in this bounded artifact; incomplete key declaration |
| Informational | Explicitly partial scope; unbound cross-resource identity candidate | Declared scope/source completeness; omitted constraint categories unknown |

Do not reject cycles, self-relations, many-to-many conceptual relations, or open labels absent a concrete semantic invariant. Database artifact scope/completeness should eventually state what it covers (e.g. selected schemas, architectural tables, full snapshot, generated from migration revision). Without an explicit completeness claim, omitted tables/indexes/constraints mean “not documented here,” not “does not exist.” Machine-derived data may indicate source and extraction boundary; manual artifacts stay valid when partial.

## 8. Visual projection, layout and graphical infrastructure

### 8.1 Separate pipelines

```text
Conceptual source -> parser -> ConceptualModel -> analysis/index
                                           -> ConceptualGraphProjection
                                           -> graph layout -> renderer -> SVG

Database source -> parser -> DatabaseModel -> analysis/index
                                        -> DatabaseGraphProjection
                                        -> graph layout -> renderer -> SVG

ConceptualGraphProjection ─┐
                           ├─> geometry-only graph layout -> positions/routes
DatabaseGraphProjection ───┘                              -> artifact renderer
```

The projection owns visual choices such as grouping, edge aggregation, ports and layout preferences; the semantic model does not need to be graph-simple to produce a graph projection. Render model owns renderer-specific primitives and source-addressable IDs.

### 8.2 What can be shared

`DiagramViewport` already handles finished SVG size, zoom/pan/fit/minimap and comparison transforms without knowing semantics; reuse where practical. Existing SVG utilities/primitives may be reused selectively after auditing their styling/interaction contracts. `geometry.ts` is sequence-oriented and not a graph node/edge model. EventFlow Flow/Topology layouts and Causal layout are domain-specific projections/layouts. Causal uses ELK via `elkjs`, an adapter and a browser worker; this is not a headless reusable graph service today.

Smallest useful candidate boundary (not a committed API): projections provide stable node IDs, preferred box sizes, optional ports/parent grouping and typed route-independent edges; layout returns positioned boxes, routes, bounds and warnings. It contains no Concept, Table, FK or Event Flow types. Extract only after a second real graph projection demonstrates common behavior; otherwise implement minimal per-artifact layouts and avoid speculative infrastructure. Source ranges/selection IDs remain outside or carried as opaque IDs, not interpreted by layout.

### 8.3 Layout recommendation

Start with deterministic layered/hierarchical layout for directed relationships and explicit stable ordering; support cycles by SCC/component handling or bounded rank assignment, not by pretending a DAG. Consider orthogonal routes for Database FKs and labeled relations, with edge labels and bidirectional edge styling. Permit clusters/group boxes in the projection/layout contract if needed, but avoid arbitrary canvas coordinates. Force-directed layouts are not recommended initially: they can shift unchanged nodes after small edits, are harder to test/review, and need stabilization/manual pins. ELK is the strongest existing candidate for layered routing/ports/clusters, but current worker wrapper is browser-specific; evaluate its server/headless module and determinism before extraction. Dagre is a simpler directed-layered alternative but has less routing/cluster sophistication. Do not add a dependency in discovery.

Conceptual initial assumptions: approximately 10 nodes typical, 50 comfortable target, 200 a stress case requiring grouping/filtering. Database: 10 tables typical, 100 supported target, 500 stress case likely requiring schema selection/collapse. These are planning targets, not current limits. Parsing/projection should be O(source size + declarations/relations); layered layout is typically near O((V+E) log V) depending on engine, while worker/client responsibility and caches must be measured. Parse/analyze stays framework-free and reusable by browser, tests, MCP, public reader and export.

### 8.4 Headless rendering and determinism

Existing Sequence/Event Flow SVG renderers are pure TypeScript and deterministic; MCP and tests can use the shared render pipeline without a DOM. Causal ELK currently runs through a browser Web Worker and so cannot be assumed available to headless MCP or server rendering. A graph engine must be callable without DOM/canvas text measurement, have deterministic/stable tie-breaking, expose route geometry, and be testable in Node. Browser workers may improve UI responsiveness but must be adapters around equivalent pure/headless layout input/output, not a required environment. Font measurement should use fixed/estimated metrics or explicit preferred sizes; renderer text must not determine non-repeatable layout.

Use stable source order/identity as tie-breakers. Layout should minimize churn under local edits where possible, but coordinates are output, not semantic diff. A graph diff compares model entities; review decorations overlay added/removed/modified IDs without comparing pixels. Accessibility requires semantic labels/descriptions in models, stable focusable rendered IDs, keyboard navigation, relationship text, and an equivalent textual node/edge catalog or schema/table/column outline. SVG alone is insufficient.

## 9. Source authoring and manual layout

The D02.1 spike recommends a dedicated declarative line/block DSL with explicit stable IDs, simple references, source ranges, actionable diagnostics, and local edits. Structured YAML was evaluated with equivalent realistic fixtures; its generic parse/stringify path risks comments/order round-trip and adds structural noise. See [the D02.1 decision and comparison](d02-1-semantic-contract.md). Mermaid-like syntax remains unsuitable as canonical source because it couples visual notation to semantics and offers weak identity/validation. Conceptual free labels and Database typed fields remain explicit. Database is not SQL-only; future DDL ingestion maps to the same semantic model with source provenance and unknown boundaries.

AI/MCP authoring is a first-class criterion: schemas and capability metadata should explain required declarations, identity, allowed structures, validation and supported renderer. An agent should be able to update one entity without rewriting the whole resource and should receive line/column-specific diagnostics. Keep MCP and human authoring on one canonical syntax/model.

Default: semantic source contains no coordinates. V1 uses deterministic automatic layout. If manual positioning becomes a validated need, prefer separate optional presentation/layout metadata associated with the resource, not semantic statements; first decide whether it is resource-revisioned and whether proposals compare it. Do not persist Presentation decks as a side effect of diagram support.

## 10. Diff and Proposal Decision Workspace

Reuse `ResourceDiff`'s common envelope: metadata changes, representation-specific semantic content diff, bounded source hunks, diagnostics, stable summaries. The existing strategy registry is the correct dispatch seam. Semantic identity is essential to classify renames/modifications rather than delete/add.

- Conceptual semantic diff: concept add/remove/modify (label, description, optional classification), relationship add/remove/modify (endpoints, authored label, direction, optional structural category). Match by stable local ID.
- Database semantic diff: schema/table/column/key/constraint add/remove/modify; type, nullable/default, PK, uniqueness and FK mapping changes are explicit. A future `varchar(100) -> varchar(255)` reports column type modified if the column identity is stable.
- Invalid DSL means semantic content diff unavailable, while diagnostics and source hunks remain, following current behavior.
- Proposal Decision Workspace continues comparing immutable SHARED base to immutable submitted snapshot. It consumes representation-specific `SemanticChange` targets; current SHARED remains staleness/readiness context. Before/After/Compare uses each artifact renderer. Decorations attach only to addressable semantic IDs; no SVG pixel diff and no layout-derived change claims.
- Keep technical source diff available as secondary evidence. Do not treat source reorder/layout output as architectural change.

## 11. Platform extension-point matrix

“Generic change?” identifies the kind of integration, not a mandate to generalize all code.

| Area | Conceptual | Database | Generic change? |
|---|---|---|---|
| Resource type / representation | New representation/type | New representation/type | REGISTRY |
| Parser | Dedicated grammar/parser | Dedicated grammar/parser | DOMAIN-SPECIFIC |
| Semantic model | Concept/relationship model | Database/schema/table/column/constraint model | DOMAIN-SPECIFIC |
| Validation | Endpoint/identity/scope rules | Key/FK/type/scope rules | DOMAIN-SPECIFIC |
| Analysis | Typed concept/relation facts | Typed table/constraint facts | EXTENSION POINT (shared `ResourceAnalysis` seam) |
| Identity | Local concept/relation IDs; optional later binding | Local DB/schema/table/column/FK IDs | DOMAIN-SPECIFIC |
| Project index | Typed concept/relation categories | Typed table and selected constraint categories | EXTENSION POINT (typed index, no flattening) |
| Relationships | Internal relation facts; explicit future cross-resource link | FK facts internal; cross-resource use link later | DOMAIN-SPECIFIC |
| Diff | Concept/relation diff | Schema semantic diff | EXTENSION POINT (strategy registry + typed change targets) |
| Renderer | Conceptual-specific renderer | Database-specific renderer | DOMAIN-SPECIFIC |
| Layout | Graph projection layout | Schema graph projection layout | INFRASTRUCTURE (only geometry seam after evidence) |
| Explorer | type/icon/title/filter | type/icon/title/filter | REGISTRY |
| MY WORK | existing private context | existing private context | NONE for authority; type support required at parsing/index |
| Proposal | immutable source snapshot + semantic diff | same | EXTENSION POINT (existing lifecycle; artifact review adapter) |
| Review | graph entity decorations | table/column/constraint decorations | INFRASTRUCTURE + DOMAIN-SPECIFIC targets |
| Sharing | current SHARED public projection only | same | EXTENSION POINT (projection outputs) |
| Presentation | existing Stage renderer dispatch | same | EXTENSION POINT (capability dispatch) |
| MCP | schema/read/validate/render capabilities | same | EXTENSION POINT (generic governance, domain tools as useful) |
| Guidance | Conceptual notation and boundary guide | Database notation and unknown-scope guide | REGISTRY |

## 12. Reuse matrix

| Existing component | Classification | Reason |
|---|---|---|
| Resource identity, revisions, SHARED/MY WORK context lifecycle | REUSE AS-IS | Resource envelope and authority do not depend on diagram semantics; add representation support, not authority. |
| Proposal snapshots, review evidence, promotion | REUSE AS-IS | Source snapshots and revision governance are generic; semantic review payload is extensible. |
| Sequence AST/parser/layout | DO NOT REUSE | Ordered execution semantics and lifelines are not structural graph semantics. |
| Event Flow AST and causal projection | DO NOT REUSE | Message topology and authored causality have independent evidence rules. |
| Markdown renderer | DO NOT REUSE | Text/document semantics differ. It may remain a separate Stage capability. |
| `ResourceAnalysis` / `ProjectIndexer` / `ProjectIndex` | ADAPT/EXTRACT | Existing common seam; add typed outputs and explicit artifact analyzers without a universal AST. |
| `ResourceDiff` envelope/strategy registry | ADAPT/EXTRACT | Reuse generic metadata/source diff and add per-model semantic diff. |
| Causal ELK graph adapter/worker | INVESTIGATE FURTHER | Graph layout evidence but Causal-specific conversion and browser Worker; prove headless use and determinism before extraction. |
| Existing Flow/Topology layout | DO NOT REUSE | Derived event-flow semantics and layout assumptions. |
| `DiagramViewport` and camera geometry | REUSE AS-IS | Finished SVG + size boundary is semantic-free and already shared. Add interaction hooks carefully. |
| SVG primitives/utilities | INVESTIGATE FURTHER | Selectively reusable after checking stable IDs, accessible labels and style coupling. |
| Proposal review decorations / targets | ADAPT/EXTRACT | Reuse concept of addressable decoration, add artifact-specific change-to-element mapping. |
| Project semantic index | ADAPT/EXTRACT | Shared project discovery, typed categories required; avoid symbol-kind conflation. |
| Public SHARED projection / ShareGrant | ADAPT/EXTRACT | Preserve same authority and source filtering; include new typed analysis/render data. |
| Presentation Stage / authority | ADAPT/EXTRACT | Same stage and authorized list; renderer capability dispatch must support representations. |
| MCP generic resource tools | REUSE AS-IS | Keep standard resource authorization/revision/gov path. |
| MCP artifact-specific validation/render tools | ADAPT/EXTRACT | Expose new schemas and capabilities; don't route around application services. |
| Guidance registry | ADAPT/EXTRACT | Add representation-specific entries, retain semantic boundary explanations. |

## 13. Governance, readers, Presentation and MCP

The new resources should naturally follow:

```text
MY WORK edit -> explicit submission -> immutable PROPOSAL snapshot
             -> independent review evidence -> explicit promotion -> SHARED
```

No artifact-specific auth, ShareGrant, or Presentation authority. New representation type must be allowed by source storage, API/MCP resource validation, revisions, proposal snapshot parsing, promotion, retirement/history, search/index, and public projection. Promotion continues preserving identity/history and is the only ArchitecturalProposal mutation of SHARED.

Public reader must recognize renderer capability while its resource list remains active SHARED only. The existing public projector explicitly prunes semantic-message refs and returns Event Flow analysis fields; refactor those as typed/representation-specific projection data rather than letting either new artifact bypass current resource/project filtering. ShareGrant remains project-bounded, read-only, and current; no MY WORK/proposals or independent public artifact endpoint.

Presentation discovery can continue using resources ordered by the authorized projection. Replace current type fallthrough with explicit supported-renderer selection (or a small representation renderer registry). Conceptual and Database become renderers on the existing Stage, not new Presentation authority/deck/model. Public Presentation inherits ShareGrant projection; authenticated Presentation inherits SHARED access.

MCP agents should discover supported representation schema/capabilities, read/edit using generic resource services, validate and render using artifact-specific semantics, and receive structured diagnostics/typed index facts. Generic create/update paths are preferred where they already validate resource type and revisions; domain-specific tools may be necessary for semantic operations, but must call shared application services and enforce context, ownership, authorization, revision and proposal governance. Submission remains explicit and never mutates SHARED. Do not add MCP tools before API/resource schemas and parser contract are stable.

## 14. Validation against scenarios

| Case | Result under recommendation |
|---|---|
| A `Customer --places--> Order` | Explicit Conceptual relation with directed structure and authored label; no runtime/causal implication. |
| Same label across two Conceptual files | Distinct resource-local IDs unless explicitly bound to same typed project identity; label alone is candidate only. |
| `orders.id UUID PK`, `customer_id UUID FK -> customers.id` | Database columns and PK/FK facts independently represented; line is projection only. |
| `customer_id -> buyer_id` | Stable column IDs permit rename/change diff; absent identity evidence, conservative remove/add. |
| Proposal adds Concept and changes relation | Semantic diff targets concept/relation IDs and review decorates those entities. |
| Proposal changes `varchar(100)` to `varchar(255)` | Stable column identity yields type modification, with exact source diff retained. |
| Public sharing | Both resources flow through current active SHARED ShareGrant source projection and authorization. |
| Presentation | Both render on the current Stage from already-authorized resources. |
| MCP authoring | Discovery/schema/diagnostics plus generic governed resource mutation and artifact-specific validation/render. |
| Conceptual/Database edge | Never creates Causal evidence; only explicit Event Flow causal declarations do. |

## 15. Decision records

| # | Decision | Why / alternatives | Consequences | Deferred questions |
|---|---|---|---|---|
| 1 | Conceptual uses dedicated graph-native semantic model | Best match for structural concepts and relations; reject UML-complete and generic graph as domain truth | Own parser, typed validation, projection and diff | Exact optional relation classifications |
| 2 | Relationship direction is structural; label is authored/open | Avoid closed ontology while preserving useful graph queries | `places` need not be a platform enum; exact labels diff/search | Controlled vocabulary as optional lint? |
| 3 | Stable resource-local concept identity; cross-resource identity explicit | Labels are not identity; support rename and multiple independent models | IDs needed in source, index and diff | Project-level identity registry scope/ownership |
| 4 | Database uses dedicated schema semantic model | DB is persistence structure, not generic graph or purely ER model | Typed table/column/constraint facts | Logical ER representation as separate future profile/type |
| 5 | V1 scope per §5.2 | Core table/column/PK/FK without SQL suite expansion | Unique SHOULD; indexes/checks/views later | Whether to include unique in first authoring release |
| 6 | Stable local IDs for schema/table/column/FK | Supports rename, movement and semantic review | Source format must preserve IDs | ID generation/user ergonomics |
| 7 | Share geometry-only graph layout only after second real consumer | Existing graph layouts are domain-specific; abstract prematurely is risk | Separate projections/renderers; extract small contract with evidence | ELK vs Dagre/custom based on headless spike |
| 8 | Structured, identity-explicit source; syntax remains open | Human/agent edits, diagnostics, Git diff and MCP schema all matter | One canonical parseable source; no SQL-only dependency | DSL vs structured YAML comparison/prototype |
| 9 | Semantic diff per artifact; render decoration consumes semantic targets | Pixel diff unstable and meaningless for architecture | Stable IDs and source ranges essential | Alias/rename UX and fallback candidate suggestions |
| 10 | Cross-artifact relationships explicit typed evidence | Prevent label inference and semantic boundary collapse | Separate from FK, conceptual edge, message binding and complementary-view | Artifact-local declaration vs project relationship registry |
| 11 | Headless-compatible deterministic layout is required | MCP/tests/public rendering share non-React layer; current Causal worker is browser-only | No DOM-required engine contract; tie-break stable IDs | Server-side layout package/worker adapter choice |
| 12 | No semantic coordinates; no manual layout V1 | Avoid diff noise and source/render coupling | Automatic layout; future layout metadata separate if justified | Persist layout hints in resource metadata or separate resource |

## 16. Implementation phases

Recommended sequence is gated by usable vertical slices rather than a generic diagram foundation:

1. **D02.1 — semantic contract and authoring spike.** Completed in `docs/d02-1-semantic-contract.md`; contracts, identity rules, source-format recommendation and extensions are resolved. No implementation or production registration was introduced.
2. **D02.2 — Conceptual source/model/validation.** Dedicated grammar and semantic model, stable local identity, structured diagnostics, fixtures and MCP schema discovery. No layout dependency needed yet.
3. **D02.3 — Conceptual analysis/index + basic deterministic projection/render.** Typed index entries, source-addressable SVG, accessible textual catalog, viewport and SHARED/MY WORK lifecycle integration. Keep cross-artifact bindings out.
4. **D02.4 — Conceptual semantic diff and proposal review.** Entity-level changes and decorations; proposal base/snapshot unchanged.
5. **D02.5 — Database source/model/validation.** Schema semantics, V1 table/column/PK/FK, null/default unknown representation, stable IDs; no SQL import.
6. **D02.6 — Database index/projection/render + lifecycle/public/Presentation/MCP.** Type-specific schema/table UI and graph projection; assess shared geometry only with Conceptual evidence.
7. **D02.7 — Database semantic diff/review.** Column, key and FK changes projected into decision workspace.
8. **D02.8 — Explicit cross-artifact identity/relationships, if product decision authorizes it.** Separate typed evidence mechanism, index querying and governance review; no inferred links.

Each phase should add parser/validation/domain and relevant host coverage in the same deployable slice. Sequence/Event Flow AST changes are not prerequisites.

## 17. Open questions

### Blocking before implementation

Resolved by D02.1: Conceptual directions are directed/undirected with open labels and resource-local IDs; cross-resource identity remains explicit-only; Database is schema-native with optional schema, stable table/FK IDs and optional stable column IDs; source direction is dedicated DSL; types are opaque; `.concept` and `.dbschema` are recommended extensions and `conceptual`/`database` resource types. Indexes are SHOULD in V1, while completeness metadata is deferred. Full decisions and validation rules are in [D02.1](d02-1-semantic-contract.md).

### Can defer

- Optional Concept kind/classification and constrained relation vocabulary.
- Shared project-wide concept identity registry and aliases.
- Indexes, check constraints, generated columns, views, materialized views, routines and triggers.
- DDL/migration/introspection ingestion and dialect normalization.
- Explicit completeness/scope syntax and machine-source provenance detail.
- Manual layout metadata and persistence boundary.
- Layout-engine selection after a headless deterministic prototype using representative diagrams.
- Project-level cross-artifact relation storage and query design.
- Conceptual/database MCP tool granularity after generic resource schema capabilities are tested.
- 200-node/500-table large-model navigation and filtering UX beyond stated stress targets.

## 18. Anti-goals and explicit answers

This recommendation does not define a UniversalDiagramAST, platform-wide semantic `Node`/`Edge`, UML editor, full database design suite, SQL IDE, arbitrary canvas, persisted deck, new authorization model, inferred causal links, or name-based cross-artifact identity.

| # | Question | Answer |
|---:|---|---|
| 1 | Should Conceptual reuse Sequence AST? | **NO** |
| 2 | Should Conceptual reuse Event Flow AST? | **NO** |
| 3 | Should Conceptual have its own semantic model? | **YES** |
| 4 | Should that model be graph-native? | **YES** |
| 5 | Should generic Node/Edge become platform semantic primitives? | **NO** |
| 6 | Should Conceptual initially be UML-complete? | **NO** |
| 7 | Should Database reuse Conceptual semantic model? | **NO** |
| 8 | Should Database have its own schema semantic model? | **YES** |
| 9 | Should Database be stored merely as graph nodes/edges? | **NO** |
| 10 | May Conceptual and Database share graph-layout infrastructure? | **YES** |
| 11 | Should layout infrastructure contain domain semantics? | **NO** |
| 12 | Should viewport/zoom/pan/fit be reused where practical? | **YES** |
| 13 | Should cross-artifact identity be inferred from labels? | **NO** |
| 14 | Should cross-artifact relationships require explicit evidence? | **YES** |
| 15 | Should Conceptual edges imply Event Flow topology? | **NO** |
| 16 | Should Conceptual edges imply Causal evidence? | **NO** |
| 17 | Should Database FKs imply service dependencies? | **NO** |
| 18 | Should new artifacts use existing SHARED/MY WORK lifecycle? | **YES** |
| 19 | Should they use existing proposal/review/promotion governance? | **YES** |
| 20 | Should they use existing ShareGrant authority? | **YES** |
| 21 | Should they use existing Presentation authority? | **YES** |
| 22 | Should they require a new authorization model? | **NO** |
| 23 | Should semantic diff be artifact-specific? | **YES** |
| 24 | Should rendered diff be based on semantic diff rather than pixels? | **YES** |
| 25 | Should source syntax optimize for AI/MCP as well as humans? | **YES** |
| 26 | Should visual coordinates be semantic source by default? | **NO** |
| 27 | Should layout be deterministic where practical? | **YES** |
| 28 | Should headless rendering constrain layout-engine choice? | **YES** |
| 29 | Should Conceptual/Database be independently extensible later? | **YES** |
| 30 | Is a UniversalDiagramAST recommended? | **NO** |

## 19. Verification and repository outcome

The original D02 discovery was a documentation-only deliverable from clean baseline `1f879c050c50da1b0fee34dcc7a17fb2089381b3`, separately committed as `180893b208d3f35691d9b32e661945ecf3d867c9`. D02.1 decisions and verification outcome are recorded in [the focused contract](d02-1-semantic-contract.md). No production implementation is part of either architecture decision phase.
