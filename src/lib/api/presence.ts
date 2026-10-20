import type { PresenceResult } from '@contracts/commands';
import type { OwnerState } from '@contracts/reads';

/** How often a signed-in player's open page repeats its presence (the design's "at most every 6 hours"). */
export const PRESENCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** When a presence its resting gladiator waits on failed without a retry-after, the one retry comes this much later. */
export const PRESENCE_RETRY_MS = 60_000;

/** Who is viewing: the signed-in account (the fixture preview's stand-in), its gladiator as last read, and whether it rests. */
export type PresenceInput = {
  /** Null for a visitor. */
  account: string | null;
  /** That account's gladiator; null while it has none, or none has been read yet. */
  owner: Pick<OwnerState, 'currentActivity' | 'restingUntilSlot'> | null;
  /** That gladiator rests at home in the shared world (its public actor's `resting`). */
  resting: boolean;
};
export type Presence = {
  /** The viewer changed (or its owner was read again): starts, keeps or stops the signal. */
  update(input: PresenceInput): void;
  stop(): void;
};

/**
 * The owner's activity signal (Task 23.9; Task 23.8's `presence` command, which keeps a character from resting at home
 * after `RULES_V1.idle`). Only a player sends it, never a visitor or an account without a gladiator: once as soon as its
 * gladiator is shown (after sign-in or a page load), then every `PRESENCE_INTERVAL_MS` while the page is visible. A page
 * that is hidden when a presence falls due sends it when it is next visible (a page loaded in the background, its first).
 * Another account starts afresh; a later owner read of the same account sends nothing.
 *
 * `send` gives every presence its own operation id (`GameGateway.sendPresence`). A refusal or a failure is not shown. It
 * waits for the next presence due, except while the gladiator rests waiting on it (resting in the world, no current
 * activity, `restingUntilSlot` null; fix round 1): then that presence is retried once, after the refusal's `retryAfterMs`
 * or `PRESENCE_RETRY_MS`, and a failed retry waits for the next one due. Retries never move the 6-hour cadence.
 *
 * An answered presence reads the owner again (`reread`) when its gladiator has no current activity and no
 * `restingUntilSlot` (it may rest with no signal since it began): the server then knows when it returns. Otherwise the
 * presence cannot change the owner state, so nothing more is read. Nothing is read or sent after `stop`, or for an account
 * that is no longer the viewer's.
 */
export function createPresence(options: { send(): Promise<PresenceResult>; reread(): void; intervalMs?: number }): Presence {
  const { send, reread, intervalMs = PRESENCE_INTERVAL_MS } = options;
  let viewer: PresenceInput = { account: null, owner: null, resting: false };
  let running: { account: string; stop(): void } | null = null;
  const unsignalled = () => viewer.owner !== null && viewer.owner.currentActivity === null && viewer.owner.restingUntilSlot === null;

  function start(account: string) {
    let stopped = false, sending = false;
    let dueAt = Date.now();
    /** The one retry of a failed presence the resting gladiator waits on, or null. */
    let retryAt: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const arm = () => {
      clearTimeout(timer);
      const next = retryAt === null ? dueAt : Math.min(dueAt, retryAt);
      timer = setTimeout(tick, Math.max(0, next - Date.now()));
    };
    function tick() {
      if (stopped) return;
      const now = Date.now();
      const due = now >= dueAt, retry = retryAt !== null && now >= retryAt;
      if (!due && !retry) { arm(); return; }
      // Hidden when due: the next visibility change sends it.
      if (!visible()) { clearTimeout(timer); timer = undefined; return; }
      if (due) dueAt = now + intervalMs;
      // A presence due now stands for a pending retry.
      retryAt = null;
      arm();
      attempt(!due);
    }
    function attempt(isRetry: boolean) {
      if (sending) return;
      sending = true;
      void Promise.resolve().then(send).then(result => result, () => null).then(result => {
        if (stopped) return;
        if (result?.ok) { if (unsignalled()) reread(); return; }
        if (isRetry || !viewer.resting || !unsignalled()) return;
        retryAt = Date.now() + Math.max(0, result?.retryAfterMs ?? PRESENCE_RETRY_MS);
        arm();
      }).finally(() => { sending = false; });
    }
    const onVisibility = () => { if (visible()) tick(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    tick();
    return {
      account,
      stop() {
        stopped = true; clearTimeout(timer);
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      },
    };
  }

  return {
    update(input) {
      viewer = input;
      const player = input.account !== null && input.owner !== null ? input.account : null;
      if (running && running.account === player) return;
      running?.stop();
      running = player === null ? null : start(player);
    },
    stop() { running?.stop(); running = null; viewer = { account: null, owner: null, resting: false }; },
  };
}
