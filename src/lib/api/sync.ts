import type { WorldSnapshot } from '@contracts/reads';
import type { GameGateway } from './gateway';

export type SyncState = {
  world: WorldSnapshot | null; offsetMs: number | null; lastSyncMs: number | null;
  processing: boolean; refreshing: boolean; error: 'unavailable' | 'unauthenticated' | null;
  /**
   * The server's newest patch, from every revision read (Patch A, "Patch numbers and the changelog"): a missing or malformed value is
   * null, which shows no notice. A failed read keeps the last one; a session change forgets it until the next read.
   */
  latestPatch: string | null;
  /**
   * The active rules version from every revision read (Patch 1.6 spec, "Client"): its text, or null when a successful read names none
   * (`displayRules` words both). A failed read keeps the last one; so does a session change, since the active rules are the world's, not
   * the account's. Only the newest read of the newest session lands.
   */
  rulesVersion: string | null;
};
export type SyncController = {
  start(): Promise<void>; stop(): void;
  /**
   * Reads the revision (and a changed world) now, or joins the refresh in flight. `fresh` (a command just changed the
   * world, Task 23.4) waits for a refresh in flight and then reads again, so the revision read starts after the change.
   */
  refresh(options?: { fresh?: boolean }): Promise<void>;
};

/**
 * Poll only revision/time after entry. Details and owner management are requested by their consumers. Every refresh,
 * the first included, starts with one timed `revision()` read, the only source of `offsetMs`: a world load spans
 * several requests (pages and its revision checks), so timing it would bias the offset by about half the load. The
 * world is then loaded only when there is none yet or its revision changed. With `{ actors: false }` (a page that only
 * needs the server's time, such as a /replay/ deep link; Task 23.4, C6) the world is never loaded: each refresh publishes
 * the revision as a world without actors.
 */
export function createSync(gateway: GameGateway, listener: (state: SyncState) => void, options: { actors?: boolean } = {}): SyncController {
  const actors = options.actors ?? true;
  let state: SyncState = { world: null, offsetMs: null, lastSyncMs: null, processing: false, refreshing: false, error: null, latestPatch: null, rulesVersion: null };
  let running = false, generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | null = null;
  let unsubscribe: (() => void) | undefined;
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const publish = (next: Partial<SyncState>) => { state = { ...state, ...next }; listener(state); };
  const cancelTimer = () => { clearTimeout(timer); timer = undefined; };
  const schedule = () => { cancelTimer(); if (running && visible()) timer = setTimeout(() => { void refresh(); }, 30_000); };
  function refresh(): Promise<void> {
    if (!running || !visible()) return Promise.resolve();
    if (pending) return pending;
    const ticket = generation;
    publish({ refreshing: true });
    const work = (async () => {
      try {
        const began = Date.now();
        const { latestPatch: latest, rulesVersion: rules, ...clock } = await gateway.revision();
        const ended = Date.now();
        if (ticket !== generation || !running) return;
        // The gateway's read keeps only a well-formed number (readRevision); an older server's read names none.
        const latestPatch = typeof latest === 'string' ? latest : null;
        const rulesVersion = typeof rules === 'string' ? rules : null;
        const offsetMs = clock.serverNowMs - (began + ended) / 2;
        let world: WorldSnapshot;
        if (!actors) world = { ...clock, actors: [] };
        else if (state.world && clock.revision === state.world.revision) world = { ...state.world, ...clock };
        else {
          world = await gateway.world();
          if (ticket !== generation || !running) return;
        }
        publish({ world, offsetMs, lastSyncMs: Date.now(), refreshing: false, latestPatch, rulesVersion,
          processing: world.actors.some(actor => actor.activityStatus === 'processing' || actor.activityStatus === 'queued'), error: null });
      } catch (error) {
        if (ticket !== generation || !running) return;
        const code = error && typeof error === 'object' && 'code' in error && error.code === 'unauthenticated' ? 'unauthenticated' : 'unavailable';
        publish({ refreshing: false, error: code, ...(code === 'unauthenticated' ? { world: null, offsetMs: null, lastSyncMs: null, processing: false, latestPatch: null } : {}) });
      }
    })();
    pending = work.finally(() => { if (ticket === generation) { pending = null; schedule(); } });
    return pending;
  }
  const focus = () => { if (visible()) { cancelTimer(); void refresh(); } };
  const visibility = () => { if (visible()) focus(); else cancelTimer(); };
  const changedSession = () => {
    generation++; pending = null; cancelTimer();
    publish({ world: null, offsetMs: null, lastSyncMs: null, processing: false, refreshing: false, error: null, latestPatch: null });
    // Defer SDK reads until onAuthStateChange returns (Supabase holds its auth lock in callbacks).
    queueMicrotask(() => { if (running) void refresh(); });
  };
  return {
    start() {
      if (running) return pending ?? Promise.resolve();
      running = true; generation++;
      publish({ world: null, offsetMs: null, lastSyncMs: null, processing: false, refreshing: false, error: null, latestPatch: null, rulesVersion: null });
      if (typeof window !== 'undefined') window.addEventListener('focus', focus);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
      unsubscribe = gateway.subscribeSession?.(changedSession);
      return refresh();
    },
    stop() {
      running = false; generation++; pending = null; cancelTimer(); unsubscribe?.(); unsubscribe = undefined;
      if (typeof window !== 'undefined') window.removeEventListener('focus', focus);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility);
    },
    refresh: options => (options?.fresh && pending ? pending.then(() => refresh()) : refresh()),
  };
}
