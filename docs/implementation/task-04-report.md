# Task 4 implementation report

Status: **DONE_WITH_CONCERNS** — completed local identity/command persistence, with the controller-approved local gateway CORS exception and hosted integration responsibilities below.

Dates: 2026-10-11–12, Asia/Jerusalem. Branch: `codex/gladiator-arena`.
Base: `b73987048b9b0c7848dfcdcf29b9cd4d688471cc`.
Implementation commit: **`6bf2d97a7fa664333a174211401f1f904f1cffce`** — `feat: persist one protected gladiator per account`.
Final source SHA: **`0769a12fb6eabd12f809536acb5735ddda1709ac`** — `fix: normalize operation UUIDs for creation retries` (self-review fix, no migration rewrite).
M01: **`supabase/migrations/20261012050952_identity.sql`**.

## Delivered behavior

`handleCommand(request, deps)` verifies the caller through Supabase Auth `getUser`, requires a non-anonymous Google provider and Google identity, and constructs an immutable Actor containing only the verified user ID. Client owner IDs, user metadata, inventory, catalog rolls and derived stamina never supply authority. Auth verification fails closed for missing/malformed/expired/bad-signature tokens and non-Google accounts. Backend keys exist only in the Edge entrypoint's environment-backed clients.

The parser consumes canonical `GameCommand`, using exact keys for every discriminant, UUIDs, finite safe integers, bounded allocations/counts and current catalog IDs. Names use the approved 3–20 English letters/digits/spaces/underscore/hyphen alphabet, with no surrounding whitespace. Payloads are limited to 16,384 streamed bytes as well as the declared length. HTTP method/content-type/JSON/origin errors have safe typed responses, unexpected backend errors return `unavailable`, and CORS uses an exact configured origin. Valid later-task commands return `unavailable`; this task does not implement their gameplay actions.

Database-backed, serialized rolling one-minute limits enforce 60 authenticated command attempts and five creation attempts per account. The handler charges the general budget once, then the creation budget when the parsed JSON's kind identifies creation, including invalid creation payloads. Retried operations count against the limits. The rate table is private and inaccessible to client roles. Server database time determines limits and orientation; there is no player clock-control endpoint.

Backend creation uses `validateCreationAllocation`, `validateBuild`, `CATALOG_V1` and `deriveStats` from reviewed Task 2. It prepares the exact common sword/light-armor rolls and full derived stamina, preserving canonical types and avoiding a second stats formula. The backend-only `create_gladiator(actor_id uuid, operation_id uuid, input jsonb) returns jsonb` additionally validates exact prepared/request shapes, catalog identities, numeric bounds, integer allocations and names. Player HTTP cannot submit this prepared envelope.

One account advisory lock serializes all creation operation IDs for that account. Unique owner/name constraints protect concurrent accounts and case-insensitive name collisions. Success atomically persists character, current build, default schedule, wallet, two immutable starter instances, initial ledger grant and operation receipt. A late inserted-item failure rolls the entire transaction back. Successful and business-conflict receipts are durable and scoped to `(verified account, operation ID)`; the same original JSON command replays the stored result, while changed payload returns `conflict`. Request JSON and SHA-256 digest are stored. Invalid creation input creates no receipt or partial character.

Initial state is level 1, XP 0, earned points 10/all allocated, money 100, renown 0, Bronze/rating 1000, full derived stamina, Balanced stance, Training / Woodland Expedition / Rest, no pending build/reservations and tournament opt-in off. The two starter items are equipped. The orientation ends at the next complete 4,800,000 ms boundary; processed slot records the partial creation slot. Until later activity processing exists, the owner view reports orientation as active before its end and processing after it. Peak-strength processing belongs to Task 8; the durable initial field is zero.

Durable public base tables are `gladiators`, `builds`, `schedules`, `wallets`, `item_instances`, `reservations`, `operation_receipts` and `wallet_ledger`. Every exposed table enables RLS with owner-only SELECT, and direct player mutation privileges are revoked. Both mutation functions use SECURITY INVOKER and are executable only by the backend service role. PUBLIC function execution is explicitly revoked and default privileges hardened. `private.command_attempts` has a primary key, indexed account/budget/time, RLS, a service-role policy and no client schema/table access. No future job/seed tables are invented in this task; those must remain in the unexposed private schema when implemented.

`public.owner_state` is a security-invoker view with columns `owner_id` and `state`; `state` is the canonical `OwnerState` JSON DTO. The view uses underlying table policies rather than bypassing RLS. `loadOwnedInventory(actor)` selects the verified account's aggregate: all 60 item instances fit in one row, avoiding the Data API's 50-row pagination cap. The full-inventory regression caught and fixed a prior base-table implementation returning only 50 items.

## Task 5 and later integration contract

Authenticated publishable-key client query:

```typescript
const { data, error } = await client.from('owner_state').select('state').maybeSingle();
// error => a read failure, never the no-character state.
// data === null => no character for this account.
// data.state => canonical OwnerState.
```

Owner queries return exactly the authenticated account's row; other accounts return zero rows and anonymous clients lack SELECT privilege. Do not send an owner ID as a command authority. Creation success is `{ok:true,receiptId,value:{gladiatorId}}`; reload the owner query after success. `CommandDependencies` wraps verified auth, durable rate limiting and transactional creation. `makeVerifier` produces `verifyActor(request): Promise<Actor>`; the actual Edge entrypoint also exports the configured `verifyActor`.

The controller explicitly assigned the live owner frontend adapter to Task 5 and the general `reads.ts`/public projection adapter to Task 10. No frontend API file was added here. Other live reads remain unavailable until their owning tasks. Task 6 owns pending-build validation against verified inventory, transactional fee reservation/refund and schedule history changes. Task 7 owns activation/real activity projection, private jobs/seeds and historical cutoffs. Task 8 owns ongoing progression/peak strength. Tasks 9–10 own market/public projections; none are implemented here. Retention/checkpoint maintenance is later operations work. Future transactions must revalidate ownership/version at commit, even when using the provided inventory loader.

## File map and justified additions

Specified files delivered: `supabase/config.toml`, `supabase/sql/01-identity.sql`, `supabase/functions/game-command/index.ts`, the four `_shared/backend/{auth,database,commands,http}.ts` modules, `tests/backend/commands.test.ts`, `tests/db/identity.test.ts`, `tests/fixtures/db.ts`, `scripts/test-db.mjs`, `docs/operations/migrations.md`, and generated M01 above.

Necessary runtime/harness adjustments:

- `package.json` / `package-lock.json`: exact `@supabase/supabase-js@2.117.3` for Auth/RPC/Data API; development `supabase@2.120.0` for reproducible CLI/migrations, `deno@2.9.6` for actual Edge checks, and `postgres@3.4.7` for independent real SQL transactions and operator-only local fixtures. `npm install` reported zero vulnerabilities. Node 22.19.0 satisfies the current client's Node requirement.
- `vitest.db.config.ts`: separate serialized database suite, real integration timeouts, no fixture substitute.
- `supabase/functions/deno.json` / `deno.lock`: pinned runtime import mapping, strict Deno compiler, locked npm graph. `typecheck` runs TypeScript, frozen Deno entrypoint compilation and actual Deno test execution.
- `tests/backend/edge.deno.ts`: one mandatory actual-Deno smoke test of canonical creation prep and authority rejection; separate from Vitest and the real local Edge HTTP integration.
- `tsconfig.json`: excludes only the Deno-global entrypoint and Deno runtime test from app TypeScript; shared modules remain typechecked by TypeScript and Deno.
- `supabase/.gitignore`: generated local CLI branch/temp and local secret-file exclusions.
- This tracked report and identical ignored `.superpowers/sdd/2026-10-11-gladiator-arena-implementation/task-4-report.md`.

The source commit contains exactly 21 implementation files. No canonical wire/domain type changes, Claude-owned paths, scene/assets/replay files, controller HANDOFF/reviews, helper agents or pushes. The existing Next preview on port 3000 was not stopped/restarted. Local Edge serving was started independently (execution session 10537 at implementation time).

## RED evidence and corrections

1. Before production implementation, `npm test -- tests/backend/commands.test.ts` exited 1 because `_shared/backend/commands.ts` did not exist. This is the brief's required absent-handler RED, not an assertion-level claim.
2. Once the local harness was correctly configured, `npm run test:db -- tests/db/identity.test.ts` exited 1 with live PostgreSQL `relation "public.gladiators" does not exist`. No helper synthesized an identity result. Startup/path/configuration failures before this are separate environment issues, not RED evidence.
3. With schema present, real Auth integration initially failed because manually inserted raw `auth.users` rows lacked GoTrue defaults: `User from sub claim in JWT does not exist`. Fixtures now use real `admin.createUser`, followed only by trusted local Google-identity installation. An email-identity duplicate in fixture setup was then corrected; these fixture setup errors are not product regression evidence.
4. Legal-name self-review regression: `npm test -- tests/backend/commands.test.ts` exited 1, **1 failed / 4 passed**, `_Avi-` expected non-null but parser returned null. Removed the invented first-character restriction; the alphabet/trim/length rules remain.
5. SQL NULL validation regression: `npm run test:db -- tests/db/identity.test.ts` exited 1, **1 failed / 7 passed**, SQL accepted a prepared command with `classId:null` and returned success instead of invalid. Added explicit type/NULL/exact-shape checks, including starter stats and integer fields. The suite then passed all eight tests.
6. Actual local HTTP check initially exited 1, **1 failed / 8 passed**, because the gateway returned `Access-Control-Allow-Origin:*` instead of the exact origin, despite successful creation. Investigation/controller ruling below preserves this as an observed local tooling limitation, not a claimed product fix.
7. Full inventory regression: `npm run test:db -- tests/db/identity.test.ts -t 'entire verified inventory'` exited 1, **1 failed / 9 skipped**, expected 60 loaded items but received 50. Changed the backend loader to the actor-filtered owner aggregate; the complete database suite then passed ten tests.
8. SQL lint found an unused PL/pgSQL loop variable; removed it before final migration generation. TypeScript found a test-fixture UUID default inferred too narrowly; an explicit canonical string parameter fixed it. These were verification corrections, not feature RED claims.
9. Final UUID-casing regression: `npm run test:db -- tests/db/identity.test.ts -t 'uppercase and lowercase UUID'` exited 1 at 08:17:57, **1 failed / 10 skipped**, expected success but received `invalid`. PostgreSQL normalizes UUID arguments; the prepared JSON command now normalizes only its operation ID to lowercase as well. Both casing forms replay one receipt. The source-only fix was committed separately as `0769a12`; committed M01 remains unchanged. All other original request fields remain exact for changed-payload conflict detection.

## Final verification

All final commands below exited 0. Times are local Asia/Jerusalem on 2026-10-12.

```powershell
npm test
# 08:18:15 — 6 files, 151 tests passed, after final source fix.

npm run test:db -- tests/db/identity.test.ts
# 08:18:14 — 1 file, 11 tests passed, after final M01 clean replay and source fix.

npm run typecheck
# TypeScript no diagnostics; actual game-command entrypoint Deno check --frozen;
# 08:18 — actual pinned Deno runtime: 1 passed, 0 failed.

npx supabase db reset --local --no-seed --yes
# Recreated local database, applied 20261012050952_identity.sql, restarted local containers, success.

npx supabase migration list --local
# local=20261012050952, remote(local target)=20261012050952, 2026-10-12 05:09:52 UTC.

npx supabase db advisors --local --type all --level info --fail-on warn
# Final post-test: no warnings/errors; one INFO unused_index:
# public.operation_receipts.operation_receipts_gladiator_idx.

npx supabase db lint --local --schema public,private --fail-on warning
# results=[], No schema errors found.

git diff --check
git diff --cached --check
# No whitespace errors at commit. Removed only CLI-generated trailing blank EOF lines from M01.
```

Coverage includes same-operation and different-operation same-account races, cross-account normalized-name races, account-scoped reuse of operation IDs, changed-payload conflict, immutable starter rolls/full initial state/next-boundary orientation, one initial ledger grant, owner and anonymous RLS behavior across every table/view, revoked INSERT/UPDATE/DELETE/TRUNCATE privileges, invoker function flags, direct RPC denial, private schema denial, verified Auth and spoofed user metadata/owner IDs, malformed SQL and HTTP numeric inputs, 5/60 rolling limits under concurrency and expiry, induced late transaction failure/rollback, real direct Edge plus gateway HTTP creation/origin denial, and full 60-item backend inventory.

No UI/browser/static build rerun: no frontend behavior/imports changed. The controller agreed backend-owning tests, complete unit suite and both runtime checks cover this task. Hosted load/mobile performance, Google OAuth, deployment and public gameplay remain unverified later tasks.

## Migration workflow and advisor evidence

Reviewed Supabase skill/current changelog, relevant Auth/Edge docs, CLI help and Postgres privilege/RLS/index guidance before schema work. Inspected installed CLI 2.120.0 flags for init/start/query/pull/reset/advisors/migration list/repair/functions serve/lint. Installed Next TypeScript documentation was consulted for compiler integration. The database is the isolated Docker local stack; no hosted project was linked, created or changed.

`npx supabase db query --local --file supabase/sql/01-identity.sql` failed with `cannot insert multiple commands into a prepared statement` on this pinned CLI. Single-statement queries work. The verified fallback for multi-statement local iteration is:

```powershell
Get-Content supabase/sql/01-identity.sql -Raw | docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1
```

Guarded source reapplication succeeded repeatedly. Initial advisor INFO findings for a missing private-table primary key and policy were corrected with a primary key and explicit backend-only policy; unused FK indexes were retained intentionally. Default privileges and explicit backend grants were hardened during migration inspection. `npx supabase db pull identity --local --schema public,private --yes` generated the final exact path, and `migration list --local` confirmed it. Two uncommitted earlier generated drafts were locally repaired/replaced before final M01; no committed migration was rewritten. Generated SQL was inspected for table/constraint/index/policy grants, private schema, invoker behavior, public execution revokes and no unrelated schema modifications. M01 contains the CLI's standard extension declarations and privilege replay boilerplate; no production data or credentials.

Final clean reset applied M01 successfully, followed by all eleven integration tests and final lint/advisors above (the final source-only UUID fix changes no SQL). Immediately after reset, several required indexes showed INFO unused statistics; after the tests only the receipt FK index remained. This is a statistics observation on an empty/new test database, not grounds to remove ownership/FK indexes.

## Local CORS exception and release requirement

Official [CLI configuration](https://supabase.com/docs/guides/local-development/cli/config), actual CLI help, and [Edge CORS documentation](https://supabase.com/docs/guides/functions/cors) were checked. The running local gateway is Kong 2.8.1; its functions route installs the default CORS plugin. The observed gateway HTTP response overwrites the function's allow-origin to wildcard. No supported CLI setting was found to retain the exact header, and no generated/provider gateway internals were patched.

Controller ruling: maintain strict handler/unit tests and actual direct Edge-runtime HTTP exact-header coverage; explicitly characterize the gateway wildcard while verifying actual bad-origin POST is rejected 403 with no state change. These all pass. This exception is confined to the current local tooling. The actual local runtime reports `supabase-edge-runtime-1.77.4`, compatible with Deno 2.1.4; the independent project validation uses pinned Deno 2.9.6. Both ran the implementation successfully.

**Task 24 must verify hosted exact-origin response headers and denial behavior before public launch.** If hosted parity fails, implement a documented supported boundary or present concrete options. This report does not claim hosted CORS parity or approve wildcard release behavior. Exact production origins/redirects and Google provider credentials still require deployment configuration.

## Environment, credential hygiene and self-review

Default sandbox Docker access and CLI telemetry writes were denied; necessary authorized escalations ran local tests/commands. The npm CLI package exposes `dist/supabase.js` rather than the initially assumed older executable path; the test harness uses the installed wrapper. A usage-limit interruption prevented one approval review; no action from that failed request ran. Avi explicitly authorized continuation after the limit, and this task resumed the saved work.

During CORS diagnosis, an attempted filtered read of generated local gateway configuration accidentally included generated **local development** credentials in tool output because matching header context was too broad. No hosted keys/projects were involved. Inspection stopped; values are not repeated in code, reports, commits or coordination. A sanitized in-memory scan compared the local status credential values against all **65 tracked files and 21 staged implementation files**, yielding **zero tracked matches and zero staged matches**. The scan outputs counts only. Local env/startup logs remain ignored, the runner suppresses credential-containing CLI output in errors, and direct Edge test headers travel over stdin. This records the observed local exposure and actual repository scan; it does not claim an unperformed credential rotation.

Self-review found and corrected legal-name overrestriction, SQL NULL handling, overly broad inherited/default grants, missing rate-table primary key/policy, the SQL lint warning, the fixture type annotation, 50-row inventory truncation and operation-UUID casing. It also checked actor authority, prepared-payload exclusion, exact contract reuse, replay identity, transaction rollback, true rolling limits, private/public separation, source/migration replay, no client grants, no module path/runtime drift, no unknown-error leakage, and task ownership. The controller owns independent review, HANDOFF/review commits and push. No helper/reviewer was spawned. Controller-owned AGENTS.md and HANDOFF.md changes remain unstaged by this implementer.

Avi approved the reusable skill improvement reported to the controller: document the observed CLI 2.120.0 multi-statement `db query --file` failure, verified local psql fallback and credential-safe diagnostics in a durable local Supabase override. The controller added the authorized AGENTS.md guidance and will commit it at the reviewed checkpoint. This implementer leaves that controller file unstaged. No vendor cache was modified, and task progress was not gated on the proposal.

The report is committed separately to record the actual source SHA without a self-referential hash. The matching scratch report contains the same complete text.
