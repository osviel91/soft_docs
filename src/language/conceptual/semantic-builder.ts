import type { ConceptualModel } from "../../domain/conceptual/model";
import type { SourceRange } from "../../domain/diagram/ast";
import type { ConceptualSyntax } from "./syntax";

/** Construct domain semantics from parsed declarations; ranges remain sidecar provenance. */
export function buildConceptualModel(syntax: ConceptualSyntax): { model: ConceptualModel; ranges: Map<string, SourceRange> } {
  const model: ConceptualModel = { concepts: [], relationships: [] }, ranges = new Map<string, SourceRange>();
  for (const declaration of syntax.declarations) {
    if (declaration.kind === "title" || declaration.kind === "description") model[declaration.kind] = declaration.value;
    else if (declaration.kind === "concept") {
      model.concepts.push({ id: declaration.id, name: declaration.name, ...(declaration.description === undefined ? {} : { description: declaration.description }) });
      ranges.set(`concept:${declaration.id}`, declaration.range);
    } else {
      model.relationships.push({ id: declaration.id, sourceConceptId: declaration.source, targetConceptId: declaration.target, label: declaration.label, direction: declaration.direction, ...(declaration.description === undefined ? {} : { description: declaration.description }) });
      ranges.set(`relation:${declaration.id}`, declaration.range);
    }
  }
  return { model, ranges };
}
