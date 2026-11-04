// Patch 1.6 (spec "Client", "The active version"): the rules the client words its texts with. Every revision read names the active rules
// version (`world_revision.rules_version`, M27), visitors' too. Only the economy's texts follow it (the Training line, the daily Training
// limit, tournament entry, Rest projections, salvage values); an activity is still paid by its own frozen version on the server.
import { RULES_V1 } from '@domain/rules-v1';
import { RULES_V2 } from '@domain/rules-v2';
import type { Rules } from '@domain/types';

/**
 * The retained rules to show for the revision read's `version`: `RULES_V2` for exactly 'v2', `RULES_V1` for anything else (a missing,
 * malformed or unknown later version such as 'v3', which this build cannot word). Never throws; always the retained constant itself.
 */
export function displayRules(version: unknown): Rules {
  return version === RULES_V2.version ? RULES_V2 : RULES_V1;
}
