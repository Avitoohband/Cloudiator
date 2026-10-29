// The words and choices of the Schedule panel (launch feedback, 2026-10-25): which choices a part of the day offers, what each
// one costs and does, which part is running, and what a saved day says. Pure, so the panel only lays them out. The rules
// come from `RULES_V1` (stamina costs, the Arena bout's timing, the tournament's days and hour, the parts Arena may take),
// never from numbers written here.
import type { ActivityChoice, DayScheduleValue, Phase, Schedule } from '@contracts/commands';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { slotAt } from '@domain/clock';
import { RULES_V1 } from '@domain/rules-v1';
import { choiceAllowedInPhase } from '@domain/schedule-choice';
import type { Rules } from '@domain/types';
import { slotTimeText } from './slot-time';

/** The parts of the day, in order. */
export const PHASES: readonly Phase[] = RULES_V1.clock.phases;
const MINUTE_MS = 60_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
type ExpeditionId = Extract<ActivityChoice, { kind: 'expedition' }>['expeditionId'];
/** The catalog's expeditions, in its order (the order the select lists them). */
const EXPEDITIONS = Object.keys(CATALOG_V1.expeditions) as ExpeditionId[];
const requiredLevel = (id: ExpeditionId) => CATALOG_V1.expeditions[id].requiredLevel;
const expeditionChoice = (expeditionId: ExpeditionId): ActivityChoice => ({ kind: 'expedition', expeditionId });
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * What a part's select offers a player of `level`: training, rest, Arena only where `rules` allow it (the evening in v1), then
 * the expeditions the level has opened. The expeditions it has not opened are `lockedChoices`: the select still lists them,
 * disabled, so a player sees what the next level brings (as the panel always has).
 */
export function choicesFor(phase: Phase, level: number, rules: Rules = RULES_V1): ActivityChoice[] {
  const always: ActivityChoice[] = [{ kind: 'training' }, { kind: 'rest' }, { kind: 'arena' }];
  return [...always.filter(choice => choiceAllowedInPhase(phase, choice, rules)), ...EXPEDITIONS.filter(id => level >= requiredLevel(id)).map(expeditionChoice)];
}

/** The expeditions a player of `level` has not unlocked yet, in the order the select lists them after the open choices. */
export function lockedChoices(level: number): ActivityChoice[] {
  return EXPEDITIONS.filter(id => level < requiredLevel(id)).map(expeditionChoice);
}

/**
 * The line a part that may not hold Arena says under its select ("Arena runs in the evening only."), or null where Arena is
 * allowed: the parts come from `rules.schedule.arenaPhases`, the same rule the server refuses by.
 */
export function arenaNote(phase: Phase, rules: Rules = RULES_V1): string | null {
  if (choiceAllowedInPhase(phase, { kind: 'arena' }, rules)) return null;
  return `Arena runs in ${rules.schedule.arenaPhases.map(allowed => `the ${allowed}`).join(' and ')} only.`;
}

/** A choice's name: "Training", "Rest", "Arena", "Expedition: Woodland Path". */
export function choiceLabel(choice: ActivityChoice): string {
  if (choice.kind === 'expedition') return `Expedition: ${CATALOG_V1.expeditions[choice.expeditionId].name}`;
  return capital(choice.kind);
}

/** A choice as its select option reads: an expedition also names the level that opens it ("Expedition: Woodland Path · Level 1"). */
export function optionLabel(choice: ActivityChoice): string {
  return choice.kind === 'expedition' ? `${choiceLabel(choice)} · Level ${requiredLevel(choice.expeditionId)}` : choiceLabel(choice);
}

const staminaText = (cost: number) => cost === 0 ? 'Costs nothing.' : `Costs ${cost} stamina.`;

/**
 * One line about a choice, under its select: what it does and what it costs in stamina. Arena also says when its bout is
 * revealed and rewarded within the slot, and that the Wednesday and Saturday evening at the tournament's hour is the tournament.
 * All numbers are `rules`'s: the stamina costs, the reveal minute, the slot's length, the tournament's days and hour (UTC).
 */
export function choiceHint(choice: ActivityChoice, rules: Rules = RULES_V1): string {
  const cost = staminaText(rules.activityStamina[choice.kind]);
  switch (choice.kind) {
    case 'training': return `Practice yard: builds experience. ${cost}`;
    case 'rest': return `Recovers stamina. ${cost}`;
    case 'expedition': return `Gathers loot and gold over the slot. ${cost}`;
    case 'arena': {
      const { utcWeekdays, hourUtc, minuteUtc } = rules.tournament;
      const days = utcWeekdays.map(day => WEEKDAYS[day]).join(' and ');
      return `Bout revealed at minute ${rules.arena.revealAfterMs / MINUTE_MS}, rewards at ${rules.clock.slotMs / MINUTE_MS}. `
        + `${days} ${pad(hourUtc)}:${pad(minuteUtc)} UTC: the tournament. ${cost}`;
    }
  }
}

/**
 * The part of the day the clock is in, and when it ends. A slot is inclusive at its start and exclusive at its end; the display
 * clock's fractional milliseconds are rounded down. `nowMs` must be a finite, nonnegative time (the clock's).
 */
export function runningPart(nowMs: number): { phase: Phase; endsAtMs: number } {
  const slot = slotAt(Math.floor(nowMs));
  return { phase: slot.phase, endsAtMs: slot.endMs };
}

/** "at 7:20 PM" for a time of the same day; a time that names its day ("tomorrow 1:20 AM", "Sat 4:20 AM") reads as it is. */
const atTime = (time: string) => /^\d/.test(time) ? `at ${time}` : time;

/**
 * The notice over the schedule while a part is running: which, when it ends, and that a change to it starts with its next
 * occurrence (`nextStartMs`). Times are `slotTimeText`'s against `nowMs`; a time that cannot be shown is left out.
 */
export function runningNotice(running: { phase: Phase; endsAtMs: number }, nextStartMs: number, nowMs: number): string {
  const { phase } = running;
  const ends = slotTimeText(running.endsAtMs, nowMs), next = slotTimeText(nextStartMs, nowMs);
  return `${capital(phase)} is running now${ends ? ` (ends ${ends})` : ''}. A change to the ${phase} starts with the next ${phase}${next ? `, ${atTime(next)}` : ''}.`;
}

/**
 * What a saved day says: each part the server changed (not `null` in `value.parts`), in day order, with its activity from
 * `choices` (the day that was saved) and the time its change starts, e.g. "Saved. Morning: Training from 6:00 PM. Afternoon:
 * Expedition: Woodland Path from 7:20 PM, after the running afternoon." A part is "running" if it was when the server received
 * the save (`value.receivedAtMs`), not by the clock now; parts that did not change are not named. `nowMs` is the display time
 * the start times are shown against.
 */
export function savedSummary(value: DayScheduleValue, choices: Schedule, nowMs: number): string {
  const received = value.receivedAtMs;
  const running = Number.isFinite(received) && received >= 0 ? runningPart(received).phase : null;
  const named = PHASES.flatMap(phase => {
    const changed = value.parts?.[phase];
    if (!changed) return [];
    const time = slotTimeText(changed.effectiveAtMs, nowMs);
    return [`${capital(phase)}: ${choiceLabel(choices[phase])}${time ? ` from ${time}` : ''}${running === phase ? `, after the running ${phase}` : ''}.`];
  });
  return ['Saved.', ...named].join(' ');
}
