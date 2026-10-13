import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourceDiffView } from "../../../src/features/diff/SourceDiffView";

describe("SourceDiffView", () => {
  it("renders changed lines with unchanged context from bounded source hunks", () => {
    render(<SourceDiffView
      source={{ changed: true, hunks: [{ oldStart: 3, newStart: 3, oldLines: ["Old rule."], newLines: ["New rule.", "Added rule."] }], truncated: false, totalHunks: 1, returnedHunks: 1 }}
      beforeContent={"Heading\nUnchanged context.\nOld rule.\nTail"}
      afterContent={"Heading\nUnchanged context.\nNew rule.\nAdded rule.\nTail"}
      mode="side-by-side"
      beforeLabel="Note A"
      afterLabel="Note B"
    />);

    expect(screen.getAllByText("Unchanged context.")).toHaveLength(2);
    expect(screen.getByText("Old rule.").closest(".proposal-review__line")).toHaveClass("proposal-review__line--removed");
    expect(screen.getByText("New rule.").closest(".proposal-review__line")).toHaveClass("proposal-review__line--added");
    expect(screen.getByText("Added rule.").closest(".proposal-review__line")).toHaveClass("proposal-review__line--added");
    expect(screen.getAllByText("Tail")).toHaveLength(2);
  });

  it("falls back to bounded hunks and reports truncation", () => {
    render(<SourceDiffView
      source={{ changed: true, hunks: [{ oldStart: 1, newStart: 1, oldLines: ["Old"], newLines: ["New"] }], truncated: true, totalHunks: 7, returnedHunks: 1 }}
      beforeContent="Old\nUnreturned tail"
      afterContent="New\nUnreturned tail"
      mode="side-by-side"
    />);

    expect(screen.getByRole("status")).toHaveTextContent("showing 1 of 7 hunks");
    expect(screen.getByText("- Old")).toBeInTheDocument();
    expect(screen.getByText("+ New")).toBeInTheDocument();
    expect(screen.queryByText("Unreturned tail")).toBeNull();
  });
});
