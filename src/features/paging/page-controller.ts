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
  type Intent = { page: number; row: number | null };
  type Read = { total: number; intent: Intent | null; settled: boolean };

  let input: PageInput = { total: 0, size: 1, hasMore: false, resetKey: undefined };
  let load: (() => Promise<unknown>) | null = null;
  let synced = false;
  let asked = 1;
  let failed = false;
  let turn = 0;
  let jump: number | null = null;
  let read: Read | null = null;
  let version = 0;
  const listeners = new Set<() => void>();
  const changed = () => { version += 1; listeners.forEach(listener => listener()); };

  const reading = () => read !== null && !read.settled;
  const canLoad = () => input.hasMore && load !== null;
  const knownPages = () => canLoad() ? Math.max(1, Math.floor(input.total / Math.max(1, input.size))) : pageCount(input.total, input.size);
  const shown = () => clampPage(asked, knownPages());

  const recordTurn = (page: number, row: number | null) => {
    asked = page;
    failed = false;
    turn += 1;
    jump = row;
  };

  // Supersede only the requested page. An in-flight response can still add rows.
  const discardIntent = () => {
    if (read) read.intent = null;
  };

  const turnTo = (page: number, row: number | null = null) => {
    discardIntent();
    recordTurn(page, row);
    changed();
  };

  // A loader may resolve before React supplies the new rows to sync. Either
  // event can finish the pending turn once it sees the committed state.
  const finishTurn = () => {
    if (!read?.settled) return;
    const { intent, total } = read;
    if (intent === null) {
      read = null;
      return;
    }
    const { row } = intent;
    const page = row === null ? intent.page : pageOfIndex(row, input.size);
    const grew = input.total > total;
    if (canLoad() && (!grew || page > knownPages())) return;

    read = null;
    if (grew || (row !== null && row < input.total)) recordTurn(page, row);
  };

  const readThen = (page: number, row: number | null = null) => {
    if (reading() || !load) return;
    const pending: Read = { total: input.total, intent: { page, row }, settled: false };
    read = pending;
    failed = false;
    changed();
    load().then(() => {
      if (read !== pending) return;
      pending.settled = true;
      finishTurn();
      changed();
    }, () => {
      if (read !== pending) return;
      read = null;
      failed = pending.intent !== null;
      changed();
    });
  };

  const go = (page: number) => {
    if (reading()) return;
    const known = knownPages();
    if (page > known && canLoad()) readThen(Math.min(page, Math.floor(input.total / Math.max(1, input.size)) + 1));
    else turnTo(clampPage(page, known));
  };

  return {
    /** The latest rows and options, each render. No listeners run during a render. */
    sync(next: PageInput, nextLoad: (() => Promise<unknown>) | null = null) {
      if (synced && !Object.is(next.resetKey, input.resetKey)) {
        asked = 1;
        failed = false;
        jump = null;
        read = null;
      } else if (synced && next.size !== input.size) {
        asked = pageOfIndex(jump ?? (shown() - 1) * input.size, next.size);
      }
      synced = true;
      input = next;
      load = nextLoad;
      finishTurn();
    },
    view(): PageView {
      const known = knownPages();
      const page = shown();
      return {
        page, pages: input.hasMore ? null : known, knownPages: known,
        canBack: page > 1, canNext: page < known || input.hasMore, busy: reading(), failed, turn, jump, target: asked,
      };
    },
    back() { if (shown() > 1) turnTo(shown() - 1); },
    next() { go(shown() + 1); },
    go,
    goToIndex(index: number) {
      const page = pageOfIndex(index, input.size);
      if (page <= knownPages() || !canLoad()) {
        turnTo(page, index);
      } else if (read && !read.settled) {
        read.intent = { page, row: index };
      } else {
        readThen(page, index);
      }
    },
    resize(size: number, firstIndex = (shown() - 1) * input.size) {
      discardIntent();
      input = { ...input, size };
      asked = pageOfIndex(firstIndex, size);
      jump = null;
      changed();
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => version,
  };
}
