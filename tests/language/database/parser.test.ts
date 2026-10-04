import { describe, expect, it } from "vitest";
import { parseDatabase } from "../../../src/language/database/analyze";
import { parseDatabaseSyntax } from "../../../src/language/database/parser";

describe("Database DSL", () => {
  it("preserves opaque types/defaults, optional column IDs, ordered keys and namespaces", () => {
    const result = parseDatabase(`# selected schema\nschema billing "請求"\ntable invoice billing "請求書"\ncolumn invoice invoice_id "id" {uuid} not-null\ncolumn invoice - "amount" {decimal(10,2)} not-null default {ARRAY[]::text[]}\ncolumn invoice - "note" {timestamp with time zone} nullable\nprimary-key invoice_pk invoice (id, amount)\nunique invoice_uq invoice (amount, id)\nindex invoice_ix invoice (amount, id)\nforeign-key self invoice (id, amount) -> invoice (id, amount)\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.model?.schemas[0].name).toBe("請求");
    expect(result.model?.tables[0].columns.map(({ type }) => type)).toEqual(["uuid", "decimal(10,2)", "timestamp with time zone"]);
    expect(result.model?.tables[0].columns[1].default).toBe("ARRAY[]::text[]");
    expect(result.model?.tables[0].columns[1].id).toBeUndefined();
    expect(result.model?.tables[0].primaryKey?.columns).toEqual(["id", "amount"]);
    expect(result.model?.foreignKeys[0].sourceTableId).toBe("invoice");
  });

  it("reports malformed and semantically invalid declarations deterministically", () => {
    const source = 'table source - "Source"\ncolumn source - "id" {uuid} nullable\nprimary-key source_pk source (missing)\nforeign-key bad source (id, missing) -> ghost (id)\n';
    const first = parseDatabase(source).diagnostics;
    expect(first.map(({ code }) => code)).toEqual(parseDatabase(source).diagnostics.map(({ code }) => code));
    expect(first.map(({ code }) => code)).toEqual(expect.arrayContaining(["database.unknown-column", "database.unknown-table", "database.fk-arity"]));
    expect(first.every(({ range }) => range !== undefined)).toBe(true);
  });

  it("parses syntax separately and preserves declaration spans", () => {
    const parsed = parseDatabaseSyntax('table ledger - "ledger"\ncolumn ledger column_id "id" {uuid} not-null\n');
    expect(parsed.ast.declarations.map(({ kind }) => kind)).toEqual(["table", "column"]);
    expect(parsed.ast.declarations[1].range.start.line).toBe(1);
    expect(parsed).not.toHaveProperty("model");
  });
});
