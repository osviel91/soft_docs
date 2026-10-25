import { describe, expect, it } from "vitest";
import { isValidMarkdownScrollSnapshot, markdownRestoreScrollTop, markdownScrollSnapshot } from "../../../src/features/preview/markdown-scroll-snapshot";

describe("Markdown scroll snapshots", () => {
  it("captures an absolute offset, normalized progress, and the source geometry", () => {
    expect(markdownScrollSnapshot(250, 1_000, 500)).toEqual({ scrollTop: 250, scrollRatio: 0.5, maxScroll: 500 });
  });

  it("uses zero progress when content has no scrollable range", () => {
    expect(markdownScrollSnapshot(20, 200, 240)).toEqual({ scrollTop: 0, scrollRatio: 0, maxScroll: 0 });
    expect(markdownRestoreScrollTop({ scrollTop: 0, scrollRatio: 0, maxScroll: 0 }, 200, 240)).toBe(0);
  });

  it("normalizes invalid inputs and clamps negative or excessive offsets", () => {
    expect(markdownScrollSnapshot(Number.NaN, Number.POSITIVE_INFINITY, 40)).toEqual({ scrollTop: 0, scrollRatio: 0, maxScroll: 0 });
    expect(markdownScrollSnapshot(-9, 900, 400)).toEqual({ scrollTop: 0, scrollRatio: 0, maxScroll: 500 });
    expect(markdownScrollSnapshot(900, 900, 400)).toEqual({ scrollTop: 500, scrollRatio: 1, maxScroll: 500 });
    expect(markdownScrollSnapshot(Number.POSITIVE_INFINITY, 900, 400).scrollTop).toBe(0);
  });

  it("prefers scrollTop for comparable geometry and uses the ratio when it changes significantly", () => {
    const snapshot = { scrollTop: 300, scrollRatio: 0.5, maxScroll: 600 };
    expect(markdownRestoreScrollTop(snapshot, 1_220, 600)).toBe(300);
    expect(markdownRestoreScrollTop(snapshot, 1_600, 400)).toBe(600);
    expect(markdownRestoreScrollTop({ scrollTop: 900, scrollRatio: 0.75, maxScroll: 1_200 }, 900, 400)).toBe(375);
  });

  it("validates finite normalized values before the controller accepts them", () => {
    expect(isValidMarkdownScrollSnapshot({ scrollTop: 10, scrollRatio: 0.5, maxScroll: 20 })).toBe(true);
    expect(isValidMarkdownScrollSnapshot({ scrollTop: Number.NaN, scrollRatio: 0, maxScroll: 20 })).toBe(false);
    expect(isValidMarkdownScrollSnapshot({ scrollTop: 10, scrollRatio: 1.2, maxScroll: 20 })).toBe(false);
    expect(isValidMarkdownScrollSnapshot({ scrollTop: 10, scrollRatio: 0.5, maxScroll: -1 })).toBe(false);
  });
});
