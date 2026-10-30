import { useEffect, useSyncExternalStore } from 'react';
import type { GameGateway } from '../../lib/api/gateway';
import type { BoutFilter, MyBout } from '../../lib/api/reads';

// The owner's My bouts lists (Arena replays spec 1 and 3): one list per chip (All, Won, Lost), read 20 a page through `bouts`, with More
// for the next page. One store per reader and owner (the shell makes a new one when the account changes, so no owner's bouts outlive
// it), shared by Results and, later, the replay's queue. Only the latest read lands (AGENTS.md, React async state; Review Focus 2): each
// read is numbered, and a page that comes back for a read the list has moved past (a reload, a newer first page) is dropped, so a slower
// earlier read never replaces a newer one. The first page asks with no cursor at all (`undefined`, never `''`, which the read refuses).

export type BoutList = { rows: readonly MyBout[]; nextCursor: string | null; status: 'idle' | 'loading' | 'ready' | 'failed'; loadingMore: boolean; moreFailed: boolean };
export type BoutsStore = {
  list(filter: BoutFilter): BoutList;
  /** The first page, unless the list is loaded or loading (a failed one is read again: Try again). */
  load(filter: BoutFilter): void;
  /** The next page appended, no bout twice; the rows are kept on failure, which `moreFailed` says. */
  more(filter: BoutFilter): Promise<void>;
  /** Every list read again (Results reads once each time it opens); the pages of older reads are dropped. */
  reload(): void;
  subscribe(listener: () => void): () => void;
};

const IDLE: BoutList = { rows: [], nextCursor: null, status: 'idle', loadingMore: false, moreFailed: false };
const FILTERS: readonly BoutFilter[] = ['all', 'won', 'lost'];

export function createBoutsStore(reads: Pick<GameGateway, 'bouts'>): BoutsStore {
  const lists = new Map<BoutFilter, BoutList>();
  /** The read each list waits for: its first page (`first`) and its More (`more`); a page for any other read is dropped. */
  const waiting = new Map<BoutFilter, { first: number | null; more: number | null }>();
  const listeners = new Set<() => void>();
  let reads_ = 0;

  const list = (filter: BoutFilter) => lists.get(filter) ?? IDLE;
  const wait = (filter: BoutFilter) => {
    let entry = waiting.get(filter);
    if (!entry) waiting.set(filter, entry = { first: null, more: null });
    return entry;
  };
  const set = (filter: BoutFilter, next: Partial<BoutList>) => {
    lists.set(filter, { ...list(filter), ...next });
    for (const listener of [...listeners]) listener();
  };

  /** Reads `filter`'s first page; the rows shown stay until it lands (a reload does not flash an empty list), and an older More is dropped. */
  const readFirst = (filter: BoutFilter) => {
    const id = ++reads_, entry = wait(filter);
    entry.first = id;
    entry.more = null;
    set(filter, { status: 'loading', loadingMore: false, moreFailed: false });
    reads.bouts(filter).then(
      page => {
        if (entry.first !== id) return;
        entry.first = null;
        const seen = new Set<string>();
        set(filter, { rows: page.rows.filter(bout => !seen.has(bout.activityId) && seen.add(bout.activityId)), nextCursor: page.nextCursor, status: 'ready' });
      },
      () => {
        if (entry.first !== id) return;
        entry.first = null;
        set(filter, { status: 'failed' });
      },
    );
  };

  return {
    list,
    load(filter) {
      const { status } = list(filter);
      if (status === 'idle' || status === 'failed') readFirst(filter);
    },
    async more(filter) {
      const current = list(filter), entry = wait(filter);
      if (current.status !== 'ready' || !current.nextCursor || current.loadingMore) return;
      const id = ++reads_;
      entry.more = id;
      set(filter, { loadingMore: true, moreFailed: false });
      try {
        const page = await reads.bouts(filter, current.nextCursor);
        if (entry.more !== id) return;
        const { rows } = list(filter);
        const seen = new Set(rows.map(bout => bout.activityId));
        const fresh = page.rows.filter(bout => !seen.has(bout.activityId) && seen.add(bout.activityId));
        // A page with nothing new (a read that ignores the cursor) ends the list rather than offering More for ever.
        set(filter, { rows: [...rows, ...fresh], nextCursor: fresh.length ? page.nextCursor : null, loadingMore: false });
      } catch {
        if (entry.more !== id) return;
        set(filter, { loadingMore: false, moreFailed: true });
      } finally {
        if (entry.more === id) entry.more = null;
      }
    },
    reload() {
      for (const filter of FILTERS) if (list(filter).status !== 'idle') readFirst(filter);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** `filter`'s list from `store`, read again whenever it changes; it loads on first use. */
export function useBoutList(store: BoutsStore, filter: BoutFilter): BoutList {
  const shown = useSyncExternalStore(store.subscribe, () => store.list(filter), () => store.list(filter));
  useEffect(() => { store.load(filter); }, [store, filter]);
  return shown;
}
