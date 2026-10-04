import type { DatabaseForeignKey, DatabaseModel, DatabaseTable } from "../../domain/database/model";
import type { SourceRange } from "../../domain/diagram/ast";
import type { DatabaseSyntax } from "./syntax";

/** Construct schema semantics from syntax declarations, retaining provenance separately. */
export function buildDatabaseModel(syntax: DatabaseSyntax): { model: DatabaseModel; ranges: Map<string, SourceRange> } {
  const model: DatabaseModel = { schemas: [], tables: [], foreignKeys: [] }, ranges = new Map<string, SourceRange>(), tables = new Map<string, DatabaseTable>();
  for (const declaration of syntax.declarations) {
    if (declaration.kind === "title" || declaration.kind === "description") model[declaration.kind] = declaration.value;
    else if (declaration.kind === "schema") {
      model.schemas.push({ id: declaration.id, name: declaration.name }); ranges.set(`schema:${declaration.id}`, declaration.range);
    } else if (declaration.kind === "table") {
      const table: DatabaseTable = { id: declaration.id, ...(declaration.schemaId ? { schemaId: declaration.schemaId } : {}), name: declaration.name, columns: [], uniqueConstraints: [], indexes: [] };
      model.tables.push(table); tables.set(table.id, table); ranges.set(`table:${table.id}`, declaration.range);
    } else if (declaration.kind === "column") {
      const table = tables.get(declaration.tableId);
      if (!table) continue;
      table.columns.push({ ...(declaration.id ? { id: declaration.id } : {}), name: declaration.name, type: declaration.type, nullable: declaration.nullable, ...(declaration.default === undefined ? {} : { default: declaration.default }), ...(declaration.description === undefined ? {} : { description: declaration.description }) });
      ranges.set(`column:${table.id}:${declaration.name}`, declaration.range);
    } else if (declaration.kind === "primary-key" || declaration.kind === "unique" || declaration.kind === "index") {
      const table = tables.get(declaration.tableId);
      if (!table) continue;
      const key = { id: declaration.id, columns: declaration.columns };
      if (declaration.kind === "primary-key") table.primaryKey = key;
      else if (declaration.kind === "unique") table.uniqueConstraints.push(key);
      else table.indexes.push(key);
      ranges.set(`${declaration.kind === "primary-key" ? "pk" : declaration.kind}:${table.id}${declaration.kind === "primary-key" ? "" : `:${declaration.id}`}`, declaration.range);
    } else {
      const fk: DatabaseForeignKey = { id: declaration.id, sourceTableId: declaration.sourceTableId, sourceColumns: declaration.sourceColumns, targetTableId: declaration.targetTableId, targetColumns: declaration.targetColumns };
      model.foreignKeys.push(fk); ranges.set(`fk:${fk.id}`, declaration.range);
    }
  }
  return { model, ranges };
}
