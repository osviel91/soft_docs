import { describe, expect, it } from "vitest";
import type { DatabaseModel } from "../../../src/domain/database/model";
import { projectDatabase } from "../../../src/domain/database/visual-projection";

describe("Database visual projection", () => {
  it("projects tables, ordered compound rows, identities, keys, nullability, and FK endpoints", () => {
    const model: DatabaseModel = {
      schemas: [{ id: "billing", name: "billing" }],
      tables: [
        { id: "account", schemaId: "billing", name: "accounts", columns: [{ id: "account-id", name: "id", type: "uuid", nullable: false }, { name: "external", type: "text", nullable: true }], primaryKey: { id: "account-pk", columns: ["id"] }, uniqueConstraints: [{ id: "account-uq", columns: ["external"] }], indexes: [] },
        { id: "invoice", schemaId: "billing", name: "invoices", columns: [{ id: "invoice-id", name: "id", type: "uuid", nullable: false }, { id: "account-ref", name: "account_id", type: "uuid", nullable: false }], primaryKey: { id: "invoice-pk", columns: ["id"] }, uniqueConstraints: [], indexes: [{ id: "invoice-ix", columns: ["account_id"] }] },
      ],
      foreignKeys: [
        { id: "fk-1", sourceTableId: "invoice", sourceColumns: ["account_id"], targetTableId: "account", targetColumns: ["id"] },
        { id: "fk-2", sourceTableId: "invoice", sourceColumns: ["account_id"], targetTableId: "account", targetColumns: ["external"] },
      ],
    };
    const projection = projectDatabase(model), account = projection.tables[0]!, invoice = projection.tables[1]!;
    expect(projection.tables.map(table => table.semanticTableId)).toEqual(["account", "invoice"]);
    expect(account.qualifiedName).toBe("billing.accounts");
    expect(account.columns.map(column => column.order)).toEqual([0, 1]);
    expect(account.columns[0]).toMatchObject({ semanticColumnId: "account-id", isPrimaryKey: true, nullable: false });
    expect(account.columns[1]).toMatchObject({ implicitIdentity: { tableId: "account", exactName: "external" }, uniqueConstraintIds: ["account-uq"], nullable: true });
    expect(invoice.columns[1]).toMatchObject({ semanticColumnId: "account-ref", isForeignKey: true, uniqueConstraintIds: [] });
    expect(invoice.requiredHeight).toBeGreaterThan(account.requiredHeight - 28);
    expect(projection.connections).toHaveLength(2);
    expect(projection.connections[0]).toMatchObject({ semanticForeignKeyId: "fk-1", sourceColumnIds: [invoice.columns[1]?.visualId], targetColumnIds: [account.columns[0]?.visualId] });
    expect(projection.connections[0]?.geometry.source.portId).toBe(invoice.columns[1]?.portIds.east);
    expect(projection.connections[0]?.geometry.target.portId).toBe(account.columns[0]?.portIds.west);
    expect(projection.connections[0]?.visualId).not.toBe(projection.connections[1]?.visualId);
  });

  it("retains a composite self-FK as one connection with row-specific evidence", () => {
    const model: DatabaseModel = {
      schemas: [],
      tables: [{ id: "tree", name: "tree", columns: [{ id: "tenant-id", name: "tenant_id", type: "uuid", nullable: false }, { id: "tree-id", name: "id", type: "uuid", nullable: false }, { id: "parent-tenant", name: "parent_tenant", type: "uuid", nullable: true }, { id: "parent-id", name: "parent_id", type: "uuid", nullable: true }], primaryKey: { id: "tree-pk", columns: ["tenant_id", "id"] }, uniqueConstraints: [], indexes: [] }],
      foreignKeys: [{ id: "tree-parent", sourceTableId: "tree", sourceColumns: ["parent_tenant", "parent_id"], targetTableId: "tree", targetColumns: ["tenant_id", "id"] }],
    };
    const projection = projectDatabase(model), fk = projection.connections[0]!;
    expect(fk.sourceTableVisualId).toBe(fk.targetTableVisualId);
    expect(fk.sourceColumnIds).toHaveLength(2);
    expect(fk.targetColumnIds).toHaveLength(2);
    expect(fk.sourcePortIds).toHaveLength(2);
    expect(fk.targetPortIds).toHaveLength(2);
    expect(fk.geometry.source.portId).not.toBe(fk.geometry.target.portId);
  });
});
