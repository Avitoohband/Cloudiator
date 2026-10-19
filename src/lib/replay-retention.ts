// Replay retention on the client (Task 22.5). The server keeps detailed replays seven days (`RULES_V1.retention.replayMs`):
// its hourly cleanup flips an expired summary's `replayExpiry`, deletes the activity's stages and logs, and compacts a
// tournament's bout logs to their fight summaries (14-operations.sql). Between an expiry and that cleanup the summary still
// says `available`, so the client never trusts the state alone: it compares the expiry with the server's time (a read's
// `serverNowMs` or the shared display clock, never the device's clock), and so agrees with the server before and after
// cleanup. Pure: no clock, React or transport.
import type { ActivitySummary } from '@contracts/events';
import { RULES_V1 } from '@domain/rules-v1';
import { TOURNAMENT_BOUT_ID, tournamentSlotOf } from './tournament-id';

export type ReplayExpiry = ActivitySummary['replayExpiry'];

/** Whether an activity's replay is kept at the server time: its summary says `available` and its expiry is still ahead. */
export function replayKept(expiry: ReplayExpiry, serverNowMs: number): boolean {
  return expiry?.state === 'available' && expiry.expiresAtMs > serverNowMs;
}

/** Whether a tournament's bout replays are kept at the server time: until seven days after the tournament ends. */
export function tournamentReplayKept(endsAtMs: number, serverNowMs: number): boolean {
  return serverNowMs < endsAtMs + RULES_V1.retention.replayMs;
}

/**
 * When the league tournament named by a tournament id (`tournament:<slot>:<league>`) or one of its bout ids ends: the end
 * of its slot, as the server's tournament rows say. Null for anything malformed. Lets an old link be told "no longer
 * kept" without reading its tournament.
 */
export function tournamentEndsAtMs(id: string): number | null {
  if (typeof id !== 'string') return null;
  const slot = tournamentSlotOf(TOURNAMENT_BOUT_ID.test(id) ? id.split(':').slice(0, 3).join(':') : id);
  return slot === null ? null : (slot + 1) * RULES_V1.clock.slotMs;
}
