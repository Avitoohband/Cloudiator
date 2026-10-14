# Task 19 report: automatic league tournaments

Status: **DONE_WITH_CONCERNS**. All three phases are implemented and verified locally. Phase 1 (pure domain) and phase 2a
(entry, brackets, bout jobs) passed independent review. Phase 2b (results, reveals, settlement, the public view, the Task 20
update and the Task 16 lock fix) is complete and awaits its independent review. The concerns are under
[Concerns](#concerns): chiefly a pre-existing coordinator race now observed in the timing test, and the egress cost of the
public view.

| Phase | Scope | Commits | Review |
| --- | --- | --- | --- |
| 1 | Pure domain: `isTournamentSlot`, `partitionTournament`, `buildBracket`, `readyBouts`, `runBout`, `recordBout`, ratings, placements, outcomes | `abf7cb9`, report `ef73c82`, review fixes `98aeb07`, `d317f14`, `b42097e` | Spec Pass, quality Pass ([review](task-19-phase-1-review.md)) |
| 2a | Opt-in command, the partition inside Task 16's pairing job, bracket acceptance, one-way seeds, bout jobs, M11 | `81dc36b`, report `f9e3d97`, review corrections `a9f25d3` | Spec Pass, quality Pass (recorded in the [2b dispatch](task-19-phase-2b-dispatch.md)) |
| 2b | Result fence, reveals and stages, settlement with placements, `TournamentView`, live read, Task 20 update, Task 16 phase-8 lock fix, M12 | **`505b2b3`** `feat: run automatic league tournaments` | Pending |

- Date: 2026-10-14. Worktree `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-19-p2`.
- Phase 2b base: **`a9f25d3`**; branch start `2025dc6` (the controller brief).
- Migrations: M11 `supabase/migrations/20261014160257_tournaments.sql` (2a) and M12
  **`supabase/migrations/20261014174629_tournament_results.sql`** (2b). M01–M11 are unchanged. **M11 and M12 ship together.**
- Not done, by instruction: no push or merge, no `HANDOFF.md` edit, no subagents, no downloads. No other checkout was opened,
  no hosted project was touched, and no key, credential or status output was printed. CLI, reset, test, mutation and browser
  output is in ignored `.task19-2b-*.log` files.

## Phases 1 and 2a (summary)

The [phase 1 report](task-19-phase-1-report.md) and the [phase 2a report](task-19-phase-2a-report.md) hold the full
interfaces, decisions and evidence.
- **Phase 1** added `supabase/functions/_shared/domain/tournament.ts` (166 unit cases): Wednesday and Saturday 17:20 UTC by
  UTC arithmetic; eligibility at the cutoff (opt-in before it, Arena scheduled, stamina for both costs); seeded
  single-elimination brackets with byes at the top ranks in standard positions and no NPC; reveal times
  `start + ceil(80 min × r / (R + 1))`; the full log fence (`recordBout`); round-ordered Elo; placement grants and per-entrant
  outcomes in which a bye is never a win.
- **Phase 2a** added `supabase/sql/09-tournaments.sql` and M11: `set_tournament_opt_in` with the planning lock order and the
  processing gate; the partition inside Task 16's per-league pairing job; strict acceptance of the TypeScript-built bracket
  against frozen values; a one-way placement seed and one-way per-bout seeds; one simulation job per fought bout anchored to
  the rank-1 entry, with parent dependencies, and a fenced read of the stored graph and frozen names.

## Phase 2b: what changed

| Path | Change |
| --- | --- |
| `supabase/sql/10-tournament-results.sql` | New reapplicable source; its header lists ten accepted exceptions. |
| `supabase/migrations/20261014174629_tournament_results.sql` | M12, CLI-generated and completed (see "Migration"). |
| `supabase/sql/08-arena-bouts.sql`, `09-tournaments.sql` | Header comments only: 08 exception 3 corrected (the deadlock), 09 exception 9 completed (2a review M3) and the phase 2a limit marked lifted. No SQL object changes. |
| `supabase/functions/_shared/backend/jobs.ts` | The final bout's result carries every entrant's `tournamentOutcomes`; `TournamentBoutResult.outcomes?`. |
| `supabase/functions/_shared/contracts/reads.ts` | `TournamentBracket`, `TournamentPlacement`; `TournamentView.bracket` and role-safe `placements`. |
| `src/lib/api/reads.ts`, `gateway.ts` | `readTournament`, `tournamentLookupId`; the live `tournament(id)` read; `set-tournament-opt-in` in the live command whitelist. |
| `src/game/tournament-stage.ts` | Round one from the seeded slots (byes from the start, published round-one results must be the seeded pair, malformed brackets fail closed); `viewer.placement` is `{place, activityId}`; `tournamentIdFor` uses the reads layer's lookup id. |
| `src/features/tournaments/TournamentPanel.tsx`, `tournament-text.ts` | The viewer's credited rewards come from its own timeline; the "pairings are revealed with the round" note is gone; a bye receiver is told its first bout is in round 2. |
| `src/lib/api/fixture-gateway.ts` | Serves the fixture owner's settled tournament timelines. |
| `tests/fixtures/tournament-build.ts`, `tournaments.ts`, `tournaments/*.json` | The fixture views in the new shape (bracket, completions, byes from the start); `ownerTimeline`; new `owner-timelines.json`. |
| `tests/db/tournaments.test.ts` | 18 new DB cases, two 2a cases updated (dependencies, acceptance), the timing case now runs the whole slot. |
| `tests/db/arena.test.ts` | The Task 16 deadlock regression. |
| `tests/backend/worker.test.ts`, `tests/reads.test.ts`, `tests/api/*.ts`, `tests/domain/tournament-*.test.ts`, `tests/browser/tournament.spec.ts` | Unit, fixture, panel and browser cases for the above. |
| `docs/operations/migrations.md` | M12 entry, release and retention notes. |

## Interfaces (phase 2b)

### SQL (all `SECURITY INVOKER`, empty `search_path`, backend-only execution)

| Object | Contract |
| --- | --- |
| `private.boundary_start(bigint)` | Phase 8, unchanged except that every preparing member's account lock is taken, in gladiator order, before any debit or job insert (exception 1). |
| `private.prepare_activity_jobs(uuid)` | Tournament branch: rank 1's call creates every fought bout's simulation job (2a) and its reveal job `tournament-reveal:<boutId>` (anchored to rank 1, its activity seed, due at the bout's stored reveal time, depending on the bout's job and its fought parents' reveal jobs). Each settlement depends on the final's bout and reveal jobs, added from both sides. Each entrant gets its staging stage (ordinal 0) from S until its first fought round's reveal. |
| `private.accept_job_result(uuid, jsonb)` | Dispatches tournament jobs (anchored to the rank-1 tournament activity) to `accept_tournament_result`; Arena and Expedition unchanged. |
| `private.accept_tournament_result(uuid, jsonb)` | Re-locks the job, samples time after the lock, re-checks status, expiry, due time and dependencies. Simulation: the exact result shape (`{boutId, log}`, the final `{boutId, log, outcomes}`), the sanitized log against the frozen entries (exception 2), then a compare-and-set of the bout row and, for the final, the frozen outcomes. Reveal: both entrants' bout stages (ordinal = round) and the public result. |
| `private.valid_tournament_outcomes(...)` | The final's outcomes against storage (exception 2); no write. |
| `private.tournament_settlement_failure(uuid)` | Null, `rating-mismatch`, `tournament-unsettled` or `tournament-unbracketed`; only this entrant's frozen rating against its own live row. |
| `private.tournament_rewards(uuid)` | This entrant's credit from its frozen outcome: its rating row and human counters, the rating cache, placement money and fight plus placement renown, the return stage (ordinal rounds + 1) and its public placement row; returns the outcome with its placement grant. |
| `private.settle_rewards(uuid)`, `private.settle_activity_core(uuid, uuid, jsonb)` | The tournament kind: its own rating row locked as a dependent row, the fail-closed check, and the receipt whose request carries `grantId` (exception 7); one ledger row (`reason 'tournament'`). |
| `private.publish_tournaments(bigint)`, `private.boundary_published(bigint)` | Task 10's phase-8 hook now publishes the slot's public tournament rows (exception 8). |
| `private.tournament_results` | One row per tournament: the final's job and every entrant's outcome in rank order; `guard_frozen`, backend only. |
| `public.tournament_views` | One row per league and tournament slot: id, slot, times, status (`active` or `insufficient-entrants`), entrants (frozen names, classes), `bracket {size, rounds, slots}`, bout shapes, reveal times; references its pairing job; authenticated read. |
| `public.tournament_bout_results` | One row per due result (`{participants, winnerId, bye, battleLog?}`); RLS checks database time on every read. |
| `public.tournament_placements` | One row per settled entrant: tournament, gladiator, activity, place; authenticated read. |

All four tables have RLS, `guard_frozen` and no client mutation; the three public ones bump the world revision through
Task 10's deferred `projection_changed`.

### TypeScript

- **`simulateTournamentBoutV1`**: unchanged for earlier bouts (`{boutId, log}`). The final, which completes the graph,
  returns `{boutId, log, outcomes: tournamentOutcomes(recordBout(graph, boutId, log))}`.
- **`readTournament(client, id)`** (reads layer): rejects a malformed id before any query (`not-found`); reads the view row,
  the due results (also filtered by the sampled server time) in pages of 50 by ordinal, and, once every entrant has a
  placement row, their public completions from `recent_results` in chunks of 50. Entrants are sorted by name, placements by
  place then gladiator id. Status: `insufficient-entrants`; `completed` with placements; `processing` after minute 80 or
  while a due result is missing; otherwise `active`.
- **`tournamentLookupId(slot, league)`** = `tournament:<slot>:<league>`; the stage core's `tournamentIdFor` delegates to it.
- **Live gateway**: `tournament(id)` reads through the account-guarded Data API; `set-tournament-opt-in` is forwarded to the
  command endpoint like the other commands (the 2a backend already handled it).

### Contract changes (Claude owns the contracts)

```ts
export type TournamentBracket = { size: number; rounds: number; slots: (GladiatorId | null)[] };
export type TournamentPlacement = { gladiatorId: GladiatorId; place: number; completion: PublicActivitySummary };
export type TournamentView = { /* … */ bracket: TournamentBracket | null; /* … */ placements: TournamentPlacement[] };
```

- `slots` has `size` seats in bracket order; round-one bout p seats `slots[2p]` against `slots[2p + 1]`; `null` is an empty
  seat, a bye for the other. Public from the start, with no result. `null` for a scheduled view and a league below the
  minimum.
- `placements` carry the public place and Task 10's six safe completion fields only; empty until every entrant has settled.
  The owner's rewards come only from its own timeline `summary`, under RLS. `ActivitySummary` is no longer imported by
  `contracts/reads.ts`.

## Decisions

1. **Settlement route: stored outcomes (Task 16's route).** The final's bout executor computes every entrant's outcome from
   the graph it completes; acceptance checks and freezes them once with the final's result; each entrant settles from its
   own. No prepared-settlement RPC is needed, and `createWorkerDatabase.settle` is unchanged.
2. **Reveal shape (open from the phase 1 review): one reveal job per fought bout, created in rank 1's call.** It depends on
   its bout's job and its fought parents' reveal jobs, and writes both entrants' stages and the public result. An
   eliminated entrant gets no stage after its losing bout until its minute-80 return; a bye receiver gets none for its bye
   and stays in staging until its round-2 bout. This needs 49 reveal jobs for 50 entrants instead of about 286 per-entrant
   ones, and no reveal is a no-op. Its stage writes touch two activities; the lock analysis is header exception 4.
3. **Settlement depends on the final's bout job and the final's reveal job.** The dispatch's "the final's bout job only"
   replaces the n² rows; the final reveal is added so that no credit, return stage or placement can precede the last
   published bout (both are ancestors of everything else, so the gating stays exact). 2 rows per entrant.
4. **Byes are public from the start.** The seeded slots already show them, so their public results are due at S rather than
   at round 1's reveal, and the stage core shows a bye's advance from the start (the fixtures follow).
5. **Stages:** staging (ordinal 0, `Tournament staging`), each fought bout at its round (`Quarterfinal: victory`, `Final:
   defeat`, `Round r: …`), and `Results credited` at ordinal rounds + 1, written by the crediting settlement as Task 16 does.
6. **Insufficient entrants** get a public row for every league with a pairing job on a tournament slot and no bracket; its
   entrants are the `too-few-entrants` qualifiers (possibly none). SQL knows a tournament slot without restating the days
   (exception 8). A league with no Arena entrant has no pairing job and no row; the live panel then says no tournament
   matches.
7. **Grant identity** `<tournamentId>:placement:<gladiatorId>` is kept in the request of the activity's single settlement
   receipt; one ledger row combines placement money with fight and placement renown; `settled_slots` stays the only guard.
8. **Live opt-in command.** Added to the live gateway's whitelist so that Task 20's toggle works live; the backend has handled
   it since 2a. It is outside the dispatch's literal list, so it is called out here.

## The Task 16 deadlock (2a review I1)

- **Defect.** Phase 8 walks members in gladiator order. When the lower-id member is an Arena side 1, its call creates the
  battle's job anchored to side 0, whose foreign keys take KEY SHARE locks on side 0's gladiator and activity rows before the
  boundary holds side 0's account lock. An owner command of side 0 that holds that lock and then asks for its gladiator row
  `FOR UPDATE` deadlocks with it.
- **Regression** (`tests/db/arena.test.ts`, "takes every member's account lock before phase 8 anchors a battle job to side
  0…"): two entrants, the higher id with the stronger build, so it is side 0 (asserted); session B takes side 0's account
  lock; session A calls `advance_boundary` and is shown blocked by B (`pg_blocking_pids`); B sets `lock_timeout='3s'` and
  selects side 0's gladiator row `FOR UPDATE`; then B commits and A must complete phase 9.
- **RED** (before the fix): `PostgresError: deadlock detected`, code **40P01**, "waits for ExclusiveLock on advisory lock",
  raised in `advance_boundary`. **GREEN** after the fix, and again in every later DB run.
- **Fix:** `private.boundary_start` takes every preparing member's account lock, in gladiator order, before the debit loop.
  The order is unchanged; only the timing moved. Mutation M16 (the lock loop removed) brings the 40P01 back.
- Headers: 08 exception 3 now records the defect and the fix; 10 exception 1 documents the fix; 09 exception 9 covers the
  entry foreign keys' KEY SHARE on entrants' gladiator rows during `complete_job` and why no cycle exists (2a review M3).

## RED and GREEN (phase 2b)

| Cycle | RED (observed) | GREEN |
| --- | --- | --- |
| Deadlock | 40P01 as above (Edge stable). | 1/1, then in every suite run. |
| Worker unit | `completes the final with every entrant's outcome…`: the result had no `outcomes`. | 43/43 |
| DB (new and updated tournament cases) | 17 failed / 1 passed: completions answered `invalid` (no tournament acceptance), `readTournament is not a function`, no reveal jobs, the crash case resolved `invalid` instead of throwing. The one pass was the `complete_job` lease regression, already met by the inherited `complete_job` fence, which locks the job row and samples time after it before reaching the new branch (the new settlement lock's meaningful RED is mutation M14). **The Edge container was recreated during that run**; none of these cases uses Edge, but under the database-test rule the run is reported, not counted. | The first implementation run failed 15 cases on `column reference "result" is ambiguous` (a parameter named like the bout column); qualifying the column gave 18/18 with Edge stable. |
| Reads and gateway units | `readTournament` / `tournamentLookupId is not a function`; the live tournament read and the opt-in command answered `unavailable`. | 27/27 |
| Fixtures | 4 failed: reward keys in the views, no `bracket`, no `completion`, no `ownerTimeline`. | Regenerated with `UPDATE_TOURNAMENT_FIXTURES=1`; 17/17. |
| Stage core | 6 failed: no seeded sides, byes only at round 1, `viewer.placement.summary`, no fail-closed bracket check. | 21/21 |
| Panel | 3 failed: no bye-receiver text, `summary` undefined in the placement line. | 14/14 |
| Fixture gateway | The owner's tournament timeline was unavailable. | 12/12 |

### Mutations (SQL)

Each mutation was applied to the verified local container as a modified copy of `10-tournament-results.sql`, its owning test
was run, and the original source was reapplied; an md5 over every public and private function definition matched the
baseline after each one, and the Edge start time was unchanged in every run. **16 of 16 were caught.** The runner is a
scratch file.

| # | Mutation | Owning test failed with |
| --- | --- | --- |
| M1 | Acceptance skips the frozen armor | "an altered armor" accepted |
| M2 | Acceptance skips the frozen name | "the live name after a rename" accepted |
| M3 | Later-round sides taken from the log, not the parents' stored winners | "swapped participants" accepted |
| M4 | Outcome bouts not checked against the stored results | "a bye counted as a win" accepted |
| M5 | Renown not checked as fight plus placement renown | that forged outcome accepted |
| M6 | Grant identity not checked | "a grant for another entrant" accepted |
| M7 | A bye counted as a win in the counters | the canonical final refused |
| M8 | Reveal jobs due at the start | a reveal claimable before its time |
| M9 | Stage label from participant 0 | a wrong perspective label |
| M10 | A public result written at acceptance | a fought result visible before its reveal |
| M11 | Settlement without the final reveal dependency | the dependency table |
| M12 | Settlement also checks other entrants' live rows | the second entrant went to `operator` |
| M13 | Settlement skips the rating check | the drifted entrant settled |
| M14 | Settlement samples time before the tournament rating-row lock | an expired lease settled after the proven wait (the concurrency override's meaningful RED for the new lock) |
| M15 | No insufficient-entrants row | `not-found` |
| M16 | Phase 8 without the account locks first | 40P01 |

## Tests (phase 2b)

`tests/db/tournaments.test.ts` (slot 301 is Saturday 1970-01-17 17:20 UTC):
- **Bracket runs, 0, 1, 2, 3, 5 and 50 qualifying entrants**, each end to end through real SQL and jobs (preparation,
  partition, bracket, every bout through the canonical executor and its fenced read, every reveal, every settlement through
  the real worker adapter): one activity charged once per entrant (stamina 79); full health in every bout; one success;
  each summary, rating row and counter equal to the domain's round-ordered outcome from the stored graph; byes with no
  renown or rating; n − 1 rated bouts (2(n − 1) counters); wallets and the one `tournament` ledger row equal to 10 per win,
  2 per loss plus the spec's placement bonus (100/50, 60/30, 30/15, 0/5) by the round each entrant lost in; placement counts
  {winner, runner-up} for 2, plus one semifinal for 3, two semifinals and one other for 5, and 2/46 for 50; the receipt's
  `grantId`; the signed-in public read in pages (63 results and 50 placements for 50). Below 2: regular Arena and the
  `insufficient-entrants` row with its qualifiers.
- **Reveals**, in a rollback-only transaction with the database clock: staging only at S (ending at round 1 or, after a bye,
  round 2); bye results due at S; at each round's reveal − 1 ms no reveal or settlement is claimable; at the reveal exactly
  that round's reveal jobs, then both entrants' stages at the stored time with the shared log and their own labels, and
  the public result; eliminated entrants and byes get no extra stage; at minute 79 nothing is credited; at minute 80 every
  entrant's credit and return stage.
- **Public view**: the seeded first round at the start with no fought result; nothing fought public after simulation alone;
  every result after the reveals; no placement while any entrant is unsettled; then placements with public completions only;
  spectators and other entrants see no rewards, receipts, ratings, seeds, ranks, snapshots or grants; the owner reads its
  rewards from its own timeline; unknown or malformed ids are `not-found`; anonymous reads fail.
- **Forged results**, 19 for a round-one bout (shape, battle, rules, malformed log, swapped or relabelled participants,
  altered fighter, injured start, armor, class, silhouettes, the live name after a mid-tournament rename, a winner outside
  the bout or against its victory event, outcomes on an earlier bout), the first round's loser in a later round, and 21
  forged final outcomes: each refused as `invalid` with nothing written. The canonical result is stored once, replays and is
  immutable; the final's outcomes are frozen once.
- **Failures**: an injected write failure rolls a completion back whole; a stalled child holds the final, its reveal, every
  settlement and the next boundary (`settlement`); its expired lease is reclaimed with the same seed and input and
  reproduces the same bout; the dead worker's late completion is a conflict; the slot then settles and the next boundary
  moves on.
- **Settlement**: in rank order, each entrant moves only its own row while every later row still holds its frozen rating, and
  lost responses replay; nine simultaneous calls for three entrants grant once each; a frozen/live mismatch goes to
  `operator` (`rating-mismatch`) with nothing credited while the others settle, the next boundary waits on `operator`, and the
  repaired, resumed job settles; a malformed settlement hook rolls back every write (rating rows, wallets, ledger, return
  stages, placements, checkpoints).
- **Lease regressions** (AGENTS.md): `complete_job` on a bout job (job row held) and `settle_activity` on an entrant (job row
  held, rating row held) block while the lease is valid, resume after database expiry and answer `conflict` with no write.
- **Access denial**: `private.tournament_results` has RLS and no client privilege; the three public tables have RLS,
  authenticated read only, no anonymous access and no client mutation; all eleven new or changed functions are backend-only
  and not `SECURITY DEFINER`; no stored outcome, seed, rank, snapshot, rating pair or grant reaches any client read.
- **Timing**: below.

`tests/db/arena.test.ts`: the deadlock regression. Unit, fixture, panel and browser cases are listed in the RED/GREEN table;
the browser spec now checks the seeded round-one pairs at the start.

## Timing (50 entrants, one-minute cron cadence)

Method (as Task 16 and 2a): the real `private.cron_tick()`, the real private Edge worker through pg_net and a test-only
database clock, restored and verified. P is a cold regular Arena slot run to its minute-60 reveals; T = P + 1 is the next real
Wednesday or Saturday 17:20 UTC slot (373387) in steady state, now ticked through every round to its minute-80 credit. Run 1
ticks T exactly 60 000 ms apart (window cleared), run 2 59 999 ms apart (window held). All times are from T's cutoff, on the
local stack (not hosted evidence, Task 23). Nine measured runs, each with the Edge start time unchanged:

| | Window cleared | Window held |
| --- | --- | --- |
| P settled | 1.05–1.15 s | 1.09–1.13 s |
| Preparations done | 61.01–61.06 s | 120.94–120.99 s |
| Published | **61.08–61.12 s** in 5 runs; **120.93–120.98 s** in 4 runs (the race below) | **120.99–121.05 s** |
| Credited (all 50) | 4 800.96–4 801.06 s (minute 80 + about 1 s) | 4 860.90–4 860.98 s (the tick before minute 80 fell 80 ms early) |

Every round is simulated long before it is due, and each reveal lands on the first tick after its time:

| Round | Fought bouts | Reveal at | Last bout simulated (all 18 run cases) | Smallest margin before reveal | Reveal lag |
| --- | --- | --- | --- | --- | --- |
| 1 | 18 | 685.7 s | 121.0–181.1 s | 504.6 s | 35.2–35.3 s |
| 2 | 16 | 1 371.4 s | 181.1–301.1 s | 1 070.3 s | 9.5–9.6 s |
| 3 | 8 | 2 057.1 s | 241.1–361.1 s | 1 696.1 s | 43.7–43.8 s |
| 4 | 4 | 2 742.9 s | 301.0–421.1 s | 2 321.8 s | 18.0–18.1 s |
| 5 | 2 | 3 428.6 s | 361.0–481.1 s | 2 947.5 s | 52.2–52.4 s |
| 6 | 1 | 4 114.3 s | 420.9–541.0 s | 3 573.3 s | 26.5–26.6 s |

The reveal lag is the cron cadence: a round is published by the first tick at or after its reveal time.

- A tick simulates at most one round (each round waits for its parents), at most 25 bouts; when the rolling window still
  counts the previous tick, a round can take two ticks.
- Dispatch per run: settlement 10/20/20; preparation 10/20/20 (held: 20/20, then 10 with the pairing job); simulations over
  six or seven ticks; one reveal invocation per round (18, 16, 8, 4, 2, 1 jobs); settlement 10/20/20 at minute 80. 49 bout
  jobs, 49 reveal jobs and 245 dependency rows (48 parent bouts, 49 reveals on their bouts, 48 reveals on their parents'
  reveals, 2 per settlement), against 2 498 in 2a.
- Every invocation answered HTTP 200 with no failure, conflict, unrecorded failure or deferral.
- **The cleared-window race (observed, pre-existing).** In 4 of the 9 runs the pairing job was not claimed at the 60 s tick.
  The three preparation invocations reported their final coordinations as `phase 4 preparation`, `busy`, `phase 4
  preparation`: the invocation that completed the last preparation found the coordinator busy with another invocation's
  coordination, which had itself still seen a preparation unfinished, so no invocation saw the released pairing job and the
  slot published at the next tick. This is the "coordinator busy race" Task 16 recorded as not observed; it is independent
  of this phase's changes (the coordination and worker paths are untouched). The test now tells the two cases apart from the
  reported coordinations and holds the uncontended case to 120 s. No fix is applied here (see Concerns).
- The held window misses 120 s by about 1 s, as Task 16 recorded (the settlement barrier; a Task 23 policy decision).

## Migration

- **Iteration.** `10-tournament-results.sql` was applied with the documented `docker exec -i supabase_db_Cloudiator psql`
  fallback (the container's `com.supabase.cli.project` label checked), from a Node script that pipes the exact CRLF bytes.
  Lint was empty; advisors showed four INFO unused-index notices, none on the new tables.
- **Generation.** `npx supabase db pull tournament_results --local --schema public,private --yes` (CLI 2.120.0, engine `migra`)
  wrote `20261014174629_tournament_results.sql` on the first attempt: 5 new and 6 changed functions, four tables, policies and
  triggers; it re-emits no unchanged function.
- **Completion** (AGENTS.md), normalized to CRLF like the other migrations: source-equivalent revokes before the generated
  grants of all four tables; the source's function revoke/grant pair; a provenance header and `notify pgrst`. No backfill or
  initialization: the tables are new and no tournament exists before M11 and M12 ship.
- **Replay.** `npx supabase db reset --local --no-seed --yes` replayed M01–M12 with no source applied afterwards.
- **Comparison.** The sanitized schema fingerprint (863 lines: function definition hashes, search paths, security, volatility
  and ACLs; relation ACLs, RLS, options and view definitions; policies, triggers, constraints, columns, indexes, the cron job
  and seed rows) matched the tested source exactly, and was identical again after the tests.
- **Tests on the replay:** `npm run test:db` **170/170** in eight files, Edge start time unchanged. Lint empty; advisors (after
  that run) four INFO unused-index notices, none on the new tables; `migration list --local` shows M01–M12.

## Final commands (in `verification-gates.md` order)

| Command | Result |
| --- | --- |
| `npm test` | **904 passed**, 36 files (896 + 8). |
| `npm run typecheck` | Exit 0: `tsc` clean, frozen Deno check of `game-command` and `game-worker`, 2 Deno runtime tests passed. |
| `npm run test:db` | **170/170** in eight files (151 + 19), Edge start time unchanged across the run (also 170/170 on the first replay run). |
| `node assets/source/build-assets.mjs --check` | Up to date (28 files). |
| `npm run build`, then `npm run verify:static` | 5 fixed routes, **90 assets** (91 at 2a; the export's chunking changed, which was not investigated further), no forbidden backend material. `out/` contains no engine, fixture-season, fixture-slot, owner-timeline or receipt-seed strings. |
| `npx playwright test -c node_modules/.cache/pw-claude.config.mjs` (port 3200) | **260 passed, 8 skipped** (4.2 min). No dev server was left on 3200. |
| Isolated production gate (`CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build`, `npm run verify:static -- .next/browser-test`, `PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test` with the private config) | Build and scan clean; **14 passed, 254 skipped** by design. |
| `git diff --check`, `git diff --cached --check` | Clean. |

## Gates for later tasks

- **Task 21 (seasons):** tournament bouts now move the league-season rating rows and human counters, round-ordered, and count
  toward the five-human-bout rule; season close must run after a tournament slot's settlements (phase 1 already waits for
  them). Season identity is `private.season_index`, as Task 16 left it.
- **Task 22 (retention):** prune `public.tournament_bout_results` and `public.tournament_placements` before their
  `public.tournament_views` row, that row before its pairing job, `private.tournament_results` before its tournament and its
  final bout job, placements before their activities, and (2a) bout rows and entries before their tournament. Logs in
  stages and public results follow the seven-day replay rule; an expired tournament log needs Task 20's "replay no longer
  retained" note.
- **Task 23 (load):**
  - the cleared-window coordinator race (above) and the held-window 121 s, both at 50 characters;
  - the public view's egress: every read carries every revealed log (about 10 KB each in the fixtures), so a 50-entrant view
    near the end is roughly half a megabyte, and the panel re-reads at each reveal mark and every 30 s while processing.
    Measure against the 3 GB monthly budget; mitigations include reading only results newer than the last ordinal, or logs
    on demand;
  - one tick simulates one round; brackets above 64 entrants need more ticks per round (still far ahead of the reveals here).
- **Task 24 (deployment):** ship M11, M12 and the worker in one release step; then check that no `prepare`, `pair`,
  `simulation`, `reveal` or `settlement` job is in operator state. Set the season epoch as Task 16 recorded.
- **Task 13:** the panel and the camp each read tournaments; a live world needs the camp outside fixture mode.
- **Carried from Task 20's review:** move `isTournamentSlot` into an engine-free module (not in this dispatch).

## Concerns

- **Coordinator busy race (pre-existing, now observed).** Publication of a steady-state 50-entrant slot in the cleared window
  took about 121 s in 4 of 9 runs instead of about 61 s. Proposed fix, for the controller and Task 23 (not applied, not
  tested): when `runWorker`'s coordination after its simple loop answers `busy`, retry the coordination a bounded number of
  times after a short pause before deciding whether pairing was released.
- **Egress of the public view** (Task 23 above).
- **RED evidence caveat.** The first 2b DB RED run saw an Edge recreation; its failures were all non-Edge database cases and
  are reported, not counted. The meaningful RED for the new SQL is the 16 mutations, each run with the Edge start time
  unchanged.
- **Reveal jobs write two activities' stages** (header exception 4): a new pattern beside Task 16's one-stage-per-side
  reveals; the no-cycle argument is documented.
- **Choices beyond the literal dispatch** (decisions 3, 4 and 8): the final-reveal settlement dependency, byes public from
  the start, and the live opt-in command.
- **Environment:** the Edge container was recreated between DB runs after host reads (`typecheck`), never during a counted run.
  Bash heredocs in this session altered backslashes, so scripted edits used Node files or the editor. No package or tool was
  downloaded.

## Skill upkeep

No new skill change is proposed: the TDD, verification, migration and concurrency guidance covered this work. The phase 2a
proposal (restore a test-only stand-in from its captured `pg_get_functiondef` text) still awaits Avi; this phase followed that
practice (the tests restore from captured definitions, and the mutation runner reapplies the source and verifies an md5 of
every function definition).
