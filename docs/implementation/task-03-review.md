# Task 3 independent review and fix record

Date: 2026-10-11. Independent `gpt-6.1-sol` reviewer.
Initial range: `190d8c7aeb1f92c3ad0091305f718e409d7d588a..f3852216a70fb5051cad0a2403ccf2dff87cdd05`.

## Initial verdict

Specification issues found; task quality needs fixes. One Important finding, no Critical or Minor findings. This initial verdict was corrected by fix round 1 below.

**Premature arena-armor rounding changes damage.** `supabase/functions/_shared/domain/combat.ts:56` uses `stats.arenaArmor`, which unchanged `domain/stats.ts:30–31` rounds to hundredths. A valid renown armor roll of **6.65 × 1.1** becomes **7.32**, instead of **7.315**. A balanced, guaranteed-hit attack with base damage **20.5** therefore deals **17 instead of 18**. Preserve exact arena armor through combat damage calculation and add this regression.

The reviewer inspected only `stats.ts` outside the task diff for this named risk and ran a focused read-only Node probe, yielding `{ derivedArmor: 7.32, exactArmor: 7.315, actualDamage: 17, damageWithExactArmor: 18 }`. No suites were rerun and no checkout state was mutated.

## Verified strengths

- Named fixed PRNG version and independent output vector (`random.ts:4`, `tests/domain/combat.test.ts:32`).
- All simultaneous attacks resolve before defeat checks; mutual-defeat regression includes both final health values and victory sequence (`combat.ts:123`, `tests/domain/combat.test.ts:100`).
- Public fields are explicitly whitelisted and output graphs frozen (`combat.ts:84`, `combat.ts:154`).
- Timeout fractions use exact cross products; event reduction reproduces recorded health (`combat.ts:143`, `tests/domain/combat.test.ts:132`).

## Fix round 1 — independently approved

Original implementer resumed with the complete finding. Fix base: `f3852216a70fb5051cad0a2403ccf2dff87cdd05`. Required coverage: `tests/domain/combat.test.ts`, plus `tests/domain/rules.test.ts` if shared stats change, and TypeScript. The implementer must reproduce the regression, append actual red/green commands/output to [the task report](task-03-report.md), and commit the fix before scoped independent re-review.

Backend seed storage, retained-module selection, timed reveal, transactional settlement, and rendering remain later-task responsibilities; these do not change the initial finding's severity.


Fix commit: `9fffaf51032587292cf1e3ea8dc54c668b76b0e4`; scoped range `f385221..9fffaf5`. Fresh independent reviewer `gpt-6.1-sol` verified the original finding **ADDRESSED**: `stats.ts:31` preserves arena armor 7.315; `combat.test.ts:79` checks damage18/HP100→82 and unchanged expedition armor6.65; `rules.test.ts:107` independently checks exact derivation. Both regression names and reported true RED failures match the fix diff. The report records 110 covering tests, 146 full-suite tests, and clean TypeScript. No additional test run was necessary.

New fix-diff breakage: none. Out-of-scope observations: none. Final verdict: **all findings addressed; no new Critical or Important breakage**. Task3 is complete and approved for the controller's reviewed checkpoint push. Full implementation range: `190d8c7..9fffaf5`.
