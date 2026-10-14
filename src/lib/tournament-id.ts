// Pure tournament identifiers: Task 19's graph id of a league tournament, `tournament:<slot>:<league>`, and its bout ids,
// `<tournament id>:<round>:<position>`. Shared by the reads layer, the stage core and the camp; it imports neither the
// API layer nor Supabase, so the game modules stay free of transport code.
import type { LeagueId } from '@contracts/commands';

/** A league tournament's id; the slot is a nonnegative integer of at most 15 digits. */
export const TOURNAMENT_ID = /^tournament:(\d{1,15}):(bronze|silver|gold|champion)$/;
/** One bout of a league tournament (round 1 and up, position 0 and up). */
export const TOURNAMENT_BOUT_ID = /^tournament:\d{1,15}:(?:bronze|silver|gold|champion):\d{1,3}:\d{1,5}$/;

/** The lookup id of a league's tournament in a slot, or null when the slot or league cannot name one. Never throws. */
export function tournamentLookupIdOrNull(slotIndex: unknown, league: unknown): string | null {
  if (typeof slotIndex !== 'number' || !Number.isSafeInteger(slotIndex) || slotIndex < 0 || typeof league !== 'string') return null;
  const id = `tournament:${slotIndex}:${league}`;
  return TOURNAMENT_ID.test(id) ? id : null;
}

/** The lookup id of a league's tournament in a slot (Task 19's graph id); throws on an invalid slot or league. */
export function tournamentLookupId(slotIndex: number, league: LeagueId): string {
  const id = tournamentLookupIdOrNull(slotIndex, league);
  if (id === null) throw new RangeError('Invalid tournament lookup');
  return id;
}

/** The slot of a well-formed tournament id, else null. */
export function tournamentSlotOf(id: string): number | null {
  const match = typeof id === 'string' ? TOURNAMENT_ID.exec(id) : null;
  return match ? Number(match[1]) : null;
}
