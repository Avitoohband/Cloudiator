# Task 21 independent reviews: seasons, rewards and prestige

Plan: [Task 21 plan](../superpowers/plans/2026-10-18-task-21-seasons.md). Spec: [game design §8.3](../superpowers/specs/2026-10-11-gladiator-arena-design.md). Each checkpoint has a fresh implementer and an independent reviewer; reviewers may run read-only catalog queries against the local stack "Cloudiator". Avi approved the seasons UI from a [clickable mockup](https://claude.ai/artifact/TG8LCpJyHygQqqKjNWK6qn) on 2026-10-18 before 21.4 started.

## 21.1: Close a season into a frozen archive (database)

Range `d8057c6..2110d3a`: `ab4b1a0` (feature), `a1ddb62` (report), `61274dd` (grant fix before review) and `2110d3a` (report of that adjustment). [Implementer report](task-21.1-report.md). There is no migration here: M15 in 21.2 covers both checkpoints.

**Implementer evidence:**
- 15 new seasons tests, all red before `13-seasons.sql` existed; unit tests 1020.
- `test:db` 208/208 twice with the Edge start time unchanged.
- After the pre-review grant adjustment: seasons and visitor-access 20/20, `test:db` 208/208, Edge stable. A check against the old grants failed as expected.

**Verdicts:** spec compliant; quality Approved; no Critical or Important findings.

**What the reviewer confirmed:**
- **Tables:** `public.seasons`, the frozen `public.season_standings` archive (no foreign key, by design) and `private.season_awards` (primary key, unique place, unique receipt). Clients can only SELECT the two public tables.
- **Close rules:**
  - ranking is rating, human wins, fewer human losses, then gladiator id;
  - only human bouts count toward the five-bout qualification;
  - a row is reward-eligible only in the character's highest qualifying league, and places 1–3 go to the eligible rows of each league;
  - promoted and inactive rows are flagged and every row is archived with its name at close.
- **Payment:** awards are paid in gladiator order (account lock, then wallet), capped at the wallet maximum, each with a decided receipt, a `'season'` ledger row and an award row. A second close returns 0.
- **Replacements:** `project_character`, `guard_arena_rating` and the live view change only what they must. The view gains `reward_eligible` as its last column and stays `security_invoker`.
- **Lock order:** it matches commands, settlement and the market (account lock, then wallet), so a purchase cannot form a cycle with the close.
- **Tests:** archives are compared exactly, including ties; receipt digests are recomputed in Node; the cap test reads wallets as text; the privilege sets are pinned in the catalog; a close runs as `service_role` in a rolled-back transaction, so the grants are proven sufficient, not only present.

**Controller rulings (see the appendix):**
- 21.1 is not pushed alone, because a 21.1-only origin would fail on a clean replay.
- The plan's grants for Decisions 3 and 5 were wrong: the boundary runs as `service_role`, so it gets EXECUTE on `close_season` and `season_rules` and the DML the close needs.
- No extra held-account-lock test in 21.1.
- The view may repeat the five-bout literal if a test pins it.

**Minors, all carried into 21.2 and fixed there (the final review verified each):**
- M1: the eligibility flags were O(n²) correlated sublinks. They are now window aggregates.
- M2: the `guard_season` bounds clause was never tested alone. A test now changes bounds together with a valid close.
- M3: three Data API probes could not prove grants. They are relabelled as exposure checks, with catalog privilege checks added.
- M4: stale report lines about the superseded grants were marked as superseded.

**Reviewer notes:** the frozen-rating guard also covers the tournament settlement, so 21.2 had to prove a tournament in a season's last slot (done). `PublicProfile.prestige` was still typed `string[]` (21.3's Decision 7). Commit trailers were verified by the controller.

## 21.2: Close each season at its boundary (M15)

Range `2110d3a..ed5a114`: `c615091` (feature with M15 `20261018123715_seasons`, plus 21.1 minors M1–M3), `ef11c19` (21.1 minor M4) and `ed5a114` (report). [Implementer report](task-21.2-report.md). 21.1 and 21.2 were pushed together to `origin/codex/gladiator-arena` (`69ed674..ed5a114`, fast-forward) after this review. Work was paused at Avi's request during the review and resumed afterwards.

**Implementer evidence:**
- Unit tests 1029; `test:db` 216/216 on the source and on a clean M01–M15 replay, Edge stable.
- The replay fingerprint (1029 lines) is byte-identical to the source's, and identical after every counted run. Lint is empty; advisors INFO only (4 on the source, 5 on the replay).
- Three mutations each failed their own test: closing only at a season's first boundary, `promoted` using `>=`, and eligibility ignoring qualification.
- M15's backfill statement was run verbatim on the replayed database inside a `DO` block that always raises, so nothing was left behind.
- **Incident (local only):** a check script ran in autocommit and left two guard triggers disabled, the epoch at 10 and test rows on Claude's local stack. A clean `db reset` restored it (identical fingerprint, triggers enabled) and 216/216 passed afterwards. Nothing hosted was touched.

**Verdicts:** spec compliant; quality Approved; no Critical or Important findings.

**What the reviewer confirmed:**
- **Phase 2:** `private.boundary_close_season` closes every earlier open season row in ascending order, then inserts the boundary's own season row. It samples `planning_now_ms()` once, after the coordinator lock. A skipped boundary leaves the close to the next one that runs.
- **Settlement order:** phase 1 proves the previous slot settled and settlement is globally ordered, so no rating of the closing season can move during or after the close. Rating rows are created only in phase 4, for the boundary's own season.
- **Atomicity:** a failure injected on the second award rolls back the whole boundary subtransaction (seasons, archive, awards, receipts, ledger, prestige and wallets unchanged); the retry pays exactly once and a replayed boundary runs no phase.
- **Tournament ordering:** the stand-in test holds phase 1 with entrants unsettled, restores the function byte for byte, and proves `closed_at_ms` is not before the last settlement.
- **M15 is complete:** checked statement by statement against the tested source (tables, constraints, RLS, revoke-before-grant, both policies, trigger order, the invoker view, the six function ACLs, the backfill, `notify pgrst`). The replaced functions differ from their latest earlier bodies only as intended.
- **`seasonAt`:** the domain function throws for an unsafe, negative or pre-epoch value.

**Controller rulings (see the appendix):**
- The rare season-boundary deadlock is accepted: phase 2 takes award account locks before phase 3's member locks, so a concurrent market buy can form a cycle. Postgres aborts one side, the buy maps 40P01 to a retryable result and the boundary retries.
- The skipped-boundary test may use operator-seeded rating rows.

**Deferred Minors:**
- M1: the promotion test filters `ratingsOf(a)` to season 1; assert the full row list (test precision only; no game path inserts a post-close row).
- M2: the season-bounds formula is written twice in the source and twice in M15; a `private.season_bounds(index)` helper needs a new migration (carried to M16).
- M3: a fourth copy of the boundary-driving test helpers (carried to Task 22).
- M4: report evidence noise: an unexplained Edge recreation in a discarded run, and advisors at 4 INFO on the source against 5 on the replay (probably index statistics reset by `db reset`).

**Proposed, pending Avi:** extend the migration-guide fingerprint to record trigger enablement and singleton rows (the epoch), and run rollback-only checks as raising `DO` blocks. The 21.2 report proposes this as a guide and AGENTS.md update; it is tested only as the `DO`-block check.

## 21.3: Client reads for seasons and prestige

Range `ed5a114..5df2ce6`: `479583f` (feature) and `5df2ce6` (report). [Implementer report](task-21.3-report.md).

**Implementer evidence:**
- Focused units 112/112; full units 1035/1035; `test:db` 217/217 with the Edge start time unchanged (`13:45:48Z`).
- Build and `verify:static` pass; development browser suite 412 passed, 22 skipped (run because `live-routes.ts` and the fixture cursor changed).

**Verdicts:** spec compliant; quality Approved; no Critical or Important findings.

**What the reviewer confirmed:**
- **Read contract:** `GameGateway.seasons()` and `standings(league, cursor?, seasonId?)` keep the standings page shape and add `StandingRow.awardPlace` (null for an open season). An open season reads `arena_standing_reads` and takes `rewardEligible` from the database; a closed one reads `season_standings` with `archived: true`, the same `season:rank` cursor and 50-row pages.
- **Season choice:** cursor, then `seasonId`, then the latest `public.seasons` row, then the `arena_standings` maximum when `seasons` is empty. Season 0 is handled without falsy checks. A malformed or unknown id is `unavailable`.
- **Shared parsing:** `parseStandingsRead` validates before any query and is reused by the fixture gateway, so the two cannot drift. A test asserts no request is made for 14 bad ids.
- **Visitors:** read-only access is covered in the live gateway test, the real anonymous client in a DB test, and the visitor-access suite.
- **Fixtures:** season `'1'` is current and `'0'` is closed. The season-0 archive matches the SQL rules (promoted, inactive and fourth-placed rows traced by hand), and the archive and profile prestige are checked both ways.
- **Prestige:** the strict profile mapping rejects 12 malformed shapes, and the real projection's shape passes.

**Controller rulings (see the appendix):**
- A cursor naming a season with no row reads as open; a named `seasonId` with no row is unavailable.
- A malformed `seasonId` is unavailable even beside a valid cursor.
- A season may close between pages, and the newest season may be briefly empty after a boundary; the UI shows its normal empty state (carried to 21.4).

**Minors:**
- **Carried to 21.4 and fixed there:** M2 (each page costs a season lookup, so N pages cost 2N requests: the panel now never re-reads a picked finished season and re-reads the season list only when it is stale) and M3 (a season can close between the lookup and the page query: `readNextPage` re-reads loaded pages from the archive when a season closes).
- **Fixed in the final fix wave:** M6 (the gateway doc now says "without a cursor").
- **Kept as a rule:** M7 (one malformed prestige entry makes the whole profile read unavailable; table CHECKs make it near impossible). Add any new badge or league value to `BADGES` and `LEAGUES` in the same change as its migration.
- **Deferred:** M1 (fixture `archiveOf` re-derives the close rules, pinned by name in a test), M4 (the league list and a nested ternary in the fixture gateway), M5 (`'fixture-season-1'` stays as an engine seed label), M8 (small test gaps: an unknown `seasonId` beside a cursor, archive paging past 50 through the real Data API, request headers without a session).

## 21.4: Seasons in Arena standings and on profile cards

Range `5df2ce6..6b00f3f`: `f4c118f` (feature), `35cefb8` (self-review fix: keep following the current season at a new revision), `2b1a4ab` ([Task 21 report](task-21-report.md)), `bab7580` (fix round 1) and `6b00f3f` (its report).

**Implementer evidence:**
- Unit tests 1056; `test:db` 218/218 with Edge stable.
- Build and `verify:static` pass; development browser suite 430 passed, 22 skipped; isolated production gate 16 passed (436 skipped); `git diff --check` clean. 18 `seasons-*` screenshots.
- One 60 s timeout in an untouched arena DB test on the first full run; it passed alone and in two later full runs (the known flaky test, carried to Task 23).
- The self-review defect (the panel stayed on the closed season at opening) was fixed with a test that fails before and passes after.

**Verdicts (first review):** spec not compliant (one Important), visual pass, quality Needs fixes. After fix round 1, the scoped re-review found the one finding addressed and nothing open; the checkpoint is clean.

**What the reviewer confirmed:**
- **UI:**
  - a "Season" picker, and a current-season card with countdown, local time and UTC, prizes from `RULES_V1` and the rule;
  - "Your standing" keeps League, Rating, Renown and Current combat strength and adds Season rank, Human bouts N of 5, a progress bar and the qualify text;
  - pills for You, Promoted, Inactive, ✓ Eligible (open season only) and medals (archived only);
  - the archived view hides "Your standing" and has a footnote; the profile card shows a title and badge chips, or nothing.
- **Reads:** `GameGateway.standingOf` is a public one-row read with unit and DB tests. The whole-league rank survives the gladiator filter (proved on the real database). Visitors get no "Your standing" and make no one-row read.
- **Request discipline:** a picked finished season is never re-read, the followed current season always is, and the season list is re-read only when it is stale. A live test counts each kind of read.
- **Text:** Intl supplies numbers only; day and month names are fixed, so ICU drift cannot change the copy. DST, a UTC day that differs from the local one and three zones are tested.
- **Accessibility:** a native labelled `<select>`, season regions named by their headings, a labelled progress bar and prize medals with ordinal labels.
- **Visual:** current, current with standing, archived, footnote, profile, visitor and 360 px shots all match the approved mockup, with the documented deviations (square bordered pills, six figures in "Your standing", a two-line "Human W–L" header).

**Important finding I1 (fixed):** the archived promotion footnote (`promotionNote`, `season-text.ts`) said a promoted qualifier ranked above the last medal "is rewarded there". A promoted row that is not eligible only proves the gladiator qualified higher, not that they placed there; in the plan's Review Focus 4 case (qualifies higher, places fourth, gets nothing in either league) the copy would claim a reward the player never got. Fix round 1 (`bab7580`) reworded it so it cannot assert a reward, and tests forbid `/(is|are) rewarded/`. Fix-round evidence: focused units 37/37, full units 1056, `seasons.spec` 18/18.

**Controller rulings (see the appendix):**
- "Your standing" keeps combat strength and adds Season rank and Human bouts, although the mockup showed four fields.
- 21.4 may add the one-row `standingOf` read.
- The brief's "Sat 15 Nov, 19:00" was the controller's error: 15 Nov 2026 is a Sunday, and the test expects "Sun 15 Nov, 19:00".

**Minors:**
- **Fixed in the final fix wave:** M1 (`qualifyText` names the league), M2 (✓ Eligible is not uppercase) and M6 (the medal emoji is `aria-hidden`).
- **Deferred:**
  - M3: the owner's `standingOf` and profile are re-read at each revision while a finished season is shown;
  - M4: the 30 s `useNow` tick re-renders the whole panel, and `sync()` never notifies;
  - M5: a duplicated `capital` helper and two `ORDINALS` arrays;
  - M7: no 360 px screenshot of the medal rows (a test asserts the fit);
  - M8: the glass profile sheet on touch lets panel text show through (pre-existing).

## Final whole-branch review and fix wave

Range `69ed674..6b00f3f` (15 commits, 38 files, +4838/−170), reviewed read-only by the most capable reviewer in three passes: SQL and M15 against the decisions and spec; reads, gateway and fixtures; the UI and every test. Nothing was run. **Verdict: ready to merge (yes).** No Critical findings; one Important; seven Minor.

**What it confirmed across checkpoints:**
- **One authority:** SQL ranks, qualifies, selects and pays; TypeScript only names windows and words. No TypeScript award selector exists to drift.
- **Once-only and atomic:** the close locks the season row and returns 0 once closed; the award keys and the archive CHECK make a second payment impossible; the archive is one `INSERT … SELECT` with window aggregates.
- **Locks:** the order agrees with every existing path. The phase-2 and phase-3 cycle with a market buy is the accepted exception.
- **Skipped boundaries:** phase 2 closes by open season row, so a skipped boundary 504 is handled by construction, and the test drives it through `coordinate_work` as the worker does.
- **Review Focus 1–5** each has a named test.
- **M15:** complete and replayed. Defaults (invoker, volatile) are pinned by catalog tests.
- **Visitor security:** `seasons` and `season_standings` are anonymously readable with nothing else; awards, rules and the close functions are backend-only, proven at the catalog level.
- **Reads and UI:** validated inputs, pinned request shapes, whole-league `standingOf` rank, and request discipline counted by a live test.

**Important finding I1 and ruling:** phase 2 runs before the epoch gate, so "every season with ratings has a row" holds only when the epoch is set before any boundary with members reaches phase 2. If the epoch is set while such a boundary waits at phase 4 (`'epoch'`), phase 4 can rate a season with no `seasons` row; if that boundary is the season's last slot under the new epoch, the season is never closed, archived or paid. It is unreachable in the documented launch flow (Task 24 sets the epoch with no gladiators before launch; locally `resetIdentity` sets epoch 0 first), so it does not block the push.
- **Controller ruling:** no migration now. The final fix wave adds the launch-ordering sentence to Task 24 in the 24-task plan and a "Known limit" paragraph to `migrations.md`. The defensive phase-4 insert and the `season_bounds` helper go to M16 (Task 22). M15 is never edited.

**Final fix wave:** `1ef320f` (code), `ce9f4fa` (docs) and `c7f724a` ([report](task-21-report.md#final-fix-wave-whole-branch-review)). It took 21.4 M1, M2 and M6, 21.3 M6 and the documentation part of Important 1. No SQL behavior, migration, Edge function or dependency changed.

**Scoped re-review:** all five items ADDRESSED, no new breakage. Out-of-scope notes: the plan's Decision 6 line and the 21.3 report line 82 still state the invariant unconditionally (historical), and the Task 24 sentence's second clause (a boundary already waiting at `'epoch'` must not be a season's last slot) is defense in depth.

**Fix-wave evidence:**
- unit tests 1056/1056; `tsc` and `deno check` clean;
- `seasons.spec` 18/18; arena and arena-live specs 65 passed, 1 skipped.

## Deferred Minor items and the final triage

**Triage result: none must be fixed before the push.** The final review recommended 21.4 M1 (plus M2 and M6), and the wave took them.

**Addressed in the branch:**
- 21.1 M1–M4 (in 21.2), 21.3 M2 and M3 (in 21.4), 21.4 Important I1 (fix round 1);
- 21.4 M1, M2 and M6 and 21.3 M6 (final fix wave).

**Stay deferred, with the reason:**
- **21.2 M1** (promotion test filters to season 1): only phase 4 inserts rating rows, and only for the boundary's own season, so a post-close season-0 insert has no game path.
- **21.2 M2** (bounds helper): needs M16; cosmetic. Folded into the Important fix's migration.
- **21.2 M3** (fourth copy of boundary-driving helpers): a test refactor across four files; do it with the next DB-test task.
- **21.2 M4** (report evidence noise): recorded; no code effect.
- **21.3 M1** (fixture `archiveOf`): documented, and pinned by name in `fixture-gateway.test.ts`.
- **21.3 M4** (fixture-gateway league list and nested ternary): cosmetic.
- **21.3 M5** (`'fixture-season-1'` in tournament fixtures): an engine seed label, not a season id.
- **21.3 M7** (one malformed prestige entry fails the profile read): the table CHECKs make it impossible; extend `BADGES` and `LEAGUES` with the migration.
- **21.3 M8** (small test gaps): low value.
- **21.4 M3** (owner `standingOf` and profile re-read while an archive is shown): one lookup and one row per revision, accepted by ruling.
- **21.4 M4** (30 s tick re-render): `subscribe` fires only on `freeze`; the cost is a cheap re-render of at most about 100 rows and, at worst, a 30 s delay of the countdown.
- **21.4 M5** (duplicate `capital` and `ORDINALS`): cosmetic.
- **21.4 M7** (no 360 px screenshot of the medal rows): the test asserts the fit.
- **21.4 M8** (glass profile sheet on touch): pre-existing.
- **Final review Minor 3** (`readStandingOf` sorts the whole league-season per owner read at each revision): fine at current size; Task 23 decides whether a rank cache is needed.

## Carried items

**Task 22:**
- **Migration M16** (the next schema change):
  - a defensive `insert into public.seasons … on conflict do nothing` in phase 4 (`private.boundary_recompute_leagues`), so every rated season has a row unconditionally;
  - a `private.season_bounds(index)` helper used by phase 2, the backfill and phase 4 (see [migrations.md](../operations/migrations.md), M15 "Known limit"). M15 is never edited.
- **Retention and pruning** must respect `season_awards` references to gladiators and operation receipts: removing a character or a receipt must account for the award first. Keep `seasons`, `season_standings` and `season_awards` indefinitely (spec §11).
- **Optional:** shared boundary-test helpers in `tests/fixtures/boundaries.ts` in place of four copies (21.2 M3).

**Task 23:**
- **Capacity evidence** for the synchronous close inside the boundary transaction (Ruling: if it grows too large, move it to a fenced job) and for the `arena_standing_reads` page and one-row costs.
- **The accepted phase-2 and phase-3 account-lock cycle with a market buy** (40P01 is handled; at most one delayed boundary per collision at a season end). A later fix would pre-lock the union of members and awardees in gladiator order in phase 2.
- **The known flaky arena DB test timeout** ("promotes from real Task 8 acquisitions only at a boundary…"): one 60 s timeout, not reproduced.
- **Accessibility checks** of the standings and profile additions: the picker, the progress bar, the medal pills (checked by accessible name, not with a screen reader), focus and contrast.

**Task 24:** set the season epoch before any boundary with members exists, and never in the past (plan Task 24 Step 3, [migrations.md](../operations/migrations.md) M15). A boundary already waiting at phase 4 `'epoch'` must not be the last slot of a season under the chosen epoch. M15 deploys before the epoch is set, so nothing is backfilled in production and the first launch boundary creates season 0's row.

**Recorded:**
- The picker and `readSeasons` show at most 50 seasons (about four years); the data is kept indefinitely and paging can be added later.
- `closed_at_ms` is database time at the close, while the UI labels "ended" by `endsAtMs` (plan-specified).
- `standingOf` reads the owner's current league only, so a mid-season promotion shows the new league's rank; the wording consequence was fixed (21.4 M1).
- The standings table headers changed from uppercase to sentence case and cell padding narrowed for all standings, matching the approved mockup and the 380 px fit.
- A boundary with members waiting at phase 4 `'epoch'` can wait forever if the epoch is set above its target slot: Task 16's design and Task 24's launch procedure.
- **Pending Avi:** the proposed migration-guide upkeep (fingerprint records trigger enablement and singleton rows; rollback-only checks run as raising `DO` blocks) from the 21.2 incident.

## Appendix: every controller ruling (from the execution ledger)

Each line gives what was decided, why, and what it costs if wrong. They are copied verbatim from the ledger, in ledger order, before its deletion.

- Ruling: 21.1 is committed but not pushed alone; the first push is after 21.2 (with M15) — a 21.1-only origin would fail DB tests on a clean replay — costs one larger reviewed push if wrong.
- Ruling: no TypeScript selectSeasonAwards (plan Decision 2 deviates from the 24-task plan's interface) — SQL is the single authority so two implementations cannot drift — if wrong, a later TS mirror is additive.
- Ruling: seasons UI goes inside Arena standings (no new menu), pending Avi's mockup approval — keeps the approved shell's menu set — if Avi prefers a separate menu, only 21.4 changes.
- Ruling: season close is synchronous in boundary phase 2 (no job, no coordinator_token RPC) — phase 1 already proves every earlier slot settled and the coordinator lock serializes it — if the close ever grows too large for one boundary transaction, move it to a fenced job (Task 23 capacity evidence decides).
- Ruling: plan Decisions 3/5 grants were wrong — advance_boundary/coordinate_work run as service_role (security invoker), so close_season/season_rules get EXECUTE to service_role (revoked from public, anon, authenticated) and the tables get service_role DML as needed (season_awards select,insert; season_standings select,insert; seasons select,insert,update), exactly the 07-arena.sql/03 pattern for boundary functions and arena_ratings — costs nothing if wrong beyond a grant change; clients still get nothing beyond SELECT on the two public tables.
- Ruling: no extra held-account-lock test in 21.1 (implementer concern 3) — the brief did not ask and 21.2's boundary tests exercise the real path — a lock-order defect would surface in 21.2 or the final review.
- Ruling: the view repeating the 5-bout literal is accepted (visitors cannot call private.season_rules) provided a test pins 4 vs 5 in the view — costs a drift if RULES_V1 changes without the view.
- Ruling: accept the rare season-boundary deadlock (phase 2 takes award account locks before phase 3's member locks, so a concurrent market buy can form a cycle) — Postgres aborts one side: the buy maps 40P01 to processing (M14), the boundary subtransaction rolls back and retries next coordination — costs at most one delayed boundary per collision at a season end; a later fix would pre-lock the union of members and awardees in gladiator order in phase 2.
- Ruling: the skipped-boundary test may use operator-seeded rating rows (in a real world a rated character is always due at 504) — it proves robustness of the "close every ended season" rule — costs nothing if wrong.
- Ruling: a cursor naming a season with no public.seasons row reads as an open season (the empty-seasons fallback), while a named seasonId with no row is unavailable — in production every rated season has a row (phase-2 invariant + M15 backfill) and existing direct-seeded DB tests page that way — costs a misleading open page only for operator-seeded data.
- Ruling: a malformed seasonId is unavailable even beside a valid cursor (stricter than Decision 7's precedence) — bad input should fail loudly — costs nothing for real callers, which never send both.
- Ruling (carried to 21.4): a season may close between pages (page 2 archived, same frozen ranks) and the newest season can be briefly empty after a boundary that waits between phases 2 and 4 — the UI shows its normal empty state and keeps the previous season in the picker — costs a brief empty view.
- Ruling: "Your standing" keeps League, Rating, Renown and Current combat strength and ADDS Season rank and Human bouts (Decision 8 says "adds"; spec §8.1 requires current combat strength to stay visible) although the mockup showed only four fields — costs a slightly taller card.
- Ruling: 21.4 may add a public one-row read GameGateway.standingOf(league, gladiatorId): Promise<StandingRow | null> (current season, arena_standing_reads filtered by gladiator) so Season rank and Human bouts work when the owner is outside the loaded page — costs one small read per open/revision.
- Ruling: the brief's 'Sat 15 Nov, 19:00' is my error — 15 Nov 2026 is a Sunday (as is 18 Oct 2026); the test expects 'Sun 15 Nov, 19:00' — costs nothing.
- Ruling: final Important 1 (phase 2 runs before the epoch gate, so a season whose last slot is a boundary waiting at phase 4 'epoch' when the epoch is set could get rating rows and no seasons row, never closing) — not fixed by a migration now: it is unreachable in the documented launch flow (epoch set before any boundary with members; locally resetIdentity sets epoch 0 first). This wave adds the launch-ordering sentence to Task 24 in the 24-task plan and to migrations.md, and the defensive phase-4 `insert into public.seasons … on conflict do nothing` plus a private.season_bounds helper (21.2 M2) are carried to the next schema migration (M16, Task 22) — costs one misconfigured-launch season if Task 24 ignores the note.
- Ruling: final fix wave takes 21.4 M1 (qualifyText names the league), 21.4 M2 (Eligible not uppercase), 21.4 M6 (medal emoji aria) and 21.3 M6 (gateway doc "without a cursor"); every other deferred minor stays deferred per the final review's triage — costs only polish.
