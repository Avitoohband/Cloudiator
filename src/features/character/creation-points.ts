// The creation points (launch feedback, 2026-10-25, goal 1): a new gladiator spends exactly `creationPoints` whole points on
// top of the base of every attribute. The server's rule is unchanged (`validateCreationAllocation`); this module is only what
// the "Create your gladiator" dialog needs to make spending them self-explanatory. The totals come from RULES_V1.
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

/** The points still to spend. Never negative: an over-spent allocation (an old saved draft) has none left. */
export function pointsLeft(allocation: Attributes): number {
  return Math.max(0, RULES_V1.attributes.creationPoints - pointsSpent(allocation));
}

/**
 * Sets one attribute to the number the player typed or stepped to. The result is a whole number from 0 to what the field
 * already holds plus the points left, so the total can never pass the points there are (Avi: with 7 left, typing 10 sets 7);
 * `capped` says the wanted number was above that. A fraction is floored, and an empty field or anything that is not a
 * finite number (NaN) counts as 0, never NaN. The allocation passed in is not changed.
 */
export function setPoints(allocation: Attributes, key: keyof Attributes, wanted: number): { allocation: Attributes; capped: boolean } {
  const most = allocation[key] + pointsLeft(allocation);
  const points = Number.isFinite(wanted) ? Math.max(0, Math.min(most, Math.floor(wanted))) : 0;
  return { allocation: { ...allocation, [key]: points }, capped: Number.isFinite(wanted) && wanted > most };
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
 * The short status line shown when a typed number was capped, as in the approved mockup: `cap` is the most the attribute can
 * take now (the points it already holds plus the points left), which is also what it was set to; `left` is the points left
 * before the change. Typing "10" one key at a time with 7 left says 7, not the 6 left after the first digit.
 */
export function cappedNote(name: string, left: number, cap: number): string {
  if (left <= 0) return `No points left to add, so ${name} stays at ${cap}.`;
  return `Only ${cap} point${cap === 1 ? '' : 's'} left, so ${name} was set to ${cap}.`;
}
