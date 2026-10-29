// What a class gives (Patch A item 4), said in words, and the class's suggested split of attribute points. The bonuses are read from
// the rules (`RULES_V1.classes`, a multiplier on each attribute's value); the split is the creation dialog's `CLASS_SUGGESTIONS`, a
// share of every 10 points. Nothing here is sent to the server: "Suggested for {class}" only fills the build form's fields.
import type { Attributes, ClassId } from '@contracts/commands';
import { RULES_V1 } from '@domain/rules-v1';
import { ATTRIBUTE_KEYS, CLASS_SUGGESTIONS } from './creation-points';

const title = (value: string) => value[0].toUpperCase() + value.slice(1);

/** One bonus of a class: the attribute and how many percent above 1 its multiplier is (Guardian: Vitality 1.05 is +5%). */
export type ClassBonus = { attribute: keyof Attributes; percent: number };

/** The bonuses of a class: every multiplier above 1, in attribute order. */
export function classBonuses(classId: ClassId): ClassBonus[] {
  const multipliers = RULES_V1.classes[classId];
  return ATTRIBUTE_KEYS.filter(attribute => multipliers[attribute] > 1)
    .map(attribute => ({ attribute, percent: Math.round((multipliers[attribute] - 1) * 100) }));
}

/** A bonus as its chip says it: "Vitality +5%". */
export function bonusText(bonus: ClassBonus): string {
  return `${title(bonus.attribute)} +${bonus.percent}%`;
}

/** What each class's bonus means to a player (Claude's call, approved with the mockup): it counts from points and from gear. */
export const CLASS_MEANING: Record<ClassId, string> = {
  berserker: 'From points and gear alike: every hit lands harder.',
  guardian: 'From points and gear alike: more health and more stamina.',
  duelist: 'From points and gear alike: faster, and hits more often.',
};

/** The suggested split of every 10 points, largest share first, ties in attribute order, zeros kept. */
export function suggestedShares(classId: ClassId): { attribute: keyof Attributes; points: number }[] {
  return ATTRIBUTE_KEYS.map(attribute => ({ attribute, points: CLASS_SUGGESTIONS[classId][attribute] }))
    .sort((a, b) => b.points - a.points); // a stable sort: equal shares stay in attribute order
}

/**
 * "Suggested for {class}": `allocation` with exactly `left` more points on it, given the class's way. Each attribute takes the
 * whole number of its share of `left` (`floor(left × share / 10)`); the points still left go one each by the largest remainder,
 * ties by the larger share, then attribute order. Only adds: nothing is lowered, an attribute with no share gets nothing, and a
 * `left` that is not a whole number above 0 adds nothing. The allocation passed in is not changed.
 */
export function suggestedSplit(allocation: Attributes, left: number, classId: ClassId): Attributes {
  const shares = CLASS_SUGGESTIONS[classId];
  const total = ATTRIBUTE_KEYS.reduce((sum, key) => sum + shares[key], 0);
  if (!Number.isSafeInteger(left) || left <= 0 || total <= 0) return { ...allocation };
  const parts = ATTRIBUTE_KEYS.map((attribute, order) => ({ attribute, order, share: shares[attribute], whole: Math.floor(left * shares[attribute] / total),
    remainder: (left * shares[attribute]) % total }));
  const leftOver = left - parts.reduce((sum, part) => sum + part.whole, 0);
  // The leftover is less than the attributes that have a remainder (their remainders add up to leftOver × total, each below total).
  const next = { ...allocation };
  for (const part of parts) next[part.attribute] += part.whole;
  [...parts].sort((a, b) => b.remainder - a.remainder || b.share - a.share || a.order - b.order).slice(0, leftOver)
    .forEach(part => { next[part.attribute] += 1; });
  return next;
}

/** What the split changed, as the build form's status line says it: "+1 Strength, +1 Vitality, +1 Endurance: the Guardian split." */
export function splitNote(before: Attributes, after: Attributes, classId: ClassId): string {
  const added = ATTRIBUTE_KEYS.filter(key => after[key] > before[key]).map(key => `+${after[key] - before[key]} ${title(key)}`);
  return `${added.length ? added.join(', ') : 'No points to add'}: the ${title(classId)} split.`;
}
