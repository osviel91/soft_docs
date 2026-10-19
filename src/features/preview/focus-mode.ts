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

/** Plain F belongs to the focused editor or control, not the workspace shell. */
export function focusShortcutTargetIsInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(INTERACTIVE_TARGET));
}

/** Overlays and menus own Escape before the workspace focus mode does. */
export function hasKeyboardOwningOverlay(root: ParentNode = document): boolean {
  return Boolean(root.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [aria-modal="true"]'));
}
