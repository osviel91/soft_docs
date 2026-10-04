import { validateDatabase } from "../../domain/database/validate";
import type { DatabaseModel } from "../../domain/database/model";
import type { Diagnostic } from "../diagnostics/diagnostics";
import { buildDatabaseModel } from "./semantic-builder";
import { parseDatabaseSyntax } from "./parser";
import type { DatabaseSyntax } from "./syntax";

export function parseDatabase(source: string): { ast: DatabaseSyntax | null; model: DatabaseModel | null; diagnostics: Diagnostic[] } {
  const parsed = parseDatabaseSyntax(source);
  const built = buildDatabaseModel(parsed.ast);
  return { ast: parsed.ast, model: built.model, diagnostics: [...parsed.diagnostics, ...validateDatabase(built.model, built.ranges)] };
}
