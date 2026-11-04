// Patch 1.6 (spec "The Training line" and "Generic daily-limit warning"): what the Schedule says about Training under the active rules.
// The point cap and the daily allowance come from economy.ts's accessors (`trainingCap`, `trainingDailyLimit`), never from numbers
// written here: under v1 there is no cap and no daily limit, and the Schedule keeps its old words.
import type { Schedule } from '@contracts/commands';
import { trainingCap, trainingDailyLimit } from '@domain/economy';
import type { Rules } from '@domain/types';

/**
 * How far the point cap lets Training go for a gladiator: its earned points (every attribute point, the 10 from creation included), the
 * cap at its level, whether Training is full (gives no point), and the first level whose cap is above its points (`nextLevel`: the
 * next level while there is room). Null when the rules have no cap (v1) or the numbers are not safe integers (level ≥ 1, earned ≥ 0).
 */
export type TrainingRoom = { earned: number; cap: number; level: number; full: boolean; nextLevel: number } | null;

const count = (value: unknown, minimum: number): value is number => Number.isSafeInteger(value) && (value as number) >= minimum;

export function trainingRoom(progression: { level: number; earnedAttributePoints: number }, rules: Rules): TrainingRoom {
  const level = progression?.level, earned = progression?.earnedAttributePoints;
  if (!count(level, 1) || !count(earned, 0)) return null;
  const cap = trainingCap(rules, level);
  if (cap === null) return null;
  if (earned < cap) return { earned, cap, level, full: false, nextLevel: level + 1 };
  // The cap is base + perLevel × level (economy.ts): the first level whose cap is above `earned` is ⌊(earned − base) / perLevel⌋ + 1.
  const perLevel = trainingCap(rules, 2)! - trainingCap(rules, 1)!, base = trainingCap(rules, 1)! - perLevel;
  return { earned, cap, level, full: true, nextLevel: Math.floor((earned - base) / perLevel) + 1 };
}

const costs = (cost: number) => (cost === 0 ? 'Costs nothing.' : `Costs ${cost} stamina.`);
const whenRuns = (cost: number) => (cost === 0 ? 'When Training runs, it costs nothing.' : `When Training runs, it costs ${cost} stamina.`);

/**
 * The line under a Training choice: below the cap, the point it gives and the cap at the level; at or above it, that it gives nothing
 * until a level whose cap is above the points held; with no room (v1, or numbers that cannot be read), the old line. `cost` is
 * Training's stamina (the rules' base cost, as the Schedule's other lines say theirs).
 */
export function trainingHint(room: TrainingRoom, cost: number): string {
  if (!room) return `Practice yard: builds experience. ${costs(cost)}`;
  if (!room.full) return `Practice yard: +1 attribute point, up to ${room.cap} at level ${room.level} (you have ${room.earned}). ${whenRuns(cost)}`;
  return `Training is full: ${room.earned} points, and level ${room.level} allows ${room.cap}. It gives nothing until level ${room.nextLevel}. ${whenRuns(cost)}`;
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
/** A small count in words ("two"), as the copy says it; a larger one in digits. */
export const countWord = (value: number): string => WORDS[value] ?? String(value);
const list = (items: readonly string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * The generic daily-limit warning the Schedule shows before Save (linked to it, Save stays enabled) for any draft day holding a Training
 * under rules with a daily limit (v2: two actual Trainings a game day; an excess request becomes an ordinary Rest). It names no count of
 * the day's Training so far: the Schedule does not read that history. Null under v1 and for a day without Training.
 */
export function trainingLimitWarning(day: Schedule, rules: Rules): string | null {
  const limit = trainingDailyLimit(rules);
  if (limit === null || !rules.clock.phases.some(phase => day[phase]?.kind === 'training')) return null;
  const n = countWord(limit);
  return `Only ${n} Training activities can run per game day (${list(rules.clock.phases)}). After ${n}, another Training request becomes Rest, `
    + `costs no Training stamina and refills stamina when it ends. Training at the point cap still uses one of the ${n} activities.`;
}
