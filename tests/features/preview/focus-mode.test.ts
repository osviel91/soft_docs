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
  ])("ignores plain F from %s", (_label, markup) => {
    const target = document.createElement("div");
    target.innerHTML = markup;
    expect(focusShortcutTargetIsInteractive(target.firstElementChild)).toBe(true);
  });

  it("allows plain F from non-interactive shell space", () => {
    expect(focusShortcutTargetIsInteractive(document.createElement("main"))).toBe(false);
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
