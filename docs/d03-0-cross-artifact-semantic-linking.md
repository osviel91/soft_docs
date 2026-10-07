# D03.0 — Cross-Artifact Semantic Linking Discovery

**Status:** architecture recommendation; discovery only; no production functionality implemented
**Baseline:** `2c0b34b2f53100983d7a5ee27cd2f91c50312363` (`master`, clean at inspection)
**Normative boundaries:** [documentation-model.md](documentation-model.md), [D02 artifact architecture](d02-artifact-architecture.md), [D02.1 semantic contract](d02-1-semantic-contract.md)

## 1. Decision summary

Introduce an explicit, project-scoped **semantic binding** record for an evidenced relationship between two typed entity anchors in distinct resources. Keep `ResourceRelationship` for resource-to-resource relationships such as complementary Sequence/Event Flow views. Do not generalize its current `complementary-view` meaning or use it to represent entity links.

The binding is an assertion, not a universal entity model: endpoints are opaque, typed references into existing artifact-specific models; the relation kind is a small explicit open/registered vocabulary; evidence is required; and uncertainty/candidates are reported separately from authoritative bindings. No matching name, structural resemblance, shared message text, FK, or resource relationship creates a binding.

This is a design decision, not an implementation commitment. D03.1 should first establish durable entity anchors and queryable analysis for the artifact types in scope. Sequence/Event Flow grammar and renderers are explicitly out of scope for this discovery and need not change to introduce the registry/query surface, but their existing non-stable IDs limit what can safely be bound there.

## 2. Repository evidence and current boundary

### 2.1 Resource relationships

`src/domain/workspace/resource-relationship.ts` defines `ResourceRelationshipKind = "complementary-view"`, resource IDs as endpoints, and optional execution/causal/other view roles. `validateResourceRelationship` permits only a Sequence and an Event Flow. The pair is normalized by resource ID, disallows self-links, and `sameResourceRelationship` identifies by kind and pair.

The relationship is stored in project metadata and, in server mode, `resource_relationships` (migration 0015; MY WORK context isolation is added in 0016). `ProjectCatalog` permits private-context creation and read; direct SHARED mutation is rejected. Proposal snapshots capture relationship operations; proposal diff exposes added/modified/deleted summaries; promotion validates base fingerprints and applies changes in the same governed batch as resources/manifest; retirement removes active links while history is retained. `buildPublicProjectProjection` filters links to the authorized active source set. MCP exposes `list_resource_relationships` and private-context `create_resource_relationship`.

This is useful lifecycle infrastructure, but the relationship's **subject is a resource**, the pair is symmetric/normalized, and its domain meaning is specifically complementary views. It has no entity endpoint, evidence, source range, anchor-resolution state, or assertion provenance. Recasting it as a generic graph edge would silently change identity, validation, and semantics.

### 2.2 Analysis, semantic index, and project index

`analyzeResource` in `src/domain/project/resource-analysis.ts` is a per-resource cached analysis. Sequence contributes participant symbols/usages and message occurrences; Event Flow contributes event/service/channel/broker symbols, message entities and causal facts; Markdown contributes headings and resource references. Conceptual and Database parsing, semantic models, validation, artifact-specific rendering, semantic diff, Share and Presentation are implemented (see `docs/d02-2-conceptual-database-dsl.md`), but this analyzer currently only parses them for title/diagnostics and does not publish their typed entities into `ResourceAnalysis` or `ProjectIndex`.

`ProjectIndex` (`src/domain/project/project-index.ts`) resolves project-wide resource references and aggregates symbols, semantic messages/occurrences and causal facts. It does not currently include resource relationships or general entity bindings. The MCP `semanticIndex` helper builds this index from resources and semantic message identities but does not load relationships. The indexer is derived/rebuildable; it should be the query/read model, not the authority or persistence store for assertions.

`semantic-message-trace.ts` is a narrow existing precedent: names are grouped as discovery candidates, while an explicit project-manifest `messageRef` to `SemanticMessageIdentity` is authoritative. `SemanticMessageIdentity` is typed only as event/command and is not a universal symbol registry.

### 2.3 Existing entity identity quality

| Artifact/entity | Current identity | Cross-resource suitability |
|---|---|---|
| Resource | Stable project resource ID, independent of current path | Suitable endpoint namespace; path is display/navigation data, not identity. |
| Conceptual Concept / internal relationship | Authored stable local ID; IDs are scoped to resource | Suitable as `(resourceId, representation, entityKind, localId)` anchor. |
| Database schema/table/FK/key/index | Authored stable local IDs scoped to resource; column ID optional, otherwise `(tableId, exact name)` | Table/FK/key can be anchored; column fallback identity has weaker rename continuity and must be explicit in anchor form. |
| Sequence participant | Source participant ID/name local to file; index key `participant:${participant.id}` | Not a durable authored identity separate from name. Must be treated as a source-local anchor with stated rename fragility until a stable anchor contract exists. |
| Sequence message occurrence | Step/range/name/endpoints; optional `messageRef` to project event/command identity | `messageRef` is authoritative message identity when valid, but does not uniquely identify one occurrence. Range/step is positional and may move. Do not equate occurrence with message identity. |
| Event Flow event | Name/kind and source range; optional `messageRef`; analysis `nodeId` derives from range | Valid `messageRef` is stable message identity; no independent stable local event identity today. Range/node ID is not rename/move-stable. |
| Event Flow handler/effect/failure | Authored local IDs in Event Flow AST | Can be addressed by resource-scoped typed local ID, subject to parser/model analysis exposing it. |
| Markdown heading/span | Extracted heading text and line; no authored stable entity ID | No durable generic entity anchor today. Resource links are resource references, not semantic entity bindings. |

The existing `nodeIdOf(kind, range)` is a location key, not a stable identity. D03 must not promote it to one. Anchoring Markdown to a heading slug/line is similarly fragile across edits; V1 should support a Markdown entity only when it has an explicit durable anchor mechanism, otherwise permit a resource-level link or report no stable entity anchor.

## 3. Contract and terminology

Keep five concepts separate:

1. **Resource identity:** stable project-scoped resource ID. Path/type/title are mutable descriptive or classification data.
2. **Entity identity within a resource:** a typed, artifact-specific local identity. Its global address is `(resourceId, representation, entityKind, localId)`; do not require a universal entity AST or global entity registry.
3. **Explicit cross-artifact relationship:** a separately stored typed assertion between two resolvable entity anchors in different resources, with authored relation kind and evidence/provenance. It does not assert equivalence, cardinality, runtime causality, or direction unless its specific declared kind defines only that aspect.
4. **Inferred/possible relationship:** a non-authoritative candidate from name, structural, or other heuristic discovery. It is returned as candidate evidence, never stored/promoted as an authoritative binding without explicit user-backed assertion.
5. **Unknown:** no supported assertion or sufficient anchor/evidence. Absence of a binding is not a negative relationship claim.

An entity anchor should contain only what is needed to resolve identity, e.g. resource ID, representation, entity kind, and local ID. Relation records should refer to the two anchors, a stable binding ID, a declared relation kind/label, evidence entries, and governance provenance/revision. Evidence should be inspectable and machine-addressable where possible: source resource and stable entity anchor, exact source range/revision or external evidence reference, and a concise rationale. A range is supporting evidence/navigation, not endpoint identity. The exact evidence schema and supported evidence forms are D03.1 blockers.

V1 relation vocabulary should not claim more than evidence: include a neutral, explicitly asserted `related-to`/`represents`-style relation only if product queries require it; prefer authored open labels over prematurely asserting `implements`, `realizes`, `causes`, `owns`, or equivalence. Directionality is per declared relation definition, not inferred from endpoint order. A relation may be left unresolved/unknown when the source artifact does not expose a stable entity anchor.

## 4. Model alternatives

| Option | Identity and semantics | Revision / governance | Diff and lifecycle | Auditability / decision |
|---|---|---|---|---|
| Extend `resource_relationships` | Requires replacing resource endpoints with polymorphic resource/entity endpoints, changing symmetric normalization and the sole relation-kind invariant. Risks conflating complementary views with entity-level assertions. | Existing MY WORK/proposal/promotion path is a useful template, but SQL table and API contracts are resource-specific. | Existing relationship diff/fingerprint assumes resource pair/kind/roles; entity anchors need endpoint changes and anchor validity checks. Existing retirement cleanup only sees resource IDs. | Migration could retain a single table but entails a breaking semantic schema and larger retrofit. Reject as the authority for entity links. Reuse lifecycle patterns, not its domain type. |
| Dedicated semantic binding registry (recommended) | Explicitly models typed entity anchors and evidence. Leaves each artifact's entity model independent; no AST unification. Separate identity of binding from identity of either endpoint. | New MY WORK/private context, immutable proposal snapshot, review and promotion operations can mirror existing governed operations and share batch/manifest revision protection. | Binding-specific fingerprint/diff; validate endpoint resources/entities against the proposal's effective indexed snapshot; retire/rename handling can preserve historical endpoint references and report unresolved anchors. | More storage/API surface, but clean semantics, independent evolution and explicit audit trail. Preferred because identity/evidence differ materially from resource-level complementary-view. |
| Put links in artifact source (Conceptual/Database/Sequence/Event Flow/Markdown) | Each source grammar would need foreign-resource/entity reference syntax; introduces cross-file coupling and parsing/resolution in every language. No common anchor contract exists for all endpoints. | Editing a link mutates one resource; atomic multi-resource endpoint changes and shared governance are harder. | Link changes appear in source diff, but cross-resource endpoint validity, retirement and referential history require additional global machinery anyway. | Can be useful later for links intrinsic to a particular notation, but not a single V1 mechanism. Reject as the initial cross-artifact authority. |
| Reuse semantic message identities | Stable and already bound explicitly for event/command occurrences. | Existing identity manifest and binding governance work for message identity. | Does not represent arbitrary Concept/Table/participant/handler relationships or evidence assertions. | Retain only for shared event/command identity. A common message identity is not a complementary-view link or generic entity equivalence. |
| Derive all links in `ProjectIndex` | Convenient query/read model; names and heuristics are discoverable. | Rebuildable index cannot own authored intent or proposal authority. | Derived results churn with content and cannot be reviewed/promoted as explicit facts. | Use index for endpoint resolution and candidates, never as persistence/authority. |

### Recommendation

Create a separate `SemanticBinding` domain/persistence concept. It may share generic application mechanisms for context ownership, revision checks, immutable proposal operations, promotion batches, audit and public projection, but it must not be a `ResourceRelationship` subtype or a universal graph edge. Keep complementary-view resource links independently queryable and preserve their existing contract.

## 5. Concrete examples and limits

Examples below describe candidate assertions, not a frozen relation vocabulary. `evidence` is mandatory; placeholders must be replaced with inspectable evidence, never fabricated.

### 5.1 Concept Project ↔ table projects

```text
left  = (resource=domain.concept, representation=conceptual, kind=concept, localId=project)
right = (resource=app.dbschema, representation=database, kind=table, localId=projects)
relation = "represents"       # only if the author explicitly asserts this meaning
evidence = inspected design/schema source or named human rationale, with revision/range where applicable
```

This does not mean the concept and table share identity, that `projects` is the only persistence backing, or that the table fully implements the concept. Without explicit evidence the result is an unconfirmed candidate or unknown.

### 5.2 Concept User ↔ table users

```text
left  = (resource=domain.concept, representation=conceptual, kind=concept, localId=user)
right = (resource=app.dbschema, representation=database, kind=table, localId=users)
relation = explicit authored claim, e.g. "represented-in" only when its semantics are agreed
evidence = source evidence / explicit rationale
```

Do not create this link because `User` and `users` look alike. Do not infer one-to-one, canonical storage, or exclusive backing.

### 5.3 Concept ↔ Sequence participant

```text
left  = (resource=domain.concept, kind=concept, localId=project)
right = (resource=project-lifecycle.seq, kind=sequence-participant, localId=<stable-anchor>)
relation = explicit authored relation and evidence
```

Current participant identity is name/source-local, not a stable authored ID independent of the label. Until a stable participant anchor exists, expose this as a location/name candidate or mark it unbindable, not as a durable authoritative binding. Adding an ID grammar to Sequence is not part of D03.0 and must be separately scoped; do not make entity binding silently depend on line/range IDs.

### 5.4 Event Flow event ↔ Sequence message/handler

Where both sources explicitly bind to the same valid `SemanticMessageIdentity` (`messageRef`), use that identity to answer that the artifacts contain occurrences of the same event/command. That answers message identity, not occurrence identity and not necessarily a relationship between a particular handler and a particular Sequence arrow.

For an Event Flow event and a Sequence message/handler relationship beyond common message identity, create a separate binding only with evidence identifying the exact entities and the claimed meaning. Event Flow event lacks an independent stable local ID, Sequence occurrence is positional, and handler/event causal links are Event Flow-specific. Preserve those types and do not turn a shared name, same message ID, or handler causal edge into a cross-view complementary relationship automatically.

### 5.5 Markdown ↔ semantic entity

Markdown currently offers resource identity, headings/line spans and explicit resource links, but no stable entity anchor. A resource-level Markdown link is supported as a resource reference and does not claim an entity relation. Entity-level binding is deferred unless Markdown adopts an explicit durable anchor (for example an authored stable block identifier with a defined lifecycle). Heading text, generated slug, line number, or quoted name is not sufficient endpoint identity. A citation to source text may be evidence without making that text an entity endpoint.

## 6. Invariants

1. Resource ID and typed local entity ID are distinct fields; endpoint resolution always includes resource scope and entity kind.
2. Entity names are display/search data, never identity. Name matching can produce candidates only.
3. Authoritative bindings are explicit authored claims and require evidence. The system may validate evidence shape/anchor existence but cannot fabricate evidence or upgrade candidates.
4. Binding relation, semantic-message identity, Conceptual relationship, Database FK, Event Flow causal edge, and complementary-view resource relationship remain distinct types and meanings.
5. No universal AST, universal entity inheritance tree, or generic semantically overloaded Node/Edge is introduced. Each artifact remains the authority for its internal entities and relations.
6. Cross-artifact binding asserts only its declared relation semantics. No equivalence, implementation, causality, ownership, completeness, exclusivity, cardinality, or direction is implied unless explicitly defined and evidenced.
7. Invalid/missing/unresolvable endpoint is diagnosed as unresolved/unknown; it must not be repaired by a name lookup. Resource rename preserves resource identity; path change does not break anchors.
8. Resource/entity rename preserves a binding only when the endpoint's stable local ID is retained. Without stable identity, report an unresolved/changed endpoint, not a guessed continuity.
9. Bindings and candidate results are separate API shapes. Candidate records cannot enter SHARED as authoritative links through ordinary indexing or proposal submission without explicit assertion and evidence.
10. SHARED lifecycle is non-destructive: retire/unresolve does not erase historical binding identity, revisions, evidence, review or promotion audit. Active query views may omit retired endpoints but must report why where appropriate.
11. MY WORK is private to its owner; proposals are immutable, team-visible and non-authoritative; only explicit authorized promotion changes SHARED.
12. Indexes are derived and rebuildable. Binding authority comes from governed persisted records, not from UI, renderer, share projection, or inferred index output.
13. Partial source scope remains valid. No link or entity omission proves architectural absence.

## 7. Indexing, Share projection, and Presentation

### 7.1 Analysis and query projection

Add artifact-specific typed entity anchors to `ResourceAnalysis` where parsers/models already provide stable IDs; project-level assembly resolves those anchors and validates persisted bindings. Conceptual and Database must first contribute their native typed entities to analysis/index. Do not parse their source a second time in query tools. Sequence participant/message and Event Flow event/handler anchors require an explicit stability assessment before becoming bindable.

The semantic binding repository remains authoritative. `ProjectIndex` may expose validated active bindings alongside distinct candidate suggestions. Avoid forcing entity bindings into `ProjectReference`, whose current meaning is authored resource reference, or into the participant `ProjectSymbol` union. Query responses should carry endpoint type/identity, relation, evidence, status, and provenance.

### 7.2 Share projection

`buildPublicProjectProjection` currently receives active SHARED resources and resource relationships, filters resource links to source IDs, builds the index, prunes invalid message refs, and returns catalog facts. Add only active SHARED bindings whose endpoint resources are included and whose anchors resolve in the projected index. Do not expose MY WORK/proposal bindings, unverified candidates as authoritative, or evidence that is outside the share grant's authorized resource set. If evidence is unavailable under the projection boundary, disclose a redacted/unavailable evidence state rather than expanding authority to fetch it.

### 7.3 Presentation

Presentation consumes an already authorized resource projection and currently selects rendering by supported representation. Cross-artifact links can be consumed later as navigation/relationship overlays or an accessible textual catalog, but are not a reason to introduce a universal renderer or merge diagrams. The initial consumer can be semantic search/agent query output; visual overlays wait for stable renderer-addressable entity IDs and explicit product need. Resource-level complementary-view navigation remains separate.

## 8. Governance, diff, review, promotion, and lifecycle

The recommended binding registry needs the same authority boundary as resource relationships, but separate snapshots and fingerprints:

- MY WORK operations create/update/remove bindings in the caller-owned private context, with expected revision and context isolation.
- Submission selects explicit binding operations (or an explicit closure policy) into immutable PROPOSAL snapshots. Do not silently include every binding in the context; report selected bindings and dependencies. Endpoint resources/entities required by a binding must be in effective SHARED or selected proposal content and resolve under the proposal snapshot.
- Proposal diff lists binding ADD/UPDATE/REMOVE with both typed endpoints, relation semantics, evidence changes, and resolution diagnostics. Resource textual diff alone is insufficient.
- Review evidence remains append-only and applies to the immutable proposal snapshot. Review UI should show evidence and endpoint changes; approval does not publish.
- Promotion preview validates current shared base, binding fingerprint, endpoint resource revisions/identity, relation/evidence validity, permission and lifecycle. Promotion writes binding changes atomically with manifest/resource operations and records audit entries. A stale base is reported, never silently rebased.
- Resource or entity retirement/rename must not silently delete bindings. Preview should report bindings that become unresolved or retired. Explicit binding removal is a proposal operation; historical records stay available. For stable local IDs that persist through resource updates, links remain resolved.
- `resource_relationships` continues its existing diff/promotion/lifecycle behavior unchanged. Share its batch and audit infrastructure where safe, not its endpoint schema.

The initial binding record may use project manifest persistence, server table, or another existing authoritative repository, but MY WORK/context isolation, optimistic concurrency, proposal snapshot, promotion atomicity and durable history must have equivalent semantics in local and server modes. Select exact storage during D03.1 after comparing manifest churn/size with server-only storage and local parity; do not let that choice weaken authority.

## 9. MCP query surface for D03.1/D03.2

Expose explicit read queries through the application layer, returning provenance and epistemic status, not name-inferred links as facts:

| Agent question | Query behavior |
|---|---|
| “¿Qué artefactos representan este concepto?” | Resolve an exact typed entity anchor; return explicit bindings and evidence, then separately list candidates/unknowns. “Representan” must not imply equivalence unless a relation kind says so. |
| “¿Qué tablas respaldan este concepto?” | Return explicit Concept-to-table bindings only; list name-based matches in a separate candidate section, never as backing facts. |
| “¿En qué secuencias participa?” | For a bound entity with a stable Sequence participant anchor, return exact resources/participant anchors and evidence. If only names/ranges exist, label as candidate/unanchored and ask for confirmation. |
| “¿Qué eventos están relacionados?” | Query explicit bindings and independently query shared message identities/authoritative message refs. Keep relation and same-message identity results visibly distinct. |
| “¿Qué evidencia respalda cada vínculo?” | Return evidence entries, source resource/revision/range or external provenance, author/assertion and proposal/promotion provenance; disclose unavailable evidence under ShareGrant filtering. |
| “¿Qué podría estar relacionado?” | Return bounded heuristic candidates with algorithm/reason and `authoritative: false`; never write them or blend them into explicit results. |
| “¿Qué no sabemos?” | Report missing stable anchors, absent evidence, unresolved/retired endpoints, and unsupported artifact coverage as unknown; never convert absence to a negative answer. |

V1 MCP should add list/get/query capability over the governed application service and explicit private-context create/update/remove operations only after write contract/governance is ready. Do not add name-based auto-bind, inferred relationship creation, or a tool that bypasses proposal/promotion. Candidate discovery may be computed from `ProjectIndex`; read results must include context/provenance and status.

## 10. Migration and compatibility

1. No migration is required for this discovery. Existing `resource_relationships`, complementary-view links and semantic message identities remain byte/meaning compatible.
2. D03.1 adds new binding storage/schema and versioned domain/API types; do not overload `project.json.relationships` or reinterpret its rows. If local metadata is selected, add a separate property with tolerant parse/round-trip and preserve unknown-version safety.
3. Existing data is not auto-converted. A complementary-view pair is not evidence for any entity binding; message identity refs remain message identity refs.
4. Add index support incrementally: Conceptual/Database typed anchor contributions first; then only those Sequence/Event Flow entity kinds with stable anchors. Markdown remains resource-level until a stable authored anchor is designed.
5. Provide diagnostics for dangling bindings after endpoint edit/retirement and preserve the old record/history. Never migrate by display name. Any later import-assisted candidate report remains non-authoritative.
6. Public projection remains SHARED-only. Schema migration must not create binding data or grant exposure to existing ShareGrants by default; expose only within already-authorized included resources.

## 11. Alternatives rejected and anti-goals

- Extending `ResourceRelationship` into an arbitrary node-edge graph: mismatched endpoint identity, pair normalization, relation semantics, evidence, and lifecycle constraints.
- Treating same names as identity or proof: ambiguous, non-durable, language/case-sensitive and potentially wrong.
- Reusing `messageRef` for Concept/Table/participant: message identities have event/command semantics and occurrence binding contract.
- Using source range/node ID as stable identity: edits move ranges and generated IDs.
- Putting all entity types into one polymorphic AST/index schema: erases independent artifact semantics and creates a universal AST in another layer.
- Treating Conceptual edges, Database FKs, Event Flow causality, Markdown resource links, and resource complementary-view relations as interchangeable.
- Automatically inferring causal direction, cardinality, implementation, equivalence, ownership, completeness, or exclusivity.
- Making links a renderer concern or relying on hidden visual edges as evidence.
- Introducing authoring grammar changes or renderer changes in D03.0.

## 12. Incremental plan D03.1–D03.3

### D03.1 — Entity anchors and governed binding contract

- Freeze endpoint serialization, typed entity-kind vocabulary, stable-anchor requirements, relation/evidence schema, unresolved state, and local/server persistence strategy.
- Extend Conceptual/Database analysis to expose their existing stable local IDs as typed anchors; add index/query tests without universal AST changes. This is index integration, not implementation of their already-supported parsers/renderers/diffs.
- Prototype binding repository/application operations with context ownership, revisions/idempotency, validation and immutable proposal/promotion integration; no grammar or renderer scope creep.
- Inventory Sequence/Event Flow entities; only declare bindable those with stable identity or explicitly accept a bounded unstable anchor contract. Do not assume current participant/event names or ranges qualify.
- Decide whether any Markdown stable entity anchor is warranted; otherwise record resource-only support.

### D03.2 — Explicit authoring, query and proposal decision

- Add explicit binding operations through MY WORK, proposal snapshots, diff, review evidence display, preview and atomic promotion.
- Add MCP read/write tools using exact typed anchors and explicit evidence; queries separate authoritative bindings, shared-message identity, candidate matches and unknowns.
- Extend the existing SHARED public projection and Presentation consumers only to the degree supported by stable anchors and ShareGrant filtering; provide accessible textual navigation before visual overlays. Conceptual/Database Share and Presentation already exist; the D03 work is binding projection/navigation, not basic artifact support.
- Test create/update/remove, stale revisions, unresolved endpoints, retire/history, context privacy, stale proposal base, conflict, audit and redacted evidence.

### D03.3 — Enrichment and broader artifact coverage

- Add opt-in candidate discovery and explicit human/agent confirmation workflow; candidates remain non-authoritative until submitted as asserted bindings.
- Reassess stable Sequence participant and occurrence anchors and Event Flow event anchors. If required, separately propose source-identity work rather than binding to line/label heuristics.
- Add Markdown entity anchors only if a concrete stable authoring and lifecycle contract is approved.
- Consider entity navigation/overlays, cross-artifact impact queries and relation vocabulary expansion only after D03.1/D03.2 usage demonstrates value. Do not claim broad semantic impact analysis beyond implemented query evidence.

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Relation vocabulary overstates meaning | Start with minimal explicit vocabulary; document exact entailments; allow open labels only with clear declared semantics and review. |
| Local IDs are stable only within the resource and can be edited/reused | Validate uniqueness; scope endpoint by resource/type; preserve history and emit unresolved diagnostics; never fall back to name. |
| Sequence/Event Flow lack durable IDs for some entities | Mark those endpoint kinds non-bindable or provisional; do not persist authoritative bindings to generated range IDs. |
| Proposal closure becomes surprising | Require explicit selected binding operations/dependency report; show endpoint resource selection and unresolved blockers before submission/promotion. |
| Stale bindings survive entity removal and look current | Separate active resolution from immutable record/history; display unresolved/retired status; require explicit proposal removal for authoritative deletion. |
| Evidence points outside ShareGrant or private contexts | Filter/redact evidence by authority boundary; never fetch or reveal hidden MY WORK/proposal data in public projection. |
| Two persistence paths drift (local/server) | Define one application contract and conformance tests for both; retain one authority model. |
| Query results imply completeness | Return scope and unknowns; state that no result means “no documented explicit binding,” not “does not exist.” |
| Indexing becomes a universal entity framework | Keep per-artifact entity extractors and typed unions; share only endpoint envelope and binding operations. |

## 14. Acceptance criteria

D03.0 is satisfied when:

- The recommendation distinguishes resource identity, resource-local entity identity, explicit cross-artifact relation, inferred candidate, and unknown.
- `resource_relationships` is evaluated as an existing resource-level governed mechanism, not assumed to be entity-level infrastructure; the dedicated binding decision is justified against revision, promotion, diff, lifecycle and auditability.
- Examples cover Concept Project/table projects, Concept User/table users, Concept/Sequence participant, Event Flow event/Sequence message or handler, and Markdown anchoring limits without asserting unsupported semantics.
- No relation is inferred or authored solely because names match; every authoritative relationship has explicit evidence.
- Conceptual, Database, Sequence, Event Flow and Markdown remain independent semantic artifacts; no universal AST, grammar change, or renderer change is proposed for this phase.
- Share projection and Presentation are identified as consumers behind existing authority filtering, not sources of link truth.
- MCP questions distinguish explicit binding, message identity, candidates, evidence and unknown.
- Governance, proposal diff/review/promotion, lifecycle/history, migration and phased D03.1–D03.3 plans are explicit.
- No production functionality, grammar or renderer was modified for this discovery.
