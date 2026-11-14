// Patch 1.9 Task 30, menus with Back and Next instead of scrolling (Avi, 2026-11-13): the arithmetic every paged list shares.
// Pure: no React, no DOM. Rows per page are fixed per list (Avi's choice 1), sized so a page fits the panel without a scroll.

/** Rows a page shows, per list (the Show choice "Fit (N)"). */
export const PAGE_SIZES = { gladiators: 7, standings: 10, tournaments: 6, results: 8, bouts: 8, market: 3, notifications: 6, messages: 3,
  patches: 8, future: 8, wikiTopics: 5, history: 6, titles: 4, feedback: 6, buyBack: 5,
  /** Task 31 fix round 1: the Tournaments panel's bouts and placements keep a Show choice of their own (the entrants use `tournaments`). */
  tournamentBouts: 6, placements: 6,
  /** Final review M4 (add-only): Your rewards (Results) and the editor's Feedback list keep a Show choice of their own (not Everyone's, nor the player's own feedback's). */
  rewards: 8, feedbackReview: 6 } as const;
export type ListId = keyof typeof PAGE_SIZES;
/** A grid's page: whole rows of tiles, 6x4 on desktop and 5x3 on a phone. */
export const GRID_PAGE = { desktop: 24, phone: 15 } as const;
/** The Show choices above Fit. */
export const SHOW_CHOICES = [10, 25, 50] as const;
/** The most circles a bar shows: desktop, phone, and a screen under 360 px (9 phone circles of 32 px do not fit 320 px). */
export const MAX_DOTS = { desktop: 12, phone: 9, narrow: 7 } as const;

/** The Show choices of a list: its own Fit first, then every larger choice. */
export function showChoices(fit: number): readonly number[] {
  return [fit, ...SHOW_CHOICES.filter(choice => choice > fit)];
}

/** How many pages `total` rows make, at least one (an empty list is one empty page). */
export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, size)));
}

/** A whole page number in 1..pages. */
export function clampPage(page: number, pages: number): number {
  return Math.min(Math.max(1, Math.floor(page)), Math.max(1, pages));
}

/** The rows of a page; a page past the end shows the last one. */
export function pageRows<T>(rows: readonly T[], page: number, size: number): readonly T[] {
  const at = clampPage(page, pageCount(rows.length, size));
  return rows.slice((at - 1) * size, at * size);
}

/** The page that holds row `index` (0-based). */
export function pageOfIndex(index: number, size: number): number {
  return Math.floor(Math.max(0, index) / Math.max(1, size)) + 1;
}

/** The bar's label: "Page 2 of 5", or "Page 2" with "more to see" while the total is unknown (`pages` null). */
export function pagerLabel(page: number, pages: number | null): { main: string; sub: string | null } {
  return pages === null ? { main: `Page ${page}`, sub: 'more to see' } : { main: `Page ${page} of ${pages}`, sub: null };
}

/**
 * The circles to show: every page when they fit in `max`; otherwise the first and the last, a window around the current page
 * (`max` - 4 wide, one more on a side with no gap), and a gap mark for each hidden run.
 */
export function dotWindow(page: number, pages: number, max: number): readonly (number | 'gap')[] {
  const all = Math.max(1, pages);
  if (all <= max) return Array.from({ length: all }, (_, i) => i + 1);
  const width = Math.max(1, max - 4);
  const current = clampPage(page, all);
  let start = Math.max(2, Math.min(current - Math.floor((width - 1) / 2), all - width));
  let end = Math.min(all - 1, start + width - 1);
  // A side with no gap mark gives its place to one more circle.
  if (start === 2) end = Math.min(all - 1, end + 1);
  else if (end === all - 1) start = Math.max(2, start - 1);
  const dots: (number | 'gap')[] = [1];
  if (start > 2) dots.push('gap');
  for (let p = start; p <= end; p++) dots.push(p);
  if (end < all - 1) dots.push('gap');
  dots.push(all);
  return dots;
}

/**
 * The page under a finger (or a held mouse) sliding along a windowed row of circles (fix round 1, I3): measured from the circle it
 * pressed, `dx` pixels along a row `width` pixels wide that stands for all `pages`. A finger that stays still stays on its circle.
 */
export function slidePage(startPage: number, dx: number, width: number, pages: number): number {
  if (width <= 0) return clampPage(startPage, pages);
  return clampPage(startPage + Math.round((dx / width) * (Math.max(1, pages) - 1)), pages);
}
