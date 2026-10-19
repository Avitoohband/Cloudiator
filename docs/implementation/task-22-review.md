# Task 22 independent reviews: retention, health reporting and recoverable exports

Plan: [Task 22 plan](../superpowers/plans/2026-10-18-task-22-retention-operations.md). Spec: [game design §11](../superpowers/specs/2026-10-11-gladiator-arena-design.md). Each checkpoint has a fresh implementer and an independent reviewer; reviewers may run read-only catalog queries against the local stack "Cloudiator". Reviewers: Opus for 22.1–22.5, Sonnet for scoped re-reviews of fix rounds and the final fix wave, and the most capable model (Fable) for the final whole-branch review. There was no mockup: 22.5 changes copy and state inside existing panels with no new layout, so Avi sees screenshots at completion (controller ruling).

The task ran in two stretches. 22.1–22.3 ran in sequence, with pauses at Avi's request during the 22.2 and 22.3 reviews, and were pushed together after the 22.3 review. Then Avi asked on 2026-10-19 for parallel agents, so 22.4 and 22.5 ran in separate worktrees and were integrated by a cherry-pick (see "Parallel lanes and integration").

## 22.1: Retention in the database

Range `e5ea022..8faf0c4`: `34dae0a` (feature), `0f7587d` (self-review fix: bound the real-clock wait of the ledger case) and `8faf0c4` (report). [Implementer report](task-22.1-report.md). There is no migration here: M16 in 22.3 covers 22.1–22.3.

**Implementer evidence:**
- 17 retention tests (the brief's 16 plus one Review Focus lock case), all red before `14-operations.sql` existed (17/17 failed, each for the missing feature); unit tests 1056.
- `test:db` 235/235 with the Edge start time unchanged (`16:47:52Z`).
- `db lint` clean; advisors 4 INFO unused-index notices, none a warning.
- `pg_net.ttl` is 6 hours locally, so cleanup has no `net._http_response` delete.
- The ledger case commits every wallet-moving kind (all ten reasons) and proves `wallets = checkpoint + Σ ledger` for every character after one fold and after a final fold.

**Verdicts:** spec compliant; quality Approved; no Critical or Important findings. Commit trailers were verified by the controller (1/1/1).

**What the reviewer confirmed:**
- **Decisions 2–5:** P, H7 and H90 are computed as specified and both slot passes are skipped when P is null; the three backend-only tables have RLS and select-only access for `service_role`; `lock_timeout` is 500 ms and the state row is locked first; EXECUTE on cleanup is revoked from all four roles; the tick is inert while the scheduler is off and records a SQLSTATE-only event on failure.
- **FK order:** every foreign key into a pruned table was grepped across `supabase/sql`. Each NO ACTION reference is deleted before its parent; the only cascades are the two intended ones (`recent_results`, `tournament_placements.activity_id`); no permanent table references a deleted one.
- **Guards:** `guard_receipt` refuses every delete and allows one compaction of an `activity-settlement` result; `guard_tournament_bout_result` allows exactly the `battleLog` to `fight` update. No existing writer updates or deletes receipts or bout results.
- **P−19 margin:** the pairing history reads slots from P−17 up while deletion stops at P−19. A non-completed activity or an unfinished job stops the batch and is reported as `blockedSlot`.
- **Locks:** the coordinator is read without a lock and the lease is never touched. The only account lock is the `expire_listings` try-lock, which never waits (proved at `market.test.ts:605-634`).
- **Projections:** dropping `project_changed_character` on `activity_stages` loses nothing (the projection reads no stage), and the anti-join upsert gives the same rows as the old upsert.
- **Tests:** real history built through real boundaries and settlements, exact counts per table, off-by-one checks at P−19, RED evidence for both projection changes, resume after an unblock, caps and idempotency.
- **Deviations accepted as strengthenings:** P is null whenever nothing is published; 7-day step (1) flips without the expiry predicate; schedule revisions are deleted only when the newer revision is effective no earlier than the old one (phase 5 orders by effective slot first, so the brief's literal rule could delete a revision a future boundary still reads); the return value adds `checkpointSlot`.

**Controller rulings (see the appendix):**
- Cleanup runs hourly in bounded batches instead of once a day (a pre-flight ruling).
- The `expire_listings` backstop inside cleanup may take a seller account lock by try-lock only.
- Until 22.2, one inconsistent open listing fails the whole cleanup call; 22.2 must give the backstop the per-seller isolation too.
- Health adds an alert for repeated cleanup failures (carried to 22.3).

**Minors:**
- **Carried to 22.2 and fixed there (the 22.2 review confirmed each):** M1 (the busy-owner lock case had no due listing), M2 (the cron-contention case needed a finished cron run: now a committed fabricated row, deleted in `finally`), M3 (the ledger case commits real commands: `afterAll` reset), M4 (`resetIdentity` reseeds the singleton with `on conflict`), M5 (client RPC probes labelled as exposure checks).
- **Carried to 22.3 and fixed there:** M7 (a canceled 57014 tick leaves no event: `cleanup-stale` reads `last_run_at_ms`), M8 (per-row reprojection cost: health shows the pass durations), M9 (`migrations.md` M16 wording).
- **Deferred:** M6 (blocking is tested only with an unfinished job; several caps are untested) and M10 (gate noise: the unused-index INFO and Edge recreation during `tsc` and `deno check`).

**Reviewer notes:** `POLLED_RESULT` still read `battleLog` after the compaction, so 22.5 had to land before any deploy (Task 24). The M16 completion list had to be enforced in 22.3 (done).

## 22.2: Durable ticks, whole seasons and recovery

Range `8faf0c4..61065ee`: `782facc` (feature), `7e1d272` (22.1 minors M1–M5), `f16c377` (self-review fix: sweep past a failing seller between two sound ones) and `61065ee` (report). [Implementer report](task-22.2-report.md). Work was paused at Avi's request (2026-10-18 21:03 IDT) during the review and resumed at 21:34 IDT; the review result was recorded during the pause.

**Implementer evidence:**
- Recovery tests 8/8, four of them red first; unit tests 1056.
- `test:db` 243/243 on two valid runs with Edge stable (`17:47:40Z` and `17:53:21Z`). Two earlier full runs were discarded because the Edge container was recreated during them.
- Lint clean; advisors 4 INFO.

**Verdicts:** spec compliant; quality Approved; no Critical or Important findings. Trailers verified (1/1/1/1).

**What the reviewer confirmed:**
- **Replaced bodies are faithful:** `expire_listings`, `cron_tick`, `boundary_close_season` and `boundary_recompute_leagues` were each compared with their latest earlier definition and differ only as intended.
- **Subtransactions:** each seller is swept in its own block with the try-lock outside it, so a failed seller rolls back alone, a partial count cannot leak, and the sweep goes on. `cron_tick` runs `dispatch_workers()` in its own block, so a dispatch failure can no longer roll back committed coordination.
- **Season rows:** `private.season_bounds` is STABLE (it reads the epoch), phase 2 and the backfill take their bounds from it, and phase 4 inserts its season row `on conflict do nothing` before any account lock, which removes M15's known limit.
- **Recovery tests:** a 37-slot pause is caught up by the real `cron_tick` and the real worker: boundaries complete once and in order, settlement order holds, every receipt has one ledger row, the market sweep expires the listings once, and a cleanup in the middle of catch-up removes nothing the catch-up still needs (the snapshot above the horizon, unfinished rows and grant state are compared before and after).

**Controller rulings (see the appendix):**
- "Nothing at or above P−19" in the brief's recovery wording is tested as "nothing above P−19", matching Decision 2.
- `cron_tick`'s expiry block records no event on a whole-sweep failure until 22.3 adds one.

**Minors:**
- **Carried to 22.3 and fixed there (the 22.3 review confirmed each):** M1 (the busy-owner case also asserts no `market-sweep` failure, with a mutation check), M2 (distinct SQLSTATEs in the sweep event, aggregated by health), M3 (a 50-seller cap per call), M4 (a test that M16 ships the backfill after `season_bounds`), M5 (items returned once, also by `catalogId` and origin row count), M6 (the recovery cases state their order dependence and check preconditions).
- **Deferred:** M7 (Edge recreated during `tsc` and `test:db` with no function change; kept open in `verification-gates.md`).

## 22.3: Health report and migration M16

Range `61065ee..bbf7ac6`: `0f86b3e` (feature, with M16 `20261018191110_operations`), `402b641` (self-review fix: state the recovery cases' order dependence precisely) and `bbf7ac6` (report). [Implementer report](task-22.3-report.md). Work was paused at Avi's request during the review; the result was recorded during the pause.

**Implementer evidence:**
- Red 10 of 34 on the new behaviours, then `test:db` 252/252 on a clean M01–M16 replay with Edge stable (`19:00:08Z`); 251/252 on the source applied before M16 existed (the M16 case was the only failure).
- The replay fingerprint (1127 lines: M15's 1029-line coverage plus every trigger's enabled state and the `retention_state` seed row) is byte-identical to the source's and again after the full test run. Lint empty; advisors 4 INFO, none on M16's tables.
- The first M16 draft (`20261018190708`) replayed cleanly but `db lint` reported three plpgsql_check warnings in new bodies (an untyped `'{}'`, `health_alerts` marked IMMUTABLE, `health_report` marked STABLE). It was never committed: the source was fixed, the draft discarded (local `migration repair --status reverted`, exact-file removal) and M16 regenerated; the new draft differs only in those three lines.
- The backfill statement, verbatim from M16, ran on the replayed database inside a `DO` block that always raises: it created exactly the expected season rows, added nothing on a second run and left nothing behind.
- A mutation check moved the seller account lock inside the per-seller block as a waiting lock; the strengthened never-waits assertion failed exactly there, and the function was restored byte for byte (md5 checked).

**Verdicts:** spec compliant; quality Approved; no Critical or Important findings. Trailers verified (1/1/1).

**What the reviewer confirmed:**
- **Health fields and alerts:** every Decision 8 field, with `budgetBytes` 262144000 and `cpu: "not available"`, and all nine alert codes at their exact thresholds (the budget alerts at 80 % − 1, 80 %, 100 % − 1 and 100 %; the boundary threshold at exactly 10 minutes and 10 minutes + 1 ms).
- **Secret-free by construction:** every free-text column is shape-filtered to a SQLSTATE or a failure code, event detail contributes only `failedSellers` and validated SQLSTATEs, and nothing reads Vault, pg_net or cron messages. A test plants a URL, JWT, Bearer token, password, API-key shape and Vault value in every source and none crosses.
- **M16 is complete and ordered:** both trigger drops, the seed row after the constraints, guard triggers after their functions, table revokes before grants, all 13 function ACL pairs, the backfill after `season_bounds`, `cron.schedule` and `notify pgrst`. The reviewer extracted the 13 function bodies from the source and from M16: all byte-identical, none re-emitted. M01–M15 are untouched.
- **CLI:** `npm run health` reads in one read-only transaction with bounded timeouts, maps errors to a fixed code plus a SQLSTATE, and uses only the existing `postgres` driver.

**Controller ruling (see the appendix):** boundary waiting time is measured from `opened_at_ms` (the other timestamp is rewritten on every attempt), and overdue jobs include leases expired over 10 minutes ago.

**Minors:**
- **Carried to 22.4 and fixed there (the 22.4 review confirmed each):** M1 (the loopback guard and the driver parsed the URL differently: one shared parser now refuses `,` and more than one `@` and hands discrete fields to the driver), M2 (EPIPE is a network failure), M3 (all CLI failure codes are in the runbook).
- **Deferred:** M4 (coverage gaps: backlog under 24 h and the exact 24/26 h edges, a lease expired under 10 minutes, busy sellers against the cap) and M5 (environment noise: Edge recreations outside counted runs, and the healthy CLI case depends on the local database staying under 80 % of the budget).

**After the review:** on Avi's "continue" (2026-10-19), 22.1–22.3 and a runtime note were pushed to `origin/codex/gladiator-arena` as `b4b3521..074dcf3` (fast-forward; unit tests 1056, typecheck, build, `verify:static`, `git diff --check`; no `src` change). The host had restarted: Docker Desktop failed at the Secrets Engine socket, recovered with the guarded recipe in [local-runtime.md](../operations/local-runtime.md) (the stale directory was preserved under a fresh backup name, nothing deleted); the stack and Edge serve were then restarted and `migration list --local` showed the 16 migrations with the reverted draft absent.

## 22.4: Export, restore check and operator guides

Range `074dcf3..cc92de9`: `8c2d01d` (22.3 minors M1/M2: one connection parser, EPIPE), `30d27b1` (feature), `c83981c` (self-review fix: refuse a loopback URL for a remote export), `5b4fbff` (report), `cdeb641` (fix round 1) and `cc92de9` (its report); `9e56dbf` (a controller note on the clean Docker start) is also in the range. [Implementer report](task-22.4-report.md), including fix round 1 and the final fix wave.

**Implementer evidence:**
- Unit tests 1083, then 1084 after fix round 1; `test:db` 256/256 with Edge stable (`05:49:33Z`); `tests/scripts` 28/28 after fix round 1 (two red first).
- The real procedure, run once on a seeded world (four characters, an open listing, a catch-up through boundary 1009, season 1 closed): the export wrote 54 tables and 2653 rows; the restore check into `cloudiator_restore_check` matched all 54 tables and 2653 rows, both checksums, all nine invariants, with a resumed boundary replayed, `duplicateGrants` 0 and `lostItems` 0, and the restore database dropped. pg_cron objects are the only exclusion (15 schema entries and 4 data entries); nothing in `public`, `private` or `auth` is excluded from the restore. `.backups/` is git-ignored.
- Refusals proved on the real scripts: a tampered dump (`checksum-mismatch`, exit 1 before any restore), `-Database postgres` and a differently cased name (`database-not-allowed`), a missing backup, `-Remote` without a URL, with a loopback URL and with the review's evil URL.
- Red evidence on the parser: five of ten tests failed on the unchanged 22.3 logic (the evil URL accepted, EPIPE as a SQLSTATE, an encoded host, doubled IPv6 brackets).

**Verdicts (first review):** spec compliant with one plan-mandated weakness; quality Needs fixes (two Important). After fix round 1, the scoped re-review found both addressed and nothing open; the checkpoint is clean.

**What the reviewer confirmed:**
- **Destructive scope is tight:** the target is a constant, `Invoke-Psql` admits only it and the `postgres` maintenance connection, the label and checksum gates run before any drop, `restore-resume.sql` refuses any other database itself, and every psql run uses `ON_ERROR_STOP`.
- **Credentials never touch a command line or output:** one parser feeds discrete fields to postgres.js and to libpq through `docker exec -e NAME`; the child's stderr is discarded; the tests use random markers to prove nothing is echoed.
- **The comparison fails closed:** a missing table, a missing or self-contradicting invariant and a malformed manifest all fail; counts come from the dump's own COPY rows; the manifest must list exactly both dumps.
- **Carried 22.3 items are present:** the shared parser, EPIPE, every CLI code, `verify-full` notes and the egress and invocation budgets in the runbook.
- **Not dumped:** no pg_net extension script registers its tables for dumping, so the worker secret queued in `net.http_request_queue` does not reach `.backups/`.

**Important findings (both fixed in round 1):**
- **I1 (plan-mandated):** the resume check's "no new grants" comparison could not fail. `advance_boundary` returns `replayed` for a published slot before any phase or grant table, so `duplicateGrants` and `lostItems` were 0 by construction. Fix `cdeb641`: the replay stays, labelled structural, and three behavioural probes run on the restored rows, each in a rolled-back subtransaction (a second settlement must hit the primary key, deleting a settled slot and deleting a receipt must each be refused by their guards, and the counts must be unchanged). `compareRestore` judges each probe against its own fixed expectation. The runbook and report stopped claiming a real replay; the plan's wording was the controller's error.
- **I2:** the runbook had the operator type the owner connection string at an interactive prompt (kept in plaintext by PSReadLine) and paste the worker secret into the SQL editor. Fix: a "Entering a connection string" section reads it with `Read-Host -AsSecureString` (and `read -rs` in Git Bash), and the Vault step runs in a new unsaved query that is deleted afterwards.

**Fix-round evidence:** the real restore check ran twice with the probes (exit 0, all three refused, counts unchanged). A mutation proof removed one guard at a time in the restored copy only (`settled_slots_pkey`, `guard_frozen`, `guard_receipt`): each time exactly its own probe failed, `compare` exited 1, and the counts stayed unchanged. Unit tests 1084, typecheck, `git diff --check` clean.

**Controller rulings (see the appendix):**
- The export leaves out Auth session and refresh-token rows: a backup should not carry live sessions, so every player signs in again after a disaster restore.
- The remote export path is untested beyond the connection and is carried to Task 24.
- I1 is fixed, not waived.
- The restore check targets a separate database inside the local container, not a new container (a pre-flight ruling).

**Minors:**
- **Fixed in the final fix wave:** M1 (the post-restore secret step, promoted to Important 1 of the final review), M2 (a sentence that a failed restore's psql error text can echo row values and must not be shared), M3 (the manifest commit now uses the repository root), M5 (the missing failure codes and the resume statuses with an action each) and the naming half of M6 (a backup holds `auth.users` password hashes and `auth.mfa_factors` secrets). Also the inline `CLOUDIATOR_DB_URL=…` lines in `migrations.md` and `scripts/health.mjs` (fix-round minor).
- **Deferred:** M4 (a local rehearsal of the `-Remote` path through `host.docker.internal:54322` before Task 24), the rest of M6 (consider excluding `auth.mfa_challenges`; extend the `foreignKeys` invariant to `auth`) and the other fix-round minors (deleting a SQL-editor history entry cannot be verified, the `SecureString` is not disposed, the clipboard command, report lines not marked as superseded).

## 22.5: Expired replays in the game

Range `074dcf3..50f069a` on `claude/task-22-client`: `b343209` (feature) and `50f069a` (report). Cherry-picked onto `claude/task-22` as `e5d0f2d` and `1dc684d`. [Implementer report](task-22.5-report.md). Built in the `Cloudiator-replay` worktree with no database or Edge.

**Implementer evidence:**
- Red first: 15 unit failures and 14 browser failures (7 tests on desktop and mobile), each for missing behaviour.
- Unit tests 1073; typecheck; assets check; build; `verify:static` (5 fixed routes, 90 assets); development browser suite 444 passed, 22 skipped on port 3300; isolated production gate 16 passed, 450 skipped on port 4173; `git diff --check` clean.
- The tournament keyboard test needs four Tab presses because the new `aged` sample adds a button.

**Verdicts:** spec compliant; visual pass; quality Approved; no Critical or Important findings.

**What the reviewer confirmed:**
- **One helper, server time only:** `replayKept` and `tournamentReplayKept` decide every offer (Recent results, Arena card, expeditions, tournaments, the replay page) from a read's `serverNowMs` or the shared clock once it is synced or held. No new decision uses `Date.now()`.
- **Client and server agree:** the client says "no longer kept" at `ends_at + 7 d`, the same instant the server's flip, prune and compaction become eligible, both before and after the hourly cleanup. A log pruned while its summary still said `available` reads `expired`, never `missing`.
- **Compacted bouts keep their fight summary:** `POLLED_RESULT` selects `fight:result->fight` and copies only its three fields; `readTournamentLog` returns `not-found` after expiry without querying the log table.
- **Unsynced clock:** until the clock has the server's time, Recent results shows no Replay button and calls nothing gone, with no endless loading.
- **Visual review:** results top and expired rows, the saved Arena outcome, the cleaned-up expedition, the tournament older than seven days and a watched replay that is gone were checked on desktop and at 360 px; all pass.

**Controller rulings (see the appendix):** no mockup for 22.5; a replay link to an activity deleted after 90 days reads "not available yet", because activity ids carry no date (rare, and the 90-day summary is gone too).

**Minors (all deferred):** M1 (the old-link tournament notice uses the 7-day threshold although views live 90 days; unreachable in the live UI today), M2 (BattleReplay's "kept until" note can follow the device clock during a sync error), M3 (no test for the note vanishing at expiry during playback, or for `useServerTime`'s unsynced-to-synced path), M4 (accepted trade-off: a persistent sync error offers no Replay in Recent results), M5 (the owner's expired-expedition card lacks an "Expedition · settled" eyebrow), M6 (optional copy that results older than 90 days are not kept), M7 (fixture-only inconsistency for the `completed` and `pair` samples).

**Reviewer notes:** the brief named `src/features/expedition/ExpeditionView.tsx`, which does not exist; the implementer correctly changed `src/features/character/ExpeditionView.tsx`. The combined Task 22 report is assembled by the controller's records pass ([task-22-report.md](task-22-report.md)).

## Parallel lanes and integration

Avi asked on 2026-10-19 for parallel agents. Controller ruling: 22.5 runs in the separate worktree `Cloudiator-replay` on `claude/task-22-client` from `074dcf3` (its own `.next`, Playwright port 3300, no database or Edge needed) while 22.4 stays in `Cloudiator-claude`; the file sets are disjoint. A read-only survey of Task 23 ran in parallel and produced the requirements and plan draft Task 23 starts from. A host reboot at 08:33 IDT interrupted all three lanes; after Avi's "continue" Docker started cleanly, the stack and Edge serve were restarted and the three agents resumed from their committed state with nothing lost.

After both lanes were reviewed, 22.5 was cherry-picked onto `claude/task-22` (`e5d0f2d`, `1dc684d`, clean), and the full gate ran there before the final review.

**Gate result:** unit tests, typecheck, assets, build and `verify:static` passed; the development browser suite (444 passed, 22 skipped) and the production gate (16 passed, 450 skipped) passed. `test:db` gave 254/256 with Edge stable (`06:31:49Z`), and `git diff --check` found one blank line at the end of `scripts/restore-compare.mjs`.

**F0, found only by the integration gate:** two tournament DB tests ("publishes the seeded first round …" and "keeps battle logs out of every polled read of a late 50-entrant view …") failed with `not-found`. Task 22.5's rule, which the 22.5 reviewer approved, makes `readTournamentLog` answer `not-found` once the sampled server time reaches the tournament's end plus seven days. Those tests read the logs of a 1970 tournament at the real clock, decades later. The 22.5 lane had no database, so it could not run them.
- **Controller ruling:** the product rule stands. The tests read inside the retention window under the stand-in restore rule, keep their unrevealed `not-found` meaning and gain one assertion that the same log is `not-found` after the window.
- **Fix:** `4eab68b`. `world_revision.server_now_ms` is computed from `statement_timestamp()` inside the view, with no function to stand in for, so a test-client fetch wrapper rewrites only that response; the database, its RLS and every other response stay real, and nothing needed restoring.

## Final whole-branch review and fix wave

Range `b4b3521..1dc684d` (21 commits, 56 files), reviewed read-only by the most capable reviewer in three passes: SQL (`14-operations.sql` in full and M16 by structure); scripts and operations (export, restore, parser, health, runbook, environment, the `migrations.md` hunk); and the client with the titles of every Task 22 test. Nothing was run. **Verdict: ready to merge, with fixes.** No Critical findings; one Important (documentation only); six Minor.

**What it confirmed across checkpoints:**
- **Cleanup safety end to end:** only the retention singleton, old terminal rows and (at `SET CONSTRAINTS ALL IMMEDIATE`) the projection rows are locked; the coordinator is read without a lock; the only account lock is the seller try-lock; with a 500 ms `lock_timeout` set first, cleanup is the side that gives up, and a reprojection order conflict ends in 55P03 rather than a deadlock wait. Because H90 ≤ `detail_through_slot`, the 90-day pass can never pass a slot the 7-day pass was blocked on.
- **FK order checked independently** (jobs, activities, tournaments, views): each reference is deleted earlier or at the 90-day pass.
- **Guards are exact:** the receipt guard refuses every delete and allows one compaction; the bout guard requires the byte-exact expression; the checkpoint guard requires `ledger_rows` to grow. The restore check probes two of them behaviourally.
- **M16 is complete and ordered**, and no finding needs a schema change, so no new migration is required (22.1–22.3 are on origin).
- **Durable ticks** are scoped per seller under the 64 sub-XID cache with distinct SQLSTATEs, and a failure to record an event can no longer roll back coordination.
- **Health is secret-free by construction**, and `cleanup-stale` reads `last_run_at_ms`, so a 57014-canceled tick is still visible.
- **Export and restore destructive scope is tight**, and no credential touches a command line.
- **Client and server cutoffs agree**, one helper decides everywhere, and a log pruned while available reads `expired`, never `missing`.
- **Review Focus 1–5** each have a named real test: cleanup racing a boundary or a command, a command retried after 90 days, a service paused for days, a replay older than seven days, and a restore into a separate database.
- **The 22.5 cherry-pick is clean:** the integrated client code is byte-identical to the reviewed lane (only the three 22.4 test files differ).

**Important finding I1 (fixed):** the runbook's post-restore secret step could not work as written (it was the deferred 22.4 M1, promoted). Step 4 was `vault.update_secret((select id from vault.secrets where name='game_worker_secret'), …)` and the text called it the step that re-creates the secrets after a restore. After a restore `vault.secrets` is empty (it is in the export exclusions), so the sub-select is null and `update_secret` updates zero rows silently; `game_worker_url` was not covered at all. Dispatch would then stay `unconfigured` and the operator would learn it only from `overdue-jobs`. The same section wrote the private env file with `node -e … >`, which is UTF-16LE under Windows PowerShell 5.1 and which `supabase secrets set --env-file` cannot parse.
- **Controller ruling (see the appendix):** the final fix wave takes Important 1, Minors 1–3 and F0; everything else stays deferred per the triage below.

**Final fix wave:** `4eab68b` (F0 test), `1a1cf70` (docs: F1/F2/F4), `85fe838` (F3 fix and the end-of-file blank line) and `b0a2e8e` (the final-fix-wave sections of the [22.4](task-22.4-report.md) and [22.5](task-22.5-report.md) reports). No SQL, migration, Edge function or dependency changed.
- **F1 (Important 1):** step 4 is rotation on a live database only, with a names-only check; a new paragraph says to create both Vault secrets after a restore with `vault.create_secret('<url>', 'game_worker_url')` and `vault.create_secret('<secret>', 'game_worker_secret')` (scheduler paused first, same SQL-editor rules); step 2 writes the private file from node with `{ flag: 'wx' }` and the path as an argument (run in PowerShell 5.1: UTF-8, no BOM, a second run refused).
- **F2 (Minor 1):** the inline `CLOUDIATOR_DB_URL=… command` forms in `migrations.md` and `scripts/health.mjs` now point to the runbook's "Entering a connection string".
- **F3 (Minor 2):** the manifest's `commit` and `dirty` come from `repositoryCommit()` with `cwd` set to the repository root, covered by a test that runs the module from a temp directory (red with the `cwd` removed).
- **F4 (Minor 3):** the runbook lists `usage`, `verify-failed` and `compare-failed` and an action for each resume status, warns that a failed restore's error text can echo row values, and names the Auth secret material kept in a backup.
- **F0:** see the integration section above.

**Fix-wave evidence:** `tests/scripts` 29/29; unit tests 1102/1102; typecheck; `test:db` 256/256 with Edge stable (`06:52:03Z`, before and after); `git diff --check b4b3521..HEAD` clean.

**Scoped re-review (Sonnet):** all five items ADDRESSED, no new breakage. F0's test-only server-clock fake is confined to `tournaments.test.ts`; the product rule is untouched.

**Not judged by the final review:** commit trailers (verified by the controller), the reported gate counts (the gate had run), hosted behaviour of `-Remote`, `pg_net.ttl` and cron privileges (Task 24), and the growth of never-deleted command receipts (Task 23 measurement).

## Deferred Minor items and the final triage

**Triage result: nothing deferred needs code or a migration before the push.** The final review's required fix (Important 1) and its two one-line documentation edits were taken by the final fix wave, together with 22.4's M2, M3, M5 and the naming half of M6 and the integration defect F0.

| Item | Ruling | Where it goes |
|---|---|---|
| 22.1 M1–M5 (carried to 22.2) | Addressed; confirmed by the 22.2 review | closed |
| 22.1 M6 (blocking only via an unfinished job; caps for reservations, revisions, market, `command_attempts`, events and cron untested) | Stays deferred: coverage, no observed defect; the predicates are simple limits | Task 23 |
| 22.1 M7–M9 (carried to 22.3) | Addressed; confirmed by the 22.3 review | closed |
| 22.1 M10 (gate noise: unused-index INFO, Edge recreated during `tsc` and `deno check`) | Stays deferred | Task 23 |
| 22.2 M1–M6 (carried to 22.3) | Addressed; confirmed by the 22.3 review | closed |
| 22.2 M7 (Edge recreated during `tsc` and `test:db`) | Stays deferred; the open note exists in `verification-gates.md` | Task 23 |
| 22.3 M1–M3 (carried to 22.4) | Addressed; confirmed by the 22.4 review | closed |
| 22.3 M4 (backlog under 24 h, the 24/26 h edges, a lease under 10 minutes, busy sellers against the cap) | Stays deferred | Task 23 |
| 22.3 M5 (environment noise) | Stays deferred | Task 23 |
| 22.4 M1 (Vault `create_secret` after a restore; `node -e >` UTF-16) | Fixed in the final fix wave (F1) | closed |
| 22.4 M2 (raw tool stderr can echo row values) | Documented in the runbook in the final fix wave (F4); no code change | closed |
| 22.4 M3 (manifest commit uses the caller's directory) | Fixed in the final fix wave (F3, test-covered) | closed |
| 22.4 M4 (local `-Remote` rehearsal through `host.docker.internal:54322`) | Stays deferred; already carried to Task 24 by ruling | Task 24 |
| 22.4 M5 (runbook codes and resume statuses incomplete) | Fixed in the final fix wave (F4) | closed |
| 22.4 M6 (name the Auth secret material; `auth.mfa_challenges`; `foreignKeys` over `auth`) | The naming was fixed in the wave (F4); the exclusion and invariant extension stay deferred | Task 24 |
| 22.4 fix-round minors (SQL-editor history unverifiable, `SecureString` not disposed, clipboard command, report lines not marked superseded; inline `CLOUDIATOR_DB_URL=…` lines) | The two inline-URL lines were fixed in the wave (F2); the rest stay deferred | Task 24 |
| 22.5 M1 (old-link notice 7 d against 90 d) | Stays deferred (unreachable in the live UI; note it where a tournament deep link would be planned) | Task 23 |
| 22.5 M2 ("kept until" note follows the device clock during a sync error) | Stays deferred; the keep or expire decision itself is server time | Task 23 |
| 22.5 M3 (no test of the note at expiry or the unsynced-to-synced hook) | Stays deferred | Task 23 |
| 22.5 M4 (no Replay during a persistent sync error) | Accepted as the documented trade-off of "server time only" | none |
| 22.5 M5, M6, M7 (eyebrow, optional copy, fixture inconsistency) | Stay deferred (polish) | Task 23 |
| Final review Minor 4 (`cron.job_run_details` privilege and the size functions unverified hosted) | Stays deferred; the result is contained and reported in `operational.cronRunDetails` | Task 24 |
| Final review Minor 5 (`verification-gates.md` untouched) | Stays deferred; append the Task 22 Edge dates | Task 23 |
| Final review Minor 6 (= 22.5 M1) | See 22.5 M1 | Task 23 |
| Rulings carried to Task 24 (remote export untested, hosted `pg_net.ttl`, Auth sessions excluded) | Agreed by the final review | Task 24 |

## Carried items

**Task 23:**
- **One coverage bundle:** 22.1 M6 (blocking by a non-completed activity; caps for reservations, revisions, market listings, `command_attempts`, events and cron), 22.3 M4 (backlog and alert edges, leases, busy sellers against the cap) and 22.5 M3 (the note at expiry and the unsynced-to-synced hook).
- **Edge recreations for `verification-gates.md`** (no function change in any of them; every counted run kept an unchanged start time). Each container start time below is a recreation time, all on 2026-10-18 except the last two: 22.1 `16:42:24Z` and `16:47:52Z`; 22.2 `17:40:27Z`, `17:43:48Z` and `17:45:45Z` (the two full runs they bracket were discarded), then `17:47:40Z` and `17:53:21Z`; 22.3 `18:45:06Z`, `18:52:09Z` (four seconds into a discarded run) and `19:00:08Z`; on 2026-10-19 the integration gate saw `06:31:49Z` and the container was recreated before the final fix wave (`06:52:03Z`). The cause is still unconfirmed; the Task 16 note there says so.
- **22.5 polish:** M1 (the old-link notice threshold), M2 (the device-clock note), M5 (the expedition eyebrow), M6 (optional copy) and M7 (the fixture samples).
- **Command-receipt growth:** receipts are never deleted or compacted (a guard enforces it); only settlement results are compacted at 90 days. Measure the growth at capacity.
- **Capacity notes from the final review:** a sparse-activity stretch can let one 7-day batch span many boundary slots (bounded in practice and lock-timeout protected); each flipped or deleted row still bumps `world_revision_state` once.
- **Known flaky tests with root causes found by the Task 23 survey:** `arena.test.ts:1193` waits for a stable real slot (120 s) inside a 60 s timeout, and `tournaments.test.ts:169` waits for one (60 s) inside the 20 s default.

**Task 24:**
- **Deploy M16 and the 22.5 client together.** `POLLED_RESULT` must read the compacted `fight` before the first compaction seven days after launch.
- **Hosted `pg_net.ttl`** (6 hours locally; cleanup deletes nothing from `net._http_response`).
- **`cron.job_run_details` privilege:** read `operational.cronRunDetails` in the first hosted cleanup result; the runbook's `cleanup-failures` row could mention it. The same goes for `pg_database_size` and `pg_total_relation_size` in the health report.
- **The `-Remote` export has never run past the connection.** Run a local rehearsal first (`CLOUDIATOR_EXPORT_DB_URL` pointing at `host.docker.internal:54322` with `sslmode=disable`), then the hosted run: the hosted `postgres` role must be able to `pg_dump` every schema, and a direct host may be IPv6-only (the runbook names the session pooler as the fallback).
- **Vault after a restore:** `vault.secrets` is not exported, so create both `game_worker_url` and `game_worker_secret` with `vault.create_secret` (not `update_secret`), with the Edge `GAME_WORKER_SECRET` equal to the new secret, as in the runbook.
- **TLS and CA:** `ssl: 'require'` encrypts but does not verify the server. Decide on `sslmode=verify-full` with the hosted CA (`NODE_EXTRA_CA_CERTS` for health, `/root/.postgresql/root.crt` in the container for the export).
- **Auth sessions are excluded from backups:** after a disaster restore every player signs in again; a backup does hold `auth.users` password hashes and `auth.mfa_factors` secrets, so decide where backups live. Consider excluding `auth.mfa_challenges` and extending the `foreignKeys` invariant to `auth` (22.4 M6).
- **The restore check is a separate local database** (roles from the local cluster, no pg_cron). It proves the backup's completeness and consistency, not a hosted disaster recovery; repeat it against the real project.
- **`cleanup-stale` fires right after the scheduler is enabled** until minute 23 or a manual `select private.cleanup_tick()` (release note in `migrations.md`).

**Recorded:**
- Cleanup runs hourly in bounded batches; the spec's "daily" is the maximum lateness.
- CPU per request is reported as "not available" (the Edge runtime does not expose it); egress and function invocations are read from the hosting dashboard (the runbook says how).
- A replay link to an activity deleted after 90 days reads "not available yet".
- **Pending Avi:** two skill-upkeep proposals. (1) Supabase CLI override, "Generated migration completion": run `db lint --fail-on warning` on the source-applied database before `db pull`, and add trigger enablement and singleton seed rows to the parity fingerprint (the fingerprint extension is tested; lint-first is untested as a general rule). (2) Supabase CLI override, psql-fallback paragraph: verify the container label with `{{json .Config.Labels}}`, because the `index … "…"` template fails in Windows PowerShell 5.1 (`migrations.md` is already fixed).

## Pre-push gates

Code tree `b0a2e8e`; the records commit that follows it changes only documentation, and the checks below were run on the tree before it and again after it with the same results.

- `npm test` 1102/1102 (50 files); `npm run typecheck` clean (`tsc`, `deno check` of both Edge entrypoints, 2 Deno tests).
- `npm run build` (7 static pages) and `npm run verify:static` (5 fixed routes, 90 assets, no forbidden backend material, no fixture preview data) pass.
- `git diff --check b4b3521..HEAD` clean.
- No database or browser run after the final fix wave's last code commit (`85fe838`; `b0a2e8e` and the records commit are documentation). The last DB run was 256/256 with Edge stable (`06:52:03Z`) at the parent of `b0a2e8e`; the last browser runs were the integration gate's (development 444 passed, 22 skipped; isolated production gate 16 passed, 450 skipped) on a tree whose later commits changed no `src` file; the clean M01–M16 replay (252/252, identical 1127-line fingerprint) is from 22.3.

## Appendix: every controller ruling (from the execution ledger)

Each line gives what was decided, why, and what it costs if wrong. They are copied verbatim from the ledger, in ledger order, before its deletion. There are 20 lines.

- Ruling: cleanup runs hourly in bounded batches (cron '23 * * * *') instead of once a day — keeps each transaction short and catches up a backlog at 72 slots/day against 18 accrued; the spec's "daily" becomes the maximum lateness — costs 24 small runs a day.
- Ruling: command receipts are never deleted or compacted (a guard enforces it); only settlement receipts' result is compacted at 90 days — five commands compare the full request JSON for conflicts — costs receipt growth, measured in Task 23.
- Ruling: both projection optimizations (drop project_changed_character on activity_stages; anti-join recent_results upsert) go into M16 with tests — they cut cleanup's commit-time cost — costs a projection regression if the tests miss one.
- Ruling: CPU per request is reported as "not available" (the Edge runtime does not expose it); durations come from job_attempts — the spec says "where available" — costs nothing.
- Ruling: no mockup for 22.5 (copy and state changes inside existing panels, no new layout); Avi sees screenshots at completion — costs a copy revision if Avi disagrees.
- Ruling: the restore check targets a separate database `cloudiator_restore_check` inside the local Cloudiator container (label verified), not a new container — no image download, roles already exist; platform-owned objects that cannot exist outside `postgres` may be excluded only by a documented list — costs a less faithful restore than a fresh hosted project (Task 24 repeats it on the host).
- Ruling: the expire_listings backstop inside cleanup may take a seller account lock by try-lock only (never waits, runs last) — Decision 4's intent is that cleanup never waits on account locks — costs a skipped seller until the next run.
- Ruling (carried to 22.2): until 22.2's per-seller subtransactions land, one inconsistent open listing fails the whole cleanup call; 22.2 must make the backstop inside cleanup benefit from the per-seller isolation too — costs failed hourly cleanups only before 22.2.
- Ruling (carried to 22.3): health adds an alert for repeated cleanup failures (e.g. the last 3 cleanup events failed), since cleanup yields after 500 ms when a boundary holds the revision row — costs nothing.
- Ruling: "nothing at or above P−19" in the brief's recovery wording is tested as "nothing above P−19", matching Decision 2 (slots ≤ P−19 are prunable) — costs nothing.
- Ruling (carried to 22.3): cron_tick's expiry block still records no event on a whole-sweep failure — 22.3 adds a market-sweep event there and the health alert covers it — costs one unrecorded failure mode until then.
- Ruling: boundary waiting time is measured from opened_at_ms (advance_boundary refreshes updated_at_ms on every attempt, so it cannot measure the wait); overdue jobs include leases expired over 10 minutes ago — costs nothing.
- Ruling: run 22.5 in parallel with 22.4 in the separate worktree C:\Avi\Studies\Projects\Cloudiator-replay on branch claude/task-22-client from 074dcf3 (own .next, Playwright port 3300 via pw-replay.config.mjs; no DB or Edge needed); 22.4 stays in Cloudiator-claude (scripts/docs/.gitignore, disjoint files). After both are reviewed, cherry-pick 22.5's commits onto claude/task-22 and rerun the full gate there before the final whole-branch review — costs a rebase step; conflicts unlikely (disjoint files).
- Ruling: start Task 23's read-only survey and plan drafting in parallel (no edits) so Task 23 can begin as soon as Task 22 is pushed — costs a plan revision if Task 22's final review changes anything Task 23 relies on.
- Ruling: the export leaves out Auth session and refresh-token rows — a backup should not carry live sessions; after a restore every player signs in again — costs one re-login per player after a disaster restore.
- Ruling (carried to Task 24): the remote export path is untested beyond connection (hosted pg_dump permissions, IPv6-only direct hosts) — Task 24 runs it against the hosted project — costs a Task 24 fix if hosted permissions differ.
- Ruling: I1 is fixed, not waived — the resume check adds behavioural guard probes on the restored rows in rolled-back savepoints (re-insert a settled_slots row of the last published slot → unique_violation; delete a settled_slots row and an operation_receipts row → refused by their guards; counts unchanged) and the runbook/report stop claiming a real replay — the plan's "replay the last published boundary" wording was my error — costs one fix round.
- Ruling: a replay link to an activity deleted after 90 days reads "not available yet" (activity ids carry no date) — rare, and the 90-day summary is gone too — costs a slightly misleading message on very old links; final review may adjust wording.
- Ruling: final fix wave = Important 1 (runbook post-restore step uses vault.create_secret for game_worker_url and game_worker_secret; update_secret only for rotation; write the private env file from node, not shell redirection) + Minor 1 (inline CLOUDIATOR_DB_URL=… lines in migrations.md M16 notes and health.mjs:8) + Minor 2 (restore-compare git cwd = repo root) + Minor 3 (runbook restore-check failure codes and resume statuses; raw stderr warning; name auth password hashes and MFA secrets in backups). Everything else stays deferred per the final triage (Task 23 / Task 24) — costs only polish.
- Ruling: the product rule stands; the tests read within the retention window (server-clock stand-in under the stand-in restore rule, or equivalent), keep their unrevealed not-found meaning, and add one assertion that the same log is not-found after the window. Folded into the final fix wave — costs one test change.
