import type { ConceptualVisualProjection } from "../../domain/conceptual/visual-projection";
import type { PositionedGeometry } from "../../layout/geometry-input";
import type { SemanticChange } from "../../domain/diff/resource-diff";

const xml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);

export function renderConceptualSvg(projection: ConceptualVisualProjection, geometry: PositionedGeometry, changes: SemanticChange[] = [], side: "base" | "proposed" = "proposed"): string {
  const changeByVisualId = new Map<string, SemanticChange>();
  for (const change of changes) {
    const id = change.entity === "concept" ? projection.visualIdByConceptId[change.identity] : change.entity === "relationship" ? projection.visualIdByRelationshipId[change.identity] : undefined;
    if (id) changeByVisualId.set(id, change);
  }
  const itemProjection = new Map(projection.items.map(item => [item.visualId, item]));
  const connectionProjection = new Map(projection.connections.map(item => [item.visualId, item]));
  const paths = geometry.connections.map(connection => {
    const visual = connectionProjection.get(connection.id);
    if (!visual || connection.points.length < 2) return "";
    const change = changeByVisualId.get(connection.id);
    const d = connection.points.map((p, index) => `${index ? "L" : "M"}${p.x},${p.y}`).join(" ");
    const label = connection.label ? `<text class="conceptual__edge-label" x="${connection.label.x + connection.label.width / 2}" y="${connection.label.y + connection.label.height / 2}" text-anchor="middle" dominant-baseline="middle">${connection.label.text.split("\n").map((line, index) => `<tspan x="${connection.label!.x + connection.label!.width / 2}" dy="${index ? 16 : 0}">${xml(line)}</tspan>`).join("")}</text>` : "";
    return `<g class="conceptual__connection${visual.direction === "undirected" ? " conceptual__connection--undirected" : ""}${change ? ` review-change review-change--${change.kind}` : ""}" data-edge-id="${xml(visual.semanticRelationshipId)}"${change ? ` data-review-change="${xml(change.entity)}:${xml(change.identity)}"` : ""}><path d="${d}" fill="none" stroke="currentColor" stroke-width="2"${visual.direction === "directed" ? ` marker-end="url(#conceptual-arrow-${side})"` : ""}/>${label}</g>`;
  }).join("");
  const nodes = geometry.items.map(bounds => {
    const item = itemProjection.get(bounds.id);
    if (!item) return "";
    const change = changeByVisualId.get(item.visualId);
    const title = [item.name, item.description].filter(Boolean).join(". ");
    const lines = item.nameLines.map((line, index) => `<tspan x="${bounds.x + bounds.requiredWidth / 2}" dy="${index ? 19 : 0}">${xml(line)}</tspan>`).join("");
    const description = item.descriptionLines.map((line, index) => `<tspan x="${bounds.x + bounds.requiredWidth / 2}" dy="${index ? 16 : 0}">${xml(line)}</tspan>`).join("");
    const descriptionY = bounds.y + 27 + item.nameLines.length * 19 + 12;
     return `<g class="conceptual__concept${change ? ` review-change review-change--${change.kind}` : ""}" data-node-id="${xml(item.semanticConceptId)}" data-concept-id="${xml(item.semanticConceptId)}" tabindex="0" role="button" aria-label="${xml(title)}"${change ? ` data-review-change="${xml(change.entity)}:${xml(change.identity)}"` : ""}><rect x="${bounds.x}" y="${bounds.y}" width="${bounds.requiredWidth}" height="${bounds.requiredHeight}" rx="8"/><text class="conceptual__name" x="${bounds.x + bounds.requiredWidth / 2}" y="${bounds.y + 27}" text-anchor="middle">${lines}</text>${description ? `<text class="conceptual__description" x="${bounds.x + bounds.requiredWidth / 2}" y="${descriptionY}" text-anchor="middle">${description}</text>` : ""}<title>${xml(title)}</title></g>`;
  }).join("");
   return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${geometry.width} ${geometry.height}" role="group" aria-label="Conceptual model"><style>.conceptual__concept{color:var(--text,#202634);cursor:pointer}.conceptual__concept rect{fill:var(--bg-panel,#fff);stroke:var(--border-strong,#303a50);stroke-width:1.5}.conceptual__name,.conceptual__edge-label{fill:var(--text,#202634);font:600 16px system-ui,sans-serif}.conceptual__description{fill:var(--text-muted,#5b6478);font:13px system-ui,sans-serif}.conceptual__connection{color:var(--text-muted,#5b6478)}.conceptual__connection path{vector-effect:non-scaling-stroke}.conceptual__concept:focus rect{stroke:var(--accent,#6ca9ff);stroke-width:3}</style><defs><marker id="conceptual-arrow-${side}" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="currentColor"/></marker></defs>${paths}${nodes}</svg>`;
}
