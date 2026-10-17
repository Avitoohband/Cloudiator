# Task 13 independent reviews: full-screen camp and visitor viewing

Plan: [Task 13 plan](../superpowers/plans/2026-10-16-task-13-full-screen-camp.md). Spec: [full-screen camp design](../superpowers/specs/2026-10-14-full-screen-camp-design.md). Each checkpoint has a fresh implementer and an independent reviewer, read-only on the worktree; the reviewers may run read-only catalog queries against the local stack "Cloudiator".

Controller rulings made before execution (plan pre-flight scan):
1. `tests/browser/live-routes.ts` (13.3) serves both a signed-out visitor and a seeded signed-in session.
2. The 13.5 Tab test also asserts the focus order: rail icons, then the corner chip.
3. The 13.8 leave-pose and encounter-count Minors are fixed wherever the logic actually lives.
4. Marketplace stays hidden until Task 18 builds it.

## 13.1: Visitor read access (M13)

Range `a8d59f9..43af136` on `claude/task-13`: `43af136` adds the source `supabase/sql/11-visitor-access.sql`, migration M13 `20261016141628_visitor_access.sql` and `tests/db/visitor-access.test.ts`. [Implementer report](task-13.1-report.md).

**Implementer evidence:**
- `test:db` 176/176 on the source and again on a clean M01–M13 replay, with the Edge start time unchanged.
- The 900-line parity fingerprint matched; `npm test` 922/922; typecheck and `git diff --check` clean.
- Lint empty; advisors INFO only.

**Reviewer evidence** (live catalog, label `com.supabase.cli.project=Cloudiator`):
- `anon` can SELECT exactly the 14 sanitized projections and has no write or execute privilege on any public or private object.
- `tournament_views.pairing_job_id` and `published_at_ms` are readable by no client (column SELECT for `service_role` only); its other 10 columns are granted to `anon` and `authenticated`.
- All 9 `player_read` and `due_read` policies are `{anon,authenticated}`, with their due-time predicates unchanged; no second policy exists; the 12 `owner_read` policies remain `{authenticated}`.
- JSON-path reads of `tournament_bout_results.result` keep working (table-level grant).

**Verdicts:** spec compliant; quality Approved; no Critical or Important findings.

**Accepted beyond the brief:** `revoke all on public.owner_state from anon`. It only removes privileges; without it, `anon` kept TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on that view from M01.

**Deferred Minors:**
- **Denial assertions:** some check only `error !== null`. Assert `42501` on the column reads.
- **Column list:** the 10-column `tournament_views` list is repeated; export it from `reads.ts` for the tests.
- **`anonWritable`:** it omits REFERENCES, TRIGGER and MAINTAIN. `anon` still holds the pre-existing MAINTAIN on the 8 M01 owner tables, which is not reachable through the Data API; hardening for Task 23 or 24.
- **M13:** a redundant generated revoke precedes the completion's revoke (harmless).
- **Tournament catalog check:** `has_any_column_privilege` slightly weakens the table-level check there.

**Carried to 13.2:** the visitor timeline read (`readTimeline` still queries owner-only `activities`) and a visitor `readProfile` DB test.

## 13.2: Public reads without a session

Range `abb5376..6fed6b0`: `f8d6fc3` (feature) and `6fed6b0` (review fixes). [Implementer report](task-13.2-report.md).

**Implementer evidence:**
- Unit tests 933/933; typecheck clean.
- `test:db` 177/177 with the Edge start time unchanged in each counted run.
- Build and `verify:static` clean; the live-gateway browser specs passed 36/36 on port 3200.

**Round 1 (full review).** Verdicts: spec ❌ for two deviations, quality Approved, no Critical or Important findings.
- **What it confirmed:**
  - All eight public reads use `publicRead`, which retries once on an account change and throws `unavailable` on a second change.
  - `owner()` and commands still require a session.
  - A visitor timeline never queries `activities`.
  - The shared log cache is cleared on an account change.
  - The fixture results carry only the six public summary fields.
  - The DB test reads world, profile, standings, tournament and a timeline as `anon`, with spectator parity.
- **Deviation 1:** `readTimeline`'s owner-summary option had a default instead of being required.
- **Deviation 2:** the fixture `recent()` cursor diverged from `readRecent` (malformed and empty cursors).

**Round 2 (scoped re-review of `6fed6b0`):** both findings ADDRESSED, no new breakage.
- The option is required at all 20 call sites.
- A shared `parseResultsCursor` gives identical cursor semantics, and `readRecent`'s behaviour is unchanged.

**Deferred Minors:**
- **Fixture rows:** the synthesized Training and Rest fixture rows share slots with existing fixture bouts, so the preview feed can show overlapping results.
- **Untested paths:** a `getSession` error read as a visitor, and an epoch-only account change.
- **Wording and noise:** two stale test names, an inaccurate cursor-format comment, and LF line endings in `tests/fixtures/results.ts`.

**Ruling carried to 13.3:** a public read can fail `unauthenticated` when the server rejects a stale stored token. `useGameState` maps that, while signed in, to a local sign-out, after which reads run as a visitor.

## 13.3: One shared game state, sync clock and live camp

Range `22ad713..46fd8c3`: `5bb3452` (feature) and `46fd8c3`, a pre-review test fix. That fix routes the live expedition and replay reads, which 13.2's sign-in-free reads had left reaching the local stack in two specs. [Implementer report](task-13.3-report.md).

**Implementer evidence:**
- Unit tests 939/939; `test:db` 177/177 with the Edge start time unchanged.
- Typecheck, build and `verify:static` clean.
- Development browser suite green after `46fd8c3` (expedition 46 passed, replay 36 passed); production gate 14 passed.

**Verdicts:** spec compliant; quality Approved; no Critical or Important findings.

**What the reviewer confirmed:**
- **Sync offset:** it comes only from a timed `revision()` round trip. The Task 10 bias test is RED at 1 950 ms off and GREEN under 50 ms.
- **`useGameState`:**
  - It owns the sync controller, the shared clock and account-scoped owner reads.
  - Live mode never uses fixture state.
  - While the session says signed in, a server-rejected stale token signs out locally (mutation-checked).
- **`GameViewport`:** it reports its scene status and no longer re-anchors a shared clock.
- **The page:** it mounts the camp live, keeping its layout.
- **`tests/browser/live-routes.ts`:** it serves visitors and seeded sessions, fails loudly on unknown traffic and refuses anon on private tables.

**Deferred Minors carried to later checkpoints:**
- **To 13.5:**
  - retry a failed local sign-out;
  - pin `scope=local` in its test;
  - make `activityStatus` robust to a slot index up to 30 s old (`max(slotIndex, slot of now)`);
  - surface sync, scene and owner-refresh failures in the shell.
- **To 13.8:** rename the expedition test that now reads, and decide what an unknown live expedition shows.
- **To 13.9:** cover the camp's live timeline and tournament reads for a visitor.

**Other deferred Minors:**
- **Sync and clock:**
  - the first timed sample is lost when the first world load fails;
  - timeline reads still nudge the shared clock forward;
  - the world memo relies on the revision embedding the slot.
- **Test transport and specs:** unexercised transport helpers; two specs still seed sessions by hand.
- **Owner reads (Task 23 measurement):**
  - the owner is re-read on every revision change (plan-mandated);
  - one extra owner read follows creation.

## 13.4: Panels follow the shared clock and revision

Range `52c697f..d9a0d27`: `c035491` (feature) and `d9a0d27` (review fixes). [Implementer report](task-13.4-report.md).

**Implementer evidence:**
- Unit tests 939/939; typecheck clean.
- `test:db` 177/177 with the Edge start time unchanged.
- Full development browser suite 290 passed and 8 skipped; production gate 14 passed.
- The controller re-ran the build and static scan after the fix round: 5 routes, 91 assets, clean.
- Two earlier `test:db` runs failed on the known coordinator busy race in the production-cadence timing test (`arena.test.ts:642`, 120 991 ms against a 120 000 ms bound). That test is flaky and is tracked for Task 23.

**Round 1 (full review).** Verdicts: spec ❌ (R3), quality Needs fixes.
- **What it confirmed:**
  - The Schedule panel re-estimates from the shared clock (the Task 6 stale-clock gate).
  - Standings re-read exactly on a revision change; `standings-refresh.ts` is deleted.
  - R2: the owner refresh is held in a ref and awaited before the tournament read while preparing.
  - Visitors get a league picker that defaults to Bronze.
  - The live id uses `tournamentLookupIdOrNull`; the unreachable "You advance…" branch is removed.
  - A spectator Arena card has the owner summary stripped, so it never shows credited lines.
- **I1 (Important):** R3 still let visitors and new gladiators read "No tournament matches" during preparation. The plan's premise was wrong: the revision's slot is the slot by time, not a publication signal.

**Controller rulings:**
- **R3:** a not-found tournament reads "Tournament being prepared" for every viewer for 300 s after its slot starts (`TOURNAMENT_PREPARE_GRACE_MS`), and longer while a player's processed slot lags. A server published-slot field is Task 23/24 scope.
- **M1** joined the fix round: the card showed "Loading" forever when the sync never succeeded, a regression this diff introduced.

**Round 2 (scoped re-review of `d9a0d27`):** both ADDRESSED, no new breakage.
- The grace is measured from the tournament slot's start and never applies outside it.
- `revisionSlotIndex` was removed with no dangling caller.
- `syncError` is wired from the page.

**Deferred Minors:**
- **Carried to 13.5:** the league picker flashes for a player whose owner is still loading.
- **Carried to 13.6:** visitors still see a disabled Registration box.
- **Other:**
  - a re-render each second under a held clock;
  - a non-null assertion on a malformed later-round bye;
  - extra owner reads while preparing;
  - one extra profile read;
  - the unused `tournamentIdFor`;
  - `TournamentPanel.tsx` has grown to 577 lines.

## 13.5: The full-screen shell, rail, panels and chip

Range `1cd64eb..6bbbdbe`: `5c109f6` (feature) and `6bbbdbe` (review fixes). [Implementer report](task-13.5-report.md). The implementer was resumed once after a PC restart, from its uncommitted work.

**Implementer evidence:**
- Unit tests 948/948; typecheck clean.
- `test:db` 177/177 with the Edge start time unchanged.
- Development browser suite 321 passed, 19 skipped, 0 failed after the fixes; production gate 16 passed.
- The controller re-ran the build and static scan after the fix round: 5 routes, 91 assets, clean.

**Round 1 (full review: spec, quality and visual).** Verdicts: spec compliant; quality Needs fixes.
- **What it confirmed:**
  - The seven menus (no Marketplace) and the exact accessible names, including "Schedule".
  - The Tab order: rail icons, zoom buttons, then the corner chip.
  - Panels render outside the camp element, so typing in a field never moves the camera; this is tested.
  - The camp stays visible when the scene is unavailable, with Find and Follow giving their reason.
  - Touch scrolling inside a sheet never pans the camp; this is tested with real touch input.
- **Carried Minors fixed, each with a test:**
  - `activityStatus` is robust to a stale slot index;
  - the shell shows sync, scene and owner-refresh failures;
  - the stale-session local sign-out retries and is pinned to `scope=local`;
  - the league picker shows only for visitors and gladiator-less viewers.
- **Visual:** a close match to the approved mockup on desktop and the phone.
- **I1 (Important):** closing any menu crashed the camp on Safari 16.4–17.3 (iOS 16.4–17.3), because `checkVisibility` is missing there.

**Controller rulings:**
- **Ratified:** the touch layout below 481 px pointer width, and the fixture pill's placement.
- **Added to the fix round:** the phone menu became one horizontally scrollable row of menu icons, as the spec's "shows the icons as a row" requires. It had wrapped into a block with zoom buttons; touch keeps pinch zoom.

**Round 2 (scoped re-review of `6bbbdbe`):** both ADDRESSED, no new breakage.
- The visibility check falls back correctly, and a test deletes the API and closes menus.
- The touch row is a single row at 360 px with no page overflow.

**Deferred Minors:**
- **Carried to 13.6:**
  - after a sign-out, the rail can stay open on a menu the viewer lost;
  - the "Connection lost" notice also shows during a stale-session sign-out;
  - the visitor chip still needs the Google mark and the short phone label;
  - capture visitor screenshots.
- **Other:**
  - the scene-unavailable notice can sit under an open panel at 1024 px;
  - Find and Follow are disabled without a reason for some roster rows;
  - the skip link is bypassed by the first Tab;
  - a stale press start can carry across pointers;
  - a duplicated countdown hook;
  - no "Following …" feedback (mockup follow-up);
  - the first-Tab fallback path and narrow pointer windows are untested.

## 13.6: Visitors watch and join

Range `43573b9..0332c2a`: `6f5730c` (feature) and `0332c2a` (review fixes). [Implementer report](task-13.6-report.md).

**Implementer evidence:**
- Unit tests 949/949; typecheck clean.
- `test:db` 177/177 with the Edge start time unchanged.
- Build and `verify:static` clean (5 routes, 90 assets).
- Development browser suite 338 passed, 22 skipped, 0 failed after the fixes; production gate 16 passed.
- The controller re-ran the build and static scan after the fix round.

**Round 1 (full review: spec, quality and visual).** Verdicts: spec compliant; quality Needs fixes.
- **What it confirmed:**
  - The visitor sees the camp with only the "Sign in with Google to join" chip (Google mark; "Sign in to join" on touch) and the five public menus.
  - The visitor's My gladiator shows the sign-in prompt.
  - After sign-in without a gladiator, a native modal "Create your gladiator" dialog opens over the running camp. "Not now" leaves a "Create your gladiator" chip, and the draft survives.
  - A cancelled or failed sign-in returns to the visitor view with a short message, and the parameter is removed (Decision 6).
  - A session change closes private menus and leaves no private value on screen.
  - The carried Minors are fixed:
    - Registration is hidden for visitors;
    - a lost menu closes the rail;
    - "Connection lost" shows only for `unavailable`.
- **I1 (Important):** the shell's global Tab and Escape handling broke keyboard use inside the modal dialog.
- **I2 (Important):** Back from Google could leave the join button stuck on "Opening Google…" when the browser restores the page from its back-forward cache.

**Controller ruling:** a 360×740 dialog overflow check joined the fix round, because the Global Constraint binds it and no screenshot covered it.

**Round 2 (scoped re-review of `0332c2a`):** all ADDRESSED, no new breakage.
- The keyboard guard stands down while a modal is open.
- Focus moves to the alert after a refused creation.
- A persisted `pageshow` resets the button; it is tested with a dispatched event, because this Chrome has no back-forward cache.
- The dialog fits at 360 px.

**Deferred Minors:**
- **Edge cases:**
  - a second Escape mid-send can close the dialog before success is applied;
  - expiry and account-switch browser cases are untested;
  - focus can fall to `body` after some unmounts.
- **Polish:**
  - a 28 px notice close button;
  - the duplicated fake Google flow in two test helpers;
  - one extra owner read;
  - a duplicated modal query.
- **Product choices for Avi:**
  - My gladiator opens after creation, where the mockup shows a welcome toast;
  - the creation dialog reopens on each visit until a gladiator exists.

## 13.7: Results, profile cards and merchants

Range `8b423f7..2268aff`: `2268aff` (feature). [Implementer report](task-13.7-report.md).

**Implementer evidence:**
- Unit tests 965/965; typecheck clean.
- `test:db` 177/177 with the Edge start time unchanged.
- Build and `verify:static` clean; development browser suite 352 passed, 22 skipped; production gate 16 passed.

**Controller ruling:** a camp click on an Arena entrant keeps opening its Arena bout card, not the profile card. Every other gladiator opens the profile card, and an entrant's profile card (with "Watch bout") opens from the Gladiators list and the standings.

**Verdicts (full review: spec, quality and visual):** spec compliant; quality Approved; no Critical or Important findings.

**What the reviewer confirmed:**
- **Results:** pages of 50 with "More" and "You" marks.
- **Training and Rest:** they never offer a replay or say "no longer kept" (Tasks 7 and 9).
- **Profile card:**
  - It opens from `select-character`, and the Gladiators and standings names are keyboard paths to it.
  - It sits near the actor on desktop and is a sheet on touch.
  - It reads the public profile on demand, with an "unavailable" fallback.
  - The viewer's own card adds shortcuts.
- **Merchants:** a click opens the matching shop tab for a player, and the sign-in prompt for anyone else.
- **Privacy:** no private value reaches a visitor; this is tested with anonymous reads and no command sent.
- **Carried Minors:**
  - the synthetic fixture rows moved to idle slots;
  - roster rows explain a disabled Find or Follow;
  - joining and camp-click handling moved into hooks.
- **Visual:** faithful to the mockup's card and rows.

**Deferred Minors:**
- **Carried to 13.8:**
  - skip Arena entrants in the profile-card listener, with a regression test (today it fires one discarded profile read);
  - route Results "Replay" by kind (expeditions to the expedition scene).
- **Carried to 13.9:** the fixture Results still show duplicate Aster rows.
- **Other:**
  - Results do not refresh while open;
  - a latent page cap in `readResults`;
  - the "record" label wording;
  - `CampShell.tsx` has grown to 294 lines;
  - two helper tests were written after the code (they pin exact branches);
  - no 360 px or live-visitor card test;
  - visual polish: generic result lines and "Now" text, a blur behind the card, and a wrapping "You" tag.
