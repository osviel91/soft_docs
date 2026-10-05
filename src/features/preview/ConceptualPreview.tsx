import { useEffect, useMemo, useState } from "react";
import { parseConceptual } from "../../language/conceptual/analyze";
import { projectConceptual } from "../../domain/conceptual/visual-projection";
import { layoutGeometry } from "../../layout/elk-geometry-adapter";
import type { PositionedGeometry } from "../../layout/geometry-input";
import type { SemanticChange } from "../../domain/diff/resource-diff";
import { renderConceptualSvg } from "../../renderer/svg/conceptual-svg-renderer";
import DiagramViewport, { type DiagramViewportTransform } from "./DiagramViewport";
import DiagramGuidance from "./DiagramGuidance";

export interface ConceptualPreviewProps {
  source: string;
  onNodeSelect?: (conceptId: string) => void;
  activeNodeId?: string | null;
  reviewChanges?: SemanticChange[];
  reviewSide?: "base" | "proposed";
  reviewMode?: boolean;
  linkedTransform?: DiagramViewportTransform | null;
  onTransformChange?: (transform: DiagramViewportTransform) => void;
  activeReviewChange?: string | null;
  focusReviewChange?: string | null;
  comparisonMode?: boolean;
}

export default function ConceptualPreview({
  source, onNodeSelect, activeNodeId = null, reviewChanges = [], reviewSide = "proposed",
  reviewMode = false, linkedTransform = null, onTransformChange, activeReviewChange = null,
  focusReviewChange = null, comparisonMode = false,
}: ConceptualPreviewProps) {
  const parsed = useMemo(() => parseConceptual(source), [source]);
  const projection = useMemo(() => parsed.model ? projectConceptual(parsed.model) : null, [parsed.model]);
  const [layout, setLayout] = useState<PositionedGeometry | null>(null);
  const [layoutError, setLayoutError] = useState(false);

  useEffect(() => {
    let current = true;
    setLayout(null);
    setLayoutError(false);
    if (!projection) return () => { current = false; };
    void layoutGeometry(projection.geometry, "conceptual").then(
      result => { if (current) setLayout(result); },
      () => { if (current) setLayoutError(true); },
    );
    return () => { current = false; };
  }, [projection]);

  const invalid = !parsed.model || parsed.diagnostics.some(({ severity }) => severity === "error");
  if (invalid) return <div className="conceptual-preview" data-testid="conceptual-preview-invalid" role="status">
    <DiagramGuidance view="conceptual" comparison={comparisonMode} diffDecorations={reviewChanges.length > 0} />
    <p>Conceptual source has errors. Fix the diagnostics to render this model.</p>
  </div>;
  if (layoutError) return <div className="conceptual-preview" role="alert">The Conceptual layout could not be calculated. The source is still available for editing.</div>;
  if (!projection || !layout) return <div className="conceptual-preview" aria-busy="true" role="status">Laying out Conceptual model…</div>;

  return <div className="conceptual-preview" data-testid="conceptual-preview">
    <div className="sequence-guidance-toolbar"><DiagramGuidance view="conceptual" comparison={comparisonMode} diffDecorations={reviewChanges.length > 0} /></div>
    <DiagramViewport
      svg={renderConceptualSvg(projection, layout, reviewChanges, reviewSide)}
      size={{ width: layout.width, height: layout.height }}
      svgTestId="conceptual-preview-svg"
      onNodeSelect={onNodeSelect}
      activeNodeId={activeNodeId}
      reviewMode={reviewMode}
      linkedTransform={linkedTransform}
      onTransformChange={onTransformChange}
      activeReviewChange={activeReviewChange}
      focusReviewChange={focusReviewChange}
    />
  </div>;
}
