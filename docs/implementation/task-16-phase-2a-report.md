# Task 16 phase 2a report: Arena placement, ratings and pairing inside the boundary

Status: **DONE**. Phase 2a is implemented and verified locally, as specified in
[task-16-phase-2a-dispatch.md](task-16-phase-2a-dispatch.md). It covers season identity, league placement at phase 4,
rating rows, the visible combat strength, and fenced per-league pairing at phase 7. It stops before any bout is simulated or
settled: Arena activities still stall truthfully at phase 8 (`integration`, no debit), as Task 7 left them, until phase 2b.
An independent review is still to come.

- Date: 2026-10-14. Worktree `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-16-p2`.
- Base: **`839423d`**, the pushed integration head. Branch start: `cd73b1e`, the controller brief.
- Source commit: **`6e8fd57`**, `feat: place leagues and pair Arena entrants at the boundary`, with the migration.
- New migration M09: **`supabase/migrations/20261014113448_arena.sql`**. M01–M08 are unchanged.
- Not done, by instruction: no push or merge, no `HANDOFF.md` edit, no subagents, no downloads. No other checkout was opened,
  and no hosted project was touched. No credential, key or status output was printed. The reset log is the ignored
  `.task16-reset.log`.

## Files

| Path | Change |
| --- | --- |
| `supabase/sql/07-arena.sql` | New reapplicable source. Its header lists the seven accepted exceptions. |
| `supabase/migrations/20261014113448_arena.sql` | M09, CLI-generated, then completed (see "Migration"). |
| `supabase/functions/_shared/backend/jobs.ts` | Additive preparation fields; `PairingInput`, `PairingResult`, `pairArenaV1`; `v1.pair` registry entry; claim order `settlement, prepare, pair, reveal`. |
| `supabase/functions/_shared/domain/types.ts` | `JobKind` gains `pair`; `PreparationResult` gains four fields; `JobLease.gladiatorId` is nullable; `BoundaryReport.wait` gains `pairing` and `epoch`. |
| `tests/db/arena.test.ts` | New. 15 DB cases. |
| `tests/backend/worker.test.ts` | 5 new unit cases. The HTTP test's report literal gains `pair: 0`. |
| `tests/fixtures/db.ts` | `resetIdentity` sets the season epoch to slot 0 and checks it. |
| `tests/db/activities.test.ts` | Two affected expectations (see "Affected existing tests"). |
| `docs/operations/migrations.md` | M09 entry and the local epoch command. |

`arena.ts`, `combat.ts`, the read contracts and Task 10's projection functions and views are unchanged.

## Interfaces

### TypeScript

- **`prepareActivityV1(input)`** keeps every existing field and adds:
  - `league`: `leagueFor(level, earnedPoints, peakStrength ?? 0)`. Banked points count, and the current loadout is
    not an input. A job frozen before Task 8 has no `peakStrength`; 0 is safe there because SQL never lowers a placement.
  - `arenaFighter`: `makeFighter(snapshot, 'arena', RULES_V1)`.
  - `npcTemplate`: `makeFallback(arenaFighter)`.
  - `arenaStrength`: `estimateArenaStrength(arenaFighter)`.
- **`PairingInput`** = `{slotIndex, league, seasonId, rulesVersion, entrants: ArenaEntrant[], recent: PairingHistory[]}`.
  **`PairingResult`** = `{assignments: ArenaAssignment[]}`.
- **`pairArenaV1(input, seed)`** runs `matchArena(entrants, recent, seed)`. It fails closed:
  - a missing array, or an entrant of another league, slot or season, is `invalid-input`;
  - any rules version other than `v1` is `unsupported-rules`.
- **`DEFAULT_EXECUTORS.v1.pair`** calls `pairArenaV1(job.snapshot, job.seed)`.
- **`runWorker`** claims `settlement`, `prepare`, `pair`, then `reveal` inside the one 20-job simple budget, and
  `byKind.pair` counts pairing jobs. So the invocation that completes a boundary's last preparation also claims that
  boundary's pairing jobs. Simulations are still claimed only when no simple work was claimed.

### SQL (all `SECURITY INVOKER`, empty `search_path`, backend-only execution)

| Object | Contract |
| --- | --- |
| `private.season_epoch(singleton, epoch_slot)` | One row, set once. Update and delete are refused (`guard_frozen`). Only the backend has `SELECT`. |
| `private.season_index(slot) → bigint` | `(slot − epoch) / 504`, or null when no epoch covers the slot. Season ids are its decimal text (`'0'`). |
| `private.arena_ratings` | Primary key `(gladiator_id, league, season_index)`; rating 1000, check 0 … 2⁵³−1; `human_wins`, `human_losses`. Identity is immutable, the counters only grow, and rows cannot be deleted (`guard_arena_rating`). |
| `public.gladiators.league` / `.rating` | The cache of the current placement and its current league-season row. `guard_league` refuses any decrease. |
| `private.boundary_recompute_leagues(target)` | Phase 4, described below. |
| `private.pairing_input(target, league, season, rules) → jsonb` | One league's frozen entrants, plus the human bouts among them in slots S − 18 … S − 1. |
| `private.boundary_pair(target)` | Phase 7, described below. |
| `private.accept_pairing(job, result) → boolean` | Validates a pairing result, then writes the assignments (details below). |
| `private.arena_assignments` | One immutable row per battle: battle id, pairing job (FK), slot, league, season, kind, private `seed` and the validated assignment. |
| `private.arena_assignment_sides` | `(activity_id` primary key, `battle_id, side)`: each entrant activity is on exactly one side of one battle. |
| `private.jobs` | Kind `pair` is allowed; `gladiator_id` is nullable, and `jobs_gladiator_check` allows that for `pair` only. `guard_job` compares it with `IS DISTINCT FROM`. |
| `public.claim_jobs` / `public.complete_job` | `pair` is whitelisted with the simple cap of 20, and has its own completion branch. |
| `private.boundaries.wait_reason` | Gains `pairing` and `epoch`. |

`dispatch_workers` is unchanged: it already counts every kind except `simulation` as simple work, so pairing dispatches
as simple work (the 50-entrant test sees `claimableSimple: 2`).

**Phase 4, `boundary_recompute_leagues`.** For each cohort member, in gladiator order, under the account lock and the
gladiator row lock:
1. The placement is the higher of the cached league and the frozen `league`.
2. It ensures the `(placement, season)` rating row exists, created at 1000.
3. It refreshes the cached league and rating.
4. It upserts `public_profiles.combat_strength` from the frozen `arenaStrength`.

It returns `epoch` when members exist but no epoch covers the slot.

**Phase 7, `boundary_pair`.**
- A `tournament` entrant is still Task 19's `integration` gate. With no Arena entrants the phase passes.
- Otherwise it inserts one `pair` job per league with entrants: dedupe key `pair:<slot>:<league>`, no gladiator or
  activity, the default job-local random seed, and the `pairing_input` as its immutable input.
- It returns `operator` if any pairing job of the slot is in operator state, and `pairing` while any is unfinished.
- Once all have completed, it checks that every entrant has an adopted side, then passes.

**Pairing acceptance, `accept_pairing`.** It returns false before any write unless every rule below holds:
- The result is exactly `{assignments: [...]}`.
- Each assignment has exactly its kind's keys, and the job's slot, league and season.
- A human assignment has two sides and an NPC assignment one.
- Each side has exactly its five keys and is an entrant of this slot and league, appearing only once.
- Each side's activity, frozen rating (`snapshot.starting.rating`), strength and fighter equal the frozen preparation values.
- Battle ids follow phase 1's format.
- An NPC opponent is exactly `{id: 'npc:<gladiatorId>', snapshot: <frozen npcTemplate>}`.
- Every entrant appears.

Only then does it insert the assignments, their sides and their battle seeds,
`encode(extensions.digest(<pairing job seed>||':'||battleId,'sha256'),'hex')`.

## Decisions

1. **The comparison target is frozen, never recomputed** (controller decision 1). The test suite found a concrete
   reason. `makeFighter` orders `equipmentSilhouettes` by the build's equipment key order, and JSONB stores keys in its
   own order. A fighter recomputed from a stored snapshot therefore lists the starter gear as
   `[light-armor, sword]`, while the canonical preparation lists `[sword, light-armor]`. The test pins both orders.
   Phase 2b must likewise use the assignment's frozen fighters and NPC template, never `makeFighter(snapshot.build)`.
2. **The strength is published by an upsert at phase 4**, outside `project_character` (header exception 4).
   Task 10's projector never writes `combat_strength`, so this is additive, and the deferred revision trigger publishes
   it. The value is null until a character's first boundary.
3. **The arena fields are not copied into `activity_snapshots`.** At phase 7 they are read from the completed, immutable
   prepare job, and the immutable assignment then retains them with the activity. This saves about 1 KB on every
   non-Arena snapshot.
4. **Rating rows are created at phase 4 for every member**, including Training and Rest characters, so the cache always
   reflects the current league-season row. A season rollover takes effect at its first boundary. No migration backfill
   is possible or needed, because the epoch is unset when M09 is applied.
5. **Two new waits.** `pairing` is a truthful wait for unfinished pairing jobs. `epoch` is a truthful wait for a missing
   epoch, instead of inventing a season. An unexpected unpaired entrant after every job completed raises an error, which
   `coordinate_work` isolates as `boundary-failed` with its SQLSTATE.
6. **History bound.** SQL passes only S − 18 … S − 1 (header exception 7), and only bouts between two entrants of the
   job; `matchArena` still applies its own versioned window. The history uses the pairing jobs' `jobs_slot_idx` and the
   assignments' pairing-job index, so it needs no slot index on `arena_assignments`.
7. **Assignments reference their pairing job (FK).** That records the seed's provenance, and it lets the test suite's
   `truncate public.gladiators cascade` clear the assignments. Retention must therefore prune assignments and sides
   before their pairing jobs.
8. **Acceptance does not re-run pairing optimality** (header exception 5). Canonical TypeScript decides the pairs.
   SQL restates no pairing rule, including the 2× cap. Cross-league pairs are structurally impossible: every side must
   be an entrant of the job's own league.
9. **Lock order.** Phase 4 takes the coordinator, then the account advisory lock, the gladiator row, the rating row, and
   the projection row last. A pairing completion locks the job row, and its FKs then take KEY SHARE locks on activity
   rows. That is the reverse of settlement's order, so it is documented as header exception 3. It cannot form a cycle,
   because nothing locks those activities while phase 7 waits for that job.

## RED and GREEN

| Cycle | RED (observed) | GREEN |
| --- | --- | --- |
| Unit (worker) | `npx vitest run tests/backend/worker.test.ts`: **5 failed / 17 passed**. `arenaFighter` and `league` were `undefined`, `DEFAULT_EXECUTORS.v1.pair is not a function`, and the claims stopped at `[settlement, prepare, reveal]`. | 22/22 |
| DB (Arena) | `npm run test:db -- tests/db/arena.test.ts` before any SQL: **15 failed**, all with `relation "private.season_epoch" does not exist` (the missing schema). | After applying the source, 14/15. The failure was a test error (decision 1): the recomputed fighter came from the JSONB-ordered snapshot. Recomputing from the frozen job input instead gave 15/15. |

The DB RED above was only "missing schema", so each SQL rule was then proven by a temporary mutation:
- each mutated function was applied to the verified local container;
- its owning test was run;
- the original definition was restored, and its `md5(pg_get_functiondef)` checked equal ("restored: true" for every row).

| Mutation | Owning test | Observed failure |
| --- | --- | --- |
| M1: placement takes the computed league (no max) | never lowers a placement | `advance_boundary: league placement decrease` (the guard trigger, a second defence) |
| M3: a new league row inherits the old rating | promotes from banked points | rating 1040, expected 1000 |
| M4: history window S − 19 | preceding 18 slots | `recent` also held the S − 19 bouts |
| M5: no fighter equality check | omits, duplicates or alters | "an altered fighter" was accepted |
| M6: no completeness count | omits, duplicates or alters | "an omitted entrant" was accepted |
| M7: battle seed without the battle id | battle seed is stable | the seed differed from `sha256(seed + ':' + battleId)` |
| M8: no NPC template equality check | omits, duplicates or alters | "an altered NPC template" was accepted |
| M9: strength not published | weak current loadout | `combatStrength` stayed null |
| M10: rating cache not refreshed | promotes from banked points | the cached rating stayed 1040 |

M7's first run failed for the wrong reason. A kind-order assertion depended on battle-id order, and battle ids contain
random gladiator ids. The assertion was made order-independent, M7 was rerun (the failure above), and the unmutated test
then passed 3 runs out of 3.

## Tests

`tests/db/arena.test.ts` drives real Auth accounts, real creation, the real boundary RPCs, canonical preparation, real
claims and fenced completion. Characters are placed by trusted operator SQL: first slot, earned and banked points, level,
gear history and build allocations. Every build is validated again by its prepare job.

- **Placement.**
  - Banked points (105 earned, 95 banked) promote Bronze to Silver, and only at the boundary.
  - A new Silver row starts at 1000 and the Bronze row (1040, 3 wins and 1 loss) is kept.
  - The snapshot's `starting` and `OwnerState.progression` show Silver at 1000.
  - A Gold placement stays Gold when the frozen computation says Bronze, and lowering it directly is refused.
  - Rating identity and counters are immutable, and rating rows cannot be deleted.
  - Gear history 560 places Gold while the current starter loadout's own score would give Bronze. The current strength
    931.75 is published on the public profile, after being null before the first boundary.
- **Epoch.**
  - Season indexes are 0 for slots 0, 300 and 503, and 1 for slot 504.
  - The epoch refuses update, delete and a second row.
  - In a rollback-only transaction without an epoch, phase 4 waits with `epoch` and creates no rating row.
- **Pairing job.**
  - Phase 7 waits with `pairing`, three failures give `operator`, and resume, completion and adoption follow.
  - Phase 8 then still waits with `integration`: no debit, no published activity and no simulation job.
  - There is one job per league, with no gladiator or activity and its own 64-hex seed, distinct from every activity
    seed. Its input entrants equal the frozen values.
  - A non-pair job without a gladiator is refused, and a frozen pairing job's identity is immutable.
- **Acceptance.** 21 malformed results are each rejected as `invalid` with no rows written, including:
  - a non-object result, no array, or an extra key at any level;
  - an omitted entrant, a duplicated assignment, or a duplicated entrant;
  - an altered fighter, NPC template or NPC identity;
  - an altered rating, strength or activity;
  - a foreign entrant, or another league, season or slot;
  - a forged battle id, or a swapped kind.

  The valid result is then accepted.
- **Assignments.**
  - An injected failure while writing the sides rolls the whole completion back.
  - The retry (attempt 2) has the same seed and input and produces the same result.
  - Each battle seed equals `sha256(<job seed>:<battleId>)`, computed independently in the test.
  - Replaying the completion writes nothing new, and both tables refuse updates.
- **Real snapshots.** Each case uses builds that a probe over 372,326 real starter-gear builds found:
  - **No cross-league pairs**, between a Bronze pair and a Silver pair.
  - **Exactly 2×**: 708.37 against 1416.74 is a human bout, while 708.37 against 1416.75 gives two NPC bouts.
  - **18-slot history**: one bout at S − 18 counts, and two at S − 19 do not, so the first entrant takes the opponent it
    has not met inside the window.
  - **Odd count**: the weakest of three gets its frozen NPC template.
  - **No entrants** create no pairing job, and **one entrant** gets an NPC bout.
  - **50 entrants** (10 Silver, 40 Bronze) are paired by the real Edge worker through pg_net. Every entrant appears
    exactly once, each bout stays in its league, the result equals `matchArena` on the frozen input under the job seed,
    and every human pair is within 2×.
- **Access denial.**
  - Anonymous and authenticated clients have no privilege on the four new private tables, and every one has RLS.
  - The owner, another account and an anonymous client all fail to read them through the Data API.
  - No new function is `SECURITY DEFINER`, clients cannot execute any of them, and the backend can.
  - No seed, battle id, NPC template or arena fighter appears in owner state, the profile, the activities or the world
    projection.
  - Clients cannot update `public_profiles`.

## Timing (50 entrants, real dispatch)

The coordinator lease is released at phase 7. Then `private.dispatch_workers()` sends one pg_net request to the local
`game-worker` Edge function. That worker coordinates, claims both pairing jobs, runs `matchArena`, completes both, and
coordinates again, which adopts the result and moves the boundary to phase 8.

| Measurement (database timestamps) | Result |
| --- | --- |
| Pairing jobs inserted → adopted (phase 8) | **69 ms** (later runs: 67, 66) |
| Dispatch → adopted | 46 ms |
| Claim → both completed | 17 ms |
| Completed → adopted | 12 ms |
| Wall clock, dispatch call → phase 8 observed | 109 ms |
| Target (spec §10.4) | 120,000 ms |

This is the local stack, not hosted evidence; hosted load measurement remains Task 23. In production the pairing job is
normally claimed by the same invocation that completes the last preparation (claim order `prepare` then `pair`). Otherwise
it waits for the next dispatch, at most one cron minute.

## Migration

- **Iteration.** `07-arena.sql` was applied through the documented `docker exec -i supabase_db_Cloudiator psql` fallback,
  after checking the container's `com.supabase.cli.project` label. The first application failed and rolled back as a
  whole: PL/pgSQL ends an `IF` condition at the first `THEN`, so a `CASE` inside it is a syntax error. The values are now
  computed into variables first.
- **Before generation.** Lint was empty. Advisors showed five INFO unused-index notices, all existing.
- **Generation.** `npx supabase db pull arena --local --schema public,private --yes` (CLI 2.120.0, engine `migra`) wrote
  `20261014113448_arena.sql`.
- **Completion.** The draft was completed per AGENTS.md, then normalized to CRLF like the other working-tree migrations:
  1. The `guard_league` trigger, which preceded its function, was moved after all the functions.
  2. The draft only added table grants; source-equivalent revokes were added before them.
  3. The function revoke/grant pair it omitted was appended.
  4. A provenance header and `notify pgrst` were added.

  The draft re-emits no unchanged function. It holds the 6 changed and 6 new functions listed in `migrations.md`. No
  backfill or initialization is needed.
- **Replay.** `npx supabase db reset --local --no-seed --yes` replayed M01–M09, with no source applied afterwards.
- **Comparison.** The sanitized schema fingerprint (scratch `schema-fingerprint.sql`) matched the source state exactly:
  **625 entries** (645 lines, because some policies span lines). It covers function definition hashes, search paths,
  security, volatility and ACLs; table and view ACLs, RLS and options; view definitions; policies, triggers,
  constraints, columns, indexes, the cron job and the seed rows.
- **Tests on the replay.** The first full `npm run test:db` run had one **infrastructure fault**, not product evidence:
  - Docker events show the background `functions serve` recreated the Edge container one second after the run began.
  - `supabase/.temp/start-secrets` was rewritten at the same moment. A separate `supabase status` call did not
    reproduce it, so the trigger is unconfirmed.
  - One Edge HTTP case (the expedition worker) got "connection refused"; the other 123 passed.

  The serialized rerun, with the container's start time unchanged across the run, passed **124/124**.
- **After the tests.** The fingerprint was identical again, so the test-only triggers and function stand-ins were all
  removed. Lint was empty. Advisors showed six INFO unused-index notices (none on the new tables) and no warnings or
  errors. `migration list --local` shows M01–M09 applied.

## Affected existing tests

- `activities.test.ts`, "starts expeditions and retains the unsupported Arena integration gate". The Arena entrant is
  now paired at phase 7, so the gate moved from `phase: 7` to `phase: 8`. The no-debit and unchanged-checkpoint
  assertions are unchanged.
- `activities.test.ts`, "recomputes the derived stamina maximum under a newer rules version". Its test-only v2 executor
  already rewrote `rulesVersion` on its result and snapshot. It now also rewrites the two new version-bearing fields,
  because `valid_preparation` checks them against the job's rules version.
- `worker.test.ts`: the HTTP test's report literal gains `pair: 0`, required by the extended `byKind` type.

## Final commands (in `verification-gates.md` order)

| Command | Result |
| --- | --- |
| `npm test` | **872 passed**, 36 files (867 before, plus 5). |
| `npm run typecheck` | Exit 0: `tsc` clean, frozen Deno check of `game-command` and `game-worker`, 2 Deno runtime tests passed. |
| `npm run test:db` (on the M01–M09 replay) | **124/124**, 7 files (109 + 15). The first run's infrastructure fault is described under "Migration". |
| `npm run build`, then `npm run verify:static` | 5 fixed routes, 91 assets, no forbidden backend material. |
| `npx playwright test -c node_modules/.cache/pw-claude.config.mjs` (port 3200) | **258 passed, 8 skipped** (4.3 min), the same counts as the integration checkpoint. Run after the build had finished; no dev server was left on 3200. |
| `git diff --check`, `git diff --cached --check` | Exit 0 (only the configured LF-to-CRLF notices). |

Environment notes:
- A first attempt to script a file edit with a `python3 … || node …` shell construct hung on the Windows `python3`
  stub. It was stopped before it wrote anything (`git diff --stat` confirmed), and the edit was redone with the editor.
- No package or tool was downloaded. The scratch probe and the mutation runner used the installed Node 22.19 with
  built-in type stripping, from the session scratch directory.

## What phase 2b must do

1. **Executor readiness and jobs.** Make `private.activity_executor_ready('arena')` true. For an Arena activity,
   `private.prepare_activity_jobs`:
   - looks up its battle through `private.arena_assignment_sides`;
   - creates exactly one simulation job per battle, idempotently. Its dedupe key must be decided: battle ids already
     begin with `arena:`. The job is anchored to side 0's activity and gladiator, and carries `arena_assignments.seed`
     and the frozen assignment under an explicit input kind;
   - creates each activity's own reveal and settlement jobs, which depend on the simulation through
     `private.job_dependencies`;
   - documents the battle-seed exception, already in this source's header.
2. **Frozen fighters only.** Simulate from the assignment's frozen fighters and NPC template. Never call
   `makeFighter(snapshot.build)`: JSONB key order changes the silhouette order (decision 1).
3. **Executor discriminator.** The `v1.simulation` executor dispatches on an explicit input kind, and an unknown kind
   fails with `unsupported-executor`, with a unit test. Use `simulateBattle` with the battle id and battle seed:
   - a human participant's id is its `gladiatorId`;
   - the NPC is `opponent.id` with `gladiatorId: null`.
4. **Acceptance.** Give `private.accept_job_result` an Arena branch, fenced and with post-lock checks. It validates the log
   against the assignment (the same checks `arenaOutcomes` makes), and stores the log and both outcomes once.
5. **Settlement, one side at a time,** under its own account lock in the common order:
   - Compare that side's frozen rating with its live `private.arena_ratings` row, for the snapshot's league and
     `season_index(slot)`. On a mismatch, fail closed to operator state.
   - Apply the clamped `applied` delta to that row, and the human win or loss counter for human bouts only.
   - Refresh `public.gladiators.rating` in the same transaction.
   - Credit renown only. `ratingDelta` is the applied change, and 0 for NPC bouts.
6. **Public stages:** `staging` at S (ends at S + 60 min), `bout` at S + 60 min with the log, and a zero-length `return` at
   S + 80 min, with the labels in the phase 1 report.
7. **Standings:** a public, paginated read model from `arena_ratings` (rating, human wins and losses), wired through
   Task 10's projection and revision hooks.
8. **DB tests** still open from plan item 12:
   - `db.settleNpcWin()` gives `{renown: 3, ratingDelta: 0}`;
   - simultaneous settlement retries;
   - the frozen/live rating mismatch goes to operator state;
   - the second side settles after the first moved its row;
   - both sides reveal the same log, and exactly one is credited the win;
   - stages appear only when due;
   - the malformed-hook rollback;
   - the 2-minute target re-measured with simulation included.
9. **Retention (Task 22):** prune assignments and their sides before their pairing jobs (FK).
10. **Deployment (Task 24):**
    - Set `private.season_epoch` at launch, or every boundary with members waits with `epoch`.
    - Deploy the worker before or together with M09. The new `valid_preparation` refuses preparations without the
      four additive fields, so an old worker's result would be rejected and retried into operator state.

## Skill upkeep

No skill change is applied. One observation, for the controller to raise with Avi if wanted (observed once, mitigation
untested): the background `functions serve` recreated the Edge container during a DB run, and the cause is unconfirmed.
A possible addition to `local-runtime.md` would be to record the Edge container's `StartedAt` before and after
`npm run test:db`, and to treat Edge connection failures during a recreation as infrastructure faults to rerun.
