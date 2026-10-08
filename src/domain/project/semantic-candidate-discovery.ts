import type { ProjectIndex } from "./project-index";
import { entityAnchorKey, type EntityAnchor, type IndexedEntity, type SemanticBinding } from "../workspace/semantic-binding";

export const DISCOVERY_IDENTITY_SCHEMA_VERSION = 1;

export interface SemanticCandidate {
  id: string;
  relation: "represents-in";
  left: EntityAnchor;
  right: EntityAnchor;
  leftName: string;
  rightName: string;
  leftType: string;
  rightType: string;
  signals: Array<{ code: "normalized-name-exact" | "entity-kind-compatible"; description: string }>;
  ranking: number;
  fingerprint: string;
  policyVersion: string;
  ambiguity: { ambiguous: boolean; alternativeCount: number };
}

export function discoverSemanticCandidates(
  index: ProjectIndex,
  activeBindings: SemanticBinding[],
  policyVersion: string,
): SemanticCandidate[] {
  const entities = (index.entities ?? []).filter(isEligibleEntity);
  const leftByName = new Map<string, IndexedEntity[]>();
  const rightByName = new Map<string, IndexedEntity[]>();
  for (const entity of entities) {
    const normalized = normalizeName(entity.name);
    if (!normalized) continue;
    const groups = entity.anchor.representation === "conceptual" ? leftByName : rightByName;
    const group = groups.get(normalized) ?? [];
    if (!group.some((candidate) => entityAnchorKey(candidate.anchor) === entityAnchorKey(entity.anchor))) group.push(entity);
    groups.set(normalized, group);
  }

  const bound = new Set(activeBindings.filter((b) => b.status === "ACTIVE" && b.projectId === index.projectId)
    .map((b) => `${entityAnchorKey(b.left)}\0${entityAnchorKey(b.right)}`));
  const candidates: SemanticCandidate[] = [];
  for (const [normalized, leftEntities] of leftByName) {
    const rightEntities = rightByName.get(normalized) ?? [];
    for (const left of leftEntities) for (const right of rightEntities) {
      if (!typesCompatible(left.anchor, right.anchor)) continue;
      const pairKey = `${entityAnchorKey(left.anchor)}\0${entityAnchorKey(right.anchor)}`;
      if (bound.has(pairKey)) continue;
      const id = hash([DISCOVERY_IDENTITY_SCHEMA_VERSION, "represents-in", entityAnchorKey(left.anchor), entityAnchorKey(right.anchor)]);
      const signals = [
        { code: "normalized-name-exact" as const, description: `Names match after normalization: ${normalized}.` },
        { code: "entity-kind-compatible" as const, description: `${left.anchor.entityKind} can represent ${right.anchor.entityKind}.` },
      ];
      const ambiguity = leftEntities.length > 1 || rightEntities.length > 1;
      const alternativeCount = leftEntities.length * rightEntities.length - 1;
      const relevantDiscoveryInputs = [normalized, left.name, right.name, left.anchor.entityKind, right.anchor.entityKind, alternativeCount];
      candidates.push({
        id, relation: "represents-in", left: left.anchor, right: right.anchor,
        leftName: left.name, rightName: right.name, leftType: left.anchor.entityKind, rightType: right.anchor.entityKind,
        signals, ranking: 1, fingerprint: hash([policyVersion, id, relevantDiscoveryInputs, signals]), policyVersion,
        ambiguity: { ambiguous: ambiguity, alternativeCount },
      });
    }
  }
  return candidates.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function normalizeName(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function isEligibleEntity(entity: IndexedEntity): boolean {
  const { anchor } = entity;
  return (anchor.representation === "conceptual" && ["concept", "conceptual-relationship"].includes(anchor.entityKind)) ||
    (anchor.representation === "database" && ["table", "column", "foreign-key"].includes(anchor.entityKind));
}

function typesCompatible(left: EntityAnchor, right: EntityAnchor): boolean {
  return left.representation === "conceptual" && right.representation === "database" &&
    (left.entityKind === "concept" || left.entityKind === "conceptual-relationship") &&
    (right.entityKind === "table" || right.entityKind === "column" || right.entityKind === "foreign-key");
}

// Compact deterministic non-cryptographic hash; collision affects identifiers, not authority.
function hash(value: unknown): string {
  const text = JSON.stringify(value);
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x85ebca6b);
  }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}
