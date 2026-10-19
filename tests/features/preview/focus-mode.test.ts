import { describe, expect, it } from "vitest";
import { focusShortcutTargetIsInteractive, hasKeyboardOwningOverlay } from "../../../src/features/preview/focus-mode";

describe("focus mode keyboard guards", () => {
  it.each([
    ["input", "<input />"],
    ["textarea", "<textarea></textarea>"],
    ["select", "<select><option>one</option></select>"],
    ["contenteditable", '<div contenteditable="true"></div>'],
    ["button", "<button>action</button>"],
    ["link", '<a href="/">link</a>'],
    ["focusable control", '<div tabindex="0"></div>'],
    ["menu item", '<div role="menuitem"></div>'],
  ])("ignores the focus chord from %s", (_label, markup) => {
    const target = document.createElement("div");
    target.innerHTML = markup;
    expect(focusShortcutTargetIsInteractive(target.firstElementChild)).toBe(true);
  });

  it("allows the focus chord from non-interactive shell space and the viewer canvas", () => {
    expect(focusShortcutTargetIsInteractive(document.createElement("main"))).toBe(false);
    const canvas = document.createElement("div");
    canvas.className = "viewport__pane";
    canvas.tabIndex = 0;
    expect(focusShortcutTargetIsInteractive(canvas)).toBe(false);
  });

  it("recognizes dialog and menu keyboard owners", () => {
    const root = document.createElement("div");
    expect(hasKeyboardOwningOverlay(root)).toBe(false);
    root.innerHTML = '<section role="dialog"></section>';
    expect(hasKeyboardOwningOverlay(root)).toBe(true);
    root.innerHTML = '<nav role="menu"></nav>';
    expect(hasKeyboardOwningOverlay(root)).toBe(true);
  });
});
