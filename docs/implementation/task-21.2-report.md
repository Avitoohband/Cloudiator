# Task 21.2 report: close each season at its boundary (M15)

- **Status:** DONE_WITH_CONCERNS. Every gate passed. The concerns are a local-database incident during verification (fixed by
  a clean reset, details below) and one residual lock-order observation.
- **Branch and base:** `claude/task-21` in `C:\Avi\Studies\Projects\Cloudiator-claude`, base `2110d3a`. Nothing is pushed.
- **Commits:**
  - `c615091 feat: close each season at its boundary`: the source, M15, the tests, `season.ts` and `migrations.md`, with the
    Task 21.1 review minors M1–M3.
  - `ef11c19 docs: mark the Task 21.1 report's superseded grant lines`: minor M4.
  - This report is committed separately as `docs: report Task 21.2`.

## What I implemented

### Phase 2: `private.boundary_close_season(target bigint) returns text` (Decision 6)

It replaces Task 7's stub in `supabase/sql/13-seasons.sql` with the same signature, now `plpgsql volatile`.
- It returns null when `private.season_index(target)` is null. Phase 4 then waits with `epoch`, as before.
- Otherwise it samples `private.planning_now_ms()` once. It runs inside `advance_boundary`, so this is after the
  coordinator lock and the boundary row lock.
- It closes every `public.seasons` row with `closed_at_ms is null and season_index < season_index(target)`, in ascending
  order, through `private.close_season(season, now_ms)`.
- It then inserts the row for `season_index(target)`, with bounds `(epoch + 504 × index) × 4,800,000` ms and
  `on conflict do nothing`.
- It always returns null and never holds the phase.
- Grants: revoked from public, anon and authenticated, with EXECUTE granted to service_role, as 21.1's functions are
  (`03-activities-jobs.sql` already granted it to service_role, and `create or replace` keeps that).

It closes by season row, not at "the first boundary of a season". So a season whose first boundary `coordinate_work` skips
still closes at the next boundary that runs (Review Focus 3).

### Backfill

At the end of the source, and completed into M15: one `public.seasons` row for each distinct season in
`private.arena_ratings`, with the same epoch bounds and `on conflict do nothing`.

### `seasonAt` (Decision 2)

`supabase/functions/_shared/domain/season.ts` holds only `SeasonWindow = { index, firstSlot, endSlot, startsAtMs, endsAtMs }`
and `seasonAt(slotIndex, epochSlot)`.
- It reads `RULES_V1.seasons.durationSlots` and `RULES_V1.clock.slotMs`.
- It throws `RangeError` when either value is not a nonnegative safe integer, when `slotIndex < epochSlot`, or when the
  season's end time is not a safe integer.
- The DB tests compare the `public.seasons` rows against it, and 21.1's `openSeason` fixture now uses it.

### Task 21.1 review minors

- **M1.** `close_season`'s `promoted` and `eligible` flags now use window aggregates over `partition by gladiator_id`:
  - `max(league_order) over w > league_order`;
  - `qualifies and league_order = max(case when qualifies then league_order end) over w`.

  The CTE is referenced once, so it is no longer materialized and scanned per row. All 15 Task 21.1 tests keep their exact
  results.
- **M2.** The guard test adds `update public.seasons set closed_at_ms=1, starts_at_ms=1, ends_at_ms=SEASON_MS+1 where
  season_index=1`, expecting `immutable season`. This exercises the bounds clause alone.
- **M3.** The three Data API probes are kept, now labeled as exposure checks, not privilege proof. The catalog checks carry
  the privilege proof.
- **M4.** In `docs/implementation/task-21.1-report.md`, the status line, both grant bullets, `close_season`'s "granted to
  nobody" and concern 1 now say they were superseded by the pre-review adjustment (`61274dd`).

### Other changes

- The source header documents the season rows, phase 2, the lock order including phase 2's single clock sample, errors and
  retries, and why the guard's unlocked read is safe for tournament settlements too (the reviewer's note).
- The 21.1 privilege test now also covers `boundary_close_season`: no client EXECUTE, service_role EXECUTE, `plpgsql`,
  volatile.

### Files changed

- `supabase/sql/13-seasons.sql`
- `supabase/migrations/20261018123715_seasons.sql` (M15, new)
- `supabase/functions/_shared/domain/season.ts` (new)
- `tests/domain/season.test.ts` (new)
- `tests/db/seasons.test.ts`
- `docs/operations/migrations.md` (M15 section)
- `docs/implementation/task-21.1-report.md` (M4)

## Tests (all 8 named in the brief, plus the domain tests)

Every boundary test drives real boundaries: `advance_boundary` and `coordinate_work` as service_role through the Data API,
canonical preparation and pairing, the real simulation and reveal executors, and the real worker settlement adapter.
- **creates each season row at its first boundary with seasonAt bounds**
  - First, in a rollback-only transaction with the epoch at 10: phase 2 for slot 9 creates nothing, and slot 700 creates
    exactly `seasonAt(700, 10)`'s row.
  - Then, at epoch 0, boundary 503 creates season 0's row before its rating row exists.
  - Boundary 504 closes season 0 at a time between its own boundary's open and complete times, and creates season 1's row.
  - Boundary 505 changes nothing.
- **counts a human bout started in slot 503 in season 0 and waits to close until it settles at 504**
  - The assignment is `season 0, slot 503`.
  - With one side settled, and again before the second, boundary 504 waits at phase 1 with `settlement`, with no close, no
    archive and no season 1 row.
  - After both settle, the archive holds 1012 (1–0) and 988 (0–1), and nobody is paid (one bout is below the minimum).
- **closes season 0 at boundary 504 before phase 4 starts season 1 ratings at 1000**
  - When boundary 504 waits at phase 4 for preparation, season 0 is already closed and archived from its settled rows.
    No season 1 rating row exists yet, and the character cache still holds 1012 and 988.
  - After the boundary completes, the season 1 rows are at 1000, the cache is 1000, the slot-504 snapshots start at 1000
    and the slot-504 assignments are in season 1.
  - Season 0's rows refuse an update, and the archive is unchanged.
- **places a gladiator promoted at boundary 504 in the new league only in season 1**
  - Both characters have four seeded bouts, so their slot-503 bout is the fifth. `a`'s banked points are raised after
    boundary 503's phase 4, so `a` promotes at 504.
  - Season 0 has only Bronze rows: `a` is not marked promoted there, and both are paid places 1 and 2 in Bronze.
  - In season 1, `a` has only a Silver row at 1000, and `b` only a Bronze row.
  - `a` has exactly one season-award receipt (Bronze), and its prestige shows it.
- **closes a season whose final slot held a tournament only after every entrant settled** (the reviewer's note)
  - A `private.season_index` stand-in ends season 0 with slot 301. It is captured with `pg_get_functiondef` first,
    restored in `finally` and verified byte-equal.
  - Four opted-in entrants play the slot-301 tournament (`season_index` 0).
  - Boundary 302 waits at phase 1 with `settlement` while one, and then three, entrants are unsettled. Season 0 stays open,
    with no archive.
  - After all four minute-80 settlements, every season 0 rating row equals that entrant's `tournamentOutcomes` rating,
    wins and losses (3 wins in total).
  - The close then happens with `closed_at_ms ≥ max(settled_at_ms)`, and the archive holds exactly those values.
- **closes the season at the next boundary run when coordinate_work skips boundary 504**
  - `coordinate_work` returns `publishedSlot 509` and one report, for boundary 510, waiting at phase 4.
  - Only boundary 510 exists. It closed season 0 (archive plus one award) and created season 1's row with
    `seasonAt(510, 0)`'s bounds.
- **rolls back a failed close entirely and pays once on the retry**
  - A temporary AFTER INSERT trigger on `private.season_awards` raises on the close's second award, after the first award
    was fully paid. It is always dropped in `finally`.
  - `coordinate_work` reports `boundary-failed` with SQLSTATE `P0001`. Seasons, archive, awards, receipts, ledger,
    prestige and wallets are all unchanged, no boundary row remains, and the coordinator records `P0001` and slot 504.
  - The next coordination pays places 1–3 once each: one receipt, one ledger row and one credit per winner.
  - Finishing boundary 504 (and reaching 505) changes nothing more.
- **replays a completed boundary with no new awards**
  - After boundary 504 completes, replaying `advance_boundary(504)` returns `replayed: true`.
  - Phase 2 rerun directly as service_role, and the whole of boundary 505, leave the close state unchanged.
- **`tests/domain/season.test.ts` (9 tests):** the brief's four expectations; seasons 0–2 at epoch 0; epoch 10 bounds;
  `RULES_V1` consistency; a slot before the epoch; the unsafe values -1, 0.5, NaN, Infinity and MAX+1 for either argument;
  and an overflowing season.

## TDD evidence

Each DB run recorded `docker inspect -f '{{.State.StartedAt}}' supabase_edge_runtime_Cloudiator` before and after.

### RED

1. **Domain.** `npx vitest run tests/domain/season.test.ts`:
   `Error: Cannot find package '@domain/season'`, `Test Files 1 failed (1)`.

   Writing `season.ts` then gave 9/9. This was done before the DB RED, because the DB file imports `seasonAt`.
2. **DB.** `npm run test:db -- tests/db/seasons.test.ts` against the 21.1 source (phase 2 still the stub). StartedAt was
   `12:24:15.094389683Z` before and after. Result: `Tests 8 failed | 15 passed (23)`. All 8 new tests failed because no
   season row was created or closed:
   - `expected [] to deeply equal [ { index: +0, … } ]`;
   - `expected null not to be null` (the skip test);
   - `expected [] to have a length of 3` (the replay test);
   - and similar.

   The 15 Task 21.1 tests passed, including the new M2 assertion.

The Edge container restarted at `12:24:15Z`, just before that run, when `season.ts` was created in the served functions tree.

### GREEN and the full runs

| Run | Database | Edge StartedAt before / after | Result |
|---|---|---|---|
| seasons file | iterating database, source applied | `12:24:15.094389683Z` / same | 23/23 |
| full 1 (**discarded**) | same | `12:24:15.094389683Z` / `0001-01-01T00:00:00Z` (container recreated as the run ended; back at `12:28:55.256387486Z`) | 216/216, does not count |
| full 2 | same | `12:28:55.256387486Z` / same | 216/216 |
| **source, counted** | clean M01–M14 reset, source applied once | `12:32:20.461012572Z` / same | **216/216**, 11 files, 171 s |
| **replay 1, counted** | M01–M15 replay | `12:32:20.461012572Z` / same | **216/216**, 169 s |
| replay 2 | M01–M15 replay after the restoring reset (below) | `12:32:20.461012572Z` / same | 216/216 |
| **replay, final** | same replay, after adding the `boundary_close_season` privilege assertion | `12:32:20.461012572Z` / same | **216/216**, 165 s |

- The Edge container also restarted at `12:32:20Z` while `npm run typecheck` (deno check) read the Edge sources. No DB run was
  active then.
- **`npm test`:** 46 files, 1029 tests passed.
- **`npm run typecheck`:** exit 0 (`tsc`, `deno check`, Deno edge tests 2/2).
- **`git diff --cached --check`:** clean.

### Mutation checks

Each mutation was applied with psql and run against `tests/db/seasons.test.ts`, with the Edge start time stable. The source
was then reapplied, and later the database was reset to M14 and the source applied once.

| Mutation | Result |
|---|---|
| Phase 2 closes the previous season only at a season's first boundary | 1 failed: the `coordinate_work` skip test (`expected null not to be null`) |
| `promoted` uses `>=` in the window | 8 failed (five 21.1 archive tests and three boundary tests) |
| `eligible` ignores qualification (`= max(league_order)`) | 1 failed: "rewards a promoted gladiator only in the highest qualifying league…" |

## M15

### Generation

- **Baseline.** I reset to M01–M14 (`db reset --local --no-seed --yes`). Its fingerprint was 956 lines, matching M14's
  record. I then applied `13-seasons.sql` once with the local psql fallback, after confirming the container label
  `com.supabase.cli.project=Cloudiator`.
- **Generation.** `npx supabase db pull seasons --local --schema public,private --yes` (CLI 2.120.0, `engine":"migra"`)
  wrote `supabase/migrations/20261018123715_seasons.sql` and recorded it as applied.
- **Artifacts.** The original draft is kept at `scratchpad/t212/draft-original.sql`, and the completion script at
  `scratchpad/t212/complete-m15.cjs`. Both draft and completed file are LF.

### How the draft differed from the tested source, and what I completed

1. **Trigger order.** It created `guard_season` on `public.seasons` in the public section, before `private.guard_season()`,
   which it creates later. The trigger now follows its function.
2. **Lost `security_invoker`.** Its `create or replace view public.arena_standing_reads` had no `WITH` options.
   PostgreSQL replaces a view's options on `CREATE OR REPLACE VIEW`, so the view would have lost `security_invoker`.
   `with (security_invoker=true)` is restored.
3. **No table revokes.** It had only grants. Source-equivalent `revoke all … from public, anon, authenticated, service_role`
   statements now precede them on `seasons`, `season_standings` and `season_awards`.
4. **No view grants.** The source's revoke/grant pair for `arena_standing_reads` is added.
5. **No function ACLs.** The source's revoke/grant pair is appended for `season_rules`, `guard_season`,
   `guard_arena_rating`, `project_character`, `close_season` and `boundary_close_season`.
6. **No backfill.** The source's statement is added, together with a provenance header and `notify pgrst`.

The draft re-emits no unchanged function: it has exactly those six. Their bodies came from the database where the source
was applied. The other triggers use the existing `guard_frozen` and `project_changed_character`.

### Replay, parity, lint and advisors

- **Replay.** `db reset --local --no-seed --yes` replayed M01–M15, with no source applied afterwards.
- **Parity.** The fingerprint (`scratchpad/t212/fingerprint.sql`, the M14 coverage) was 1029 lines.
  - The replay is **byte-identical** to the source-applied fingerprint.
  - It was identical again after each counted test run (source, replay 1, replay 2, final) and after the backfill check.
- **Lint** (`--fail-on warning`): empty on the source and on the replay.
- **Advisors** (`--level info --fail-on warn`), no WARN or ERROR on either:
  - source: 4 INFO;
  - replay: 5 INFO unused-index notices (`jobs_gladiator_idx`, `recent_results_gladiator_idx`,
    `market_listings_buyer_idx`, `market_listings_receipt_idx`, `market_offers_listed_idx`), none on the new tables.
- **`migration list --local`:** M01–M15, local and remote matching.

### Backfill check

A replay has no ratings, so the backfill inserts nothing during it. I therefore ran M15's backfill statement, extracted
verbatim, on the replayed database inside one `DO` block that always raises at its end.
- With ratings in seasons 0, 1, 3 and 7, it created exactly those four rows with the epoch-0 bounds. For example, season 3
  is `7257600000..9676800000`.
- Run again, it added nothing (still 4 rows).
- With the epoch at 10, the bounds followed it (season 0 is `48000000..2467200000`).
- Afterwards the epoch was 0, all triggers were enabled, `public.seasons` was empty and the fingerprint was identical.

## Self-review

- **Brief and decisions.** I checked the diff against Decision 6, Decision 2, the controller's grant ruling, M1–M4 and the
  reviewer's note:
  - the test names match the brief;
  - the stand-in and the injected trigger are both cleaned up in `finally`, and the stand-in is verified byte-equal;
  - the commit trailers are present.
- **Found and fixed:**
  - Nothing pinned `boundary_close_season`'s grants or its new `plpgsql volatile` form. The 21.1 privilege test now covers
    both.
  - Fixed a lexicographic numeric sort in one assertion.
  - Reflowed the header's lock-order paragraph.

## Concerns

1. **Local-database incident during verification (fixed; nothing hosted).**
   - **What happened.** My first backfill check was a psql script generated through a Node template. It lost the backslash
     of `\set ON_ERROR_STOP on`, so psql sent `set ON_ERROR_STOP on begin;` as one failing statement. The rest of the
     script then ran in autocommit.
   - **What it left committed on the local replay database:** `guard_season` and `season_epoch`'s `guard_frozen` disabled,
     the epoch at 10, four test rating rows and four season rows.
   - **Repair.** I found it from the "no transaction in progress" warning. I ran another clean
     `db reset --local --no-seed --yes`, which is allowed for this task's replay. After it, the fingerprint was identical,
     all triggers were enabled ('O'), there was no epoch row and the tables were empty. Replay run 2 then passed 216/216.
   - **Fix for the check.** The redone check uses a single always-raising `DO` block, which cannot commit.
   - **Gap it exposed.** The parity fingerprint covers trigger definitions but not trigger enablement (`tgenabled`) or data
     such as the epoch row, so it would not have caught this state. I added a separate trigger-enablement check and
     recorded the gap in `migrations.md`.
2. **Lock order (observation, not changed).** In one boundary transaction, phase 2 takes the awardees' account locks in
   gladiator order, and phase 3 then takes the members' locks in gladiator order. Across the two phases the order is not
   globally ascending. A concurrent two-account command, such as a market buy, could therefore deadlock with the boundary.
   - PostgreSQL then aborts one side atomically (40P01). A boundary abort is retried by the next coordination; the market
     adapter retries a purchase.
   - This is the residual already accepted in `migrations.md` (M14: a boundary does not always take its account locks in
     global order). It is not tested here.
3. **The skip test's world is operator-placed.** In a consistent world, every character rated in season 0 is due at 504, so
   `coordinate_work` cannot skip 504 while season 0 has ratings. The test seeds season 0's row and ratings for characters
   whose checkpoints are at slot 509. It proves that the close is keyed to open season rows, not to the boundary's slot.
4. **The close runs inside the boundary transaction,** as the controller ruled. A very large season lengthens that boundary.
   M1 removes the quadratic part.

## Deviations from the brief

- The DB RED ran after `season.ts` existed. The domain RED came first, because the DB file imports `seasonAt`. The DB RED
  still failed only because phase 2 was the stub.
- The skip, crash and replay tests seed season 0's row (with `seasonAt` bounds) and its ratings by SQL, as the 21.1 tests
  do. The boundaries themselves are real.
- Additive: the 21.1 privilege test covers `boundary_close_season`, and the domain test covers more cases than the brief's
  four.

## Proposed guide update (needs Avi's approval; not made)

Avi, shall I update `docs/operations/migrations.md`'s parity description (and the AGENTS.md generated-migration rule that
cites it) so the fingerprint also records each trigger's enabled state and the singleton seed rows (the season epoch)? I
would also add the rule that any rollback-only verification against the local database runs as one `DO` block that raises at
its end (a form that cannot commit), never as a generated multi-statement script relying on `begin`/`rollback`.

- **Observed failure:** concern 1.
- **Tested fix:** the `DO`-block check, which left the database unchanged by fingerprint, epoch and trigger state.
- **Proposed, untested:** the fingerprint extension.
