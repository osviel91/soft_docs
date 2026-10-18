export const UI_PREFERENCES_KEY = "sequencediagrams.ui-preferences";

export type AnalysisPreferenceTab = "message" | "relationships";
export type TracePanelMode = "minimized" | "normal" | "expanded";
export type ExplorerSection = "shared" | "myWork" | "proposals" | "local" | "archivedWork" | "archivedProposals";

export const EXPLORER_MIN_WIDTH = 180;
export const EDITOR_MIN_WIDTH = 280;
export const PREVIEW_COMFORT_WIDTH = 280;
const SPLITTER_WIDTH = 8;
const EXPLORER_COLLAPSED_WIDTH = 30;

export interface UiPreferences {
  version: 1;
  shell: {
    explorerWidth: number;
    explorerCollapsed: boolean;
    /** `null` means use the CSS flex default until the user resizes the editor. */
    editorWidth: number | null;
  };
  screens: {
    workspace: {
      analysis: { minimized: boolean; height: number; tab: AnalysisPreferenceTab };
      explorerSections: Partial<Record<ExplorerSection, boolean>>;
      localProjectsExpanded: boolean;
    };
    comparison: {
      editorHidden: boolean;
      summaryHeight: number | null;
      traceHeight: number;
      traceMode: TracePanelMode;
    };
    proposalReview: { listCollapsed: boolean };
  };
}

export interface UiPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface EffectiveShellLayout {
  explorerCollapsed: boolean;
  explorerResponsiveCollapsed: boolean;
  explorerWidth: number;
  editorWidth: number | null;
  editorResponsiveHidden: boolean;
}

export function defaultUiPreferences(): UiPreferences {
  return {
    version: 1,
    shell: { explorerWidth: 252, explorerCollapsed: false, editorWidth: null },
    screens: {
      workspace: {
        analysis: { minimized: true, height: 250, tab: "message" },
        explorerSections: {},
        localProjectsExpanded: true,
      },
      comparison: { editorHidden: true, summaryHeight: null, traceHeight: 420, traceMode: "normal" },
      proposalReview: { listCollapsed: false },
    },
  };
}

/** Apply viewport-specific bounds without overwriting the user's desired sizes. */
export function effectiveShellLayout(preferences: UiPreferences, availableWidth: number): EffectiveShellLayout {
  const width = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : 0;
  if (width === 0) {
    return {
      explorerCollapsed: preferences.shell.explorerCollapsed,
      explorerResponsiveCollapsed: false,
      explorerWidth: Math.min(252, preferences.shell.explorerWidth),
      editorWidth: null,
      editorResponsiveHidden: false,
    };
  }
  const expandedMinimum = EXPLORER_MIN_WIDTH + EDITOR_MIN_WIDTH + PREVIEW_COMFORT_WIDTH + SPLITTER_WIDTH * 2;
  const explorerResponsiveCollapsed = width > 0 && width < expandedMinimum;
  const explorerCollapsed = preferences.shell.explorerCollapsed || explorerResponsiveCollapsed;
  const maxExplorerWidth = width > 0 ? Math.max(EXPLORER_MIN_WIDTH, width - EDITOR_MIN_WIDTH - PREVIEW_COMFORT_WIDTH - SPLITTER_WIDTH * 2) : Number.POSITIVE_INFINITY;
  const explorerWidth = Math.min(maxExplorerWidth, Math.max(EXPLORER_MIN_WIDTH, preferences.shell.explorerWidth));
  const explorerSpace = explorerCollapsed ? EXPLORER_COLLAPSED_WIDTH : explorerWidth + SPLITTER_WIDTH;
  const compactMinimum = EXPLORER_COLLAPSED_WIDTH + EDITOR_MIN_WIDTH + PREVIEW_COMFORT_WIDTH + SPLITTER_WIDTH;
  const editorResponsiveHidden = width > 0 && width < compactMinimum;
  const maxEditorWidth = width > 0 ? Math.max(EDITOR_MIN_WIDTH, width - explorerSpace - PREVIEW_COMFORT_WIDTH - SPLITTER_WIDTH) : Number.POSITIVE_INFINITY;
  const desiredEditorWidth = preferences.shell.editorWidth;
  const editorWidth = desiredEditorWidth === null ? null : Math.min(maxEditorWidth, Math.max(EDITOR_MIN_WIDTH, desiredEditorWidth));
  return { explorerCollapsed, explorerResponsiveCollapsed, explorerWidth, editorWidth, editorResponsiveHidden };
}

function browserStorage(): UiPreferenceStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function optionalPositive(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Read only the versioned layout fields; malformed values fall back independently. */
export function parseUiPreferences(raw: string | null): UiPreferences {
  const defaults = defaultUiPreferences();
  if (raw === null) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults;
  }
  const root = record(parsed);
  if (!root || root.version !== 1) return defaults;
  const shell = record(root.shell);
  const screens = record(root.screens);
  const workspace = record(screens?.workspace);
  const analysis = record(workspace?.analysis);
  const comparison = record(screens?.comparison);
  const proposalReview = record(screens?.proposalReview);
  const sectionValues = record(workspace?.explorerSections);
  const explorerSections: UiPreferences["screens"]["workspace"]["explorerSections"] = {};
  for (const section of ["shared", "myWork", "proposals", "local", "archivedWork", "archivedProposals"] as const) {
    if (typeof sectionValues?.[section] === "boolean") explorerSections[section] = sectionValues[section] as boolean;
  }

  return {
    version: 1,
    shell: {
      explorerWidth: finitePositive(shell?.explorerWidth, defaults.shell.explorerWidth),
      explorerCollapsed: typeof shell?.explorerCollapsed === "boolean" ? shell.explorerCollapsed : defaults.shell.explorerCollapsed,
      editorWidth: optionalPositive(shell?.editorWidth) ?? (shell?.editorWidth === null ? null : defaults.shell.editorWidth),
    },
    screens: {
      workspace: {
        analysis: {
          minimized: typeof analysis?.minimized === "boolean" ? analysis.minimized : defaults.screens.workspace.analysis.minimized,
          height: finitePositive(analysis?.height, defaults.screens.workspace.analysis.height),
          tab: analysis?.tab === "relationships" ? "relationships" : analysis?.tab === "message" ? "message" : defaults.screens.workspace.analysis.tab,
        },
        explorerSections,
        localProjectsExpanded: typeof workspace?.localProjectsExpanded === "boolean" ? workspace.localProjectsExpanded : defaults.screens.workspace.localProjectsExpanded,
      },
      comparison: {
        editorHidden: typeof comparison?.editorHidden === "boolean" ? comparison.editorHidden : defaults.screens.comparison.editorHidden,
        summaryHeight: optionalPositive(comparison?.summaryHeight) ?? (comparison?.summaryHeight === null ? null : defaults.screens.comparison.summaryHeight),
        traceHeight: finitePositive(comparison?.traceHeight, defaults.screens.comparison.traceHeight),
        traceMode: comparison?.traceMode === "minimized" || comparison?.traceMode === "expanded" || comparison?.traceMode === "normal" ? comparison.traceMode : defaults.screens.comparison.traceMode,
      },
      proposalReview: {
        listCollapsed: typeof proposalReview?.listCollapsed === "boolean" ? proposalReview.listCollapsed : defaults.screens.proposalReview.listCollapsed,
      },
    },
  };
}

export function readUiPreferences(storage: UiPreferenceStorage | null = browserStorage()): UiPreferences {
  if (!storage) return defaultUiPreferences();
  try {
    const raw = storage.getItem(UI_PREFERENCES_KEY);
    if (raw === null) return defaultUiPreferences();
    try {
      const parsed: unknown = JSON.parse(raw);
      if (record(parsed)?.version !== 1) return defaultUiPreferences();
      return parseUiPreferences(raw);
    } catch {
      try { storage.removeItem(UI_PREFERENCES_KEY); } catch { /* keep defaults in memory */ }
      return defaultUiPreferences();
    }
  } catch {
    return defaultUiPreferences();
  }
}

export function writeUiPreferences(preferences: UiPreferences, storage: UiPreferenceStorage | null = browserStorage()): void {
  if (!storage) return;
  try {
    const existing = storage.getItem(UI_PREFERENCES_KEY);
    if (existing !== null) {
      try {
        if (record(JSON.parse(existing))?.version !== 1) return;
      } catch {
        // A malformed value may be replaced by the validated in-memory state.
      }
    }
    storage.setItem(UI_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // The current session remains usable when browser storage is blocked or full.
  }
}

export function resetUiPreferences(storage: UiPreferenceStorage | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(UI_PREFERENCES_KEY);
  } catch {
    // Defaults still apply in memory when browser storage is unavailable.
  }
}
