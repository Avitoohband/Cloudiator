// The creation points (launch feedback, 2026-10-25, goal 1): a new gladiator spends exactly `creationPoints` whole points on
// top of the base of every attribute. The server's rule is unchanged (`validateCreationAllocation`); this module is only what
// the "Create your gladiator" dialog needs to make spending them self-explanatory. The totals come from RULES_V1. The build
// step (level-up points, 2026-10-28) uses the same counter and cap with the points earned as the total, and a floor.
import type { Attributes, ClassId } from '@contracts/commands';
import { RULES_V1 } from '@domain/rules-v1';

/** The five attributes, in the order the dialog lists them. */
export const ATTRIBUTE_KEYS = ['strength', 'agility', 'vitality', 'endurance', 'precision'] as const;

/** Nothing spent yet: a new draft starts here, so the counter reads "10 of 10 left". */
export const EMPTY_ALLOCATION: Attributes = Object.freeze({ strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 });

/** The points put on the five attributes so far. */
export function pointsSpent(allocation: Attributes): number {
  return ATTRIBUTE_KEYS.reduce((sum, key) => sum + allocation[key], 0);
}

/**
 * The points still to spend of `total`: the creation points in the creation dialog, the points earned in the build step. Never
 * negative: an over-spent allocation (an old saved draft) has none left.
 */
export function pointsLeft(allocation: Attributes, total: number): number {
  return Math.max(0, total - pointsSpent(allocation));
}

/**
 * Sets one attribute to the number the player typed or stepped to. The result is a whole number from `floor` to what the field
 * already holds plus the points left of `total`, so the total can never pass the points there are (Avi: with 7 left, typing 10
 * sets 7); `capped` says the wanted number was above that. `floor` is 0 when creating; the build step passes the current
 * build's value, because added points are permanent (Avi, 2026-10-28): `raised` says the wanted number was below it and was
 * lifted to it (never with the default floor of 0: a number below 0 is simply 0). A fraction is floored, and an empty field or anything that is not a finite number (NaN) counts as 0, never NaN
 * (so with a floor it is raised). A field already below its floor (a stale draft) is lifted to the floor, which then wins over
 * the cap. The allocation passed in is not changed.
 */
export function setPoints(allocation: Attributes, key: keyof Attributes, wanted: number, total: number, floor = 0):
  { allocation: Attributes; capped: boolean; raised: boolean } {
  const most = Math.max(floor, allocation[key] + pointsLeft(allocation, total));
  const count = Number.isFinite(wanted) ? Math.floor(wanted) : 0;
  return { allocation: { ...allocation, [key]: Math.max(floor, Math.min(most, count)) }, capped: Number.isFinite(wanted) && wanted > most,
    raised: floor > 0 && count < floor };
}

/** "Suggested for {class}": a split of exactly 10 points that suits the class's own bonus. */
export const CLASS_SUGGESTIONS: Record<ClassId, Attributes> = {
  berserker: { strength: 5, agility: 1, vitality: 2, endurance: 1, precision: 1 },
  guardian: { strength: 2, agility: 0, vitality: 5, endurance: 2, precision: 1 },
  duelist: { strength: 2, agility: 4, vitality: 0, endurance: 0, precision: 4 },
};

/** The one-line effect shown under each attribute; the numbers come from the rules (health per vitality, stamina per endurance). */
export const ATTRIBUTE_HINTS: Record<keyof Attributes, string> = {
  strength: 'More damage with every hit',
  agility: 'Faster attacks, harder to hit',
  vitality: `+${RULES_V1.resources.healthPerVitality} health per point`,
  endurance: `+${RULES_V1.resources.staminaPerEndurance} stamina per point, carries more`,
  precision: 'Hits more often, more critical hits',
};

/**
 * The short status line shown when a typed number was capped. `cap` is the most the attribute can take now (the points it
 * already holds plus the points left), which is also what it was set to; `left` is the points left before the change; `held`
 * is what the field held when the player started editing it (its value when it took the focus, final review ruling R10).
 * - Nothing left: the field stays where it is.
 * - The field held 0: the counter showed `cap` left then, so the line says so, as in the approved mockup. Typing "10" one key
 *   at a time with 7 left says 7, not the 6 left after the first digit.
 * - The field already held points: fewer than `cap` were left, so the line names the field's cap instead (2 in Strength, 5
 *   left, typing 9: "Strength can take at most 7, so it was set to 7.").
 */
export function cappedNote(name: string, left: number, cap: number, held: number): string {
  if (left <= 0) return `No points left to add, so ${name} stays at ${cap}.`;
  if (held <= 0) return `Only ${cap} point${cap === 1 ? '' : 's'} left, so ${name} was set to ${cap}.`;
  return `${name} can take at most ${cap}, so it was set to ${cap}.`;
}

/** The status line when a typed number was below the current build's value and was raised to it (`setPoints` `raised`). */
export function raisedNote(name: string, floor: number): string {
  return `${name} can't go below ${floor}: added points are permanent.`;
}
