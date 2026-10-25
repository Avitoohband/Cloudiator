import type { ActivityChoice, Phase } from '../contracts/commands.ts';
import type { Rules } from './types.ts';
import { RULES_V1 } from './rules-v1.ts';

/**
 * Launch feedback (2026-10-25): whether `choice` may be scheduled in `phase`. Arena only in `rules.schedule.arenaPhases`
 * (the evening in v1); every other choice is open in every part. Pure, so the Edge parser and the client's schedule panel
 * share one rule; SQL restates it in planning_command.
 */
export function choiceAllowedInPhase(phase: Phase, choice: ActivityChoice, rules: Rules = RULES_V1): boolean {
  return choice.kind !== 'arena' || rules.schedule.arenaPhases.some(allowed => allowed === phase);
}
