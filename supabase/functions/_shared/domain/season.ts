// Task 21 (plan Decision 2): the season window of a slot. SQL is the one authority for closing a season and selecting its
// awards (private.close_season); this module only names a season's slots and times, exactly as boundary phase 2 writes
// them into public.seasons: season N spans slots epoch + 504 × N up to (not including) epoch + 504 × (N + 1).
import { RULES_V1 } from './rules-v1.ts';

/** One season: its index (players see "Season index + 1"), its first slot and exclusive end slot, and their UTC times. */
export type SeasonWindow = { index: number; firstSlot: number; endSlot: number; startsAtMs: number; endsAtMs: number };

function safeSlot(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Slot must be a nonnegative safe integer');
}

/** The season containing `slotIndex`, counted from the launch epoch slot. A slot before the epoch has no season. */
export function seasonAt(slotIndex: number, epochSlot: number): SeasonWindow {
  safeSlot(slotIndex);
  safeSlot(epochSlot);
  if (slotIndex < epochSlot) throw new RangeError('Slot precedes the season epoch');
  const { durationSlots } = RULES_V1.seasons, { slotMs } = RULES_V1.clock;
  const index = Math.floor((slotIndex - epochSlot) / durationSlots);
  const firstSlot = epochSlot + index * durationSlots, endSlot = firstSlot + durationSlots;
  const startsAtMs = firstSlot * slotMs, endsAtMs = endSlot * slotMs;
  if (!Number.isSafeInteger(endSlot) || !Number.isSafeInteger(endsAtMs)) throw new RangeError('Season time must be a safe integer');
  return { index, firstSlot, endSlot, startsAtMs, endsAtMs };
}
