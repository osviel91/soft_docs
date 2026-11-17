import { describe, expect, it } from "vitest";
import { compareSequenceSnapshots } from "../../../src/domain/diff/sequence-comparison";

const snapshot = (revision: number, source: string) => ({ revision, source });
const compare = (before: string, after: string, maxLcsCells?: number) =>
  compareSequenceSnapshots(snapshot(1, before), snapshot(2, after), { maxLcsCells });
const message = (label: string) => `A ->> B: ${label}`;

describe("compareSequenceSnapshots", () => {
  it("reports inserted/deleted prefix messages without false reorders", () => {
    const result = compare(
      `participant A\nparticipant B\n${message("one")}\n${message("two")}`,
      `participant A\nparticipant B\n${message("zero")}\n${message("one")}\n${message("two")}`,
    );
    expect(result.changes.map(({ kind, afterValue }) => [kind, afterValue?.label])).toEqual([["added", "zero"]]);
    expect(result.changes.some((change) => change.kind === "reordered")).toBe(false);
    const reordered = compare(
      `participant A\nparticipant B\n${message("one")}\n${message("two")}`,
      `participant A\nparticipant B\n${message("two")}\n${message("one")}`,
    );
    expect(reordered.changes.filter((change) => change.kind === "reordered")).toHaveLength(2);
  });

  it("pairs exact repeated messages conservatively and reports property edits as candidates", () => {
    const result = compare(
      `participant A\nparticipant B\n${message("same")}\n${message("same")}`,
      `participant A\nparticipant B\n${message("same")}\n${message("same")}\n${message("last")}`,
    );
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ kind: "added", afterValue: { label: "last" } });

    const changed = compare(`participant A\nparticipant B\n${message("old")}`, `participant A\nparticipant B\n${message("new")}`);
    expect(changed.changes).toContainEqual(expect.objectContaining({
      entity: "interaction", kind: "modified", confidence: "candidate", modifiedProperties: ["label"],
    }));
  });

  it("matches participants by authored id and reports label changes", () => {
    const result = compare("participant A as \"Old\"", "participant A as \"New\"");
    expect(result.changes[0]).toMatchObject({
      entity: "participant", kind: "modified", confidence: "confirmed", matchBasis: "authored-participant-id",
    });
    const renamed = compare("participant A", "participant B");
    expect(renamed.changes.map((change) => change.kind).sort()).toEqual(["added", "removed"]);
  });

  it("compares nested fragments and reports an exact interaction moved between containers", () => {
    const before = `participant A\nparticipant B\nalt ok\n  ${message("same")}\nelse no\n  ${message("other")}\nend`;
    const after = `participant A\nparticipant B\nalt ok\n  ${message("other")}\nelse no\n  ${message("same")}\nend`;
    const result = compare(before, after);
    expect(result.changes.some((change) => change.kind === "moved" && change.entity === "interaction")).toBe(true);
  });

  it("preserves alt/else, par/and, loop, opt, and nested fragment scopes", () => {
    const before = `participant A\nparticipant B\nloop retry\n  alt ready\n    ${message("work")}\n  else wait\n    ${message("wait")}\n  end\nend\npar left\n  ${message("left")}\nand right\n  opt optional\n    ${message("right")}\n  end\nend`;
    const after = before.replace("work", "work changed").replace("optional", "optional changed");
    const result = compare(before, after);
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "modified", entity: "interaction" }),
      expect.objectContaining({ kind: "modified", entity: "fragment" }),
    ]));
  });

  it("does not guess between repeated occurrences in an ambiguous ordering", () => {
    const result = compare(
      `participant A\nparticipant B\n${message("same")}\n${message("same")}`,
      `participant A\nparticipant B\n${message("same")}`,
    );
    expect(result.availability).toBe("partial");
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "ambiguous-match")).toBe(true);
  });

  it("tracks notes on matched occurrences after an ordinal shift", () => {
    const before = `participant A\nparticipant B\n${message("target")}\nnote on 1: before`;
    const after = `participant A\nparticipant B\n${message("inserted")}\n${message("target")}\nnote on 2: after`;
    const result = compare(before, after);
    expect(result.changes).toHaveLength(2);
    expect(result.changes.map((change) => change.entity)).toEqual(["interaction", "note"]);
    expect(result.changes[1]).toMatchObject({ kind: "modified", confidence: "candidate" });
  });

  it("returns unavailable for invalid snapshots and explicit partial fallback at budget", () => {
    expect(compare("participant A\nA ->> Missing: bad", "participant A").availability).toBe("unavailable");
    const limited = compare(`participant A\nparticipant B\n${message("a")}`, `participant A\nparticipant B\n${message("b")}`, 1);
    expect(limited).toMatchObject({
      availability: "partial", changes: [], processedLcsCells: 1,
      diagnostics: [expect.objectContaining({ code: "processing-limit" })],
    });
  });

  it("is deterministic across repeated calls", () => {
    const input = ["participant A", "participant B", message("one"), message("two")].join("\n");
    expect(compare(input, `${input}\n${message("three")}`)).toEqual(compare(input, `${input}\n${message("three")}`));
  });
});
