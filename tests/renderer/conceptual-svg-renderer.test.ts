import { describe, expect, it } from "vitest";
import { projectConceptual } from "../../src/domain/conceptual/visual-projection";
import { parseConceptual } from "../../src/language/conceptual/analyze";
import { layoutGeometry } from "../../src/layout/elk-geometry-adapter";
import { renderConceptualNotationSample, renderConceptualSvg } from "../../src/renderer/svg/conceptual-svg-renderer";
import { estimateTextWidth } from "../../src/layout/text";

describe("Conceptual SVG renderer", () => {
  it("escapes authored text and decorates semantic identities", async () => {
    const parsed = parseConceptual('concept customer "R&D <Buyer>"\nconcept order "Order"\nrelation places customer -> order "creates & owns"');
    const projection = projectConceptual(parsed.model!);
    const geometry = await layoutGeometry(projection.geometry, "conceptual");
    const svg = renderConceptualSvg(projection, geometry, [{ kind: "modified", entity: "concept", identity: "customer" }]);
    expect(svg).toContain("R&amp;D &lt;Buyer&gt;");
    expect(svg).toContain('data-node-id="customer"');
    expect(svg).toContain('data-review-change="concept:customer"');
    expect(svg).toContain('marker-end="url(#conceptual-arrow-proposed)"');
  });

  it("renders every wrapped relationship-label line without changing its text", async () => {
    const label = "relationship label that preserves every authored word across multiple rendered lines";
    const parsed = parseConceptual(`concept source "Source"\nconcept target "Target"\nrelation link source -> target "${label}"`);
    const projection = projectConceptual(parsed.model!);
    const geometry = await layoutGeometry(projection.geometry, "conceptual");
    const svg = renderConceptualSvg(projection, geometry);
    const lines = geometry.connections[0]!.label!.text.split("\n");
    const widestLine = lines.reduce((widest, line) => estimateTextWidth(line, 12) > estimateTextWidth(widest, 12) ? line : widest, "");

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe(label);
    for (const line of lines) expect(svg).toContain(`>${line}</tspan>`);
    expect(projection.connections[0]!.label).toBe(label);
    expect(estimateTextWidth(widestLine, 12)).toBeLessThanOrEqual(220);
    expect(geometry.connections[0]!.label!.width).toBeGreaterThanOrEqual(estimateTextWidth(widestLine, 12) + 12);
    expect(svg).toContain(`data-label-for="link"`);
    expect(svg).toContain(`data-edge-id="link"`);
    expect(svg.match(/<rect x=/g)).toHaveLength(3);
    expect(svg).not.toContain('rx="4"');
    expect(svg.indexOf('class="conceptual__edge-label"')).toBeGreaterThan(svg.indexOf("<path d="));
  });

  it("gives Concepts and route labels distinct visual roles", async () => {
    const model = parseConceptual('concept source "Initiator"\nconcept target "Shared Record"\nrelation update source -> target "changes durable project knowledge"').model!;
    const projection = projectConceptual(model);
    const geometry = await layoutGeometry(projection.geometry, "conceptual");
    const svg = renderConceptualSvg(projection, geometry);
    const style = svg.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    const sample = renderConceptualNotationSample();
    const conceptRectStyle = style.match(/\.conceptual__concept rect\s*\{[^}]+\}/)?.[0] ?? "";
    const labelRectStyle = style.match(/\.conceptual__edge-label rect\s*\{[^}]+\}/)?.[0] ?? "";
    const labelTextStyle = style.match(/\.conceptual__edge-label text\s*\{[^}]+\}/)?.[0] ?? "";

    expect(conceptRectStyle).toContain("--bg-panel");
    expect(conceptRectStyle).toContain("stroke: var(--border-strong");
    expect(labelRectStyle).toContain("fill: var(--bg,");
    expect(labelRectStyle).toContain("stroke: none");
    expect(labelTextStyle).toContain("fill: currentColor");
    expect(labelTextStyle).toContain("font: 500 12px");
    expect(style).toContain("font: 600 16px");
    expect(style).toContain(".conceptual__connection--related { color: var(--accent-strong");
    expect(sample.match(/class="conceptual__concept"/g)).toHaveLength(4);
    expect(sample.match(/class="conceptual__edge-label"/g)).toHaveLength(2);
    expect(sample).toContain('data-edge-id="sample-directed"');
    expect(sample).toContain('marker-end="url(#conceptual-arrow-sample)"');
    expect(sample).toContain('class="conceptual__connection conceptual__connection--undirected"');
    expect(sample).toContain('data-edge-id="sample-undirected"');
    expect(sample).not.toMatch(/data-edge-id="sample-undirected"[\s\S]*?marker-end=/);
    expect(sample.match(/<style>([\s\S]*?)<\/style>/)?.[1]).toBe(style);
    expect(svg).toContain("changes durable project knowledge");
  });

  it("keeps parallel and self relationships independently identified and directional", async () => {
    const model = parseConceptual('concept node "Node"\nconcept neighbor "Neighbor"\nconcept island "Island"\nrelation self node -> node "loops back"\nrelation first node -> neighbor "first link"\nrelation second node -- neighbor "second link"').model!;
    const projection = projectConceptual(model);
    const geometry = await layoutGeometry(projection.geometry, "conceptual");
    const svg = renderConceptualSvg(projection, geometry);

    expect(geometry.connections.map(connection => connection.id)).toEqual(projection.connections.map(connection => connection.visualId));
    expect(svg.match(/data-edge-id=/g)).toHaveLength(3);
    expect(svg).toContain('data-concept-id="island"');
    expect(svg.match(/data-label-for=/g)).toHaveLength(3);
    expect(svg.match(/marker-end=/g)).toHaveLength(2);
    expect(new Set(geometry.connections.map(connection => JSON.stringify(connection.points))).size).toBe(3);
    expect(svg).toContain('data-edge-id="self"');
    expect(svg).toContain('data-edge-id="first"');
    expect(svg).toContain('data-edge-id="second"');
    expect(svg).toContain("var(--muted, #5b6472)");
    expect(svg).toContain("var(--text-muted, var(--muted, #5b6472))");
  });
});
