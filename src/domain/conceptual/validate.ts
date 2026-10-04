import type { ConceptualModel } from "./model";
import type { Diagnostic } from "../../language/diagnostics/diagnostics";
import { diagnostic } from "../../language/artifact-parser";
import type { SourceRange } from "../diagram/ast";

export function validateConceptual(model: ConceptualModel, ranges: Map<string, SourceRange> = new Map()): Diagnostic[] {
  const diagnostics: Diagnostic[] = [], concepts = new Set<string>(), relations = new Set<string>();
  for (const concept of model.concepts) {
    const range = ranges.get(`concept:${concept.id}`) ?? { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
    if (concepts.has(concept.id)) diagnostics.push(diagnostic("conceptual.duplicate-concept-id", `Duplicate concept id "${concept.id}".`, range));
    concepts.add(concept.id);
  }
  for (const relation of model.relationships) {
    const range = ranges.get(`relation:${relation.id}`) ?? { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
    if (relations.has(relation.id)) diagnostics.push(diagnostic("conceptual.duplicate-relationship-id", `Duplicate relationship id "${relation.id}".`, range));
    relations.add(relation.id);
    if (!concepts.has(relation.sourceConceptId)) diagnostics.push(diagnostic("conceptual.unknown-source", `Unknown source concept "${relation.sourceConceptId}".`, range));
    if (!concepts.has(relation.targetConceptId)) diagnostics.push(diagnostic("conceptual.unknown-target", `Unknown target concept "${relation.targetConceptId}".`, range));
    if (!relation.label.trim()) diagnostics.push(diagnostic("conceptual.empty-label", "Relationship label must not be empty.", range));
  }
  return diagnostics;
}
