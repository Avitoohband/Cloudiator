// The display clock shared by the camp scene and the Arena panels: estimated server time in ms. It anchors at the
// first server time it is given, then runs in real time; a later read never moves it back (a static or slower
// read would otherwise replay reveals), while a server ahead of the estimate moves it forward. Fixture tests and
// captures can freeze it. Task 13's shared sync controller can own this clock; it holds no game authority.
export type DisplayClock = {
  now(): number;
  /** True once a server time has been given. */
  synced(): boolean;
  /** A server time from a read: anchors the clock the first time, afterwards only moves it forward. */
  sync(serverNowMs: number): void;
  /** Holds the clock at a time (null lets it run on from there). Server reads never move a frozen clock. */
  freeze(ms: number | null): void;
  frozen(): number | null;
  /** Called after a freeze or release, so views can redraw at once. */
  subscribe(listener: () => void): () => void;
};

export function createDisplayClock(perf: () => number = () => performance.now(), wall: () => number = () => Date.now()): DisplayClock {
  let anchor: { serverMs: number; at: number } | null = null;
  let frozenAt: number | null = null;
  const listeners = new Set<() => void>();
  const running = () => (anchor ? anchor.serverMs + (perf() - anchor.at) : wall());
  const now = () => frozenAt ?? running();
  return {
    now,
    synced: () => anchor !== null,
    sync(serverNowMs) {
      if (!Number.isFinite(serverNowMs) || frozenAt !== null) return;
      if (!anchor || serverNowMs > running()) anchor = { serverMs: serverNowMs, at: perf() };
    },
    freeze(ms) {
      if (ms === null) {
        if (frozenAt !== null) anchor = { serverMs: frozenAt, at: perf() };
      } else if (!Number.isFinite(ms)) return;
      frozenAt = ms;
      for (const listener of [...listeners]) listener();
    },
    frozen: () => frozenAt,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
