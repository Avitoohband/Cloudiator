# Task 16 report: league-aware Arena battles and ratings

Status: **DONE**. All three phases are implemented and verified locally. Phase 1 (pure domain) and phase 2a (schema,
placement, ratings, pairing) passed independent review. Phase 2b (bouts, settlement, stages, standings) is complete here
and awaits its independent review. Hosted proof, retention and the tournament and season tasks remain later gates.

| Phase | Scope | Branch and commits | Review |
| --- | --- | --- | --- |
| 1 | Pure Arena domain: `leagueFor`, `estimateArenaStrength`, `makeFallback`, `matchArena`, `ratingDelta`, `applyRatingDelta`, `arenaOutcomes` | `claude/task-16`: feature `270deb9`, report `61b3e7b`, review fixes `a60eeb2`/`bec7ad2`, Minors `c30d854`/`b3c3238` | Spec Pass, quality Pass ([review](task-16-phase-1-review.md)) |
| 2a | Season epoch, league placement at phase 4, rating rows, visible combat strength, fenced pairing at phase 7, M09 | `claude/task-16-p2`: brief `cd73b1e`, feature `6e8fd57`, report `430aec3`, review record `d3797e7` | Spec Pass, quality Pass ([review](task-16-phase-2a-review.md)) |
| 2b | One simulation per battle, worker executor, fenced acceptance, settlement one side at a time, public stages, standings, live UI wiring, M10 | `claude/task-16-p2`: base `d3797e7`, brief `1d6a482`, feature **`31cfdaa`**, this report | To come |

- Date: 2026-10-14. Worktree `C:\Avi\Studies\Projects\Cloudiator-claude`. Phase 2b base: **`d3797e7`** (pushed).
- Phase 2b scope: [task-16-phase-2b-dispatch.md](task-16-phase-2b-dispatch.md), the 2a report's "What phase 2b must do" with its
  review additions, and the binding plan and spec text in [task-16-brief-base.md](task-16-brief-base.md).
- Migrations: M09 `supabase/migrations/20261014113448_arena.sql` (2a) and M10
  **`supabase/migrations/20261014131209_arena_bouts.sql`** (2b). M01–M08 are unchanged.
- Not done, by instruction: no push or merge, no `HANDOFF.md` edit, no subagents, no downloads. No other checkout was opened
  and no hosted project was touched. No key, credential or status output was printed; CLI, reset and test output is in
  ignored `.task16-2b-*.log` files.

## Phases 1 and 2a (summary)

The [phase 1 report](task-16-phase-1-report.md) and the [phase 2a report](task-16-phase-2a-report.md) hold the full
interfaces, decisions and evidence. In short:
- **Phase 1** added `supabase/functions/_shared/domain/arena.ts` with 121 unit cases: league index and thresholds from level,
  every earned point and historical gear (never the current loadout), the exact-decimal strength estimate, the 85% NPC
  fallback, strongest-first greedy pairing within a league under the 2× cap and the 18-slot history, Elo K24 with a floor of
  0, and per-side outcomes from the logged `winnerId`. Avi kept the spec's strongest-first rule (balance option A).
- **Phase 2a** added `supabase/sql/07-arena.sql` and M09: the immutable season epoch and `season_index`; placement at
  phase 4 as max(cached, frozen) with one rating row per character, league and season; the published combat strength; one
  fenced `pair` job per slot and league, strict acceptance against frozen values, and immutable assignments with per-battle
  seeds `sha256(<pairing seed>:<battleId>)`. Arena activities stalled truthfully at phase 8 until 2b.

## Phase 2b: what changed

| Path | Change |
| --- | --- |
| `supabase/sql/08-arena-bouts.sql` | New reapplicable source; its header lists the eight accepted exceptions. |
| `supabase/migrations/20261014131209_arena_bouts.sql` | M10, CLI-generated and completed (see "Migration"). |
| `supabase/functions/_shared/backend/jobs.ts` | `ArenaSimulationInput`, `ArenaSimulationResult`, `simulateArenaV1`; the explicit simulation discriminator; `PairingInput.historyFromSlot` and its fail-closed check; an operator-retained settlement counts as failed. |
| `supabase/functions/_shared/backend/database.ts` | `JobOutcome` gains the `operator` code. |
| `supabase/functions/_shared/domain/arena.ts` | Additive `arenaNpcName(league)`. |
| `src/lib/api/reads.ts`, `src/lib/api/gateway.ts` | `readStandings` and the live `standings(league, cursor?)`. |
| `src/app/game/page.tsx` | The Arena card and the Standings panel receive the live gateway in live mode; fixture mode is unchanged. |
| `tests/db/arena.test.ts` | 13 new DB cases (28 in all); five 2a expectations updated (see "Affected existing tests"). |
| `tests/backend/worker.test.ts` | 8 new unit cases; the pairing inputs gain `historyFromSlot`. |
| `tests/reads.test.ts`, `tests/api/projection-gateway.test.ts` | 3 new unit cases for the standings read. |
| `tests/browser/arena-live.spec.ts` | New live-mode spec: the live panels get a reader. |
| `tests/db/activities.test.ts` | One affected expectation: Arena now starts at phase 8. |
| `vitest.db.config.ts` | The same `@domain`, `@contracts` and `@` aliases as the unit config (DB tests drive the read adapters). |
| `docs/operations/migrations.md` | M10 entry, release and retention notes. |

`combat.ts`, the contracts, the fixture gateway and the Task 17 panels are unchanged.

## Interfaces (phase 2b)

### TypeScript

- **`simulateArenaV1(input, seed)`**, the `kind: 'arena'` branch of `v1.simulation`. Input: `{kind, battleId, slotIndex,
  rulesVersion, startsAtMs, revealAtMs, assignment, names}`, where `assignment` is the frozen row from
  `private.arena_assignments` and `names` are the human sides' names in side order. It runs one `simulateBattle` from the
  assignment's frozen fighters and NPC template only, then `arenaOutcomes`, and returns `{battleId, log, outcomes}`.
  - Participants: a human is `{id: gladiatorId, gladiatorId}`; the NPC is `{id: 'npc:<entrant>', gladiatorId: null}` named
    `arenaNpcName(league)` ("Bronze Sentinel", "Silver Sentinel", "Gold Sentinel", "Champion Sentinel").
  - Fails closed: another rules version is `unsupported-rules`; a battle or slot mismatch, a names mismatch, `startsAtMs`
    other than `slot × slotMs`, `revealAtMs` other than `startsAtMs + RULES_V1.arena.revealAfterMs`, or an invalid fighter is
    `invalid-input`.
- **Discriminator.** An input with `kind: 'arena'` is an Arena bout. An input without `kind` whose `choice.kind` is
  `expedition` is an expedition snapshot and keeps `planExpedition`. Anything else is `unsupported-executor`.
- **`pairArenaV1`** now requires `historyFromSlot <= slotIndex − rules.matchmaking.recentPairingSlots` (`invalid-input`
  otherwise, also when it is missing).
- **`runWorker`**: a settlement answered `{ok:false, code:'operator'}` counts as `failed` and is not failed again.
- **`readStandings(client, league, cursor?)`** returns a `StandingsPage` of the latest season with rows: at most 50 rows,
  ranked by the view, `nextCursor` `season:rank` when a page is full, `archived: false`. `inactive` means no human bout in
  that league and season; `rewardEligible` means at least `RULES_V1.seasons.minimumHumanBouts` (5) human bouts. A
  malformed cursor or league fails before any query. With no rows at all it returns `seasonId: ''` and no rows.

### SQL (all `SECURITY INVOKER`, empty `search_path`, backend-only execution)

| Object | Contract |
| --- | --- |
| `private.activity_executor_ready(text)` | True for training, rest, expedition and arena. |
| `private.prepare_activity_jobs(uuid)` | Arena: the battle's one simulation `arena:<battleId>` (on conflict do nothing; anchored to side 0, battle seed, frozen assignment, due S), this side's reveal `arena-reveal:<activity>` (activity seed, due S + 60 min, needs the simulation), its settlement (needs the simulation and the reveal) and its warm-up stage. |
| `private.accept_arena_result(uuid, jsonb)` | Called through `accept_job_result` from `complete_job`. Locks the job again, samples the clock after that lock, re-checks status, expiry, due time and dependencies. Simulation: validates and freezes the log and both outcomes in `private.arena_results`. Reveal: writes this side's bout stage. |
| `private.accept_job_result(uuid, jsonb)` | Dispatches Arena activities first; Task 9's expedition branch is unchanged. |
| `private.arena_settlement_failure(uuid)` | Null, or `rating-mismatch` / `arena-unsimulated` / `arena-unassigned`. Checks only this side's frozen rating against its own live row. |
| `private.arena_rewards(uuid)` | One side's credit from its frozen outcome: its own rating row (the clamped delta), the human win or loss counter for human bouts only, the rating cache, renown only (10/2 human, 3/0 NPC) and its return stage. `ratingDelta` is the applied change, 0 for NPC bouts. |
| `private.settle_rewards(uuid)` | Training and Rest unchanged; Arena calls `arena_rewards`. |
| `private.settle_activity_core(uuid, uuid, jsonb)` | Locks the side's rating row before the activity and job; the operator transition; a receipt and ledger row for Arena as for Expedition. |
| `private.pairing_input(...)` | Adds `historyFromSlot: target − 18`. |
| `private.project_character(uuid)` | Task 10's projector, plus this character's `public.arena_standings` rows. |
| `private.arena_results` | Primary key `battle_id` (FK assignments), unique `simulation_job_id` (FK jobs), the sanitized `log`, the `outcomes` array, `guard_frozen`; backend-only. |
| `public.arena_standings` | `(gladiator_id, league, season_index)`: name, rating, human wins and losses. Authenticated `SELECT` only; backend writes; cascades with its gladiator. |
| `public.arena_standing_reads` | Invoker view: the columns above plus `rank` (row number per league and season by rating, human wins, fewer human losses, id) and `promoted` (a higher league's row in the same season). |

Triggers: `project_changed_character` on `private.arena_ratings` and `projection_changed` on `public.arena_standings` (both
deferred, as Task 10's), and `guard_frozen` on `private.arena_results`.

## Decisions

1. **Settlement route: stored outcomes from acceptance** (the dispatch asked which). The simulation executor returns the log
   and both sides' `arenaOutcomes`; acceptance validates and freezes them; each side's settlement reads only its own frozen
   outcome. No prepared settlement RPC was needed, because an Arena credit depends on nothing outside the bout.
2. **Acceptance restates no domain formula** (header exception 2). It checks the exact result shape and the log against the
   frozen assignment: battle id, rules version, both participants' ids, `gladiatorId`, names and frozen fighter values
   (class, stance, attributes, health at full, armor, weapon damage, interval, silhouettes), and a winner that is a
   participant and agrees with the victory event. For each outcome it checks identity, result and success against the
   logged winner, zero XP, money, points, items and overflow, a safe-integer renown, the frozen rating before, after =
   before + delta, a non-negative winner delta and non-positive loser delta, and a zero NPC delta. It trusts the canonical
   TypeScript renown amounts and Elo, as preparation and pairing acceptance trust theirs.
3. **Stage writers** (header exception 4). The warm-up is due at S, so phase 8 (which runs at or after S) writes it with the
   activity. The bout is written by the side's own reveal job at S + 60 min. The zero-length return is written by the
   side's settlement in the crediting transaction, so "Results credited" never appears before the credit; this differs
   from the expedition pattern, where a reveal job writes the return stage. Only due stages exist, and RLS still checks
   database time. Both entrants' bout stages carry the same log and the same `endsAtMs` (Task 17 review Minor 2).
4. **Rating mismatch goes straight to operator state** (exception 6), with `last_failure='rating-mismatch'`, before any grant
   or checkpoint: retrying a deterministic inconsistency would only spend attempts. The operator repairs the row and calls
   `private.resume_operator_job`; the next boundary waits with `operator` meanwhile.
5. **Restated constants** (exception 5): `3600000` (minute 60) is checked by the versioned executor through the job's
   `revealAtMs`; `18` is now passed as `historyFromSlot` and checked; `604800000` (replay retention) is as in Task 9; the 504
   in 07's `season_index` restates `RULES_V1.seasons.durationSlots`.
6. **Standings are a projection** written by Task 10's projector (exception 7). The current season is the latest season with
   rows: the launch epoch stays private. Rank is computed by the view at read time, so the page cursor is `season:rank`; a
   rating that changes between two page reads can shift rows, and the panel de-duplicates by gladiator.
7. **Page detection.** The local Data API caps every response at `max_rows = 50` (`supabase/config.toml`), so a 51-row probe
   never sees more. As Task 10's `readRecent`, a full page of 50 yields a cursor; an exact multiple of 50 rows gives one
   empty last page, which the panel handles.
8. **Ledger.** An Arena credit writes an `activity-settlement` operation receipt and a `wallet_ledger` row
   (`reason 'arena'`, renown delta, money 0), as Expedition does for money. Renown 0 still writes its row.

## RED and GREEN (phase 2b)

| Cycle | RED (observed) | GREEN |
| --- | --- | --- |
| Worker units | `npx vitest run tests/backend/worker.test.ts`: **7 failed / 23 passed**. The Arena input reached `planExpedition` (`TypeError` reading `build.rulesVersion`), unknown kinds failed as `execution-failed` instead of `unsupported-executor`, a narrower history passed, and an operator outcome counted as a conflict. The expedition dispatch case passed (unchanged behaviour). | 30/30 (151 with the arena domain file) |
| Read adapter | 3 failed: `readStandings is not a function` (2) and the live gateway `unavailable` (1). | 11/11 |
| Arena DB | The first attempt failed to load: `Cannot find package '@domain/rules-v1'` (the DB config had no aliases): a configuration fault, not RED. Then **17 failed / 7 passed**: every pairing failed at the new `historyFromSlot` check (2a SQL does not pass it) and Arena had no bout path. The 7 passing were the four 2a placement cases, the 2a frozen-job case and the two new pins described below. | After `08-arena-bouts.sql`: 21/24. Two failures were test errors (a lexicographic `sort()` of numbers); one was a real finding (decision 7). The Edge container was also recreated 3 s into that run. After the fixes, **24/24** with the container stable. |
| Live UI | `npx playwright test … arena-live --project=desktop` against the committed `page.tsx`: failed; the card read "The Arena card is not available in this build yet." | 2/2 (desktop and mobile) after the flip. A first green attempt failed only on an ambiguous text locator in the test. |

Written after the SQL, so proven by mutation instead: the bout-result rejection case (32 forged results per battle, for one
human and one NPC bout) and the three lock-wait regressions. The rejection case first failed on a test error: flipping
"win" was a no-op for an NPC bout the entrant had won. Two new cases pinned existing 2a behaviour through real paths and
passed on first run: banked Training points and real Task 8 acquisitions.

### Mutations

Each SQL mutation was applied to the verified local container as a modified copy of `08-arena-bouts.sql`, its owning test
was run, and the original source was reapplied; an md5 over every public and private function definition matched the
baseline after each one (`restored: true` throughout). The runner and its list are scratch files.

| # | Mutation | Owning test failed with |
| --- | --- | --- |
| MA | Settlement skips the frozen/live rating check | the mismatched side settled (`ok: true`) |
| MB | NPC bouts count as human wins | NPC win: counters 1/0 instead of 0/0 |
| MC | Each side also checks the opponent's live row | the second side went to `operator` |
| MD | Acceptance skips the frozen fighter comparison | "an altered fighter" accepted |
| ME | Acceptance skips the result/winner consistency | "results against the logged winner" accepted |
| MP | Acceptance allows an NPC rating change | "an NPC bout changing rating" accepted |
| MF | Bout label from participant 0, not the side | "Bout: defeat" where "Bout: victory" was due |
| MG | Return stage written at the minute-60 reveal | minute 60 already showed the return stage |
| MH | Bout reveal due at the slot start | a reveal was claimable at minute 59 |
| MI | Standings ranked by rating alone | wrong order among equal ratings |
| MJ | The projector writes no standings rows | no season, no rows |
| MK | Pairing history bound S − 17 | the pairing executor failed closed |
| ML | Settlement samples time before the rating-row lock | an expired lease settled after the proven wait (`ok: true`) |
| TM1 | `prepareActivityV1` ignores gear history | the acquisitions case stayed Bronze |
| TM2 | League from allocated instead of earned points | both the Training and the acquisitions cases |

ML is the meaningful RED the concurrency override asks for: with time sampled before the new rating-row wait, settlement
used pre-wait time; the correction samples after every lock.

## Tests (phase 2b, `tests/db/arena.test.ts` unless noted)

- **`settleNpcWin`** (plan Step 1): `{renown: 3, ratingDelta: 0}`, rating 1000 and counters 0/0, money 100, no XP and no
  training point, an `arena` ledger row, the stages `Warming up` / `Bout: victory` / `Results credited`, and the NPC logged as
  `npc:<entrant>` with a null `gladiatorId` from the frozen template. The battle seed is private and random and the starter
  build beats its fallback about nine times in ten (a scratch probe over 4,000 seeds measured 0.90–0.92), so the helper
  repeats fresh slots, up to eight, until a credited win; a loss on the way must credit 0 renown.
- **Human bout:** the job graph (one simulation anchored to side 0 with the battle seed; each side's reveal and settlement
  with its activity seed, due at minutes 60 and 80, with their dependencies); no opponent id or name in any owner,
  spectator, world or profile read before the reveal; the same log in both bout stages with opposite labels and equal end
  times; 10 and 2 renown, Elo +12/−12, counters 1/0 and 0/1, the rating cache and public profiles; exactly one success;
  owners read their summary, a spectator only the public completion.
- **The second side settles after the first moved its own row** (the first settlement moves only its own row).
- **Simultaneous settlement retries:** six concurrent calls (three per side): one grant per side, two replays each, one
  ledger row and one return stage each; a later retry replays.
- **Frozen/live mismatch:** `{ok:false, code:'operator'}`, `rating-mismatch` on the job and its attempt, nothing credited to
  that side, the other side settles, boundary 301 waits with `operator`, and after repair and resume the same job settles.
- **Malformed hook:** a stand-in hook applies the real Arena writes and returns negative renown; both settlements fail and
  roll back rating rows, counters, cache, renown, ledger, return stages and checkpoints; after restoring (verified), both
  settle once.
- **Bout-result rejection:** 32 forged results per battle are refused with nothing written; the valid one is frozen once,
  replays, and cannot be updated.
- **Lock waits:** `complete_job` (job row) and `settle_activity` (job row, and the new rating row) block while their lease is
  valid, resume after database expiry, and return `conflict` with no write.
- **Stages only when due** (rollback-only transaction under database time): minute 0 only the warm-up; minute 59 no reveal or
  settlement claimable and no opponent in stages or owner state; minute 60 both bout stages; minute 79 nothing credited;
  minute 80 both credits with their return stages and `replayExpiry` available until minute 80 + 7 days.
- **Banked points by real Training settlement:** 104 → 105 earned stays Bronze after the settlement and becomes Silver only at
  the next boundary, keeping the Bronze row.
- **Real Task 8 acquisitions and a real Task 6 respec** at the current slot, then the next boundary in a rollback-only
  transaction: never-equipped light boots, bought and then sold, keep history 30 (Silver); a bound renown sword scores 30.4
  with its arena bonus and cannot be sold (Silver); a second common sword adds nothing (Bronze); a paid respec lowering
  Strength keeps 105 earned points (Silver). Every cache was still Bronze before the boundary.
- **Standings:** 52 Bronze rows of season 1 plus an older season-0 row and a promoted character: two pages (50 + 2) in exact
  spec order, the flags, the Silver and empty Champion pages, only public columns, anonymous denial, cursor rejection, and a
  rating change republished with a revision bump.
- **Access denial:** the five private Arena tables (now with `arena_results`), the standings table and view privileges, 17
  private functions including `pairing_input`, client denial of `settle_activity`, and no seed, simulation input or private
  outcome in any client read.
- **Unit:** the Arena executor (log and outcomes, NPC identity and name, frozen silhouette order kept, fail-closed inputs),
  the discriminator (five unknown inputs → `unsupported-executor`), expedition dispatch unchanged, the history bound and the
  operator outcome; the standings read (pages, cursor, flags, malformed input, empty world) and the live gateway read.
- **Browser** (`tests/browser/arena-live.spec.ts`, development only): a signed-in live owner with an Arena activity opens
  "Your arena bout" and sees "Warming up" from the live timeline read; the Standings tab shows live rows and the owner's
  combat strength from the live profile read.

### Affected existing tests

- `arena.test.ts` (2a): four cases expected phase 8 `integration` after pairing; Arena now publishes, so they expect phase 9
  `complete` (and, for the pairing-job case, the debit and one simulation job). The 2a 50-entrant pairing measurement is
  replaced by the 2b measurement below, keeping its pairing assertions.
- `activities.test.ts`, "starts expeditions and Arena entrants once their executors exist…": the Arena entrant now starts
  (stamina 79, processed 300) instead of waiting at phase 8.
- `worker.test.ts`: the existing pairing inputs gain `historyFromSlot`.

## Timing (50 entrants, real scheduled dispatch)

The test shifts the database clock (a stand-in restored and verified in `finally`) to just after the next cutoff, so the
boundary is processed on time and the minute-60 reveals stay in the future. It enables the scheduler and calls
`private.cron_tick()` (coordinate, then dispatch at most five worker invocations per rolling minute) once a second instead of
once a minute; every invocation is the real private Edge worker through pg_net.

| Measurement (database time, from the boundary opening) | Result |
| --- | --- |
| All 50 preparations completed | 0.12–0.41 s |
| Both pairing jobs completed | 1.06–1.10 s |
| Boundary published (phase 8: debit, jobs, warm-ups) | 1.07–1.11 s |
| All 25 bouts simulated and frozen | **61.7–61.9 s** |
| Wall clock, first tick to all simulated | 62.7–62.8 s |
| Worker invocations | 9, all HTTP 200 with no failure |
| Target (spec §10.4) | 120 s |

Six runs gave the same picture. The simulation time is bounded by the dispatch budget, not by compute: three invocations go
to preparation, so only two of the five simulation invocations fit in the first rolling minute and the other three wait for
it to free. With cron's one-minute tick the simulations likewise start at the next tick, about 60 s after the boundary.
This is the local stack, not hosted evidence (Task 23).

## Migration

- **Iteration.** `08-arena-bouts.sql` was applied through the documented `docker exec -i supabase_db_Cloudiator psql`
  fallback after checking the container's `com.supabase.cli.project` label. Lint found a shadowed loop variable in
  `accept_arena_result`; the declaration was removed and the source reapplied. Then lint was empty and advisors showed four
  INFO unused-index notices, all existing.
- **Generation.** `npx supabase db pull arena_bouts --local --schema public,private --yes` (CLI 2.120.0, engine `migra`)
  wrote `20261014131209_arena_bouts.sql`. It re-emits no unchanged function: 3 new and 7 changed functions.
- **Completion** (AGENTS.md), normalized to CRLF like the other migrations: the view's `security_invoker=true` and its
  grants; source-equivalent revokes before the table grants; the function revoke/grant pair; the standings backfill
  `select public.refresh_projections();`; a provenance header and `notify pgrst`.
- **Replay.** `npx supabase db reset --local --no-seed --yes` replayed M01–M10 with no source applied afterwards.
- **Comparison.** The sanitized schema fingerprint (667 entries, 687 lines: function definition hashes, search paths,
  security, volatility and ACLs; table and view ACLs, RLS, options and view definitions; policies, triggers, constraints,
  columns, indexes, the cron job and seed rows) matched the source exactly, and was identical again after the tests.
- **Tests on the replay:** **137/137** in seven files with the Edge container stable (identity 11, planning 15, activities 36,
  shops 21, expeditions 20, projections 6, Arena 28). Lint empty; advisors four INFO notices, none on the new tables;
  `migration list --local` shows M01–M10 applied.

## Final commands (in `verification-gates.md` order)

| Command | Result |
| --- | --- |
| `npm test` | **883 passed**, 36 files (872 + 11). |
| `npm run typecheck` | Exit 0: `tsc` clean, frozen Deno check of `game-command` and `game-worker`, 2 Deno runtime tests passed. |
| `npm run test:db` on the M01–M10 replay | **137/137**, Edge start time unchanged across the run. Two earlier replay runs also passed 137/137 but had an Edge recreation during the run, so they are not counted. After a PC reboot and stack restart, a further run passed **137/137**, Edge stable. |
| `node assets/source/build-assets.mjs --check` | Up to date (28 files). |
| `npm run build`, then `npm run verify:static` | 5 fixed routes, 91 assets, no forbidden backend material. |
| `npx playwright test -c node_modules/.cache/pw-claude.config.mjs` (port 3200) | **260 passed, 8 skipped** (258 + the two live-panel cases). No dev server was left on 3200. |
| Isolated production gate: `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build`, `npm run verify:static -- .next/browser-test`, `PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test` with the private config | Build and scan clean (5 routes, 91 assets); **14 passed, 254 skipped** by design. |
| `git diff --check`, `git diff --cached --check` | Clean. |

## Environment notes

- **Edge recreations.** Three DB runs saw the Edge container recreated a few seconds after they started. The background
  `functions serve` log showed `File change detected … (WRITE)` for Edge source files (`commands.ts`, `http.ts`, `types.ts`,
  and earlier `deno.json`, `deno.lock`) whose content `git status` showed unchanged, while host tools (vitest, `tsc`, `deno
  check`) were reading them; it then restarted the runtime. This is an observation, not a confirmed cause or a tested fix.
  Every counted run had an unchanged start time.
- Git Bash `sed -i` rewrote `tests/db/arena.test.ts` to LF once; CRLF was restored with Node before anything was staged.
- A JavaScript `String.replace` used to splice a test block treated a dollar-backtick sequence in the inserted text as a
  replacement pattern; the splice failed its own uniqueness check and was redone with a replacer function before anything
  was written.
- No package or tool was downloaded. Scratch probes ran on the installed Node 22.19 from the session scratch directory.

## Remaining gates

- **Task 19 (tournaments):** `private.boundary_pair` still returns `integration` for tournament entrants. `pairing_input`
  reads only regular `pair` assignments as history; Task 19 phase 2 must add its human tournament bouts, one row per bout.
  Tournament settlement can reuse `arena_rewards`' pattern, but bouts of a bracket apply ratings in round order.
- **Task 21 (seasons):** season close, archives and placement rewards on the same epoch; `archived: true` standings pages
  and the real reward-eligibility rule (highest league with qualifying participation). `rewardEligible` here only marks five
  human bouts in that league.
- **Task 22 (retention):** prune `private.arena_results` before its assignment and its simulation job, assignment sides and
  stages before their activities, and assignments before their pairing jobs (foreign keys). Detailed logs in stages and
  results follow the seven-day replay rule; `arena_standings` follows its gladiator.
- **Task 23 (load):** hosted timing at 50 characters. Locally the simulations take one dispatch-budget minute; a slot with
  far more than 25 Arena battles would need more than five combat invocations and exceed one minute per 25 battles.
- **Task 24 (deployment):** set `private.season_epoch` at launch, no later than the first boundary with members the
  coordinator will process (`select min(processed_slot_index) from public.gladiators;`). Ship M09, M10 and the worker in
  one release step, then check that no `pair`, `prepare` or `simulation` job is in operator state: the new worker fails a
  pairing input without `historyFromSlot` closed, and an older worker cannot simulate Arena bouts. Store the Vault
  secrets, enable the scheduler and prove hosted dispatch, as Task 7 recorded.

## Open items and concerns

- **TDD deviations:** the bout-result rejection case and the three lock-wait regressions were written after the SQL; their
  power is shown by mutations MD, ME, MP and ML. The Training and acquisition cases pin 2a behaviour (TM1, TM2).
- **NPC display name** "<League> Sentinel" is a presentation choice made here; views identify the NPC by its null
  `gladiatorId`.
- **Historical slots** settle with `replayExpiry: expired` (seven days after the activity ended), as Task 9 does.
- **Empty world standings** report `seasonId: ''` until any rating row exists, because the epoch is private.
- **Balance:** the weakest entrant of a stable odd league keeps getting the NPC (Avi's option A, phase 1).
- **Deferred Minors carried:** Task 17 review Minor 1 (labels on a clamped target with real logs) and Task 10's initial
  clock-offset bias; Task 17's two-reads-per-human-pair Minor (M7) could use a pairing hint later.

## Skill upkeep

No skill change is applied. One observation for the controller to raise with Avi if wanted (observed, cause unconfirmed,
mitigation untested): `docs/operations/local-runtime.md` could record that `supabase functions serve` restarted the Edge
runtime on `WRITE` file events for unchanged Edge sources during host-side reads, so DB runs should start only after builds,
typechecks and edits have settled, with the start-time check kept.
