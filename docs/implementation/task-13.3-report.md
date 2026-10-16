# Task 13.3 report: one shared game state, sync clock and live camp

Worktree `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-13`, base `22ad713`.
Commit: `5bb3452 feat: share one sync clock and show the live camp` (not pushed).

## What was implemented

`src/lib/api/sync.ts` (the Task 10 offset bias)
- Every refresh, the first included, starts with one timed `revision()` read. `offsetMs` comes only from that round trip's midpoint.
- The world loads only when there is none yet or the revision changed; an unchanged revision is merged into the world as before.
- Consequence: a page load is one small `revision()` read, then `world()`. Polling is unchanged (one revision read every 30 s).

`src/features/character/activity-status.ts` (new)
- `activityStatus(owner, slotIndex, nowMs)` returns `{ status, label, endsAtMs }`.
  - "Processing results": ended (`nowMs >= endsAtMs`), not `completed`, and `processedSlotIndex < slotIndex`.
  - "Preparing your next activity": `completed` and `processedSlotIndex < slotIndex`; also when `currentActivity` is null.
  - Otherwise by time: Scheduled, In progress, Completed.
  - `endsAtMs` is the activity's end while Scheduled or In progress, else null.
- Produced and tested here. Nothing renders it yet: the layout is unchanged, and 13.5 consumes it.

`src/features/character/useGameState.ts` (new)
- `useGameState(gateway, { fixture, previewAs })` returns the brief's `GameUiState`, same shape.
- One `createSync` per gateway; it wires `subscribeSession`. Each publish with `offsetMs !== null` calls `clock.sync(Date.now() + offsetMs)`.
- The owner is read when the account changes, the revision changes, the server slot advances, the tab regains focus, and on `refreshOwner()`.
  - A ticket lets only the latest read land. An account change invalidates reads in flight, and a signed-out view keeps no owner.
  - `not-found` means no gladiator. Any other failure sets `ownerError: 'unavailable'`.
  - A failed refresh keeps an owner already shown. It never keeps a "no gladiator" answer, so a failed read never offers creation.
  - `refreshOwner()` rejects when its read fails (the panels' existing "could not be confirmed" path). It resolves when a newer read supersedes it.
- Viewer:
  - Fixture: `previewAs: 'visitor'` gives `visitor`; otherwise `player` once the fixture owner is read.
  - Live: session `loading` gives `loading`; `unavailable` (no Supabase configuration) gives `unavailable`; `signed-out` gives `visitor`.
  - Signed in: `player`, `no-gladiator`, `unavailable` (read failed) or `loading` (pending).
- Ruling 2: while the session says signed in and the sync reports `unauthenticated`, it calls `signOut({ scope: 'local' })`. The SIGNED_OUT event resets the sync, which then reads as a visitor.
- Fixture mode reads the fixture gateway the same way and wraps the world with `withDemoCrowd`.
- The world object is kept while its actors and revision are unchanged, so a 30 s poll does not hand the camp an unchanged world.
- `window.__cloudiatorShell = { clock }` only when `NEXT_PUBLIC_FIXTURE_ENABLED === 'true'`, like the other hooks.

`src/lib/api/session.ts`
- `signOut({ scope })`. The default is `global`, so the Sign out button is unchanged; `local` is for the stale session.
- supabase-js removes the local session even when the server refuses the sign-out (401/403/404).

`src/game/GameViewport.tsx`
- New `onStatus?(status: 'loading' | 'ready' | 'unavailable')`, called on each status change.
- When a shared clock is passed, the viewport no longer syncs it from world snapshots. This covers the world effect (old lines 117-123) and the same sync at the Phaser mount.
- Without a shared clock it keeps its own clock and syncs it from each world, as before.

`src/app/game/page.tsx` (same layout)
- `useGameState(reads, { fixture, previewAs })` replaces the page's owner effect, its fixture owner and world load, and its clock. Here `reads = fixture ? fixtureReads : gateway`.
- The fixture import now loads only the samples and the fixture gateway.
- `GameViewport` is mounted in both modes, with `timelines` and `tournaments` set to `reads` and `onStatus={setSceneStatus}`. `.scene-placeholder` is gone.
- `previewAs` comes from `?as=visitor`, in fixture mode only.
- Retry owner load, the panels' `refresh` and creation's `onCreated` call `refreshOwner()`.
- Copy the live camp made false is updated. "CAMP UNDER CONSTRUCTION" is now "LIVE CAMP", and "Coming soon" is "Live". The camp note no longer says "under construction". No structure changed.

`tests/browser/live-routes.ts` (new; ruling 1)
- `routeLiveReads(context, { world, profiles, standings, tournaments, timelines, recent, owner?, serverNowMs? })` routes `http://127.0.0.1:54321/**`.
  - It answers each object as PostgREST answers the readers in `reads.ts`, with rows built from fixture DTOs:
    - public: `world_revision` (single object; time and slot from the server clock), `world_actor_reads`, `public_profile_reads`, `visible_events`, `recent_results`, `arena_standings`, `arena_standing_reads`, `tournament_views`, `tournament_bout_results` (JSON-path selects), `tournament_placements`;
    - owner-only: `owner_state`, `activities`.
  - A small evaluator handles the filters (`eq`, `gt`, `lte`, `in`, `or`/`and` groups and the rest), `order`, `limit`, JSON-path `select` and the single-object `Accept` header. Reveal-time row filters apply at the server time.
  - The publishable key as bearer is a visitor, and the private objects refuse it (401 `42501`), as they refuse `anon`. A JWT reads as its `sub`.
  - Controls: `requests` (table, reader, query), `count`, `setWorld`, `setOwner`, `delay`, `hold`, `rejectSessions` (401 `PGRST301` for every signed-in request) and `serverNowMs`.
  - It answers a stored session's Auth calls: `/auth/v1/user`, `logout`, and a refused `token` refresh.
  - Commands and unknown requests fail the test. A spec's own handler, registered later, runs first and hands the rest over with `route.fallback()`.
- `seedSession(context, user = testUser())` stores `sb-127-auth-token` before every load, the `arena-live.spec.ts` approach. `testUser()` and `emptyWorld()` are small helpers.

Specs moved onto the transport
- `arena-live.spec.ts` is extracted onto `seedSession` and `routeLiveReads`. Its assertions are unchanged, plus a check that every read carried the session.
- `planning`, `inventory` and `identity` specs: the live page now syncs the public world. Each registers `routeLiveReads(context, { world: emptyWorld() })` before its own handler, and that handler's last line changes from `throw` to `route.fallback()`. Unknown requests still fail the test, now in the transport.
- `shell.spec.ts` (dev only): routes the same way, so `/game/` never reaches the real local Supabase stack.
- `expedition.spec.ts`, production test `refuses the fixture preview...`: the exported `/game/?mode=fixture` now mounts the camp. Phaser loads its art through in-page `blob:` URLs of the page origin, so the filter now allows those, as `tests/browser/remote.ts` already does. Every other check is unchanged.
- `tests/sync.test.ts` and `tests/browser/sync.spec.ts`: three counts change by design, because one timed revision sample precedes the first world load.
  - Revision reads after 90 s go from 3 to 4.
  - A hidden tab after start has 1 revision read, not 0.
  - The coalescing test waits one tick before counting the single `world()` call.

## TDD evidence

RED, unit (`npx vitest run tests/sync.test.ts tests/domain/activity-status.test.ts`), before any implementation:
- `anchors the clock offset to the revision request, not to a slow multi-page world load`: `AssertionError: expected 1950 to be less than 50`. The fake world load takes 4 s and samples its revision at the end.
- `tests/domain/activity-status.test.ts`: `Cannot find module '../../src/features/character/activity-status'`.

RED, browser (`npx playwright test --config node_modules/.cache/pw-claude.config.mjs tests/browser/live-camp.spec.ts --project desktop`): 5 failed.
- The four live tests: `TimeoutError: page.waitForFunction: Timeout 45000ms exceeded` waiting for `window.__cloudiatorCamp`. Live mode showed `.scene-placeholder`, so there was no scene.
- The fixture test: `TypeError: Cannot read properties of undefined (reading 'clock')`, because there was no `__cloudiatorShell`.

GREEN
- Unit: both files, 10 of 10.
- `live-camp.spec.ts`: 10 of 10 (desktop and mobile). The first GREEN run had one failure, in my test: `state().players` counts only gladiators in camp (2 of 13 are away). Now it compares `players` and `away`.
- `sync`, `arena-live`, `camp`, `planning`, `inventory`, `identity` and `shell` specs: 77 passed, 5 skipped (production-only).

Mutation check (ruling 2): with the `signOut({ scope: 'local' })` call commented out, the stale-session test failed (the camp never got a world). Restored, and `cmp` confirmed the file identical.

New browser tests (`live-camp.spec.ts`)
- `mounts the camp from live public reads, polling only the revision every 30 s`, signed out:
  - the scene is ready with the world, and there is no `.scene-placeholder`;
  - the shared clock is within 5 s of the server time, which is days behind the browser's wall clock here;
  - three 30 s fast-forwards add exactly one `world_revision` read each and no world load;
  - a changed revision loads the world once, and the camp shows it;
  - every read is anonymous, and only `world_revision` and `world_actor_reads` are read.
- `shows the camp when the first world arrives late`: `world_actor_reads` is held for at least 3 s. The scene becomes ready on an empty camp, then shows every actor after the release.
- `signs a rejected stored session out locally and keeps the camp running for the visitor`:
  - the seeded token is rejected by the server;
  - the camp loads and "Continue with Google" shows;
  - the stored token is gone;
  - the first revision read carried the token, and the world loads were anonymous.
- `a signed-in player sees the camp on their gladiator and re-reads the owner on a new revision, slot or focus`:
  - "Find my gladiator" shows;
  - an unchanged revision and slot reads only the revision;
  - a new revision, the next slot (server clock jumped one slot, revision unchanged) and a focus event each add exactly one owner read;
  - owner reads carry the session.
- `the fixture preview keeps its owner, and previews the visitor view with ?as=visitor`:
  - the fixture shows "Find my gladiator", and the shared clock runs from the fixture server time;
  - `?as=visitor` shows "A legend awaits" and no Find button.

## Gate results

| Gate | Result |
| --- | --- |
| `npm test` | 38 files, 939 tests passed |
| `npm run typecheck` | passed (tsc, deno check, 2 Deno tests); `tsc --noEmit` rerun after the later test edits also passed |
| `npm run test:db` | 9 files, 177 tests passed. Edge `StartedAt` before and after: `2026-10-16T15:05:57.554535233Z` both (unchanged; the run counts). Nothing else ran in the worktree |
| `node assets/source/build-assets.mjs --check` | assets up to date (28 files) |
| `npm run build`, then `npm run verify:static` | built, no warnings; "Static export verified: 5 fixed routes; 91 assets scanned; no forbidden backend material." |
| Dev browser suite (full, `pw-claude.config.mjs`, port 3200) | 274 passed, 8 skipped, 2 failed. Both failures are the pre-existing `expedition.spec.ts:622` (see Concerns), proven at base with my changes stashed. After the later test-only edits: `shell.spec.ts` and `expedition.spec.ts` rerun, 48 passed, 6 skipped, the same 2 pre-existing failures |
| Isolated production gate | `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build`, then `verify:static -- .next/browser-test` (5 routes, 91 assets), then the static Playwright run: 14 passed, 270 skipped. The first static run failed 2 (the `blob:` filter, fixed above); the whole gate was redone in order after the dev rerun |
| `git diff --check` / `git diff --cached --check` | clean |

Builds and browser runs were never overlapped.

## Files changed

- `src/app/game/page.tsx`
- `src/features/character/activity-status.ts` (new)
- `src/features/character/useGameState.ts` (new)
- `src/game/GameViewport.tsx`
- `src/lib/api/session.ts`
- `src/lib/api/sync.ts`
- `tests/sync.test.ts`
- `tests/domain/activity-status.test.ts` (new)
- `tests/browser/live-routes.ts` (new)
- `tests/browser/live-camp.spec.ts` (new)
- `tests/browser/arena-live.spec.ts`, `identity.spec.ts`, `inventory.spec.ts`, `planning.spec.ts`, `shell.spec.ts`, `sync.spec.ts`, `expedition.spec.ts`

## Concerns

1. **Pre-existing failure, not from this task:** `expedition.spec.ts:622` ("explains an unknown, malformed or live expedition without reading or drawing one").
   - Since 13.2 the live expedition page reads the timeline as a visitor.
   - The test does not route that read, so in development it reaches the real local Supabase at `127.0.0.1:54321`. The page then shows "Preparing" instead of "This expedition is not available".
   - The same assertion (line 630) fails at base `22ad713` with my changes stashed.
   - The 13.2 report ran only four browser specs, so this was not seen.
   - The test's premise ("live ... without reading") is stale. Routing it through `live-routes.ts`, and deciding what a visitor should see for an unknown live expedition, belongs to the expedition work (13.8 mounts `useGameState` there). I left it unchanged.
2. `activityStatus` follows the brief's rules literally. If a caller passes a slot index read before the boundary (the sync's `slotIndex` can be up to 30 s old), an ended, unsettled activity reads "Completed" until the next poll. The JSDoc says to pass the current slot. 13.5 should pass `max(slotIndex, floor(clock.now() / SLOT_MS))` or similar.
3. `GameViewport` still syncs a shared clock forward from Arena timeline reads (`timeline.serverNowMs`), as `ArenaPanel` does. The brief scoped the change to the world sync. With an accurate offset this is a no-op, because the sync is forward only and the sample is older than the response.
4. Creation now calls `refreshOwner()` instead of taking the owner `CreateCharacter` already read. This costs one extra owner read on creation, and keeps the brief's `GameUiState` shape (no owner setter).
5. A focus event re-reads the owner and, through the sync, the revision. If the revision also changed, the owner is read twice. Owner reads also follow each revision change, at most one per 30 s poll for a player.
6. `useGameState` has no React unit test, because the repo has no DOM test library. Its rules are covered by the browser tests above.

## Fix note: unrouted live reads (coordinator request)

Commit: `46fd8c3 test: route the live expedition and replay reads through the test transport` (new commit, no amend, not pushed). This resolves Concern 1.

**Cause.**
- Since 13.2, a visitor's live expedition page and live replay page read the public timeline (`world_revision`, `visible_events`, `recent_results`).
- `expedition.spec.ts:622` and `replay.spec.ts:163` did not route those reads, so in development they reached the real local Supabase at `127.0.0.1:54321`.
- Expedition: a timeline the server answers, even an empty one, renders "Preparing", not "This expedition is not available". So the test failed on desktop and mobile.
- Replay: the test still passed, because an empty timeline also renders "not available". It was unrouted all the same.

**Change.**
- `tests/browser/live-routes.ts` gains `fail(table)`: a 500 response, which postgrest-js does not retry.
- `expedition.spec.ts`: the test registers `routeLiveReads(context, { world: emptyWorld() })` and calls `live.fail('world_revision')`.
  - The live page cannot read the expedition and must explain it. The original "This expedition is not available", Camp link and no-canvas assertions are unchanged.
  - The original no-request assertion is unchanged, but now covers the two fixture loads (unknown and malformed), where it still holds. It also asserts that the transport saw nothing during those loads.
  - For the live load:
    - no command (`functions/v1`) and no Auth request;
    - at least one routed read;
    - every routed read anonymous and to a public timeline object;
    - every page request to 54321 is a `/rest/v1/` public timeline read.
- **Concession.** "Without reading" cannot hold for a live load after 13.2: visitors read public timelines by design. The live part now proves the read is anonymous, public-only and routed.
- The scenario changed: from no session to a failed server read. An unknown live expedition that the server answers shows "Preparing", like any unrevealed one. The comment in the test says so. If review prefers to test that realistic path, the heading expectation for the live load would change.
- `replay.spec.ts:163`: routes the live replay read with an empty transport (no such activity on the server). The original assertions are unchanged. New assertions check that the live read happened, as an anonymous public timeline read.

**Sweep** (`grep -nE "goto\(|\.url\(" tests/browser/*.spec.ts | grep -v mode=fixture`):
- Every other live page load is routed through the transport, or through a spec handler that falls back to it: `arena-live`, `identity`, `inventory`, `planning`, `shell`, `live-camp`.
- `sync.spec` loads `/`, which reads nothing.
- The remaining camp navigations are link clicks inside fixture mode: `arena.spec:559`, `replay.spec:311`, `expedition.spec:221`, `tournament.spec:116`.

**Commands and output**

| Command | Output |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx playwright test --config node_modules/.cache/pw-claude.config.mjs tests/browser/expedition.spec.ts` (both projects) | 46 passed, 2 skipped (production-only), exit 0 |
| `npx playwright test --config node_modules/.cache/pw-claude.config.mjs tests/browser/replay.spec.ts` (both projects) | 36 passed, exit 0 |
| `git diff --check`, `git diff --cached --check` | clean |

No build ran during these browser runs. Only test files changed, and the production gate's expedition test is untouched by this commit, so the production gate was not re-run.
