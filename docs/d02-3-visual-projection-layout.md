# D02.3 — Visual projection and layout architecture

**Status:** headless Conceptual/Database projection and geometry layout implemented. Database product rendering consumes this projection and positioned geometry; product lifecycle integration is tracked by D02.5.

## Boundary

```text
ConceptualModel -> ConceptualVisualProjection ─┐
                                                ├-> GeometryInput -> LayoutAdapter -> PositionedGeometry
DatabaseModel   -> DatabaseVisualProjection ───┘
```

The projections remain artifact-specific. `src/layout/geometry-input.ts` contains only rectangle sizes, ports, endpoint references, optional measurable labels, positions and routes. Geometry IDs are deterministic projection IDs, deliberately distinct from semantic IDs; each projection keeps explicit semantic-to-visual maps. No semantic model, parser, renderer, React or DOM dependency is introduced into the shared contract or adapter.

## Existing infrastructure audit

| Subsystem | Decision | Evidence / reason |
|---|---|---|
| Sequence layout | NOT REUSED | `src/layout/sequence-layout.ts` lays out Sequence AST constructs (lifelines, messages, activations, fragments, notes). It is deterministic and headless, but its geometry contract is not a graph/table contract. |
| Event Flow layout | NOT REUSED | `src/layout/eventflow-layout.ts` depends on Event Flow rows, producers, channels, causal order and fanout. |
| Topology layout | ADAPTED (principle only) | `src/layout/topology-layout.ts` provides evidence for deterministic layered placement; its topology semantics, fixed dimensions and cycle residual handling cannot preserve arbitrary cycles/loops/parallel edges or database ports. |
| Causal layout | NOT REUSED | The existing ELK adapter and worker are coupled to CausalViewModel, React Flow and browser worker lifecycle. |
| Viewport/camera | NOT REUSED here | `src/features/preview/viewport.ts` has reusable pure transform math, but it acts after layout and does not belong in headless geometry. The React `DiagramViewport` also measures DOM/SVG. |
| Review decoration | NOT REUSED | Existing proposal decorations emit Sequence/Event Flow/SVG-specific classes. Semantic-to-visual ID maps are preserved for a later artifact-aware decoration layer. |
| SVG helpers/renderers | NOT REUSED | They are presentation-specific. D02.3 stops at positioned geometry. |
| Text helpers | REUSED | `src/layout/text.ts` provides deterministic, font-independent width estimates and wrapping without DOM/font loading. |

## Artifact projections

### Conceptual

`projectConceptual` maps every concept ID to a distinct visual item ID and every relationship ID to a distinct connection ID. The projection retains concept name/description, relationship label and directed/undirected value. It includes concepts without edges, allows self/parallel/cyclic edges, and does not merge equal names or labels. `nameLines` and description wrapping plus deterministic estimated widths/heights are projection data for layout/render consumers, not semantic facts.

### Database

`projectDatabase` maps each table to a compound visual item. It retains qualified display name, authored column order, type, nullability, default, description, PK/FK markers, unique-constraint and index participation, complete index mappings, and explicit versus implicit column identities. Each column gets west/east row ports. Each FK gets one visual connection ID and ordered source/target column and port evidence arrays; a composite FK remains one connection, with the generic route attached to the first paired ports. This is a visual attachment policy, not a claim that the composite FK has a single-column semantic endpoint. No cardinality is projected.

Schemas are shown as qualified table names; no schema containers are created.

## Shared geometry and layout decision

The projections demonstrated a small shared contract is adequate after semantic projection: sized items, optional side ports, item/port endpoints, individually identified connections and optional measured labels. The contract has no artifact-specific field. Database row ports motivated first-class ports; Conceptual uses item endpoints.

| Candidate | Decision | Reason |
|---|---|---|
| Existing Sequence/Event Flow layout | Reject | Domain-specific geometry and semantics; cannot represent compound tables and row ports without contaminating contracts. |
| Existing topology layout | Reject as implementation | Layering is useful evidence, but cycle residual handling and topology projection are unsuitable. |
| Dagre | Reject | Not installed; its graph-oriented model does not offer the port-aware compound-node behavior required here without additional routing work. |
| Custom layout + router | Reject for this phase | Would require owning layering, crossing reduction, compound dimensions, self-loop and parallel routing, and ports. Too much unvalidated algorithm surface. |
| Existing ELK library | SELECTED behind adapter | ELK already exists in the lockfile, has MIT licensing, headless Node use, layered placement, compound-capable geometry, fixed ports and orthogonal routing. It is isolated in `src/layout/elk-geometry-adapter.ts`; no dependency was added. |

Candidate comparison (`✓` suitable, `△` possible with compromises/custom work, `—` not provided by the current implementation):

| Criterion | ELK | Dagre | Custom | Existing layouts |
|---|---:|---:|---:|---:|
| Directed graphs | ✓ | ✓ | △ | ✓ |
| Undirected connections | ✓ (direction ignored by layout) | ✓ (direction ignored by layout) | △ | △ |
| Cycles | ✓ | △ | △ | — |
| Self loops | ✓ | △ | △ | — |
| Parallel edges | ✓ | △ | △ | △ |
| Disconnected components | ✓ | ✓ | △ | △ |
| Compound/large items | ✓ | △ | △ | — |
| Ports | ✓ | — | △ | — |
| Port-aware routing | ✓ | — | △ | — |
| Edge labels | ✓ | △ | △ | — |
| Deterministic configuration | ✓ | ✓ | △ | ✓ |
| Headless Node | ✓ | ✓ | ✓ | ✓ |
| Browser-capable | ✓ | ✓ | ✓ | ✓ |
| TypeScript integration | ✓ (adapter-local types) | ✓ | ✓ | ✓ |
| Bundle impact | △ (already installed; bundled adapter entry) | △ (new dependency) | ✓ | ✓ |
| Maintenance/activity | ✓ | △ | owned locally | established locally |
| License | MIT | MIT | project | project |
| Medium-fixture performance | measured below | not measured | not measured | not applicable |
| Incremental future potential | △ | △ | ✓ (with ongoing ownership) | △ |
| Database FK suitability | ✓ | △ | △ | — |
| Conceptual graph suitability | ✓ | ✓ | △ | △ |

The matrix compares current, credible capabilities rather than hypothetical custom implementations. ELK is favored by Database's compound rows and port-aware orthogonal FK routing; a small custom algorithm would still need crossing reduction, cycle handling, route separation and testing, while Dagre would need an additional port/routing layer.

ELK is asynchronous. The adapter selects layered RIGHT placement, orthogonal routing, deterministic fixed options and no random IDs. IDs and input order are preserved in returned geometry; equivalent repeated input is tested for equivalent output. Output errors throw `GeometryLayoutError`; incomplete items, ports, positions or routes are never returned as partial success. Invalid duplicate IDs, dimensions and references fail before the engine call. Empty input returns empty geometry.

## Measurement, ports and routing

Text sizing is a deterministic estimate, not browser font measurement. Conceptual wraps names/descriptions at a fixed available width and computes a minimum box. Database row heights are fixed and table width is the maximum estimated header/row width. A renderer may later replace the measurement policy or render overflow handling without changing semantic models or the geometry adapter.

Database ports are placed at each column row on the west/east sides. ELK routes to those ports using orthogonal edges. Self-loops and parallel edges remain separate identified connections/routes; undirected Conceptual connections retain their direction metadata in the artifact projection while layout treats endpoints as geometry anchors. ELK is responsible for bends and route placement. Composite FK evidence is preserved on the projection; current single route attaches to the first ordered source/target pair. The product renderer exposes the complete ordered mapping in accessible relationship details, so the representative route is not presented as the complete semantic mapping.

## Evidence and known limits

Headless tests cover Conceptual chain/star/cycle/disconnected/self/parallel/mixed-direction cases; Database simple/self/composite/parallel-FK fixtures, row ports, a 40-table/60-FK fixture and a 50-concept/100-relationship fixture. Tests assert no trivial item overlap in a cyclic/disconnected fixture, route identity, port ownership, repeated-run determinism, empty layout, and explicit invalid-input errors. Medium fixture elapsed time is asserted below 15 seconds; use the test's reported run duration as a coarse sanity check, not a benchmark guarantee.

Adding nodes/tables may change global layered positions. D02.3 does not promise positional stability or persist manual coordinates. The layered engine optimizes a fresh arrangement; future stability needs evidence and should be handled downstream without changing semantic identity.

Future review and selection use the explicit semantic-ID-to-visual-ID maps, never coordinate comparison. Future guidance should explain Concept, directed/undirected authored relationship and label; and Database table, column, PK, FK, unique constraint evidence, nullability and the visual FK connection. Rendering, manual layout, review decorations, selection UI, semantic diff, public Share, Presentation, Explorer and MCP artifact-specific support remain out of scope.
