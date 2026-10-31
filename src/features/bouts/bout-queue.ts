import type { BoutFilter, MyBout } from '../../lib/api/reads';
import { replayKept } from '../../lib/replay-retention';
import type { BoutList } from './bouts-store';

export type ReplayQueue = {
  filter: BoutFilter;
  /** Read the current snapshot after more(): the store replaces list objects. */
  readonly list: BoutList;
  ownerName: string;
  currentActivityId: string | null;
  open(activityId: string): void;
  /** True only when this invocation applied a page (including a terminal duplicate page). */
  more(): Promise<boolean>;
};
export type QueueEntries = { entries: readonly MyBout[]; index: number; more: boolean };
export type StepTarget = { kind: 'chapter'; index: number } | { kind: 'bout'; activityId: string } | { kind: 'more' };

/** Kept rows in list order. Only an absent own current bout gets a navigation-only anchor. */
export function queueEntries(list: BoutList, current: string, nowMs: number): QueueEntries | null {
  if (list.status !== 'ready' || !Number.isFinite(nowMs)) return null;
  const entries = list.rows.filter(row => replayKept(row.replayExpiry, nowMs));
  let index = entries.findIndex(row => row.activityId === current);
  if (index < 0) {
    // A listed but expired current replay must never be fabricated back into the kept list.
    if (list.rows.some(row => row.activityId === current)) return null;
    // This anchor carries only an id. It is never an authoritative row or an Up next source.
    const anchor: MyBout = { activityId: current, kind: 'arena', slotIndex: 0, foughtAtMs: NaN, settledAtMs: NaN,
      result: 'victory', renown: 0, ratingDelta: null, opponent: null, tieBreak: false, round: null, replayExpiry: { state: 'expired' } };
    entries.unshift(anchor);
    index = 0;
  }
  return { entries, index, more: list.nextCursor !== null };
}

export function nextTarget(chapter: number, chapters: number, queue: QueueEntries | null): StepTarget | null {
  if (chapter + 1 < chapters) return { kind: 'chapter', index: chapter + 1 };
  const next = queue?.entries[queue.index + 1];
  return next ? { kind: 'bout', activityId: next.activityId } : queue?.more ? { kind: 'more' } : null;
}

export function previousTarget(chapter: number, queue: QueueEntries | null): StepTarget | null {
  if (chapter > 0) return { kind: 'chapter', index: chapter - 1 };
  const previous = queue?.entries[queue.index - 1];
  return previous ? { kind: 'bout', activityId: previous.activityId } : null;
}

/** Read before stepping, skipping pages without a kept replay; an invalidated/no-op/failed page never navigates. */
export async function nextQueuePage(queue: ReplayQueue, current: string, now: () => number, active: () => boolean): Promise<void> {
  const cursors = new Set<string>();
  while (active()) {
    const list = queue.list;
    const cursor = list.nextCursor;
    if (list.status !== 'ready' || list.loadingMore || !cursor || cursors.has(cursor)) return;
    cursors.add(cursor);
    if (!await queue.more() || !active()) return;
    const latest = queue.list;
    if (latest.status !== 'ready' || latest.loadingMore || latest.moreFailed) return;
    const target = nextTarget(0, 1, queueEntries(latest, current, now()));
    if (target?.kind === 'bout') { queue.open(target.activityId); return; }
    if (target?.kind !== 'more') return;
  }
}
