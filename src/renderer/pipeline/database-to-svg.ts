import { projectDatabase } from "../../domain/database/visual-projection";
import { parseDatabase } from "../../language/database/analyze";
import { layoutGeometry } from "../../layout/elk-geometry-adapter";
import { renderDatabaseSvg } from "../svg/database-svg-renderer";

export interface DatabaseDocument {
  svg: string;
  width: number;
  height: number;
}

export interface DatabaseRenderOptions {
  theme?: "light" | "dark";
  background?: string;
  padding?: number;
  includeTitle?: boolean;
}

const PALETTES = {
  light: { text: "#202634", background: "#ffffff", panel: "#ffffff", border: "#d5d9e2", borderStrong: "#303a50", muted: "#5b6478" },
  dark: { text: "#e7ebf3", background: "#0e121b", panel: "#141926", border: "#232b3d", borderStrong: "#303a50", muted: "#8d96ac" },
};

const escapeXml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);

export async function databaseSourceToSvgDocument(
  source: string,
  options: DatabaseRenderOptions = {},
): Promise<DatabaseDocument | null> {
  const { model, diagnostics } = parseDatabase(source);
  if (!model || diagnostics.some(({ severity }) => severity === "error")) return null;

  const projection = projectDatabase(model);
  const positioned = await layoutGeometry(projection.geometry, "database");
  const palette = PALETTES[options.theme === "dark" ? "dark" : "light"];
  const background = options.background ?? "white";
  const canvas = background === "white" ? palette.background : background;
  const padding = options.padding !== undefined && Number.isFinite(options.padding) && options.padding > 0 ? options.padding : 0;
  const title = options.includeTitle === false ? "" : model.title ?? "";
  const titleHeight = title ? 36 : 0;
  const width = Math.max(1, positioned.width + padding * 2);
  const height = Math.max(1, positioned.height + padding * 2 + titleHeight);
  const geometry = { ...positioned, width, height };
  let svg = renderDatabaseSvg(projection, geometry).replace(
    /^<svg\b/,
    `<svg width="${width}" height="${height}" style="--text:${palette.text};--bg:${escapeXml(background === "transparent" ? "transparent" : canvas)};--bg-panel:${palette.panel};--panel:${palette.panel};--border:${palette.border};--border-strong:${palette.borderStrong};--muted:${palette.muted};--text-muted:${palette.muted}"`,
  );
  const backgroundRect = background === "transparent" ? "" : `<rect width="${width}" height="${height}" fill="${escapeXml(canvas)}"/>`;
  const titleMarkup = title ? `<text x="${padding}" y="${padding + 24}" fill="${palette.text}" font-family="system-ui, sans-serif" font-size="20" font-weight="600">${escapeXml(title)}</text>` : "";
  svg = svg.replace("</defs>", `</defs>${backgroundRect}${titleMarkup}<g transform="translate(${padding}, ${padding + titleHeight})">`);
  svg = svg.replace(/<\/svg>$/, "</g></svg>");
  return { svg, width, height };
}
