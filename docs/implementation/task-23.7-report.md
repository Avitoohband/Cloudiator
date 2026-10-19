# Task 23.7 report: settled jobs' payloads and the 500 MB budget (Lane A, M21)

## Status

**DONE.** `npm run verify` passed end to end (exit 0) on the clean M01–M21 replay. The database budget, the gate's one known
blocker since Task 23.6, no longer fires.

Commits:
- `694fe7b` feat: trim settled jobs and raise the database budget to 500 MB (M21)
- this report: docs: report Task 23.7

Brief: `.superpowers/sdd/2026-10-19-task-23-release-readiness/task-23.7-brief.md`. Design:
`docs/superpowers/specs/2026-10-19-database-budget-design.md`, sections A.1 and D. C (idle characters) is Task 23.8.

## Budgets before and after

Worst case: 50 characters, all active every slot, 10 commands a player a day. The figures are modeled from the measured run
(`node scripts/resource-report.mjs`, 18:30:56–18:33:24 UTC on the M01–M21 replay).

| Database | Task 23.3, against 250 MB | After M21, against 500 MB | Verdict |
|---|---|---|---|
| 90 days, mixed schedules | 445.4 MiB, 178.1 % | 409.8 MiB, 82.0 % | under the budget; risk band (over 80 %) |
| One year, mixed schedules | 685.2 MiB, 274.1 % | 649.7 MiB, 129.9 % | risk, with the after-launch compaction plan |
| 90 days, new-character schedule | 376.2 MiB, 150.5 % | 346.1 MiB, 69.2 % | ok |
| One year, new-character schedule | 568.5 MiB, 227.4 % | 539.3 MiB, 107.9 % | risk, with the after-launch compaction plan |

- **The trim's saving** at 90 days: about 35 MiB (mixed) and 29 MiB (new-character schedule).
  - A job row: 2,109 B with its payloads, 867 B compacted.
  - The detail class: 139.5 → 104.2 MiB (mixed), 111.3 → 81.8 MiB.
- **The 400 MB warning** (419,430,400 bytes):
  - mixed: before day 90 (409.8 MiB is 429.7 million bytes);
  - new-character schedule: about 5½ months.
  Both as the design expected.
- **Cross-check**, after `VACUUM FULL` (test only): 829 B per row on disk against 943 B modeled live, for 1,035 compacted and
  280 full rows; the model is 12 % conservative.

## What changed

**SQL source: `supabase/sql/15-release.sql`, fourth part (:263–744; header :1–5).**
- `:263–290` The design notes, including who reads a job's payloads (no kind is excluded) and the settled rule:
  - at or below P − 19, the seven-day pass's own rule without its seven-day age;
  - below the first slot with an unfinished activity or job.
- `:293` `private.retention_state.jobs_compacted_through_slot` (bigint, not null, default -1, at least -1).
- `:301–339` `private.guard_job()`: M09's status machine plus exactly one update of a completed job:
  - the two stubs, once, with every other column unchanged;
  - only at or below the watermark.
  It keeps its ACL; the trigger is unchanged.
- `:343–612` `private.cleanup_history(now_ms)`: M16's body plus the trim after the seven-day pass (`:452–476`). It moves the
  watermark, then compacts, and counts the jobs in `detail.compacted.jobs` (`:478`). Owner only.
- `:615–744` `private.health_report(now_ms)`:
  - `budgetBytes` 524,288,000 (`:725`);
  - `cohort.activeCharacters`, an index-backed count of the current slot's activities (`:733`);
  - owner only.
- Built from M16's text by exact, single-match edits, so the rest of both bodies is unchanged.

**Migration M21: `supabase/migrations/20261019180659_job_payloads.sql`.**
- Generated with CLI 2.120.0 `db pull job_payloads --local --schema public,private --yes` (migra) after one source apply on a
  clean M01–M20 reset.
- Completed with the three function ACLs and `notify pgrst`, plus a provenance header.
- The function statements are as generated, byte-identical to the source's `pg_get_functiondef` (compared programmatically).
- No unchanged function is re-emitted, and no backfill is needed (the default seeds the singleton).
- It has no top-level `update` (`tests/rule-retention.test.ts` passes).

**Model, fixtures and report.**
- `tests/performance/capacity-model.ts`:
  - `:53–61` the budget is 524,288,000;
  - `:68–72` `JOB_PAYLOAD_SLOTS = 19 + 1`;
  - `:92` jobs are compacted after it.
- `tests/fixtures/capacity.ts`:
  - `:478–484` the jobs entry of the `shrink` map;
  - `:519–551` `compactedJobsCheck`, the trim through `cleanup_history` on the run, then `VACUUM FULL` and the per-row
    comparison;
  - `:634` it runs after every other measurement.
- `tests/fixtures/db.ts:83–85`: `resetIdentity` resets the new watermark.
- `tests/db/capacity.test.ts`:
  - `:17–22` the header;
  - `:75–80` the trim's cross-check (within 25 %);
  - `:83–86` the gate enforces the 90-day figures only. The one-year figures are recorded, not enforced (the design: the gate
    requires 90 days under 100 %).
- `scripts/resource-report.mjs:89–116`: the one-year database lines are a named `risk` at any share, never a `blocker`.

**Docs.**
- The budget sentence becomes 500 MB (warning at 400 MB; Avi's decision, 2026-10-19) in:
  - the spec `docs/superpowers/specs/2026-10-11-gladiator-arena-design.md:410`;
  - `docs/superpowers/plans/2026-10-11-gladiator-arena-implementation.md:27` and `:541`;
  - `docs/superpowers/plans/2026-10-19-task-23-release-readiness.md:27` and `:41`.
  Spec §4.3 is untouched (Task 23.8), and so is the Task 22 plan.
- `docs/operations/runbook.md`: `cohort.activeCharacters`, the `database-size` alert (500 MB, the warning as the trigger of
  the after-launch compactions), and "Budgets".
- `docs/operations/environment.md:66`.
- `docs/operations/migrations.md`: the new top section for M21, and the M16 report field list.
- `docs/operations/release-evidence.md`: Lane A's status, "Task 23.7: the database re-measured", the Budgets lines, risks 1
  and 5, the gate's status, "Before the public release", and the Task 23.7 gate run.

## Tests, RED first

RED: `red-unit` and `red-db`, on the M20 source, before any implementation.

| Test | File | RED reason |
|---|---|---|
| empties the input and result of completed jobs in settled slots and keeps the rows | `tests/db/retention.test.ts:515` | `{tournamentBoutResults: 0}`, no `jobs: 95` |
| leaves the jobs of an unsettled or blocked slot untouched | `tests/db/retention.test.ts:542` | `jobs` undefined (expected 63) |
| reads Arena results, tournament views and recent results identically after compaction | `tests/db/retention.test.ts:565` | no compaction count |
| compacts tournament bout logs … (now `jobs: 1`) and returns all-zero counts … (counts `jobs`) | `:397`, `:626` | `jobs` missing |
| answers a same-token settlement retry on a compacted job with ok and no new grants | `tests/db/activities.test.ts:221` | no compaction |
| still refuses every other update of a completed job, a compaction-shaped update outside cleanup included | `tests/db/activities.test.ts:446` | no watermark column |
| warns at 400 MB and alerts at 500 MB of physical database size | `tests/db/health.test.ts:297` | budget 262,144,000 |
| counts the characters with an activity in the current slot | `tests/db/health.test.ts:315` | `cohort` undefined |
| the cleanup-state case and the CLI case (budget constants) | `tests/db/health.test.ts` | budget 262,144,000 |
| models compacted job rows and the 500 MB budget, and the budget pin | `tests/performance/capacity-model.test.ts:21`, `:17` | budget 262,144,000 |
| reports the one-year database figure as a risk, never a blocker … | `tests/scripts/resource-report.test.ts:44` | the one-year line was a blocker |

- Totals: 11 database tests and 3 unit tests failed, each for the expected reason.
- The first activities guard check (the exact shape above the watermark is refused) already passed on M20, which refuses
  every update. It stays as the regression for "outside cleanup".
- `tests/db/access-matrix.test.ts` needed no change: the new column is covered by the table grant, and no function was
  added.

## Results

- `npm test`: 1,218 passed. `npm run typecheck`: passed.
- `npm run test:db` with `CAPACITY_GATE=1`:
  - on the source: 284/284 (18:00–18:06 UTC), the Edge start time unchanged;
  - on the M01–M21 replay, inside `npm run verify`: 284/284, unchanged.
  Each run came after the Edge refresh and a settled runtime.
- Replay:
  - the M01–M20 reset matched Task 23.3 fix round 1's fingerprint (1,135 lines);
  - the source-applied fingerprint differs only in the three function hashes, the column, its constraint and the seed line;
  - the M01–M21 replay matched it byte for byte (1,138 lines), and again after the test runs.
  - Inspection: ACLs as before, 44/44 triggers, both cron jobs, no client EXECUTE, 21 migrations.
- `supabase db lint`: empty on the source and the replay. Advisors: 36 INFO `unused_index`, no warnings or errors.
- `npm run verify` (18:13–18:29 UTC), exit 0. Every step passed:
  - unit 1,218;
  - typecheck, assets, build, static;
  - Edge settled (recreated while settling, as designed);
  - db 284, Edge unchanged;
  - development 527 / 0 / 33;
  - production build, scan and gate 32 / 0 / 528;
  - `git diff --check` clean.

## Concerns

- `scripts/verify.mjs` still lists the database budget as a `KNOWN_BLOCKERS` entry owned by Task 23.7. It no longer fires,
  but a future 90-day regression would report as "blocked" (exit 2) rather than failed. Retiring it is the controller's call.
- The mixed worst case is at 82.0 % at 90 days, above the 400 MB warning before day 90. That is a risk, as the design states.
- The capacity measurement's raw client egress came out at 80.7–82.7 % in the final run (76.4–78.3 % twenty minutes
  earlier). This is run-to-run variance at the risk line, unrelated to the trim.
- The trim has its own watermark and no health field. A blocked slot shows as `blockedSlot` only when the seven-day pass
  reaches it; the `operator-jobs` alert shows the cause first.
