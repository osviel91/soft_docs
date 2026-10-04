import type { Diagnostic } from "../diagnostics/diagnostics";
import { diagnostic, idError, sourceLines, tokensOf } from "../artifact-parser";
import type { ConceptualSyntax } from "./syntax";
export type { ConceptualDeclaration, ConceptualSyntax } from "./syntax";
export interface ConceptualSyntaxParseResult { ast: ConceptualSyntax; diagnostics: Diagnostic[] }

export function parseConceptualSyntax(source: string): ConceptualSyntaxParseResult {
  const ast: ConceptualSyntax = { declarations: [] }, diagnostics: Diagnostic[] = [];
  for (const line of sourceLines(source)) {
    const tokens = tokensOf(line.text);
    if (!tokens || (tokens.length && !["title", "description", "concept", "relation"].includes(tokens[0]))) {
      if (line.text.trim() && !line.text.trimStart().startsWith("#")) diagnostics.push(diagnostic("conceptual.syntax", "Malformed or unsupported Conceptual declaration.", line.range));
      continue;
    }
    if (!tokens?.length) continue;
    const [kind, ...parts] = tokens;
    if (kind === "title" || kind === "description") {
      if (parts.length !== 1) diagnostics.push(diagnostic("conceptual.syntax", `${kind} requires one quoted value.`, line.range));
      else ast.declarations.push(kind === "title" ? { kind, value: parts[0], range: line.range } : { kind, value: parts[0], range: line.range });
    } else if (kind === "concept") {
      const [id, name, ...extra] = parts;
      const description = extra.length === 2 && extra[0] === "description" ? extra[1] : undefined;
      if (!id || name === undefined || (extra.length !== 0 && description === undefined)) { diagnostics.push(diagnostic("conceptual.syntax", 'Expected: concept ID "Name" [description "..."]', line.range)); continue; }
      const invalid = idError(id); if (invalid) diagnostics.push(diagnostic("conceptual.invalid-id", invalid, line.range));
      ast.declarations.push({ kind, id, name, ...(description === undefined ? {} : { description }), range: line.range });
    } else {
      const [id, sourceId, direction, target, label, ...extra] = parts;
      const description = extra.length === 2 && extra[0] === "description" ? extra[1] : undefined;
      if (!id || !sourceId || !["->", "--"].includes(direction) || !target || label === undefined || (extra.length !== 0 && description === undefined)) { diagnostics.push(diagnostic("conceptual.syntax", 'Expected: relation ID SOURCE ->|-- TARGET "label" [description "..."]', line.range)); continue; }
      const invalid = idError(id); if (invalid) diagnostics.push(diagnostic("conceptual.invalid-id", invalid, line.range));
      ast.declarations.push({ kind: "relation", id, source: sourceId, target, label, direction: direction === "--" ? "undirected" : "directed", ...(description === undefined ? {} : { description }), range: line.range });
    }
  }
  return { ast, diagnostics };
}
