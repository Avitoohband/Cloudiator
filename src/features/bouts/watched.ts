import { useSyncExternalStore } from 'react';
import { RULES_V1 } from '@domain/rules-v1';

// "Not watched yet" marks for My bouts (Arena replays spec 1): which bouts' replays were opened on this device. Kept on this device only
// (never on the account), as a JSON array of [activityId, watchedAtMs]; a mark older than a replay is kept (7 days) is dropped, and the
// newest 200 stay. A per-device convenience: every access is inside try/catch, and the page's own memory answers when storage throws
// (private mode, blocked site data), so a dot that went stays gone for the page's life (Review Focus 1). Another tab's marks arrive by
// the `storage` event.

/** The device key. */
export const WATCHED_KEY = 'cloudiator.bouts-watched.v1';
const KEEP = 200;

/** The marks, oldest first (a mark made again moves to the end); null until first read. */
let memory: Map<string, number> | null = null;
/** The set the view reads, one object per change (`useSyncExternalStore` compares it). */
let snapshot: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();
const NONE: ReadonlySet<string> = new Set();

/** The stored marks, or none for a store that throws, is missing or is not what this module writes; a bad entry is left out alone. */
function stored(): Map<string, number> {
  const marks = new Map<string, number>();
  let raw: string | null = null;
  try { raw = localStorage.getItem(WATCHED_KEY); } catch { return marks; }
  if (raw === null) return marks;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return marks; }
  if (!Array.isArray(parsed)) return marks;
  for (const entry of parsed) {
    if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && Number.isSafeInteger(entry[1])) marks.set(entry[0], entry[1]);
  }
  return marks;
}

function marks(): Map<string, number> {
  memory ??= stored();
  return memory;
}

function changed() {
  snapshot = null;
  for (const listener of [...listeners]) listener();
}

/** The activity ids marked watched on this device. */
export function readWatched(): Set<string> {
  return new Set(marks().keys());
}

/**
 * Marks a bout's replay watched at `nowMs` (the display clock's time): in memory first, then the marks older than a replay is kept are
 * dropped and the newest 200 kept, then stored if the device lets it, then every listener is told.
 */
export function markWatched(activityId: string, nowMs: number): void {
  // The display clock runs on performance.now(): a time with a fraction is stored as whole milliseconds, which is what a read accepts.
  const at = Math.floor(nowMs);
  const current = marks();
  current.delete(activityId);
  current.set(activityId, at);
  const kept = [...current].filter(([, when]) => at - when <= RULES_V1.retention.replayMs).sort((a, b) => a[1] - b[1]).slice(-KEEP);
  memory = new Map(kept);
  try { localStorage.setItem(WATCHED_KEY, JSON.stringify(kept)); } catch { /* No storage: the page's memory holds the marks. */ }
  changed();
}

/** Calls `listener` after every change, also one another tab makes (the `storage` event for the key). Returns the way to stop. */
export function subscribeWatched(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    // A null key is the whole store being cleared: only the page's own marks stay.
    if (event.key !== null && event.key !== WATCHED_KEY) return;
    const merged = new Map(marks());
    for (const [id, at] of stored()) if ((merged.get(id) ?? -Infinity) < at) merged.set(id, at);
    memory = new Map([...merged].sort((a, b) => a[1] - b[1]).slice(-KEEP));
    snapshot = null;
    listener();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

const read = (): ReadonlySet<string> => {
  snapshot ??= readWatched();
  return snapshot;
};

/** The watched marks, read again whenever they change. A server render (and hydration) knows none. */
export function useWatched(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeWatched, read, () => NONE);
}
