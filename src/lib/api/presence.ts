import type { PresenceResult } from '@contracts/commands';
import type { OwnerState } from '@contracts/reads';

/** How often a signed-in player's open page repeats its presence (the design's "at most every 6 hours"). */
export const PRESENCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Who is viewing: the signed-in account (the fixture preview's stand-in) and its gladiator as last read. */
export type PresenceInput = {
  /** Null for a visitor. */
  account: string | null;
  /** That account's gladiator; null while it has none, or none has been read yet. */
  owner: Pick<OwnerState, 'currentActivity' | 'restingUntilSlot'> | null;
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
 * `send` gives every presence its own operation id (`GameGateway.sendPresence`). A refusal or a failure is not shown and
 * not retried early: the next presence is the next one due. An answered presence reads the owner again (`reread`) when its
 * gladiator rests with no signal since it began (no current activity, `restingUntilSlot` null): the server then knows when
 * it returns. Otherwise the presence cannot change the owner state, so nothing more is read. Nothing is read or sent after
 * `stop`, or for an account that is no longer the viewer's.
 */
export function createPresence(options: { send(): Promise<PresenceResult>; reread(): void; intervalMs?: number }): Presence {
  const { send, reread, intervalMs = PRESENCE_INTERVAL_MS } = options;
  let owner: PresenceInput['owner'] = null;
  let running: { account: string; stop(): void } | null = null;

  function start(account: string) {
    let stopped = false, sending = false;
    let dueAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const arm = () => { clearTimeout(timer); timer = setTimeout(tick, Math.max(0, dueAt - Date.now())); };
    function tick() {
      if (stopped) return;
      if (Date.now() < dueAt) { arm(); return; }
      // Hidden when due: the next visibility change sends it.
      if (!visible()) { clearTimeout(timer); timer = undefined; return; }
      dueAt = Date.now() + intervalMs;
      arm();
      if (sending) return;
      sending = true;
      void Promise.resolve().then(send).then(result => {
        if (stopped || !result.ok) return;
        if (owner && owner.currentActivity === null && owner.restingUntilSlot === null) reread();
      }, () => undefined).finally(() => { sending = false; });
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
      owner = input.owner;
      const player = input.account !== null && input.owner !== null ? input.account : null;
      if (running && running.account === player) return;
      running?.stop();
      running = player === null ? null : start(player);
    },
    stop() { running?.stop(); running = null; owner = null; },
  };
}
