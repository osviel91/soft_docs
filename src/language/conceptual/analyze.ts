import { validateConceptual } from "../../domain/conceptual/validate";
import type { ConceptualModel } from "../../domain/conceptual/model";
import type { Diagnostic } from "../diagnostics/diagnostics";
import { buildConceptualModel } from "./semantic-builder";
import { parseConceptualSyntax } from "./parser";
import type { ConceptualSyntax } from "./syntax";

export function parseConceptual(source: string): { ast: ConceptualSyntax | null; model: ConceptualModel | null; diagnostics: Diagnostic[] } {
  const parsed = parseConceptualSyntax(source);
  const built = buildConceptualModel(parsed.ast);
  return { ast: parsed.ast, model: built.model, diagnostics: [...parsed.diagnostics, ...validateConceptual(built.model, built.ranges)] };
}
