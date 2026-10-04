import type { Concept, ConceptualModel, ConceptualRelationship } from "../../domain/conceptual/model";
import { validateConceptual } from "../../domain/conceptual/validate";
import type { Diagnostic, ParseResult } from "../diagnostics/diagnostics";
import { diagnostic, idError, sourceLines, tokensOf } from "../artifact-parser";
import type { SourceRange } from "../../domain/diagram/ast";

export type ConceptualSyntax = { declarations: Array<{ kind: "concept" | "relation"; tokens: string[]; range: SourceRange }> };
export interface ConceptualParseResult extends ParseResult<ConceptualSyntax> { model: ConceptualModel | null }

export function parseConceptual(source: string): ConceptualParseResult {
  const syntax: ConceptualSyntax = { declarations: [] }, model: ConceptualModel = { concepts: [], relationships: [] };
  const diagnostics: Diagnostic[] = [], ranges = new Map<string, SourceRange>();
  for (const line of sourceLines(source)) {
    const tokens = tokensOf(line.text);
    if (!tokens || (tokens.length && !["title", "description", "concept", "relation"].includes(tokens[0]))) {
      if (line.text.trim() && !line.text.trimStart().startsWith("#")) diagnostics.push(diagnostic("conceptual.syntax", "Malformed or unsupported Conceptual declaration.", line.range));
      continue;
    }
    if (!tokens?.length) continue;
    if (tokens[0] === "title" || tokens[0] === "description") {
      if (tokens.length !== 2) diagnostics.push(diagnostic("conceptual.syntax", `${tokens[0]} requires one quoted value.`, line.range));
      else if (tokens[0] === "title") model.title = tokens[1]; else model.description = tokens[1];
      continue;
    }
    const kind = tokens[0] as "concept" | "relation";
    syntax.declarations.push({ kind, tokens: tokens.slice(1), range: line.range });
    if (kind === "concept") {
      const [id, name, ...extra] = tokens.slice(1);
      const description = extra.length === 2 && extra[0] === "description" ? extra[1] : undefined;
      if (!id || name === undefined || (extra.length !== 0 && !description)) { diagnostics.push(diagnostic("conceptual.syntax", 'Expected: concept ID "Name" [description "..."]', line.range)); continue; }
      const invalid = idError(id); if (invalid) diagnostics.push(diagnostic("conceptual.invalid-id", invalid, line.range));
      const concept: Concept = { id, name, ...(description === undefined ? {} : { description }) };
      model.concepts.push(concept); ranges.set(`concept:${id}`, line.range);
    } else {
      const [id, from, direction, to, label, ...extra] = tokens.slice(1);
      const description = extra.length === 2 && extra[0] === "description" ? extra[1] : undefined;
      if (!id || !from || !["->", "--"].includes(direction) || !to || label === undefined || (extra.length !== 0 && !description)) { diagnostics.push(diagnostic("conceptual.syntax", 'Expected: relation ID SOURCE ->|-- TARGET "label" [description "..."]', line.range)); continue; }
      const invalid = idError(id); if (invalid) diagnostics.push(diagnostic("conceptual.invalid-id", invalid, line.range));
      const relationship: ConceptualRelationship = { id, sourceConceptId: from, targetConceptId: to, label, direction: direction === "--" ? "undirected" : "directed", ...(description === undefined ? {} : { description }) };
      model.relationships.push(relationship); ranges.set(`relation:${id}`, line.range);
    }
  }
  diagnostics.push(...validateConceptual(model, ranges));
  return { ast: syntax, model, diagnostics };
}
