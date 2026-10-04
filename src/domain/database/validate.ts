import type { DatabaseModel } from "./model";
import type { Diagnostic } from "../../language/diagnostics/diagnostics";
import type { SourceRange } from "../diagram/ast";
import { diagnostic } from "../../language/artifact-parser";

export function validateDatabase(model: DatabaseModel, ranges: Map<string, SourceRange> = new Map()): Diagnostic[] {
  const out: Diagnostic[] = [], ids = new Set<string>();
  const range = (id: string) => ranges.get(id) ?? { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
  const uniqueId = (id: string, identity: string) => { if (ids.has(id)) out.push(diagnostic("database.duplicate-id", `Duplicate id "${id}".`, range(identity))); ids.add(id); };
  const tableNames = new Set<string>();
  const schemaIds = new Set(model.schemas.map(({ id }) => id));
  for (const schema of model.schemas) uniqueId(schema.id, `schema:${schema.id}`);
  for (const table of model.tables) {
    uniqueId(table.id, `table:${table.id}`);
    if (table.schemaId && !schemaIds.has(table.schemaId)) out.push(diagnostic("database.unknown-schema", `Unknown schema "${table.schemaId}".`, range(`table:${table.id}`)));
    const path = `${table.schemaId ?? ""}.${table.name}`;
    if (tableNames.has(path)) out.push(diagnostic("database.duplicate-table-name", `Duplicate table name "${path}".`, range(`table:${table.id}`)));
    tableNames.add(path);
    const cols = new Set<string>();
    for (const column of table.columns) {
      if (cols.has(column.name)) out.push(diagnostic("database.duplicate-column", `Duplicate column "${column.name}" in table "${table.id}".`, range(`column:${table.id}:${column.name}`)));
      cols.add(column.name); if (column.id) uniqueId(column.id, `column:${table.id}:${column.name}`);
    }
    const check = (key: { id: string; columns: string[]; name?: string }, identity: string) => {
      uniqueId(key.id, identity);
      for (const col of key.columns) if (!cols.has(col)) out.push(diagnostic("database.unknown-column", `Unknown column "${col}" in table "${table.id}".`, range(identity)));
    };
    if (table.primaryKey) {
      check(table.primaryKey, `pk:${table.id}`);
      for (const col of table.primaryKey.columns) if (table.columns.find(c => c.name === col)?.nullable) out.push(diagnostic("database.nullable-primary-key", `Primary-key column "${col}" must be not-null.`, range(`pk:${table.id}`)));
    }
    table.uniqueConstraints.forEach(key => check(key, `unique:${table.id}:${key.id}`));
    table.indexes.forEach(key => check(key, `index:${table.id}:${key.id}`));
  }
  for (const fk of model.foreignKeys) {
    uniqueId(fk.id, `fk:${fk.id}`);
    const source = model.tables.find(t => t.id === fk.sourceTableId), target = model.tables.find(t => t.id === fk.targetTableId);
    if (!source) out.push(diagnostic("database.unknown-table", `Unknown source table "${fk.sourceTableId}".`, range(`fk:${fk.id}`)));
    if (!target) out.push(diagnostic("database.unknown-table", `Unknown target table "${fk.targetTableId}".`, range(`fk:${fk.id}`)));
    if (fk.sourceColumns.length !== fk.targetColumns.length) out.push(diagnostic("database.fk-arity", "Foreign-key source and target column counts must match.", range(`fk:${fk.id}`)));
    for (const col of fk.sourceColumns) if (source && !source.columns.some(c => c.name === col)) out.push(diagnostic("database.unknown-column", `Unknown source column "${col}".`, range(`fk:${fk.id}`)));
    for (const col of fk.targetColumns) if (target && !target.columns.some(c => c.name === col)) out.push(diagnostic("database.unknown-column", `Unknown target column "${col}".`, range(`fk:${fk.id}`)));
    if (target && fk.targetColumns.length && !([target.primaryKey, ...target.uniqueConstraints].some(key => key && key.columns.join("\0") === fk.targetColumns.join("\0")))) out.push(diagnostic("database.fk-target-not-unique", "Foreign-key target columns must match a declared primary or unique key in order.", range(`fk:${fk.id}`)));
  }
  return out;
}
