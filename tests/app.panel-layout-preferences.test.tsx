import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./app-harness";
import { defaultUiPreferences, readUiPreferences, UI_PREFERENCES_KEY, writeUiPreferences } from "../src/workspace/ui-preferences";

let viewportWidth = 1400;
let resizeCallbacks: Array<() => void> = [];

beforeEach(() => {
  viewportWidth = 1400;
  resizeCallbacks = [];
  localStorage.removeItem(UI_PREFERENCES_KEY);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("app__workspace") ? viewportWidth : 0;
  });
});
afterEach(() => {
  cleanup();
  localStorage.removeItem(UI_PREFERENCES_KEY);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("App panel layout preferences", () => {
  it("restores layout after remount and resets all saved layout choices", async () => {
    class TestResizeObserver {
      constructor(private readonly callback: () => void) { resizeCallbacks.push(callback); }
      observe() { /* the test triggers viewport changes directly */ }
      disconnect() {
        resizeCallbacks = resizeCallbacks.filter((callback) => callback !== this.callback);
      }
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const saved = defaultUiPreferences();
    saved.shell.explorerWidth = 368;
    saved.shell.explorerCollapsed = false;
    saved.screens.comparison.editorHidden = false;
    saved.screens.workspace.analysis.minimized = false;
    saved.screens.workspace.analysis.height = 330;
    saved.screens.workspace.analysis.tab = "relationships";
    writeUiPreferences(saved);

    const first = render(<App />);
    expect(screen.getByRole("region", { name: "Project explorer" })).toHaveStyle({ flexBasis: "368px" });
    fireEvent.click(screen.getByRole("button", { name: "Collapse project explorer" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY)!).shell.explorerCollapsed).toBe(true));
    first.unmount();

    render(<App />);
    expect(screen.getByRole("button", { name: "Expand project explorer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand project explorer" })).toBeEnabled();
    expect(readUiPreferences().screens.workspace.analysis).toEqual({ minimized: false, height: 330, tab: "relationships" });

    fireEvent.click(screen.getByRole("button", { name: "Expand project explorer" }));
    await waitFor(() => expect(readUiPreferences().shell.explorerCollapsed).toBe(false));
    viewportWidth = 700;
    resizeCallbacks.forEach((callback) => callback());
    await waitFor(() => expect(screen.getByRole("button", { name: "Project explorer collapsed for narrow window" })).toBeDisabled());
    expect(readUiPreferences().shell.explorerWidth).toBe(368);
    expect(readUiPreferences().shell.explorerCollapsed).toBe(false);

    viewportWidth = 390;
    resizeCallbacks.forEach((callback) => callback());
    await waitFor(() => expect(screen.getByTestId("app-shell").querySelector(".app__workspace")).toHaveClass("app__workspace--comparison-editor-hidden"));
    expect(readUiPreferences().shell.explorerWidth).toBe(368);

    viewportWidth = 1400;
    resizeCallbacks.forEach((callback) => callback());
    await waitFor(() => expect(screen.getByRole("region", { name: "Project explorer" })).toHaveStyle({ flexBasis: "368px" }));

    const serialized = JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY)!);
    expect(serialized).not.toHaveProperty("selectedResourceId");
    expect(serialized).not.toHaveProperty("selectedNodeId");
    fireEvent.click(screen.getByTestId("workspace-settings"));
    expect(screen.getByTestId("workspace-settings-page")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("reset-panel-layout"));
    expect(localStorage.getItem(UI_PREFERENCES_KEY)).toBeNull();
    fireEvent.click(screen.getByTestId("workspace-settings-back"));
    expect(screen.getByRole("region", { name: "Project explorer" })).toHaveStyle({ flexBasis: "252px" });
  });
});
