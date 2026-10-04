import type { Diagnostic } from "../diagnostics/diagnostics";
import { diagnostic, idError, sourceLines, tokensOf } from "../artifact-parser";
import type { DatabaseSyntax } from "./syntax";
export type { DatabaseDeclaration, DatabaseSyntax } from "./syntax";

export interface DatabaseSyntaxParseResult { ast: DatabaseSyntax; diagnostics: Diagnostic[] }

function list(tokens: string[], start: number): string[] | null {
  if (tokens[start] !== "(") return null;
  const end = tokens.indexOf(")", start + 1);
  if (end < 0) return null;
  const values = tokens.slice(start + 1, end);
  if (!values.length || values.some((v, i) => i % 2 === 1 ? v !== "," : v === ",")) return null;
  return values.filter(v => v !== ",");
}

export function parseDatabaseSyntax(source: string): DatabaseSyntaxParseResult {
  const ast: DatabaseSyntax = { declarations: [] }, diagnostics: Diagnostic[] = [];
  for (const line of sourceLines(source)) {
    const tokens = tokensOf(line.text);
    if (!tokens?.length) {
      if (line.text.trim() && !tokens) diagnostics.push(diagnostic("database.syntax", "Unterminated quote or opaque value.", line.range));
      continue;
    }
    const fail = (expected: string) => diagnostics.push(diagnostic("database.syntax", `Expected: ${expected}`, line.range));
    const valid = (id: string) => { const message = idError(id); if (message) diagnostics.push(diagnostic("database.invalid-id", message, line.range)); };
    const [kind, ...parts] = tokens;
    if (kind === "title" || kind === "description") {
      if (parts.length !== 1) fail(`${kind} "value"`); else ast.declarations.push(kind === "title" ? { kind, value: parts[0], range: line.range } : { kind, value: parts[0], range: line.range });
    } else if (kind === "schema") {
      if (parts.length !== 2) { fail('schema ID "name"'); continue; }
      valid(parts[0]); ast.declarations.push({ kind, id: parts[0], name: parts[1], range: line.range });
    } else if (kind === "table") {
      if (parts.length !== 3) { fail('table ID SCHEMA_ID|- "name"'); continue; }
      valid(parts[0]); ast.declarations.push({ kind, id: parts[0], ...(parts[1] === "-" ? {} : { schemaId: parts[1] }), name: parts[2], range: line.range });
    } else if (kind === "column") {
      if (parts.length < 5) { fail('column TABLE_ID [COLUMN_ID|-] "name" {type} nullable|not-null'); continue; }
      const [tableId, authoredId, name, type, nullability, ...extra] = parts;
      if (!type || !["nullable", "not-null"].includes(nullability)) { fail('column TABLE_ID [COLUMN_ID|-] "name" {type} nullable|not-null'); continue; }
      let defaultValue: string | undefined, description: string | undefined, validTail = true;
      for (let i = 0; i < extra.length;) {
        if (extra[i] === "default" && i + 1 < extra.length) { defaultValue = extra[i + 1]; i += 2; }
        else if (extra[i] === "description" && i + 1 < extra.length) { description = extra[i + 1]; i += 2; }
        else { validTail = false; break; }
      }
      if (!validTail) { fail('optional default {value} and description "text"'); continue; }
      if (authoredId !== "-") valid(authoredId);
      ast.declarations.push({ kind, tableId, ...(authoredId === "-" ? {} : { id: authoredId }), name, type, nullable: nullability === "nullable", ...(defaultValue === undefined ? {} : { default: defaultValue }), ...(description === undefined ? {} : { description }), range: line.range });
    } else if (kind === "primary-key" || kind === "unique" || kind === "index") {
      const [id, tableId, ...tail] = parts, columns = list(tail, 0);
      if (!id || !tableId || !columns || tail[columns.length * 2 + 1] !== undefined) { fail(`${kind} ID TABLE_ID (column, ...)`); continue; }
      valid(id);
      if (kind === "primary-key") ast.declarations.push({ kind, id, tableId, columns, range: line.range });
      else if (kind === "unique") ast.declarations.push({ kind, id, tableId, columns, range: line.range });
      else ast.declarations.push({ kind, id, tableId, columns, range: line.range });
    } else if (kind === "foreign-key") {
      const [id, sourceTableId, ...tail] = parts, sourceColumns = list(tail, 0);
      const arrow = sourceColumns ? sourceColumns.length * 2 + 1 : -1;
      const targetTableId = tail[arrow + 1], targetColumns = list(tail, arrow + 2);
      if (!id || !sourceTableId || !sourceColumns || tail[arrow] !== "->" || !targetTableId || !targetColumns || tail[arrow + 2 + targetColumns.length * 2 + 1] !== undefined) { fail("foreign-key ID SOURCE_TABLE (columns) -> TARGET_TABLE (columns)"); continue; }
      valid(id); ast.declarations.push({ kind, id, sourceTableId, sourceColumns, targetTableId, targetColumns, range: line.range });
    } else fail("title, description, schema, table, column, primary-key, unique, index, or foreign-key declaration");
  }
  return { ast, diagnostics };
}
