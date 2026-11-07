import type { ActivityChoice, Phase } from '../contracts/commands.ts';
import type { Rules } from './types.ts';
import { RULES_V1 } from './rules-v1.ts';
import { isRulesV2 } from './rules.ts';

/**
 * Whether a choice may be scheduled in a phase. Arena uses the retained Arena phases, and dungeons open only in v2's
 * dungeon phases. Pure, so Edge and the schedule panel can share the rule; SQL restates it in planning_command.
 */
export function choiceAllowedInPhase(phase: Phase, choice: ActivityChoice, rules: Rules = RULES_V1): boolean {
  if (choice.kind === 'arena') return rules.schedule.arenaPhases.some(allowed => allowed === phase);
  if (choice.kind === 'dungeon') return isRulesV2(rules) && rules.schedule.dungeonPhases.some(allowed => allowed === phase);
  return true;
}
