import type { CausalViewModel } from "../../domain/eventflow/causal-projection";
import { causalTextLines, type CausalFlowGraph } from "./causal-flow-adapter";

export function renderCausalFlowSvg(graph: CausalFlowGraph, view: CausalViewModel, options: { background?: string; includeTitle?: boolean; padding?: number } = {}): { svg: string; width: number; height: number } {
  const padding = Math.max(0, options.padding ?? 28);
  const width = graph.width + padding * 2;
  const height = graph.height + padding * 2 + (options.includeTitle === false ? 0 : 28);
  const shiftY = options.includeTitle === false ? padding : padding + 28;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Causal event flow" font-family="Inter, system-ui, sans-serif">`, `<rect width="100%" height="100%" fill="${esc(options.background ?? "#ffffff")}"/>`];
  if (options.includeTitle !== false && view.title) parts.push(`<text x="${padding}" y="${padding + 16}" fill="#0f172a" font-size="16" font-weight="700">${esc(view.title)}</text>`);
  for (const edge of graph.edges) {
    const edgeData = edge.data;
    if (!edgeData) continue;
    const points = edgeData.points ?? [];
    if (points.length < 2) continue;
    const dashed = edgeData.causalType === "HANDLER_HAS_EFFECT" || edgeData.causalType === "FAILURE_RETRIED" || edgeData.causalType.startsWith("RETRY_");
    const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x + padding} ${point.y + shiftY}`).join(" ");
    parts.push(`<path d="${path}" fill="none" stroke="${edgeColor(edgeData.causalType)}" stroke-width="2"${dashed ? " stroke-dasharray=\"5 4\"" : ""} marker-end="url(#causal-arrow)"/>`);
  }
  parts.push(`<defs><marker id="causal-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#64748b"/></marker></defs>`);
  for (const node of graph.nodes) {
    const fill = node.data.kind === "message" ? "#eef2ff" : node.data.kind === "handler" ? "#ecfdf5" : node.data.kind === "effect" ? "#fff7ed" : "#fff1f2";
    const accent = node.data.kind === "message" ? "#4338ca" : node.data.kind === "handler" ? "#0f766e" : node.data.kind === "effect" ? "#9a3412" : "#be123c";
    const x = node.position.x + padding;
    const y = node.position.y + shiftY;
    parts.push(`<rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="10" fill="${fill}" stroke="${accent}" stroke-width="1.5"/>`);
    parts.push(`<text x="${x + 12}" y="${y + 18}" fill="#475569" font-size="9" font-weight="700" letter-spacing="1">${esc(node.data.kind.toUpperCase())}</text>`);
    parts.push(`<text x="${x + 12}" y="${y + 38}" fill="#0f172a" font-size="13">${causalTextLines(node.data.label, node.width ?? 140).map((line, index) => `<tspan x="${x + 12}" dy="${index === 0 ? 0 : 18}">${esc(line)}</tspan>`).join("")}</text>`);
  }
  parts.push("</svg>");
  return { svg: parts.join(""), width, height };
}

function edgeColor(type: string): string { return type === "HANDLER_HAS_EFFECT" ? "#b45309" : type === "ENTITY_FAILED" || type === "FAILURE_RETRIED" || type.startsWith("RETRY_") ? "#be123c" : "#64748b"; }
function esc(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
