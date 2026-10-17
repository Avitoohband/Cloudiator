# Task 13 final-review fix wave — report

**Status: DONE_WITH_CONCERNS.** All six Minors are fixed and every gate passed. The concerns below are judgment calls, plus one suggested follow-up.

**Commit:** `30257f1` fix: land the Task 13 final-review Minors 1-6. It sits on base `d8b1195` and is not pushed.

## Setup

- **Worktree and branch:** `C:\Avi\Studies\Projects\Cloudiator-claude`, `claude/task-13`.
- **Base:** `d8b1195` (docs: record the Task 13.9 review). The working tree was clean at the base.
- **Scope:** final-review Minors 1–6 only, each test-first. No SQL change, no package or tool download, no HANDOFF edit, no push or merge, no subagent.
- **Read first:**
  - `AGENTS.md` (all sections) and `docs/operations/verification-gates.md`.
  - The plan's Global Constraints and Decisions, the spec, the review record and the SDD ledger.
  - Two Next.js guides, `01-app/02-guides/environment-variables.md` and `03-api-reference/05-config/01-next-config-js/env.md`. They cover how `NEXT_PUBLIC_*` and `env` values are inlined, which the Minor 4 guard relies on.

I checked each finding against the code before fixing it. Every reviewer statement held.

## 1. An owner's summary outlived the session (replay and expedition, pages and scenes)

**What the code did.** The `ActivityReplay` and `ExpeditionView` keys did not include the account.
- **`/replay/`:** after a sign-out, the sync's world re-read restored the clock, and only the battle player remounted. It kept the old view and its summary.
- **`/expedition/`:** the held timeline stayed, with its `summary` (so `isOwner` stayed true). The sync re-read the same revision, so the view saw no new revision and did not re-read.
- **Expedition scene:** the scene kept its timeline until the visitor re-read landed, and kept it forever if that read failed.
- **Replay scene:** already safe. Its visitor reads wrapper changes identity with the viewer, so the scene reloads without the summary.

**RED.** New test in `tests/browser/scenes.spec.ts`: "an owner's replay and expedition when the session ends" › *leaves no credited reward on the pages or the scenes once the session ends in another tab*.
- Setup: a signed-in owner (seeded session, owner fixture) opens each surface and sees the credited rewards.
- Sign-out: the test holds the `visible_events` re-read, then ends the session the way another tab does. It removes the shared `sb-127-auth-token` and posts `SIGNED_OUT` on supabase-js's `BroadcastChannel` of that name.
- Check: it waits for this tab's anonymous reads, then expects no reward text, both while the re-read is held and after it lands. Replays are skipped to their result first.
- Results per surface:
  - **`/expedition/?activity=<woodland>`:** failed while the re-read was held. The page still showed "Credited rewards +20 money +100 XP Light boots (tier 1, uncommon) ×1 Salvage ×1".
  - **`/replay/?activity=<owner bout>`:** failed after the re-read. "Credited rewards +2 renown +15 money +40 XP Rating +12" came back on screen.
    - A first draft without "Skip to result" passed here by accident, because a remounted player restarts at 0 s. The test now skips to the result.
  - **The two scene surfaces only** (a temporary `surfaces.slice(2)` run, reverted afterwards):
    - `/game/?view=expedition&…` failed while the re-read was held, still showing the owner's rewards.
    - `/game/?view=replay&…` passed, because it was already safe. It stays in the test as a guard.

**GREEN.** The keys now include `session.userId ?? 'visitor'`.
- `src/app/replay/page.tsx` and `src/app/expedition/page.tsx` add `…|${reader}` to the `ActivityReplay` and `ExpeditionView` keys.
- `src/features/shell/SceneOverlay.tsx` keys both views by `viewKey = ${sceneKey}|${state.session.userId ?? 'visitor'}`. The `sceneKey` used for focus and scroll is unchanged.
- The views mount only once the session is known (`session.status !== 'loading'`), showing "Loading the replay…" or "Loading the expedition…" until then.
  - Without this gate, a signed-in reader's first render (userId still null) would mount as `visitor` and remount a moment later. Every signed-in deep link would read its timeline twice.
- The new test passes on desktop and mobile; `scenes.spec.ts` passes 24/24.

## 2. A refused visitor got a silently empty camp

**What the code did.**
- `checked()` mapped 401, 403 and `42501` to `unauthenticated`, and `createSync` publishes `world: null` for that.
- The shell showed "Connection lost" only for `unavailable`.
- A local sign-out needs a `signed-in` session, so a visitor got neither a notice nor a sign-out.

**RED.** New test in `tests/browser/full-screen.spec.ts`, under live failures: *says the connection is lost when a visitor's public reads are refused*.
- `world_revision` answers 401 `42501` for every reader, through a new transport method, `refuse(table)`.
- It failed: no "Connection lost — showing the last known camp" status appeared. The snapshot showed only the visitor chip, "Sign in with Google to join".

**GREEN.** In `src/features/shell/CampShell.tsx`, the notice now shows for `unavailable`, and also for `unauthenticated` when `session.status === 'signed-out'`.
- The test also checks the visitor chip, that every read was anonymous, that no Auth call was made, and recovery: once the table is served again, the camp loads and the notice goes.
- The "live failures in the shell" group passes 8/8 on both projects. That includes *never says the connection is lost while a rejected session is signed out*.

## 3. Local sign-out without a refresh attempt

**What the code did.** `useGameState` signed out (`scope: 'local'`) at the first `unauthenticated` publish of a signed-in session.

**RED** (all in `tests/browser/live-camp.spec.ts`):
- **Existing test, new assertion:** *signs a rejected stored session out locally…* now also expects `['token:refresh_token', 'logout:local']`, in that order. It received `['logout:local']`.
- **New test:** *keeps a player signed in when one refresh renews a rejected stored session*. The transport's new `renewSessions()` makes the refresh grant return a new session whose token the server accepts. The test failed: the chip name "Aster" never appeared, because the player was signed out instead.
- **New test:** *signs out locally when the renewed session is still refused at the next read*, using `renewSessions({ accepted: false })`. It received `['logout:local']`, with no refresh.

**GREEN.**
- `src/lib/api/session.ts` adds `refreshSession()`, which calls `client.auth.refreshSession()` and returns true when the session was renewed.
- `src/features/character/useGameState.ts` handles the first rejected publish:
  - It tries one refresh.
  - If the session is renewed, the sync re-reads (`controller.refresh()`) and the owner is read again.
  - It signs out locally only when the refresh is refused, or when the renewed session is still refused at the next publish.
- The existing retry behaviour is kept: one attempt per publish object, never two at once. A successful read lets a later rejection have its own refresh.
- `live-camp.spec.ts` passes 20/20 on both projects. That includes *retries a failed local sign-out…* (`['local', 'local']`) and *drops the rejected session locally even when the server refuses its sign-out*.

**Library behaviour relied on.** I read this in `_callRefreshToken` in `@supabase/auth-js` 2.117.3.
- When a refresh is refused with a non-retryable error, auth-js keeps the stored session as long as the access token is still valid by the device clock. That is the slow-clock case, so the local sign-out that follows still reaches `/auth/v1/logout?scope=local`.
- If the access token has already expired locally, auth-js removes the session itself.

## 4. The fixture gateway chunk was in the production export

**What the code did.** In `CampShell`, `if (fixture) import('../../lib/api/fixture-gateway')` depends on a prop, so the bundler kept the import.
- The chunk was `out/_next/static/chunks/0axv2hfdwf-sd.js`, 457,902 bytes. The same chunk was in `.next/browser-test/`.
- The replay and expedition pages already guard their import with the inlined flag.
- No other fixture-only dynamic import exists. The remaining dynamic imports load Phaser and the scenes.

**RED.**
- New cases in `tests/static.test.ts`, *scanner refuses fixture preview data in an exported chunk* (one per marker): each returned status 0 where 1 was expected.
- I then ran the new scanner on the existing artifacts, before the source fix. Both `npm run verify:static` and `npm run verify:static -- .next/browser-test` failed with `Fixture preview data in _next\static\chunks\0axv2hfdwf-sd.js`.

**GREEN.**
- `CampShell.tsx` now guards the import with `if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true' && fixture)`.
- `scripts/verify-static.mjs` now fails on either of two markers:
  - `unavailable in the fixture preview`, the fixture gateway's own refusal message;
  - `fixture-receipt-`, the receipt ids of the sample summaries.
  - Its success line now ends with "no fixture preview data".
- Both scanner runs check production builds. `next.config.ts` forces `NEXT_PUBLIC_FIXTURE_ENABLED` to `'false'` whenever `NODE_ENV === 'production'`.
  - That includes the isolated `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true` build. Its production gate already proves fixtures are refused there.
  - So the marker check is unconditional, and both runs pass (see Gates).

## 5. Two owner reads on every tab return

**What the code did.** Both `focus` and `visibilitychange` called `loadOwner`.

**RED.** In `live-camp.spec.ts`, *a signed-in player … re-reads the owner on a new revision, slot or focus*: I changed the focus step into a tab return (both events, more than 2 s after the last owner read). It expected 4 owner reads and received 5.

**GREEN.**
- `useGameState.ts` now tracks how many owner reads are in flight and when the last one completed (`performance.now()`).
- A tab-return event reads only when no read is in flight and none completed within the last 2 s (`RETURN_READ_GAP_MS`).
- Reads triggered by a revision, slot or account change, and explicit `refreshOwner()` calls, are unchanged.
- The test also checks that a return within 2 s is served by the last read, and that a later return reads again.
- Two existing tests fired a single `focus` right after an owner read and expected a new read. They now wait 2.1 s first, which is the intended new behaviour:
  - `full-screen.spec.ts` › *tells a player when their gladiator could not be refreshed…*
  - `identity.spec.ts` › *a slow no-character focus read cannot replace the confirmed creation owner*

## 6. "In this build" copy for live read failures; malformed activity ids

**What the code did.**
- `loadReplayView` and `useTimelineReads` map every failure other than `not-found` to `unavailable`.
- That showed "Replays cannot be loaded in this build yet." and "It may not exist, or expedition scenes cannot be loaded in this build yet."
- `sceneOf` accepted any activity text, and so did `/replay/`. `/expedition/` already checked the id's shape.

**RED.**
- `tests/domain/scene-url.test.ts`:
  - *names no activity for a malformed id…* received `activityId: 'a1'`.
  - *says a live read failure cannot be loaded right now…* received "Replays cannot be loaded in this build yet."
- `tests/browser/scenes.spec.ts`, *says a failed live read cannot be loaded right now, and a malformed shared link is not found without a read*:
  - It first failed on `/replay/`, which showed "Replays cannot be loaded in this build yet."
  - After the copy change, it failed at the malformed link. The scene read `not-an-id` and showed "This replay is not available yet / The fight has not been revealed yet."

**GREEN.**
- New copy:
  - "This replay cannot be loaded right now. Try again shortly."
  - "This expedition cannot be loaded right now. Only revealed stages of an expedition are ever shown."
- `expedition-query.ts` exports `isActivityId`, built on its existing regex.
- `scene-url.ts` adds a `SceneAddress` type. A malformed id gives `activityId: null`, as `expeditionQuery` does, and `sceneOf` returns it.
- `SceneOverlay` shows not-found for such an address and reads nothing:
  - replay: "No fight was found for this link."
  - expedition: "No expedition matches this link."
- `useSceneHistory` and `CampShell` now take `SceneAddress`.
- `/replay/` validates the id the same way.
- Unit tests pass 10/10 (scene-url and expedition-query); the browser test passes 2/2. The browser test also proves that a malformed link sends no `visible_events`, `recent_results` or `activities` request.

## Gates (in `verification-gates.md` order, one at a time)

| Step | Command | Result |
| --- | --- | --- |
| 1 | `npm test` | 44 files, **995 passed** (989 at 13.9, plus 6 new unit cases) |
| 2 | `npm run typecheck` | clean: `tsc`, `deno check`, `deno test` 2/2 |
| 2 | `node assets/source/build-assets.mjs --check` | assets up to date (28 files) |
| 3 | `npm run build`, then `npm run verify:static` | Built. "5 fixed routes; **89 assets** scanned; no forbidden backend material; no fixture preview data". It was 90 assets before; the 457,902-byte fixture chunk is gone, and no file in `out/` holds either marker. |
| 4 | `npx playwright test --config node_modules/.cache/pw-claude.config.mjs` (port 3200) | **394 passed, 22 skipped, 0 failed, 0 flaky** in 7.5 min (384 at 13.9, plus 10 new cases). Its dev server had exited before step 5. |
| 5 | `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build` | built |
| 5 | `npm run verify:static -- .next/browser-test` | Exit 0: 5 routes, 89 assets, no forbidden material, **no fixture preview data**. This build forces fixtures off, so the new check does not fail it. |
| 5 | `PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test` (repo config, port 4173) | **16 passed, 400 skipped, 0 failed** |
| 6 | `git diff --check` | clean |

- **Not run:** `npm run test:db`, since nothing changed in SQL.
- **No overlap:** no build ever overlapped a browser run. The RED and GREEN iterations used targeted runs on the private port while no build was running.

## Files changed

**Source:**
- `src/app/replay/page.tsx`: account in the key, session-loading gate, UUID check (Minors 1, 6).
- `src/app/expedition/page.tsx`: account in the key, session-loading gate (Minor 1).
- `src/features/shell/SceneOverlay.tsx`: account in both view keys, loading gate, not-found for a malformed address (Minors 1, 6).
- `src/features/shell/scene-url.ts`: `SceneAddress`; `sceneOf` validates the activity id (Minor 6).
- `src/features/shell/useSceneHistory.ts`: takes `SceneAddress` (Minor 6).
- `src/features/character/expedition-query.ts`: exports `isActivityId` (Minor 6).
- `src/features/arena/BattleReplay.tsx` and `src/features/character/ExpeditionView.tsx`: read-failure copy (Minor 6).
- `src/features/shell/CampShell.tsx`: visitor notice (Minor 2), fixture import guard (Minor 4), `SceneAddress` prop (Minor 6).
- `src/features/character/useGameState.ts`: refresh before local sign-out (Minor 3), tab-return coalescing (Minor 5).
- `src/lib/api/session.ts`: `refreshSession()` (Minor 3).
- `scripts/verify-static.mjs`: fixture preview markers (Minor 4).

**Tests:**
- `tests/static.test.ts`: two refusal cases and one acceptance case (Minor 4).
- `tests/domain/scene-url.test.ts`: malformed ids and copy; the existing cases now use UUID ids (Minor 6).
- `tests/browser/scenes.spec.ts`: the owner session-end test (Minor 1) and the read-failure and malformed-link test (Minor 6).
- `tests/browser/full-screen.spec.ts`: the refused-visitor test (Minor 2), and a 2.1 s wait in the owner-refresh test (Minor 5).
- `tests/browser/live-camp.spec.ts`: the refresh-order assertion and two renewal tests (Minor 3), and the tab-return count (Minor 5).
- `tests/browser/identity.spec.ts`: a 2.1 s wait before the held focus read (Minor 5).
- `tests/browser/live-routes.ts`:
  - new transport methods `refuse(table)` and `renewSessions({ times, accepted })`;
  - stored refresh tokens now name their user (`test-only:<id>`);
  - issued access tokens carry a `jti`, so each renewal gets a distinct token.

## Concerns and judgment calls

1. **Copy wording.** I wrote "cannot be loaded right now", not the brief's "can't".
   - The interface copy uses no contractions anywhere.
   - It matches the existing Tournaments replay message: "This replay cannot be loaded right now. Try again shortly."
   - Switching to "can't" is a one-word change if wanted.
2. **Where "in this build" remains.** Neither view has a no-reader path any more.
   - Timelines have been read in every build since Task 13.2, and the replay overlay's `reads === null` case already shows "Loading…". So both views now use only the "right now" copy.
   - The "in this build" wording stays, untouched, where a panel really has no reader: `TournamentPanel` without reads, the Standings `unavailable` status, arena-text `build`, and the fixture-refused notices.
   - In an export without Supabase configuration (before Task 24), a replay or expedition now says "cannot be loaded right now". That matches the "Connection lost" notice the camp already shows in that export.
3. **Suggested follow-up for Minor 2 (not done; outside the brief).** The sync still clears the world on `unauthenticated` (the identity rule in `sync.ts`).
   - A refused visitor therefore sees "Connection lost — showing the last known camp" over an empty camp, so "last known camp" is inaccurate there. That was already true for a first-load `unavailable`.
   - Options: keep the world for a reader with no session, or vary the copy.
4. **Minor 1 goes beyond the literal key change.** The views mount only once the session is known.
   - Without that, a signed-in deep link mounts as `visitor` and then remounts, reading its timeline twice on every load.
   - An account change also remounts the expedition scene's Phaser view. That creates one more WebGL context, which the 13.8 `loseContext` fix releases.
5. **Minor 6 also covers `/replay/`.** A malformed `/replay/?activity=` had the same defect: a read, then the failure copy. `/expedition/` already validated the id; `/replay/` now uses the shared `isActivityId`.
6. **Minor 5 changes two older tests.**
   - `full-screen.spec.ts` (*could not be refreshed*) and `identity.spec.ts` (*slow no-character focus read*) fired a single `focus` right after an owner read.
   - They now wait 2.1 s of real time first, which adds about 4 s per project.
   - Coalescing applies to tab-return events only. Reads triggered by a revision, slot or account change, and `refreshOwner()` calls, are unchanged.
7. **Minor 3 depends on library behaviour.** It relies on auth-js 2.117.3 keeping the session after a refused refresh, while the device clock says the access token is still valid.
   - I read this in the library source, and the browser tests exercise it: the existing `scope=local` tests still see exactly one `logout:local` after the refused refresh.
   - If the access token has already expired locally, auth-js drops the session itself and the local sign-out does nothing. The view still ends as a visitor's.
8. **Test caveats.**
   - The replay scene was already safe before the fix, because its visitor reads wrapper reloads without the summary. Its case in the Minor 1 test passes before and after, and stays as a guard.
   - The `/replay/` RED needed "Skip to result". A remounted player restarts at 0 s, so the first draft without it passed by accident. I added the skip before recording the RED.
   - The RED for the two scene surfaces came from a temporary `surfaces.slice(2)` edit, reverted before the commit.
9. **Not done, as briefed:** no push, no merge, no `HANDOFF.md` edit, no subagent or reviewer.
   - This report is in the git-ignored SDD folder.
   - `next dev` left the `AGENTS.md` Next.js block unchanged.
