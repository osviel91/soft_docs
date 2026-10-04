import type { SourceRange } from "../../domain/diagram/ast";

export type ConceptualDeclaration =
  | { kind: "title"; value: string; range: SourceRange }
  | { kind: "description"; value: string; range: SourceRange }
  | { kind: "concept"; id: string; name: string; description?: string; range: SourceRange }
  | { kind: "relation"; id: string; source: string; target: string; label: string; direction: "directed" | "undirected"; description?: string; range: SourceRange };
export interface ConceptualSyntax { declarations: ConceptualDeclaration[] }
