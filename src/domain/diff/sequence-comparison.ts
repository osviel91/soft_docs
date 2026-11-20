import {
  nodeIdOf,
  type AstNodeKind,
} from "../diagram/node-id";
import type {
  AltBranch,
  CriticalBranch,
  NoteNode,
  ParBranch,
  SequenceDiagram,
  SourceRange,
  Statement,
} from "../diagram/ast";
import { analyze } from "../../language/analyze";

export type SequenceComparisonEntity =
  | "participant"
  | "interaction"
  | "fragment"
  | "branch"
  | "note";

export type SequenceComparisonKind =
  | "added"
  | "removed"
  | "modified"
  | "moved"
  | "reordered";

export type SequenceComparisonConfidence =
  | "confirmed"
  | "candidate"
  | "unmatched";

export interface SequenceSnapshot {
  revision: number;
  source: string;
}

export interface SequenceNodeReference {
  revision: number;
  nodeId: string;
  range: SourceRange;
}

export interface SequenceComparisonChange {
  id: string;
  entity: SequenceComparisonEntity;
  kind: SequenceComparisonKind;
  confidence: SequenceComparisonConfidence;
  matchBasis?: string;
  modifiedProperties: string[];
  before: SequenceNodeReference | null;
  after: SequenceNodeReference | null;
  beforeValue: Record<string, unknown> | null;
  afterValue: Record<string, unknown> | null;
}

export interface SequenceComparisonDiagnostic {
  code: "invalid-snapshot" | "ambiguous-match" | "processing-limit";
  severity: "error" | "warning";
  message: string;
  side?: "before" | "after";
  range?: SourceRange;
}

export interface SequenceIndeterminateOccurrence {
  entity: SequenceComparisonEntity;
  side: "before" | "after";
  reference: SequenceNodeReference;
  value: Record<string, unknown>;
}

export interface SequenceAmbiguityRegion {
  id: string;
  cause: "multiple-optimal-alignments";
  scope: string;
  before: SequenceIndeterminateOccurrence[];
  after: SequenceIndeterminateOccurrence[];
  ranges: { before: SourceRange[]; after: SourceRange[] };
  counts: { before: number; after: number };
  evidence: string[];
  diagnosticIndices: number[];
}

export interface SequenceComparison {
  availability: "available" | "partial" | "unavailable";
  beforeRevision: number;
  afterRevision: number;
  changes: SequenceComparisonChange[];
  indeterminate: SequenceAmbiguityRegion[];
  diagnostics: SequenceComparisonDiagnostic[];
  limitations: string[];
  processedLcsCells: number;
  maxLcsCells: number;
}

export interface SequenceComparisonOptions {
  /** Total prefix/suffix LCS table cells across every compared scope. */
  maxLcsCells?: number;
}

const DEFAULT_MAX_LCS_CELLS = 1_000_000;
const OUT_OF_SCOPE = [
  "Sequence titles, aliases, and activations are not compared structurally; retain textual source evidence for these constructs.",
];

type PropertyValue = string | number | boolean | null;
type Properties = Record<string, PropertyValue>;

interface Scope {
  entries: Entry[];
}

interface Entry {
  entity: SequenceComparisonEntity;
  subtype: string;
  nodeKind: AstNodeKind;
  range: SourceRange;
  key: string;
  candidateKey: string;
  properties: Properties;
  children: Scope[];
  messageOccurrence?: number;
}

interface SnapshotModel {
  revision: number;
  diagram: SequenceDiagram;
  participants: Entry[];
  root: Scope;
  notes: Entry[];
  messages: Entry[];
}

interface PendingChange {
  entity: SequenceComparisonEntity;
  kind: SequenceComparisonKind;
  confidence: SequenceComparisonConfidence;
  matchBasis?: string;
  before: Entry | null;
  after: Entry | null;
  modifiedProperties: string[];
}

interface EntryMatch {
  before: Entry;
  after: Entry;
  confidence: "confirmed" | "candidate";
  basis: string;
  kind?: "moved" | "reordered";
}

interface UnmatchedEntry {
  entry: Entry;
  side: "before" | "after";
  scopePair: string;
  ambiguous: boolean;
}

interface Alignment {
  anchors: Array<[number, number]>;
  ambiguous: Array<[number, number]>;
}

class ProcessingLimitExceeded extends Error {}

function stableKey(value: unknown): string {
  return JSON.stringify(value);
}

function ref(entry: Entry | null, revision: number): SequenceNodeReference | null {
  return entry
    ? { revision, nodeId: nodeIdOf(entry.nodeKind, entry.range), range: entry.range }
    : null;
}

function entry(
  entity: SequenceComparisonEntity,
  subtype: string,
  nodeKind: AstNodeKind,
  range: SourceRange,
  properties: Properties,
  children: Scope[] = [],
  candidateProperties: Properties = properties,
): Entry {
  return {
    entity,
    subtype,
    nodeKind,
    range,
    key: stableKey([entity, subtype, properties]),
    candidateKey: stableKey([entity, subtype, candidateProperties]),
    properties,
    children,
  };
}

function branchEntries(
  branches: Array<AltBranch | ParBranch | CriticalBranch>,
  subtype: string,
): Entry[] {
  return branches.map((branch, index) => {
    const label = "condition" in branch ? branch.condition : branch.label;
    return entry(
      "branch",
      subtype,
      "branch",
      branch.range,
      { label },
      [{ entries: statementEntries(branch.statements) }],
      { branchIndex: index },
    );
  });
}

function fragmentEntry(statement: Exclude<Statement, { type: "message" | "activation" }>): Entry {
  const properties: Properties = { fragmentType: statement.type };
  if ("label" in statement) properties.label = statement.label;

  let children: Scope[];
  if (statement.type === "alt") {
    children = [{ entries: branchEntries(statement.branches, "alt") }];
  } else if (statement.type === "par") {
    children = [{ entries: branchEntries(statement.branches, "par") }];
  } else if (statement.type === "critical") {
    children = [{ entries: branchEntries(statement.branches, "critical") }];
  } else {
    children = [{ entries: statementEntries(statement.statements) }];
  }

  return entry(
    "fragment",
    statement.type,
    statement.type,
    statement.range,
    properties,
    children,
    { fragmentType: statement.type },
  );
}

function statementEntries(statements: Statement[]): Entry[] {
  return statements.flatMap((statement) => {
    if (statement.type === "activation") return [];
    if (statement.type !== "message") {
      return fragmentEntry(statement);
    }

    const semantics = statement.semantics;
    const properties: Properties = {
      from: statement.from,
      to: statement.to,
      label: statement.label,
      lineStyle: statement.lineStyle,
      arrowStyle: statement.arrowStyle,
      semanticName: semantics?.name ?? null,
      semanticKind: semantics?.kind ?? null,
      semanticOperation: semantics?.operation ?? null,
      messageRef: semantics?.messageRef ?? null,
    };
    const item = entry(
      "interaction",
      "message",
      "message",
      statement.range,
      properties,
      [],
      { from: statement.from, to: statement.to },
    );
    return item;
  });
}

function noteEntry(note: NoteNode): Entry {
  const properties: Properties = {
    placement: note.placement,
    participants: stableKey(note.participants),
    text: note.text,
  };
  const candidateProperties = { ...properties, text: "" };
  return entry("note", note.placement, "note", note.range, properties, [], candidateProperties);
}

function buildModel(revision: number, diagram: SequenceDiagram): SnapshotModel {
  const messages = statementEntries(diagram.statements);
  const flattenedMessages: Entry[] = [];
  const walk = (entries: Entry[]) => {
    for (const item of entries) {
      if (item.subtype === "message") flattenedMessages.push(item);
      for (const child of item.children) walk(child.entries);
    }
  };
  walk(messages);
  flattenedMessages.forEach((item, index) => { item.messageOccurrence = index + 1; });

  return {
    revision,
    diagram,
    participants: diagram.participants.map((participant) => entry(
      "participant",
      "participant",
      "participant",
      participant.range,
      { id: participant.id, label: participant.label, participantType: participant.participantType },
      [],
      { id: participant.id },
    )),
    root: { entries: messages },
    notes: diagram.notes.map(noteEntry),
    messages: flattenedMessages,
  };
}

function lcsAlignment(
  before: Entry[],
  after: Entry[],
  spend: (cells: number) => void,
): Alignment {
  const rows = before.length + 1;
  const columns = after.length + 1;
  const cells = rows * columns;
  spend(cells * 2);
  const table = new Uint32Array(cells);
  const prefix = new Uint32Array(cells);
  const at = (row: number, column: number) => row * columns + column;

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[at(i, j)] = before[i]!.key === after[j]!.key
        ? table[at(i + 1, j + 1)] + 1
        : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }
  for (let i = 0; i < before.length; i += 1) {
    for (let j = 0; j < after.length; j += 1) {
      prefix[at(i + 1, j + 1)] = before[i]!.key === after[j]!.key
        ? prefix[at(i, j)]! + 1
        : Math.max(prefix[at(i, j + 1)]!, prefix[at(i + 1, j)]!);
    }
  }

  const rankPairs = new Map<number, Array<[number, number]>>();
  const length = table[0]!;
  for (let i = 0; i < before.length; i += 1) {
    for (let j = 0; j < after.length; j += 1) {
      if (before[i]!.key !== after[j]!.key || prefix[at(i, j)]! + 1 + table[at(i + 1, j + 1)]! !== length) continue;
      const rank = prefix[at(i, j)]!;
      const pairs = rankPairs.get(rank) ?? [];
      pairs.push([i, j]);
      rankPairs.set(rank, pairs);
    }
  }
  const anchors: Array<[number, number]> = [];
  const ambiguous: Array<[number, number]> = [];
  for (const pairs of rankPairs.values()) {
    if (pairs.length === 1) anchors.push(pairs[0]!);
    else ambiguous.push(...pairs);
  }
  anchors.sort((left, right) => left[0] - right[0]);
  return { anchors, ambiguous };
}

function propertyChanges(before: Entry, after: Entry): string[] {
  return [...new Set([...Object.keys(before.properties), ...Object.keys(after.properties)])]
    .filter((name) => before.properties[name] !== after.properties[name])
    .sort();
}

function candidateCompatible(before: Entry, after: Entry): boolean {
  return before.entity === after.entity && before.subtype === after.subtype;
}

function exactCounts(entries: Entry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of entries) counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
  return counts;
}

function groupUniqueCandidates(before: Entry[], after: Entry[]): EntryMatch[] {
  const oldByKey = new Map<string, Entry[]>();
  const newByKey = new Map<string, Entry[]>();
  for (const item of before) {
    const list = oldByKey.get(item.candidateKey) ?? [];
    list.push(item);
    oldByKey.set(item.candidateKey, list);
  }
  for (const item of after) {
    const list = newByKey.get(item.candidateKey) ?? [];
    list.push(item);
    newByKey.set(item.candidateKey, list);
  }
  const matches: EntryMatch[] = [];
  for (const [key, oldItems] of oldByKey) {
    const newItems = newByKey.get(key);
    if (oldItems.length !== 1 || newItems?.length !== 1) continue;
    const oldItem = oldItems[0]!;
    const newItem = newItems[0]!;
    if (!candidateCompatible(oldItem, newItem) || oldItem.key === newItem.key) continue;
    matches.push({ before: oldItem, after: newItem, confidence: "candidate", basis: "unique-compatible-gap" });
  }
  return matches;
}

function messageAtOccurrence(model: SnapshotModel, occurrence: number | null): Entry | undefined {
  return occurrence === null ? undefined : model.messages[occurrence - 1];
}

function compareSnapshots(
  before: SequenceSnapshot,
  after: SequenceSnapshot,
  beforeModel: SnapshotModel,
  afterModel: SnapshotModel,
  maxLcsCells: number,
): SequenceComparison {
  let processedLcsCells = 0;
  const changes: PendingChange[] = [];
  const diagnostics: SequenceComparisonDiagnostic[] = [];
  const indeterminate: SequenceAmbiguityRegion[] = [];
  const unmatched: UnmatchedEntry[] = [];
  const messageMatches = new Map<Entry, { other: Entry; confidence: "confirmed" | "candidate"; basis: string }>();
  const oldGlobalMessageCounts = exactCounts(beforeModel.messages);
  const newGlobalMessageCounts = exactCounts(afterModel.messages);
  let scopeSequence = 0;

  const spend = (cells: number) => {
    if (processedLcsCells + cells > maxLcsCells) throw new ProcessingLimitExceeded();
    processedLcsCells += cells;
  };

  const addChange = (
    match: EntryMatch,
    kind?: "moved" | "reordered",
  ) => {
    if (match.before.subtype === "message") {
      messageMatches.set(match.before, { other: match.after, confidence: match.confidence, basis: match.basis });
    }
    const modifiedProperties = propertyChanges(match.before, match.after);
    if (kind) {
      changes.push({
        entity: match.before.entity,
        kind,
        confidence: match.confidence,
        matchBasis: match.basis,
        before: match.before,
        after: match.after,
        modifiedProperties: [],
      });
    } else if (modifiedProperties.length > 0) {
      changes.push({
        entity: match.before.entity,
        kind: "modified",
        confidence: match.confidence,
        matchBasis: match.basis,
        before: match.before,
        after: match.after,
        modifiedProperties,
      });
    }
    if (!kind) compareChildren(match.before, match.after);
  };

  const markUnmatchedTree = (item: Entry, side: "before" | "after", scopePair: string, ambiguous: boolean) => {
    unmatched.push({ entry: item, side, scopePair, ambiguous });
    for (const child of item.children) {
      const childPair = `${scopePair}/${side}:${nodeIdOf(item.nodeKind, item.range)}/${scopeSequence++}`;
      for (const nested of child.entries) markUnmatchedTree(nested, side, childPair, ambiguous);
    }
  };

  const compareScope = (oldScope: Scope, newScope: Scope, scopePair: string) => {
    const oldItems = oldScope.entries;
    const newItems = newScope.entries;
    const alignment = lcsAlignment(oldItems, newItems, spend);
    const matches: EntryMatch[] = [];
    const matchedOld = new Set<Entry>();
    const matchedNew = new Set<Entry>();
    const ambiguousOld = new Set(alignment.ambiguous.map(([i]) => oldItems[i]!));
    const ambiguousNew = new Set(alignment.ambiguous.map(([, j]) => newItems[j]!));
    const anchors = alignment.anchors;
    const oldCountsForCrossing = exactCounts(oldItems);
    const newCountsForCrossing = exactCounts(newItems);
    const crossingPairs = oldItems.flatMap((item, oldIndex) => {
      const newIndex = newItems.findIndex((candidate) => candidate.key === item.key);
      return newIndex >= 0 && oldCountsForCrossing.get(item.key) === 1 && newCountsForCrossing.get(item.key) === 1
        ? [{ oldIndex, newIndex }]
        : [];
    });
    let oldCursor = 0;
    let newCursor = 0;

    const processGap = (oldEnd: number, newEnd: number) => {
      const oldGap = oldItems.slice(oldCursor, oldEnd);
      const newGap = newItems.slice(newCursor, newEnd);
      const oldCounts = exactCounts(oldGap);
      const newCounts = exactCounts(newGap);
      for (const oldItem of oldGap) {
        if (oldCounts.get(oldItem.key) !== 1 || newCounts.get(oldItem.key) !== 1) continue;
        const newItem = newGap.find((candidate) => candidate.key === oldItem.key)!;
        matches.push({ before: oldItem, after: newItem, confidence: "confirmed", basis: "unique-exact-occurrence" });
        matchedOld.add(oldItem);
        matchedNew.add(newItem);
      }
      const remainingOld = oldGap.filter((item) => !matchedOld.has(item));
      const remainingNew = newGap.filter((item) => !matchedNew.has(item));
      for (const candidate of groupUniqueCandidates(remainingOld, remainingNew).filter((match) =>
        match.before.subtype !== "message" ||
        (newGlobalMessageCounts.get(match.before.key) ?? 0) === 0 &&
        (oldGlobalMessageCounts.get(match.after.key) ?? 0) === 0)) {
        matches.push(candidate);
        matchedOld.add(candidate.before);
        matchedNew.add(candidate.after);
      }
      oldCursor = oldEnd;
      newCursor = newEnd;
    };

    for (const [oldIndex, newIndex] of anchors) {
      if (oldIndex < oldCursor || newIndex < newCursor) continue;
      processGap(oldIndex, newIndex);
      const oldItem = oldItems[oldIndex]!;
      const newItem = newItems[newIndex]!;
      matches.push({ before: oldItem, after: newItem, confidence: "confirmed", basis: "lcs-exact-anchor" });
      matchedOld.add(oldItem);
      matchedNew.add(newItem);
      oldCursor = oldIndex + 1;
      newCursor = newIndex + 1;
    }
    processGap(oldItems.length, newItems.length);
    const ambiguousGaps = new Map<number, { before: Set<Entry>; after: Set<Entry> }>();
    for (const [oldIndex, newIndex] of alignment.ambiguous) {
      const isReorder = crossingPairs.some((pair) => pair.oldIndex === oldIndex && pair.newIndex === newIndex) &&
        crossingPairs.some((pair) => (pair.oldIndex < oldIndex && pair.newIndex > newIndex) || (pair.oldIndex > oldIndex && pair.newIndex < newIndex));
      if (isReorder) continue;
      const gap = anchors.filter(([i, j]) => i < oldIndex && j < newIndex).length;
      const occurrences = ambiguousGaps.get(gap) ?? { before: new Set<Entry>(), after: new Set<Entry>() };
      occurrences.before.add(oldItems[oldIndex]!);
      occurrences.after.add(newItems[newIndex]!);
      ambiguousGaps.set(gap, occurrences);
    }
    for (const occurrences of ambiguousGaps.values()) {
      const expand = (roots: Set<Entry>) => {
        const entries: Entry[] = [];
        const visit = (item: Entry) => {
          entries.push(item);
          for (const child of item.children) child.entries.forEach(visit);
        };
        roots.forEach(visit);
        return [...new Set(entries)];
      };
      const oldAmbiguous = expand(occurrences.before);
      const newAmbiguous = expand(occurrences.after);
      const diagnosticIndex = diagnostics.length;
      diagnostics.push({ code: "ambiguous-match", severity: "warning", message: "Multiple optimal alignments leave these occurrences indeterminate.", ...(oldAmbiguous[0] ? { side: "before" as const, range: oldAmbiguous[0].range } : newAmbiguous[0] ? { side: "after" as const, range: newAmbiguous[0].range } : {}) });
      indeterminate.push({
        id: `sequence-ambiguity-${indeterminate.length + 1}`, cause: "multiple-optimal-alignments", scope: scopePair,
        before: oldAmbiguous.map((item) => ({ entity: item.entity, side: "before", reference: ref(item, before.revision)!, value: { ...item.properties } })),
        after: newAmbiguous.map((item) => ({ entity: item.entity, side: "after", reference: ref(item, after.revision)!, value: { ...item.properties } })),
        ranges: { before: oldAmbiguous.map((item) => item.range), after: newAmbiguous.map((item) => item.range) },
        counts: { before: oldAmbiguous.length, after: newAmbiguous.length },
        evidence: ["Exact occurrence pairs participate in multiple optimal LCS alignments."], diagnosticIndices: [diagnosticIndex],
      });
    }

    const oldUnique = exactCounts(oldItems);
    const newUnique = exactCounts(newItems);
    for (const match of matches) {
      let kind = match.kind;
      if (!kind && match.before.key === match.after.key &&
        oldUnique.get(match.before.key) === 1 && newUnique.get(match.after.key) === 1 &&
        !anchors.some(([i, j]) => oldItems[i] === match.before && newItems[j] === match.after)) {
        kind = "reordered";
        match.basis = "unique-exact-reorder";
      }
      addChange(match, kind);
    }

    const oldCounts = exactCounts(oldItems);
    const newCounts = exactCounts(newItems);
    const commonUnique = oldItems.flatMap((item, oldIndex) => {
      const newIndex = newItems.findIndex((candidate) => candidate.key === item.key);
      return newIndex >= 0 && oldCounts.get(item.key) === 1 && newCounts.get(item.key) === 1
        ? [{ item, oldIndex, newIndex }]
        : [];
    });
    for (const candidate of commonUnique) {
      const reordered = commonUnique.some((other) =>
        (candidate.oldIndex < other.oldIndex && candidate.newIndex > other.newIndex) ||
        (candidate.oldIndex > other.oldIndex && candidate.newIndex < other.newIndex));
      if (!reordered || matchedOld.has(candidate.item)) continue;
      const counterpart = newItems[candidate.newIndex]!;
      if (matchedNew.has(counterpart)) continue;
      matchedOld.add(candidate.item);
      matchedNew.add(counterpart);
      addChange({ before: candidate.item, after: counterpart, confidence: "confirmed", basis: "unique-exact-reorder" }, "reordered");
    }

    for (const item of oldItems) {
      if (!matchedOld.has(item)) markUnmatchedTree(item, "before", scopePair, ambiguousOld.has(item));
    }
    for (const item of newItems) {
      if (!matchedNew.has(item)) markUnmatchedTree(item, "after", scopePair, ambiguousNew.has(item));
    }
  };

  const compareChildren = (oldEntry: Entry, newEntry: Entry) => {
    const count = Math.min(oldEntry.children.length, newEntry.children.length);
    for (let index = 0; index < count; index += 1) {
      compareScope(oldEntry.children[index]!, newEntry.children[index]!, `scope-${scopeSequence++}`);
    }
    for (const child of oldEntry.children.slice(count)) {
      const pair = `before-orphan-${scopeSequence++}`;
      child.entries.forEach((item) => markUnmatchedTree(item, "before", pair, false));
    }
    for (const child of newEntry.children.slice(count)) {
      const pair = `after-orphan-${scopeSequence++}`;
      child.entries.forEach((item) => markUnmatchedTree(item, "after", pair, false));
    }
  };

  const participantOld = new Map(beforeModel.participants.map((item) => [item.properties.id, item]));
  const participantNew = new Map(afterModel.participants.map((item) => [item.properties.id, item]));
  for (const [id, oldItem] of participantOld) {
    const newItem = participantNew.get(id);
    if (newItem) {
      const properties = propertyChanges(oldItem, newItem);
      if (properties.length > 0) changes.push({
        entity: "participant", kind: "modified", confidence: "confirmed", matchBasis: "authored-participant-id",
        before: oldItem, after: newItem, modifiedProperties: properties,
      });
    } else {
      unmatched.push({ entry: oldItem, side: "before", scopePair: "participants", ambiguous: false });
    }
  }
  for (const [id, newItem] of participantNew) {
    if (!participantOld.has(id)) unmatched.push({ entry: newItem, side: "after", scopePair: "participants", ambiguous: false });
  }

  compareScope(beforeModel.root, afterModel.root, "root");

  const oldUnmatchedMessages = unmatched.filter((item) => item.side === "before" && item.entry.subtype === "message" && !item.ambiguous);
  const newUnmatchedMessages = unmatched.filter((item) => item.side === "after" && item.entry.subtype === "message" && !item.ambiguous);
  const oldMessageCounts = exactCounts(oldUnmatchedMessages.map((item) => item.entry));
  const newMessageCounts = exactCounts(newUnmatchedMessages.map((item) => item.entry));
  const movedOld = new Set<UnmatchedEntry>();
  const movedNew = new Set<UnmatchedEntry>();
  for (const oldItem of oldUnmatchedMessages) {
    if (oldMessageCounts.get(oldItem.entry.key) !== 1 || newMessageCounts.get(oldItem.entry.key) !== 1) continue;
    const newItem = newUnmatchedMessages.find((candidate) => candidate.entry.key === oldItem.entry.key)!;
    if (oldItem.scopePair === newItem.scopePair) continue;
    movedOld.add(oldItem);
    movedNew.add(newItem);
    addChange({ before: oldItem.entry, after: newItem.entry, confidence: "confirmed", basis: "unique-exact-message-across-containers" }, "moved");
  }

  const mappedAfterMessage = new Map<Entry, string>();
  for (const [oldEntry, match] of messageMatches) {
    const key = `pair:${nodeIdOf("message", oldEntry.range)}:${nodeIdOf("message", match.other.range)}`;
    mappedAfterMessage.set(oldEntry, key);
    mappedAfterMessage.set(match.other, key);
  }

  const notesByAnchor = (model: SnapshotModel, side: "before" | "after") => {
    const groups = new Map<string, Entry[]>();
    for (const item of model.notes) {
      const note = model.diagram.notes.find((candidate) => candidate.range === item.range)!;
      let anchor: string;
      if (note.placement === "on") {
        const target = messageAtOccurrence(model, note.messageNumber ?? null);
        anchor = (target ? mappedAfterMessage.get(target) : undefined) ?? `${side}:unmatched-message:${note.messageNumber}`;
      } else {
        anchor = stableKey([note.placement, note.participants]);
      }
      const list = groups.get(anchor) ?? [];
      list.push(item);
      groups.set(anchor, list);
    }
    return groups;
  };

  const oldNotes = notesByAnchor(beforeModel, "before");
  const newNotes = notesByAnchor(afterModel, "after");
  const allNoteAnchors = [...new Set([...oldNotes.keys(), ...newNotes.keys()])].sort();
  for (const anchor of allNoteAnchors) {
    const oldItems = oldNotes.get(anchor) ?? [];
    const newItems = newNotes.get(anchor) ?? [];
    if (oldItems.length === 0 || newItems.length === 0) {
      for (const item of oldItems) unmatched.push({ entry: item, side: "before", scopePair: `note:${anchor}`, ambiguous: false });
      for (const item of newItems) unmatched.push({ entry: item, side: "after", scopePair: `note:${anchor}`, ambiguous: false });
      continue;
    }
    compareScope({ entries: oldItems }, { entries: newItems }, `note:${anchor}`);
  }

  for (const item of unmatched) {
    if (movedOld.has(item) || movedNew.has(item) || item.ambiguous) continue;
    changes.push({
      entity: item.entry.entity,
      kind: item.side === "before" ? "removed" : "added",
      confidence: "unmatched",
      before: item.side === "before" ? item.entry : null,
      after: item.side === "after" ? item.entry : null,
      modifiedProperties: [],
    });
  }

  changes.sort((left, right) => {
    const leftRange = left.before?.range ?? left.after?.range;
    const rightRange = right.before?.range ?? right.after?.range;
    const line = (leftRange?.start.line ?? 0) - (rightRange?.start.line ?? 0);
    if (line !== 0) return line;
    const column = (leftRange?.start.column ?? 0) - (rightRange?.start.column ?? 0);
    if (column !== 0) return column;
    return left.entity.localeCompare(right.entity) || left.kind.localeCompare(right.kind);
  });

  const publicChanges: SequenceComparisonChange[] = changes.map((change, index) => ({
    id: `sequence-change-${index + 1}`,
    entity: change.entity,
    kind: change.kind,
    confidence: change.confidence,
    ...(change.matchBasis ? { matchBasis: change.matchBasis } : {}),
    modifiedProperties: change.modifiedProperties,
    before: ref(change.before, before.revision),
    after: ref(change.after, after.revision),
    beforeValue: change.before ? { ...change.before.properties } : null,
    afterValue: change.after ? { ...change.after.properties } : null,
  }));

  return {
    availability: diagnostics.some((diagnostic) => diagnostic.code === "ambiguous-match") ? "partial" : "available",
    beforeRevision: before.revision,
    afterRevision: after.revision,
    changes: publicChanges,
    indeterminate,
    diagnostics,
    limitations: OUT_OF_SCOPE.slice(),
    processedLcsCells,
    maxLcsCells,
  };
}

function invalidResult(
  beforeRevision: number,
  afterRevision: number,
  maxLcsCells: number,
  diagnostics: SequenceComparisonDiagnostic[],
): SequenceComparison {
  return {
    availability: "unavailable",
    beforeRevision,
    afterRevision,
    changes: [],
    indeterminate: [],
    diagnostics,
    limitations: OUT_OF_SCOPE.slice(),
    processedLcsCells: 0,
    maxLcsCells,
  };
}

/** Pure, bounded structural comparison of two independently parsed Sequence snapshots. */
export function compareSequenceSnapshots(
  before: SequenceSnapshot,
  after: SequenceSnapshot,
  options: SequenceComparisonOptions = {},
): SequenceComparison {
  const maxLcsCells = options.maxLcsCells ?? DEFAULT_MAX_LCS_CELLS;
  if (!Number.isSafeInteger(maxLcsCells) || maxLcsCells < 1) {
    return invalidResult(before.revision, after.revision, maxLcsCells, [{
      code: "invalid-snapshot",
      severity: "error",
      message: "maxLcsCells must be a positive safe integer.",
    }]);
  }

  const invalidInput = (snapshot: SequenceSnapshot) =>
    !snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 || typeof snapshot.source !== "string";
  if (invalidInput(before) || invalidInput(after)) {
    return invalidResult(before?.revision ?? 0, after?.revision ?? 0, maxLcsCells, [{
      code: "invalid-snapshot",
      severity: "error",
      message: "Both snapshots require a positive integer revision and string source.",
    }]);
  }

  const oldResult = analyze(before.source);
  const newResult = analyze(after.source);
  const oldInvalid = oldResult.ast === null || oldResult.diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const newInvalid = newResult.ast === null || newResult.diagnostics.some((diagnostic) => diagnostic.severity === "error");
  if (oldInvalid || newInvalid) {
    const diagnostics: SequenceComparisonDiagnostic[] = [];
    for (const [side, result] of [["before", oldResult], ["after", newResult]] as const) {
      for (const diagnostic of result.diagnostics.filter((item) => item.severity === "error")) {
        diagnostics.push({
          code: "invalid-snapshot",
          severity: "error",
          side,
          message: diagnostic.message,
          ...(diagnostic.range ? { range: diagnostic.range } : {}),
        });
      }
      if (result.ast === null && !result.diagnostics.some((item) => item.severity === "error")) {
        diagnostics.push({ code: "invalid-snapshot", severity: "error", side, message: "The parser did not produce a Sequence AST." });
      }
    }
    return invalidResult(before.revision, after.revision, maxLcsCells, diagnostics);
  }

  try {
    return compareSnapshots(
      before,
      after,
      buildModel(before.revision, oldResult.ast!),
      buildModel(after.revision, newResult.ast!),
      maxLcsCells,
    );
  } catch (error) {
    if (!(error instanceof ProcessingLimitExceeded)) throw error;
    return {
      availability: "partial",
      beforeRevision: before.revision,
      afterRevision: after.revision,
      changes: [],
      indeterminate: [],
      diagnostics: [{
        code: "processing-limit",
        severity: "warning",
        message: `Structural matching stopped before comparison because the ${maxLcsCells}-cell processing budget was exceeded; use textual source evidence instead.`,
      }],
      limitations: [
        ...OUT_OF_SCOPE,
        "Structural changes are unavailable because the configured LCS processing budget was exceeded.",
      ],
      processedLcsCells: maxLcsCells,
      maxLcsCells,
    };
  }
}
