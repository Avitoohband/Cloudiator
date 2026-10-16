# Task 13.2 report: public reads without a session

Worktree `C:\Avi\Studies\Projects\Cloudiator-claude`, branch `claude/task-13`, base `abb5376`.
Commit: `f8d6fc3 feat: read public projections without signing in` (not pushed).

## What was implemented

`src/lib/api/gateway.ts`
- New `publicRead(load)` beside `read`. `load(client, account)` receives the reader's account id (null for a visitor).
  - It works with no session.
  - It samples `getSession()` before and after the load. If the account or the `epoch` changed, the result is dropped and the read runs once more as the new identity. A second change throws `GatewayReadError('unavailable')`.
  - A `getSession` error reads as a visitor: supabase-js then sends the publishable key, so the server sees `anon`, and no owner summary is asked for.
- `world`, `revision`, `timeline`, `profile`, `standings`, `tournament`, `tournamentLog` and `recent` use `publicRead`. `owner()` still uses `read` (rejects `unauthenticated`). `command()` is unchanged: it already returned `unauthenticated` without a session, and the new test confirmed that without a code change.
- `timeline` passes `ownerSummary: account !== null`, decided per attempt, so a visitor who signs in mid-read is retried as that account.
- The tournament log cache: a cached hit is returned with no session check and is shared by all viewers; `subscribeSession` still clears it on an account change. This closes Task 19 R1.
- `GameGateway` method signatures are unchanged.

`src/lib/api/reads.ts`
- `readTimeline(client, id, options: { ownerSummary: boolean } = { ownerSummary: true })`. With `false` it never queries `activities` and the result has no `summary`.

`src/lib/api/fixture-gateway.ts` and `tests/fixtures/results.ts` (new)
- `recent(cursor?)` serves `RESULTS_FIXTURE: ResultsPage[]`. No cursor gives page 0. A cursor equal to a page's `nextCursor` gives the next page. An unknown cursor gives `{ rows: [], nextCursor: null }`. Pages are structured clones.
- `resultPages(rows, size = 50)` builds the pages with the live cursor format `settledAtMs:activityId` (a full page names its last row, so an exact multiple ends with an empty page). The fixture data fits on one page.
- Rows, newest first then by activity id (the live order), come from:
  - the Arena fixtures, the replay fixtures, the expedition fixtures and the owner's two tournament timelines, each attributed to its fixture gladiator;
  - two synthesized plain completions, Varro's Training and Cassia's Rest, because the fixtures hold no Training or Rest timeline.
- Rows carry only the six public completion fields. The timeline's own `completion` is used when present (only the two tournament timelines have one); otherwise the six public fields are picked from the settled `summary`. Rewards, receipt and rating change are never copied. The `tie` replay (rewards not credited) has no row.

## TDD evidence

RED, unit tests (`npx vitest run tests/api/projection-gateway.test.ts`), before the gateway change: 6 failed, 10 passed.
- Failing: `reads every public projection without a session`, `a visitor timeline never queries activities and has no summary`, `retries a public read once when the account changes during it`, `throws unavailable when the account changes again during the retry`, `decides the owner summary again on the retry when a visitor signs in during a timeline read`, `serves a cached tournament log to a later viewer without a session check, and forgets it when the account changes`.
- Reason, at `src/lib/api/gateway.ts:43` in `read`: `Error: unauthenticated`, and for the second-change test `expected ... { code: 'unauthenticated' } to match object { code: 'unavailable' }`.
- Already green, as the brief predicted, and kept as guards: `refuses owner() and commands without a session` and `a signed-in reader still gets the owner summary with the timeline`.

RED, fixture tests: first `Cannot find module '/tests/fixtures/results'`. After the fixture module existed and before the gateway change: `Error: This read is unavailable in the fixture preview.` (2 failed, 12 passed).

RED, database (`npm run test:db -- tests/db/visitor-access.test.ts` with `reads.ts` temporarily at the old `HEAD` version, then restored): 1 failed, 4 passed.
- The new test passed the world, profile, standings and tournament parity checks, then failed at the visitor timeline: `Error: unauthenticated` from `checked` at `reads.ts:15`, called from `readTimeline` at `reads.ts:64`. That is the `activities` query as `anon`. Edge start time was unchanged (`2026-10-16T14:31:59.993389175Z`).

GREEN: after the implementation, `npx vitest run tests/api/` passed 31 of 31, and the new DB test passed in the full DB run below.

## Gate results

| Gate | Result |
| --- | --- |
| `npm test` | 37 files, 932 tests passed (run twice, the second after a typing fix in the test) |
| `npm run typecheck` | passed (tsc, deno check, 2 Deno tests). It first failed on a mock return type in my new test (`getSession` mock); fixed |
| `npm run test:db` | 9 files, 177 tests passed, 152 s. Edge `StartedAt` before and after: `2026-10-16T14:31:59.993389175Z` both (unchanged, so the run counts) |
| `npm run build`, then `npm run verify:static` | build compiled; "Static export verified: 5 fixed routes; 90 assets scanned; no forbidden backend material." |
| Playwright (`pw-claude.config.mjs`, port 3200: arena-live, identity, planning, inventory) | 36 passed (desktop and mobile), 27.0 s; run after the build had finished. The two `AuthApiError: Refresh denied` lines are the expected output of the expiry spec |
| `git diff --check` | clean |

Nothing else built, browsed or edited in the worktree during the DB runs.

## Files changed

- `src/lib/api/gateway.ts`
- `src/lib/api/reads.ts`
- `src/lib/api/fixture-gateway.ts`
- `tests/fixtures/results.ts` (new)
- `tests/api/projection-gateway.test.ts` (+8 tests)
- `tests/api/fixture-gateway.test.ts` (2 new tests; the `recent` line removed from the "unimplemented fixture reads" test)
- `tests/db/visitor-access.test.ts` (+1 case)

The DB case covers the carried 13.1 item: `readProfile(anonymous, id)` equals the signed-in spectator's profile. It also compares world, standings, tournament, timeline and recent results, and shows that `readTimeline(anonymous, id, { ownerSummary: true })` is refused with `unauthenticated`. The world and timeline comparisons exclude `serverNowMs` and `visibleThroughMs`, because the `world_revision` view reads `statement_timestamp()` and differs on every read.

## Concerns

1. **`readTimeline` default option.** The brief writes `options: { ownerSummary: boolean }`. I gave it a default of `{ ownerSummary: true }`. Otherwise 17 existing signed-in DB-test calls in `arena.test.ts`, `projections.test.ts` and `tournaments.test.ts` would need an edit. The gateway always passes it explicitly. A missing option fails closed: a visitor client gets `unauthenticated`, not a leak. Making it required is a mechanical change if you prefer.
2. **`completion` source for the fixture rows.** Only the tournament owner timelines carry `completion`; the other fixture timelines have only the owner `summary`. The six public fields are picked by name from it, the same fields the projection stores. Training and Rest rows are synthesized.
3. **A `getSession` error reads as a visitor.** I chose this over throwing, so a visitor with a stale stored session (whose first refresh fails once) still sees public data. The reader never gets more than public data this way. The cost is that a signed-in user hit by a transient `getSession` error gets one timeline without the owner summary, and the next read or sign-in event fixes it. Say if you want `unavailable` instead.
4. **Fixture results import path.** `tests/fixtures/results.ts` imports the JSON-backed timeline modules, so Playwright specs (whose loader cannot import JSON) must not import it. It is noted in the file header.
5. **Not changed here.** Callers that map `unauthenticated` on `world()`/`revision()` to a sign-in prompt (for example the sync layer) will now see visitors read the camp. That belongs to the later UI checkpoints; the existing browser specs still pass.
6. **CRLF.** Most working-tree files are CRLF with LF in the index; the new `results.ts` is LF in the working tree. Git warns once; this has no effect on the commit.

---

# Fix round 1 (commit `6fed6b0`, on top of `f8d6fc3`)

Review marked the spec as failing on two deviations. Both are fixed in a new commit (not amended, not pushed).

## Finding 1: `readTimeline` option is now required

- `src/lib/api/reads.ts`: `readTimeline(client, id, options: { ownerSummary: boolean })` has no default any more. Concern 1 of the first report is withdrawn.
- RED: with the default removed, `npx tsc --noEmit` listed the 20 call sites that did not pass it: `arena.test.ts` (6), `projections.test.ts` (8), `tournaments.test.ts` (5), `reads.test.ts` (1). `gateway.ts` already passed it explicitly.
- Every signed-in call now passes `{ ownerSummary: true }`. The clients are all `owner.client`, `other.client`, `me.client`, `spectator.client` and `winner.client` (signed in).
- The fail-closed DB assertion at `tests/db/visitor-access.test.ts:165` is untouched: `readTimeline(anonymous, id, { ownerSummary: true })` is still refused with `unauthenticated`.
- New unit test in `tests/reads.test.ts`: `readTimeline(..., { ownerSummary: false })` makes no `/activities` request and returns the public completion. The existing signed-in test now also asserts `/activities` is requested.

## Finding 2: fixture `recent` follows `readRecent`'s cursor rules

- `reads.ts` has a new exported `parseResultsCursor(cursor?: string | null)`, now used by `readRecent`: no cursor (absent, null or empty) returns null; anything else must match `revealAtMs:uuid` with a safe-integer time, or it throws `GatewayReadError('unavailable')`. A non-string truthy value counts as malformed (`typeof` guard before the regexp). `readRecent`'s behavior is unchanged, including the query it builds.
- `fixture-gateway.ts` `recent(cursor)` calls it, so the check is one shared piece of code and cannot drift:
  - absent, null or `''`: the first page;
  - malformed (including a non-string): rejects with `GatewayReadError('unavailable')`;
  - well-formed but issued by no page: `{ rows: [], nextCursor: null }`;
  - a cursor issued by a page: the next page.
- RED: the rewritten test `fixture recent results follow the live cursor rules, and callers get copies` failed with `promise resolved "{ rows: [], nextCursor: null }" instead of rejecting` (a malformed cursor returned an empty page).
- The test now pins all four cases, with eight malformed values (not a cursor, `bad,filter`, no uuid, bad uuid, extra segment, 17 digits, 16 digits above the safe integer, a number), the `GatewayReadError` type, and `undefined`/`null`/`''`. It keeps the pager and copy checks.
- `tests/reads.test.ts`: `readRecent(client, '')` returns the first page with no cursor filter.

## Gates

| Gate | Result |
| --- | --- |
| `npx vitest run tests/api/fixture-gateway.test.ts tests/api/projection-gateway.test.ts tests/reads.test.ts` | 3 files, 39 tests passed |
| `npm test` | 37 files, 933 tests passed |
| `npm run typecheck` | passed (tsc, deno check, 2 Deno tests) |
| `npm run test:db` | 9 files, 177 tests passed, 150 s. Edge `StartedAt` before and after: `2026-10-16T14:56:40.010495Z` both, so the run counts |
| `npm run build`, `npm run verify:static` | passed ("5 fixed routes; 90 assets scanned; no forbidden backend material") |
| `git diff --check` | clean |

Note: the Edge container's `StartedAt` was `2026-10-16T14:31:59.993389175Z` in my first round and `2026-10-16T14:56:40.010495Z` at the start of this one, so it was recreated between the two rounds, while I was not running anything. It was stable throughout this round's DB run. I did not run Playwright again: the first-round specs use the live gateway, and this round changed only a read function's required argument in test files and the fixture gateway's `recent`.
