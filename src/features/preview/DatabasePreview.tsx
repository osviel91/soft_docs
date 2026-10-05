import { useEffect, useMemo, useState } from "react";
import { parseDatabase } from "../../language/database/analyze";
import { projectDatabase } from "../../domain/database/visual-projection";
import { layoutGeometry } from "../../layout/elk-geometry-adapter";
import type { PositionedGeometry } from "../../layout/geometry-input";
import type { SemanticChange } from "../../domain/diff/resource-diff";
import { renderDatabaseSvg } from "../../renderer/svg/database-svg-renderer";
import DiagramViewport, { type DiagramViewportTransform } from "./DiagramViewport";
import DiagramGuidance from "./DiagramGuidance";

export default function DatabasePreview({ source, onNodeSelect, activeNodeId = null, reviewChanges = [], linkedTransform = null, onTransformChange, reviewMode = false, comparisonMode = false }: {
  source: string; onNodeSelect?: (tableId: string) => void; activeNodeId?: string | null; reviewChanges?: SemanticChange[];
  linkedTransform?: DiagramViewportTransform | null; onTransformChange?: (transform: DiagramViewportTransform) => void; reviewMode?: boolean; comparisonMode?: boolean;
}) {
  const parsed = useMemo(() => parseDatabase(source), [source]);
  const projection = useMemo(() => parsed.model ? projectDatabase(parsed.model) : null, [parsed.model]);
  const [layout, setLayout] = useState<PositionedGeometry | null>(null);
  const [layoutError, setLayoutError] = useState(false);
  useEffect(() => {
    let current = true;
    setLayout(null); setLayoutError(false);
    if (!projection) return () => { current = false; };
    void layoutGeometry(projection.geometry).then(value => { if (current) setLayout(value); }, () => { if (current) setLayoutError(true); });
    return () => { current = false; };
  }, [projection]);
  const invalid = !parsed.model || parsed.diagnostics.some(diagnostic => diagnostic.severity === "error");
  if (invalid) return <div className="database-preview" data-testid="database-preview-invalid" role="status"><DiagramGuidance view="database" comparison={comparisonMode} diffDecorations={reviewChanges.length > 0} /><p>Database source has errors. Fix the diagnostics to render this Database Diagram.</p></div>;
  if (layoutError) return <div className="database-preview" role="alert">Database Diagram layout failed. The source remains available for editing; this does not indicate invalid source.</div>;
  if (!projection || !layout) return <div className="database-preview" aria-busy="true" role="status">Laying out Database Diagram…</div>;
  return <div className="database-preview" data-testid="database-preview"><div className="sequence-guidance-toolbar"><DiagramGuidance view="database" comparison={comparisonMode} diffDecorations={reviewChanges.length > 0} /></div><DiagramViewport svg={renderDatabaseSvg(projection, layout, reviewChanges, activeNodeId)} size={{ width: layout.width, height: layout.height }} svgTestId="database-preview-svg" onNodeSelect={onNodeSelect} activeNodeId={activeNodeId} reviewMode={reviewMode} linkedTransform={linkedTransform} onTransformChange={onTransformChange} /></div>;
}
