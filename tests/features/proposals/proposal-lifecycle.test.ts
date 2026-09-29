import { describe, expect, it } from "vitest";
import { proposalLifecycle } from "../../../src/features/proposals/proposal-lifecycle";

const base = { status: "open" as const };

describe("proposal lifecycle derivation", () => {
  it.each([
    [{}, "OPEN"],
    [{ reviews: { status: "changes-requested" } }, "CHANGES_REQUESTED"],
    [{ reviews: { status: "approved" } }, "APPROVED"],
    [{ lifecycle: { state: "PROMOTING" } }, "PROMOTING"],
    [{ lifecycle: { state: "PROMOTED" } }, "PROMOTED"],
  ] as Array<[Record<string, unknown>, string]>) ("derives %s", (input, expected) => {
    expect(proposalLifecycle({ ...base, lifecycle: input.lifecycle as { state: "PROMOTING" | "PROMOTED" } | undefined }, input.reviews as { status: "changes-requested" | "approved" } | undefined)).toBe(expected);
  });

  it("preserves terminal proposal status over reviews", () => {
    expect(proposalLifecycle({ status: "withdrawn" }, { status: "approved" })).toBe("WITHDRAWN");
    expect(proposalLifecycle({ status: "superseded" }, { status: "approved" })).toBe("SUPERSEDED");
  });
});
