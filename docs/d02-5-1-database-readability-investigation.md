# D02.5.1 Database Readability Investigation

## Scope and baseline

The checked-in repository contains no `.dbschema` artifact for the reported real 33-table schema. It is therefore an investigation reference only and is not copied into source control or used as a regression fixture. The existing headless synthetic layout baseline is 40 tables / 60 foreign keys; the focused baseline passes (12 tests, 3 files, ~2.2 s).

## Measured causes before implementation

- `projectDatabase` measured a row as `estimateTextWidth(name + type) + 58`, but `renderDatabaseSvg` places the name at a fixed left inset and the type plus PK/FK/UQ and nullability markers at a right-aligned edge. Since the two independently rendered regions can each consume nearly the full measured combined width, the measured width does not guarantee separation. The font-independent estimator is deterministic, but the equation does not match the rendered geometry.
- ELK's default profile is the general RIGHT-directed layered profile (`BRANDES_KOEPF`, `LAYER_SWEEP`, orthogonal edges, 40 node spacing, 72 between layers, 18 edge-node spacing). DatabasePreview selected this default profile, so Database had no dense-schema-specific placement or edge-spacing policy.
- The projection creates one visual edge per semantic FK and retains complete ordered column/port mappings. However, its geometry edge uses only the first source and target port, including composite FKs. The layout contract returns one route per edge; the renderer presents that route as the FK. Thus composite endpoints are not individually represented by route geometry. Ports were fixed positions but had no explicit x coordinate and were only one pixel wide.
- Existing tests verify stable edge IDs, first-port ownership, determinism, non-overlapping table bounds, and row-sized tables. They do not measure text-region collision, route/table intersections, crossings, or shared route segments. ELK route geometry has no guarantee that a dense graph avoids crossings or overlapping trunks.

## Baseline limits and measurement method

There is no authoritative real-schema source in this checkout, so no numeric before measurement for that artifact can be claimed. Structural fixtures will report layout bounds, fit scale in an 800x600 viewport, route crossings and overlapping/shared segments where segment geometry permits, and assert text region separation and endpoint identity. The measured real schema remains a private investigation input unless supplied separately.

The generic geometry adapter remains semantic-free. If one edge cannot express every composite FK column pair, that is a limitation of the current one-route-per-edge geometry contract, not a reason to infer constraint types or put Database semantics in the adapter. ELK rounds routed points to integer pixels while globally positioned ports can be half-pixel; endpoint verification therefore allows at most 1 px deviation. Representing each column pair as its own route would change the geometry boundary and is not included here.
