import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoutFilter, BoutsPage, MyBout } from '@/lib/api/reads';
import { createBoutsStore, type BoutsStore } from '@/features/bouts/bouts-store';
import { MyBouts } from '@/features/bouts/MyBouts';
import { BoutRow } from '@/features/bouts/BoutRow';
import { boutRow } from '@/features/bouts/bout-text';
import { pinDeviceClock } from '../fixtures/clock';

// Arena replays Task 4 (spec 1; Review Focus 1 and 2): My bouts' list store (pages, More, a reload racing a page) and the watched
// marks kept on this device, in memory first when storage throws.
const DAY = 86_400_000;
const T = Date.UTC(2026, 9, 1);
const NOW = Date.UTC(2026, 9, 10, 4, 0);
/** The visible text, its no-break spaces kept (the times carry one). */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/[ \t\r\n]+/g, ' ').trim();

function bout(over: Partial<MyBout> = {}): MyBout {
  const at = Date.UTC(2026, 9, 10, 3, 0);
  return { activityId: 'a', kind: 'arena', slotIndex: 1, foughtAtMs: at, settledAtMs: at + 20 * 60_000, result: 'victory', renown: 10, ratingDelta: 14,
    replayExpiry: { state: 'available', expiresAtMs: at + 7 * DAY }, opponent: { name: 'Varro', npc: false }, tieBreak: false, round: null, ...over };
}
const page = (ids: readonly string[], nextCursor: string | null = null): BoutsPage => ({ rows: ids.map(id => bout({ activityId: id })), nextCursor });
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `id-${from + i}`);

type Call = { filter: BoutFilter; cursor: string | undefined; argc: number; resolve(page: BoutsPage): void; reject(error: unknown): void };
/** A `bouts` read whose every page is held until the test resolves it, in the order asked. */
function heldReads() {
  const calls: Call[] = [];
  return {
    calls,
    bouts(this: void, ...args: [BoutFilter, string?]): Promise<BoutsPage> {
      return new Promise((resolve, reject) => { calls.push({ filter: args[0], cursor: args[1], argc: args.length, resolve, reject }); });
    },
  };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const rowIds = (store: BoutsStore, filter: BoutFilter) => store.list(filter).rows.map(b => b.activityId);

describe('the bouts store', () => {
  it('reads a list on first use, pages with More, never lists a bout twice', async () => {
    const reads = heldReads(), store = createBoutsStore(reads);
    const heard = vi.fn();
    store.subscribe(heard);
    expect(store.list('all')).toEqual({ rows: [], nextCursor: null, status: 'idle', loadingMore: false, moreFailed: false });
    store.load('all');
    expect(store.list('all').status).toBe('loading');
    // Task 2 carry: the first page asks with no cursor at all, never an empty one (which the read refuses).
    expect(reads.calls).toHaveLength(1);
    expect(reads.calls[0]).toMatchObject({ filter: 'all', cursor: undefined });
    expect(reads.calls[0].argc).toBe(1);
    store.load('all');
    expect(reads.calls).toHaveLength(1);
    reads.calls[0].resolve(page(ids(20), '980'));
    await settle();
    expect(store.list('all')).toMatchObject({ status: 'ready', nextCursor: '980', loadingMore: false });
    expect(rowIds(store, 'all')).toEqual(ids(20));
    expect(heard).toHaveBeenCalled();
    // Loaded: a second load reads nothing; the snapshot stays the same object until something changes.
    const snapshot = store.list('all');
    store.load('all');
    expect(reads.calls).toHaveLength(1);
    expect(store.list('all')).toBe(snapshot);

    const more = store.more('all');
    expect(store.list('all').loadingMore).toBe(true);
    expect(reads.calls[1]).toMatchObject({ filter: 'all', cursor: '980' });
    // A second More while one is out asks nothing more.
    void store.more('all');
    expect(reads.calls).toHaveLength(2);
    reads.calls[1].resolve(page([...ids(19, 20), 'id-19'], '960'));
    await more;
    expect(rowIds(store, 'all')).toEqual(ids(39));
    expect(store.list('all')).toMatchObject({ status: 'ready', nextCursor: '960', loadingMore: false, moreFailed: false });
    // Each chip is a list of its own: Won has not been read.
    expect(store.list('won').status).toBe('idle');
    // A page with nothing new (a read that ignores the cursor) ends the list rather than offering More forever.
    const again = store.more('all');
    reads.calls[2].resolve(page(ids(20), '940'));
    await again;
    expect(store.list('all')).toMatchObject({ nextCursor: null });
    expect(rowIds(store, 'all')).toHaveLength(39);
    // No cursor: More reads nothing.
    await store.more('all');
    expect(reads.calls).toHaveLength(3);
  });

  it('lands only the latest read: a reload drops the page of the read before it', async () => {
    const reads = heldReads(), store = createBoutsStore(reads);
    store.load('all');
    store.reload();
    const [first, second] = reads.calls;
    expect([first.cursor, second.cursor]).toEqual([undefined, undefined]);
    first.resolve(page(['old']));
    second.resolve(page(['new']));
    await settle();
    expect(rowIds(store, 'all')).toEqual(['new']);
    // The other way round: the newer read lands first, and the older one that comes after it changes nothing.
    const other = createBoutsStore(reads);
    other.load('lost');
    other.reload();
    const [older, newer] = reads.calls.slice(2);
    newer.resolve(page(['new']));
    await settle();
    older.resolve(page(['old']));
    await settle();
    expect(rowIds(other, 'lost')).toEqual(['new']);
    expect(other.list('lost').status).toBe('ready');
  });

  it('drops a More page of the read before a reload, and keeps the rows shown while the list is read again', async () => {
    // AGENTS.md (React async state): a refresh racing a page load; the older page must not land on the newer list.
    const reads = heldReads(), store = createBoutsStore(reads);
    store.load('all');
    reads.calls[0].resolve(page(ids(20), '980'));
    await settle();
    const more = store.more('all');
    store.reload();
    // The rows stay on screen while the reload is out (Results opening again does not flash an empty list).
    expect(store.list('all')).toMatchObject({ status: 'loading', loadingMore: false });
    expect(rowIds(store, 'all')).toEqual(ids(20));
    // A More during the reload asks nothing: the cursor belongs to the read before it.
    await store.more('all');
    expect(reads.calls).toHaveLength(3);
    reads.calls[1].resolve(page(ids(20, 20), '960'));
    await more;
    expect(rowIds(store, 'all')).toEqual(ids(20));
    reads.calls[2].resolve(page(['fresh', ...ids(19)], '981'));
    await settle();
    expect(rowIds(store, 'all')).toEqual(['fresh', ...ids(19)]);
    expect(store.list('all')).toMatchObject({ status: 'ready', nextCursor: '981', loadingMore: false, moreFailed: false });
    // A list never read is not read by a reload; one that failed is read again.
    expect(store.list('won').status).toBe('idle');
    store.load('lost');
    reads.calls[3].reject(new Error('down'));
    await settle();
    expect(store.list('lost').status).toBe('failed');
    store.reload();
    expect(reads.calls.slice(4).map(c => c.filter).sort()).toEqual(['all', 'lost']);
  });

  it('keeps the rows and says so when More fails', async () => {
    const reads = heldReads(), store = createBoutsStore(reads);
    store.load('won');
    reads.calls[0].resolve(page(ids(20), '980'));
    await settle();
    const more = store.more('won');
    reads.calls[1].reject(new Error('down'));
    await more;
    expect(store.list('won')).toMatchObject({ status: 'ready', nextCursor: '980', loadingMore: false, moreFailed: true });
    expect(rowIds(store, 'won')).toEqual(ids(20));
    // Trying again clears the line while it reads, and lands the page.
    const retry = store.more('won');
    expect(store.list('won')).toMatchObject({ loadingMore: true, moreFailed: false });
    reads.calls[2].resolve(page(ids(5, 20)));
    await retry;
    expect(store.list('won')).toMatchObject({ nextCursor: null, moreFailed: false });
    expect(rowIds(store, 'won')).toHaveLength(25);
  });

  it('says a failed first page, and reads it again on Try again', async () => {
    const reads = heldReads(), store = createBoutsStore(reads);
    store.load('all');
    reads.calls[0].reject(new Error('down'));
    await settle();
    expect(store.list('all')).toMatchObject({ status: 'failed', rows: [] });
    store.load('all');
    expect(store.list('all').status).toBe('loading');
    reads.calls[1].resolve(page(['a']));
    await settle();
    expect(store.list('all')).toMatchObject({ status: 'ready', nextCursor: null });
  });
});

describe('watched marks', () => {
  const stored = new Map<string, string>();
  const KEY = 'cloudiator.bouts-watched.v1';
  const fresh = async () => { vi.resetModules(); return import('../../src/features/bouts/watched'); };
  const throwingStorage = () => vi.stubGlobal('localStorage', {
    getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); },
  });
  beforeEach(() => {
    stored.clear();
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); } });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('names its key', async () => { expect((await fresh()).WATCHED_KEY).toBe(KEY); });

  it('remembers watched bouts on this device, for 7 days and 200 bouts', async () => {
    const w = await fresh(); w.markWatched('a', T); w.markWatched('b', T + 8 * DAY);
    expect([...w.readWatched()]).toEqual(['b']);
    expect(JSON.parse(stored.get(KEY)!)).toEqual([['b', T + 8 * DAY]]);
    for (let i = 0; i < 201; i++) w.markWatched(`id-${i}`, T + 8 * DAY);
    expect(w.readWatched().size).toBe(200);
    // The newest 200 stay: the earliest two marks of that moment went, the last one is there.
    expect(w.readWatched().has('id-200')).toBe(true);
    expect(w.readWatched().has('b')).toBe(false);
    expect(JSON.parse(stored.get(KEY)!)).toHaveLength(200);
  });

  it('reads the marks stored before, and ignores a store it does not understand', async () => {
    stored.set(KEY, JSON.stringify([['x', T], ['y', T + 1]]));
    expect([...(await fresh()).readWatched()]).toEqual(['x', 'y']);
    for (const bad of ['nope', '{}', JSON.stringify([['x']]), JSON.stringify([[1, T]]), JSON.stringify([['x', 'later']])]) {
      stored.set(KEY, bad);
      expect([...(await fresh()).readWatched()], bad).toEqual([]);
    }
    // One bad entry among good ones is left out alone.
    stored.set(KEY, JSON.stringify([['x', T], ['y', null]]));
    expect([...(await fresh()).readWatched()]).toEqual(['x']);
  });

  it('stores the display clock’s time as whole milliseconds, so the next page reads its marks back', async () => {
    // The shared display clock runs on performance.now(): its time has a fraction (observed in the browser run: the mark was lost on reload).
    const w = await fresh(); w.markWatched('a', T + 0.625);
    expect(JSON.parse(stored.get(KEY)!)).toEqual([['a', T]]);
    expect([...(await fresh()).readWatched()]).toEqual(['a']);
  });

  it('marks a bout watched again at its newer time', async () => {
    const w = await fresh(); w.markWatched('a', T); w.markWatched('b', T + 1); w.markWatched('a', T + 2);
    expect(JSON.parse(stored.get(KEY)!)).toEqual([['b', T + 1], ['a', T + 2]]);
  });

  it('keeps marks in memory when storage throws', async () => {
    throwingStorage(); const w = await fresh();
    expect(() => w.markWatched('a', T)).not.toThrow(); expect(w.readWatched().has('a')).toBe(true);
    const heard = vi.fn(); w.subscribeWatched(heard); w.markWatched('b', T);
    expect(heard).toHaveBeenCalledTimes(1);
    expect([...w.readWatched()]).toEqual(['a', 'b']);
  });

  it('keeps the page’s marks when the write fails but an older store is still readable', async () => {
    stored.set(KEY, JSON.stringify([['old', T]]));
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem() { throw new Error('quota'); } });
    const w = await fresh(); w.markWatched('new', T + 1);
    expect([...w.readWatched()]).toEqual(['old', 'new']);
  });

  it('tells its listeners, hears another tab change the key, and stops when told', async () => {
    const window = new EventTarget(); vi.stubGlobal('window', window);
    const w = await fresh();
    const heard = vi.fn(); const off = w.subscribeWatched(heard);
    w.markWatched('a', T);
    expect(heard).toHaveBeenCalledTimes(1);
    stored.set(KEY, JSON.stringify([['a', T], ['other-tab', T + 5]]));
    window.dispatchEvent(Object.assign(new Event('storage'), { key: KEY }));
    expect(heard).toHaveBeenCalledTimes(2);
    expect(w.readWatched().has('other-tab')).toBe(true);
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'something.else' }));
    expect(heard).toHaveBeenCalledTimes(2);
    off(); w.markWatched('b', T);
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

describe('the My bouts view', () => {
  beforeEach(() => { pinDeviceClock('12'); });
  afterEach(() => { vi.restoreAllMocks(); });
  const noop = () => {};
  async function loaded(rows: readonly MyBout[], nextCursor: string | null = null, filter: BoutFilter = 'all') {
    const reads = heldReads(), store = createBoutsStore(reads);
    store.load(filter);
    reads.calls[0].resolve({ rows: [...rows], nextCursor });
    await settle();
    return store;
  }
  const view = (store: BoutsStore, filter: BoutFilter = 'all', nowMs: number | null = NOW) =>
    renderToStaticMarkup(createElement(MyBouts, { store, filter, onFilter: noop, nowMs, onOpen: noop, timeZone: 'UTC' }));

  it('shows the chips, the line, the day groups and each row with its button and dot', async () => {
    const store = await loaded([bout(), bout({ activityId: 'b', result: 'defeat', foughtAtMs: Date.UTC(2026, 9, 9, 23), opponent: { name: 'Iron Warden', npc: true }, ratingDelta: null, renown: 3 }),
      bout({ activityId: 'c', foughtAtMs: Date.UTC(2026, 9, 1, 19), replayExpiry: { state: 'expired' }, opponent: null })], '977');
    const html = view(store);
    expect(text(html)).toContain('Replays are kept 7 days · ● not watched yet');
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>All<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Won<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Lost<\/button>/);
    expect(text(html)).toMatch(/TODAY · SAT 10 OCT .*vs Varro.*FRI 9 OCT .*vs Iron Warden.*NPC.*THU 1 OCT .*Arena bout/);
    expect(html).toContain('aria-label="Watch: vs Varro, Sat 10 Oct, 3:00\xA0AM"');
    expect(html).toContain('aria-label="Result: Arena bout, Thu 1 Oct, 7:00\xA0PM"');
    // The two kept rows are not watched yet (a server render knows no marks); the dimmed one has no dot.
    expect(html.match(/Not watched yet/g)).toHaveLength(2);
    expect(html.match(/data-bout-row=/g)).toHaveLength(3);
    expect(html.match(/data-gone=""/g)).toHaveLength(1);
    expect(text(html)).toContain('Won');
    expect(text(html)).toContain('Lost');
    expect(html).toMatch(/<button[^>]*>More<\/button>/);
  });

  it('says loading, a failure and an empty chip', async () => {
    const reads = heldReads(), store = createBoutsStore(reads);
    store.load('all');
    expect(text(view(store))).toContain('Loading your bouts…');
    reads.calls[0].reject(new Error('down'));
    await settle();
    const failed = view(store);
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain('Your bouts could not be loaded right now. Try again');
    const empty = await loaded([], null, 'won');
    expect(text(view(empty, 'won'))).toContain('No won bouts yet.');
    expect(text(view(await loaded([]), 'all'))).toContain('No bouts yet. Your Arena and tournament bouts show here with their replays.');
  });

  it('offers no button until the server’s time is known', async () => {
    const html = view(await loaded([bout()]), 'all', null);
    expect(html).not.toContain('Watch:');
    expect(text(html)).toContain('vs Varro');
    expect(text(html)).not.toContain('TODAY');
  });

  it('writes both sub-lines, the narrow one without the leading kind', () => {
    const html = renderToStaticMarkup(createElement(BoutRow, { text: boutRow(bout(), NOW, '12', 'UTC'), watched: true, onOpen: noop }));
    expect(html).toContain('data-sub="wide"');
    expect(html).toContain('data-sub="narrow"');
    expect(text(html)).toContain('Arena · 3:00\xA0AM · +10 renown · Rating +14');
    expect(html).not.toContain('Not watched yet');
  });
});
