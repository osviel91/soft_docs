import type { SourceRange } from "../diagram/ast";

export type EntityRepresentation = "conceptual" | "database";
export type EntityKind =
  | "concept"
  | "conceptual-relationship"
  | "table"
  | "foreign-key"
  | "primary-key"
  | "unique-key"
  | "index"
  | "column";

export type EntityIdentity =
  | { kind: "local-id"; value: string }
  | { kind: "table-column-name"; tableId: string; name: string };

export interface EntityAnchor {
  version: 1;
  resourceId: string;
  representation: EntityRepresentation;
  entityKind: EntityKind;
  identity: EntityIdentity;
}

export interface IndexedEntity {
  anchor: EntityAnchor;
  name: string;
}

export type BindingRelationKind = "represents-in";
export const BINDING_RELATIONS: Record<BindingRelationKind, {
  id: BindingRelationKind;
  direction: "directional";
  entailment: string;
}> = {
  "represents-in": {
    id: "represents-in",
    direction: "directional",
    entailment: "The source entity is represented in the target entity.",
  },
};

export type BindingEvidenceItem =
  | { kind: "internal"; resourceId: string; revision: number; entity?: EntityAnchor; range?: SourceRange }
  | { kind: "external"; reference: string; description: string };

export interface BindingEvidence {
  version: 1;
  rationale: string;
  items: BindingEvidenceItem[];
}

export interface SemanticBinding {
  id: string;
  projectId: string;
  left: EntityAnchor;
  right: EntityAnchor;
  relation: BindingRelationKind;
  evidence: BindingEvidence;
  revision: number;
  status: "ACTIVE" | "RETIRED";
  provenance: { authorId: string; contextId?: string; proposalId?: string; createdAt: string };
}

export type EntityResolution = "resolved" | "unresolved" | "unavailable";

export function entityAnchorKey(anchor: EntityAnchor): string {
  return JSON.stringify([anchor.version, anchor.resourceId, anchor.representation, anchor.entityKind, anchor.identity]);
}

export function resolveEntityAnchor(anchor: EntityAnchor, entities: IndexedEntity[]): EntityResolution {
  if (anchor.version !== 1) return "unresolved";
  return entities.some((entity) => entityAnchorKey(entity.anchor) === entityAnchorKey(anchor))
    ? "resolved"
    : "unresolved";
}

export function validateSemanticBinding(binding: SemanticBinding): void {
  if (!binding.id || !binding.projectId || binding.left.resourceId === binding.right.resourceId) throw new Error("A semantic binding requires distinct resources and a stable id.");
  if (!BINDING_RELATIONS[binding.relation]) throw new Error("Unknown semantic binding relation.");
  if (binding.evidence.version !== 1 || !binding.evidence.rationale.trim() || binding.evidence.items.length === 0) throw new Error("A semantic binding requires version 1 evidence and a concise rationale.");
  if (!Number.isInteger(binding.revision) || binding.revision < 1 || (binding.status !== "ACTIVE" && binding.status !== "RETIRED")) throw new Error("Invalid binding revision or lifecycle status.");
  for (const anchor of [binding.left, binding.right]) {
    if (anchor.version !== 1 || !anchor.resourceId || !anchor.identity) throw new Error("Invalid entity anchor.");
    if (anchor.representation !== "conceptual" && anchor.representation !== "database") throw new Error("Invalid entity representation.");
    if (anchor.identity.kind === "local-id" && !anchor.identity.value.trim()) throw new Error("Entity local id cannot be empty.");
    if (anchor.identity.kind === "table-column-name" && (!anchor.identity.tableId.trim() || !anchor.identity.name.trim())) throw new Error("Column fallback identity requires exact table id and name.");
    if (anchor.identity.kind === "table-column-name" && (anchor.representation !== "database" || anchor.entityKind !== "column")) throw new Error("Table/name identity is only valid for Database columns.");
    if (anchor.entityKind !== "column" && anchor.identity.kind !== "local-id") throw new Error("This entity kind requires an authored local ID.");
    if (anchor.representation === "conceptual" && !["concept", "conceptual-relationship"].includes(anchor.entityKind)) throw new Error("Entity kind does not belong to Conceptual.");
    if (anchor.representation === "database" && !["table", "foreign-key", "primary-key", "unique-key", "index", "column"].includes(anchor.entityKind)) throw new Error("Entity kind does not belong to Database.");
  }
  for (const item of binding.evidence.items) {
    if (item.kind === "internal") {
      if (!item.resourceId || !Number.isInteger(item.revision) || item.revision < 1) throw new Error("Internal evidence requires a resource and positive revision.");
      if (item.entity && item.entity.resourceId !== item.resourceId) throw new Error("Evidence entity must belong to its evidence resource.");
      if (item.range && (item.range.start.line < 0 || item.range.start.column < 0 || item.range.end.line < item.range.start.line || (item.range.end.line === item.range.start.line && item.range.end.column < item.range.start.column))) throw new Error("Invalid evidence range.");
    } else if (item.kind !== "external" || !item.reference.trim() || !item.description.trim()) throw new Error("External evidence requires a reference and description.");
  }
}
