import { describe, expect, it } from "vitest";
import { projectConceptual } from "../../src/domain/conceptual/visual-projection";
import { parseConceptual } from "../../src/language/conceptual/analyze";
import { layoutGeometry } from "../../src/layout/elk-geometry-adapter";
import { renderConceptualSvg } from "../../src/renderer/svg/conceptual-svg-renderer";
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
  });
});
