import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import AnalysisSurface from "../../../src/features/preview/AnalysisSurface";
import type { AnalysisPreferenceTab } from "../../../src/workspace/ui-preferences";

describe("AnalysisSurface", () => {
  it("switches tabs and preserves panel state while minimized", () => {
    render(<AnalysisSurface
      message={<input aria-label="Message value" defaultValue="kept" />}
      relationships={<p>Relationships content</p>}
      trace={null}
    />);

    expect(screen.getByTestId("analysis-surface")).toHaveClass("analysis-surface--minimized");
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

  it("keeps trace-driven opening temporary while persisting explicit tabs and panel state", () => {
    function ControlledAnalysis() {
      const [traceOpen, setTraceOpen] = useState(false);
      const [preferences, setPreferences] = useState<{ minimized: boolean; height: number; tab: AnalysisPreferenceTab }>({ minimized: true, height: 250, tab: "message" });
      return <>
        <button type="button" onClick={() => setTraceOpen(true)}>Open trace</button>
        <button type="button" onClick={() => setTraceOpen(false)}>Close trace</button>
        <AnalysisSurface
          message={<p>Message</p>}
          relationships={<p>Relationships</p>}
          trace={traceOpen ? <p>Trace content</p> : null}
          minimized={preferences.minimized}
          height={preferences.height}
          preferredTab={preferences.tab}
          onLayoutPreferenceChange={(patch) => setPreferences((current) => ({ ...current, ...patch }))}
        />
        <output data-testid="saved-analysis-preferences">{`${preferences.minimized}:${preferences.tab}:${preferences.height}`}</output>
      </>;
    }
    render(<ControlledAnalysis />);

    expect(screen.getByTestId("analysis-surface")).toHaveClass("analysis-surface--minimized");
    fireEvent.click(screen.getByRole("button", { name: "Open trace" }));
    expect(screen.getByText("Trace content")).toBeVisible();
    expect(screen.getByTestId("analysis-surface")).not.toHaveClass("analysis-surface--minimized");
    expect(screen.getByTestId("saved-analysis-preferences")).toHaveTextContent("true:message:250");

    fireEvent.click(screen.getByRole("tab", { name: "Relationships" }));
    expect(screen.getByTestId("saved-analysis-preferences")).toHaveTextContent("false:relationships:250");
    fireEvent.click(screen.getByRole("button", { name: "Close trace" }));
    expect(screen.getByRole("tab", { name: "Relationships" })).toHaveAttribute("aria-selected", "true");
  });

  it("resizes from the keyboard while preserving minimum preview space", () => {
    render(<AnalysisSurface message={<p>Message</p>} relationships={null} trace={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore analysis panels" }));
    const surface = screen.getByTestId("analysis-surface");
    vi.spyOn(surface.parentElement!, "getBoundingClientRect").mockReturnValue({ height: 800, bottom: 800 } as DOMRect);
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize analysis panels" }), { key: "ArrowUp" });
    expect(surface).toHaveStyle({ flexBasis: "282px" });
  });
});
