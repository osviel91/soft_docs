const INTERACTIVE_TARGET = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='menuitem']",
  "[role='option']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Interactive controls and editors own their keys; the diagram canvas is exempt. */
export function focusShortcutTargetIsInteractive(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".viewport__pane")) return false;
  return Boolean(target.closest(INTERACTIVE_TARGET));
}

/** Overlays and menus own Escape before the workspace focus mode does. */
export function hasKeyboardOwningOverlay(root: ParentNode = document): boolean {
  return Boolean(root.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [aria-modal="true"]'));
}
