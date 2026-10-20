# Task 23.8 report: idle characters rest at home (Lane A, M22)

## Status

**DONE.** `npm run verify` passed end to end (exit 0) on the clean M01–M22 replay at `46f176e` (run 2). Run 1 failed on
one browser load flake (below).

Commits:
- `8db6700` fix: retire the cleared database budget blocker from the release gate (Step 0)
- `f1cf073` feat: add the resting and presence contracts (announced to the controller for Lane B, Task 23.9)
- `46f176e` feat: rest idle characters at home after 14 days (M22)
- this report: docs: report Task 23.8

Brief: `.superpowers/sdd/2026-10-19-task-23-release-readiness/task-23.8-brief.md`. Design:
`docs/superpowers/specs/2026-10-19-database-budget-design.md`, section C (Avi's decision A + C + D, 2026-10-19).

## Step 0: the cleared database budget blocker

- `scripts/verify.mjs`: `KNOWN_BLOCKERS` is empty. A 90-day budget failure of the capacity case is now an ordinary failure
  (exit 1).
- The mechanism stays. `runGate(steps, io, blockers)` and `summarize(results, blockers)` take the list as a parameter,
  defaulting to `KNOWN_BLOCKERS`.
- `tests/scripts/verify.test.ts` keeps every mechanism case on its own fixture list (`FIXTURE_BLOCKERS`, the retired
  blocker's shape). Two new cases: a budget failure classifies as `failed`, and the gate exits 1 naming the failed check.
  - RED: `KNOWN_BLOCKERS` still held `database-budget`; the gate classified the budget failure `blocked`.
- `docs/operations/release-evidence.md` ("Task 23.7 run") says the blocker is retired (updated with this report).

## The contracts (`f1cf073`, committed alone)

- `GameCommand` gains `{ kind: 'presence' }`, with its operation id checked like every command's but never stored
  (`PresenceCommand`). `PresenceResult` is `{ ok: true }` or the usual error.
  - **A deviation from the brief's literal shape:** presence carries `operationId`. Without it, the browser specs that read
    `command.operationId` from a recorded `GameCommand` (identity, inventory, market, planning) stopped compiling. With it,
    presence stays inside the existing union.
- `OwnerState.restingUntilSlot: number | null` and `PublicActor.resting: boolean`. The camp's world actor type is
  `PublicActor`; there is no `WorldActor`.
- Fixtures and test actors carry `restingUntilSlot: null` and `resting: false`.
- `46f176e` refined the `restingUntilSlot` comment: the value can be `processedSlotIndex + 2`. Clients show the value and
  never derive it.

## What changed (M22)

**The rule.** At each boundary T, a character rests when `T × 4,800,000 − greatest(last signal, created_at_ms) >= 14 days`.
- The comparison uses the boundary's scheduled start, never the wall clock.
- Creation counts like a signal. Real characters are created by a command, which signals anyway. The fallback covers
  operator-made characters and the moment before the first signal.
- A signal recorded before a late boundary freezes its cohort counts for it, even one after its scheduled start.

**SQL source: `supabase/sql/15-release.sql`, fifth part (:747–1168; header :1–6).**
- `:747–786` The design notes.
- `:789` `private.idle_rules()`: `RULES_V1.idle`, restated.
- `:794–802` `private.owner_signals`, backend only.
- `:805–818` `public.character_rests`: `since_slot`, `through_slot` (the last slot a boundary rested it in) and
  `signalled_at_ms` (the owner's first signal since the rest began). Owner-readable.
- `:821` `public.consume_command_rate`: records the signal before the rate decision, at `planning_now_ms()` after the rate
  lock, at most once an hour. The first one after a rest began sets `signalled_at_ms`.
- `:851` Phase 3 `boundary_apply_changes`: the rest at the freeze. Each candidate is read again under its owner's rate
  lock. Resting characters join no cohort.
- `:897` Phase 8 `boundary_start`: resting characters' account locks are taken in the members' gladiator-ordered pass,
  then their `processed_slot_index` advances.
- `:934` `project_character`: `resting` on every actor. A resting actor shows location `camp`, status `idle` and no
  activity.
- `:999` `owner_state`: `currentActivity` null while resting; `restingUntilSlot` is `through_slot + 1` once signalled.
- `:1024` `health_report`: `cohort.restingCharacters`.
- `:1155–1168` ACLs, the deploy-time backfill and `refresh_projections()`.
- Every replaced body was derived from its latest definition by exact, single-match edits.

**What a resting character has.**

| Row or effect | While resting |
|---|---|
| Boundary member, prepare job, snapshot, activity, settlement, settled slot | none |
| Arena pairing input, tournament entry, season rating row | none (opt-in kept) |
| `processed_slot_index` | advances at phase 8 with the cohort |
| Stamina, XP, money, renown, points | unchanged |
| Queued schedule and build changes | applied at the first boundary back |

**Edge.**
- `supabase/functions/_shared/backend/commands.ts` parses `presence` (exactly `kind` and `operationId`).
- It answers `{ ok: true }` (200) after the rate check, with no other database call.
- `supabase/functions/_shared/domain/rules-v1.ts`: `idle: { afterMs: 1_209_600_000 }`.

**M22: `supabase/migrations/20261020075858_idle_rest.sql`.** CLI 2.120.0 `db pull idle_rest` (migra) after one source apply
on a clean M01–M21 reset. The draft needed five completions:
1. the invoker view statement;
2. the two tables' revokes;
3. the six function ACLs;
4. the deploy-time backfill and projection refresh;
5. a header and `notify pgrst`.
The six function statements are byte-identical to the source-applied `pg_get_functiondef`, and no unchanged function is
re-emitted.

**Docs.**
- Spec `docs/superpowers/specs/2026-10-11-gladiator-arena-design.md`, each marked as Avi's decision of 2026-10-19:
  - §4.3 :139: the schedule continues while the player is offline, until the owner has sent no activity signal for 14
    days. Added: the presence signal, the scheduled-start measure, no back-fill, the opt-in kept, the owner's line.
  - :79: offline characters stay represented until they rest; a resting character is not drawn, with its public line.
  - :428: the three-day acceptance check holds up to 14 days without a signal.
- `docs/operations/migrations.md`: the M22 section, and `restingCharacters` in the health fields.
- `docs/operations/runbook.md`: `cohort.restingCharacters`.

## Tests

RED first on the M21 database with the source's tests: all 16 DB cases failed (`private.owner_signals` did not exist), and
the two presence unit cases failed (presence parsed as invalid). Then GREEN:

| File | Cases |
|---|---|
| `tests/db/idle.test.ts` (new, 13) | rule mirror; 14 days − 1 ms plays, 14 days rests, creation counts; scheduled start not wall clock (on time, 20 days late, decades late, a signal after the start); processed slot advances with no rows, no straggler wait, cleanup checkpoint, processing answers; pairing and brackets (resting left out, opt-in kept, insufficient-entrants path); waking by presence or a refused command, no back-fill; queued changes at the first boundary back, nothing granted; deploy-day backfill; M22 ships it; owner and public views (null → P+1, P+2 for a signal after the next freeze; RLS); presence answers ok with no receipt, in process and through the served Edge function; the hourly throttle at 3,600,000 ms exact, a rate-limited attempt counts, time sampled after the rate lock; a signal committed during the boundary's lock wait counts |
| `tests/db/seasons.test.ts` (+1) | resting through season 1: no season 1 rating, archive or standings row; the active character keeps all three seasons |
| `tests/db/health.test.ts` (+1, 2 updated) | `restingCharacters` over a rest's slots; `cohort` now has both fields |
| `tests/db/access-matrix.test.ts` | three service_role lines; a `character_rests` seed row for the owner-read check |
| `tests/db/recovery.test.ts` | the two phase-4 season cases at slot 3000 (about 2,000 slots after the world's last activity) give the world's owners a signal there, so they play instead of resting |
| `tests/backend/commands.test.ts` (+2) | presence parsing; ok after the rate check and no other call; rate-limited |
| `tests/scripts/verify.test.ts` (+2, 6 moved to the fixture list) | Step 0 |
| `tests/performance/capacity-model.ts` | the two new tables classified `player` |

Counts: units 1,222 (was 1,218); `npm run test:db` 299 (was 284).

## Verification

| Step | Result |
|---|---|
| RED | 16 DB cases (missing `private.owner_signals`), 2 unit cases (presence invalid), 3 verify cases (Step 0) |
| `npm test` | 1,222 passed |
| `npm run typecheck` | clean (tsc, deno check, deno test 2/2) |
| `npm run test:db`, source | 295/299 on the first full run: the capacity model lacked the two new tables, two recovery cases rested a world 2,000 slots after its activity (both fixed in tests), and M22 did not exist yet |
| Clean M01–M21 reset | fingerprint identical to Task 23.7's recorded M21 replay (1,138 lines) |
| Source applied | differs only in the five function hashes, the new function, the two tables, the view hash (ACL and `security_invoker` unchanged) and one seed line |
| Clean M01–M22 replay | fingerprint identical to the source-applied one (1,160 lines), and again after the test run |
| Replay inspection | ACLs as the source; `owner_state` invoker; 44/44 triggers; both cron jobs; no client EXECUTE; 22 migrations |
| Lint, advisors | lint empty; advisors 36 INFO `unused_index`, none on M22's tables; no warnings or errors |
| `npm run test:db`, replay | 299/299 (08:01–08:08 UTC), Edge start time unchanged |
| `npm run verify` run 1 (08:11–08:31 UTC) | exit 1: everything passed (test:db 299 with the capacity gate, Edge unchanged; production 32/0/528) except one development browser case, `[mobile] release.spec.ts:517`. "Returned to camp" was measured mid fade-in (alpha 0.03); alone with `--repeat-each=6` it passed 12/12 |
| `npm run verify` run 2 (08:32–08:50 UTC) | **exit 0**: units 1,222; test:db 299 with the capacity gate, Edge unchanged; development 527/0/33; production 32/0/528; `git diff --check` clean |

Evidence: `docs/operations/release-evidence.md` ("Task 23.8 runs") and `docs/operations/migrations.md` (M22).

## Concerns

- **A browser load flake.** `release.spec.ts:517`'s `settled()` waits only for animations already running. A fade that starts
  just after it is measured mid-way. This is pre-existing; it was handed to the final review's flake triage.

- **The `presence` wire shape carries `operationId`** (above). Lane B's gateway must send one and accept `{ ok: true }`
  without `receiptId`. Today's gateway allow-list (`src/lib/api/gateway.ts:131–132`) and the fixture gateway still refuse
  presence (Task 23.9).
- **`restingUntilSlot` is null while the owner has not signalled since the rest began.** The owner's client sends presence
  on load and should read owner state again after it answers. A resting owner with `currentActivity: null` and
  `restingUntilSlot: null` is resting without a signal yet.
- **Creation counts like a signal.** This is an addition to the brief's rule. It never rests a character the brief's rule
  would play; it only covers characters without a signal row.
- **A CRLF source copy fingerprints differently.** A `git checkout` of `15-release.sql` (`core.autocrlf=true`) stored CRLF
  in every function body of the file. Recorded in migrations.md; the committed source and M22 are LF.
- **Lock waits.** The rate lock in phase 3 can hold a returning owner's command for the duration of the boundary
  transaction, which normally ends at phase 4's preparation wait. This was observed only in the lock-wait test (about
  1 s, deliberate).
