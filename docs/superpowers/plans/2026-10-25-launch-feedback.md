# Launch Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Avi's ten launch-test notes: clearer creation points, an evening-only Arena with evening tournaments, one
all-or-nothing schedule save with a running-part notice, a gear view with Wear buttons, and a 1-gold minimum market fee.

**Architecture:** Rules change in place in `RULES_V1`; the server enforces every rule (Edge parser and SQL), the client
explains it. SQL changes go in one new reapplicable source `supabase/sql/16-launch-feedback.sql` and one generated
migration M23; the gear view reuses `queue-build`/`cancel-build`. Bench first, then production under Avi's pre-approval.

**Tech Stack:** Next.js 16.4.3 static client (React 19), Deno Edge functions sharing TypeScript in
`supabase/functions/_shared`, Supabase Postgres 17 (CLI 2.120.0), Vitest, Playwright (`channel: 'chrome'`).

**Spec:** `docs/superpowers/specs/2026-10-25-launch-feedback-design.md`; the file map is
`docs/superpowers/specs/2026-10-25-launch-feedback-code-map.md` (line numbers there are as of `b826947`).

## Global Constraints

- Tournament time: Wednesday and Saturday, 18:40 UTC, the evening slot (`RULES_V1.tournament.hourUtc 18, minuteUtc 40`).
- Arena may be scheduled only in the `evening` part; morning and afternoon refuse it with `invalid`.
- Market fee: `max(1, floor(price × 5 / 100))`; lowest listing price 2; highest unchanged (1,000,000,000).
- Creation: exactly 10 whole points, 0–10 each (server unchanged); the client starts at 0 each.
- Class suggestions: Berserker `{strength 5, agility 1, vitality 2, endurance 1, precision 1}`; Guardian `{strength 2,
  agility 0, vitality 5, endurance 2, precision 1}`; Duelist `{strength 2, agility 4, vitality 0, endurance 0, precision 4}`.
- Attribute hints (exact copy): Strength "More damage with every hit"; Agility "Faster attacks, harder to hit"; Vitality
  "+10 health per point"; Endurance "+2 stamina per point, carries more"; Precision "Hits more often, more critical hits".
- Committed migrations are never edited; M23 is generated from the tested source and completed per AGENTS.md
  ("Generated migration completion"), then replayed with `db reset --local --no-seed`.
- TDD for every code change; the DB-test rule (Edge container start time unchanged across `npm run test:db`).
- No package downloads. Accessibility as Task 23.5: real buttons and labels, 4.5:1 text, announced status lines.
- Gate of record: `node scripts/verify.mjs --config node_modules/.cache/pw-claude.config.mjs`, 12/12, quiet host.
- Deploy outside Wednesday and Saturday 17:20–20:00 UTC with no open boundary; re-check live data first (spec, "Settled
  after the builder check").

## Review Focus

1. A schedule save racing a boundary or another tab: `conflict` on a stale `expectedVersion`, nothing partly saved
   (Task 2, test `edit-day-schedule refuses a stale version and writes nothing`).
2. A replayed day save (same operation id) after a lost reply returns the stored result, never a second version bump
   (Task 2, test `edit-day-schedule replays its receipt`).
3. Gear Undo/Cancel when the pending build also holds a class or attribute change: those survive (Task 6, test
   `cancelling gear changes keeps a queued class change`).
4. Typing an empty or non-number value into a creation field: treated as 0, never NaN (Task 7, test
   `an empty field counts as 0`).
5. A sale of a price-2 listing: fee 1, seller receives 1 (Task 2 SQL and Task 4 client, tests named below).

---

### Task 1: Schedule rules and the day command contract

**Files:**
- Modify: `supabase/functions/_shared/domain/rules-v1.ts` (add `schedule: { arenaPhases: ['evening'] }`, `fees.marketMinimum: 1`,
  `marketplace.minimumPrice: 2`; tournament `hourUtc: 18, minuteUtc: 40` is Task 3)
- Create: `supabase/functions/_shared/domain/schedule-choice.ts`
- Modify: `supabase/functions/_shared/contracts/commands.ts:31` (new command), `supabase/functions/_shared/backend/commands.ts:28-33, :53`
- Test: `tests/domain/schedule-choice.test.ts`, `tests/backend/commands.test.ts`

**Interfaces:**
- Produces: `choiceAllowedInPhase(phase: Phase, choice: ActivityChoice, rules?: Rules): boolean` (Arena only in
  `rules.schedule.arenaPhases`); command `{ kind: 'edit-day-schedule'; operationId: string; expectedVersion: number;
  day: Schedule }` (`Schedule = Record<Phase, ActivityChoice>`, existing type); `parseCommand` accepts it and refuses
  Arena outside the evening for both schedule kinds (`invalid`).

- [ ] **Step 1: Write the failing tests**: `choiceAllowedInPhase` true for evening Arena, false for morning and
  afternoon Arena, true for every non-Arena choice in every part; `parseCommand` refuses `edit-schedule` with morning
  Arena, refuses `edit-day-schedule` with afternoon Arena, accepts a day with evening Arena, refuses a day missing a part
  or with an extra key.
- [ ] **Step 2: Run** `npx vitest run tests/domain/schedule-choice.test.ts tests/backend/commands.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the rules entries, `schedule-choice.ts`, the contract and the parser (reuse the existing
  choice parser for each part; exactly the three keys; add the kind to `PLANNING_KINDS` at `commands.ts:53`).
- [ ] **Step 4: Run** the same command; expect PASS. Update `tests/backend/commands.test.ts:40, 50-53` cases that used
  morning Arena to evening.
- [ ] **Step 5: Commit** `feat: allow Arena only in the evening and add the day schedule command`.

### Task 2: SQL: evening Arena, the day save, the market fee, the backfill (M23)

**Files:**
- Create: `supabase/sql/16-launch-feedback.sql` (re-emits `private.planning_command`, `private.market_command`; adds
  `public.edit_day_schedule(actor_id uuid, operation_id uuid, input jsonb) returns jsonb` = `select
  private.planning_command(actor_id, operation_id, input, 'edit-day-schedule')`, revoke/grant as
  `02-build-schedule.sql:222-225`; the backfill `do` block)
- Create: `supabase/migrations/<generated>_launch_feedback.sql` (M23, generated by `db pull launch_feedback --local
  --schema public,private --yes`, then completed)
- Modify: `supabase/functions/_shared/backend/database.ts:16-19, :141` (`PlanningCommand` gains the kind; rpc
  `edit_day_schedule`; `DayScheduleValue`), `scripts/hosted-checks.sql:194-204` (judge a sale by the fee stored in its
  receipt)
- Test: `tests/db/build-schedule.test.ts`, `tests/db/market.test.ts`, `tests/db/access-matrix.test.ts:196`,
  `tests/db/restore-hosted.test.ts:43` (22 → 23), `tests/db/launch-feedback-backfill.test.ts` (new),
  `tests/db/hosted-checks.test.ts`

**Interfaces:**
- Consumes: Task 1's command shape.
- Produces: `DayScheduleValue = { version: number; receivedAtMs: number; parts: Record<Phase, { effectiveSlotIndex:
  number; effectiveAtMs: number } | null> }` (null = unchanged); `planning_command` refuses non-evening Arena for both
  schedule kinds; a day with no change is `invalid`; `market_command` fee `greatest(1, price*5/100)`, price shape
  `between 2 and 1000000000`.

- [ ] **Step 1: Write the failing DB tests**: `edit-day-schedule saves three parts in one version` (one version bump,
  one revision per changed part, each with `schedule_effective_slot`, unchanged parts `null`); `edit-day-schedule
  refuses a stale version and writes nothing`; `edit-day-schedule replays its receipt` (same id twice → same result,
  version bumped once); `edit-day-schedule refuses afternoon Arena` and `edit-schedule refuses morning Arena` (`invalid`,
  nothing written); `a day with no change is invalid`; market `a price-2 sale pays fee 1 and credits 1`, `a price-19 sale
  pays fee 1`, `a listing at price 1 is refused` (replace the fee-0 cases at `market.test.ts:240-252, 282`);
  backfill test seeds a current morning Arena and a future afternoon Arena revision (plus one part holding both), applies
  the backfill block, and asserts the boundary pick for each affected slot is Rest; access matrix lists
  `edit_day_schedule` for service_role only.
- [ ] **Step 2: Run** `npm run test:db -- tests/db/build-schedule.test.ts tests/db/market.test.ts
  tests/db/launch-feedback-backfill.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the source file; apply it with the psql fallback (`docker exec -i supabase_db_Cloudiator psql
  -U postgres -d postgres -v ON_ERROR_STOP=1 -q < supabase/sql/16-launch-feedback.sql`, after the container label check).
  The day kind follows `planning_command`'s existing order (lock, receipt replay, shape, gladiator lock, `now_ms` after
  locks, processing gate, version check, validation, one version bump, receipt). The backfill: per gladiator, one version
  for current Rest revisions at processed slot + 1, a further version for each future Arena revision's Rest at its own
  effective slot; inside `do $$ … $$`.
- [ ] **Step 4: Run** the step 2 command and `npx vitest run tests/rule-retention.test.ts`; expect PASS.
- [ ] **Step 5: Generate M23** with `npx supabase db pull launch_feedback --local --schema public,private --yes`; complete
  it against the source (grants and revokes, function order, the backfill block, unchanged functions not re-emitted);
  `npx supabase db reset --local --no-seed --yes`; inspect the replayed functions and ACLs; run `npm run test:db`
  (DB-test rule), `npx supabase db lint --local --schema public,private --fail-on warning`, `npx supabase db advisors
  --local --type all --level info`.
- [ ] **Step 6: Record** M23 in `docs/operations/migrations.md` (new section at the top, the M22 section's shape) and the
  rules-in-place exception in `docs/operations/runbook.md` ("Retained-rule deployments").
- [ ] **Step 7: Commit** `feat: save the whole day at once, evening Arena and a 1-gold minimum fee (M23)`.

### Task 3: Tournaments in the 18:40 UTC evening slot

**Files:**
- Modify: `supabase/functions/_shared/domain/rules-v1.ts:36`, `domain/tournament-slot.ts:23-25` (comments),
  `src/features/tournaments/tournament-text.ts:17, 51-53, 67-73`, `src/features/tournaments/TournamentPanel.tsx:96, 108,
  129, 637, 641` (read `owner.schedule.evening`; "Evening schedule"; "Wed & Sat · 18:40 UTC"), `src/game/tournament-stage.ts:7`
- Modify fixtures: `tests/fixtures/tournament-ids.ts`, `tests/fixtures/tournaments/*.json` (regenerated), the SEEDS table
  in `tests/fixtures/tournament-fixtures.test.ts:121-160`
- Test: every file in the code map's section 2 test list (slot 301 → 302, 17:20 → 18:40, afternoon → evening)

**Interfaces:**
- Consumes: Task 1 (fixtures now schedule evening Arena).
- Produces: `isTournamentSlot` true only for Wed/Sat 18:40 UTC slots.

- [ ] **Step 1: Update the tests to the new expectations** (`tournament-slot.test.ts` asserts Sat 18:40 is a tournament
  slot and Sat 17:20 is not; `tournament-fixtures.test.ts:185-193` asserts phase `evening` and an 18 h 00 countdown);
  run `npx vitest run tests/domain`; expect FAIL.
- [ ] **Step 2: Implement** the rule and the texts; regenerate fixtures with `UPDATE_TOURNAMENT_FIXTURES=1 npx vitest run
  tests/fixtures/tournament-fixtures.test.ts`, searching new seeds where a fixture story needs them; check each story's
  wording still holds.
- [ ] **Step 3: Run** `npx vitest run`, `npm run test:db -- tests/db/tournaments.test.ts tests/db/seasons.test.ts
  tests/db/idle.test.ts tests/db/retention.test.ts`, and `npx playwright test --config
  node_modules/.cache/pw-claude.config.mjs tournament.spec.ts`; expect PASS.
- [ ] **Step 4: Commit** `feat: move tournaments to the Wednesday and Saturday evening slot`.

### Task 4: Market minimum fee and price in the client and Edge

**Files:**
- Modify: `src/features/market/market-text.ts:9-26` (`marketFee = max(fees.marketMinimum, floor(price × 5 / 100))`;
  `validPrice` ≥ `marketplace.minimumPrice`), `src/features/market/MarketPanel.tsx:145, 231, 244, 246-247, 251-252`
  ("5%, at least 1"; min 2; "from 2 to"), `supabase/functions/_shared/backend/commands.ts:43-44` (`integer(price, 2, max)`)
- Test: `tests/domain/market-panel.test.ts`, `tests/backend/commands.test.ts:45, 249-256`, `tests/browser/market.spec.ts:92,
  154, 280, 619`, `tests/browser/release.spec.ts:337`

- [ ] **Step 1: Write the failing tests**: `marketFee(2) === 1`, `marketFee(19) === 1`, `marketFee(40) === 2`,
  `sellerReceives(2) === 1`, `validPrice(1) === false`, `validPrice(2) === true`; the parser refuses price 1.
- [ ] **Step 2: Run** `npx vitest run tests/domain/market-panel.test.ts tests/backend/commands.test.ts`; expect FAIL.
- [ ] **Step 3: Implement**; update the browser specs' mock fee and texts.
- [ ] **Step 4: Run** the step 2 command and `npx playwright test --config node_modules/.cache/pw-claude.config.mjs
  market.spec.ts`; expect PASS.
- [ ] **Step 5: Commit** `feat: show the 1-gold minimum fee and the 2-gold lowest price`.

### Task 5: The schedule screen: one save, evening Arena, the running part

**Files:**
- Modify: `src/features/schedule/SchedulePanel.tsx`, `src/lib/api/gateway.ts:160` (allow `edit-day-schedule`),
  `src/features/shell/CampShell.tsx:97-111` (fixture text, if it lists Arena per part)
- Create: `src/features/schedule/schedule-text.ts` (pure helpers below)
- Test: `tests/domain/schedule-text.test.ts`, `tests/browser/planning.spec.ts:53-55, 116-176`,
  `tests/browser/release.spec.ts:303-309`

**Interfaces:**
- Consumes: Task 1 (`choiceAllowedInPhase`, the command), Task 2 (`DayScheduleValue`).
- Produces: `choicesFor(phase: Phase, level: number): ActivityChoice[]`; `choiceHint(choice: ActivityChoice): string`
  (with the stamina cost from `RULES_V1.activityStamina`; Arena adds "Bout revealed at minute 60, rewards at 80. Wed and
  Sat 18:40 UTC: the tournament."); `runningPart(nowMs: number): { phase: Phase; endsAtMs: number }`;
  `savedSummary(value: DayScheduleValue, choices: Schedule, nowMs: number): string` ("Saved. Morning: Training from
  18:00. Afternoon: … from 19:20, after the running afternoon.").

- [ ] **Step 1: Write the failing unit tests** for the four helpers (morning and afternoon omit Arena; evening includes
  it; a running afternoon's summary says "after the running afternoon"; hints carry the costs 20/30/25/0).
- [ ] **Step 2: Run** `npx vitest run tests/domain/schedule-text.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the helpers, then the panel: one draft for the day, per-part select and hint ("Arena runs in
  the evening only" under morning and afternoon), "Running now"
  badge and the notice (ends HH:MM; a change starts with the next occurrence at HH:MM), one **Save schedule** (disabled
  without changes) sending `edit-day-schedule`, **Undo changes**, the status line, the existing retry rules (same
  operation id on `processing`/`unavailable`/`rate-limited`, refresh on `conflict`).
- [ ] **Step 4: Update** `planning.spec.ts` and `release.spec.ts` to the single save (mock `edit-day-schedule`); run them
  with the private config; expect PASS.
- [ ] **Step 5: Commit** `feat: plan the whole day and save it once`.

### Task 6: The gear view in the inventory

**Files:**
- Create: `src/features/inventory/gear.ts`
- Modify: `src/features/inventory/InventoryPanel.tsx` (the "Wearing now" row above the items; a Wear action per wearable
  item)
- Test: `tests/domain/gear.test.ts`, `tests/browser/inventory.spec.ts` (mock `queue-build` and `cancel-build`)

**Interfaces:**
- Consumes: `OwnerState.currentBuild`, `pendingBuild`, `buildVersion`, `inventory` (`reads.ts`); `validateBuild`.
- Produces: `wornNow(owner): Record<EquipmentSlot, string | null>`; `nextEquipment(owner): Record<EquipmentSlot, string |
  null>` (pending ?? current); `wearCommand(owner, itemId): GameCommand` (`queue-build` with the whole build from
  `pendingBuild ?? currentBuild`, that slot changed, off-hand cleared for a two-handed weapon; `cancel-build` when the
  result equals the current build); `undoCommand(owner, slot)` (restores the worn item and, for a two-handed weapon, the
  worn off-hand); `cancelGearCommand(owner)` (equipment back to current, other build changes kept); `wearState(owner,
  item): 'wearing' | 'queued' | 'leaving' | 'free' | 'needs-free-hand' | 'needs-level' | 'listed'`.

- [ ] **Step 1: Write the failing unit tests**: wearing a second sword queues a build with only the weapon changed;
  a two-handed weapon clears the off-hand and the shield reads `needs-free-hand`; undoing the queued two-handed weapon
  restores the worn off-hand; `cancelling gear changes keeps a queued class change` (pending class change survives,
  equipment reset); a swap that returns to the current build becomes `cancel-build`; an item above level reads
  `needs-level`; a listed item reads `listed`.
- [ ] **Step 2: Run** `npx vitest run tests/domain/gear.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** `gear.ts`, then the panel: badges "Wearing", "Wears from HH:MM", "Off at HH:MM" (from
  `pendingBuild.effectiveSlotIndex`), per-item Undo, "Cancel changes", the note on when changes start; disabled in
  preview mode; `conflict` refreshes the owner.
- [ ] **Step 4: Update** `inventory.spec.ts` (Wear queues, badge shows; Undo; preview disabled); run with the private
  config; expect PASS.
- [ ] **Step 5: Commit** `feat: show worn gear and swap it from the inventory`.

### Task 7: Creation points

**Files:**
- Create: `src/features/character/creation-points.ts`
- Modify: `src/features/character/CreateCharacter.tsx:25, 105-118, 176-192`
- Test: `tests/domain/creation-points.test.ts`, `tests/browser/identity.spec.ts`, `read-render.spec.ts:281-283`,
  `visitor.spec.ts:290-291`, `release.spec.ts:345-395`

**Interfaces:**
- Produces: `EMPTY_ALLOCATION` (all 0); `setPoints(allocation, key, wanted: number): { allocation; capped: boolean }`
  (cap at current + left, floor, NaN → 0); `pointsLeft(allocation): number`; `CLASS_SUGGESTIONS: Record<ClassId,
  Attributes>` (Global Constraints); `ATTRIBUTE_HINTS: Record<keyof Attributes, string>`.

- [ ] **Step 1: Write the failing unit tests**: `an empty field counts as 0`; typing 10 with 7 left sets 7 and reports
  capped; `pointsLeft` never negative; each suggestion totals 10.
- [ ] **Step 2: Run** `npx vitest run tests/domain/creation-points.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the module, then the dialog per the spec's goal 1 (counter "N of 10 left" / "All 10 spent",
  ten pips, − value + and "= total" per row, the capped status line, **Reset points**, **Suggested for {Class}**, Create
  disabled until 10 with "Spend N more points to continue."; fields not `aria-invalid` until a create attempt).
- [ ] **Step 4: Update** the browser flows that relied on the 2-each default (click "Suggested for …" before Create),
  `identity.spec.ts:241-265` and the `release.spec.ts` aria snapshot; run with the private config; expect PASS.
- [ ] **Step 5: Commit** `feat: make the creation points self-explanatory`.

### Task 8: Gate, bench, production, records

**Files:**
- Modify: `docs/operations/release-evidence.md` (a "Launch feedback (M23)" section), the spec 2026-10-11 lines 282 and 450
  (tournament time), `docs/operations/deployment.md` (none unless a step changed)

- [ ] **Step 1: Gate of record** `node scripts/verify.mjs --config node_modules/.cache/pw-claude.config.mjs` on a quiet host;
  expect `Result: PASSED`, 12/12. Push to `origin/codex/gladiator-arena` (fast-forward).
- [ ] **Step 2: Bench**: link this folder to the bench (`supabase link --project-ref uukrqribdfqovahzjsrx`), `db push
  --dry-run` (only M23), `db push`, deploy both functions, fast-forward `bench`, run the deployed harness (9/9) and
  hosted-checks; relink production.
- [ ] **Step 3: Production** (Avi's pre-approval, 2026-10-25): outside Wed/Sat 17:20–20:00 UTC; re-check (no non-evening
  Arena, no tournament formed, no open listing below 2, no open boundary; stop for Avi if any changed); `db push` (only
  M23), deploy both functions, fast-forward `release`, deployed harness 9/9, hosted-checks and health after the next
  boundary.
- [ ] **Step 4: Record** the evidence and commit `deploy: ship the launch feedback changes`; tell Avi in a short summary.
