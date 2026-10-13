import { describe, expect, it } from "vitest";
import { conceptualSourceToSvgDocument } from "../../src/renderer/pipeline/conceptual-to-svg";

describe("conceptualSourceToSvgDocument", () => {
  it("renders concepts, relationship labels and standalone SVG dimensions", async () => {
    const document = await conceptualSourceToSvgDocument([
      'title "Commerce"',
      'concept customer "Customer"',
      'concept order "Order"',
      'relation places customer -> order "places orders"',
    ].join("\n"));

    expect(document).not.toBeNull();
    expect(document!.svg).toContain('width="');
    expect(document!.svg).toContain('height="');
    expect(document!.svg).toContain('data-node-id="customer"');
    expect(document!.svg).toContain('data-node-id="order"');
    expect(document!.svg).toContain('data-edge-id="places"');
    expect(document!.svg).toContain("places orders");
  });

  it("returns null for invalid source", async () => {
    await expect(conceptualSourceToSvgDocument('relation places missing -> absent "places"')).resolves.toBeNull();
  });

  it("returns a non-zero empty SVG for a valid model without elements", async () => {
    const document = await conceptualSourceToSvgDocument("");

    expect(document).not.toBeNull();
    expect(document!.width).toBe(1);
    expect(document!.height).toBe(1);
    expect(document!.svg).toContain('viewBox="0 0 1 1"');
    expect(document!.svg).not.toContain('<g class="conceptual__concept');
    expect(document!.svg).not.toContain('<g class="conceptual__connection');
  });

  it("applies export theme, background, padding and title options", async () => {
    const document = await conceptualSourceToSvgDocument('title "Commerce & Orders"\nconcept customer "Customer"', {
      theme: "dark",
      background: "#123456",
      padding: 12,
      includeTitle: true,
    });

    expect(document).not.toBeNull();
    expect(document!.svg).toContain('--text:#e7ebf3');
    expect(document!.svg).toContain('fill="#123456"');
    expect(document!.svg).toContain("translate(12, 48)");
    expect(document!.svg).toContain("Commerce &amp; Orders");

    const withoutTitle = await conceptualSourceToSvgDocument('title "Commerce"\nconcept customer "Customer"', { includeTitle: false });
    expect(withoutTitle!.svg).not.toContain(">Commerce</text>");
  });
});
