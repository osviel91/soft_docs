import type { CausalViewModel } from "../../domain/eventflow/causal-projection";
import { causalTextLines, type CausalFlowGraph } from "./causal-flow-adapter";

export function renderCausalFlowSvg(graph: CausalFlowGraph, view: CausalViewModel, options: { background?: string; includeTitle?: boolean; padding?: number } = {}): { svg: string; width: number; height: number } {
  const padding = Math.max(0, options.padding ?? 28);
  const width = graph.width + padding * 2;
  const height = graph.height + padding * 2 + (options.includeTitle === false ? 0 : 28);
  const shiftY = options.includeTitle === false ? padding : padding + 28;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Causal event flow" font-family="Inter, system-ui, sans-serif">`, `<rect width="100%" height="100%" fill="${esc(options.background ?? "#ffffff")}"/>`];
  if (options.includeTitle !== false && view.title) parts.push(`<text x="${padding}" y="${padding + 16}" fill="#0f172a" font-size="16" font-weight="700">${esc(view.title)}</text>`);
  const nodeLabels = new Map(graph.nodes.map((node) => [node.id, node.data.label]));
  for (const edge of graph.edges) {
    const edgeData = edge.data;
    if (!edgeData) continue;
    const dashed = edgeData.causalType === "HANDLER_HAS_EFFECT" || edgeData.causalType === "FAILURE_RETRIED" || edgeData.causalType.startsWith("RETRY_");
    const sourceLabel = nodeLabels.get(edge.source) ?? edge.source;
    const targetLabel = nodeLabels.get(edge.target) ?? edge.target;
    const edgeLabel = `${edgeData.causalType.replaceAll("_", " ")}: ${sourceLabel} to ${targetLabel}`;
    for (const [index, route] of edgeData.routes.entries()) {
      if (route.points.length < 2) continue;
      const description = `${edgeLabel}, segment ${index + 1} of ${edgeData.routes.length}${route.endsAtTarget ? " (reaches target)" : " (continuation)"}${route.fallback ? " (fallback route)" : ""}`;
      const path = route.points.map((point, pointIndex) => `${pointIndex === 0 ? "M" : "L"}${point.x + padding} ${point.y + shiftY}`).join(" ");
      const stroke = route.fallback ? "#7c3aed" : edgeColor(edgeData.causalType);
      const strokeDash = route.fallback ? "3 3" : dashed ? "5 4" : undefined;
      parts.push(`<path data-causal-edge="${esc(edge.id)}" data-route="${esc(route.id)}" d="${path}" fill="none" stroke="${stroke}" stroke-width="2"${strokeDash ? ` stroke-dasharray="${strokeDash}"` : ""}${route.endsAtTarget ? " marker-end=\"url(#causal-arrow)\"" : ""} aria-label="${esc(description)}"><title>${esc(description)}</title></path>`);
    }
  }
  parts.push(`<defs><marker id="causal-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#64748b"/></marker></defs>`);
  for (const node of graph.nodes) {
    const fill = node.data.kind === "message" ? "#eef2ff" : node.data.kind === "handler" ? "#ecfdf5" : node.data.kind === "effect" ? "#fff7ed" : "#fff1f2";
    const accent = node.data.kind === "message" ? "#4338ca" : node.data.kind === "handler" ? "#0f766e" : node.data.kind === "effect" ? "#9a3412" : "#be123c";
    const x = node.position.x + padding;
    const y = node.position.y + shiftY;
    parts.push(`<rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="10" fill="${fill}" stroke="${accent}" stroke-width="1.5"/>`);
    const kind = `${node.data.kind}${node.data.messageKind ? ` · ${node.data.messageKind}` : ""}`.toUpperCase();
    parts.push(`<text x="${x + 12}" y="${y + 18}" fill="#475569" font-size="9" font-weight="700" letter-spacing="1">${esc(kind)}</text>`);
    const labelLines = node.data.labelLines ?? causalTextLines(node.data.label, node.width ?? 140);
    const fontSize = node.data.labelFontSize ?? 13;
    parts.push(`<text x="${x + 12}" y="${y + 38}" fill="#0f172a" font-size="${fontSize}" aria-label="${esc(node.data.label)}"><title>${esc(node.data.label)}</title>${labelLines.map((line, index) => `<tspan x="${x + 12}" dy="${index === 0 ? 0 : fontSize * 1.25}">${esc(line)}</tspan>`).join("")}</text>`);
    if (node.data.owner) {
      const owner = `owned by ${node.data.owner.replace("handler:", "")}`;
      const ownerLines = node.data.ownerLines ?? causalTextLines(owner, node.width ?? 140, (node.data.ownerFontSize ?? 10) * 0.55);
      const ownerFontSize = node.data.ownerFontSize ?? 10;
      const ownerY = y + 38 + labelLines.length * fontSize * 1.25 + 5 + ownerFontSize * 0.8;
      parts.push(`<text x="${x + 12}" y="${ownerY}" fill="#334155" font-size="${ownerFontSize}" aria-label="${esc(owner)}"><title>${esc(owner)}</title>${ownerLines.map((line, index) => `<tspan x="${x + 12}" dy="${index === 0 ? 0 : ownerFontSize * 1.3}">${esc(line)}</tspan>`).join("")}</text>`);
    }
  }
  parts.push("</svg>");
  return { svg: parts.join(""), width, height };
}

function edgeColor(type: string): string { return type === "HANDLER_HAS_EFFECT" ? "#b45309" : type === "ENTITY_FAILED" || type === "FAILURE_RETRIED" || type.startsWith("RETRY_") ? "#be123c" : "#64748b"; }
function esc(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
