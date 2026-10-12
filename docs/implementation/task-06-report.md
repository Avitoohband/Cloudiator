# Task 6 implementation report

Status: **DONE_WITH_CONCERNS** — local planning/reservation work is complete and verified; chronological boundary advancement remains Task 7, sell/list command implementation remains later work, and hosted OAuth/CORS/release proof remains Task 24.

Date: 2026-10-12, Asia/Jerusalem. Branch: `codex/gladiator-arena`.
Base: `ad1b7e8b9a5bb52c01c5ee7e8897980ebd62582a`.
Source: **`f35c9acf5a49459af7245291952bb5211bf333a0`**, `feat: queue safe schedule and build changes`.
M02: **`supabase/migrations/20261012121232_build_schedule.sql`**.
M01 `supabase/migrations/20261012050952_identity.sql` is unchanged.

The controller owns independent review, HANDOFF/review commits and push. No helper/reviewer was spawned and no push, merge or branch change was performed.

## Delivered behavior

All three command kinds pass through the existing exact canonical parser, verified Google account identity, origin boundary, 16 KiB input limit and general 60/minute limit. Existing creation behavior and its separate 5/minute limit remain. Live frontend commands now enable only creation, edit-schedule, queue-build and cancel-build; unrelated commands and future reads remain explicitly unavailable.

`createDatabase().plan(actor, command)` normalizes the operation UUID to lowercase. For queueing, the backend reads the actor-filtered owner aggregate, validates against the canonical `validateBuild`, computes fees with `buildChangeFee` against the active build, and derives maximum stamina with `deriveStats`. It sends the original canonical command plus private preparation to SQL. Clients cannot submit the prepared envelope. Preparation includes the exact current/pending builds, build edit version, earned points, level and complete sorted owned inventory. SQL takes locks and rereads those values; a mismatch returns conflict before any reservation change. Wallet availability is computed from locked current wallet/reservation state, not the prepared read. There is no second SQL stats/catalog build engine, and the reviewed arena precision rules are unchanged.

Planning mutations acquire the existing account advisory transaction lock `hashtextextended(actor_id::text,0)`, then the gladiator row, builds/schedules/wallet and inventory rows in item-ID order. The database clock is read after account/character lock acquisition. New commands return `processing` with a 1000 ms retry hint if the character checkpoint is behind the current shared slot. Matching committed operation receipts replay before the checkpoint, current version or new preparation checks; changed JSON under an existing operation ID returns conflict. The tests include replay after intervening replacement/cancellation/application and after a formerly requested item is deleted so new canonical preparation fails. Transient processing is not recorded, allowing the same request to succeed after catch-up. Accepted commands and reached business failures such as version conflict, invalid build or insufficient funds produce durable account-scoped receipts. Early malformed/no-character errors do not create receipts; rate limiting remains outside these transactions.

Schedule edits update the latest repeating plan and increment its version. `schedule_revisions` preserves each phase's choice, received timestamp, effective slot and revision. An occurrence whose start is equal to or earlier than the locked receipt time is excluded; e.g. a morning edit exactly at morning's cutoff becomes effective next morning. Initial choices are recorded by a trigger, and the migration backfills existing characters. Controlled source reapplication does not backfill synthetic revisions for characters that already have history. Expedition level gates are checked against the locked character. Task 7 must select the latest eligible historical revision, not the mutable latest-plan row, for catch-up.

Queueing holds 100 money for class changes and 100 for a decrease in any active attribute allocation. Combining them holds 200. Allocating earned unspent points costs zero. Replacement compares against the active build and atomically releases the old hold before reserving the new amount. The wallet retains the held funds until activation; spendable funds are wallet money minus held reservations. Insufficient replacement funds leave existing state intact. Cancellation releases a pending hold once; replay does not refund twice. Current class, stance, allocation, equipment and stamina remain unchanged while pending.

`pending_build_items` records every selected item, including those already equipped. Newly selected items carry a `pending-build` reservation; currently equipped items keep their equipment reservation. Replacing/canceling frees only the old pending selection. A database item guard rejects deleting, transferring, changing quantity or changing immutable item fields while an active/pending reservation exists. The test uses actual SQL deletion/quantity mutation attempts; a frontend mock is not the source of authority. Sell/list/discard commands themselves remain Tasks 8/9.

The service-only private application primitive consumes a held fee once, writes one build ledger row, changes current equipment/build, clears pending state, and computes unspent points from current earned points minus the pending allocation. It preserves absolute current stamina, clamping only when the maximum shrinks. A higher Endurance maximum does not refill stamina. Null/negative boundaries are rejected, earlier boundaries return false, and repeat application returns false with no duplicate money/point/item effects. The primitive neither awards activity rewards nor advances a checkpoint.

## Canonical interfaces and controller rulings

- `OwnerState.buildVersion` is a required monotonic edit revision backed by `public.builds.version` (default 1). Queue/replace/cancel increments it. Queue/cancel `expectedVersion` must use this field. The controller explicitly chose this additive DTO field so `currentBuild.version` remains the active snapshot identity and does not change while pending. Pending `build.version` carries its eventual edit revision; activation never decreases the edit revision.
- `PendingBuildView` adds `reservedItemIds: string[]`, alongside the existing build/effectiveSlotIndex/reservedMoney/operationId fields. `BuildDraft` is a backend alias of this canonical type, not a competing definition. `ScheduleEditValue` and `PlanningValue` are exported beside the producing adapter.
- `public.edit_schedule(actor_id uuid, operation_id uuid, input jsonb) returns jsonb`.
- `public.queue_build(actor_id uuid, operation_id uuid, input jsonb) returns jsonb`.
- `public.cancel_build(actor_id uuid, operation_id uuid, input jsonb) returns jsonb`. The controller confirmed extending the plan's two-argument shorthand to carry the canonical expectedVersion into the locked transaction.
- `input` is the backend-only `{command, prepared}` envelope. Queue preparation is canonical validated data; other commands use null preparation. All public RPCs and their private helpers use SECURITY INVOKER, empty search paths and explicit client execution denial/service execution grants.
- `private.pending_build_preparations` stores the immutable canonical snapshot including rulesVersion, derived stamina maximum, operation ID and received milliseconds. This state is not included in public builds, pending DTO JSON or any authenticated base-table projection. Private schema/table grants and RLS restrict it to backend use.
- `private.apply_pending_build(gid uuid, boundary_slot bigint) returns boolean` acquires the common account/character locks. Task 7 must call it inside the chronological boundary transaction **after** settling the previous slot and **before** new-slot stats/snapshots. Task 7 owns the global cutoff/barrier, ordering, season work, worker jobs and checkpoint advancement. This task implements no scheduler or test player clock endpoint.
- For historical schedule resolution: filter by gladiator, phase and `effective_slot_index <= targetSlot`, then order by effective slot descending and version descending. Initial history contains all three choices. Latest owner schedule is planning UI data, not catch-up authority.
- Task 8/9 item mutations must take the common locks and deny both active and pending reservations. Wallet spends must subtract held reservations from available funds.

## Frontend behavior and verification boundaries

`SchedulePanel` edits the three repeating phases and disables locked expedition choices. It shows estimated next occurrence times through canonical `nextPhaseStart`, clearly labeled as estimates; the server receipt supplies the confirmed effective time. Client time never supplies eligibility. The current activity continues.

`BuildPanel` shows Current and Pending class/stance/attributes/equipment, confirmed pending effective time and reservations. Its draft uses canonical build validation, fee calculation and derived load/stamina preview. Selecting a two-handed weapon clears the draft off-hand selection. Invalid allocations/builds cannot submit. Increasing Endurance previews the preserved absolute stamina. Queue/replace/cancel refreshes the protected owner aggregate rather than optimistically replacing the active build. Available money is labeled separately from held fees.

Both panels retain an immutable in-memory operation/payload for unchanged unknown-outcome, rate-limit and processing retries. Editing clears the attempt; a version conflict reloads authoritative owner state and lets the next deliberate request use a new operation/version. A synchronous sending guard prevents duplicate submits. Async UI effects are ignored after unmount; root owner refresh shares the existing request revision guard. Panels mount only for the current signed-in owner and key by gladiator; fixture mode stays a read-only preview. No wallet/inventory/owner authority or private preparation is persisted in browser storage. Creation/account/session guards remain intact.

Browser tests use explicit intercepted HTTP identity/owner/command transport to exercise the real components, SDK session, live gateway request shapes, retries, error branches and refreshes. They do not prove database authority. The separate real SQL/Auth/Edge tests provide that evidence. Desktop/mobile screenshots were inspected: Current/Pending are side-by-side on desktop and stacked on mobile; form controls and whole-point inputs fit the viewport, with a mobile no-horizontal-overflow assertion. The long mobile management form remains scrollable. Hosted Google consent and actual device performance are not claimed.

## TDD and correction evidence

1. `npm run test:db -- tests/db/build-schedule.test.ts`, 09:38 — **2 failed** before implementation: absent RPC inventory (`[]` instead of the three names), and combined reservation returned unavailable instead of reservedMoney 200. The test created a real authenticated local character and 300-money operator fixture.
2. During source iteration, the first SQL application found an unparenthesized PL/pgSQL CASE expression in an IF condition. After syntax correction, the focused RPC diagnostic exposed ambiguous `operation_id` in reservation UPDATE predicates. Qualifying the table columns corrected the issue. The initial owning tests then passed **2/2** at 09:43.
3. `npm run test:e2e -- tests/browser/planning.spec.ts --project=desktop --workers=1` before panels existed — **3 failed**, absent Current build/class/schedule editing controls. After implementation, test control selection exposed nested-select label matching and an unscoped Next route-announcer alert. Explicit class/stance labels and planning-scoped alert locators resolved these. Final six desktop/mobile planning tests passed.
4. Expanded real database coverage passed **10**, then **13**, then **15** tests, covering cutoff history, races, fee cases, cancellation/replacement, newly earned points, stamina growth/shrink, item reservation guards, stale preparation, processing replay, RLS/private data, injected late rollback and actual authenticated Edge HTTP.
5. The first clean generated M02 replay's affected suite was **25 passed / 1 failed**: the existing identity security test found inherited mutation privileges on new `pending_build_items` and `schedule_revisions`. Source iteration had correctly revoked them; the CLI diff omitted the complete revocations. Restoring source-equivalent revoke/regrant statements to the uncommitted migration made the next clean replay pass **26/26**.
6. Self-review regression `npm run test:db -- tests/db/build-schedule.test.ts -t 'consumes a combined fee'`, 15:20:11 — **1 failed / 14 skipped**: private activation with a null boundary resolved true instead of rejecting. Added explicit null/negative boundary rejection to source and the still-uncommitted M02. Final clean replay plus both suites passed **26/26** at 15:20:45.
7. Final receipt edge test explicitly deletes an item after pending replacement and verifies replay still returns its original receipt despite failed new preparation. Focused owning test passed **1/1**, 14 intentionally skipped, at 15:18:57; it is included in the final 26-test pass.

Environment/setup failures are not product RED evidence: the default sandbox blocked CLI telemetry/Deno filesystem access; authorized escalation succeeded. Automatic approval review later hit an account usage limit before migration generation executed. Avi explicitly authorized continuation afterward; no action bypassed the failed review. One initial static-browser run expected unconfigured production but the build was given placeholder public config, producing **2 failed / 4 passed / 2 skipped**. Rebuilding with empty public config to match that existing suite passed all six applicable checks. No product change was made to hide that harness configuration mismatch.

## Migration generation, replay and security

CLI 2.120.0 version/help were inspected for query, pull, migration list, reset, lint and advisors. The existing approved local psql fallback applied the reapplicable SQL source only to the verified `supabase_db_Cloudiator` container. Source iteration and migration replay were separate checks. Official Supabase changelog/RLS and PostgreSQL locking docs were consulted; the current HTTP TLS deprecation does not alter these local transactional interfaces. Installed Next 16.4 client-component docs and React self-review guidance were read.

`npx supabase db pull build_schedule --local --schema public,private --yes` generated M02 at 12:12:32 UTC; local migration list showed M01 and M02. Its `migra` diff required explicit review completion before commit: public triggers originally preceded their private functions; function ACLs were missing; full table revocations were missing; existing-character history backfill DML was absent. Triggers were moved after function definitions, source-equivalent ACL statements and backfill were included, and security-invoker view behavior was made explicit. The null-boundary regression guard was also incorporated before this artifact was committed. These are documented changes to a newly generated draft, not edits to an immutable committed migration.

Three controlled clean CLI reset/replays were run while completing the draft, with the final one proving the complete artifact. Reset output stayed in ignored `.task6-reset.log`. The controller explicitly allowed this mandatory isolated local reset despite the brief's normal service-preservation wording. The database/Auth containers restarted, but the original Edge runtime remained up approximately six hours, so no manual `functions serve` restart or replacement session was needed. Real direct Edge tests succeeded after final replay, including origin rejection. The original preview at port 3000 returned HTTP 200; unrelated/hosted services were not touched.

Final SQL lint: `results=[]`, no schema errors. Final advisors: no WARN/ERROR; two INFO unused-index observations, `operation_receipts_gladiator_idx` and `schedule_revisions_effective_idx`. Both are retained for FK/history access; an isolated new database's statistics do not justify removing them. All client table mutations and new RPC execution are denied, owner history is isolated, private preparation is inaccessible, and source/migration use invoker execution. The existing local Kong CORS characterization remains unchanged; hosted exact-origin proof is Task 24.

## Final commands and results

- `npm test` — **153 passed**, seven files, 15:20:44 after final source/type changes.
- `npm run typecheck` — TypeScript clean; pinned Deno frozen actual-entrypoint check passed; actual Deno smoke **1 passed**, 15:20.
- `npx supabase db reset --local --no-seed --yes` — final M01+M02 clean replay succeeded; no source SQL was applied between that replay and the final tests.
- `npm run test:db -- tests/db/build-schedule.test.ts tests/db/identity.test.ts` — **26 passed** (15 planning + 11 identity), 15:20:45, final migration artifact.
- `npm run test:e2e -- tests/browser/planning.spec.ts tests/browser/identity.spec.ts tests/browser/shell.spec.ts --workers=2` — **30 passed / 4 intentionally skipped** development desktop/mobile, including all six planning cases. A later exact desktop planning capture passed **1/1**.
- Isolated `CLOUDIATOR_BROWSER_TEST=true`, fixture false, empty public config: `npm run build` succeeded; `npm run verify:static -- .next/browser-test` — **three fixed routes, 37 assets**, no forbidden backend material. The isolated Next output is the actual scanned export; default preview output was preserved.
- `PLAYWRIGHT_STATIC=true`, `PLAYWRIGHT_STATIC_ROOT=.next/browser-test`, `npm run test:e2e -- tests/browser/shell.spec.ts --workers=2` — **6 passed / 2 intentionally skipped** against the fresh export.
- `npx supabase db lint --local --schema public,private --fail-on warning` — clean; `npx supabase db advisors --local --type all --level info --fail-on warn` — only the two INFO observations above.
- `git diff --check` and `git diff --cached --check` — no whitespace errors. Git reports expected LF-to-CRLF notices for source files. Browser output includes existing color-variable warnings and the deliberate session-expiry refresh-denial diagnostics; output is not claimed pristine.
- Credential-safe in-memory scan of **82 tracked/intended new files** against local status credential values — **zero credential matches**. Status values were never printed. Private config/reset logs and generated exports remain ignored.

## Exact file map and self-review

The source commit contains **16 files**:

1. `supabase/sql/02-build-schedule.sql` — reapplicable schema, transactions, guards, private activation and owner projection.
2. `supabase/migrations/20261012121232_build_schedule.sql` — CLI-generated, reviewed and clean-replayed M02.
3. `supabase/functions/_shared/backend/database.ts` — canonical prepared build, locked-baseline contract and planning adapter/types.
4. `supabase/functions/_shared/backend/commands.ts` — authenticated dispatch for only the three newly owned kinds.
5. `supabase/functions/_shared/contracts/reads.ts` — approved buildVersion plus pending item-ID reservations.
6. `src/features/schedule/SchedulePanel.tsx`.
7. `src/features/build/BuildPanel.tsx`.
8. `src/lib/api/gateway.ts` — enable only the owned live commands.
9. `src/app/game/page.tsx` — mount the two panels and guarded authoritative refresh.
10. `src/app/globals.css` — responsive planning controls/comparison layout.
11. `tests/db/build-schedule.test.ts` — 15 real database/Auth/Edge/concurrency tests.
12. `tests/browser/planning.spec.ts` — three behaviors on desktop/mobile using actual components/live gateway with intercepted transport.
13. `tests/fixtures/domain.ts` — required canonical buildVersion field.
14. `tests/backend/commands.test.ts` — expanded dependency interface in existing mocks.
15. `tests/backend/edge.deno.ts` — expanded dependency interface in the real Deno smoke.
16. `docs/operations/migrations.md` — exact M02 workflow, verified diff corrections and Task 7/8 integration contract.

The canonical domain validators/stats already supported the required legality/fee behavior and were reused unchanged. The brief's planned domain-validation extension therefore required no duplicate or unnecessary domain change. Necessary DTO/fixture/page/style/gateway adjustments were expressly authorized by the controller. No dependency, lockfile, auth/session implementation, M01, Claude-owned art/scene/replay/management file or controller HANDOFF file was included. This report is committed separately with an identical ignored scratch copy at `.superpowers/sdd/2026-10-11-gladiator-arena-implementation/task-6-report.md`.

Self-review checked active snapshot stability, edit revision monotonicity, receipt replay before failed preparation, reservation conservation, locked baseline comparisons, numeric/cutoff semantics, private projection boundaries, worker application idempotency and null handling, historical schedule selection, source reapplication, migration ACL/dependency parity, account/unmount guards, keyboard/native controls, responsive screenshots and exact staging. Known issues found during this review were corrected and tested above. Independent review remains the controller's responsibility.

The version-scoped CLI diff omissions are a reusable workflow lesson. The controller will propose a narrowly scoped persistent Supabase migration-guidance update under Avi's skill-upkeep policy after checking existing guidance. No vendor cache or skill was modified, and the proposal does not gate the completed task work.
