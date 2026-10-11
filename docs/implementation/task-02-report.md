# Task 2 implementation report

Status: DONE_WITH_CONCERNS (resolved test environment limitation and explicit integration requirements below).
Task date: 2026-10-11. Branch: `codex/gladiator-arena`.
Base: `275625f5e15a17934a39844484fbfffa8986b929`.
Implementation commit: `a361ecdad344a743777c099da11aebae3078f470` — `feat: define versioned gladiator rules`.

## Delivered behavior

The clock uses nonnegative safe-integer server UTC milliseconds, computes `floor(nowMs / 4,800,000)`, and returns an inclusive start/exclusive end window with morning/afternoon/evening phases. `nextPhaseStart` returns only a strictly future occurrence, including when an edit arrives exactly on that phase's start. Unsafe resulting timestamps and unknown phases are rejected. Wednesday/Saturday 17:20 UTC are verified afternoon starts.

Deeply frozen `RULES_V1` and `CATALOG_V1` encode the approved launch values. There are 132 gear variants: 11 templates × three tiers × three rarities plus Common renown variants. Stats, weights, intervals, price multipliers, money-shop eligibility, sell values, renown prices and account binding are explicit. Money shops expose only Common variants; Uncommon/Rare entries carry sell values but have null money purchase prices. Renown entries use Common stats and have no NPC sell value. All three expeditions include their exact enemy attribute vectors, explicit enemy health/damage/intervals, encounter count, gear chance/tier, XP, money and salvage quantities.

Rules also preserve all numeric activity costs, class bonuses, creation/base attributes, resource/load formulas, class/respec/listing fees, inventory/salvage limits, combat/stance coefficients, arena/NPC rewards and reveal timing, league thresholds/strength weights, matchmaking/rating coefficients, tournament timing/placement bonuses, season duration/eligibility/rewards, marketplace expiry/limits and retention periods. These are versioned data; this task does not implement their later simulation or transactional workflows.

Derived attributes combine base five, allocations and immutable equipped-item attribute bonuses, then apply class percentage bonuses with integer hundredths arithmetic and round to two decimals. Health/stamina floor at their defined application point. Equipped slots alone contribute load/armor; overload can penalize heavy equipment without rejecting it, and efficiency has a 0.5 floor. Arena-specific renown armor and weapon multipliers are separate outputs so the later combat engine can apply them once. `preserveStamina` retains current absolute stamina and only clamps down, never refilling after Endurance increases. `activityCost` rounds overloaded costs upward and rejects nonfinite or unsafe results.

Build validation uses canonical command/item types. It validates integer allocation budgets, runtime shapes, class/stance values, the exact five legal slots, item availability from an actor-scoped owned list, immutable-roll numeric values, catalog version/tier/rarity, level locks, duplicate identifiers, listing reservations and two-hand/off-hand conflicts. Successful validation copies and deeply freezes the snapshot, isolating it from later inventory/attribute mutations. Creation requires exactly ten allocated points; later builds may leave earned points unspent. Neither levels nor level-ups add attributes or stamina in the versioned progression rules.

`buildChangeFee` compares the active build with the requested build: spending previously unspent points is free; any decrease costs 100; class change costs 100; both cost 200. The caller must perform transactional reservation, replacement/refund and slot-boundary activation in later backend tasks.

## Files and file-map adjustments

- Created exactly the six specified domain files: `types.ts`, `clock.ts`, `rules-v1.ts`, `catalog-v1.ts`, `stats.ts`, `build.ts` under `supabase/functions/_shared/domain/`.
- Created the owning `tests/domain/clock.test.ts` and `tests/domain/rules.test.ts`; extended `tests/fixtures/domain.ts` without changing the existing owner/world wire samples.
- Added the authorized durable report `docs/implementation/task-02-report.md` and matching scratch `.superpowers/sdd/2026-10-11-gladiator-arena-implementation/task-2-report.md`.
- No source file-map deviation. Small supporting interfaces/helpers live in the specified files: `validateCreationAllocation`, `buildChangeFee`, `preserveStamina`, private catalog types and recursive freeze.
- Kept `docs/implementation/HANDOFF.md` modified by the controller unstaged. No visual-lane files, public wire DTOs, package pins/configuration, UI, engine, backend or Claude-owned files changed. No helpers/reviewers spawned and no push performed.

## Interfaces for later tasks

- `slotAt(nowMs: number): SlotWindow` — index, phase, startMs, endMs.
- `nextPhaseStart(phase: Phase, nowMs: number): number`.
- `deriveStats(build: BuildSnapshot, rules: Rules): DerivedStats` — attributes, maxHp, maxStamina, loadCapacity, load, overload, efficiency, armor, weaponDamage, weaponIntervalMs, arenaArmor and arenaWeaponMultiplier. Input must already be an authoritative validated snapshot.
- `validateBuild(input: BuildInput, owned: ItemInstance[], earnedPoints: number, level: number): BuildValidation`. Success contains snapshot/unspentPoints; failure contains a typed reason.
- `BuildInput` is a Pick of the canonical queue-build command's classId/stance/allocation/equipment fields; wire commands keep singular `allocation`. Private `BuildSnapshot` uses `allocations`, rulesVersion, classId, stance and immutable equipped ItemInstance copies.
- `Rules` is inferred from the frozen v1 configuration; `ItemInstance`, Attributes, ClassId, Stance, Phase and EquipmentSlot are imported/re-exported canonical types. No competing public DTO schema was introduced.
- `activityCost(base: number, overload: number): number`.
- `preserveStamina(current: number, maximum: number): number`.
- `validateCreationAllocation(allocation: Attributes): boolean`.
- `buildChangeFee(current: BuildInput, next: BuildInput): number`.
- `CATALOG_V1.items` uses `template:tier:rarity` IDs and `template:tier:renown` for bound gear. `CATALOG_V1.expeditions` uses the canonical woodland/outpost/mountain IDs.
- `itemFixture(entry: CatalogItem)` returns a mutable fresh canonical ItemInstance. Passing catalog data into the fixture helper avoids a runtime private-domain import in the fixture module used by the client preview gateway.

## Controller rulings recorded

The task controller explicitly approved and required tests for these previously unspecified administrative defaults:

1. An empty weapon contributes zero item damage and uses a 1000 ms base interval; later combat still adds Strength damage. Empty slots remain legal subject to the existing loadout restrictions.
2. Player allocation totals, earned-point budgets and levels have named versioned maxima of 1,000,000,000, with finite safe-integer validation. This bounds arithmetic rather than adding a progression reward. Exact bound, bound plus one, total-over-budget, nonfinite and fractional cases are covered.

Snapshot/catalog immutable stat values remain two-decimal values, rather than requiring integers. Equipment/pending-build reservations are eligible when revising a build; listing reservations are rejected. The backend remains responsible for supplying only the authenticated actor's inventory and for any pending-request reservation identity checks.

## RED evidence

1. Before implementations, ran `npm test -- tests/domain/rules.test.ts tests/domain/clock.test.ts`: exit 1; two failed suites with absent clock/catalog modules. This is the brief's missing-implementation check, not an assertion-level behavioral proof.
2. Added executable placeholder functions and empty catalog, then ran the same command: exit 1; **68 failed / 8 passed, 76 total**. Clock returned endMs 0 instead of 4,800,000 and failed every boundary/future-edit test; class resources were zero instead of the expected health/stamina/load values; creation/valid-build/fee assertions failed. Catalog-dependent cases also failed on the absent entries. The eight passing rejection/default cases are not claimed as independent RED evidence.
3. Self-review identified a floating-point half-cent defect. A new regression hand-derived `(5 + 12 + 0.15) × 1.10 = 18.865`, expected 18.87. `npm test -- tests/domain/rules.test.ts -t "percentage half-cent"`: exit 1; **1 failed / 62 skipped**, actual 18.86. Replaced percentage attribute arithmetic with integer hundredths/percentage points. Final owning/full runs cover this regression.

During implementation, corrected the initial table assertion for money prices on Uncommon/Rare items: the binding spec says NPC shops sell Common only, so the expected moneyPrice is null for other rarities. No product requirement changed.

## GREEN and exact checks

Commands against the final source:

```powershell
npm test -- tests/domain/rules.test.ts tests/domain/clock.test.ts
# exit 0; 2 files passed; 82 tests passed.
# 19 clock cases + 63 catalog/resource/build cases.
# Run after fixed-point correction; final table widening was then
# checked by the complete suite below.

npm test
# exit 0; 4 files passed; 99 tests passed.
# Final run after every renown variant/all-class equipment assertion:
# 2026-10-11 23:03:43, duration 617 ms.

npm run typecheck
# exit 0; tsc --noEmit, no diagnostics.

git diff --check
git diff --cached --check
# exit 0; no whitespace errors. Git emitted configured LF-to-CRLF notices.
```

The full unit suite includes the pre-existing fixture gateway and static scanner tests. Table tests exercise all 99 non-renown and 33 renown variants, hand-derived template stats/prices, all classes' legal equipment, three class bonus vectors, phase boundaries ±1 ms, exact/next phase cutoff behavior, 1/5/10 level locks, three valid stances and an unknown stance, malformed/extra keys, missing ownership, two hands plus shield, duplicate/reserved items, immutable snapshot isolation, minimum efficiency, resource ceilings/clamping, version rejection and administrative bounds.

No browser/build/static-artifact reruns: Task 1 already passed those checks, this task does not change the app/runtime configuration, and the fixture self-review removes the private-domain runtime dependency rather than expanding it. No Deno entrypoints exist yet; runtime Deno checks remain the backend task as already ruled.

## Test environment investigation

The initial RED commands and TypeScript commands worked in the default sandbox. Once shared transformed domain modules existed, repeated focused runs failed before test collection with ENOENT under a Windows sandbox AC/Temp/ssr transformed-module cache path. Both normal repeats and `--maxWorkers=1` reproduced this; serial workers moved the failed module to the second test file while the first suite passed. No domain assertion caused those failures.

The same exact focused command under approved `require_escalated` execution passed 76/76, demonstrating environment/cache isolation rather than a domain failure. Later focused and full verification commands also used approved escalation and passed. No workaround was added to production code or Vitest configuration. The systematic-debugging skill was read for this investigation; it is documented as an environment limitation, not claimed as a verified harness fix. Full suites before the final rounding regression passed 98 tests; the final suite passes 99.

## Self-review and concerns

- Reviewed Task 1 report/review, tracked handoff, canonical commands/reads/events, and the exact Task 2 brief before implementation. Applied TDD (including writing-good-tests), verification-before-completion and systematic-debugging.
- Reconciled class/resources, every catalog template and expedition vector/reward against the supplied reference. Confirmed v1 rules freeze nested class tables and catalog immutable stats.
- Confirmed snapshots copy rolled stats instead of re-deriving current catalog values. Changing the original owned damage to 999 leaves the frozen snapshot damage at six. No caller-owned inventory is frozen.
- Strength half-cent regression now has explicit RED/GREEN proof; hundredths arithmetic also sums load/armor without cumulative floating drift.
- Runtime validation returns typed failures for client build input. Server-scoped ownership, transactions, inventory/reservation changes and mutation authorization remain backend responsibilities; never take `owned` from a client request.
- Build rules reject simultaneous two-hand/shield requests. The later UI/queue workflow may explicitly remove a shield before submission as the design requests; this validator does not silently rewrite a contradictory input.
- Combat multipliers, progression, match ordering, season/tournament rewards and economy data are provided, not executed. Later consumers must use arena modifiers once and preserve absolute stamina with the helper.
- Nonblocking environment concern: Vitest requires approved unsandboxed execution on this Windows environment for shared transformed modules. Git's configured line-ending notices persist.
- No new reusable skill instruction was found necessary: the existing skills already require independent expected values, reproducible environment investigation, true RED/GREEN evidence and full-suite verification.

The controller owns independent review, durable review/HANDOFF updates and the authorized push. The report is committed in a documentation checkpoint so the exact implementation SHA can be recorded without a self-referential commit hash.
