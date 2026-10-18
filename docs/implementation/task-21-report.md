# Task 21 report: seasons, rewards and prestige

Plan `docs/superpowers/plans/2026-10-18-task-21-seasons.md` (commit `d8057c6`); spec `docs/superpowers/specs/2026-10-11-gladiator-arena-design.md` §8.3.
Branch `claude/task-21` in `C:\Avi\Studies\Projects\Cloudiator-claude`. Nothing is pushed by this task's last part (21.1 and 21.2 were pushed by the controller after their reviews).

## Overview

| Part | What it delivered | Commits | Report |
|---|---|---|---|
| 21.1 | Close a season in the database: `public.seasons`, the frozen `public.season_standings` archive, `private.season_awards`, `private.close_season` (rank, qualify, eligible in the highest qualifying league, places 1–3, pay once with receipts and ledger), prestige on public profiles, `reward_eligible` in the live view, frozen ratings | `ab4b1a0`, `a1ddb62`, `61274dd`, `2110d3a` | [task-21.1-report.md](task-21.1-report.md) |
| 21.2 | Close each season at its boundary: phase 2 `private.boundary_close_season`, the next season's row, the M15 migration and backfill, `seasonAt` in the domain | `c615091`, `ef11c19`, `ed5a114` | [task-21.2-report.md](task-21.2-report.md) |
| 21.3 | Client reads: `GameGateway.seasons()`, `standings(league, cursor?, seasonId?)` with archived pages, `StandingRow.awardPlace`/`rewardEligible`, `PublicProfile.prestige: PrestigeAward[]`, fixture seasons `'1'` (current) and `'0'` (closed) | `479583f`, `5df2ce6` | [task-21.3-report.md](task-21.3-report.md) |
| 21.4 | The UI Avi approved from the mockup on 2026-10-18: seasons inside Arena standings and titles/badges on profile cards, plus the one-row `standingOf` read | `f4c118f`, `35cefb8`, this report | this file, below |

Reviews of 21.1–21.3 (spec ✅, quality Approved, no Critical or Important findings) are in the SDD workspace (`.superpowers/sdd/2026-10-18-task-21-seasons/task-21.N-review.md`).

## Task 21.4: seasons in Arena standings and on profile cards

- **Status:** DONE_WITH_CONCERNS. Every gate passed on the final tree. Concerns: the brief's `seasonEnds` literal names the wrong weekday (corrected, below), and one unexplained DB-test timeout that did not reproduce.
- **Base:** `5df2ce6`. **Commits:** `f4c118f feat: show seasons, archives and prestige`; `35cefb8 fix: keep following the current season at a new revision` (self-review); this report as `docs: report Task 21`.
- No database, migration, Edge or package change.

### What I implemented

**Text helpers** (`src/features/seasons/season-text.ts`, new):
- `seasonName(seasonId)` → "Season N" (index + 1; "Season" when there is no season yet).
- `seasonEnds(endsAtMs, nowMs, timeZone?)` → `{ countdown, local, utc }`: "27 days 22 h" / "3 h 5 min" / "12 min" (at least "1 min" while time is left, "0 min" at or after the end); "Sun 15 Nov, 19:00" in the viewer's zone (undefined → the runtime's zone); "17:00 UTC", or "Sat 24 Oct, 00:00 UTC" when the UTC date differs from the local one. Intl supplies only the zone's numeric fields; the day and month names are fixed in code because ICU versions differ (Node's en-GB gives "Sept").
- `seasonLabel(season, timeZone?)` → "Season 2 · current" / "Season 1 · ended Sat 26 Sep" (local end date).
- `badgeText(award)` → "🥇 Season 1 · Silver"; `titleText(award)` → "Champion · Season 1 Silver" or null.
- `placeText(place)` → "🥇 1st · Champion" / "🥈 2nd" / "🥉 3rd" (medal and title from `RULES_V1.seasons.placements`).
- `qualifyText(humanBouts, league)` → "N more human bout(s) to qualify for season rewards. NPC bouts do not count." or the qualified message.
- `ELIGIBLE_NOTE` and `promotionNote(rows, league)` (the archived footnote, below).

**One-row read** (controller ruling): `GameGateway.standingOf(league, gladiatorId): Promise<StandingRow | null>`.
- `src/lib/api/reads.ts`: `readStandingOf` picks the current season exactly as `readStandings` does with neither cursor nor season id (the shared `latestSeason` helper: newest `public.seasons` row, else the `arena_standings` maximum), returns null when there is none or it is closed, else reads `arena_standing_reads` filtered by league, season and gladiator with `limit 1`. The gladiator filter applies after the view's window, so the rank is the rank in the whole league (proved on the real database). `parseStandingOf` refuses a malformed league or gladiator id before any query and lowercases the id; the fixture gateway applies it too. `readStandings` now shares `latestSeason` and `standingRow` with it; its request shapes are unchanged (pinned by the existing tests).
- `src/lib/api/gateway.ts`: a public read (`publicRead`), so a visitor could read it too (the panel only asks for the owner).
- `src/lib/api/fixture-gateway.ts`: the current season's row from `ARENA_STANDINGS`, as a copy, or null.

**Arena standings** (`src/features/arena/StandingsPanel.tsx`, `.module.css`), inside the existing Arena menu section (no new menu):
- **Season picker** (labelled "Season"): every listed season, newest first, with `seasonLabel`. Picking the newest open season follows the current season again (the panel reads without a season id); any other pick reads that season. A season the list does not hold yet still shows by name.
- **Current season card** (a region named by its heading): "Season 2 ends in 13 days 23 h", "Sat 24 Oct, 03:00 your time (00:00 UTC). Ratings then restart at 1000; level, gear, money and renown stay.", the three prizes from `RULES_V1.seasons.placements` and the rule. The countdown uses the shared display clock (redrawn on clock changes and every 30 s while visible; no read timer). Past its end but not yet closed it says "Season 2 is ending" and "Final standings and rewards appear once the server closes the season." instead of a countdown.
- **Your standing** (signed-in owner, open season only) keeps League, Rating, Renown and Current combat strength and adds Season rank ("#27", "Not ranked yet", "Loading…" or "not available") and Human bouts ("3 of 5"), a progress bar (`role="progressbar"`, "Human bouts toward season rewards", value capped at 5) and `qualifyText`. The figures come from `standingOf(owner league, owner id)`, read at opening and again with every new revision.
- **Notes pills:** You, Promoted, Inactive, "✓ Eligible" (open season, from the view's `reward_eligible`), and for an archived season the medals from `awardPlace`.
- **Archived season:** tag "Archived season", card "Season 1 final standings" / "Ended Sat 26 Sep, 03:00 your time (00:00 UTC). Frozen at the close; medals show the season rewards.", no countdown, no Your standing, no ✓ Eligible. Footnote: every row that is promoted, has at least 5 human bouts and is not reward-eligible (so it qualified higher), ranked above the last medal (or anywhere when fewer than three medals were awarded), is named: "Lucilla was promoted and qualified in a higher league, so Lucilla is rewarded there only, and the Bronze medals go to the next eligible gladiators." (plural form for several, up to three names). Otherwise the rule: "A gladiator promoted during the season is rewarded only in their highest league with at least 5 human bouts; a lower league’s medals then go to its next eligible gladiators."
- **Current season footnote:** "✓ Eligible: has 5 or more human bouts and this is their highest qualifying league."
- **Empty states:** the normal "No standings in the Bronze league yet." for an empty current season (the picker keeps earlier seasons); "No standings in the Gold league in Season 1." for an empty archived league.
- **Visitors** see the picker, the season cards and the standings; never Your standing and no command (none exists in this section).
- **Requests (21.3 review M2/M3):** a finished season's archive never changes, so at a new revision a finished season the viewer picked is not read again, while the current season (followed without a season id) is always read again, since a boundary may have opened the next one; the season list is read at opening and again at a revision only when it may be out of date (never read or failed, no season, the newest closed or past its end on the display clock, or the shown season missing or listed open while its pages are archived). The read contract is unchanged. A season that closes between two pages: `readNextPage` re-reads every loaded page from the archive (same ranks), so rows never mix live and frozen flags.
- Table headers are sentence case (the mockup's), so a medal note fits on one line in the 380 px panel; the cells' side padding is 0.35rem instead of 0.5rem; "W–L" never splits. The table fits its own box at 360 px (asserted).

**Profile card** (`src/features/character/ProfileCard.tsx`, `.module.css`): under the name, the title of the latest champion award ("Champion · Season 1 Silver", italic gold); under the class line, a list "Season badges" with a chip per award, newest season first ("🥇 Season 1 · Silver"). Nothing at all without prestige or before the profile loads.

**ArenaMenu:** passes the same gateway (which now carries `seasons` and `standingOf`); comments updated. No new menu.

**Tests:** `tests/domain/season-text.test.ts` (new), `tests/browser/seasons.spec.ts` (new); additions to `tests/domain/arena-panels.test.ts`, `tests/domain/profile-card.test.ts`, `tests/reads.test.ts`, `tests/api/live-gateway.test.ts`, `tests/api/fixture-gateway.test.ts`, `tests/db/seasons.test.ts`; two existing browser assertions updated (below). `tests/browser/live-routes.ts` needed no change: 21.3 already answers `seasons` and `season_standings`, and its query evaluator handles the `gladiator_id` filter.

### Files changed

| File | Change |
|---|---|
| `src/features/seasons/season-text.ts` | new: the text helpers above |
| `src/features/arena/StandingsPanel.tsx`, `.module.css` | picker, season cards, own progress, pills, archived view, request rules; sentence-case headers |
| `src/features/arena/ArenaMenu.tsx` | comments only (the gateway already passes through) |
| `src/features/character/ProfileCard.tsx`, `.module.css` | title line and badge chips |
| `src/lib/api/reads.ts` | `readStandingOf`, `parseStandingOf`; shared `latestSeason` and `standingRow` |
| `src/lib/api/gateway.ts`, `fixture-gateway.ts` | `standingOf` |
| `tests/domain/season-text.test.ts`, `tests/browser/seasons.spec.ts` | new |
| `tests/domain/arena-panels.test.ts`, `profile-card.test.ts`, `tests/reads.test.ts`, `tests/api/live-gateway.test.ts`, `fixture-gateway.test.ts`, `tests/db/seasons.test.ts` | added cases |
| `tests/browser/arena.spec.ts` | two updated assertions (below) |

### How it maps to the mockup, and deliberate differences

Built with the app's components, the StandingsPanel module and the shell's panel and sheet; the mockup's inline CSS, fixed sample data, "(Arena bouts list above, unchanged)" line and "What changes" note are not reproduced. Order and copy follow the mockup: eyebrow, "Arena standings", tag (CURRENT SEASON / ARCHIVED SEASON, the archived one in the mockup's brown-gold), the "Season" picker, the season card, Your standing, the league buttons, the table (Rank, Gladiator, Rating, Human W–L, Notes), the footnote. The profile card matches the archived view's card (gold italic title under the name, a gold-bordered chip per badge).

Deliberate differences:
1. **Weekday.** The brief's literal `local: 'Sat 15 Nov, 19:00'` for `Date.UTC(2026, 10, 15, 17)` is wrong: 15 Nov 2026 is a Sunday (1 Jan 2026 is a Thursday, and 318 days later is a Sunday; Node's Intl agrees). The test expects `'Sun 15 Nov, 19:00'`; the rest of that line is verbatim (`'27 days 22 h'`, `'17:00 UTC'`). The mockup's "Season 1 · ended Sat 18 Oct" was sample data with the same slip (18 Oct 2026 is a Sunday). The fixture dates the app shows are real Saturdays ("Sat 24 Oct", "Sat 26 Sep").
2. **No prestige → nothing.** The mockup's card showed "No season badges yet"; Decision 8 and the brief's test say nothing at all, so nothing is shown.
3. **Your standing has six figures** (controller ruling): League, Rating, Renown, Current combat strength, Season rank, Human bouts, then the bar, the qualification line and the existing explanation paragraph. The mockup showed four.
4. **Footnote wording.** The mockup said "Varro was promoted to Silver and qualified there". An archive row does not say which higher league, so the text says "in a higher league"; it is derived from the rows (promoted, at least 5 human bouts, not reward-eligible, above the last medal), with the rule as a fallback.
5. **Pills** use the app's existing bordered pill family (You, Promoted and Inactive were already styled); ✓ Eligible is green-bordered and the medal pill is gold-filled and sentence case. The mockup's pills were rounded and filled.
6. **Table headers** are now sentence case like the mockup (they were uppercase and letter-spaced, which pushed the Notes column out of the 380 px panel), with slightly smaller side padding.
7. **States the mockup did not show:** "Season N is ending" after the end and before the close; "No standings in the Gold league in Season 1." for an empty archived league; "Loading…", "not available" and "Not ranked yet" for the season rank.
8. `tests/browser/live-routes.ts` was listed to modify; it needed no change (21.3 already serves `seasons` and `season_standings`, and its evaluator handles the new `gladiator_id` filter).

### Tests and TDD evidence

**RED, units** (all new tests written first): `npx vitest run tests/domain/season-text.test.ts tests/domain/arena-panels.test.ts tests/domain/profile-card.test.ts tests/reads.test.ts tests/api/live-gateway.test.ts tests/api/fixture-gateway.test.ts`

```
 FAIL  tests/domain/season-text.test.ts  Error: Cannot find package '@/features/seasons/season-text'
 Test Files  6 failed (6)
      Tests  16 failed | 60 passed (76)
```

The 16: `readStandingOf` (reads), `standingOf` in the live gateway (3: the no-backend list and both season-read cases) and in the fixture gateway (1), eight StandingsView season cases, two `readStandingsPages` cases (a named season; a season closing between pages) and the profile-card prestige case.

**RED, browser:** `npx playwright test --config node_modules/.cache/pw-claude.config.mjs seasons.spec.ts --project desktop` → 7 failed (no season region, `selectOption` timeouts on the missing picker, no ✓ Eligible, no season rank).

**RED, database:** with `src/lib/api/reads.ts` temporarily restored from HEAD, `npm run test:db -- tests/db/seasons.test.ts -t "current-season row"` → `TypeError: readStandingOf is not a function` (1 failed, 24 skipped); the implementation was copied back from a saved copy.

**RED, self-review fix (`35cefb8`):** with the committed `StandingsPanel.tsx` (before the fix), `... seasons.spec.ts --project desktop -g "follows the current season|reads the current season again"` → "follows the current season to the next one when the newest season was closed at opening" failed (the view stayed on the closed season: no ✓ Eligible row). The other test failed too, but on a test bug: it pinned an absolute season-list count at opening (2, not 1, because the development server's React Strict Mode mounts effects twice). It now asserts deltas only; it pins the request rules and does not distinguish the fix.

**GREEN:**

| Check | Command | Result |
|---|---|---|
| Focused units | the six files above | 6 files, 83/83 |
| Seasons spec | `npx playwright test -c node_modules/.cache/pw-claude.config.mjs seasons.spec.ts` | 18/18 (9 tests × desktop and mobile) |
| Focused DB | `npm run test:db -- tests/db/seasons.test.ts -t "current-season row"` | 1 passed, 24 skipped |

New and changed cases:
- `season-text.test.ts`: names; end times in Jerusalem (winter and summer time), UTC, New York (UTC date differs) and Los Angeles; countdown units and edges; picker labels; badge, title and place texts; the qualification text.
- `arena-panels.test.ts`: picker options and selection; the current card (and its "is ending" state); Your standing with rank, bouts and progress, and its unranked, loading, unavailable and qualified forms; ✓ Eligible and its footnote; the archived view with medals, You and no Your standing (also as a visitor); the named promotion footnote (one and several) and the rule; an empty newest season; the visitor view; pages of a named season; a season closing between pages.
- `profile-card.test.ts`: the latest champion title, badges newest first, a third place only, nothing without prestige.
- `reads.test.ts`, `live-gateway.test.ts`, `fixture-gateway.test.ts`: the one-row read's request shape, null cases, legacy season choice, input refusal and copies.
- `tests/db/seasons.test.ts`: on the real database, for a visitor and a player, `readStandingOf` returns third place for a gladiator filtered out of a four-row league (the filter does not renumber the window), the promoted row's flags, null without a row, and null once the season closes and the next opens empty.
- `seasons.spec.ts`: the brief's four tests (the finished-season one also as a visitor) plus four live-mode tests: a visitor reads an archive from `season_standings` with no owner read and no one-row read; request counts at new revisions (the current season: +1 view read and +1 lookup, no list read; a picked finished season: nothing at all); following the current season to the next one; the owner's rank #57 from the one-row read while only the first 50 rows are loaded.
- Updated existing assertions (`tests/browser/arena.spec.ts`): Your standing's definitions now end with the season rank and "3 of 5"; the revision test counts page reads of the view only (the `gladiator_id`-filtered one-row read is excluded), since the one-row read also follows the revision.

### Gates, in order (final tree `35cefb8`)

| # | Gate | Result |
|---|---|---|
| 1 | `npm test` | 47 files, 1056/1056 |
| 2 | `npm run typecheck` | `tsc` clean, `deno check` clean, 2 Deno tests passed |
| 3 | `npm run test:db` | 11 files, 218/218 (221 s); Edge stable |
| 4 | `node assets/source/build-assets.mjs --check` | up to date (28 files) |
| 5 | `npm run build`, `npm run verify:static` | 7 static pages; "Static export verified: 5 fixed routes; 89 assets scanned; no forbidden backend material; no fixture preview data." |
| 6 | Development browser suite: `npx playwright test --config node_modules/.cache/pw-claude.config.mjs` (private port 3200) | 430 passed, 22 skipped (production-only), exit 0, 11.2 min |
| 7 | Isolated production gate: `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build`, `npm run verify:static -- .next/browser-test`, `PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test` (the repo's `playwright.config.ts`; port 4173 was free, and its server script differs from the private copy only in the port) | build and verify pass; 16 passed, 436 skipped (the fixture and live specs skip in production) |
| 8 | `git diff --check` | clean |

The same gate ran on the feature commit's tree before the self-review fix: units 1056/1056, typecheck clean, DB 218/218 (below), build and `verify:static` pass, development suite 426 passed / 22 skipped (8.1 min), production gate 16 passed / 432 skipped, `git diff --check` clean. After the last edit before that commit (a comment) units and `tsc` were rerun: 1056/1056, clean.

### Edge runtime StartedAt (`supabase_edge_runtime_Cloudiator`)

- Task start: `2026-10-18T13:58:18.282322287Z`.
- Recreated outside any DB run: `14:30:36.262897129Z` (seen before the first full unit run, after the first browser runs), `14:35:55.233788344Z` (after `npm run typecheck`), then `14:58:30.658898314Z` and `14:58:52.083675648Z` (around the final typecheck). No file under `supabase/functions` was edited. Each DB run used the value at its start:
- DB RED focused: before `14:35:55.233788344Z`, after `14:35:55.233788344Z`.
- DB GREEN focused: before and after `14:35:55.233788344Z`.
- Full DB run 1: before and after `14:35:55.233788344Z`: **217/218**, 264 s. One 60 s timeout in an untouched test, `tests/db/arena.test.ts` "promotes from real Task 8 acquisitions only at a boundary…". Alone it passed (before and after `14:35:55`); the whole `arena.test.ts` passed 29/29 (before and after `14:35:55`).
- Full DB run 2: before and after `14:35:55.233788344Z`: **218/218**, 168 s.
- Full DB run 3 (final tree): before and after `14:58:52.083675648Z`: **218/218**, 221 s.

### Screenshots (visual review)

In `.superpowers/sdd/2026-10-18-task-21-seasons/shots/` (from the final development run; the workspace is gitignored). The desktop project is 1280×720 and the mobile project a Pixel 7; `phone-*` are at 360×760; times are in Asia/Jerusalem with the display clock held at the world fixture's time.
- `seasons-desktop-current.png`: the current season: picker, countdown card, prizes, rule.
- `seasons-desktop-current-standing.png`: Your standing (six figures, the bar, "2 more human bouts…"), the leagues, the table with ✓ Eligible.
- `seasons-desktop-archived.png`: Season 1 final standings: medals, Promoted, You with 🥉 3rd.
- `seasons-desktop-archived-footnote.png`: the end of the Bronze archive and the promotion footnote naming Lucilla.
- `seasons-desktop-profile.png`: Lucilla's card over the archived Silver standings: "Champion · Season 1 Silver" and "🥇 Season 1 · Silver".
- `seasons-desktop-visitor.png`: a visitor's current season (sign-in chip, no Your standing).
- `seasons-desktop-phone-current.png`, `seasons-desktop-phone-standing.png`, `seasons-desktop-phone-archived.png`: the 360 px sheet.
- The same nine from the mobile project (`seasons-mobile-*.png`).

### Self-review

I read the whole diff against the mockup, Decision 8, the brief and the controller rulings.
- **Found and fixed (`35cefb8`):** the revision handler skipped re-reading an archived page even while following the current season. Phase 2 opens the next season in the same transaction that closes the old one, so this state is transient at most, but a viewer who opened the panel in it would have stayed on the closed season. Now only a finished season the viewer picked is left unread. Two live tests were added (RED above).
- **Found and fixed before the feature commit:** ICU abbreviates September as "Sept" in en-GB, so day and month names are fixed in code; uppercase headers pushed the medal pills out of the panel (now sentence case, as the mockup); a badly reflowed comment in `ProfileCard.tsx`.
- Checked: visitors never get Your standing or a one-row read; the section offers no command or control besides the leagues, names, picker and More (asserted); the `standings` read contract is unchanged (21.3's request-shape tests pass untouched); no new badge or league value, so `BADGES` and `LEAGUES` need no change (21.3 M7); names render as React text.

### Concerns and deviations

1. **Brief literal corrected** (deviation): `'Sat 15 Nov, 19:00'` → `'Sun 15 Nov, 19:00'` (a calendar fact, above).
2. **One unexplained DB timeout** (observed, not reproduced): full run 1 had a 60 s timeout in an untouched arena test with the Edge container stable. It passed alone, its file passed 29/29, and two later full runs passed 218/218. I found no cause; that run was also much slower than the others (264 s against 168 s and 221 s).
3. **Extra reads for a signed-in owner:** the one-row read costs one season lookup and one view row at opening and at each new revision (accepted by the ruling).
4. The countdown redraws every 30 s while the tab is visible and whenever the display clock is held or moved; this is a display tick only, never a read.
5. The promotion footnote considers the loaded rows only; a promoted qualifier beyond them is named once More loads it (this can matter only when fewer than three medals were awarded).
6. No skill upkeep question: nothing reusable for a skill came up.
