# D02.6 — Conceptual real-world layout/readability investigation

**Status:** investigated and corrected. The regression used the real MY WORK source during diagnosis; private project source and IDs are not retained in this document or automated fixtures.

## Finding

The viewport fit and renderer bounds were correct. The original shared geometry profile used ELK layered RIGHT/ORTHOGONAL for both artifacts. On the observed Conceptual graph, long one-line relationship labels (up to 442 px by the deterministic estimate) combined with that layering to produce an extremely wide geometry. The minimum viewport zoom was a downstream symptom, not the cause. Edge routes and labels were inside ELK's returned canvas bounds; no renderer bounds correction or viewport zoom change was needed.

The correction wraps labels only in `ConceptualVisualProjection` and renders all wrapped lines. It does not change authored text, semantic relationships, IDs or source. Conceptual selects a DOWN/compact geometry profile; Database continues to select the existing default profile.

## Measurements

Fit estimates use an 800 × 600 viewport with the existing 32 px padding. Aspect ratio is the larger of width/height and height/width. Percentages are observations for these inputs and this viewport, not UX SLAs or global layout invariants.

| Input | Before: geometry / aspect / fit | After: geometry / aspect / fit |
|---|---|---|
| Real MY WORK artifact, 15 concepts / 15 relationships; 9 directed, 6 undirected; no self-relations or parallel edges | 2813.6 × 531.3 / 5.30:1 / 26.2% | 1085.7 × 1230 / 1.13:1 / 43.6% |
| Structural regression, 15 concepts / 15 mixed-direction relationships, cycles and long labels | 3640.8 × 531.3 / 6.85:1 / 20.2% | 1196.8 × 1324 / 1.11:1 / 40.5% |

The real artifact's maximum estimated edge-label width changed from 442 px to 218 px. The structural fixture compares new geometry against the legacy RIGHT profile and single-line labels; it checks relative improvement and determinism, not a fixed fit percentage. A smaller viewport or a materially different graph can produce a different fit and must be evaluated in context.

## Architectural conclusion

Conceptual and Database share the geometry/layout boundary and can share the same engine. Sharing that boundary does not require one strategy: each artifact projection may select a layout profile appropriate to its visual characteristics. Conceptual label wrapping remains projection/rendering policy; the geometry adapter remains semantics-free. Database retains its existing geometry input and layout policy.

The pipeline remains:

```text
ConceptualModel -> ConceptualVisualProjection -> GeometryInput
  -> semantics-free geometry/layout adapter -> PositionedGeometry -> SVG -> viewport fit
DatabaseModel -> DatabaseVisualProjection -> GeometryInput
  -> semantics-free geometry/layout adapter (default profile) -> PositionedGeometry
```

Regression coverage checks a structural 15-concept/15-relationship case with cycles, mixed directions and long labels; preservation of the complete multilined label text; determinism of the Conceptual profile; and unchanged Database default-profile output. No source or relationships from the real artifact were modified.
