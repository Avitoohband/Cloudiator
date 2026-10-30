import { RULES_V1 } from './rules-v1.ts';
import { RULES_V2 } from './rules-v2.ts';
import type { Rules } from './types.ts';

/**
 * Retained rules by version: every version a frozen activity, job, snapshot or tournament graph may carry (runbook,
 * "Retained-rule deployments"). Arena and the tournament read it through arena.ts's re-export. A version not listed here
 * fails closed.
 */
export const RETAINED_RULES: Readonly<Record<string, Rules>> = Object.freeze({ [RULES_V1.version]: RULES_V1, [RULES_V2.version]: RULES_V2 });

/** The retained rules of `version`; anything else (an unknown or a non-string version) is a RangeError. */
export function retainedRules(version: unknown): Rules {
  if (typeof version !== 'string' || !Object.hasOwn(RETAINED_RULES, version)) throw new RangeError('Unsupported rules version');
  return RETAINED_RULES[version];
}

/**
 * `rules` itself when it is the retained constant of its version (`retainedRules`' RangeError for an unknown version). A copy,
 * even an equal or frozen one, is a RangeError with its own message: code that plans or pays under a version (the expedition
 * planner, the worker's executors) receives the retained constants by reference, so a copy is a caller's bug, not an
 * unsupported version.
 */
export function requireRetained(rules: Rules): Rules {
  if (retainedRules(rules?.version) !== rules) throw new RangeError('Rules must be the retained constants, never a copy');
  return rules;
}

/** Whether `rules` is Patch 1.6's economy (economy.ts reads the differences through it). */
export function isRulesV2(rules: Rules): rules is typeof RULES_V2 {
  return rules.version === RULES_V2.version;
}
