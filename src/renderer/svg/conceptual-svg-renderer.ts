import type { ConceptualVisualProjection } from "../../domain/conceptual/visual-projection";
import type { PositionedGeometry } from "../../layout/geometry-input";
import type { SemanticChange } from "../../domain/diff/resource-diff";
import { CONCEPTUAL_SVG_STYLE } from "./conceptual-svg-style";

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
    const label = connection.label ? `<g class="conceptual__edge-label" data-label-for="${xml(visual.semanticRelationshipId)}"><rect x="${connection.label.x}" y="${connection.label.y}" width="${connection.label.width}" height="${connection.label.height}"/><text x="${connection.label.x + connection.label.width / 2}" y="${connection.label.y + (connection.label.height - connection.label.text.split("\n").length * 16) / 2 + 14}" text-anchor="middle">${connection.label.text.split("\n").map((line, index) => `<tspan x="${connection.label!.x + connection.label!.width / 2}" dy="${index ? 16 : 0}">${xml(line)}</tspan>`).join("")}</text></g>` : "";
    return `<g class="conceptual__connection${visual.direction === "undirected" ? " conceptual__connection--undirected" : ""}${change ? ` review-change review-change--${change.kind}` : ""}" data-edge-id="${xml(visual.semanticRelationshipId)}" data-source-concept-id="${xml(projection.items.find(item => item.visualId === visual.sourceVisualId)?.semanticConceptId ?? "")}" data-target-concept-id="${xml(projection.items.find(item => item.visualId === visual.targetVisualId)?.semanticConceptId ?? "")}"${change ? ` data-review-change="${xml(change.entity)}:${xml(change.identity)}"` : ""}><path d="${d}" fill="none" stroke="currentColor" stroke-width="2"${visual.direction === "directed" ? ` marker-end="url(#conceptual-arrow-${side})"` : ""}/>${label}</g>`;
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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${geometry.width} ${geometry.height}" role="group" aria-label="Conceptual model"><style>${CONCEPTUAL_SVG_STYLE}</style><defs><marker id="conceptual-arrow-${side}" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="currentColor"/></marker></defs>${paths}${nodes}</svg>`;
}

export function renderConceptualNotationSample(): string {
  const concept = (y: number) => `<g class="conceptual__concept"><rect x="80" y="${y}" width="82" height="28" rx="8"/><text class="conceptual__name" x="121" y="${y + 20}" text-anchor="middle">Concept</text></g><g class="conceptual__concept"><rect x="338" y="${y}" width="82" height="28" rx="8"/><text class="conceptual__name" x="379" y="${y + 20}" text-anchor="middle">Concept</text></g>`;
  const relation = (y: number, id: string, directed: boolean) => `<g class="conceptual__connection${directed ? "" : " conceptual__connection--undirected"}" data-edge-id="${id}"><path d="M162,${y} L338,${y}" fill="none" stroke="currentColor" stroke-width="2.25"${directed ? ' marker-end="url(#conceptual-arrow-sample)"' : ""}/><g class="conceptual__edge-label" data-label-for="${id}"><rect x="195" y="${y - 11}" width="110" height="22"/><text x="250" y="${y + 4}" text-anchor="middle">relationship</text></g></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 424 92" role="img" aria-label="Concept, directed relationship, Concept; Concept, undirected relationship, Concept"><style>${CONCEPTUAL_SVG_STYLE}</style><defs><marker id="conceptual-arrow-sample" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="currentColor"/></marker></defs><text class="conceptual__key-caption" x="4" y="25">Directed</text>${relation(22, "sample-directed", true)}${concept(8)}<text class="conceptual__key-caption" x="4" y="73">Undirected</text>${relation(70, "sample-undirected", false)}${concept(56)}</svg>`;
}
