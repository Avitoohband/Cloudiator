import { describe, expect, it } from 'vitest';
import type { HistoryEntry, HistoryKind, HistoryPage } from '@contracts/reads';
import type { BoutFilter, BoutsPage, MyBout } from '@/lib/api/reads';
import { createBoutsStore } from '@/features/bouts/bouts-store';
import { createHistoryStore } from '@/features/character/history-store';
import { readMore } from '@/features/paging/read-more';

// Patch 1.9 final review M2: the pager's Next past the loaded rows of My bouts and of a gladiator's History (`readMore`). The stores' `more`
// answers false, with no failure, while the list's first page is read again (Results re-reads My bouts each time it opens) or another read of
// more is out (the History's landing): a Next then waits for that read and reads on, or rejects so the bar says so. Never a press that waits
// for rows that never come.

type Held<P> = { cursor: string | undefined; resolve(page: P): void; reject(error: unknown): void };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
/** Whether `promise` has settled (resolved or rejected) after the queued work ran. */
async function state(promise: Promise<unknown>): Promise<'pending' | 'resolved' | 'rejected'> {
  let seen: 'pending' | 'resolved' | 'rejected' = 'pending';
  promise.then(() => { seen = 'resolved'; }, () => { seen = 'rejected'; });
  await settle();
  return seen;
}

const bout = (id: string) => ({ activityId: id }) as MyBout;
const boutPage = (from: number, count: number, nextCursor: string | null): BoutsPage =>
  ({ rows: Array.from({ length: count }, (_, i) => bout(`b-${from + i}`)), nextCursor });
function boutReads() {
  const calls: Held<BoutsPage>[] = [];
  return { calls, bouts: (_filter: BoutFilter, cursor?: string) => new Promise<BoutsPage>((resolve, reject) => { calls.push({ cursor, resolve, reject }); }) };
}

const entry = (id: string) => ({ entryId: id, activityId: `a-${id}` }) as HistoryEntry;
const historyPage = (from: number, count: number, nextCursor: string | null): HistoryPage =>
  ({ rows: Array.from({ length: count }, (_, i) => entry(`h-${from + i}`)), nextCursor });
function historyReads() {
  const calls: Held<HistoryPage>[] = [];
  return {
    calls,
    history: (_id: string, _kind: HistoryKind, cursor?: string) => new Promise<HistoryPage>((resolve, reject) => { calls.push({ cursor, resolve, reject }); }),
  };
}

describe('Next past the loaded rows of a store list (final review M2)', () => {
  it('My bouts: a Next pressed while the bouts are read again waits for that read, then reads the next twenty from it', async () => {
    const reads = boutReads(), store = createBoutsStore(reads);
    store.load('all');
    reads.calls[0].resolve(boutPage(0, 20, 'c20')); await settle();
    // Results opens again: the bouts are read again, the twenty rows stay on screen meanwhile.
    store.reload('all');
    expect(store.list('all').status).toBe('loading');
    const next = readMore(store, 'all');
    expect(await state(next)).toBe('pending');
    expect(reads.calls).toHaveLength(2);
    reads.calls[1].resolve(boutPage(0, 20, 'c20')); await settle();
    // The reload landed: the next twenty are read from it, and the Next settles once they are in.
    expect(reads.calls).toHaveLength(3);
    expect(reads.calls[2].cursor).toBe('c20');
    expect(await state(next)).toBe('pending');
    reads.calls[2].resolve(boutPage(20, 20, 'c40'));
    await next;
    expect(store.list('all').rows).toHaveLength(40);
  });

  it('My bouts: a reload that leaves fewer rows than at the press is read on until there are more', async () => {
    const reads = boutReads(), store = createBoutsStore(reads);
    store.load('all');
    reads.calls[0].resolve(boutPage(0, 20, 'c20')); await settle();
    void store.more('all'); reads.calls[1].resolve(boutPage(20, 20, 'c40')); await settle();
    expect(store.list('all').rows).toHaveLength(40);
    store.reload('all');
    const next = readMore(store, 'all');
    reads.calls[2].resolve(boutPage(0, 20, 'c20')); await settle();
    reads.calls[3].resolve(boutPage(20, 20, 'c40')); await settle();
    expect(await state(next)).toBe('pending');
    reads.calls[4].resolve(boutPage(40, 5, null));
    await next;
    expect(store.list('all').rows).toHaveLength(45);
  });

  it('My bouts: a reload that fails rejects the Next, so the bar says so', async () => {
    const reads = boutReads(), store = createBoutsStore(reads);
    store.load('all');
    reads.calls[0].resolve(boutPage(0, 20, 'c20')); await settle();
    store.reload('all');
    const next = readMore(store, 'all');
    reads.calls[1].reject(new Error('offline'));
    await expect(next).rejects.toThrow();
    expect(reads.calls).toHaveLength(2);
  });

  it('History: a Next pressed while another read of more is out (the landing\'s) waits for it and settles with its rows', async () => {
    const reads = historyReads(), store = createHistoryStore(reads, 'g-1', false);
    store.load('arena');
    reads.calls[0].resolve(historyPage(0, 20, 'c20')); await settle();
    const landing = store.more('arena');
    const next = readMore(store, 'arena');
    expect(await state(next)).toBe('pending');
    reads.calls[1].resolve(historyPage(20, 20, 'c40'));
    await landing;
    await next;
    expect(store.list('arena').rows).toHaveLength(40);
    expect(reads.calls).toHaveLength(2);
  });

  it('History: when that other read fails, the Next reads once more itself, and rejects (the bar says so) when that fails too', async () => {
    const reads = historyReads(), store = createHistoryStore(reads, 'g-1', false);
    store.load('arena');
    reads.calls[0].resolve(historyPage(0, 20, 'c20')); await settle();
    const landing = store.more('arena');
    const next = readMore(store, 'arena');
    reads.calls[1].reject(new Error('offline'));
    await landing; await settle();
    expect(reads.calls).toHaveLength(3);
    expect(await state(next)).toBe('pending');
    reads.calls[2].reject(new Error('offline'));
    await expect(next).rejects.toThrow();
    expect(reads.calls).toHaveLength(3);
  });

  it('a plain Next reads one page; a failed one rejects; the end of the list settles', async () => {
    const reads = historyReads(), store = createHistoryStore(reads, 'g-1', false);
    store.load('arena');
    reads.calls[0].resolve(historyPage(0, 20, 'c20')); await settle();
    const first = readMore(store, 'arena');
    reads.calls[1].reject(new Error('offline'));
    await expect(first).rejects.toThrow();
    const second = readMore(store, 'arena');
    reads.calls[2].resolve(historyPage(20, 3, null));
    await second;
    expect(store.list('arena').rows).toHaveLength(23);
    expect(reads.calls).toHaveLength(3);
  });
});
