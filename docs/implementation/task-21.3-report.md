# Task 21.3 report: season reads

Branch `claude/task-21`, BASE `ed5a114`. Implementation commit `479583f feat: serve seasons, archived standings and prestige`. No schema change, no migration, nothing pushed.

## What was implemented

- **Contract types** (`supabase/functions/_shared/contracts/reads.ts`): `SeasonView`, `PrestigeAward`, `PublicProfile.prestige: PrestigeAward[]`, and `StandingRow.awardPlace: 1 | 2 | 3 | null`. `StandingsPage` keeps its shape.
- **Reads** (`src/lib/api/reads.ts`):
  - `readSeasons(client)` returns at most 50 `public.seasons` rows, newest first (`order season_index desc limit 50`), as `SeasonView` with `seasonId = String(season_index)` and `closedAtMs` null for the open season.
  - `readStandings(client, league, cursor?, seasonId?)` picks the season in the order cursor, `seasonId`, latest `public.seasons` row, then (only when `public.seasons` is empty) today's `arena_standings` maximum, then `seasonId ''` with no rows. An open season reads `arena_standing_reads` and takes `rewardEligible` from its `reward_eligible` column (the client-side five-bout computation, and the `RULES_V1` import, are gone; `awardPlace` is always null). A closed season (`closed_at_ms` not null) reads `season_standings` with `archived: true`, taking `rewardEligible`, `awardPlace`, `inactive` and `promoted` from the archive columns. The cursor format is unchanged (`season:rank`, 50 rows).
  - `parseStandingsRead(cursor?, seasonId?)` is exported (as `parseResultsCursor` and `parseMarketRead` are) so the fixture gateway applies the same rules. A `seasonId` must be a canonical non-negative integer string (`/^(0|[1-9]\d{0,14})$/`), and a malformed one is `unavailable` even beside a cursor, before any query. A `seasonId` that names no `public.seasons` row is `unavailable` after one lookup.
  - `readProfile` maps the projection's `prestige` (`{seasonIndex, league, place, badge, title}`) to `PrestigeAward` with `seasonId = String(seasonIndex)`. A prestige value that is not an array, or an entry that is not a well-formed award, is `unavailable`.
- **Gateway** (`src/lib/api/gateway.ts`): `GameGateway.seasons()` and `standings(league, cursor?, seasonId?)` (backward compatible), both through `publicRead`, so a visitor reads them with no session.
- **Fixtures**:
  - New `tests/fixtures/seasons.ts`: `FIXTURE_EPOCH_SLOT`, `FIXTURE_SEASONS` (built with `seasonAt`; newest first: `'1'` open, `'0'` closed), `FIXTURE_ARCHIVE` (season `'0'`) and `fixturePrestige`.
  - `tests/fixtures/arena-build.ts`: rows gain `awardPlace: null`; `arenaStandingsPage(league, seasonId = current, after = 0)` serves the current season or an archive and issues the live cursor `season:rank`; profiles carry `fixturePrestige`.
  - `src/lib/api/fixture-gateway.ts`: `seasons()` and `standings(league, cursor, seasonId)` with the live read's rules (malformed league/cursor/season id and an unknown named season are `unavailable`; a well-formed cursor of an unknown season ends the list with an empty page).
- **Test transport** (`tests/browser/live-routes.ts`): answers `seasons` and `season_standings`, serves `reward_eligible` in the view, and converts a profile's `PrestigeAward`s back to the projection's `seasonIndex` shape. Specs `arena-live.spec.ts` and `arena.spec.ts` got `awardPlace: null` in their row literals and expect a `seasons` read where they expected the `arena_standings` probe.

### Fixture epoch choice

`FIXTURE_EPOCH_SLOT = worldFixture.slotIndex − 504 − 252 = 373248 − 756 = 372492` (one and a half seasons before the fixture world's slot). Season `'1'` is slots 372996 to 373499 (2026-09-26T00:00Z to 2026-10-24T00:00Z); the world's slot 373248 is 252 slots (14 days) into it, in the middle, so the fixture world's Arena bouts (at most 5 slots old) are all in season 1 and the world is far from both boundaries. Season `'0'` is slots 372492 to 372995 (2026-08-29 to 2026-09-26), closed 3 s after its end (the coordinator closes it just after the boundary). A test asserts both indexes via `seasonAt`, the 28-day length, contiguity and that the world's time is more than 10 slots from each edge.

### Season `'0'` archive

56 Bronze rows (two pages of 50 + 6), 12 Silver, 3 Gold, no Champion rows. Derived for fixtures only (SQL stays the authority; the header says so) from each character's league rows with the close's rules, and pinned by name in the test:

- Bronze: Lucilla ranks first, was promoted to Silver where she also qualified, so she has no award in Bronze; the Bronze medals go to the next eligible rows (ranks 2 to 4): Severus (1st, champion, gold), Nerva (2nd), Aster (3rd, bronze badge).
- Silver: Lucilla (1st, champion), Marcellus (2nd, Bronze row only 4 bouts, so his Silver row is his reward row), a filler (3rd). Valeria's Silver row is promoted and ineligible.
- Gold: Valeria (1st, champion) and one more eligible row; only two eligible rows, so only two places are awarded.
- Inactive rows (Gallus, Ardea and fillers with no human bout) are never eligible, never promoted.
- Profiles carry the prestige of every named medalist (Aster: `[{seasonId:'0', league:'bronze', place:3, badge:'bronze', title:null}]`); everyone else has none. A test checks the archive and the profiles agree in both directions and that badges and titles equal `RULES_V1.seasons.placements`.

## Tests and TDD evidence

### RED (before any implementation)

`npx vitest run tests/reads.test.ts tests/api/live-gateway.test.ts tests/api/fixture-gateway.test.ts tests/api/projection-gateway.test.ts tests/domain/arena-fixtures.test.ts tests/domain/arena-panels.test.ts`

```
 Test Files  6 failed (6)
      Tests  15 failed | 97 passed (112)
```

The 15 failures: the five new `reads.test.ts` tests (seasons newest first; latest season / archive with awardPlace; cursor and season-id rules; no-season world; prestige mapping), the two `live-gateway` season tests plus the no-backend test (`gateway.seasons()` missing), `projection-gateway` (2), `serves the fixture seasons, archive and Aster prestige` and the fixture standings test, `arena-fixtures` (2) and `arena-panels` (1: season id `'1'`).

DB test RED: with `src/lib/api/reads.ts` temporarily restored to HEAD, `npm run test:db -- tests/db/seasons.test.ts -t "reads seasons, an archived season"` failed with `TypeError: readSeasons is not a function` (1 failed | 23 skipped); the implementation was restored from a saved copy and is what was committed.

### GREEN (implementation as committed)

| Gate | Command | Result |
|---|---|---|
| Focused units | the six files above | 6 files, 112/112 passed |
| Full units | `npm test` | 46 files, 1035/1035 passed |
| Typecheck | `npm run typecheck` | `tsc --noEmit` clean, `deno check` clean, 2 Deno tests passed |
| Focused DB | `npm run test:db -- tests/db/seasons.test.ts -t "reads seasons, an archived season"` | 1 passed, 23 skipped |
| Full DB | `npm run test:db` | 11 files, 217/217 passed (216 plus the new live read test), 166 s |
| Assets | `node assets/source/build-assets.mjs --check` | up to date (28 files) |
| Build | `npm run build` | compiled; 7 static pages |
| Static | `npm run verify:static` | verified: 5 fixed routes; 89 assets scanned; no forbidden backend material; no fixture preview data |
| Whitespace | `git diff --check` | clean |
| Dev browser suite (not required by the brief; run because `live-routes.ts` and the fixture cursor changed) | `npx playwright test -c node_modules/.cache/pw-claude.config.mjs` (private port 3200, after build and verify:static) | 412 passed, 22 skipped (production-only), exit 0, 7.5 min |

### Edge StartedAt (`supabase_edge_runtime_Cloudiator`)

- At task start: `2026-10-18T13:30:35.734870581Z`.
- After my edit of `supabase/functions/_shared/contracts/reads.ts` and a `tsc`/`deno check`/`deno test` run (before any DB run) it read `2026-10-18T13:45:48.848032415Z`: the container was recreated outside any DB run, which the gate guide describes (source change in the serving worktree); the container was running and served the later runs.
- Every DB run used that baseline and nothing else touched the worktree during it:
  - RED focused run: before `13:45:48.848032415Z`, after `13:45:48.848032415Z`.
  - GREEN focused run: before `13:45:48.848032415Z`, after `13:45:48.848032415Z`.
  - Full `npm run test:db`: before `13:45:48.848032415Z`, after `13:45:48.848032415Z`; unchanged, so the 217/217 run is valid.
- The build, `verify:static` and the browser suite ran after the DB runs, one after another.

## Self-review

- Read the whole diff. Checked: every `readStandings` path (cursor, named, latest, legacy) has a test with the exact request shape; a malformed season id never reaches a query (including beside a cursor); the open view and the archive use their own column lists; a visitor and a signed-in reader get identical results and no private table or command is touched (`live-gateway.test.ts`, the DB test with the real anon client and a real `close_season`).
- The fixture `reward eligible` of the current season is still `bouts ≥ 5` (unchanged): its fixture rows have no higher-league twins, so the view's rule would give the same answer except for the few "promoted" fillers, whose higher-league row does not exist in the fixture data.
- The review found nothing to change after the feature commit.

## Concerns and deviations

1. **Cursor season trusted (deviation, small).** The brief says an unknown `seasonId` is `unavailable`. For a cursor naming a season with no `public.seasons` row I read the season as open instead of failing: `tests/db/arena.test.ts` seeds rating rows without season rows and pages with `1:50`, and only this read issues cursors. After M15 every rated season has a row, so a real cursor always finds one. A named `seasonId` with no row is `unavailable`.
2. **`seasonId` is validated even beside a cursor** (the cursor still wins): stricter than the literal order in Decision 7, so garbage is never silently ignored. Easy to relax if 21.4 prefers.
3. **Extra lookup per page.** Every page costs one `seasons` primary-key read (to know open or closed), including cursor pages; the cursor format is unchanged as the clarification required.
4. **Season closing between pages.** If an open season closes between page 1 and page 2, page 2 reads the archive (`archived: true`) with the same ranks. The 21.4 panel should take `archived` from the newest page it reads.
5. **Empty current season.** A new season's row (boundary phase 2) can exist before its first rating rows (phase 4), so the default page (latest season) may briefly be empty. 21.4 should show an empty state and keep the season picker usable.
6. **Strict prestige validation.** A profile whose `prestige` is not the award list fails as `unavailable` instead of showing broken badges (the database guarantees the shape: `not null default '[]'`, check constraints on badge, place and title).
7. **Fixture cursor changed** from the opaque `fixture-standings:league:offset` to the live `season:rank`, and a malformed cursor is now `unavailable` as live (it used to restart at page 1). `arena-fixtures.test.ts` and `arena-panels.test.ts` were updated; `arenaStandingsPage` now takes `(league, seasonId, after)`.
8. **Old fixture season id.** The only test that asserted it (`arena-panels.test.ts`) now expects `'1'`. `tests/domain/tournament-fixtures.test.ts` has its own `const SEASON = 'fixture-season-1'`, a label for the tournament engine's pairing input; it is not a standings season id and changing it could change the generated tournament fixtures, so it is untouched.
9. The open-season `inactive` flag is still computed from the counts (the live view has no `inactive` column); the archive's is read as stored.
10. Nothing reusable surfaced for a skill upkeep question.
