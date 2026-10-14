# Task 10 — safe projections and revision polling

Status: **DONE_WITH_CONCERNS**. The local read models, authorization, adapters,
polling controller and migration are implemented and verified. The remaining
concerns are the explicitly deferred UI integration, combat-strength producer,
and hosted release proof below. Independent review and push belong to Codex's
controller.

## Provenance and scope

- Date: 2026-10-14, Asia/Jerusalem; repository `C:/Avi/Studies/Projects/Cloudiator`,
  branch `codex/gladiator-arena`.
- Full review BASE: `62f24ccfc62ce73615819dfad341be20d948ed82`.
- Controller's intervening approved runtime-documentation checkpoint:
  `701fe10bfbf2257b0242d7064c8dec43348fc389`. It changed AGENTS.md and the new local
  runtime guide, not Task 10 product source; it does not replace the review BASE.
- Source: **`36fd2b476988e48d67cf060a59879198dfcc73dd`**,
  `feat: expose safe synchronized world projections`.
- New CLI-generated M07:
  **`supabase/migrations/20261014045856_projections.sql`**.
  M01–M06 were not edited. M07 is immutable after this source commit.
- This tracked report is a separate documentation commit. Its SHA is returned
  to the controller and recorded in the ignored scratch report after commit.

No helpers/reviewers were spawned; no push, merge, stash, reset of Git, branch
switch, hosted project action, or Claude checkout edit was performed. The root
fixture gateway, game/expedition/replay pages, scanner/static tests, scene files,
ExpeditionView, Claude tests/reports, and HANDOFF were left untouched. Task 15's
READY checkpoint has not been integrated into this source. On resumption the
controller assigned Tasks 16/19 to Claude after reviewed Task 10; that future
backend work is not part of this checkpoint.

## Authoritative projection and privacy

`supabase/sql/06-projections.sql` is the reapplicable source. It adds:

- `world_actors`: explicit public identity, current class/league/level, equipped
  machine silhouettes and published activity metadata. It never spreads an
  owner aggregate or a private simulation snapshot. Only current equipment IDs
  join item instances; unequipped gear and owned cosmetics remain private.
- `public_profiles`: rating, nullable combat strength, and prestige storage.
  Combat strength remains null because Task 16 owns its canonical producer.
  Historical gear strength is not relabeled as a combat or league formula.
- `recent_results`: explicit safe completion identity/kind/result/success/time
  and replay-expiry metadata. No rewards, receipt IDs, inventory, wallet,
  owner identity, or private grant/overflow details enter these rows.
- `world_revision_state`: a singleton monotonic revision counter.
- Invoker views `visible_events`, `world_revision`, `world_actor_reads`, and
  `public_profile_reads`. All underlying tables have RLS and explicit grants;
  authenticated clients can read the safe projections, anonymous clients
  cannot, and direct client mutation is denied.

`visible_events` reads Task 9's sanitized authoritative `activity_stages`,
retains the existing database-clock RLS and adds an explicit due predicate.
Guessed IDs do not bypass it, including for the owner. The world/profile view
selects only the latest due stage and removes `battleLog`; full logs are read
only when timeline is requested. Tests assert this payload distinction.

Deferred constraint triggers on gladiators, builds, item instances, activities,
and stages run the explicit projector against complete transaction state.
Projection-row changes and stage writes invalidate the revision in that same
transaction. The existing `private.boundary_published(bigint)` hook also bumps
the counter after the authoritative boundary phases. Read revision includes the
current database slot and latest due-event timestamp, so slot/visibility
transitions also change the read token. Private simulation completion alone
does not publish its plan or outcome.

Published activities exclude `preparing` rows and require an authoritative
publication timestamp. An overdue active activity remains processing until
settlement commits; no elapsed client countdown creates completion or rewards.
Training/Rest retain their resolved kind and readable completed result. Their
stored expired-replay marker is not used to classify them as expired combat.
Management consumers still use OwnerState.currentActivity together with
processedSlotIndex; this task does not rewrite that owner producer.

The public repair RPC `refresh_projections()` and all private writer/trigger
functions are SECURITY INVOKER, have an empty search_path, and grant execution
only to the backend role. The RPC accepts no caller DTO or private snapshot.
`backend/projections.ts` exports `refreshProjections(client): Promise<void>` for
trusted repair/backfill; normal publication is transactional SQL, not a worker
follow-up HTTP write. Idempotent repair does not change an unchanged revision.

## Approved contracts and query interfaces

The controller approved and notified Claude before the shared contract edits:

- `PublicActivitySummary` is exactly a Pick of ActivitySummary's `activityId`,
  `resolvedKind`, `result`, `success`, `settledAtMs`, and `replayExpiry`.
- `RevealedTimeline.completion?: PublicActivitySummary` is additive and safe
  for spectators. Existing `summary?: ActivitySummary` remains full owner-only
  data, obtained by a separate RLS-protected activities query.
- `ResultRow.summary` is narrowed to PublicActivitySummary. Owner reward
  details are loaded through the owner-authorized timeline on demand.
- `PublicProfile.combatStrength` is `number | null` pending Task 16.
- `GameGateway.subscribeSession?(listener): () => void` is optional; existing
  fixture implementations remain compatible and were not edited.
- On resumption, the controller separately authorized the mechanical signature
  `standings(league: LeagueId, cursor?: string): Promise<StandingsPage>` for
  Claude's later pagination consumer. The implementation remains unavailable.
  Tournament placement privacy reconciliation belongs to Task 19.

`src/lib/api/reads.ts` exposes `readOwner`, `readWorld`, `readRevision`,
`readTimeline`, `readProfile`, and `readRecent`, each accepting the browser's
SupabaseClient. Reads use protected Data API tables/views, not an Edge invocation
per poll. The existing GatewayReadError import remains available through a
re-export from gateway.ts.

World queries use ordered gladiator-ID cursor batches of at most 50, with
revision reads before/after assembly and up to three attempts if a concurrent
commit changed the revision. Timeline reads use ordinal cursor batches of at
most 50, restricted both by database RLS and the response's sampled server time.
Owner summaries are also bounded by that sampled settlement time. Recent
results use descending settlement time, then ascending activity ID, with a
strictly validated `time:UUID` cursor; equal-time results are neither skipped
nor duplicated. Each recent page contains at most 50 rows. Profiles, owner
management, timelines and logs are loaded on demand.

The live gateway checks the captured account again after every read, including
not-found/error results. An old account's no-character response cannot become
creation authority for a new account. Session subscriptions invalidate caches
only when account identity changes, not on same-account SIGNED_IN focus events
or TOKEN_REFRESHED notifications. Expired/denied Data API requests surface as
unauthenticated; server authorization, rather than a possibly skewed browser
clock comparison, decides read expiry. Existing command guards are unchanged.
Market, standings and tournament still fail explicitly as unavailable.

## Synchronization contract

`createSync(gateway, listener): SyncController` exposes asynchronous `start()`
and `refresh()`, plus `stop()`. `SyncState` has `world`, `offsetMs`, `lastSyncMs`,
`processing`, `refreshing`, and `error`. It contains no eagerly loaded owner
management or replay payload.

Entry loads world data. Subsequent visible polls request only revision/time
every 30 seconds; a different revision causes one world refresh. The offset uses
the server timestamp relative to the request's local midpoint. Tests cover
constant browser skew in both directions by 24 hours. Hidden tabs stop polling;
focus/visibility recovery refreshes. Overlapping calls coalesce. Generation
guards discard stopped/account-stale completions, and stop unsubscribes the
browser/auth listeners. Account changes and a fresh start clear cached state.

Outages preserve the last valid world, offset and sync timestamp while exposing
an unavailable error. Authentication loss clears them. `processing` reflects
authoritative queued/processing actors; `refreshing` tracks network work, so a
successful poll cannot imply that delayed backend work has completed.

## RED/GREEN and verification evidence

These are distinct runs, not an invented combined final count:

| Check | Observed evidence |
| --- | --- |
| Initial sync RED | `npm test -- tests/sync.test.ts`: missing sync module, as permitted by the task's initial RED step; then 3/3 green. |
| Initial adapter RED | `npm test -- tests/reads.test.ts`: missing read module; then 3/3 green through real Supabase query construction and controlled HTTP transport. |
| Initial database RED | After the intended local stack was available, `npm run test:db -- tests/db/projections.test.ts`: three failures at unavailable revision/projection reads; after SQL source application, 3/3 green. The earlier unavailable Docker/backend discovery attempt is not counted as RED. |
| Recent ordering RED | Expanded real DB test expected newest settlement time 2000 but received 1000. Composite cursor/order fix made it pass; 52 rows are recovered across 50+2 pages including equal-time rows. |
| Delayed processing RED | Sync test expected processing true but got false after a successful network response. Separating refreshing from authoritative processing fixed it. |
| Same-account refresh RED | New gateway test observed two invalidations from focus/token refresh where none was expected. Account-identity comparison fixed it. |
| Stale absence RED | A delayed old-account null owner response returned not-found instead of unauthenticated. Rechecking identity on failed/absent results fixed it. |
| Source-state DB | All six owning/affected DB/Auth/RLS/Edge files passed: **107/107**, about 40 seconds. |
| Migration-only DB | After clean M01–M07 replay, the same six files passed **107/107**, about 42 seconds. |
| Expanded final DB | Final projections file passed **5/5**, adding compact-log assertions, idempotent repair and exact boundary-predicate cases. No later SQL change occurred. |
| Unit suite | A 373/373 run passed before adding gateway regressions. A later full `npm test` passed **376/376 in 19 files**, before the final extra stale-null case/fix. That last source change then passed **11/11 focused** tests. No claim is made that a 377-test full run occurred. |
| Resume-focused verification | After the optional standings cursor type edit: `npx tsc --noEmit` and the four gateway/read/sync files passed **12/12**. The additional case is the existing unavailable-gateway test. No whole-suite or DB replay was repeated for this type-only edit. |
| Browser | Scoped sync desktop/mobile initially 2/2; affected identity+sync **22/22**. Final serialized run, recovered after the session pause, also **22/22 in 18.1 seconds**. |
| Compile/runtime | `npm run typecheck` passed TypeScript, both actual frozen Deno Edge entrypoints and two Deno runtime tests. Separate frozen Deno check of the new backend/projections.ts passed. |
| Static artifact | Fresh `npm run build` passed; exported app routes were `/`, `/auth/callback`, `/game`, `/replay` plus Next's not-found route. `npm run verify:static` passed **4 fixed routes, 81 assets**. The held scanner was not changed; no fifth expedition route is claimed. The later standings edit is type-only. |
| SQL | Final lint returned no schema errors; `db advisors --local --type all --level warn --fail-on warn` returned no issues. The earlier unused target-parameter lint warning was corrected before generating M07. |

The real DB run command was `npm run test:db -- tests/db/projections.test.ts
tests/db/activities.test.ts tests/db/expeditions.test.ts tests/db/identity.test.ts
tests/db/build-schedule.test.ts tests/db/shops.test.ts`. These suites exercise
real local PostgreSQL, Auth, RLS, PostgREST and Edge worker/command HTTP.

The exact ±1ms test is a **local operator predicate-clock harness**, not a claim
of millisecond-precision wall-clock scheduling. It reads the deployed RLS
predicate, replaces only its clock call with 999/1000/1001ms inside a transaction,
executes real authenticated-role reads for owner and spectator against a 1000ms
event, and rolls back the temporary policy after each case. It verifies the
original predicate is restored. Separate HTTP cases use the unchanged real
database clock and prove guessed future IDs are hidden. No player-accessible
clock control exists. The final schema parity check remained exact afterward.

## Migration-only proof

CLI 2.120.0 and current help for pull/reset/list/lint/advisors were inspected.
The database container's `com.supabase.cli.project` label was verified as
Cloudiator before source iteration. `db pull projections --local --schema
public,private --yes` produced the actual M07 path above.

The generated draft placed triggers before new private functions and omitted
explicit ACL restoration, invoker-view options and initialization/backfill DML.
Those were completed in the uncommitted draft from the tested source. It contains
four new functions and the changed boundary hook; it does not re-emit unrelated
unchanged functions. `db reset --local --no-seed --yes` then replayed migrations
alone. No source file was applied after reset.

The ignored parity harness compared **302 entries** including function body/
definition hashes, search_path, invoker/definer status, ACLs, RLS/view options,
policies, triggers and constraints, and checked singleton initialization.
Source/replay entries matched exactly before and after the later local boundary
test. Harness artifacts are `task10-schema-check.mjs`,
`task10-source-parity.json`, and `task10-replay-parity.json` under the scratch
directory; they reuse the prior task's schema-query definition. The committed
SQL, tests and report are sufficient to reconstruct the proof in a fresh clone.

## Environment failures and corrections

Docker was initially absent even outside the sandbox. The controller diagnosed
and repaired the documented local AF_UNIX socket startup problem; its approved
durable guidance is in local-runtime.md and commit 701fe10. That runtime repair
is not product test evidence. The implementer subsequently verified Cloudiator
container identity and served Edge functions using the existing ignored local
env file, without printing credentials.

Windows sandbox worker-cache ENOENT failures affected the broad unit command
and one focused gateway run. Native escalation resolved those environment
failures. A browser harness initially emitted CommonJS `exports` into a classic
script; choosing ESNext transpilation repaired the harness. Test-only Supabase
generic inference errors were fixed before the final passing compiler/build.

One later verification run incorrectly started a production build concurrently
with the development browser suite. Since `.next/browser-test` is nested under
the production `.next` directory, the build removed the active browser cache.
That run had 10 passes and 12 failures with missing manifests, connection errors
and timeouts. The failing identity cases were: draft/canceled-OAuth recovery
(desktop/mobile), lost-response retry/reload (desktop/mobile), conflict retry
(desktop/mobile), two-tab sign-out (desktop/mobile), owner-read/callback errors
(desktop/mobile), account-change creation protection (desktop), and slow
no-character focus protection (mobile). Sequential execution of the same 22
tests subsequently passed. No product workaround was introduced for that
verification mistake; future build and dev-test runs must be serialized.

A usage-limit interruption prevented one additional command's automatic approval
review from completing. It was not executed or bypassed. After Avi authorized
resumption, the same saved work and completed browser session were recovered;
implementation and passed database verification were not restarted.

## End state and remaining gates

The final sanitized runtime inventory showed the Cloudiator database, REST,
Auth, Kong and Edge containers running. The Edge serving log is the ignored
`.task-10-edge.log`; no tokens/status keys are recorded here. At the final listener
check there were no listeners on 3000, 3100, 3200 or 4173. No unrelated container
was stopped or inspected beyond its name in Docker's inventory. Browser test
servers were owned by Playwright on 3100 and ended after their runs.

Root-held and Claude-held source files remain untouched. Independent review,
HANDOFF update, push and serialized Task 15 integration remain with the
controller. Task 13 must mount/use this controller and shared offset in the
management/camp UI; the scoped browser harness exercises the real controller
without modifying held scenes or routes. Task 16 supplies combat strength and
league reads, Task 18 marketplace reads, and Task 19 tournament reads/privacy.
Retention operations, hosted Google/provider/CORS validation, real scheduled
deployment, load/egress/invocation budgets and mobile performance release gates
remain their owning later tasks. No hosted or paid fallback was used.

Source files changed: the two read/event contracts, live gateway, new reads/sync,
new backend projection repair adapter, SQL source and M07, migration guide,
and five new owning test files (projection gateway, read adapters, sync units,
projection DB, and sync browser). Self-review fixed recent ordering, delayed
processing, same-account cache invalidation and stale no-character handling;
no known failing Task 10 check remains.

## Review correction round 1 — delayed next-slot preparation

The full review subsequently found an Important gap in the original delayed
processing coverage: after the previous slot settled, phase 4 could wait for
next-slot preparation while the projector continued to show the old completed
activity. The existing overdue-active regression did not exercise this state.
This section supersedes the earlier self-review conclusion for that scenario.

- Scoped FIX_BASE: `7f413e50e1f121db99fbdcbb97e71d7f8040fc74`.
- Corrective source commit: **`a6993848bba55d47cb5bba76f9af7c7e769bce62`**,
  `fix: retain processing during delayed slot preparation`.
- New generated M08:
  **`supabase/migrations/20261014100253_projection_preparation_status.sql`**.
- Full review BASE remains `62f24ccfc62ce73615819dfad341be20d948ed82`.
  The controller owns fresh scoped review and push; this report is committed
  separately from the corrective source.

### Authoritative state and privacy

`world_actors.processed_slot_index` stores the character's published-slot
checkpoint alongside the safe actor. The projector updates both together;
it still selects only published activities. The invoker read view compares
that checkpoint with the slot computed from database statement time. If the
old activity is completed and the current slot has not published, it returns
`location: 'camp'`, `activityStatus: 'processing'`, and null `activityId`,
`startsAtMs`, `endsAtMs`, and `visibleStage`. No next destination, choice,
preparation input, snapshot, job or private outcome enters that response.
The completed prior activity remains separately readable through the existing
authorized timeline and recent-result paths. Publication advances the
checkpoint and exposes the new activity in the same transaction.

There is no DTO, gateway, read-adapter, sync, renderer or polling-budget change.
The existing sync controller derives `processing: true` from the corrected
authoritative actor. World and profile share this view; the database-time slot
component of the existing revision makes a new boundary observable even before
another mutation. Completed results inside their already-published slot retain
their normal completion state. Orientation and overdue-active behavior remain
covered by the existing tests.

### Meaningful RED and GREEN

The new DB regression uses real Auth accounts, boundary RPCs, canonical
preparation, job claims and fenced settlement. It settles the previous Rest
slot, reads through the actual spectator adapters and sync controller, holds
the next boundary at preparation, then prepares and publishes an Expedition.
It asserts processing both before and during that pause, a generic profile,
absence of the unpublished `woodland` destination and private keys, unchanged
owner checkpoint during the wait, a new active activity after publication,
and continued readability of the previous completed result.

Before the source fix,
`npm run test:db -- tests/db/projections.test.ts -t "keeps the next slot processing"`
failed exactly at the expected state: `Sync.processing` was false and the
actor still contained the old completed Rest identity/timestamps. One failed,
five skipped. After applying the corrected reapplicable source to the verified
local Cloudiator container, all **6/6 projection DB tests passed**.

### Generated migration and replay evidence

CLI discovery confirmed Supabase **2.120.0** and current `db pull --help`.
`npx supabase db pull projection_preparation_status --local --schema public,private --yes`
generated M08 from the tested source. Its diff contains the new checkpoint
column and changes only `private.project_character` and `world_actor_reads`.
It does not re-emit unchanged functions. The uncommitted draft was completed
with explicit invoker-view/function ACL preservation and the required
`refresh_projections()` existing-actor backfill, followed by schema reload.
Committed M01–M07, including M07 `20261014045856_projections.sql`, are unchanged.

`npx supabase db reset --local --no-seed --yes` replayed M01–M08 successfully.
No SQL source was applied after that reset. Source/replay comparison matched
**303/303 entries**: function definitions/body hashes/search paths/security and
ACLs; table/view ACLs, RLS/options and definitions; policies, triggers and
constraints; plus the new column's type, nullability and default. Singleton
revision initialization was also checked. The scratch harness and captures are
`task10-fix1-schema-check.mjs`, `task10-fix1-source-parity.json` and
`task10-fix1-replay-parity.json`; they extend the previous schema-query harness.

Fresh verification for this correction:

- `npm run test:db` after migration-only replay: **109/109 tests, six files**,
  **45.37 seconds**, including all six projection cases and affected identity,
  planning, activities/jobs, inventory/shop and expedition authorization flows.
- `npm run typecheck`: TypeScript, both frozen Deno Edge entrypoint checks and
  the **2/2 Deno runtime tests passed**.
- `npx supabase db lint --local --schema public,private --fail-on warning`:
  no schema errors, empty results.
- `npx supabase db advisors --local --type all --level info --fail-on warn`:
  **six INFO unused-index notices**, no warnings or errors.
- Staged source diff check passed after removing one generator trailing blank
  line. This final whitespace cleanup did not change SQL semantics.

This correction does not rerun or relabel the earlier unit/browser/build/static
results. Its real DB regression exercises the unchanged sync adapter directly.
The unrelated Minor initial-world-load offset bias remains explicitly deferred
to UI/final triage by the controller; no offset code was changed here.

### Correction end state

Only the reapplicable projection source, NEW M08, projection DB test and minimal
migration-guide entry are in the source commit. The controller's working
HANDOFF/review files and all Claude-held source remain excluded. No helpers,
Git reset/stash/branch switch, push, hosted/paid fallback or unrelated feature
work occurred. The intended local test stack was reset and left running with
M01–M08; no frontend preview was started for this correction. Local test data
is disposable. This report and its scratch mirror record the exact fix for
takeover; independent review, integration and release gates remain controller
work as previously described.
