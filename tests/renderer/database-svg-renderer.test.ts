import { describe, expect, it } from "vitest";
import { parseDatabase } from "../../src/language/database/analyze";
import { projectDatabase } from "../../src/domain/database/visual-projection";
import { layoutGeometry } from "../../src/layout/elk-geometry-adapter";
import { renderDatabaseSvg } from "../../src/renderer/svg/database-svg-renderer";

describe("Database SVG renderer", () => {
  it("accepts the canonical schema/table/FK fixture used by governed workflows", () => {
    const source = [
      'title "Billing schema"', 'schema billing "billing"',
      'table customer billing "Customer"', 'column customer customer_id "id" {uuid} not-null', 'primary-key customer_pk customer (id)',
      'table invoice billing "Invoice"', 'column invoice invoice_id "id" {uuid} not-null', 'column invoice invoice_customer_id "customer_id" {uuid} not-null',
      'primary-key invoice_pk invoice (id)', 'foreign-key invoice_customer invoice (customer_id) -> customer (id)',
    ].join("\n");
    const parsed = parseDatabase(source);
    expect(parsed.model?.tables.map(table => table.name)).toEqual(["Customer", "Invoice"]);
    expect(parsed.diagnostics.filter(item => item.severity === "error")).toHaveLength(0);
  });

  it("renders ordered schema-qualified rows, authored details and distinct row-attached FK routes", async () => {
    const source = `schema billing "billing"\ntable invoice - "Invoice"\ncolumn invoice invoice_id "id" {uuid} not-null\ncolumn invoice customer_ref "customer_id" {uuid} not-null default {gen()}\nprimary-key invoice_pk invoice (id)\ntable customer billing "Customer"\ncolumn customer customer_id "id" {uuid} not-null\nprimary-key customer_pk customer (id)\nforeign-key billing_customer invoice (customer_id) -> customer (id)`;
    const parsed = parseDatabase(source);
    expect(parsed.diagnostics.filter(item => item.severity === "error")).toHaveLength(0);
    const projection = projectDatabase(parsed.model!);
    const layout = await layoutGeometry(projection.geometry);
    const svg = renderDatabaseSvg(projection, layout);
    expect(svg).toContain("billing.Customer");
    expect(svg.indexOf("customer_id")).toBeGreaterThan(svg.indexOf("id"));
    expect(svg).toContain("uuid");
    expect(svg).toContain("PK");
    expect(svg).toContain("NOT NULL");
    expect(svg).toContain('data-edge-id="billing_customer"');
    expect(svg).toContain("customer_id → id");
    expect(svg).toContain("default gen()");
  });

  it("escapes unicode and marks selected tables without treating selection as a diff", async () => {
    const parsed = parseDatabase('table snow - "雪"\ncolumn snow - "列" {text} nullable');
    const projection = projectDatabase(parsed.model!);
    const layout = await layoutGeometry(projection.geometry);
    const svg = renderDatabaseSvg(projection, layout, [], "snow");
    expect(svg).toContain("雪");
    expect(svg).toContain("列");
    expect(svg).toContain('aria-pressed="true"');
    expect(svg).not.toContain("review-change review-change--");
  });

  it("keeps self, parallel, and ordered composite foreign keys individually understandable", async () => {
    const source = [
      'table employee - "Employee"',
      'column employee tenant "tenant_id" {uuid} not-null',
      'column employee id "id" {uuid} not-null',
      'column employee manager_tenant "manager_tenant_id" {uuid} nullable',
      'column employee manager_id "manager_id" {uuid} nullable',
      'primary-key employee_pk employee (tenant_id, id)',
      'foreign-key manager_fk employee (manager_tenant_id, manager_id) -> employee (tenant_id, id)',
      'foreign-key mentor_fk employee (manager_tenant_id, manager_id) -> employee (tenant_id, id)',
    ].join("\n");
    const parsed = parseDatabase(source);
    expect(parsed.diagnostics.filter(item => item.severity === "error")).toHaveLength(0);
    const projection = projectDatabase(parsed.model!);
    const layout = await layoutGeometry(projection.geometry);
    const svg = renderDatabaseSvg(projection, layout);
    expect(svg.match(/data-edge-id="(?:manager_fk|mentor_fk)"/g)).toHaveLength(2);
    expect(svg).toContain("manager_tenant_id → tenant_id, manager_id → id");
    expect(svg).toContain("primary key (tenant_id, id)");
    expect(svg.indexOf('data-edge-id="manager_fk"')).toBeGreaterThan(svg.indexOf('data-node-id="employee"'));
    expect(svg).toContain("marker-end=\"url(#database-arrow)\"");
    expect(svg).not.toMatch(/crow|cardinality|many-to-one|one-to-many/i);
  });
});
