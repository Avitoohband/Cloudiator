// Patch 1.9 Task 29 (approved mockup 2026-11-13, `.superpowers/design/2026-11-13-stamina-notices/`): the words that say when a planned
// activity will not run, or did not, because of stamina or the daily Training limit. Pure, so the panels only lay them out. The limit comes
// from the rules given (`trainingDailyLimit`, v2's two a game day); no number is written here.
import type { ActivityChoice, Phase, Schedule } from '@contracts/commands';
import { trainingDailyLimit } from '@domain/economy';
import { RULES_V1 } from '@domain/rules-v1';
import { RULES_V2 } from '@domain/rules-v2';
import type { Rules } from '@domain/types';
import type { PartVerdict } from './rest-stamina';

const SLOT_MS = RULES_V1.clock.slotMs;
const PHASES = RULES_V1.clock.phases;
const MINUTE_MS = 60_000;

/** A planned activity that can become a Rest: every kind but Rest itself. */
export type PlannedKind = Exclude<ActivityChoice['kind'], 'rest'>;
/** Why a planned activity became a Rest: its cost was more than the stamina it found, or it was a Training past the day's limit. */
export type RestReason = 'stamina' | 'limit';

const KIND: Record<PlannedKind, string> = { training: 'Training', expedition: 'Expedition', arena: 'Arena', dungeon: 'Dungeon' };
/** "an Expedition", "a Dungeon", "Arena", "Training": the kind as the running note names it. */
const ARTICLED: Record<PlannedKind, string> = { training: 'Training', expedition: 'an Expedition', arena: 'Arena', dungeon: 'a Dungeon' };
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** The daily Training limit of `rules` (v2's when `rules` has none: only v2 has a limit, so only v2 ever gives this reason). */
const limitOf = (rules: Rules) => trainingDailyLimit(rules) ?? trainingDailyLimit(RULES_V2)!;

/**
 * The line a Schedule part shows under its select hint, from its verdict (`partVerdicts`): an amber warning with its hint on a part that will
 * become a Rest, a quiet "Stamina after: N" on one that runs, and nothing on a Rest (its own line says what it gives) or a part that cannot
 * be known.
 */
export type SlotMark = { tone: 'warn'; text: string; hint: string } | { tone: 'quiet'; text: string; hint: null } | null;
export function slotMark(verdict: PartVerdict, choice: ActivityChoice, rules: Rules): SlotMark {
  if (!verdict || choice.kind === 'rest') return null;
  switch (verdict.kind) {
    case 'runs': return { tone: 'quiet', text: `Stamina after: ${verdict.after}`, hint: null };
    case 'stamina': return { tone: 'warn', text: '⚠ Not enough stamina: your gladiator will rest instead',
      hint: `Needs ${verdict.needs}, will have ${verdict.has}. Add a Rest before it or pick a cheaper activity.` };
    case 'limit': return { tone: 'warn', text: `⚠ Training limit: this becomes Rest (${limitOf(rules)} a game day)`,
      hint: 'Pick another activity for this part, or leave it as a Rest.' };
  }
}

/**
 * The on-screen notice (the notices column): when the NEXT slot's planned activity (the saved `day`'s) will not run, its words and the slot
 * it is about. Once per slot: null when that slot's notice was dismissed (`dismissed` holds slot indexes), and null when the next slot runs
 * or cannot be known. "starts in N min" counts whole minutes up to the slot's start from `nowMs` (at least 1).
 */
export function nextSlotNotice({ verdicts, day, nowMs, dismissed, rules = RULES_V2 }: {
  verdicts: Record<Phase, PartVerdict>; day: Schedule; nowMs: number; dismissed: ReadonlySet<number>; rules?: Rules;
}): { slot: number; text: string } | null {
  if (!Number.isFinite(nowMs) || nowMs < 0) return null;
  const slot = Math.floor(nowMs / SLOT_MS) + 1;
  if (dismissed.has(slot)) return null;
  const phase = PHASES[slot % PHASES.length], verdict = verdicts[phase], choice = day[phase];
  if (!verdict || verdict.kind === 'runs' || !choice || choice.kind === 'rest') return null;
  const minutes = Math.max(1, Math.ceil((slot * SLOT_MS - nowMs) / MINUTE_MS));
  const what = KIND[choice.kind];
  return { slot, text: verdict.kind === 'stamina'
    ? `Not enough stamina for your next ${what} (starts in ${minutes} min). Your gladiator will rest instead.`
    : `Training limit reached: your next ${what} (starts in ${minutes} min) will be a Rest (${limitOf(rules)} a game day).` };
}

/** The reason as the running card and the notification name it. */
const reasonText = (reason: RestReason, rules: Rules) => (reason === 'stamina' ? 'not enough stamina' : `Training limit: ${limitOf(rules)} a game day`);

/**
 * The running card when the part running now rests instead of its plan: "Resting", "instead of Expedition: not enough stamina" (or
 * "instead of Training: Training limit: 2 a game day"), and "Planned: Expedition · Woodland Path (had 12, needed 30)". The numbers are said
 * only when both are known.
 */
export function runningRestLines({ planned, destination, reason, had, needed }: { planned: PlannedKind; destination: string | null; reason: RestReason; had: number | null; needed: number | null },
  rules: Rules): { what: string; instead: string; planned: string } {
  const numbers = reason === 'stamina' && had !== null && needed !== null ? ` (had ${had}, needed ${needed})` : '';
  return { what: 'Resting', instead: `instead of ${KIND[planned]}: ${reasonText(reason, rules)}`,
    planned: `Planned: ${KIND[planned]}${destination ? ` · ${destination}` : ''}${numbers}` };
}

/**
 * The note above the cards while the running part rests instead of its plan: "Afternoon is resting now instead of an Expedition (not enough
 * stamina). It ends 4:20 AM. A change to the afternoon starts with the next afternoon, tomorrow 1:20 AM." `ends` and `next` are slot times
 * (`slotTimeText`); one that cannot be shown ('') is left out.
 */
export function runningRestNotice({ phase, planned, reason, ends, next }: { phase: Phase; planned: PlannedKind; reason: RestReason; ends: string; next: string }, rules: Rules): string {
  const at = (time: string) => (/^\d/.test(time) ? `at ${time}` : time);
  return `${capital(phase)} is resting now instead of ${ARTICLED[planned]} (${reasonText(reason, rules)}).${ends ? ` It ends ${ends}.` : ''}`
    + ` A change to the ${phase} starts with the next ${phase}${next ? `, ${at(next)}` : ''}.`;
}

/** The planned activity's name as it appears after “rested instead of”. */
export function restedActivityName({ planned, destination }: { planned: PlannedKind; destination: string | null }): string {
  return planned === 'expedition' || planned === 'dungeon'
    ? destination ? `the ${destination} ${planned}` : planned === 'expedition' ? 'an expedition' : 'a dungeon'
    : KIND[planned];
}

/**
 * The owner's notification of a rest that replaced a planned activity: "Aster rested instead of the Ruined Outpost expedition" (a dungeon
 * likewise, "instead of Arena", "instead of Training"), with its reason as the one line. Owner only: other players never see a reason.
 */
export function restedNoteLines(rest: { planned: PlannedKind; destination: string | null; reason: RestReason }, name: string | null,
  rules: Rules): { title: string; lines: string[] } {
  return { title: `${name ?? 'Your gladiator'} rested instead of ${restedActivityName(rest)}`,
    lines: [rest.reason === 'stamina' ? 'Not enough stamina' : `Training limit: ${limitOf(rules)} a game day`] };
}

/** The owner's own Results line for such a rest: "Aster rested instead of Expedition: not enough stamina" (others still read "finished resting"). */
export function restedResultText(name: string, { planned, reason }: { planned: PlannedKind; reason: RestReason }, rules: Rules): string {
  return `${name} rested instead of ${KIND[planned]}: ${reason === 'stamina' ? 'not enough stamina' : `Training limit, ${limitOf(rules)} a game day`}`;
}

/**
 * Patch 1.9 Task 29 addition (Avi, 2026-11-13: "it should also appear as the expedition pop up appear, and the user can dismiss it"): the
 * pop-up while the RUNNING slot rests instead of its plan. Heading "Stamina" (shown in capitals) or "Training limit"; "Aster is resting instead
 * of the Woodland Path expedition: not enough stamina (had 12, needed 30)." (the numbers only when both are known), "instead of the Arena",
 * "instead of Training", or "Aster is resting instead of Training: 2 Trainings a game day."
 */
export function restingNowText({ name, planned, destination, reason, had, needed }: {
  name: string; planned: PlannedKind; destination: string | null; reason: RestReason; had: number | null; needed: number | null;
}, rules: Rules): { heading: string; text: string } {
  if (reason === 'limit') return { heading: 'Training limit', text: `${name} is resting instead of Training: ${limitOf(rules)} Trainings a game day.` };
  const what = planned === 'expedition' || planned === 'dungeon'
    ? destination ? `the ${destination} ${planned}` : planned === 'expedition' ? 'an expedition' : 'a dungeon'
    : planned === 'arena' ? 'the Arena' : 'Training';
  const numbers = had !== null && needed !== null ? ` (had ${had}, needed ${needed})` : '';
  return { heading: 'Stamina', text: `${name} is resting instead of ${what}: not enough stamina${numbers}.` };
}

/** The pop-up for the running `slot`, or null when nothing rests instead (`rested` null) or that slot's pop-up was dismissed: once per slot. */
export function restingNowPopup({ rested, name, slot, had, needed, dismissed }: {
  rested: { planned: PlannedKind; destination: string | null; reason: RestReason } | null; name: string; slot: number; had: number | null; needed: number | null;
  dismissed: ReadonlySet<number>;
}, rules: Rules): { slot: number; heading: string; text: string } | null {
  if (!rested || dismissed.has(slot)) return null;
  return { slot, ...restingNowText({ name, planned: rested.planned, destination: rested.destination, reason: rested.reason, had, needed }, rules) };
}
