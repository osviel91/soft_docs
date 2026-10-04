import type { DatabaseForeignKey, DatabaseModel, DatabaseTable } from "../../domain/database/model";
import { validateDatabase } from "../../domain/database/validate";
import type { Diagnostic, ParseResult } from "../diagnostics/diagnostics";
import { diagnostic, idError, sourceLines, tokensOf } from "../artifact-parser";
import type { SourceRange } from "../../domain/diagram/ast";

export interface DatabaseSyntax { declarations: Array<{ tokens: string[]; range: SourceRange }> }
export interface DatabaseParseResult extends ParseResult<DatabaseSyntax> { model: DatabaseModel | null }

function list(tokens: string[], start: number): string[] | null {
  if (tokens[start] !== "(") return null;
  const end = tokens.indexOf(")", start + 1);
  if (end < 0) return null;
  const values = tokens.slice(start + 1, end);
  if (!values.length || values.some((v, i) => i % 2 === 1 ? v !== "," : v === ",")) return null;
  return values.filter(v => v !== ",");
}

export function parseDatabase(source: string): DatabaseParseResult {
  const syntax: DatabaseSyntax = { declarations: [] };
  const model: DatabaseModel = { schemas: [], tables: [], foreignKeys: [] };
  const diagnostics: Diagnostic[] = [], ranges = new Map<string, SourceRange>();
  const tables = new Map<string, DatabaseTable>();
  for (const line of sourceLines(source)) {
    const tokens = tokensOf(line.text);
    if (!tokens?.length) {
      if (line.text.trim() && !tokens) diagnostics.push(diagnostic("database.syntax", "Unterminated quote or opaque value.", line.range));
      continue;
    }
    syntax.declarations.push({ tokens, range: line.range });
    const fail = (expected: string) => diagnostics.push(diagnostic("database.syntax", `Expected: ${expected}`, line.range));
    const valid = (id: string) => { const message = idError(id); if (message) diagnostics.push(diagnostic("database.invalid-id", message, line.range)); };
    if (tokens[0] === "title" || tokens[0] === "description") {
      if (tokens.length !== 2) fail(`${tokens[0]} "value"`);
      else if (tokens[0] === "title") model.title = tokens[1]; else model.description = tokens[1];
    } else if (tokens[0] === "schema") {
      if (tokens.length !== 3) { fail('schema ID "name"'); continue; }
      valid(tokens[1]); model.schemas.push({ id: tokens[1], name: tokens[2] }); ranges.set(`schema:${tokens[1]}`, line.range);
    } else if (tokens[0] === "table") {
      if (tokens.length !== 4) { fail('table ID SCHEMA_ID|- "name"'); continue; }
      const [, id, schemaId, name] = tokens; valid(id);
      const table: DatabaseTable = { id, ...(schemaId === "-" ? {} : { schemaId }), name, columns: [], uniqueConstraints: [], indexes: [] };
      tables.set(id, table); model.tables.push(table); ranges.set(`table:${id}`, line.range);
    } else if (tokens[0] === "column") {
      // column TABLE_ID [COLUMN_ID|-] "name" {opaque type} nullable|not-null [default {opaque}] [description "..."]
      if (tokens.length < 6) { fail('column TABLE_ID [COLUMN_ID|-] "name" {type} nullable|not-null'); continue; }
      const table = tables.get(tokens[1]);
      if (!table) { diagnostics.push(diagnostic("database.unknown-table", `Declare table "${tokens[1]}" before its columns.`, line.range)); continue; }
      let i = 2, columnId: string | undefined;
      if (tokens[i] !== "-") { columnId = tokens[i]; valid(columnId); } i++;
      const name = tokens[i++], type = tokens[i++], nullableToken = tokens[i++];
      if (type === undefined || !["nullable", "not-null"].includes(nullableToken)) { fail('column TABLE_ID [COLUMN_ID|-] "name" {type} nullable|not-null'); continue; }
      let defaultValue: string | undefined, description: string | undefined;
      while (i < tokens.length) {
        if (tokens[i] === "default" && i + 1 < tokens.length) { defaultValue = tokens[i + 1]; i += 2; }
        else if (tokens[i] === "description" && i + 1 < tokens.length) { description = tokens[i + 1]; i += 2; }
        else { fail("optional default {value} and description \"text\""); break; }
      }
      table.columns.push({ ...(columnId ? { id: columnId } : {}), name, type, nullable: nullableToken === "nullable", ...(defaultValue === undefined ? {} : { default: defaultValue }), ...(description === undefined ? {} : { description }) });
      ranges.set(`column:${table.id}:${name}`, line.range);
    } else if (["primary-key", "unique", "index"].includes(tokens[0])) {
      const kind = tokens[0], id = tokens[1], table = tables.get(tokens[2]), columns = list(tokens, 3);
      if (!id || !table || !columns) { fail(`${kind} ID TABLE_ID (column, ...)`); continue; }
      valid(id); const key = { id, columns };
      if (kind === "primary-key") table.primaryKey = key;
      else if (kind === "unique") table.uniqueConstraints.push(key);
      else table.indexes.push(key);
      ranges.set(`${kind === "primary-key" ? "pk" : kind}:${table.id}${kind === "primary-key" ? "" : `:${id}`}`, line.range);
    } else if (tokens[0] === "foreign-key") {
      const id = tokens[1], sourceTableId = tokens[2], sourceColumns = list(tokens, 3);
      const arrow = sourceColumns ? 3 + sourceColumns.length * 2 + 1 : -1;
      const targetTableId = tokens[arrow + 1], targetColumns = list(tokens, arrow + 2);
      if (!id || !sourceColumns || tokens[arrow] !== "->" || !targetTableId || !targetColumns) { fail("foreign-key ID SOURCE_TABLE (columns) -> TARGET_TABLE (columns)"); continue; }
      valid(id); const fk: DatabaseForeignKey = { id, sourceTableId, sourceColumns, targetTableId, targetColumns };
      model.foreignKeys.push(fk); ranges.set(`fk:${id}`, line.range);
    } else fail("title, description, schema, table, column, primary-key, unique, index, or foreign-key declaration");
  }
  diagnostics.push(...validateDatabase(model, ranges));
  return { ast: syntax, model, diagnostics };
}
