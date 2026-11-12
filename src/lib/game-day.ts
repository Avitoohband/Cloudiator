import { FEEDBACK } from '@domain/feedback';

// The game day (patch 1.9, Feedback and Buy back): three 80-minute slots, 4 real hours, aligned to the Unix epoch as the server counts it
// (`floor(time / 14,400,000)`). Feedback's 5 a game day and Buy back's "until the next game day" both use it. Times are the shared display
// clock's (server time), so the client and the server agree on the boundary; the server stays the authority on what is allowed.

/** One game day in ms. */
export const GAME_DAY_MS = FEEDBACK.gameDayMs;
/** The game day `ms` falls in. */
export const gameDayOf = (ms: number): number => Math.floor(ms / GAME_DAY_MS);
/** When the game day after the one `ms` falls in starts. */
export const nextGameDayMs = (ms: number): number => (gameDayOf(ms) + 1) * GAME_DAY_MS;

const MINUTE = 60_000, HOUR = 60 * MINUTE;
/** U+00A0 between a number and its unit, so "2 h" never parts across two lines. */
const NBSP = ' ';
/**
 * A wait in whole hours and minutes, never rounded up: "2 h 20 min", "2 h", "45 min", and "under a minute" for less than one (also for
 * none: the caller decides what a wait that is over says).
 */
export function waitText(ms: number): string {
  if (!(ms >= MINUTE)) return 'under a minute';
  const hours = Math.floor(ms / HOUR), minutes = Math.floor((ms % HOUR) / MINUTE);
  if (hours === 0) return `${minutes}${NBSP}min`;
  return minutes === 0 ? `${hours}${NBSP}h` : `${hours}${NBSP}h ${minutes}${NBSP}min`;
}
