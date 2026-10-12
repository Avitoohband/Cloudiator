# Local identity backend and migrations

## Task 6 planning migration and worker boundary

M02 is **`supabase/migrations/20261012121232_build_schedule.sql`**, generated with CLI 2.120.0:

```powershell
Get-Content supabase/sql/02-build-schedule.sql -Raw | docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1
npx supabase db lint --local --schema public,private --fail-on warning
npx supabase db advisors --local --type all --level info --fail-on warn
npx supabase db pull build_schedule --local --schema public,private --yes
npx supabase migration list --local
npx supabase db reset --local --no-seed --yes *> .task6-reset.log
npm run test:db -- tests/db/build-schedule.test.ts tests/db/identity.test.ts
```

The CLI-generated uncommitted `migra` diff required review completion: move cross-schema triggers after their private functions, retain explicit function and table revocations/grants, preserve the view's security-invoker option, and add the source's existing-character schedule-history backfill. Schema diffing does not capture that data backfill. The first replay's security regression found inherited mutation privileges on `pending_build_items` and `schedule_revisions`; explicit source-equivalent revoke/regrant statements corrected the draft. A second clean replay passed both suites (26 tests), real Edge HTTP, lint, and advisors (only two INFO unused indexes). M01 was unchanged. Once committed, M02 is immutable.

All three public backend-only RPCs are `(actor_id uuid, operation_id uuid, input jsonb) returns jsonb`: `edit_schedule`, `queue_build`, and `cancel_build`. `input` is the server-only `{command, prepared}` envelope; HTTP accepts only canonical `GameCommand`. Cancellation includes the canonical expected version despite the plan's abbreviated two-argument signature. `OwnerState.buildVersion` is the queue/replace/cancel revision; `currentBuild.version` stays unchanged until activation. `PendingBuildView.reservedItemIds` records the reserved item IDs.

Mutation lock order is account advisory lock `hashtextextended(actor_id::text,0)`, then its gladiator row, builds/schedules/wallet and item rows in ID order. Read the database clock after acquiring the account/character lock. Task 7 must share this order and the common slot cutoff. A new mutation returns transient, unrecorded `processing` while `processed_slot_index` is behind database time; a matching committed receipt replays before that check and before new preparation validation. Defined business failures are retained; changed payload reuse returns conflict.

`schedule_revisions` retains phase, version, choice, received milliseconds and effective slot. For historical snapshots, select the latest revision for that character and phase with `effective_slot_index <= slot`, ordered by effective slot then version descending. The baseline contains all three initial choices; future edits never rewrite it. `schedules.schedule` is the owner's latest repeating plan, not historical activity authority.

`private.pending_build_preparations` stores the canonical validated snapshot (including rules version), derived stamina maximum, operation ID and received time. It has no client schema/table access and is excluded from owner DTOs and public base tables. `private.apply_pending_build(gid uuid,boundary_slot bigint) returns boolean` is a backend-only atomic application primitive: it takes the common locks, refuses earlier slots, returns false when nothing is pending, consumes the held fee once, writes one ledger row, switches item reservations/current build, preserves absolute stamina with a downward clamp, computes unspent points from current earned points, and clears pending state. Task 7 alone owns chronological settlement, the global cutoff/barrier and checkpoint advancement; call this primitive after prior-slot settlement and before new-slot snapshots. It does not advance a checkpoint, award rewards or implement a scheduler.

Task 8 sale/list/discard commands must take the same locks and require no active or pending item reservation. `pending_build_items` tracks every selected item even when it is also currently equipped; the item guard rejects deletion, transfer, quantity/stat changes while reserved. Replacement/cancel releases only pending reservations, retaining current equipment. Wallet money includes held funds; spendable money is money minus held reservations. Fees leave the wallet only at activation.

The controller authorized the deliberate local reset/replay exception to service preservation. The existing Edge runtime remained up (no manual serve restart), real Edge tests passed afterward, and preview port 3000 returned HTTP 200. Capture reset/startup output to ignored logs and never publish raw credentials.

Task 4 uses Supabase CLI **2.120.0**, supabase-js **2.117.3**, npm Deno **2.9.6**, and PostgreSQL test driver **postgres 3.4.7**, all pinned. Node **22.19.0** and Docker **29.8.2** were verified; the local database image is PostgreSQL **17.11.0.004**. The test driver provides independent pooled SQL transactions and trusted local fixture setup; production mutations use Supabase RPC, not this driver.

Only the local `Cloudiator` stack is used here. Do not link, reset, or otherwise reuse unrelated hosted projects. Never print `supabase status` credentials, gateway configuration, or local environment files. The test runner reads status into memory and refuses non-loopback URLs. CLI status/telemetry and Docker may require the approved Windows sandbox escalation.

## Fresh checkout

```powershell
npm ci
npx supabase --help
npx supabase start --help
npx supabase start --exclude studio,realtime,storage-api,imgproxy,mailpit,logflare,vector,supavisor *> .supabase-start.log
npx supabase db reset --help
npx supabase db reset --local --no-seed --yes
```

The ignored startup log contains local credential output. Inspect only sanitized errors, never paste the complete log. In a second terminal, start the local Edge function:

```powershell
'GAME_ALLOWED_ORIGINS=http://127.0.0.1:3000' | Set-Content .env.edge.local
npx supabase functions serve --help
npx supabase functions serve --env-file .env.edge.local
```

Then run:

```powershell
npm run test:db -- tests/db/identity.test.ts
npm test
npm run typecheck
```

The database suite resets **game tables in the local stack**, creates real Auth test users through the admin API, installs Google identities using trusted operator SQL, and signs only local test JWTs. This exercises real Auth `getUser`, PostgREST/RLS, SQL transactions, and the running Edge HTTP endpoint. It does not test Google's hosted OAuth exchange. `directEdge` uses the local database container's curl client to reach the Edge container through Docker networking, with bearer credentials passed on stdin. Local test users are disposable and removed by the next database reset. No test identity or clock-control endpoint exists in production code.

`npm run typecheck` must pass TypeScript, pinned Deno `check --frozen` on the actual Edge entrypoint, and an actual Deno runtime smoke test. The app compiler excludes only the Deno entrypoint and Deno test; their imported shared modules remain covered by both compilers. `supabase/functions/deno.lock` pins Deno's dependency graph separately from npm's lockfile.

## SQL source iteration and deployment artifact

Source: `supabase/sql/01-identity.sql` uses guarded DDL and replaceable functions/view/policies for controlled local reapplication. The deployable **M01 is `supabase/migrations/20261012050952_identity.sql`**. It was generated by the CLI from tested database state, inspected, reset/reapplied, and tested. Committed migrations are immutable; create a new migration for future changes.

Discover flags before use:

```powershell
npx supabase db query --help
npx supabase db advisors --help
npx supabase db pull --help
npx supabase migration list --help
```

The tested CLI 2.120.0 invocation `npx supabase db query --local --file supabase/sql/01-identity.sql` fails with `cannot insert multiple commands into a prepared statement`. This is a version-scoped observed limitation. Single-statement `db query --local` works. For this multi-statement source, the verified local psql fallback is:

```powershell
Get-Content supabase/sql/01-identity.sql -Raw | docker exec -i supabase_db_Cloudiator psql -U postgres -d postgres -v ON_ERROR_STOP=1
npx supabase db advisors --local --type all --level info
npx supabase db lint --local --schema public,private --fail-on warning
npx supabase db pull identity --local --schema public,private --yes
npx supabase migration list --local
```

Inspect the exact generated path, grants, function privileges, security-invoker view, RLS, constraints, and private schema before staging. Never invent timestamps. Do not use the source file as a second migration on deployment. `db pull` can label the local database as “remote” in its progress/history messages; `--local` selects the local stack. Replaying with `db reset --local --no-seed --yes`, rerunning the integration suite, and rerunning advisors is a separate required check from source iteration. The initial uncommitted drafts `20261012050407` and `20261012050628` were discarded using local `migration repair --status reverted` and exact-file removal before the final M01; they were never committed or deployed.

## Protected owner query and command boundary

Task 5 can call the authenticated publishable-key client:

```typescript
const { data, error } = await client.from('owner_state').select('state').maybeSingle();
// error: surface the read failure; never interpret it as "no character".
// data === null: verified account has no gladiator; show creation.
// data.state: the canonical OwnerState DTO, ready for the management UI.
```

`public.owner_state` has `owner_id` and `state` columns. Select only `state`; ownership is enforced by the security-invoker view's underlying owner-only RLS policies. A no-character account returns zero rows; other owners see zero rows; anonymous callers lack SELECT permission. The same owner restrictions cover all base game tables. All client mutations and both command RPCs are denied to `anon`/`authenticated`. `private` is not exposed and grants no client USAGE. The service-role client is backend-only and calls SECURITY INVOKER RPCs. Creation results are `{ok:true, receiptId, value:{gladiatorId}}`; query `owner_state` afterward.

`create_gladiator(actor_id uuid, operation_id uuid, input jsonb)` consumes trusted backend preparation containing `{command, starterItems, staminaMaximum}`. HTTP accepts only canonical `GameCommand`; players cannot submit the prepared envelope, owner IDs, authoritative inventory, rolls, or stamina. `prepareCreation` uses the reviewed domain allocation/build/catalog/stats functions. SQL revalidates exact shapes, name/allocation/integer/catalog constraints, serializes each account, enforces global case-insensitive names, and writes initial state/items/ledger/receipt atomically. Account-scoped operation replay compares the original JSON command; a changed payload returns conflict. Successful and business-conflict receipts are durable. Invalid requests do not create receipts. Separate database-backed rolling limits count 60 authenticated attempts/minute and five creation attempts/minute; retries count too. The handler charges the general limit once and then the creation limit by parsed kind, including invalid creation payloads.

`loadOwnedInventory(actor)` queries the verified actor's gladiator and items on the server; later build commands must use it. Other valid command kinds return `unavailable` until their owning tasks implement transactions. No frontend read adapter is added here. Task 5 owns live owner loading; Task 10 owns public reads. Task 7 must replace the initial orientation projection with real activities and preserve the stored slot boundary. Task 8 owns progression/peak-strength processing. Pending builds and fee reservations have storage now; activation/refunds belong to Tasks 6–7. Future plans/seeds must remain in `private`, not owner-readable tables or receipts.

## CORS and hosting follow-up

The handler requires exact origins from backend `GAME_ALLOWED_ORIGINS`, emits an exact matching allow-origin header, rejects other Origin values before Auth/database work, and uses bearer JWTs rather than cookies. Missing Origin supports non-browser authenticated clients. Local configuration has no hosted credentials; Google OAuth credentials, provider enablement, callback, exact production redirects and origins remain Task 24.

Observed local exception: CLI 2.120.0's Kong 2.8.1 `functions-v1` route installs its default CORS plugin and rewrites the handler's allow-origin header to `*`. Official [CLI configuration](https://supabase.com/docs/guides/local-development/cli/config) and CLI help did not expose a supported gateway CORS override; official [Edge CORS guidance](https://supabase.com/docs/guides/functions/cors) places header handling in the function. No generated gateway configuration was changed. Controller-approved tests preserve exact headers and denial behavior through direct Edge HTTP, characterize the gateway wildcard, and prove gateway bad-origin POST returns 403 with no state change. **Task 24 must verify hosted exact-origin headers and origin denial before launch**; a hosted mismatch requires a documented supported boundary or explicit options, not silently accepting wildcard CORS. This local exception is not a production release approval.

Advisors can report informational unused FK/ownership indexes immediately after a reset. Keep the indexes: they support required ownership queries and FK maintenance, and a new database's statistics are not workload evidence. No warning/error or SQL lint finding is accepted for this checkpoint. Detailed run evidence lives in `docs/implementation/task-04-report.md`.
