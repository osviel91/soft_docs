import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TraceSurface from "../../../src/features/preview/TraceSurface";
import { createProjectIndexer } from "../../../src/domain/project/indexer";

function index() {
  return createProjectIndexer().update("p", [{
    descriptor: { id: "seq", projectId: "p", path: "trace.seq", type: "sequence-diagram", title: "Trace" },
    content: "participant A\nparticipant B\nA ->> B: Raised\nsemantic event publish Raised",
  }], { format: "software-docs", version: 1, resources: [{ id: "seq", path: "trace.seq", type: "sequence-diagram", title: "Trace" }], semanticMessages: [{ id: "raised", name: "Raised", kind: "event" }] });
}

describe("TraceSurface", () => {
  it("minimizes and restores without losing trace controls", () => {
    render(<TraceSurface index={index()} start={{ messageId: "raised" }} direction="both" provenance="active viewer" onOpenResource={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Depth"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Minimize Architectural Trace" }));
    expect(screen.getByTestId("trace-surface")).toHaveClass("trace-surface--minimized");
    fireEvent.click(screen.getByRole("button", { name: "Restore Architectural Trace" }));
    expect(screen.getByLabelText("Depth")).toHaveValue(12);
  });

  it("supports maximize and keyboard splitter resizing while retaining provenance", () => {
    const view = render(<TraceSurface index={index()} start={{ messageId: "raised" }} direction="upstream" provenance="Viewer B" onOpenResource={vi.fn()} />);
    expect(screen.getByTestId("trace-surface")).toHaveAttribute("data-provenance", "Viewer B");
    expect(screen.getByLabelText("Direction")).toHaveValue("upstream");
    view.rerender(<TraceSurface index={index()} start={{ messageId: "raised" }} direction="downstream" provenance="Viewer A" onOpenResource={vi.fn()} />);
    expect(screen.getByTestId("trace-surface")).toHaveAttribute("data-provenance", "Viewer A");
    expect(screen.getByLabelText("Direction")).toHaveValue("downstream");
    fireEvent.click(screen.getByRole("button", { name: "Maximize Architectural Trace" }));
    expect(screen.getByTestId("trace-surface")).toHaveClass("trace-surface--expanded");
    const splitter = screen.getByRole("separator");
    fireEvent.keyDown(splitter, { key: "ArrowUp" });
    fireEvent.click(screen.getByRole("button", { name: "Restore Architectural Trace" }));
    expect(screen.getByTestId("trace-surface")).toHaveClass("trace-surface--normal");
  });
});
