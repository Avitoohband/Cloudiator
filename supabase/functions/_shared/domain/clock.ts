import type { Phase, SlotWindow } from './types.ts';
import { RULES_V1 } from './rules-v1.ts';

function safeTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Time must be a nonnegative safe integer');
}

/** Server UTC milliseconds; a slot is inclusive at start, exclusive at end. */
export function slotAt(nowMs: number): SlotWindow {
  safeTime(nowMs);
  const { slotMs, phases } = RULES_V1.clock;
  const index = Math.floor(nowMs / slotMs);
  const startMs = index * slotMs;
  const endMs = startMs + slotMs;
  safeTime(endMs);
  return { index, phase: phases[index % phases.length], startMs, endMs };
}

/** A started phase can only be edited for its next game-day occurrence. */
export function nextPhaseStart(phase: Phase, nowMs: number): number {
  const { slotMs, phases } = RULES_V1.clock;
  const phaseIndex = phases.indexOf(phase);
  if (phaseIndex < 0) throw new RangeError('Unknown phase');
  const current = slotAt(nowMs);
  const delta = (phaseIndex - current.index % phases.length + phases.length) % phases.length || phases.length;
  const next = current.startMs + delta * slotMs;
  safeTime(next);
  return next;
}
