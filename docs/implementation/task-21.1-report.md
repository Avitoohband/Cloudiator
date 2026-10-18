# Task 21.1 report: close a season in the database

- **Status:** DONE_WITH_CONCERNS. Every gate passed. The main concern is about Task 21.2: the grants that Decisions 3 and 5 require block a boundary run as `service_role` (concern 1).
- **Branch and base:** branch `claude/task-21` in `C:\Avi\Studies\Projects\Cloudiator-claude`, base `d8057c6`.
- **Commit:** `ab4b1a0 feat: close seasons into a frozen archive with one-time rewards`. It is not pushed.
- **No migration.** Task 21.2 generates M15. While iterating, I applied `supabase/sql/13-seasons.sql` to the local database with the tested psql fallback (below). `private.boundary_close_season` is still Task 7's stub.

## What I implemented

### Source: `supabase/sql/13-seasons.sql` (new)

The source is reapplicable: I applied it three times, and the second and later runs exited 0 with only "does not exist, skipping" notices. Its header documents:
- the ranking and eligibility rules;
- the lock order: the coordinator (held by the caller), then the season row, then each award's account lock in gladiator order, then its wallet;
- why the archive has no foreign key;
- three accepted exceptions: restated constants, the guard's unlocked season read, and the Decision 3 and 5 grants.

**Tables (Decision 3)**
- **`public.seasons`**
  - Columns and checks as decided: `ends_at_ms = starts_at_ms + 2419200000`.
  - The `guard_season` trigger, through `private.guard_season()`:
    - refuses DELETE;
    - refuses any change to `season_index`, `starts_at_ms` or `ends_at_ms`;
    - allows an UPDATE only when it moves `closed_at_ms` from null to a value, once.
- **`public.season_standings`**
  - Columns, primary key `(season_index, league, gladiator_id)` and unique `(season_index, league, rank)` as decided.
  - No foreign key.
  - `guard_frozen` refuses UPDATE and DELETE.
- **`private.season_awards`**
  - Columns, primary key, unique `(season_index, league, place)`, unique `receipt_id`, and foreign keys to `gladiators` and `operation_receipts`, as decided.
  - `guard_frozen` refuses UPDATE and DELETE.
  - An index on `gladiator_id` serves the foreign key and the prestige lookup.
- **Grants**
  - `seasons` and `season_standings`: RLS on; revoke all from public, anon, authenticated and service_role; SELECT to anon and authenticated with a `player_read … using (true)` policy; select/insert/update/delete to service_role.
  - `season_awards`: RLS on; revoke all; service_role SELECT only, with the `backend_only` policy.

**Functions**
- **`private.season_rules()`** is immutable. It returns `{minimumHumanBouts: 5, placements: [...]}` with exactly `RULES_V1.seasons`' values. Service_role only.
- **`private.guard_arena_rating()`**, replaced: 07-arena.sql's checks, plus it refuses any UPDATE of a row whose season row has `closed_at_ms` set.
- **`private.project_character(uuid)`**, replaced: 08-arena-bouts.sql's projector, unchanged, plus `public_profiles.prestige` set from `private.season_awards`.
  - Each entry is `jsonb_build_object('seasonIndex','league','place','badge','title')`, ordered by `season_index`; the default is `'[]'`.
  - The upsert changes the row only when the rating or prestige differs.
  - A deferred `project_changed_character` constraint trigger on `private.season_awards` republishes the character.
- **`public.arena_standing_reads`**, replaced: the same columns, plus a last column, `reward_eligible`.
  - It is true when the row has at least 5 human bouts and no higher league row of the same character and season also has at least 5.
  - Still `security_invoker=true`.
  - Revoke all from everyone, then re-grant SELECT to anon, authenticated and service_role.
- **`private.close_season(season bigint, now_ms bigint) returns integer`** (Decision 5). Granted to nobody.
  1. Locks the season row `FOR UPDATE`. It returns 0 when the season is already closed.
  2. Inserts one archive row per season rating row, with the name from `public.gladiators`:
     - `rank`: rating desc, human wins desc, human losses asc, gladiator_id;
     - qualifies: `human_wins + human_losses >= minimumHumanBouts`;
     - `reward_eligible`: qualifies, and no higher qualifying league row of the character (`private.league_rank`);
     - `award_place`: the row number among the league's eligible rows in the same order, kept for 1–3;
     - `promoted`: a higher league row exists that season;
     - `inactive`: zero human bouts.
  3. For each award, in `gladiator_id` order:
     - takes `pg_advisory_xact_lock(hashtextextended(owner_id::text,0))`;
     - locks the wallet `FOR UPDATE`;
     - credits `least(rule amount, 9007199254740991 − balance)`, for money and renown separately;
     - writes the receipt: owner `owner_id`, a generated `operation_id`, request `{kind:'season-award', seasonIndex, league, place}`, `request_digest = extensions.digest('season:'||season||':'||gladiator_id,'sha256')`, and result `{seasonIndex, league, place, money, renown, title, badge}`;
     - writes a `wallet_ledger` row with reason `'season'` and the credited deltas;
     - writes the `season_awards` row.
  4. Sets `closed_at_ms = now_ms` and returns the number of awards.

### Test changes
- `tests/db/seasons.test.ts` (new): the 15 tests named in the brief. Characters are created for real. Rating rows and season rows are seeded by SQL, and the tests call `private.close_season(season, now)` as the owner.
- `tests/fixtures/db.ts`: `resetIdentity` also truncates `public.seasons`, `public.season_standings` and `private.season_awards`.
- `tests/db/visitor-access.test.ts`: `OPEN` gains `seasons` and `season_standings`.
- `tests/db/arena.test.ts:1284`: the view's column list gains `reward_eligible`.

## Tests and results

Each `npm run test:db` run below recorded `docker inspect -f '{{.State.StartedAt}}' supabase_edge_runtime_Cloudiator` before and after. Nothing else built, browsed or edited during a run.

| Run | Command | Edge StartedAt before / after | Result |
|---|---|---|---|
| RED | `npm run test:db -- tests/db/seasons.test.ts` | `2026-10-18T11:14:16.442275829Z` / same | 15 failed (15) |
| GREEN 1 | same | same / same | 13 passed, 2 failed (test reads, below) |
| GREEN 2 | same | same / same | 15 passed (15) |
| Full 1 | `npm run test:db` | same / same | 11 files, 208 passed (208) |
| Full 2 (final source) | `npm run test:db` | same / same | 11 files, 208 passed (208), 164.9 s |

### RED (TDD)

- **Command:** `npm run test:db -- tests/db/seasons.test.ts`, with the new test file and the fixture change, before `13-seasons.sql` existed.
- **Relevant output:**
  ```
  PostgresError: relation "public.seasons" does not exist
   Test Files  1 failed (1)
        Tests  15 failed (15)
  ```
- **Why this was expected.** The season storage did not exist. The failure surfaces in `beforeEach`, at `resetIdentity`'s new truncate of the season tables, before any test reaches `close_season`. The brief expected "close_season does not exist". This failure comes one step earlier, for the same missing implementation. The fixture keeps its "no schema creation here" rule.

### GREEN

- **Apply** (the tested local fallback, against the confirmed `supabase_db_Cloudiator` container of the Cloudiator stack): `cat supabase/sql/13-seasons.sql | docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1`, exit 0.
- **GREEN 1 failures, both in test code:**
  - The cap test read wallets as `float8`. Its text output rounded 9,007,199,254,740,991 to …990, while the stored values were exact. Wallets are now read as text and converted with `Number`.
  - `order by 1 collate "C"` collated the literal. It now orders by the expression.
- **GREEN 2:** `Test Files 1 passed (1) / Tests 15 passed (15)`.
- **`npm test`:** 45 files, 1020 tests passed.
- **`npm run typecheck`:** exit 0 (`tsc`, `deno check`, and 2 Deno edge tests ok).
- **`npm run test:db` (all suites, final source):** 11 files, 208 tests passed. The output has no warnings or errors.
- **`git diff --cached --check`:** clean.

## Self-review

I checked completeness against Decisions 3–5 and the task text, names, existing patterns (12-market.sql and 10-tournament-results.sql grants, `guard_frozen`, the deferred projection hook, `extensions.digest`), and test output. These changes came from the review:
- I renamed the projector's prestige variable to `awarded_prestige`.
- The header now notes that the receipt insert also takes KEY SHARE on the owner's `auth.users` row, as a settlement receipt does.

I found no functional issue.

### Additions beyond the Decisions (all additive)
- `season_standings`:
  - `check (award_place is null or reward_eligible)`;
  - `rank >= 1`;
  - range checks on rating and the counters.
- `season_awards`:
  - NOT NULL on the decided columns, except `title`;
  - money and renown within 0..9,007,199,254,740,991;
  - a league check;
  - an index on `gladiator_id`.
- `close_season` raises `invalid season close` for a null argument and `unknown season` when the season row is missing. The Decision does not cover either case, so I made both fail closed.
- `guard_season` also refuses a no-op UPDATE of an open season. Only null → value of `closed_at_ms` is allowed.

### Concerns

1. **Grants for Task 21.2 (Decisions 3 and 5).**
   - As decided, `private.close_season` is granted to nobody and `private.season_awards` gives service_role SELECT only.
   - But the worker calls `public.coordinate_work()` as service_role through RPC, and service_role may execute it. The existing boundary tests also call `advance_boundary` as service_role. Every function is security invoker, so when phase 2 calls the close, it runs as service_role.
   - I verified this in a rolled-back transaction: `set local role service_role; select private.close_season(999,1)` failed with `ERROR: permission denied for function close_season`. In the catalog, `has_table_privilege('service_role','private.season_awards','INSERT')` is false and `has_function_privilege('service_role','public.coordinate_work()','EXECUTE')` is true.
   - So 21.2 will need to grant service_role EXECUTE on `close_season` and INSERT on `season_awards`, or route the close differently. The privilege assertions in the last `seasons.test.ts` test encode the current Decision, so they will need to change with it.
   - I did not change this myself, because the Decision is explicit.
2. **The guard's unlocked read (exception 2).** `guard_arena_rating` reads `public.seasons` without a lock. Locking the season row there could deadlock a settlement with a close. It relies on 21.2's phase-1 invariant: no settlement of a season is pending when that season closes. 21.1 does not test that interleaving.
3. **The account lock is taken but not tested in isolation.** No test holds an account lock to prove that the close waits for it; the brief's list did not include one. 21.2's boundary tests exercise the close under real boundary locking.
4. **The view restates the qualifying minimum 5.** A visitor's security-invoker read cannot call `private.season_rules()`. The live-view test covers the 4/5 boundary and the highest-league rule against the same data the archive uses.

### Deviations from the brief
- The RED failure surfaced at `resetIdentity`'s truncate rather than at the `close_season` call (explained above).
- Otherwise none.
