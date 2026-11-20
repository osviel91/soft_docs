import type { SemanticChange } from "../../domain/diff/resource-diff";
import type { SequenceAmbiguityRegion, SequenceComparisonChange, SequenceIndeterminateOccurrence, SequenceNodeReference } from "../../domain/diff/sequence-comparison";
import { reviewTargetId } from "./review-targets";
import {
  sequenceDiffDecorations,
  type SequenceDiffDecoration,
} from "./sequence-decorations";

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function eventOf(change: SemanticChange): string | null {
  if (typeof change.details?.event === "string") return change.details.event;
  if (change.entity === "event") return change.identity;
  if (change.entity === "publication" || change.entity === "subscription")
    return change.identity.split("|")[0];
  if (change.entity === "channel") return change.identity;
  return null;
}

/** Which add/remove colour a decoration takes on a given side of the diff. */
function visualClass(
  decoration: SequenceDiffDecoration,
): string {
  const kind = decoration.kind;
  if (kind === "modified-interaction" || kind === "modified-participant")
    return `review-change--${decoration.category}`;
  return kind.startsWith("added")
    ? "review-change--added"
    : "review-change--removed";
}

/**
 * The rendered ordinal this decoration addresses on `side`, or 0 when the
 * decoration has no representation there (an addition has none in BASE, a
 * removal none in PROPOSED).
 */
function sideNumber(
  decoration: SequenceDiffDecoration,
  side: "base" | "proposed",
): number {
  if (decoration.kind === "modified-interaction")
    return side === "base" ? decoration.baseNumber : decoration.proposedNumber;
  if (decoration.kind === "added-interaction")
    return side === "proposed" ? decoration.number : 0;
  if (decoration.kind === "removed-interaction")
    return side === "base" ? decoration.number : 0;
  return 0;
}

function decorateSequence(
  svg: string,
  changes: SemanticChange[],
  side: "base" | "proposed",
): string {
  let result = svg;
  for (const decoration of sequenceDiffDecorations(changes)) {
    const kind = visualClass(decoration);
    const marker = ` data-review-change="${xml(decoration.targetId)}"`;
    if (
      decoration.kind === "added-participant" ||
      decoration.kind === "removed-participant" ||
      decoration.kind === "modified-participant"
    ) {
      const participant = `data-participant-id="${xml(decoration.participantId)}"`;
      result = result.replace(
        new RegExp(`(<g class="participant)([^"]*)("[^>]*${participant}[^>]*)(>)`),
        `$1$2 ${kind}$3${marker}$4`,
      );
      continue;
    }
    const number = sideNumber(decoration, side);
    if (number === 0) continue;
    const target = `class="sequence-message" data-sequence-message="${number}"`;
    result = result.replace(
      target,
      `class="sequence-message ${kind}" data-sequence-message="${number}"${marker}`,
    );
  }
  return result;
}

/** Adds review-only classes to renderer-owned addressable SVG entities. */
export function decorateReviewSvg(
  svg: string,
  representation: "sequence" | "event-flow",
  changes: SemanticChange[],
  side: "base" | "proposed" = "proposed",
): string {
  if (representation === "sequence") return decorateSequence(svg, changes, side);
  let result = svg;
  for (const change of changes) {
    const identity = eventOf(change);
    const visualKind =
      change.kind === "modified"
        ? change.entity === "event-metadata"
          ? "syntactic"
          : "semantic"
        : change.kind;
    const kind = `review-change--${visualKind}`;
    const targetIdentity = reviewTargetId(change);
    const markerAttribute = ` data-review-change="${xml(targetIdentity)}"`;
    if (identity) {
      const marker = `class="eventflow-row" data-event="${xml(identity)}"`;
      result = result.replace(
        marker,
        `class="eventflow-row ${kind}" data-event="${xml(identity)}"${markerAttribute}`,
      );
    }
  }
  return result;
}

/** Decorate exact snapshot-local Sequence nodes without editing SVG source text. */
export function decorateSequenceComparisonSvg(
  svg: string,
  changes: SequenceComparisonChange[],
  side: "before" | "after",
  indeterminate: SequenceAmbiguityRegion[] = [],
): string {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") return svg;
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (document.querySelector("parsererror")) return svg;
  for (const change of changes) {
    const reference: SequenceNodeReference | null = side === "before" ? change.before : change.after;
    if (!reference) continue;
    const target = Array.from(document.querySelectorAll("[data-node-id], [data-message-node-id]"))
      .find((element) => element.getAttribute("data-node-id") === reference.nodeId ||
        element.getAttribute("data-message-node-id") === reference.nodeId);
    if (!target) continue;
    target.classList.add(`sequence-diff--${change.kind}`);
    if (change.confidence === "candidate") {
      target.classList.add("sequence-diff--candidate", "review-change--candidate");
    } else {
      if (change.confidence === "confirmed") target.classList.add("sequence-diff--confirmed");
      target.classList.add(`review-change--${change.kind}`);
    }
    if (change.id) target.setAttribute("data-review-change", change.id);
  }
  for (const region of indeterminate) {
    const occurrences = side === "before" ? region.before : region.after;
    for (const occurrence of occurrences) {
      const target = findSequenceTarget(document, occurrence.reference);
      if (!target) continue;
      target.classList.add("sequence-diff--indeterminate", "review-change--indeterminate");
      target.setAttribute("data-review-change", indeterminateOccurrenceTargetId(region.id, occurrence));
    }
  }
  return new XMLSerializer().serializeToString(document.documentElement);
}

function findSequenceTarget(document: Document, reference: SequenceNodeReference): Element | undefined {
  return Array.from(document.querySelectorAll("[data-node-id], [data-message-node-id]"))
    .find((element) => element.getAttribute("data-node-id") === reference.nodeId ||
      element.getAttribute("data-message-node-id") === reference.nodeId);
}

export function indeterminateOccurrenceTargetId(regionId: string, occurrence: SequenceIndeterminateOccurrence): string {
  return `${regionId}:${occurrence.side}:${occurrence.reference.nodeId}`;
}
