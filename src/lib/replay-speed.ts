import type { ReplaySpeed } from '../game/replay';

// The replay speed this device remembers (Arena replays spec 2): 1×, 2× or 4×, kept on this device only (never on the account) in
// `cloudiator.replay-speed.v1` as '1', '2' or '4'. A per-device convenience: every access is inside try/catch, and the choice made on
// this page answers where the device's storage cannot hold it (private mode, blocked site data), so a speed changed holds for the
// page's life (plan Review Focus 1).

/** The device key. */
export const SPEED_KEY = 'cloudiator.replay-speed.v1';

const STORED: Record<ReplaySpeed, '1' | '2' | '4'> = { normal: '1', double: '2', fast: '4' };
const SPEED_OF: Record<string, ReplaySpeed> = { 1: 'normal', 2: 'double', 4: 'fast' };

/** The choice made on this page, kept for the page's life. */
let remembered: ReplaySpeed | null = null;
/** Whether the last choice did not reach storage: an older value still readable there must not undo it. */
let unsaved = false;

/** The stored speed if it is one of '1', '2' or '4', else the choice made on this page, else 1×. */
export function readReplaySpeed(): ReplaySpeed {
  if (!unsaved) {
    try {
      const stored = localStorage.getItem(SPEED_KEY);
      if (stored !== null && Object.hasOwn(SPEED_OF, stored)) return SPEED_OF[stored];
    } catch { /* No storage: the page's own memory answers. */ }
  }
  return remembered ?? 'normal';
}

/** Makes `speed` this device's choice: held in memory first, then stored if the device lets it. */
export function saveReplaySpeed(speed: ReplaySpeed): void {
  remembered = speed;
  try { localStorage.setItem(SPEED_KEY, STORED[speed]); unsaved = false; } catch { unsaved = true; }
}
