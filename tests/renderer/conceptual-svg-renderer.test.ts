import { describe, expect, it } from "vitest";
import { projectConceptual } from "../../src/domain/conceptual/visual-projection";
import { parseConceptual } from "../../src/language/conceptual/analyze";
import { layoutGeometry } from "../../src/layout/elk-geometry-adapter";
import { renderConceptualSvg } from "../../src/renderer/svg/conceptual-svg-renderer";

describe("Conceptual SVG renderer", () => {
  it("escapes authored text and decorates semantic identities", async () => {
    const parsed = parseConceptual('concept customer "R&D <Buyer>"\nconcept order "Order"\nrelation places customer -> order "creates & owns"');
    const projection = projectConceptual(parsed.model!);
    const geometry = await layoutGeometry(projection.geometry);
    const svg = renderConceptualSvg(projection, geometry, [{ kind: "modified", entity: "concept", identity: "customer" }]);
    expect(svg).toContain("R&amp;D &lt;Buyer&gt;");
    expect(svg).toContain('data-node-id="customer"');
    expect(svg).toContain('data-review-change="concept:customer"');
    expect(svg).toContain('marker-end="url(#conceptual-arrow-proposed)"');
  });
});
