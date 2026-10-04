import { describe, expect, it } from "vitest";
import { parseDatabaseSyntax } from "../../../src/language/database/parser";
import { buildDatabaseModel } from "../../../src/language/database/semantic-builder";
import { validateDatabase } from "../../../src/domain/database/validate";

describe("Database semantic construction", () => {
  it("constructs schemas, stable and implicit column identities, keys, indexes, and FKs", () => {
    const syntax = parseDatabaseSyntax('schema billing "Billing"\ntable invoice billing "invoice"\ncolumn invoice invoice_id "id" {uuid} not-null default {gen_random_uuid()}\ncolumn invoice - "amount" {decimal(10,2)} not-null\nprimary-key invoice_pk invoice (id)\nunique invoice_amount invoice (amount)\nindex invoice_idx invoice (amount, id)\nforeign-key invoice_self invoice (id) -> invoice (id)\n').ast;
    const { model } = buildDatabaseModel(syntax);
    expect(model.schemas).toEqual([{ id: "billing", name: "Billing" }]);
    expect(model.tables[0]).toEqual({
      id: "invoice", schemaId: "billing", name: "invoice",
      columns: [
        { id: "invoice_id", name: "id", type: "uuid", nullable: false, default: "gen_random_uuid()" },
        { name: "amount", type: "decimal(10,2)", nullable: false },
      ],
      primaryKey: { id: "invoice_pk", columns: ["id"] },
      uniqueConstraints: [{ id: "invoice_amount", columns: ["amount"] }],
      indexes: [{ id: "invoice_idx", columns: ["amount", "id"] }],
    });
    expect(model.foreignKeys).toEqual([{ id: "invoice_self", sourceTableId: "invoice", sourceColumns: ["id"], targetTableId: "invoice", targetColumns: ["id"] }]);
  });

  it("validates database keys and references after construction", () => {
    const { model } = buildDatabaseModel(parseDatabaseSyntax('table users - "users"\ncolumn users id "id" {uuid} nullable\nprimary-key users_pk users (id)\nforeign-key missing users (absent) -> nowhere (id)\n').ast);
    expect(validateDatabase(model).map(({ code }) => code)).toEqual([
      "database.nullable-primary-key",
      "database.unknown-table",
      "database.unknown-column",
    ]);
  });
});
