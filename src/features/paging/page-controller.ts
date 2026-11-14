// Patch 1.9 Task 30: the state behind `usePagedList`, kept out of React so it is tested on its own. The page asked for is kept
// as is; what is shown is that page clamped to the rows there are now, so a background refresh keeps the page number and a page
// that no longer exists shows the last one. Next past the loaded rows reads more once (a press while it reads does nothing); a
// failed read keeps the page and says so. No DOM.
import { clampPage, pageCount, pageOfIndex } from './paging';

export type PageInput = {
  /** The rows loaded now. */
  total: number;
  size: number;
  /** More rows can be read (a cursor list): the total is unknown. */
  hasMore: boolean;
  /** A change (search, sort, filter chip, tab, season) goes back to page 1. */
  resetKey: unknown;
};

export type PageView = {
  page: number; pages: number | null; knownPages: number; canBack: boolean; canNext: boolean; busy: boolean; failed: boolean;
  /** Counts the player's turns (Back, Next, a circle, a key): the hook moves the focus when it changes. */
  turn: number;
  /** The row the last `goToIndex` asked for (0-based), until the next turn; null otherwise. */
  jump: number | null;
  /** The page asked for, before it is clamped to the rows there are (ahead of `page` while a read's rows are on their way). */
  target: number;
};

export type PageController = ReturnType<typeof createPageController>;

export function createPageController() {
  let input: PageInput = { total: 0, size: 1, hasMore: false, resetKey: undefined };
  let load: (() => Promise<unknown>) | null = null;
  let synced = false;
  let asked = 1;
  let busy = false;
  let failed = false;
  let turn = 0;
  let jump: number | null = null;
  /** Bumped by a reset: a read that finishes after one does not move the page. */
  let generation = 0;
  let version = 0;
  const listeners = new Set<() => void>();
  const changed = () => { version += 1; listeners.forEach(listener => listener()); };

  // While more rows can be read only full pages are known (fix round 1, I1): the partly loaded last page is read before it shows.
  const knownPages = () => (input.hasMore ? Math.max(1, Math.floor(input.total / Math.max(1, input.size))) : pageCount(input.total, input.size));
  const shown = () => clampPage(asked, knownPages());

  /** Moves to `page` as a turn of the player's. */
  const turnTo = (page: number, row: number | null = null) => {
    asked = page;
    failed = false;
    turn += 1;
    jump = row;
    changed();
  };

  /** Reads the next rows and then shows `page` (a page past the loaded ones), and row `row` when a jump asked for it. */
  const readThen = (page: number, row: number | null = null) => {
    if (busy || !load) return;
    busy = true;
    failed = false;
    const started = generation;
    changed();
    load().then(() => {
      // A read that a reset left behind changes nothing: a newer read may be running (fix round 2, R2-4).
      if (started !== generation) return;
      busy = false;
      turnTo(page, row);
    }, () => {
      if (started !== generation) return;
      busy = false;
      failed = true;
      changed();
    });
  };

  const go = (page: number) => {
    if (busy) return;
    const known = knownPages();
    // Past the full pages: read more, then show the first page with rows not seen yet (page 1 itself while it is not full).
    if (page > known && input.hasMore) readThen(Math.min(page, Math.floor(input.total / Math.max(1, input.size)) + 1));
    else turnTo(clampPage(page, known));
  };

  return {
    /** The latest rows and options, each render; never notifies (it runs during a render). */
    sync(next: PageInput, nextLoad: (() => Promise<unknown>) | null = null) {
      if (synced && !Object.is(next.resetKey, input.resetKey)) {
        asked = 1;
        failed = false;
        busy = false;
        jump = null;
        generation += 1;
      } else if (synced && next.size !== input.size) {
        // A new size (a grid that changes layout, the saved Show choice applying on open): the page that holds the jumped-to row,
        // else the first row on screen (fix round 1, I2; fix round 2, R2-2: a jump made on open is kept).
        asked = pageOfIndex(jump ?? (shown() - 1) * input.size, next.size);
      }
      synced = true;
      input = next;
      load = nextLoad;
    },
    view(): PageView {
      const known = knownPages();
      const page = shown();
      return {
        page, pages: input.hasMore ? null : known, knownPages: known,
        canBack: page > 1, canNext: page < known || input.hasMore, busy, failed, turn, jump, target: asked,
      };
    },
    back() { if (shown() > 1) turnTo(shown() - 1); },
    next() { go(shown() + 1); },
    go,
    /**
     * Turns to the page that holds row `index`, asked as is, so a row not loaded yet is shown once it is (fix round 1, M3). Past the
     * full pages of a cursor list it reads once first and then shows that page, or the last page if the server has no more (R2-3).
     */
    goToIndex(index: number) {
      const page = pageOfIndex(index, input.size);
      if (page > knownPages() && input.hasMore) readThen(page, index);
      else turnTo(page, index);
    },
    /** A new page size: the page is the one that holds `firstIndex` (by default the first row shown now). */
    resize(size: number, firstIndex = (shown() - 1) * input.size) {
      input = { ...input, size };
      asked = pageOfIndex(firstIndex, size);
      jump = null;
      changed();
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => version,
  };
}
