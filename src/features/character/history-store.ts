import { useEffect, useSyncExternalStore } from 'react';
import type { HistoryCounts, HistoryEntry, HistoryKind } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import type { OwnRewards } from '../../lib/api/reads';

// Patch 1.9 Task 27: one card's history (the approved mockup's History view): one list per chip (Arena, Tournament fights, Expeditions), each
// read 20 a page through the public history read when first shown, with Show more for the next page; the chips' counts, read once; and, on
// the viewer's own card only, the owner's own rewards for the rows shown (one owner read per page; another gladiator's card never asks).
// The store lives as long as the card (a new card is a new store), so the lists and the chip chosen stay while the card is open. Only the
// latest read lands: each read is numbered, and a page for a read the list has moved past is dropped (AGENTS.md, React async state). A
// failed first page says so (Try again reads it again); a failed Show more keeps the rows; failed rewards leave the rows without them.

export type HistoryReads = Partial<Pick<GameGateway, 'history' | 'historyCounts' | 'ownRewards'>>;
export type HistoryList = {
  rows: readonly HistoryEntry[]; nextCursor: string | null; status: 'idle' | 'loading' | 'ready' | 'failed';
  loadingMore: boolean; moreFailed: boolean;
  /** How many pages have landed (Show more adds one): "That is everything." once a list that paged has ended. */
  pages: number;
};
export type HistoryStore = {
  list(kind: HistoryKind): HistoryList;
  /** The chips' counts, or null until read (and when that read failed). */
  counts(): HistoryCounts | null;
  /** The owner's own rewards by activity id (the viewer's own card only; empty on another's). */
  rewards(): ReadonlyMap<string, OwnRewards>;
  /** A list's first page unless it is loaded or loading (a failed one is read again: Try again); the counts with it until they are read. */
  load(kind: HistoryKind): void;
  /** True only if this call applied a page; false on failure, a newer read, or nothing to read. Rows stay on failure. */
  more(kind: HistoryKind): Promise<boolean>;
  subscribe(listener: () => void): () => void;
};
type State = { lists: Partial<Record<HistoryKind, HistoryList>>; counts: HistoryCounts | null; rewards: ReadonlyMap<string, OwnRewards> };

const IDLE: HistoryList = { rows: [], nextCursor: null, status: 'idle', loadingMore: false, moreFailed: false, pages: 0 };

export function createHistoryStore(reads: HistoryReads, gladiatorId: string, own: boolean): HistoryStore {
  let state: State = { lists: {}, counts: null, rewards: new Map() };
  const listeners = new Set<() => void>();
  /** The read each list waits for: its first page and its Show more; a page for any other read is dropped. */
  const waiting = new Map<HistoryKind, { first: number | null; more: number | null }>();
  /** Activities whose rewards were asked for (own card), so a row is asked about once. */
  const asked = new Set<string>();
  let reads_ = 0, counting = false;

  const emit = (next: State) => { state = next; for (const listener of [...listeners]) listener(); };
  const list = (kind: HistoryKind) => state.lists[kind] ?? IDLE;
  const set = (kind: HistoryKind, next: Partial<HistoryList>) => emit({ ...state, lists: { ...state.lists, [kind]: { ...list(kind), ...next } } });
  const wait = (kind: HistoryKind) => {
    let entry = waiting.get(kind);
    if (!entry) waiting.set(kind, entry = { first: null, more: null });
    return entry;
  };
  /** New rows, each once by its key. */
  const fresh = (rows: readonly HistoryEntry[], known: readonly HistoryEntry[]) => {
    const seen = new Set(known.map(row => row.entryId));
    return rows.filter(row => !seen.has(row.entryId) && seen.add(row.entryId));
  };
  /** The owner's own card: its rewards for the activities of rows it has not asked about yet. */
  const askRewards = (rows: readonly HistoryEntry[]) => {
    if (!own || !reads.ownRewards) return;
    const ids = [...new Set(rows.map(row => row.activityId))].filter(id => !asked.has(id));
    if (ids.length === 0) return;
    for (const id of ids) asked.add(id);
    reads.ownRewards(ids).then(found => {
      if (found.size === 0) return;
      emit({ ...state, rewards: new Map([...state.rewards, ...found]) });
    }, () => {
      // Rows show without rewards for now; these are asked again with the next page or chip read (fix round 1).
      for (const id of ids) asked.delete(id);
    });
  };
  const loadCounts = () => {
    if (state.counts || counting || !reads.historyCounts) return;
    counting = true;
    reads.historyCounts(gladiatorId).then(counts => { counting = false; emit({ ...state, counts }); }, () => { counting = false; });
  };
  const readFirst = (kind: HistoryKind) => {
    const id = ++reads_, entry = wait(kind);
    entry.first = id;
    entry.more = null;
    set(kind, { status: 'loading', loadingMore: false, moreFailed: false });
    if (!reads.history) { entry.first = null; set(kind, { status: 'failed' }); return; }
    reads.history(gladiatorId, kind).then(page => {
      if (entry.first !== id) return;
      entry.first = null;
      const rows = fresh(page.rows, []);
      set(kind, { rows, nextCursor: page.nextCursor, status: 'ready', pages: 1 });
      askRewards(rows);
    }, () => {
      if (entry.first !== id) return;
      entry.first = null;
      set(kind, { status: 'failed' });
    });
  };

  return {
    list,
    counts: () => state.counts,
    rewards: () => state.rewards,
    load(kind) {
      loadCounts();
      const { status } = list(kind);
      if (status === 'idle' || status === 'failed') readFirst(kind);
    },
    async more(kind) {
      const current = list(kind), entry = wait(kind);
      if (current.status !== 'ready' || !current.nextCursor || current.loadingMore || !reads.history) return false;
      const id = ++reads_;
      entry.more = id;
      set(kind, { loadingMore: true, moreFailed: false });
      try {
        const page = await reads.history(gladiatorId, kind, current.nextCursor);
        if (entry.more !== id) return false;
        const { rows, pages } = list(kind);
        const added = fresh(page.rows, rows);
        // A page with nothing new (a read that ignores the cursor) ends the list rather than offering Show more for ever.
        set(kind, { rows: [...rows, ...added], nextCursor: added.length ? page.nextCursor : null, loadingMore: false, pages: pages + 1 });
        askRewards(added);
        return true;
      } catch {
        if (entry.more !== id) return false;
        set(kind, { loadingMore: false, moreFailed: true });
        return false;
      } finally {
        if (entry.more === id) entry.more = null;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** `kind`'s list, the counts and the rewards from `store`, read again whenever they change; the list loads on first use. */
export function useHistory(store: HistoryStore, kind: HistoryKind): { list: HistoryList; counts: HistoryCounts | null; rewards: ReadonlyMap<string, OwnRewards> } {
  const list = useSyncExternalStore(store.subscribe, () => store.list(kind), () => store.list(kind));
  const counts = useSyncExternalStore(store.subscribe, store.counts, store.counts);
  const rewards = useSyncExternalStore(store.subscribe, store.rewards, store.rewards);
  useEffect(() => { store.load(kind); }, [store, kind]);
  return { list, counts, rewards };
}
