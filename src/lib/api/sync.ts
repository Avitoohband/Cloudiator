import type { WorldSnapshot } from '@contracts/reads';
import type { GameGateway } from './gateway';

export type SyncState = {
  world: WorldSnapshot | null; offsetMs: number | null; lastSyncMs: number | null;
  processing: boolean; refreshing: boolean; error: 'unavailable' | 'unauthenticated' | null;
};
export type SyncController = { start(): Promise<void>; stop(): void; refresh(): Promise<void> };

/** Poll only revision/time after entry. Details and owner management are requested by their consumers. */
export function createSync(gateway: GameGateway, listener: (state: SyncState) => void): SyncController {
  let state: SyncState = { world: null, offsetMs: null, lastSyncMs: null, processing: false, refreshing: false, error: null };
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
        let began = Date.now();
        let data = state.world ? await gateway.revision() : await gateway.world();
        if (ticket !== generation || !running) return;
        if (state.world && data.revision !== state.world.revision) { began = Date.now(); data = await gateway.world(); }
        if (ticket !== generation || !running) return;
        const ended = Date.now();
        const world = 'actors' in data ? data as WorldSnapshot : state.world ? { ...state.world, ...data } : null;
        publish({ world, offsetMs: data.serverNowMs - (began + ended) / 2, lastSyncMs: ended, refreshing: false,
          processing: world?.actors.some(actor => actor.activityStatus === 'processing' || actor.activityStatus === 'queued') ?? false, error: null });
      } catch (error) {
        if (ticket !== generation || !running) return;
        const code = error && typeof error === 'object' && 'code' in error && error.code === 'unauthenticated' ? 'unauthenticated' : 'unavailable';
        publish({ refreshing: false, error: code, ...(code === 'unauthenticated' ? { world: null, offsetMs: null, lastSyncMs: null, processing: false } : {}) });
      }
    })();
    pending = work.finally(() => { if (ticket === generation) { pending = null; schedule(); } });
    return pending;
  }
  const focus = () => { if (visible()) { cancelTimer(); void refresh(); } };
  const visibility = () => { if (visible()) focus(); else cancelTimer(); };
  const changedSession = () => {
    generation++; pending = null; cancelTimer();
    publish({ world: null, offsetMs: null, lastSyncMs: null, processing: false, refreshing: false, error: null });
    // Defer SDK reads until onAuthStateChange returns (Supabase holds its auth lock in callbacks).
    queueMicrotask(() => { if (running) void refresh(); });
  };
  return {
    start() {
      if (running) return pending ?? Promise.resolve();
      running = true; generation++;
      publish({ world: null, offsetMs: null, lastSyncMs: null, processing: false, refreshing: false, error: null });
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
    refresh,
  };
}
