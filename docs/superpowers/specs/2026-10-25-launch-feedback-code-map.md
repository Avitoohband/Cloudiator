# Launch feedback: code map (research for the design, 2026-10-25)

Read-only research for `2026-10-25-launch-feedback-design.md`: where each approved change lives today. Line numbers are
as of `b826947`.

## Cross-cutting

- Slot arithmetic: 80-minute slots from the Unix epoch, slot 0 a morning. TS `clock.ts:15`
  (`phases[index % phases.length]`), `nextPhaseStart` `clock.ts:20-29`; SQL `private.slot_phase` (current definition M05
  `20261013065108_inventory_shops.sql:1272-1280`). A UTC day holds 18 slots; evenings start 02:40, 06:40, 10:40, 14:40,
  18:40, 22:40 UTC. 17:20 is the day's slot 13 (afternoon), 18:40 slot 14 (evening). Test slot 301 = Sat 1970-01-17 17:20
  (afternoon), 302 = 18:40 (evening).
- SQL workflow: `supabase/sql/*.sql` are the reapplicable sources (02 build/schedule, 12 market, 15 release). A changed
  function is fully re-emitted (CREATE OR REPLACE) in a new source file plus a generated M23; grants follow
  `02-build-schedule.sql:222-225`. Counts pinned by tests: `tests/db/restore-hosted.test.ts:43` (22 migrations),
  `tests/db/access-matrix.test.ts:109-260` (service_role grants; :196 edit_schedule), `tests/rule-retention.test.ts:65-69`
  (top-level UPDATEs must be listed in `REVIEWED_UPDATES` :45-48; statements inside `do $$…$$` are not checked).
- Rules: `RULES_V1` (`rules-v1.ts`), `RETAINED_RULES` (`arena.ts:10`) keyed by version; the runbook's "Retained-rule
  deployments" ships changed rules as a new version.

## Current SQL definitions to replace

| Function | Current definition |
|---|---|
| `private.planning_command` | M05:1105-1196 (source `sql/02-build-schedule.sql:80-167`) |
| `public.edit_schedule`, `queue_build`, `cancel_build` | M05 lines 349, 419, 108 |
| `private.schedule_effective_slot` | M05:1237-1245 |
| `private.initial_schedule_revision` | M05:1092-1103 |
| `public.create_gladiator` | M05:253 (default schedule :328; allocation checks :287, :292) |
| `private.boundary_snapshot` | M05:933-963 (revision pick :947-948) |
| `private.boundary_check_stamina` | M05:828-843 |
| `private.apply_pending_build` | M05:762-793 |
| `private.boundary_apply_changes`, `boundary_start` | M22 `20261020075858_idle_rest.sql:162`, :212 |
| `public.consume_command_rate` | M22:47-77 |
| `private.market_command`, `public.create_listing` | M14 `20261017144347_market.sql:247`, :141; price CHECKs M14:63, :113 (`>= 1`) |
| `private.cleanup_history` | M19 `20261019180659_job_payloads.sql:21` |
| tournaments: `pairing_input`, `boundary_pair`, `accept_pairing`, `set_tournament_opt_in` | M11 lines 524, 486, 357, 6 |
| `private.publish_tournaments` | M12 `20261014174629_tournament_results.sql:357` |

## 1. Arena only in the evening

- No check limits Arena by phase today: client `SchedulePanel.tsx:104-113` (options :111), contract `commands.ts:10, :31`,
  Edge `backend/commands.ts:28-33`, SQL `planning_command` M05:1137-1144 (:1140 accepts rest/training/arena for any
  phase; expedition level :1141-1143). Creation default (M05:328) and bench seed have no Arena.
- Boundary: `boundary_snapshot` takes the latest revision for `slot_phase(target)` with effective ≤ target (pick
  `effective_slot_index desc, version desc`); `boundary_check_stamina` resolves the kind or Rest; nothing downstream
  re-checks the phase (expedition level is likewise command-time only).
- Backfill risk: a future-effective Arena revision would later win over a Rest revision at processed+1; activities already
  snapshotted keep their Arena; a top-level UPDATE trips the rule-retention test.
- Tests with Arena outside the evening by direct SQL (keep working if enforcement is command-only): `arena.test.ts:46`,
  `tournaments.test.ts:59`, `seasons.test.ts:566, :819`, `idle.test.ts:75`, `recovery.test.ts:339`,
  `restore-world.test.ts:149`, `retention.test.ts:241`, `activities.test.ts:587, 724, 731`, `fixtures/capacity.ts:75-87,
  703-707`. Through commands (break): `build-schedule.test.ts:84, :209`, `browser/planning.spec.ts:120-133`,
  `backend/commands.test.ts:40, 50-53`; transport-only literals `api/fixture-gateway.test.ts:8`, `api/live-gateway.test.ts:15`.

## 2. Tournaments to the 18:40 UTC evening slot

- Domain: `rules-v1.ts:36` (`hourUtc: 17, minuteUtc: 20`), `tournament-slot.ts:23-33` (generic logic, comments say
  afternoon), `tournament.ts:111, :235`, `jobs.ts:105`. SQL: none (`09-tournaments.sql` exception 1: TypeScript decides
  tournament days).
- "Arena assigned to that phase": `tournament.ts:123-126` uses the snapshot's choice for the slot's phase, so an evening
  tournament requires evening Arena with no code change.
- Client: `tournament-text.ts:17, :43-44 (derived), :51-53, :67-73`; `TournamentPanel.tsx:96, :108, :129, :637, :641`;
  `game/tournament-stage.ts:7`.
- Fixtures: `tests/fixtures/tournament-ids.ts:5, 12-13, 19, 23-31`; 9 JSON files in `tests/fixtures/tournaments/`
  regenerated with `UPDATE_TOURNAMENT_FIXTURES=1` (`tournament-fixtures.test.ts:31`); SEEDS table :121-160 holds
  slot-specific bout ids (a slot change needs new seeds); :185-193 assert afternoon and a 16 h 40 countdown.
- Tests: `domain/tournament.test.ts:32-36, 111-151`, `tournament-slot.test.ts:64-67`, `tournament-stage.test.ts:20,
  32-78`, `tournament-panel.test.ts:33, 44-60, 77-79`, `backend/worker.test.ts:218-269` (301 → 302),
  `db/tournaments.test.ts:20-21, 330, 408`, `db/seasons.test.ts:819-835`, `db/idle.test.ts:28-29`,
  `db/retention.test.ts:27-29`, `fixtures/capacity.ts:54-58, 570`, `performance/harness.ts:27-28`,
  `browser/tournament.spec.ts:120, 187-214, 251, 433-439, 582`. Docs: spec 2026-10-11 lines 282, 450;
  `release-evidence.md:104`.
- Risks: in-flight pairing jobs, deploy order, deploying inside Wed/Sat 17:20–20:00 UTC; after deploy only 18:40 slots
  count as tournaments for `latestTournament`/`nextTournament`.

## 3. One Save for the whole day

- Today: client `SchedulePanel.tsx:63-90, :118`; Edge `parseCommand` :28-33, `PLANNING_KINDS` :53, `database.ts:16-19,
  132-145`; gateway allowlist `src/lib/api/gateway.ts:160`.
- `planning_command` order: account lock (:1117) → receipt replay (:1118-1122) → shape (:1123-1126, not stored) →
  gladiator FOR UPDATE (:1127) → `now_ms := planning_now_ms()` after the locks (:1129) → processing gate (:1131, not
  stored) → lock builds, schedules, wallets, items (:1132-1135) → expectedVersion vs schedule version only for
  `edit-schedule` (:1136; a mismatch is `conflict`, stored) → key/choice validation (:1138-1144, `invalid`, stored) →
  `effective := schedule_effective_slot(phase, now_ms)` (:1146; the running phase's next occurrence is 3 slots later) →
  one version bump + `jsonb_set` (:1147) → `schedule_revisions` row (:1148) → result `{version, receivedAtMs,
  effectiveSlotIndex, effectiveAtMs}` (:1149) → receipt (:1191-1194).
- Revisions key `(gladiator_id, phase, version)`: several phases can share a version (the creation revision writes three at
  version 1). `cleanup_history` prunes per phase. Rate limit: 60 commands a minute; a day save costs 1.
- `edit_schedule` is also used by the bench seed (`scripts/bench-seed.mjs:39, 110, 200`, its tests) and the deployed probes
  (`tests/browser/deployed-checks.ts:222`, `tests/deployed.test.ts:236`).
- Tests: `db/build-schedule.test.ts:37-38, 61-91, 203-226, 297`, `db/idle.test.ts:349-351`, `db/activities.test.ts:740-751`,
  `backend/commands.test.ts:40, 50-53`, `browser/planning.spec.ts:53-55, 116-176`, `browser/release.spec.ts:303-309`
  ("Save morning"); heading-only `release.spec.ts:469-474`, `shell.spec.ts:20`, `full-screen.spec.ts:147, 236`.

## 4. Market minimum fee 1, minimum price 2

- Rules `rules-v1.ts:17, :22`. SQL `market_command` M14: price shape :290 (`not between 1 and 1000000000` → `invalid`, no
  receipt), fee :360 (`fee:=l.price*5/100`, used :363, :365, :387-392); table CHECKs :63, :113 (`>= 1`).
- TS mirror `src/features/market/market-text.ts:9-26` (`marketFee`, `sellerReceives`, `validPrice` ≥ 1); `MarketPanel.tsx:145,
  231 ("rounded down"), 244 (min 1), 246-247 ("from 1 to"), 251-252`; Edge `backend/commands.ts:43-44` (`integer(price, 1,
  max)`). Operator `scripts/hosted-checks.sql:30, 59, 194-204` recomputes `price*5/100`. Docs `migrations.md:907-913`.
- Tests: `db/market.test.ts:240-252, 273-279, 282`, `domain/market-panel.test.ts:20-26, 32-43`, `backend/commands.test.ts:45,
  249-256`, `browser/market.spec.ts:92, 154, 280, 619`, `browser/release.spec.ts:337`.
- Risks: tightening the CHECKs fails on any open price-1 listing; a legacy price-1 listing would pay its seller 0;
  `hosted-checks.sql` would mark historical sales under 20 as wrong unless it reads the stored fee or knows the cutover.

## 5. Gear

- `BuildPanel.tsx:25-28, 33 (draft from pendingBuild ?? currentBuild), 59 (buildChangeFee), 60-61 and 111-116 (two-handed,
  tier above level, listed items), 65-89 (queue-build / cancel-build with expectedVersion = buildVersion), 94-98`.
  `InventoryPanel.tsx:72, 78, 81-82` (Sell, Discard only; preview refuses :36, :82). Read contract `reads.ts:4-12, 21-23`.
  Edge `database.ts:21-30` (`prepareBuild`).
- `validateBuild` (`build.ts:40-69`): points, unique owned ids, catalog/tier/rarity/quantity/stats, `slot`, `level` (tier >
  level), `reserved` (listed), renown items bound, `two-handed` (:65). `buildChangeFee` (`build.ts:76-81`): 100 for a class
  change + 100 for any allocation decrease, against the ACTIVE build; equipment never costs.
- SQL queue-build (M05:1151-1179): effective slot+1; previous held reservation refunded, a new one inserted (even 0);
  newly worn items get 'pending-build', worn ones keep 'equipment'; version bump. `apply_pending_build` at boundary
  phase 3; a resting character's build waits until it returns.
- So an equipment-only swap is free via the existing `queue-build` with the WHOLE build based on `pendingBuild ??
  currentBuild`; reusing it keeps `cleanup_history`'s reservation cleanup working.
- Tests: `domain/rules.test.ts:138-232`, `db/build-schedule.test.ts`, `db/shops.test.ts:339`, `db/market.test.ts:256-270,
  358`, `browser/inventory.spec.ts:13, 40-55 (no queue-build mock), 108-110`, `browser/management.spec.ts:280-310`,
  `browser/planning.spec.ts:72-114`, `browser/release.spec.ts:283-299`, `domain/slot-time.test.ts:155-172`.
- Risks: `cancel-build` also cancels queued class/stance/attribute changes; Undo of the last queued item; the two views
  editing the same version (`conflict`); off-hand under a two-handed weapon; items above level; preview mode.

## 6. Character creation points

- `CreateCharacter.tsx:25 (initial 2 each), 29, 31-48 (readDraft; saved drafts keep old values), 54-64, 105 (remaining can go
  negative), 108 (pointsInvalid = !preview: with a 0 default every field is aria-invalid at once), 118, 176, 178 (max 10,
  empty → NaN), 180, 192 (Create never disabled for points)`.
- Validation unchanged: `validateCreationAllocation` (`build.ts:71-73`), Edge `commands.ts:24-27`, `database.ts:105-119`,
  SQL M05:287, :292.
- Tests relying on the 2-each default: `browser/identity.spec.ts:179-183, 203-215, 224-230, 241-265 (asserts 2 each at
  :264), 271-272, 306-316, 326-333`, `read-render.spec.ts:281-283`, `visitor.spec.ts:290-291`,
  `release.spec.ts:345-395` (aria snapshot "All 10 points allocated."; fill 9 / fill 2). No unit test of CreateCharacter.
