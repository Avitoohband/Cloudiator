# Task 23.9 report: the owner's presence and the resting gladiator screens (Lane B, UI only)

## Status

**DONE** (Lane B gates below). No database, SQL or Edge change: the work consumes Task 23.8's contract commit `f1cf073` as it is.

Commits (branch `claude/task-23-ui2`, Cloudiator-replay, on `f1cf073`):
- `6072d3e` feat: send presence and show resting gladiators
- this report: docs: report Task 23.9

Brief: `.superpowers/sdd/2026-10-19-task-23-release-readiness/task-23.9-brief.md` (Lane A worktree). Design:
`docs/superpowers/specs/2026-10-19-database-budget-design.md`, section C, "In the camp" and "Waking up".

## What changed

**The presence (`src/lib/api/presence.ts`, new).** `createPresence({ send, reread })` decides who sends it and when:
- only a player (a signed-in account whose gladiator is shown), never a visitor or an account without a gladiator;
- once as soon as the gladiator is shown (after sign-in or a page load), then every 6 hours (`PRESENCE_INTERVAL_MS`) while
  the page is visible; a presence that falls due while the page is hidden is sent when it is next visible (a page loaded in
  the background sends its first one then);
- another account starts afresh; later owner reads of the same account send nothing;
- a refusal or a failure is not shown and not retried early (the next presence is the next one due);
- an answered presence reads the owner again only while the gladiator rests with no signal yet (no current activity and
  `restingUntilSlot` null), the one case where the presence changes the owner state; nothing is read or sent after `stop`
  or an account change.

**The gateway (`src/lib/api/gateway.ts`).**
- `GameGateway.sendPresence(): Promise<PresenceResult>` (`:20–24`, implemented at `:173`): posts `{ kind: 'presence', operationId }` with a new
  `crypto.randomUUID()` each time, takes `{ ok: true }` with no receipt id, keeps a typed refusal (and its `retryAfterMs`),
  maps anything else to `unavailable`, and never throws.
- `command()` and `sendPresence()` share one transport (`post`, `:105–122`) and one refusal check (`isRefusal`, `:64–68`);
  `command()` keeps its allow-list and still requires a receipt, so a presence sent through it is refused locally.

**Wiring (`src/features/character/useGameState.ts:229–247`).** One presence per gateway (the fixture one once loaded),
told each change of account or owner read. On a `/replay/` deep link (`clockOnly`), which reads the owner once per
account, a presence is sent but never followed by an owner read.

**The owner's line (`src/features/character/activity-status.ts:21–31`).** `Resting at home: back on your schedule at {time}`
while the current slot (the later of the revision's and the display clock's) is before `restingUntilSlot`; {time} is that
slot's start through `slotTimeText` (`src/features/schedule/slot-time.ts`, new), the Schedule panel's own formatting
(`new Date(ms).toLocaleString()`), which the Schedule panel now uses too. From the boundary the line falls back to the
existing states ("Preparing your next activity" until the owner is read again).

**The public copy (`src/features/character/actor-text.ts:16–23`).** `restingText(name)` is
`Resting at home: back when {name}'s owner returns.`; `placeOf` returns it for a resting actor, so the profile card's "Now"
shows it. The Gladiators list (`RosterPanel.tsx:65–77`) shows the class line, then that sentence once, as the reason for its
disabled Find and Follow (a resting gladiator is never drawn, even if a stale roster still lists it).

**The camp (`src/game/actors.ts:185–190`; a comment in `camp-scene.ts` applyWorld).** `layoutCamp` drops resting actors before placing: neither placed nor away,
so the scene never draws one, removes one that starts resting, and draws it again when it wakes.

**Fixture preview.**
- `tests/fixtures/resting.ts` (new): Otho (`RESTING_ACTOR`, a public profile with no standings row) and `RESTING_OWNER`.
- `src/lib/api/fixture-gateway.ts`: Otho rests in the preview's world; presence is answered `{ ok: true }`;
  `createFixtureGateway({ resting: true })`, the game page's `?mode=fixture&as=resting`, makes the owner's own gladiator
  rest in the current slot, with `restingUntilSlot` null until its presence is answered, then the next slot (as the server).
- `src/app/game/page.tsx` and `CampShell.tsx`: the `?as=resting` option.

## Tests

Watched failing first (missing module or method, then wrong behaviour) before the code:
- `tests/api/presence.test.ts` (new, fake timers): presence timing, visitors and accounts without a gladiator send nothing,
  hidden pages, background loads, swallowed failures, the re-read rule, stop and account change.
- `tests/api/live-gateway.test.ts`: a fresh operation id per presence, the answer without a receipt, refusals, failures.
- `tests/domain/activity-status.test.ts` and `tests/domain/character-panel.test.ts` (new): the owner's line until that
  boundary.
- `tests/domain/profile-card.test.ts`, `tests/domain/roster-panel.test.ts`: the public copy.
- `tests/domain/scene-layout.test.ts`: a resting gladiator is not drawn; one that starts resting leaves, and one that wakes returns.
- `tests/api/fixture-gateway.test.ts`: presence, Otho, and the resting preview.
- `tests/browser/resting.spec.ts` (new; desktop and mobile): the three resting states in the fixture preview with contrast,
  focus and accessible-description checks and 360 x 740 screenshots; a drawn gladiator that starts resting and wakes; live
  mode: one presence on load and one 6 hours later with a new operation id, none for a visitor, and a resting owner read
  once more after its presence; the export refuses `?as=resting`.

Counts that legitimately changed:
- the fixture world has 15 actors, not 14 (`fixture-gateway.test.ts`);
- the fixture camp draws 43 players, not 44 (`camp.spec.ts`, twice): the world still has 50 rows, and Otho is one of them.

Live-mode test transport: `routeLiveReads` answers a signed-in player's presence (`{ ok: true }`, recorded in
`presences`); the spec handlers for commands (identity, inventory, planning, market twice, release, management) hand a
presence back with `isPresence`, so their command lists hold only what they test.

## Gates (Lane B, no database)

Run in the documented order (`docs/operations/verification-gates.md`), one after another in this worktree:

| Step | Result |
|---|---|
| `npm test` | 1,230 passed, 3 failed: `tests/workflow.test.ts` only, failing identically at `f1cf073` before this work (see Notes) |
| `npm run typecheck` | passed (tsc, deno check, 2 Edge deno tests) |
| `node assets/source/build-assets.mjs --check` | assets up to date (28 files) |
| `npm run build`, `npm run verify:static` | passed: 5 fixed routes, `connect-src 'self'`, no fixture preview data |
| Dev browser suite (private config, port 3300) | 539 passed, 35 skipped, 0 failed (11.1 min) |
| `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build`, `verify:static -- .next/browser-test` | passed (no test publishable key in the environment) |
| Production gate (`PLAYWRIGHT_STATIC=true`, port 4173) | 34 passed, 540 skipped, 0 failed; no CSP violation |
| `git diff --check` | clean |

After the dev browser run, one doc comment in `gateway.ts` was moved back above `publicRead` (comment only; `npm test` and
`npm run typecheck` were rerun with the same results, and both builds and the production gate ran after it).

## Screenshots for Avi (360 x 740)

Copies in the session scratchpad, `task-23.9-shots/` (`resting-<project>-<state>-360.png`, desktop and mobile projects):
- `resting-*-owner-line-360.png`: My gladiator, "Resting at home: back on your schedule at 10/10/2026, 4:20:00 AM" (the
  fixture boundary in the test browser's locale and zone);
- `resting-*-profile-card-360.png`: Otho's profile card, "Now: Resting at home: back when Otho's owner returns.";
- `resting-*-gladiators-row-360.png`: Otho's row in the Gladiators list, with disabled Find and Follow.

To see them live: `/game/?mode=fixture` (Otho) and `/game/?mode=fixture&as=resting` (the owner).

## Notes and concerns

- **Contracts.** Used as committed in `f1cf073`; no issue found. `PresenceResult` has no receipt, so a presence goes through
  `sendPresence()` (the brief's `sendPresence(): Promise<void>` returns the result instead, so the caller can read the owner
  again after `{ ok: true }`); `command()` keeps requiring a receipt.
- **Owner read after a presence (a narrowing, for review).** The owner is read again only when the answered presence can
  change it: the gladiator has no current activity and `restingUntilSlot` is null (resting with no signal yet). An active
  gladiator's presence costs no owner read, so the existing owner-read counts in the browser suites are unchanged; a
  resting one is read once (tested in units and in live mode). Say if every answered presence should read the owner.
- **Who sends it.** A player only: an account signed in without a gladiator sends none (its creation command is itself a
  signal). A page that is hidden when a presence falls due sends it on its next visible moment.
- **The owner's own card and row** show the public sentence ("back when Aster's owner returns.") while it rests, as the
  copy says for everyone; only My gladiator has the owner's line. Visible in the `?as=resting` preview if Avi wants another
  wording there.
- **Before the first presence is answered** a resting owner's line reads "Preparing your next activity" (no
  `restingUntilSlot` yet); the presence follows at once.
- **Pre-existing failure, not this task's.** `tests/workflow.test.ts` (3 tests) fails in this worktree because
  `core.autocrlf=true` checks out `.github/workflows/checks.yml` with CRLF line ends and its patterns expect LF. It failed the
  same way at `f1cf073` before any change here.
- **Lane A integration.** `routeLiveReads` now answers presence for live specs; the Edge function (23.8) must accept
  `{ kind: 'presence', operationId }` with no other field, which is all the client sends.
