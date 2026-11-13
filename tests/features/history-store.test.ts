import { describe, expect, it, vi } from 'vitest';
import type { HistoryCounts, HistoryEntry, HistoryKind, HistoryPage } from '@contracts/reads';
import type { OwnRewards } from '@/lib/api/reads';
import { createHistoryStore } from '@/features/character/history-store';

// Patch 1.9 Task 27: one card's history lists (one per chip), read 20 a page through the public history read, with Show more; the
// chips' counts once; and, on the viewer's own card only, the owner's own rewards for the rows shown. Only the latest read lands.
const ID = '1ac1fd28-1bc1-4ebb-9cc2-004e1dc201e1';
const row = (n: number, kind: HistoryKind = 'arena'): HistoryEntry => ({ entryId: `0000000${n}`.slice(-8) + '-0000-4000-9000-000000000000', kind,
  activityId: `0000000${n}`.slice(-8) + '-0000-4000-9000-000000000000', foughtAtMs: 1_000_000 - n, settledAtMs: 1_000_000 - n, result: 'victory', success: true,
  replayExpiry: { state: 'expired' }, league: null, tournamentId: null, round: null, place: null, expeditionId: kind === 'expedition' ? 'woodland' : null, opponent: null });
const COUNTS: HistoryCounts = { arena: { total: 23, won: 12 }, tournament: { total: 0, won: 0 }, expedition: { total: 1, won: 1 } };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('a card’s history store', () => {
  it('reads a chip’s first page once, then Show more, and the counts once; nothing before it is asked', async () => {
    const all = Array.from({ length: 23 }, (_, i) => row(i + 1));
    const history = vi.fn(async (_id: string, _kind: HistoryKind, cursor?: string): Promise<HistoryPage> => (cursor === undefined
      ? { rows: all.slice(0, 20), nextCursor: `x:${all[19].entryId}` } : { rows: all.slice(20), nextCursor: null }));
    const historyCounts = vi.fn(async () => COUNTS);
    const ownRewards = vi.fn();
    const store = createHistoryStore({ history, historyCounts, ownRewards }, ID, false);
    expect(store.list('arena').status).toBe('idle');
    expect(history).not.toHaveBeenCalled();
    store.load('arena');
    store.load('arena');
    expect(store.list('arena').status).toBe('loading');
    await settle();
    expect(history).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledWith(ID, 'arena');
    expect(historyCounts).toHaveBeenCalledTimes(1);
    expect(store.counts()).toEqual(COUNTS);
    expect(store.list('arena')).toMatchObject({ status: 'ready', nextCursor: `x:${all[19].entryId}`, pages: 1 });
    expect(store.list('arena').rows).toHaveLength(20);
    expect(await store.more('arena')).toBe(true);
    expect(history).toHaveBeenLastCalledWith(ID, 'arena', `x:${all[19].entryId}`);
    expect(store.list('arena')).toMatchObject({ status: 'ready', nextCursor: null, pages: 2, loadingMore: false });
    expect(store.list('arena').rows.map(r => r.entryId)).toEqual(all.map(r => r.entryId));
    // Another chip reads its own list; the counts are not read again. Another gladiator's card never asks for rewards.
    store.load('expedition');
    await settle();
    expect(history).toHaveBeenLastCalledWith(ID, 'expedition');
    expect(historyCounts).toHaveBeenCalledTimes(1);
    expect(ownRewards).not.toHaveBeenCalled();
    expect(store.rewards().size).toBe(0);
  });

  it('asks the owner’s own rewards for the rows shown on its own card, once each, and keeps the rows when that fails', async () => {
    const first = [row(1), row(2)];
    const rewards = new Map<string, OwnRewards>([[first[0].activityId, { renown: 10, money: 0, ratingDelta: 13, unranked: false, items: [] }]]);
    const ownRewards = vi.fn(async () => rewards);
    const store = createHistoryStore({ history: async () => ({ rows: first, nextCursor: null }), historyCounts: async () => COUNTS, ownRewards }, ID, true);
    store.load('arena');
    await settle();
    await settle();
    expect(ownRewards).toHaveBeenCalledWith([first[0].activityId, first[1].activityId]);
    expect(store.rewards().get(first[0].activityId)).toEqual(rewards.get(first[0].activityId));
    store.load('arena');
    await settle();
    expect(ownRewards).toHaveBeenCalledTimes(1);

    const failing = createHistoryStore({ history: async () => ({ rows: first, nextCursor: null }), historyCounts: async () => COUNTS,
      ownRewards: async () => { throw new Error('denied'); } }, ID, true);
    failing.load('arena');
    await settle();
    await settle();
    expect(failing.list('arena')).toMatchObject({ status: 'ready' });
    expect(failing.list('arena').rows).toHaveLength(2);
    expect(failing.rewards().size).toBe(0);
  });

  it('says a failed first page and reads it again on Try again; a failed Show more keeps the rows', async () => {
    let fail = true;
    const store = createHistoryStore({
      history: async (_id, _kind, cursor) => {
        if (fail) throw new Error('down');
        return cursor ? Promise.reject(new Error('down')) : { rows: [row(1)], nextCursor: 'x:y' };
      },
      historyCounts: async () => { throw new Error('down'); },
    }, ID, false);
    store.load('tournament');
    await settle();
    expect(store.list('tournament').status).toBe('failed');
    expect(store.counts()).toBeNull();
    fail = false;
    store.load('tournament');
    await settle();
    expect(store.list('tournament')).toMatchObject({ status: 'ready' });
    expect(await store.more('tournament')).toBe(false);
    expect(store.list('tournament')).toMatchObject({ status: 'ready', moreFailed: true, loadingMore: false });
    expect(store.list('tournament').rows).toHaveLength(1);
  });

  it('lands only the latest read: an older More that answers late is dropped, and duplicates are left out', async () => {
    const page = deferred<HistoryPage>();
    let calls = 0;
    const store = createHistoryStore({
      history: async (_id, _kind, cursor) => {
        calls += 1;
        if (!cursor) return { rows: [row(1), row(2)], nextCursor: 'x:2' };
        return page.promise;
      },
      historyCounts: async () => COUNTS,
    }, ID, false);
    store.load('arena');
    await settle();
    const more = store.more('arena');
    expect(await store.more('arena')).toBe(false);
    page.resolve({ rows: [row(2), row(3)], nextCursor: null });
    expect(await more).toBe(true);
    expect(store.list('arena').rows.map(r => r.entryId)).toEqual([row(1), row(2), row(3)].map(r => r.entryId));
    expect(calls).toBe(2);
  });

  it('without a history read the list says it failed, and notifies its listeners on every change', async () => {
    const store = createHistoryStore({}, ID, false);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.load('arena');
    await settle();
    expect(store.list('arena').status).toBe('failed');
    expect(listener).toHaveBeenCalled();
    off();
  });
});
