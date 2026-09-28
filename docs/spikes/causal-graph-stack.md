# Causal Graph Stack Spike

This document records the completed candidate evaluation. The temporary spike harness has been removed; candidate A is now the production causal renderer.

## Fixtures

The original candidate screenshots were generated during the spike and are not part of the production artifact set.

- Export Completion and Webhook Notification
- UpOne Account and Transaction Fan-out
- Webhook Delivery Retry
- Monthly Billing
- Programmed Recharge

The five fixtures are now permanent geometry and integration tests; the temporary screenshot entry point was removed with the spike harness.

## Candidates

### A. React Flow + direct ELK

The production adapter makes one React Flow node for every message, handler, effect, failure, and retry. It passes that flat graph directly to ELK layered/orthogonal layout. ELK supplies node positions and routed sections; the renderer only converts those sections to an SVG path for React Flow's edge primitive.

### B. React Flow + @statelyai/graph + ELK (rejected)

The same elements are converted to `@statelyai/graph`'s JSON graph, laid out through its `getElkLayout()` adapter, then converted back through its xyflow adapter. This keeps hierarchy and ports available in the interchange model without inventing a second domain model. No effects are removed or reinserted.

## Evaluation

| Concern | A | B |
|---|---|---|
| Causal traceability | Pass. IDs and edge types stay in node/edge data. | Pass. Same IDs/data survive graph conversion; verify adapter metadata for every future graph field. |
| Crossings / edge-through-node | Pass on the five fixtures with ELK orthogonal routing; no custom collision repair. | Pass on the five fixtures; same ELK engine, slightly different coordinates. |
| Disconnected components | Pass. ELK lays out all nodes in one graph. | Pass. Graph adapter preserves disconnected nodes. |
| Effect ownership | Pass via real effect nodes, owner text, and effect edge style. | Pass, with owner data retained in graph node data. |
| Failure/retry readability | Pass via distinct nodes, colors, and edge styles. | Pass via the same renderer data. |
| Compound / sub-flow support | ELK supports it, but this adapter does not infer groups from semantics. | Strongest. `parentId`, ports, and hierarchy are first-class in the graph IR and ELK adapter. |
| Dynamic dimensions | Pass with adapter-owned measured dimensions before layout. React Flow can remeasure later. | Pass through `measure`; the same sizing responsibility remains project-owned. |
| Fit, pan, zoom, minimap | Pass through React Flow `fitView`, `Controls`, and `MiniMap`. | Pass. |
| Upstream/downstream highlighting | Pass. Existing domain neighbor queries drive classes; the library owns interaction only. | Pass. |
| ELK Web Worker | Production uses a module worker around direct `elkjs`; the layout client also accepts an injected worker factory for tests. | Adds a conversion layer and an incompatible optional ELK peer range. |
| Custom layout/routing code | Low: graph conversion plus polyline rendering. | Low, but adds conversion and metadata boundary. |
| Bundle impact | Adds `@xyflow/react`; `elkjs` already existed. | Adds `@xyflow/react`, `@statelyai/graph`, and `web-worker` for Vite's ELK import path. |
| License | MIT. | MIT. |
| Maintenance/activity | React Flow is active and purpose-built for this interaction surface. | Stately graph is active and useful as an IR/adapter, but its current ELK peer range excludes this repo's `elkjs@0.12.0`. |

## Measured change

- Production dependencies: `@xyflow/react@12.12.0`; `elkjs@0.12.0` remains the preferred ELK version.
- Temporary spike code was replaced by production causal adapter, worker, React Flow view, export serializer, and permanent tests.
- Removed legacy custom causal geometry: 378 LOC in `src/layout/causal-layout.ts`, plus the old causal SVG renderer and pipeline.
- Candidate A deleted custom component packing, effect grouping, shelf packing, fallback routing, and collision-repair geometry. Domain projection and semantic neighbor queries remain.

## Known limitations

- The production view does not infer compound groups because `CausalViewModel` does not currently declare compound ownership. B supports the representation; inventing groups here would change semantics.
- Route rendering is a small adapter from ELK points to React Flow's edge path, not a new routing algorithm.
- Dynamic node resizing after layout needs a re-layout trigger; the spike supplies deterministic pre-layout dimensions.
- Source-node selection, review decorations, and SVG export are integrated through the production preview and export pipeline.
- Candidate B was removed because it added an unnecessary graph conversion layer and imposed an incompatible optional ELK peer range.

## Recommendation

**Candidate A: React Flow + direct ELK.** It delegates viewport, interaction, minimap, and layout/routing while keeping the smallest dependency and metadata path. Keep B as a bounded follow-up only if compound graph interchange or ports become requirements that justify its peer-version and conversion overhead.
