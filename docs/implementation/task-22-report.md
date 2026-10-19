# Task 22 report: retention, health reporting and recoverable exports

Plan `docs/superpowers/plans/2026-10-18-task-22-retention-operations.md` (commit `e5ea022`); spec `docs/superpowers/specs/2026-10-11-gladiator-arena-design.md` §11.
Branch `claude/task-22` in `C:\Avi\Studies\Projects\Cloudiator-claude`, range `b4b3521..b0a2e8e`. The first three checkpoints and M16 were pushed to `origin/codex/gladiator-arena` as `b4b3521..074dcf3`; the rest is pushed by the controller after this records pass. Reviews, rulings and the deferred items are in [task-22-review.md](task-22-review.md).

## Overview

| Part | What it delivered | Commits | Report |
|---|---|---|---|
| 22.1 | Retention in the database: `private.cleanup_history` and `cleanup_tick`, the 7-day and 90-day passes, the ledger fold, receipt and bout-result guards, the three state tables, two projection optimizations | `34dae0a`, `0f7587d`, `8faf0c4` | [task-22.1-report.md](task-22.1-report.md) |
| 22.2 | Durable ticks (per-seller subtransactions, a contained dispatch block), whole seasons (`private.season_bounds`, phase-4 season row), recovery tests for a service paused for days | `782facc`, `7e1d272`, `f16c377`, `61065ee` | [task-22.2-report.md](task-22.2-report.md) |
| 22.3 | `private.health_report`, `health_alerts` and `npm run health`; the carried sweep cap and events; migration M16 | `0f86b3e`, `402b641`, `bbf7ac6` | [task-22.3-report.md](task-22.3-report.md) |
| 22.4 | Export and restore check scripts, the shared connection parser, the runbook and environment guides; fix round 1 (behavioural guard probes, credentials off history) and the final fix wave | `8c2d01d`, `30d27b1`, `c83981c`, `5b4fbff`, `cdeb641`, `cc92de9`, `1a1cf70`, `85fe838`, `b0a2e8e` | [task-22.4-report.md](task-22.4-report.md) |
| 22.5 | Expired replays in the game: one server-time helper, "no longer kept" in Results, Arena, expeditions, tournaments and the replay page; compacted tournament fight summaries | `e5d0f2d`, `1dc684d` (built as `b343209`, `50f069a` in a parallel lane), final fix wave `4eab68b` | [task-22.5-report.md](task-22.5-report.md) |

22.1–22.5 each passed an independent specification and quality review (22.4 after one fix round, 22.5 with a visual pass), and the whole branch passed a final review (ready after one documentation fix) with a scoped re-review of the fix wave. The five step reports above hold the commands, results and limits; there is no separate Task 22 evidence beyond them.

## What Task 22 delivers

**Retention.** Account and current state, `settled_slots`, every `operation_receipts` row, seasons and standings records, projections, configuration and singletons are kept forever; only a settlement receipt's `result` is compacted, once, to `{"compactedAtMs":n}` at 90 days. Detailed replay data goes after 7 days (anchored to whole slots at or below `min(P−19, now−7 d)`, where P is the lesser of the published slot and the slowest character's processed slot): expedition plans and stages, arena assignments and results, tournament entries, bouts and results, completed jobs with their dependencies and attempts, activity snapshots and boundary members, with each tournament bout's `battleLog` compacted to a `fight` summary. Summaries go after 90 days: completed activities (and their recent results), tournament views, placements and pair jobs, finished boundary work and boundaries, terminal market listings and offers, consumed or refunded build reservations, superseded schedule revisions, and the ledger, which is folded into `private.wallet_checkpoints` so that a wallet always equals its checkpoint plus its remaining ledger rows. Operational data has short windows: command attempts 1 hour, the dispatch log 48 hours, operations events 30 days, `cron.job_run_details` 7 days. Unfinished jobs, held reservations, open listings, non-completed activities and anything above P−19 are never touched, and a batch stops below a blocking slot and reports it. Every run first flips any replay past its seven days to `expired`, independent of the checkpoint.

**Cleanup cadence.** `cloudiator-cleanup` runs `private.cleanup_tick()` at minute 23 of every hour, inert while the scheduler is off, in bounded batches (3 data slots per pass, 300 flips, 5,000 ledger rows, 1,000 rows for each other step) with a 500 ms lock timeout, so each transaction is short and a backlog drains at 72 slots a day against 18 accrued. The spec's "daily" cleanup is the maximum lateness. Every run stores its result and records one event (a SQLSTATE only on failure).

**Health.** `npm run health` prints `private.health_report` as JSON and exits 0 healthy, 1 with alerts, 2 on failure; locally it discovers this checkout's stack and refuses a non-loopback database, and a remote report needs `--remote` and `CLOUDIATOR_DB_URL`. The report covers slots behind, incomplete boundaries, jobs by kind and status with overdue and operator-state lists, 24-hour attempt counts and p50, p95 and max durations from `job_attempts`, dispatch, cleanup progress and failures, per-source events, database size against the 250 MB budget and the ten largest tables; CPU is reported as "not available". Alert codes: `boundary-behind`, `boundary-waiting`, `operator-jobs`, `overdue-jobs`, `cleanup-stale`, `cleanup-failures`, `cleanup-backlog`, `tick-failures` and `database-size`. Nothing in it can carry a secret, and no client role can run it.

**Export and restore.** `scripts/export-db.ps1` writes `.backups/<UTC stamp>/` (a schema dump, a data dump and a manifest with the commit, the applied migrations, row counts and SHA-256 sums) from the local stack, or from a hosted database with `-Remote` and `CLOUDIATOR_EXPORT_DB_URL`; the connection is parsed once and never printed. `scripts/restore-check.ps1` verifies the checksums, then restores into a throwaway database named exactly `cloudiator_restore_check` inside the local container (label verified first, `ON_ERROR_STOP`, pg_cron the only documented exclusion), compares every table's counts with the manifest, runs nine invariants and three behavioural guard probes, and drops the database. Evidence: on a seeded world the export and restore matched 54 tables and 2653 rows with both checksums and all nine invariants intact and the three guard probes refused; a mutation proof showed each probe fails when its guard is removed. The export leaves out `vault.secrets` and Auth sessions and refresh tokens, so after a restore the operator creates both Vault secrets and every player signs in again ([runbook](../operations/runbook.md), [environment](../operations/environment.md)).

**Client expiry.** One helper decides, from server time only, whether a replay is still kept, and every offer (Recent results, the Arena card, expeditions, tournaments and the replay page) follows it at the same instant the server's flip and pruning become eligible, before and after cleanup. Expired replays show the saved outcome and credited rewards with "no longer kept"; compacted tournament bouts keep their fight summaries.

## Migration M16

`supabase/migrations/20261018191110_operations.sql` covers 22.1–22.3 together (`db pull` from the tested `14-operations.sql`, then completed: guard triggers after their functions, the seed row, table revokes, all 13 function ACL pairs, the season-row backfill, `cron.schedule`, `notify pgrst`). It was proved by a clean M01–M16 replay with an identical 1127-line fingerprint and 252/252 DB tests at 22.3. M01–M15 are unchanged. **Deploy M16 and the 22.5 client together:** the client must read the compacted `fight` before the first compaction seven days after launch.

## Evidence at the end of Task 22

1102 unit tests; 256 DB/Auth/Edge tests with Edge stable; a clean M01–M16 replay (252/252 at 22.3); development browser suite 444 passed (22 skipped); production gate 16 passed (repo config); the real export and restore check described above. Final gate output is in the [review record](task-22-review.md#pre-push-gates).

## Handoff to Task 24

- Deploy M16 and the 22.5 client in one step.
- Confirm the hosted `pg_net.ttl` (6 hours locally; cleanup deletes nothing from `net._http_response`).
- After the first hosted cleanup, read `operational.cronRunDetails` in the health report for the `cron.job_run_details` privilege (also `pg_database_size` and `pg_total_relation_size`).
- Run the `-Remote` export, which has never run past the connection: first rehearse it locally through `host.docker.internal:54322` (`sslmode=disable`), then against the hosted project (the `postgres` role must be able to `pg_dump` every schema; a direct host may be IPv6-only, so keep the session pooler as the fallback).
- After any restore, create both Vault secrets with `vault.create_secret` (never `update_secret`), matching the Edge `GAME_WORKER_SECRET`.
- Choose the TLS mode: `require` encrypts but does not verify; decide on `sslmode=verify-full` with the hosted CA.
- Auth sessions are excluded from backups, so players sign in again after a restore; a backup holds password hashes and MFA secrets, so decide where it is stored (consider excluding `auth.mfa_challenges` and extending the `foreignKeys` invariant to `auth`).
- Repeat the restore check against the real project: the local one is a separate database in the local cluster and proves completeness and consistency, not a hosted disaster recovery.
- Expect a `cleanup-stale` alert until minute 23 or a manual `select private.cleanup_tick()` after the scheduler is enabled.

The items for Task 23 (the coverage bundle 22.1 M6 / 22.3 M4 / 22.5 M3, Edge-recreation dates for `verification-gates.md`, the 22.5 polish, and the command-receipt growth measurement) are listed under "Carried items" in the [review record](task-22-review.md#carried-items).
