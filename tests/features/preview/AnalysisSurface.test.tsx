import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AnalysisSurface from "../../../src/features/preview/AnalysisSurface";

describe("AnalysisSurface", () => {
  it("switches tabs and preserves panel state while minimized", () => {
    render(<AnalysisSurface
      message={<input aria-label="Message value" defaultValue="kept" />}
      relationships={<p>Relationships content</p>}
      trace={null}
    />);

    fireEvent.click(screen.getByRole("tab", { name: "Relationships" }));
    expect(screen.getByText("Relationships content")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Minimize analysis panels" }));
    expect(screen.getByTestId("analysis-surface")).toHaveClass("analysis-surface--minimized");
    fireEvent.click(screen.getByRole("button", { name: "Restore analysis panels" }));
    fireEvent.click(screen.getByRole("tab", { name: "Message" }));
    expect(screen.getByRole("textbox", { name: "Message value" })).toHaveValue("kept");
  });

  it("selects the Trace tab when a trace opens", () => {
    const view = render(<AnalysisSurface message={null} relationships={null} trace={null} />);
    view.rerender(<AnalysisSurface message={null} relationships={null} trace={<p>Trace content</p>} />);
    expect(screen.getByRole("tab", { name: "Trace" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Trace content")).toBeVisible();
  });

  it("resizes from the keyboard while preserving minimum preview space", () => {
    render(<AnalysisSurface message={<p>Message</p>} relationships={null} trace={null} />);
    const surface = screen.getByTestId("analysis-surface");
    vi.spyOn(surface.parentElement!, "getBoundingClientRect").mockReturnValue({ height: 800, bottom: 800 } as DOMRect);
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize analysis panels" }), { key: "ArrowUp" });
    expect(surface).toHaveStyle({ flexBasis: "282px" });
  });
});
