import { describe, expect, it } from "vitest";
import { defaultUiPreferences, effectiveShellLayout, parseUiPreferences, readUiPreferences, resetUiPreferences, UI_PREFERENCES_KEY, writeUiPreferences, type UiPreferenceStorage } from "../../src/workspace/ui-preferences";

function memoryStorage(initial: string | null = null): UiPreferenceStorage & { value: string | null } {
  return {
    value: initial,
    getItem() { return this.value; },
    setItem(_key, value) { this.value = value; },
    removeItem() { this.value = null; },
  };
}

describe("versioned local UI preferences", () => {
  it("starts with the analysis pane minimized and uses the existing shell defaults", () => {
    const defaults = defaultUiPreferences();
    expect(defaults.shell).toEqual({ explorerWidth: 252, explorerCollapsed: false, editorWidth: null });
    expect(defaults.screens.workspace.analysis).toEqual({ minimized: true, height: 250, tab: "message" });
    expect(defaults.screens.comparison.summaryHeight).toBeNull();
  });

  it("round-trips only the known versioned layout fields", () => {
    const storage = memoryStorage();
    const saved = defaultUiPreferences();
    saved.shell.explorerCollapsed = true;
    saved.shell.explorerWidth = 342;
    saved.screens.workspace.analysis = { minimized: false, height: 410, tab: "relationships" };
    saved.screens.workspace.explorerSections.myWork = false;
    saved.screens.comparison.summaryHeight = 280;
    saved.screens.proposalReview.listCollapsed = true;

    writeUiPreferences(saved, storage);

    expect(JSON.parse(storage.value!)).toEqual(saved);
    expect(readUiPreferences(storage)).toEqual(saved);
  });

  it("uses defaults for a missing or unknown version without overwriting unknown data", () => {
    const storage = memoryStorage('{"version":2,"futureField":true}');
    expect(readUiPreferences(storage)).toEqual(defaultUiPreferences());
    writeUiPreferences(defaultUiPreferences(), storage);
    expect(storage.value).toContain('"version":2');
  });

  it("recovers from corrupt or partial data field-by-field", () => {
    const storage = memoryStorage("not-json");
    expect(readUiPreferences(storage)).toEqual(defaultUiPreferences());
    expect(storage.value).toBeNull();

    expect(parseUiPreferences(JSON.stringify({
      version: 1,
      shell: { explorerWidth: -1, explorerCollapsed: true, editorWidth: "wide" },
      screens: { workspace: { analysis: { minimized: false, height: Infinity, tab: "trace" }, explorerSections: { shared: true, myWork: "yes" } } },
    }))).toMatchObject({
      shell: { explorerWidth: 252, explorerCollapsed: true, editorWidth: null },
      screens: { workspace: { analysis: { minimized: false, height: 250, tab: "message" }, explorerSections: { shared: true } } },
    });
  });

  it("tolerates storage access failures and restores defaults by removing the key", () => {
    const blocked: UiPreferenceStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    expect(readUiPreferences(blocked)).toEqual(defaultUiPreferences());
    expect(() => writeUiPreferences(defaultUiPreferences(), blocked)).not.toThrow();
    expect(() => resetUiPreferences(blocked)).not.toThrow();

    const storage = memoryStorage("old");
    resetUiPreferences(storage);
    expect(storage.value).toBeNull();
    expect(UI_PREFERENCES_KEY).toMatch(/ui-preferences/);
  });

  it("keeps desired widths while applying a compact effective layout for narrow windows", () => {
    const desired = defaultUiPreferences();
    desired.shell.explorerWidth = 420;
    desired.shell.editorWidth = 620;

    const wide = effectiveShellLayout(desired, 1440);
    expect(wide).toMatchObject({ explorerCollapsed: false, explorerWidth: 420, editorWidth: 620, editorResponsiveHidden: false });

    const narrow = effectiveShellLayout(desired, 700);
    expect(narrow).toMatchObject({ explorerCollapsed: true, explorerResponsiveCollapsed: true, editorWidth: 382, editorResponsiveHidden: false });

    const phone = effectiveShellLayout(desired, 390);
    expect(phone).toMatchObject({ explorerCollapsed: true, explorerResponsiveCollapsed: true, editorResponsiveHidden: true });
    expect(desired.shell).toEqual({ explorerWidth: 420, explorerCollapsed: false, editorWidth: 620 });
  });
});
