// The tournament slot rule alone (Tasks 19 M5 and 20): its import graph holds the clock, the rules and the domain types
// but no combat engine, so the client's tournament stage core can name tournament slots without importing the engine,
// even before tree shaking. tournament.ts re-exports it, so the backend and the client use this one rule.
import type { Rules, SlotWindow } from './types.ts';
import { slotAt } from './clock.ts';
import { RULES_V1 } from './rules-v1.ts';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Epoch day 0 (1970-01-01) was a Thursday: weekday 4 in the 0 = Sunday convention of `utcWeekdays`. */
const EPOCH_WEEKDAY = 4;

/** The canonical `slotAt` window for `slot`; anything else (misaligned, wrong phase or length) fails closed. */
function canonicalSlot(slot: SlotWindow): SlotWindow {
  let canonical: SlotWindow | null = null;
  try { canonical = slot !== null && typeof slot === 'object' ? slotAt(slot.startMs) : null; } catch { canonical = null; }
  if (!canonical || canonical.index !== slot.index || canonical.phase !== slot.phase
    || canonical.startMs !== slot.startMs || canonical.endMs !== slot.endMs) throw new RangeError('Invalid slot window');
  return canonical;
}

/**
 * Spec §8.2 fixed times: a tournament slot is the 80-minute afternoon slot starting Wednesday or Saturday at 17:20 UTC.
 * Pure UTC epoch arithmetic on the slot start (no `Date`, local time zone or daylight saving), so local clock changes
 * never move a tournament. Every 17:20 UTC start is an afternoon, because a 24-hour day holds 18 slots. The days and time
 * come from `rules` (default v1); the partition and the bracket pass their entrants' retained rules.
 */
export function isTournamentSlot(slot: SlotWindow, rules: Rules = RULES_V1): boolean {
  const { startMs } = canonicalSlot(slot);
  const { utcWeekdays, hourUtc, minuteUtc } = rules.tournament;
  const day = Math.floor(startMs / DAY_MS);
  return utcWeekdays.includes((day + EPOCH_WEEKDAY) % 7) && startMs - day * DAY_MS === (hourUtc * 60 + minuteUtc) * MINUTE_MS;
}
