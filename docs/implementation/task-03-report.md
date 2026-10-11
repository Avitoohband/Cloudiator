# Task 3 implementation report

Status: DONE_WITH_CONCERNS (environment limitation and later integration responsibilities below).
Task date: 2026-10-11. Branch: `codex/gladiator-arena`.
Base: `190d8c7aeb1f92c3ad0091305f718e409d7d588a`.
Implementation commit: `f6d9081ce14535749bf5a8629b6e221cfc107b0f` — `feat: simulate deterministic gladiator combat`.

## Delivered behavior

The pure backend engine produces the same complete immutable JSON log for a retained pair of fighter snapshots, explicit rules version and private seed. The fixed random algorithm is `fnv1a-utf16-mulberry32-v1`: FNV-1a hashes JavaScript UTF-16 code units into a 32-bit state, then Mulberry32 emits values in `[0, 1)`. Every scheduled attack consumes two draws (hit, then critical, including misses); an equal-outcome tie consumes the next draw. No clock, network, browser engine, global random state, current catalog or current-rules singleton participates.

`makeFighter` consumes Task 2's validated immutable build and exact effective stats. Base damage is context-adjusted item weapon damage plus half effective Strength. Renown weapon damage and armor receive their arena bonus once; expeditions use ordinary item stats. Efficiency stays at its precise derived value for damage and attack speed. Attack intervals round after the specified formula and clamp to at least 250 ms. Unarmed item damage remains zero with a 1000 ms base interval, and Strength still contributes damage.

The two-entry timestamp priority queue delays first attacks by their entire intervals. Every equal-time group rolls all attacks before applying health changes and checking defeat. Group event order follows input participant order, never an ID sort; the ordering does not suppress an equal-time defeated fighter's attack. Events carry consecutive sequences beginning at zero, including the final victory. Health changes reduce to the recorded final health exactly.

Hit/critical probabilities use the approved coefficients and clamps. Damage applies efficiency, critical, outgoing stance, incoming stance and capped armor once, then performs one nonnegative half-up integer rounding with at least one damage on a hit. Decimal factors use internal BigInt rational arithmetic to prevent binary half-rounding errors. BigInts never enter public DTOs. Misses have zero damage, no critical, unchanged health and `evade: true`. `defend: true` means a landed attack received Defensive stance mitigation; no independent block or evade roll was invented.

Every fight names a winner. Defeat ends after its full simultaneous group. The 120,000 ms boundary includes attacks scheduled exactly at the limit and excludes later attacks. Surviving health fractions are compared with exact BigInt cross products rather than overflowing or nearly equal floating fractions. Equal fractions and mutual defeat consume a seeded tie selection, recorded as `equal-health-fraction` or `simultaneous-defeat` respectively.

Arena/tournament callers omit `startingHealth`, so health defaults to full. Expedition callers may carry a positive safe-integer health value at most the fighter's maximum; public `initialHealth` records this for replay. Authoritative inputs are validated for version/stance/class, finite nonnegative stats, positive safe health/interval, legal efficiency and distinct participant IDs. Returned snapshots/logs copy public fields and recursively freeze them without freezing caller data.

## Files and scope

- Created `supabase/functions/_shared/domain/random.ts`, `combat.ts` and `tests/domain/combat.test.ts`.
- Extended canonical private `domain/types.ts` and canonical public `contracts/events.ts`; no competing log definition.
- Added tracked `docs/implementation/task-03-report.md` and identical ignored scratch `.superpowers/sdd/2026-10-11-gladiator-arena-implementation/task-3-report.md`.
- No other source-map change, package/configuration changes, frontend/private runtime imports, visual-lane files, replay tests or preview changes. Controller-owned `HANDOFF.md` remains unstaged. No helpers/reviewers spawned and no push performed.

## Interfaces for later tasks

- `seededRandom(seed: Seed): () => number`, with exported `RANDOM_VERSION`. Seed must be a nonempty private string; this generator is reproducible simulation randomness, not a source of authentication material. Backend seed generation/storage remain later work.
- `makeFighter(build: BuildSnapshot, context: 'arena' | 'expedition', rules: Rules): FighterSnapshot` returns deeply frozen combat fields: rulesVersion, classId, stance, effective attributes, maxHealth, effective armor/weaponDamage, pre-efficiency `baseDamage`, derived attackIntervalMs, precise efficiency and copied catalog-ID equipment silhouettes.
- `BattleParticipant` adds only id, gladiatorId, name, snapshot and optional startingHealth. NPC classId/gladiatorId can be null. Stable identity is supplied separately because the canonical BuildSnapshot contains no character identity.
- `BattleInput` contains battleId, rulesVersion, retained Rules and a readonly pair of BattleParticipants. Backend code must load verified immutable snapshots/rules; this is not a public request body.
- `simulateBattle(input: BattleInput, seed: Seed): BattleLog` uses canonical names: participants, events, defenderId, healthBefore/healthAfter and victoryReason.
- Additive public fields: `RevealedCombatant.initialHealth`; attack/victory `sequence`; attack `defend`/`evade`; `BattleLog.finalHp` in participant order; and `tieBreakReason: 'simultaneous-defeat' | 'equal-health-fraction' | null`. Participants, events, health tuples and nested display fields are readonly; the complete returned graph is frozen at runtime.
- `efficiencyBasisPoints` is rounded display information only. Simulation uses private precise efficiency rather than that presentation value.
- NPC/expedition factories can override private maxHealth/baseDamage while keeping efficiency once; they must not recompute damage from the public display snapshot. The fallback factory, encounter generation, settlement/rewards and frontend replay are later tasks.

## Controller rulings and reconciliation

Read Task 1/2 committed reports/reviews, tracked HANDOFF, canonical contracts, domain types/build/stats/rules and the focused Task 3 brief. Retained the numeric/default rulings: finite safe integer player inputs with the named 1,000,000,000 administrative bound; two-decimal immutable items/effective attributes; zero unarmed item damage and 1000 ms interval. Combat intermediates are not prematurely rounded, since Strength and arena multipliers may legitimately introduce further decimal places.

The controller confirmed separate identity/snapshot composition and approved the additive initialHealth/startingHealth contract for carried expedition HP. Sequence appears on both event variants; finalHp follows participant order; canonical event/log names remain intact. Null NPC classId and sanitized equipment silhouettes are supported. Claude's visual lane is unchanged.

## RED evidence

1. Before production functions existed, `npm test -- tests/domain/combat.test.ts` exited 1 with missing `@domain/combat.ts`. This is the brief's expected missing-module check, not an assertion-level behavior proof.
2. Added executable throw/zero placeholders and canonical types, then the same command exited 1: **38 failed / 38 total**. Seed streams were incorrectly identical; combat behavior could not be produced; invalid-input cases received a placeholder Error rather than RangeError. No absent-function behavior is claimed as already implemented at this checkpoint.
3. Self-review enumerated exact rational damage against the float implementation and found half-rounding defects. Added four independent hand-derived cases before the fix. `npm test -- tests/domain/combat.test.ts -t "exact decimal half"` exited 1: **4 failed / 38 skipped**. Examples: `50 × 1.15 = 57.5`, expected 58, actual 57; `60 × 1.5 × 1.15 = 103.5`, expected 104, actual 103. Replaced float product rounding with exact decimal factors and one final rounding.
4. Added the fractional bound-weapon regression before fixing its intermediate rounding. `npm test -- tests/domain/combat.test.ts -t "fractional bound"` exited 1: **1 failed / 44 skipped**; `6.65 × 1.1`, expected 7.315, actual 7.32. Removed premature weapon rounding and retained exact base damage 10.065.
5. Extra self-review assertions pin the independent v1 random vector, non-clamped hit/critical coefficient boundaries, nested unknown-field sanitization and caller mutation isolation. They cover existing implemented behavior; no independent feature-RED claim is made for those additional assertions.

## GREEN and exact checks

Final source verification:

```powershell
npm test -- tests/domain/combat.test.ts
# exit 0; 1 file passed; 45 tests passed, final run 23:18:59.

npm test
# exit 0; 5 files passed; 144 tests passed, final run 23:19:13.
# Approved require_escalated execution for reproduced Windows cache isolation.

npm run typecheck
# exit 0; tsc --noEmit, no diagnostics, after final source changes.

git diff --check
git diff --cached --check
# exit 0; no whitespace errors.
```

Earlier affected-domain verification after exact half-rounding and before the final fractional-weapon regression: `npm test -- tests/domain/combat.test.ts tests/domain/rules.test.ts tests/domain/clock.test.ts`, exit 0, **3 files / 126 tests passed**. The final complete 144-test suite covers the unchanged predecessor domain tests and the added final regression. Final owning tests cover retry determinism, golden stream/winner variation, first/priority/equal-time attacks, actual event reduction, full/carried health, clamp behavior, exact/intermediate damage coefficients, stance/critical/armor rounding, arena-only bonuses, immutable/whitelisted output, corrupt snapshots and timeout winners.

No app/browser/static build rerun: there are no frontend runtime/configuration changes or new client imports, and typecheck/full unit coverage address the affected canonical types. No Deno entrypoints exist yet; entrypoint checking remains the backend task.

## Environment and self-review

The initial/focused tests ran in the default sandbox. A full default-sandbox `npm test` reproduced the known ENOENT for Windows AC/Temp/ssr transformed modules: combat, clock and rules suites failed during imports; the two unrelated files' 17 tests passed. The same full command under approved escalation passed all 137 tests at that stage, and the final full run passed all 144. This is recorded as environment isolation, not a product assertion failure or verified harness fix. No workaround or config change was added.

The default-sandbox Git stage/commit attempt could not write `.git/index.lock` due to the read-only Git permission. Authorized escalated stage/commit succeeded. Only the five named implementation files were staged. Git's configured LF-to-CRLF notices persist.

Self-review checked exact formulas, decimal half cases, queue cutoff and simultaneity, sequence/final-health reduction, ID independence, required private inputs, unknown nested-field exclusion, copied snapshots, no caller freezing, no JSON BigInts/private seeds and no scope crossover. Retained-rule use is tested with a supplied historical-rule fixture; RULES_V1 remains untouched. Prior seven-day replay retention and settlement timing are data/backend responsibilities outside this pure engine.

No blocking product concern identified. Later backend tasks must securely generate/store seeds, select retained rule/algorithm modules, create explicit NPC/expedition snapshots, persist snapshots and public logs, reveal at the authorized time and award rewards transactionally. This task alone does not claim playable backend battles or UI replay integration. Existing skill guidance already covers independent expected values, true RED/GREEN and reproducible verification; no reusable upkeep change is proposed.

The controller owns independent review, durable review/HANDOFF updates and the authorized push. This report is committed separately so it can record the exact implementation SHA without a self-referential hash.

## Independent review fix — round 1

Fix base: `f3852216a70fb5051cad0a2403ccf2dff87cdd05`. Task date: 2026-10-11.

The controller supplied one Important finding: arena armor was prematurely rounded in the unchanged Task 2 derivation before reaching combat. A valid immutable renown armor roll of 6.65 was boosted to 7.32 rather than 7.315. A guaranteed balanced attack with base damage 20.5 therefore dealt 17 instead of the required 18. This finding invalidates the earlier no-blocking-concern self-review statement for the original checkpoint; the correction below is verified, while independent re-review remains controller-owned.

Read the receiving-code-review skill, inspected the full finding and the `deriveStats` → `makeFighter` → final damage path, and reproduced both the wrong derived stat and its observable attack effect before changing production code.

Smallest shared fix: remove only the final hundredths rounding from `deriveStats.arenaArmor`. Armor roll hundredths multiplied by integer percentage points now divide once by 10,000, retaining `6.65 × 1.1 = 7.315`. Combat already consumes that value and uses exact decimal factors with one final damage rounding, so no duplicate derivation or combat/renderer workaround is needed. Ordinary armor, effective attributes, item roll precision, overload, and all rule coefficients remain unchanged. This authorized file-map adjustment touches Task 2's shared `supabase/functions/_shared/domain/stats.ts`; the `DerivedStats.arenaArmor` number interface remains the same, but its arena-modifier intermediate can have more than two decimal places. Backend consumers must preserve that precision until their defined final rounding point.

Added covering regressions:

- `tests/domain/rules.test.ts` — **retains fractional renown arena armor without intermediate rounding**: derives ordinary armor 6.65 and exact arena armor 7.315 from a canonical bound item with a valid fractional immutable roll.
- `tests/domain/combat.test.ts` — **preserves fractional bound arena armor through final attack damage rounding**: consumes the real derived fighter, verifies the first attack deals 18 and changes HP 100 → 82, verifies public effective armor 7.315, and confirms expedition armor stays 6.65. Hand-derived result: `20.5 × (1 − .02 × 7.315) = 17.50085`, which rounds upward to 18.

Exact commands and results:

```powershell
npm test -- tests/domain/combat.test.ts tests/domain/rules.test.ts -t "fractional.*armor"
# RED, exit 1, 23:25:58.
# Test Files 2 failed (2); Tests 2 failed | 108 skipped (110).
# Combat actual damage 17 / healthAfter 83, expected 18 / 82.
# Shared stats actual arenaArmor 7.32, expected 7.315.

npm test -- tests/domain/combat.test.ts tests/domain/rules.test.ts
# GREEN, exit 0, 23:26:14.
# Test Files 2 passed (2); Tests 110 passed (110).
# Includes 46 combat tests and 64 rules/build/catalog/resource tests.

npm run typecheck
# exit 0; tsc --noEmit; no diagnostics.

npm test
# exit 0, 23:26:23.
# Test Files 5 passed (5); Tests 146 passed (146).

git diff --check
git diff --cached --check
# exit 0; no whitespace errors.
```

Vitest commands used the already verified necessary approved escalation for Windows shared transformed-module cache isolation; no repeated environment investigation or harness workaround. Self-review confirmed exactly one bound armor modifier, unchanged ordinary/expedition armor, unchanged public/domain type shapes and no new premature damage rounding. Source fix, the two tests and this appended report are committed together; the ignored scratch report is copied identically. No app/browser/build rerun, preview interruption, visual-lane changes, HANDOFF staging, helper/reviewer spawning or push. Independent scoped re-review/publication remain with the controller. No remaining fix-specific limitation identified.
