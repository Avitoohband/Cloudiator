# Task 19 phase 2a report: tournament entry, brackets inside the pairing job, seeds and bout jobs

Status: **DONE_WITH_CONCERNS**. Phase 2a is implemented and verified locally, as specified in
[task-19-phase-2a-dispatch.md](task-19-phase-2a-dispatch.md): items 1–7 of "Phase 2 must do" in the
[phase 1 report](task-19-phase-1-report.md). Bouts are created and can be claimed; phase 2a stops before bout results are
accepted, revealed or settled. An independent review is still to come.

The concerns:
- **Phase 2a must not ship alone.** A claimed bout job cannot complete yet (no tournament acceptance), so the real worker
  fails it into operator state, and the boundary after a tournament slot waits. M11 ships with phase 2b.
- **SQL trusts the seeded ranks.** Acceptance checks the whole bracket frame given its ranks; the ranks themselves are the
  canonical TypeScript's seeded decision, as Task 16 trusts `matchArena`'s pairs (header exception 5).
- **A derived, untested Task 16 lock-order risk** (under "Concerns"), which this phase's bout jobs avoid by construction.

- Date: 2026-10-14. Worktree `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-19-p2`.
- Base: **`95a48f6`** (pushed). Branch start: `3cef588`, the controller brief.
- Source commit: **`81dc36b`**, `feat: enter league tournaments and schedule their bouts`, with the migration.
- New migration M11: **`supabase/migrations/20261014160257_tournaments.sql`**. M01–M10 are unchanged.
- Not done, by instruction: no push or merge, no `HANDOFF.md` edit, no subagents, no downloads. No other checkout was opened
  and no hosted project was touched. No key, credential or status output was printed; CLI, reset, test and browser output is
  in ignored `.task19-2a-*.log` files.

## Files

| Path | Change |
| --- | --- |
| `supabase/sql/09-tournaments.sql` | New reapplicable source. Its header lists ten accepted exceptions and the phase 2a limit. |
| `supabase/migrations/20261014160257_tournaments.sql` | M11, CLI-generated and completed (see "Migration"). |
| `supabase/functions/_shared/backend/jobs.ts` | `PairingInput.tournament`, `PairingCandidate`, `PairingResult.tournament`; the partition inside `pairArenaV1`; `TournamentBoutInput`, `TournamentBoutResult`, `simulateTournamentBoutV1`; the `tournament-bout` branch of `v1.simulation`; executors receive an `ExecutorIo`. |
| `supabase/functions/_shared/backend/database.ts` | `setTournamentOptIn` (command port), `OptInCommand`, `OptInValue`; `WorkerDatabase.tournamentBoutInput`, `TournamentBoutRead`, `ExecutorIo`; `JobExecutor` takes an optional second argument. |
| `supabase/functions/_shared/backend/commands.ts` | Routes `set-tournament-opt-in` to its transaction. |
| `tests/db/tournaments.test.ts` | New. 14 DB cases. |
| `tests/backend/worker.test.ts` | 7 new unit cases; the in-memory port gains `tournamentBoutInput`. |
| `tests/backend/commands.test.ts` | 1 new unit case; the test dependencies gain `setTournamentOptIn`. |
| `tests/backend/edge.deno.ts` | The Deno smoke test's dependencies gain `setTournamentOptIn` (a compile fix, no behaviour change). |
| `docs/operations/migrations.md` | M11 entry, release and retention notes, the discarded first draft. |

`tournament.ts`, `arena.ts`, `combat.ts`, the contracts, the fixture gateway and the UI are unchanged.

## Interfaces

### TypeScript

- **`PairingInput.tournament`** (written for every slot since M11): `{bracketSeed, rested, candidates}`.
  - `bracketSeed` is the one-way placement seed, never the job seed.
  - `rested` holds the frozen entrants of the Arena requests that boundary step 6 replaced with Rest.
  - `candidates` has one `PairingCandidate` = `{gladiatorId, choice, stamina, costs: {arena, tournament}, optIn}` per entrant
    and per Rest fallback. `optIn` is `[{enabled, receivedAtMs: cutoff − 1}]`, the frozen phase-5 value.
- **`pairArenaV1(input, seed)`**:
  - Without `tournament` (an input frozen before M11): `matchArena` as before. On a tournament slot it fails closed
    (`invalid-input`), because a bracket would silently become regular Arena.
  - With it:
    1. every entrant and Rest fallback must be exactly one candidate;
    2. `partitionTournament(slotAt(S × slotMs), candidates)`;
    3. `buildBracket` under `bracketSeed` when the league has a bracket, then `readyBouts` on it (which runs `checkGraph`);
    4. `matchArena` once over `partition.arena` under the job seed.
  - Result: `{assignments, tournament: {routes, bracket | null}}`. A malformed input, a reused seed or more than one bracket
    league is `invalid-input`.
- **`simulateTournamentBoutV1(input, read, seed)`**, the `kind: 'tournament-bout'` branch of `v1.simulation`.
  - Input: `{kind, tournamentId, boutId}` only.
  - `read` is the fenced `public.tournament_bout_input` result.
  - Steps: rebuild the stored graph; `readyBouts` (its `checkGraph` refuses stub or altered stored logs); require the bout to be
    ready and both sides named; `runBout(job, seed, names)` with the lease's bout seed; `recordBout` (the full log fence);
    return `{boutId, log}`.
  - Fails closed: a bye, an unready, resolved or unknown bout, a refused read, another tournament or a missing name is
    `invalid-input`; another rules version is `unsupported-rules`.
- **`runWorker`** passes `{database}` to every executor as its second argument. The bout read happens inside the executor, so
  the compute-budget timer (a wall-clock measurement) includes that one round trip.
- **Command port:** `setTournamentOptIn(actor, command)` sends `{command}` to `set_tournament_opt_in`, with the operation id
  lower-cased as for every command. `OptInValue` = `{enabled, receivedAtMs}`.

### SQL (all `SECURITY INVOKER`, empty `search_path`, backend-only execution)

| Object | Contract |
| --- | --- |
| `public.set_tournament_opt_in(uuid, uuid, jsonb)` | `{command}` with exactly `kind`, `operationId`, `enabled`. Account advisory lock, receipt replay (a changed payload is `conflict`), validation, then the character row `for update` and post-lock time. `processing` (unrecorded) while `processed_slot_index < slot(now)`. Then it updates the flag and records a receipt; the value is `{enabled, receivedAtMs}`. `not-found` without a character. |
| `private.pairing_input(...)` | Task 16's input plus `tournament: {rested, candidates}` (exceptions 1 and 6), and human tournament bouts in `recent` (exception 7). |
| `private.boundary_pair(bigint)` | Generates each pairing job's seed itself and freezes `bracketSeed = sha256(<seed>:bracket)` into its input (exception 2). After every pairing job completed it adopts the brackets: entrants' activities become `tournament`, charged at the frozen `costs.tournament` (exception 8). |
| `private.accept_pairing(uuid, jsonb)` | For a partitioned input, every Arena request of the league is routed exactly once. A `rest` route must be exactly a step 6 fallback, at no cost; a `tournament` route costs the frozen tournament price and a regular `arena` route the frozen Arena price. `valid_bracket` must pass; the assignments cover exactly the arena-routed entrants. Only then does it write the assignments, the tournament, its entries (with frozen names) and its bouts (with seeds). |
| `private.valid_bracket(uuid, jsonb, jsonb)` | The bracket frame given its ranks (exception 5): exact keys; size the next power of two (`n ≤ size < 2n`); entries in rank order, each a bracket entrant once with its frozen activity, rating and fighter; ids, battle ids, parents, standard seeding positions, byes and their results, reveal times `start + ceil(4 800 000 × r / (R + 1))`, and settlement at the slot end. No write. |
| `private.tournament_graph(text)` | The stored graph in the domain's `TournamentGraph` shape (entries by rank, bouts by round and position, every stored result), with no seed. |
| `public.tournament_bout_input(uuid, uuid)` | Locks the job row first, samples time after the lock, then checks the token, `leased` status and expiry (`conflict`), the job kind (`invalid`), due time and dependencies (`processing`). Returns `{ok, graph, names}`. |
| `private.activity_executor_ready(text)` | Adds `tournament`. |
| `private.prepare_activity_jobs(uuid)` | Tournament branch (exception 4). Inside the rank-1 entrant's own call it creates one simulation job `tournament-bout:<boutId>` per fought bout, in round order, anchored to that entrant. Each job carries the bout seed, the input `{kind, tournamentId, boutId}`, is due at S and depends on its fought parents' jobs. Each entrant's settlement job depends on every bout job. |
| `private.guard_tournament_bout()` | A bout's frame and seed never change; its result is written at most once, from null (exception 10). |
| `private.tournaments` | Primary key `tournament:<slot>:<league>`, unique pairing job (FK) and `(slot, league)`, season, rules version, start, settlement, size, rounds, reveal times; `guard_frozen`. |
| `private.tournament_entries` | `(tournament, gladiator)`, unique activity (FK) and `(tournament, rank)`, rating, frozen arena fighter, frozen display name; `guard_frozen`. |
| `private.tournament_bouts` | Bout id, tournament (FK), unique `(tournament, round, position)`, parents, round-1 placement, bye, reveal time, a one-way seed exactly when fought, and the result (set for byes at once). |

Claim and coordination accounting are Task 16's, unchanged. A bout job is a `simulation`: the combat batch limit stays 5,
dispatch counts it as combat work, and only an invocation that claimed no simple work claims it. A child cannot be claimed
or dispatched before its fought parents completed (`dependencies_ready`).

## Decisions

1. **The partition runs on every slot** (header exception 1). Every pairing input carries its league's candidates, and the
   canonical `partitionTournament` decides `tournamentSlot`. SQL therefore restates neither the tournament days nor the
   opt-in or eligibility rules. On a regular slot every route is `arena` (`not-tournament-slot`) or `rest`.
   Cost: about 150 bytes per candidate in each pairing input, and the routes in each result.
2. **Rest fallbacks are candidates.** The Arena requests that step 6 sent to Rest are passed (`rested`) so that the domain's
   Rest rule is checked against step 6's on real data: acceptance requires `rest` routes to be exactly the fallbacks, at
   no cost.
3. **The frame is checked in SQL, the ranks are not** (exception 5). The dispatch requires the graph to pass `checkGraph`
   at acceptance. Given the ranks, the frame has exactly one valid value, so SQL rederives and compares it, as Task 16
   checks battle ids. That restates the seeding order, the reveal arithmetic and `durationMs`. The seeded ranks are trusted,
   as Task 16 trusts `matchArena`'s pairs. The worker runs `checkGraph` before completing, and every bout executor runs it
   again on the stored graph. Each graph mutation in the acceptance test is also refused by the real `checkGraph`.
4. **Bout jobs are created inside the rank-1 entrant's own call** (exception 4). The jobs' foreign keys then lock only rows
   whose account lock phase 8 already holds. Settlement dependencies are added from both sides: rank 1 adds them for every
   entrant settlement created so far, and each later entrant adds its own.
5. **Bout results are written once into the bout row** (exception 10), as the phase 1 plan placed them. The guard leaves
   2b's compare-and-set as the only possible update, and a bye's result is stored at acceptance.
6. **Pairing history (dispatch decision 6) is extended now** (exception 7). Round-one pairs count from the stored placement
   as soon as the bracket exists, as regular assignments count at pairing. Later rounds count from the stored result,
   which 2b writes, so nothing more is needed there.
7. **Names** are frozen in `tournament_entries.name` at acceptance and returned by the fenced read (dispatch decision 7).
8. **The opt-in value** is `{enabled, receivedAtMs}`. The Task 20 panel ignores it and refreshes the owner state.
9. **Slot 0 cannot underflow:** `advance_boundary` refuses targets below 1, so `cutoff − 1` is never negative.

## RED and GREEN

| Cycle | RED (observed) | GREEN |
| --- | --- | --- |
| Units | `npx vitest run tests/backend/worker.test.ts tests/backend/commands.test.ts`: **8 failed / 41 passed of 49**. The opt-in answered 503 `unavailable`; the pairing executor returned the old `{assignments}` shape (`tournament` undefined) and threw on no candidate checks; every bout job failed with `unsupported-executor`. | 49/49 |
| DB | `npm run test:db -- tests/db/tournaments.test.ts` before any SQL: **14 failed of 14**, with `relation "private.tournaments" does not exist`, `function public.set_tournament_opt_in(...) does not exist`, and `Cannot read properties of undefined (reading 'bracketSeed')` (a pairing input without candidates). Edge stable. | After `09-tournaments.sql`: **14/14** on the first run, Edge stable; the full suite 151/151. |

**RED-run fault, now hardened.** In the RED run, the lock test awaited a signal its missing RPC never sent. It timed out
before its `finally`, so its test-only clock stand-in stayed installed. I found it and restored it (see "Migration").
The test now races the signal against the toggle transaction, installs the stand-in inside its `try`, and has a 60 s
timeout.

**Applying the source** took two corrections before any test ran:
- PL/pgSQL ends an `IF` condition at its first `THEN`, so two `CASE` expressions moved into variables.
- Lint found an integer `FOR` variable shadowing a declared one; it was renamed.

The costs case later gained a bracket entrant whose Arena cost (20) differs from its tournament cost (25). It passed on its
first run and gives mutation M12 something to fail on.

### Mutations

Each SQL mutation was applied to the verified local container as a modified copy of `09-tournaments.sql`. Its owning test
was run, then the original source was reapplied. An md5 over every public and private function definition matched the
baseline after each one (`restored: true` throughout). The runner is a scratch file.

| # | Mutation | Owning test failed with |
| --- | --- | --- |
| M1 | Rest route not tied to step 6 | "a Rest fallback routed to regular Arena" accepted |
| M2 | Seeding placement not checked | "swapped placement" accepted |
| M3 | Entry fighter not checked | "an altered fighter" accepted |
| M4 | Bracket seed = the job seed | the input's `bracketSeed` was not `sha256(seed:bracket)` |
| M5 | Bout seed without the bout id | the stored seed was not `sha256(seed:boutId)` |
| M6 | Bout jobs anchored to rank 2 | the anchor was not the rank-1 entry |
| M7 | No parent dependencies | `{}` instead of the 2:0 ← 1:1 and 3:0 ← 2:0, 2:1 dependencies |
| M8 | Bout read samples time before the job lock | the read answered `ok` after the proven wait and expiry (the concurrency override's RED) |
| M9 | Opt-in without the processing gate | the toggle at the cutoff was accepted |
| M10 | History without tournament bouts | `recent` was `[]` |
| M11 | Opt-in revision at the cutoff, not cutoff − 1 | no bracket at all |
| M12 | Adoption charges the Arena cost | debit 20 instead of 25 |
| M13 | Bracket route debit not checked | "an altered stamina debit" accepted |
| M14 | Route completeness not checked | first **survived**: the test's `routes.pop()` removed a bracket entrant, which other checks refuse. The test now omits a Rest route and an Arena route explicitly; then "an omitted Rest route" was accepted (caught). |
| M15 | Reveal times not checked | "a floored reveal time" accepted |
| M16 | Bye result not checked | "a bye won by another entrant" accepted |
| M17 | Entries not in rank order | "ranks out of order" accepted |
| M18 | Bout result rewritable | the second result write succeeded |

TypeScript mutations of `jobs.ts`, each against `tests/backend/worker.test.ts` and restored byte for byte:

| # | Mutation | Failed |
| --- | --- | --- |
| T1 | Bracket built under the job seed | 1 of 42 (the partition case) |
| T2 | No fail-closed check for a tournament slot without candidates | 1 of 42 |
| T3 | Frozen names not required | 1 of 42 |

## Tests (`tests/db/tournaments.test.ts` unless noted)

Slot 301 starts on Saturday 1970-01-17 at 17:20 UTC, a v1 tournament slot. Characters are placed in leagues and opted in by
trusted operator SQL; every build is validated again by its prepare job.
- **Opt-in command:**
  - receipt, replay and changed-payload conflict through the command port;
  - the real Edge endpoint (`directEdge`);
  - malformed server envelopes are `invalid` with no receipt, no character is `not-found` and no actor is
    `unauthenticated`.
- **Cutoff ± 1 ms through the processing gate** (rollback-only clock):
  - toggles at cutoff − 1 count, in both directions;
  - at the cutoff and at cutoff + 1 they answer `processing` with no receipt;
  - the frozen candidates carry the value at cutoff − 1;
  - bracket and regular Arena follow;
  - after publication the same operations commit and do not change the tournament.
- **A toggle at the cutoff resolved by locking:**
  - a toggle sampled at cutoff − 1 holds its locks;
  - the boundary, past the cutoff, is proven blocked (`pg_blocking_pids`);
  - after the commit the snapshot and the bracket include it;
  - the test-only per-session clock is restored and verified.
- **Partition:**
  - 5 Bronze, 3 Silver, 2 Gold and 1 Champion entrant in one slot: sizes 8, 4 and 2; n − 1 fought bouts and size − n byes
    resolved at once; one charge of 25 each;
  - the lone Champion and an opted-out Bronze run regular Arena exactly once;
  - insufficient stamina is Rest (debit 0), Training is untouched;
  - the routes include the Rest fallback.
  - 50 entrants in one league and 0 in the others are covered by the timing case.
- **Frozen costs:**
  - Arena 30 / tournament 25 with 27 stamina is Rest;
  - Arena 25 / tournament 30 with 27 stamina is regular Arena (`insufficient-stamina`);
  - Arena 20 / tournament 25 is charged 25.
  - A regular slot has no bracket whatever the flag.
- **Acceptance:** 35 malformed results are each refused with nothing written:
  - entrants: omitted, duplicated, misrouted, foreign;
  - entries: altered rating, activity, fighter, or an extra key;
  - routes: omitted Rest or Arena route, duplicated, Rest misrouted either way, altered debit, extra keys;
  - an extra result, tournament or graph key, and no bracket;
  - 15 graphs, each also refused by the real `checkGraph`.

  The valid result is stored exactly as the TypeScript graph, replays, and its rows are immutable.
- **Seeds:**
  - the placement seed is `sha256(seed:bracket)`, never the job seed;
  - a crashed completion rolls back, and the retry keeps the seed and input;
  - the stored ranks equal `buildBracket` under the placement seed;
  - each fought bout seed is `sha256(seed:boutId)`, byes have none, all are distinct;
  - each job carries its bout seed, and a lease retry reuses it.
- **Bout jobs:**
  - four jobs for five entrants, anchored to rank 1, due at S;
  - dependencies 2:0 ← 1:1 and 3:0 ← 2:0, 2:1, and every settlement on every bout;
  - preparing again adds nothing;
  - only 1:1 and 2:1 (two bye winners) are claimable;
  - the fenced read returns the stored graph and frozen names, no seed;
  - the executor fights ranks 2 and 3;
  - completion is refused in 2a, writing nothing.
- **A child reads its parents' winners:**
  - the fence refuses another token (`conflict`), another job kind (`invalid`), an unknown job (`not-found`) and an expired
    lease;
  - after an operator stand-in for 2b writes the parent's result once (a second write is refused), the child fights rank 1
    against the stored winner at full health.
- **Lease regression** (AGENTS.md): the bout read blocks on the job row while the lease is valid, resumes after database
  expiry, and answers `conflict`.
- **Pairing history:**
  - round-one pairs count from the placement;
  - the final counts only once its stored result exists.
- **Access denial:**
  - the three tables have RLS and no client privilege, and clients cannot read them;
  - all ten new or changed functions are backend-only and not `SECURITY DEFINER`;
  - clients cannot call the opt-in or the bout read;
  - no pairing, placement or bout seed, rank, fighter, placement, route or tournament id appears in owner, spectator, world,
    profile, stage, recent or timeline reads.
- **Units** (`tests/backend/worker.test.ts`, `commands.test.ts`):
  - the partition executor: bracket, routes and placement seed; below the minimum and a regular slot; fail-closed inputs;
  - the bout executor: read, seed and retry; children from byes and from a recorded parent; fail-closed cases; through
    `runWorker`;
  - opt-in routing.

## Timing (50 entrants, one-minute cron cadence)

Method: as Task 16's timing case, through the real `private.cron_tick()` and the real private Edge worker reached through
pg_net, with a test-only database clock that is restored and verified.
- Each run has 50 Bronze characters, all opted in. P is a cold regular Arena slot, run to its minute-60 reveals. T = P + 1
  is the next real Wednesday or Saturday 17:20 UTC slot (373333, then 373387 later in the session). T is in steady state:
  P's 50 settlements fall due at T's cutoff.
- Run 1 ticks T exactly 60 000 ms apart (window cleared); run 2 ticks it 59 999 ms apart (window held).
- Ticking stops once T is published. Bout results are phase 2b, so no bout is simulated here.
- Times are from T's cutoff; this is the local stack, not hosted evidence (Task 23).

| Run (Edge stable) | Window | P settled | Prepared | Paired (bracket of 50) | Published |
| --- | --- | --- | --- | --- | --- |
| source state, slot 373333 | cleared | 1.15 s | 61.06 s | 61.11 s | **61.13 s** |
|  | held | 1.08 s | 120.95 s | 121.00 s | **121.01 s** |
| M11 replay, slot 373387 | cleared | 1.14 s | 61.07 s | 61.12 s | **61.14 s** |
|  | held | 1.06 s | 121.03 s | 121.07 s | **121.09 s** |
| gate run on the replay, slot 373387 | cleared | 1.05 s | 61.06 s | 61.10 s | **61.12 s** |
|  | held | 1.05 s | 121.02 s | 121.06 s | **121.08 s** |

- The dispatch log was the same in every run:
  - cleared: 3 invocations (settlement 10/20/20), then 3 (prepare 10/20/20 plus the pairing job);
  - held: 3, then 2 (prepare 20/20), then 1 (prepare 10 plus the pairing job).
- The single pairing job (partition, a 50-entrant bracket, `matchArena` of nobody) completes about 45–51 ms after the last
  preparation. Phase 7 adoption plus phase 8 takes about 17–20 ms for 50 debits, 49 bout jobs and 2 498 dependencies:
  50 × 49 settlement dependencies plus 48 parent dependencies.
- Every invocation answered HTTP 200 with no failure, conflict, unrecorded failure or deferral.
- After run 1 the claimable bout jobs equal `readyBouts` of the stored graph: 18 fought first-round bouts plus the
  round-two bouts between two bye winners.
- The result matches Task 16's bound: about 61 s when the rolling window has cleared, about 121 s when it holds the previous
  tick. The held case misses the 120 s target for the reason Task 16 recorded (the settlement barrier; a Task 23 policy
  decision). The bracket adds about 0.07 s.
- Not measured here (2b): bout simulation time. 49 bouts at most 5 per invocation, round by round, with round 1 of 6
  revealing at minute 11.4.

## Migration

- **Iteration.** `09-tournaments.sql` was applied through the documented `docker exec -i supabase_db_Cloudiator psql`
  fallback, after checking the container's `com.supabase.cli.project` label. The two syntax corrections and the lint
  rename are under "RED and GREEN". Then lint was empty, and advisors showed four INFO unused-index notices, one of them
  on the new `tournament_entries_gladiator_idx`.
- **First draft, discarded.** `db pull tournaments` wrote `20261014160119_tournaments.sql`, which re-emitted
  `private.planning_now_ms()`.
  - Cause: after the RED-run fault I had restored the clock from M02's text through Git Bash `sed`. That dropped the
    carriage returns that the replayed definition (last written by M05) keeps.
  - I restored the function byte for byte from M05 with Node (md5 of `prosrc` now `3fd5ef1c…`, with CR).
  - I reverted the draft's local history entry (`migration repair 20261014160119 --status reverted --local`), removed the
    exact file and regenerated.
- **Generation.** `npx supabase db pull tournaments --local --schema public,private --yes` (CLI 2.120.0, engine `migra`) wrote
  `20261014160257_tournaments.sql`. It re-emits no unchanged function: 5 new and 5 changed functions, three tables, RLS,
  policies, and triggers after their functions.
- **Completion** (AGENTS.md), normalized to CRLF like the other migrations:
  - source-equivalent revokes on the three tables before the generated grants;
  - the source's function revoke/grant pair;
  - a provenance header and `notify pgrst`.

  No backfill or initialization is needed.
- **Replay.** `npx supabase db reset --local --no-seed --yes` replayed M01–M11, with no source applied afterwards.
- **Comparison.** The sanitized schema fingerprint matched the tested source exactly: 752 entries in 772 lines, with the same
  coverage as Task 16's (function definition hashes, search paths, security, volatility and ACLs; relation ACLs, RLS and
  options; policies, triggers, constraints, columns, indexes, the cron job and seed rows). It was identical again after the
  tests, so every test-only stand-in was removed.
- **Tests on the replay.**
  - The first full run passed 151/151, but the Edge container did not exist when the run ended. It came back about 1.5 s
    after the run's last output, the pattern Task 16 recorded. That run is **discarded**.
  - The rerun passed **151/151** in eight files with the Edge start time unchanged.
- **Lint and advisors.** Lint is empty. Advisors on the fresh replay report 25 INFO unused-index notices (two on the new
  foreign-key indexes) and no warnings or errors. `migration list --local` shows M01–M11.

## Final commands (in `verification-gates.md` order)

| Command | Result |
| --- | --- |
| `npm test` | **896 passed**, 36 files (888 + 8). |
| `npm run typecheck` | Exit 0: `tsc` clean, frozen Deno check of `game-command` and `game-worker`, 2 Deno runtime tests passed. The first attempt failed with TS2741: the Deno smoke test's dependencies lacked `setTournamentOptIn`. That was fixed in `tests/backend/edge.deno.ts`, then `npm test` was rerun. |
| `npm run test:db` on the M01–M11 replay | **151/151** in eight files (137 + 14), Edge start time unchanged. |
| `node assets/source/build-assets.mjs --check` | Up to date (28 files). |
| `npm run build`, then `npm run verify:static` | 5 fixed routes, 91 assets, no forbidden backend material. |
| `npx playwright test -c node_modules/.cache/pw-claude.config.mjs` (port 3200) | **260 passed, 8 skipped** (4.2 min). No dev server was left on 3200. |
| Isolated production gate: `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build`, `npm run verify:static -- .next/browser-test`, `PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test` with the private config | Build and scan clean (5 routes, 91 assets); **14 passed, 254 skipped** by design. |
| `git diff --check`, `git diff --cached --check` | Clean. |

## What phase 2b must do

1. **Result fence** (phase 1 item 8): a tournament branch of `private.accept_job_result`, reached through the anchor's
   `resolved_kind = 'tournament'`.
   - Lock the job again, sample time after the lock, and re-check status, expiry, due time and dependencies.
   - Validate the exact result `{boutId, log}` against `input.boutId`, with the log shaped by `private.safe_battle_log`.
   - Check the log against the stored graph:
     - battle id = bout id, and the graph's rules version;
     - exactly the bout's two known entrants in order: round-one placement, otherwise the parents' stored winners;
     - each participant's `gladiatorId` = its id, its frozen fighter values (class, stance, attributes, maximum health,
       `initialHealth` = maximum, armor, weapon damage, interval, efficiency basis points, silhouettes) and its frozen entry
       name;
     - a winner among them that agrees with the victory event.
   - Then compare-and-set: `update private.tournament_bouts set result={winnerId, loserId, log} where id=… and result is
     null`. The guard allows exactly this; an identical retry replays.
   - Pin it with the AGENTS.md lease regression. The worker already runs `recordBout` before completing.
2. **Reveals and stages** (item 9):
   - write a staging stage at S (phase 8, as Arena does);
   - add one reveal job per entrant and fought bout at its round's `revealAtMs`, depending on that bout's job, labelled from
     that entrant's perspective;
   - keep eliminated entrants in the activity, write a minute-80 stage, and bump the revision on reveals;
   - make each settlement depend on its reveal jobs as well.

   This means redefining `prepare_activity_jobs`' tournament branch; keep the bout-job creation in the rank-1 call.
3. **Settlement** (item 10):
   - `public.tournament_settlement_input(activity_id, lease_token)` (a fenced read; it can reuse `private.tournament_graph`);
   - the worker's `tournamentOutcomes`;
   - `public.settle_tournament(activity_id, lease_token, prepared)` through a tournament branch of
     `private.settle_activity_core`, plus a tournament branch in `createWorkerDatabase.settle`.
   - Under the settlement locks, lock this entrant's own league-season rating row for its tournament's league and season, as
     Arena does. Check:
     - the outcome's whitelisted shape;
     - the grant id `<tournamentId>:placement:<gladiatorId>` and its `activityId`;
     - the frozen entry rating equals both `ratingBefore` and the live row.
   - Write `ratingAfter`, the human counters (`wins`, `losses`), renown and money, one receipt and one ledger row, and the
     return stage.
4. **`TournamentView`** (item 11): a role-safe projection, with empty placements until minute 80. The round-1 placement
   field still awaits the M7 contract ruling (Codex and Task 20).
5. **Tests still open from item 12:**
   - the Step 1 table through settlement (charges, one winner, n − 1 rated bouts, no bye renown);
   - a stalled child job;
   - stage due-ness and empty placements before minute 80;
   - placement counts and amounts, and the two-person bracket;
   - frozen builds and names after a mid-tournament build change or rename;
   - a frozen/live rating mismatch going to operator state;
   - a later entrant settling after others moved their rows;
   - a stub or altered stored log refused at settlement;
   - simultaneous settlement retries and the malformed-hook rollback;
   - timing with every bout simulated before its round's reveal.
6. **Already done here:** pairing history picks up later-round bouts once 2b stores their results, and the executor,
   anchoring, seeds and dependencies exist.
7. **Release (Task 24):** M11, 2b's migration and the worker in one release step, then check that no `pair` or `simulation`
   job is in operator state.

## Concerns

- **Phase 2a alone stalls the world** after the first tournament slot with an opted-in pair (see the status). That is the
  expected 2a boundary; nothing is credited or invented.
- **Ranks are trusted** (decision 3). A malfunctioning worker could store a structurally valid bracket with other ranks;
  only the seeded order is unchecked by SQL.
- **Task 16 lock order (derived, not tested or observed).** Task 16 creates an Arena battle's simulation job, anchored to
  side 0, under whichever side's account lock phase 8 takes first. Its foreign key takes a KEY SHARE lock on side 0's
  gladiator row before phase 8 takes side 0's account lock. A planning or shop command by side 0's owner arriving in
  between could deadlock with the boundary: it holds that account lock and waits on its gladiator row `for update`.
  PostgreSQL would abort one of them: the boundary is isolated and retried by `coordinate_work`, while the command answers
  `unavailable` and is retried. Tournament bout jobs avoid this, because they are created inside the rank-1 entrant's own
  call. Worth a reviewer's look; no change was made to Task 16 code.
- **The bout read's round trip is inside the compute-budget timer** (`runWorker` measures executors by wall time).
- **Environment:**
  - the RED-run clock stand-in and its LF restore (under "Migration");
  - one Edge recreation at the end of a replay run (discarded);
  - Edge recreations between runs that followed source edits and host reads.

  No package or tool was downloaded.

## Skill upkeep

Avi, shall I update the project override in `AGENTS.md` (Supabase CLI, "Generated migration completion") and
`docs/operations/migrations.md` ("Required generated-artifact review") to say: restore a test-only function stand-in from
the `pg_get_functiondef` text captured before it was installed, never by replaying a migration statement through a shell
tool that may rewrite line endings? The observed failure is in "Migration": Git Bash `sed` dropped the CRs, so `db pull`
re-emitted an unchanged function. The fix used here, a byte-exact restore with Node and then a regenerated draft, was
tested once. The rule itself is a proposal.
