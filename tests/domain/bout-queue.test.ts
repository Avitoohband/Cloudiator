import { describe, expect, it, vi } from 'vitest';
import type { BoutsPage, MyBout } from '@/lib/api/reads';
import { createBoutsStore, type BoutList } from '@/features/bouts/bouts-store';
import { nextQueuePage, nextTarget, previousTarget, queueEntries, type ReplayQueue } from '@/features/bouts/bout-queue';

const NOW = Date.UTC(2026, 9, 10);
const bout = (activityId: string): MyBout => ({ activityId, kind: 'arena', slotIndex: 1, foughtAtMs: NOW - 1000,
  settledAtMs: NOW, result: 'victory', renown: 10, ratingDelta: null, opponent: null, tieBreak: false, round: null,
  replayExpiry: { state: 'available', expiresAtMs: NOW + 1000 } });
const list = (ids: string[], over: Partial<BoutList> = {}): BoutList => ({ rows: ids.map(bout), nextCursor: null,
  status: 'ready', loadingMore: false, moreFailed: false, ...over });

describe('the replay queue', () => {
  const held = async () => {
    const calls: { resolve(page: BoutsPage): void; reject(error: unknown): void }[] = [];
    const store = createBoutsStore({ bouts: () => new Promise<BoutsPage>((resolve, reject) => calls.push({ resolve, reject })) });
    const open = vi.fn();
    const queue: ReplayQueue = { filter: 'all', ownerName: 'Aster', currentActivityId: null,
      get list() { return store.list('all'); }, more: () => store.more('all'), open };
    store.load('all'); calls[0].resolve({ rows: [bout('a')], nextCursor: '9' });
    await Promise.resolve();
    return { store, calls, queue, open };
  };

  it('reads the current snapshot after paging, and skips a page with no kept replays', async () => {
    const { calls, queue, open } = await held();
    const step = nextQueuePage(queue, 'a', () => NOW, () => true);
    const expired = { ...bout('gone'), replayExpiry: { state: 'expired' as const } };
    calls[1].resolve({ rows: [expired], nextCursor: '8' });
    await Promise.resolve(); await Promise.resolve();
    calls[2].resolve({ rows: [bout('b')], nextCursor: null });
    await step;
    expect(open).toHaveBeenCalledExactlyOnceWith('b');
  });

  it('does not step after a newer reload completed before the old page returns', async () => {
    const { store, calls, queue, open } = await held();
    const step = nextQueuePage(queue, 'a', () => NOW, () => true);
    store.reload('all'); calls[2].resolve({ rows: [bout('a'), bout('new')], nextCursor: null });
    await Promise.resolve();
    calls[1].resolve({ rows: [bout('stale')], nextCursor: null });
    await step;
    expect(queue.list.rows.map(row => row.activityId)).toEqual(['a', 'new']);
    expect(open).not.toHaveBeenCalled();
  });

  it('drops a late step after a scene, owner, filter or chapter change, and on failure or terminal duplicates', async () => {
    const { calls, queue, open } = await held();
    let active = true;
    const step = nextQueuePage(queue, 'a', () => NOW, () => active);
    active = false;
    calls[1].resolve({ rows: [bout('b')], nextCursor: null }); await step;
    expect(open).not.toHaveBeenCalled();
    const failure = await held();
    const failed = nextQueuePage(failure.queue, 'a', () => NOW, () => true);
    failure.calls[1].reject(new Error('offline')); await failed;
    expect(failure.open).not.toHaveBeenCalled();
    const duplicate = nextQueuePage(failure.queue, 'a', () => NOW, () => true);
    failure.calls[2].resolve({ rows: [bout('a')], nextCursor: '8' }); await duplicate;
    expect(failure.open).not.toHaveBeenCalled();
    expect(failure.queue.list.nextCursor).toBeNull();
  });

  it('queues kept replays and puts an own unlisted current bout first', () => {
    const l = list(['a', 'b', 'c']);
    (l.rows[1] as MyBout).replayExpiry = { state: 'expired' };
    expect(queueEntries(l, 'c', NOW)).toMatchObject({ index: 1, more: false });
    expect(queueEntries(l, 'c', NOW)!.entries.map(e => e.activityId)).toEqual(['a', 'c']);
    expect(queueEntries(l, 'new', NOW)!.entries.map(e => e.activityId)).toEqual(['new', 'a', 'c']);
    expect(queueEntries(list([], { status: 'loading' }), 'a', NOW)).toBeNull();
    expect(queueEntries(list([], { status: 'failed' }), 'a', NOW)).toBeNull();
  });

  it('never restores an expired listed current bout as an unlisted anchor', () => {
    const l = list(['a', 'b']);
    (l.rows[0] as MyBout).replayExpiry = { state: 'available', expiresAtMs: NOW };
    expect(queueEntries(l, 'a', NOW)).toBeNull();
    expect(queueEntries(l, 'a', NOW - 1)!.entries.map(e => e.activityId)).toEqual(['a', 'b']);
    expect(queueEntries(l, 'b', NOW)!.entries.map(e => e.activityId)).toEqual(['b']);
  });

  it('steps chapters first, then the list, then the next page', () => {
    const q = queueEntries(list(['a', 'b']), 'a', NOW)!;
    expect(nextTarget(0, 3, q)).toEqual({ kind: 'chapter', index: 1 });
    expect(nextTarget(2, 3, q)).toEqual({ kind: 'bout', activityId: 'b' });
    expect(nextTarget(0, 1, queueEntries(list(['a'], { nextCursor: '9' }), 'a', NOW))).toEqual({ kind: 'more' });
    expect(nextTarget(0, 1, queueEntries(list(['a']), 'a', NOW))).toBeNull();
    expect(previousTarget(1, q)).toEqual({ kind: 'chapter', index: 0 });
    expect(previousTarget(0, queueEntries(list(['a', 'b']), 'b', NOW))).toEqual({ kind: 'bout', activityId: 'a' });
    expect(previousTarget(0, null)).toBeNull();
    expect(nextTarget(0, 2, null)).toEqual({ kind: 'chapter', index: 1 });
  });
});
