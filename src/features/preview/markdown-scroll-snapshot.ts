import type { MarkdownScrollSnapshot } from "./visual-session-controller";

const MIN_COMPARABLE_RANGE_DELTA = 48;
const COMPARABLE_RANGE_RATIO = 0.1;

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp(value: number, maximum: number): number {
  return Math.min(finiteNonNegative(value), maximum);
}

/** Capture bounded reading state from the actual Markdown scroll container. */
export function markdownScrollSnapshot(scrollTop: number, scrollHeight: number, clientHeight: number): MarkdownScrollSnapshot {
  const maxScroll = Math.max(0, finiteNonNegative(scrollHeight) - finiteNonNegative(clientHeight));
  const boundedScrollTop = clamp(scrollTop, maxScroll);
  return {
    scrollTop: boundedScrollTop,
    scrollRatio: maxScroll === 0 ? 0 : boundedScrollTop / maxScroll,
    maxScroll,
  };
}

export function isValidMarkdownScrollSnapshot(value: MarkdownScrollSnapshot): boolean {
  return Number.isFinite(value.scrollTop) && value.scrollTop >= 0
    && Number.isFinite(value.scrollRatio) && value.scrollRatio >= 0 && value.scrollRatio <= 1
    && Number.isFinite(value.maxScroll) && value.maxScroll >= 0;
}

/**
 * Restore by absolute offset when the scrollable range is comparable. A range
 * change greater than max(48px, 10%) uses normalized progress instead.
 */
export function markdownRestoreScrollTop(snapshot: MarkdownScrollSnapshot, scrollHeight: number, clientHeight: number): number {
  const maxScroll = Math.max(0, finiteNonNegative(scrollHeight) - finiteNonNegative(clientHeight));
  if (maxScroll === 0) return 0;
  const comparableDelta = Math.max(MIN_COMPARABLE_RANGE_DELTA, snapshot.maxScroll * COMPARABLE_RANGE_RATIO);
  const geometryComparable = Math.abs(maxScroll - snapshot.maxScroll) <= comparableDelta;
  const target = geometryComparable ? snapshot.scrollTop : snapshot.scrollRatio * maxScroll;
  return clamp(target, maxScroll);
}
