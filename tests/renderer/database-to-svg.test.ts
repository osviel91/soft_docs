import { describe, expect, it } from "vitest";
import { databaseSourceToSvgDocument } from "../../src/renderer/pipeline/database-to-svg";
import { parseDatabase } from "../../src/language/database/analyze";

describe("databaseSourceToSvgDocument", () => {
  it("renders tables, foreign keys and the authored title as a standalone SVG", async () => {
    const source = [
      'title "Stores"',
      'table customers - "Customers"',
      'column customers customer_id "id" {uuid} not-null',
      'primary-key customers_pk customers (id)',
      'table orders - "Orders"',
      'column orders order_id "id" {uuid} not-null',
      'column orders order_customer_id "customer_id" {uuid} not-null',
      'primary-key orders_pk orders (id)',
      'foreign-key orders_customer orders (customer_id) -> customers (id)',
    ].join("\n");
    expect(parseDatabase(source).diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    const document = await databaseSourceToSvgDocument(source);

    expect(document).not.toBeNull();
    expect(document!.svg).toContain('aria-label="Database Diagram"');
    expect(document!.svg).toContain('data-node-id="customers"');
    expect(document!.svg).toContain('data-edge-id="orders_customer"');
    expect(document!.svg).toContain("Stores");
    expect(document!.svg).toContain('markerUnits="userSpaceOnUse"');
    expect(document!.svg).toContain(`width="${document!.width}"`);
    expect(document!.svg).toContain(`height="${document!.height}"`);

    const dark = await databaseSourceToSvgDocument(source, { theme: "dark", background: "#123456", padding: 12, includeTitle: false });
    expect(dark!.svg).toContain('--text:#e7ebf3');
    expect(dark!.svg).toContain('fill="#123456"');
    expect(dark!.svg).toContain("translate(12, 12)");
    expect(dark!.svg).not.toContain(">Stores</text>");
  });

  it("rejects invalid source and gives empty models a non-zero SVG canvas", async () => {
    await expect(databaseSourceToSvgDocument('table broken - "unterminated')).resolves.toBeNull();
    const empty = await databaseSourceToSvgDocument("");
    expect(empty).not.toBeNull();
    expect(empty!.width).toBe(1);
    expect(empty!.height).toBe(1);
  });
});
