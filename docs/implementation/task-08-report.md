# Task 8 — authoritative inventory and NPC shops

Completed locally on 2026-10-13; independent review and push belong to the controller.
Status: **DONE_WITH_CONCERNS** (later-task integration/release gates below, no known failing task test).

## Provenance and scope

- Full review base: `8195ff5f7e319ee2d5959db35906344759544a59` on `codex/gladiator-arena`.
- Original unreviewed Claude source WIP: `5637dd5`; handover addendum: `2bed1a3`.
- Preserved normal import merge: `4be59b3` (`merge: preserve Task 8 partial handover provenance`).
- Completed source: **`801eea1fa085405b50c75c36e28f9db3b1d8b6be`**, `feat: add authoritative inventory and shops`.
- Actual new migration: **`supabase/migrations/20261013065108_inventory_shops.sql`** (M05).
- The prior implementer disappeared after a runtime reset. This continuation read the task brief, recovery record, current instructions and ledger, then preserved its uncommitted work. It did not re-import, reset Git, reimplement from scratch, touch Claude's checkout, or claim the original contributor's unknown test history.

Retained from the original WIP: canonical inventory/grant/XP/gear-score domain code,
catalog salvage rules, parser and backend preparation/adapter work, initial domain
and database tests. The preceding Codex implementer completed SQL, panels, gateway
integration, banner ownership, immutable-history inputs and regression coverage.
This continuation completed browser verification, the generated migration and
replay proof, corrected one SQL lint cast and one affected guard-error assertion,
expanded access-denial checks, completed the cosmetic receipt type and recorded
the evidence. Original contributor commits remain intact; the continuation has
no false Claude co-author attribution.

Controller rulings are binding: the approved banner costs 50 renown and is a
separate bound cosmetic; it has no equipment slot, inventory capacity, combat or
historical-score effect. The legacy `peak_strength` / `peakStrength` is the
monotonic **legal equipment score only**. Task 16 owns the combined league index.

## Implemented behavior and contracts

`planInventoryGrant(inventory, rewards, catalog)` counts every owned item,
including equipped/listed/reserved items, against 60 slots. Salvage stacks to
999, topping up eligible unreserved stacks in item-ID order before adding slots.
Plans distinguish `retained`, `stacked`, `overflow`, `overflowMoney`, `rejected`
and `slotsUsed`. Expedition overflow converts at canonical NPC value; shop and
renown purchases reject when they do not fit. Reserved salvage is excluded from
stacking. Quantities, origin/catalog compatibility and safe integer totals are
validated. Input items are not mutated.

`applyXp(level, xp, award)` consumes `100 × current level` repeatedly and returns
only `{level, xp}`; it awards no attribute points or stamina. The existing rules
maximum level remains the upper bound. Task 9 owns applying this pure result
inside expedition settlement.

`historicalGearScore(items, previousMax)` computes
`4 × weapon damage × (1000 / interval) + 2 × armor` from immutable item stats,
using one item per equipment slot. The best two-handed weapon excludes the
shield; the best one-handed weapon may combine with it. Renown arena modifiers
count toward the score. The result is floored to two decimals and never falls
below the previous maximum. Sales/discards do not lower it. The starter sword
and light armor establish 28. Creation initializes that score; the migration
backfills existing starter-era characters with `greatest(peak_strength,28)`.
Acquiring items changes neither an existing activity snapshot nor its plan.

`shopOffers(CATALOG_V1)` retains **66 equipment offers** across the weaponsmith
and armorer, with money Common variants and bound renown variants at levels
1/5/10. Canonical prices and tier multipliers are reused, not duplicated by UI
or SQL price tables. `CATALOG_V1.cosmetics.banner` separately supplies the
50-renown Arena banner. `OwnerState.ownedCosmetics` contains
`{catalogId, catalogVersion, binding:'bound'}` records. The owner fixture has an
empty cosmetic list. The banner cannot be sold, discarded, transferred or
equipped; an already-owned purchase returns conflict, while the same committed
operation replays its receipt without another debit.

The three backend RPCs are `buy_shop`, `sell_item`, `discard_item`, each
`(actor_id uuid, operation_id uuid, input jsonb) returns jsonb`. `input` is the
backend-only `{command, prepared}` envelope. HTTP accepts exact canonical
commands only. Actor identity comes from verified Auth. The invoker RPCs use an
empty search path and deny PUBLIC, anonymous and authenticated execution.
The existing handler enforces rate limits and origin checks before mutation.

All mutations acquire the account advisory lock, character row, wallet and
sorted inventory rows. Processing is checked against database time after the
account/character locks. Matching receipts replay before new preparation and
processing checks; changed command payload reuse returns conflict. Processing
is transient. Spendable balances subtract held fees. SQL checks level, funds,
capacity, ownership, active/pending reservations, quantity and arithmetic
bounds under lock. Items, wallets, ledger and receipt commit atomically. An
injected final-wallet failure proves acquired items and receipt roll back.
Discard produces no currency or wallet ledger credit.

SQL guards retain immutable item stats/catalog/origin/binding, prohibit bound
owner transfers, enforce equipment quantity one and capacity, and prevent
historical-score decreases. Task 6's reservation guard continues to prohibit
reserved deletion and mutation. PostgreSQL invokes `guard_inventory_item`
before `guard_reserved_item`; the existing Task 6 equipment-quantity test now
expects the first guard's `immutable item` error. Its reserved deletion,
replacement, release and successful post-release deletion assertions remain.

Backend producer types/functions for consumers:

- `InventoryBaseline = {items: Record<itemId,quantity>, peakStrength}`.
- `PreparedGrant = {baseline, plan, peakStrength}` from `prepareGrant(state, grants)`;
  score includes existing items plus retained acquisitions, never overflow gear.
- `prepareShopPurchase(command,state)` and `prepareItemSale(command,state)`
  obtain canonical catalog values from server-read owner state. SQL compares
  the grant baseline under lock and rechecks changed salvage reservations.
- `InventoryValue` includes equipment `ShopPurchaseValue`,
  `CosmeticPurchaseValue`, `ItemSaleValue` and `ItemDiscardValue`.
  The cosmetic receipt is `{cosmeticId:'banner', catalogVersion:'v1', moneyDebit:0,
  renownDebit:number, bound:true}`.
- `private.apply_inventory_plan(gid uuid, prepared jsonb)` returns
  `{itemIds, overflowMoney, overflow, peakStrength}`, or null on a stale baseline.
  It takes the common locks and writes items/history. **It does not credit a
  wallet, create a receipt or provide replay protection.** Task 9 must call it
  within the fenced settlement transaction, atomically credit overflow/rewards,
  write the ledger and retain the permanent settlement guard. A no-op grant
  must not be treated as an idempotency guard.
- `PrepareJobInput.peakStrength` is additive/optional for retained older jobs;
  new `private.boundary_recompute` inputs freeze the field alongside level,
  earned points, build and equipment. A regression proves later acquisition
  cannot change an already-created job's historical input. Task 16 consumes it
  and supplies league promotion; no competing league formula was added here.

## UI and React review

The Inventory tab renders `InventoryPanel` with slots, available currencies,
binding, quantity, immutable stats, reservation and NPC sale values. It supports
sale, explicitly confirmed discard, and the two merchant sub-tabs. `ShopPanel`
uses canonical offers, currency/tier/quantity selection, prices, level locks,
available funds and capacity. Banner ownership is shown separately. Fixture
actions explain that the preview is read-only.

Commands use the live gateway and refresh the protected owner aggregate after
confirmation. Unknown outcomes/processing retain the same operation ID for
explicit retry; current state is not changed optimistically. Buttons prevent
duplicate in-flight requests. Native dialog semantics provide the discard
confirmation, with the safe Keep item action focused. Names render as React
text, not HTML. Parent owner state remains scoped to the signed-in account.

Self-review used the installed Next 16.4 client-boundary/static-export guides
and the Vercel React checklist: direct imports, canonical serializable DTOs,
client-only browser APIs in events/effects, stable effect dependencies and
cleanup, derived eligibility during render, async mounted checks, stable item
keys, labeled inputs, native button/dialog keyboard behavior, and no added
fetch waterfalls or dependencies. The mobile inventory screenshot was visually
inspected; the desktop/mobile flow also asserts no horizontal overflow. This
is not a new art/camp/replay or physical-device FPS signoff.

## RED/GREEN provenance

The recovery record preserves these **previous implementer observations**; the
resumed worker did not fabricate missing raw logs or rerun old code to create
new RED claims:

1. Real shop DB RED: 19/19 failed for missing shop/grant/initialization behavior;
   later 20/20 green, then 21 shops + 36 activities = 57 green.
2. Reserved-stack and malformed-quantity domain regressions failed then passed.
3. Bound 50-renown banner, rollback and frozen history assertions were added;
   the new frozen history assertion failed before its fix.
4. Missing Inventory/Shop panels produced browser RED. First implemented run
   was 6 passed/2 selector failures because Next's route announcer also uses
   `role=alert`. Scoped product alerts were already corrected at resumption.
5. The inherited near-safe-limit DB fixture had converted bigint through
   `float8`, losing precision. It now reads bigint text then converts to Number;
   production numeric/bigint arithmetic was not relaxed.

**Newly observed in this continuation:** SQL lint warned about text-to-jsonb
initialization of `ids` in `apply_inventory_plan`. The minimal explicit
`'[]'::jsonb` source fix produced empty lint results and 57/57 source DB tests.
After clean migration replay, the full DB run was 82 passed/1 failed solely on
the earlier immutable guard's error text versus the old reservation text.
The specific affected test correction, plus stronger ACL assertions, passed
36/36 shops/planning tests against that same replayed database. Original WIP
domain/parser test RED history remains unknown; passing inherited tests are
not retroactively called TDD evidence.

## Generated migration and artifact verification

The running CLI was verified as 2.120.0; current pull/reset/lint/advisors help
was read. Relevant official CLI documentation was consulted. The changelog
markdown fetch was rejected by the web reader's content-type handling; no
claim is made that its latest entries were fully reviewed. This task introduced
no new Supabase API or package version. Current pinned versions were retained.

At resumption Docker was stopped. Docker Desktop was launched hidden; the
database container's `com.supabase.cli.project` label was verified as
`Cloudiator`. Edge was served from this checkout using its existing fresh,
ignored worker secret. Mount inspection confirmed this checkout's functions.
No status credentials, gateway config, env values or secret material were
printed. Unrelated containers and hosted projects were untouched.

After source tests and advisors, `db pull inventory_shops --local --schema
public,private --yes` generated the actual M05 path above and migration list
showed all five local entries. The `migra` draft omitted function ACLs, complete
cosmetic table revocations, explicit view invoker setting and the history
backfill, and emitted three triggers before their functions. The still-
uncommitted draft was completed from source and dependencies reordered.

All **39 re-emitted unchanged function bodies** compare byte-for-byte after
line-ending normalization with their latest earlier migration definition.
Existing changed functions are only `public.create_gladiator` and
`private.boundary_recompute`; eight new functions implement the transactions
and guards. M01–M04 are unchanged. A guarded `db reset --local --no-seed --yes`
then replayed migrations alone; **no source SQL was reapplied afterward**.

A before/after fingerprint comparison matched **228/228** entries exactly:
function bodies and complete definitions (including search path, volatility,
strictness and security), function ACLs, table/view ACLs/RLS/options, view
definition, policies, trigger definitions and constraints. This compares
sanitized schema metadata, not secrets or player rows. Scratch parity SQL,
JSON fingerprints and comparison scripts are retained under the task's ignored
`.superpowers/sdd/2026-10-11-gladiator-arena-implementation/` directory.

Post-replay access evidence covers public RPC HTTP denial for authenticated and
anonymous clients; all five new private functions lack those roles' execution,
retain service execution, use invoker security and empty search paths; both
client roles lack cosmetic INSERT/UPDATE/DELETE/TRUNCATE, anonymous SELECT is
denied, other owners see no cosmetic rows, and owner mutation is denied.

## Commands and newly observed results

All commands ran in `C:/Avi/Studies/Projects/Cloudiator`; database commands were
local only. Scratch logs remain ignored. The Windows sandbox initially blocked
CLI telemetry, Vitest temporary imports and Deno access. Authorized escalated
runs passed; those environment failures are not product RED evidence.

| Command/check | Result |
| --- | --- |
| `npm run test:e2e -- tests/browser/inventory.spec.ts tests/browser/identity.spec.ts tests/browser/planning.spec.ts tests/browser/camp.spec.ts` | **67 passed, 1 existing intentional desktop pinch skip**; inventory 8/8 across desktop/mobile. Port 3100, isolated output. |
| `npm test` | **352 passed**, 15 files. |
| `npm run typecheck` | TypeScript, frozen Deno checks for both Edge entrypoints, **2 Deno runtime tests passed**. Repeated after final receipt-type and test edits; passed. |
| Apply source with verified-container `docker exec -i ... psql -v ON_ERROR_STOP=1`, then owning DB tests | Source commit succeeded; lint empty; **57/57** shops/activities passed. |
| `npx supabase db pull inventory_shops --local --schema public,private --yes` | Generated **20261013065108_inventory_shops.sql**, engine migra. |
| `npx supabase migration list --local` | Five matching local/applied migration entries. |
| `npx supabase db reset --local --no-seed --yes` | Clean M01–M05 migration-only replay succeeded. |
| Scratch source/replay parity comparison | **228 identical entries, 0 differences; 39 unchanged function bodies match**. |
| `npm run test:db` after replay | **82 passed / 1 affected assertion failed** as explained above; activities 36 and identity 11 green. |
| `npm run test:db -- tests/db/build-schedule.test.ts tests/db/shops.test.ts` after test correction/ACL additions | **36/36 passed**: planning 15, shops 21. Together final replay coverage is all 83 DB tests; no misleading claim of an 83-pass single run. |
| Post-replay `db lint --local --schema public,private --fail-on warning` | No issues, `results:[]`. |
| Post-replay `db advisors --local --type all --level info --fail-on warn` | Exit 0; **4 INFO unused-index notices only**: operation receipts gladiator, boundary members gladiator, jobs activity, jobs gladiator indexes. Retained. |
| `$env:CLOUDIATOR_BROWSER_TEST='true'; npm run build` | Fresh isolated Next static export succeeded, including /game and /replay. |
| `npm run verify:static -- .next/browser-test` | **4 fixed routes, 81 assets scanned**, no forbidden backend material. Actual fresh root, not stale out/. |
| `PLAYWRIGHT_STATIC=true`, `PLAYWRIGHT_STATIC_ROOT=.next/browser-test`; shell browser suite | **6 passed, 2 intentional fixture-only skips**, port 4173. |
| `git diff --check`, `git diff --cached --check` | Clean; configured LF/CRLF notices only. |
| Restored fixture preview on port 3000 | **HTTP 200** at `/game/?mode=fixture`; session 72301 at report time. Edge serve session 7337. |

The browser harness intercepts Auth/Data API/command transport while running
the actual components, SDK and gateway. Its in-memory effects prove frontend
behavior only. Real SQL/Auth/Edge tests separately prove authority, races,
ledger/receipt atomicity and denial. Browser logs include the existing color
environment warning, intentional token-refresh denial, and camp context-loss
diagnostics. No hosted Google OAuth proof or physical FPS claim is implied.

## Changed file map and integration gates

Beyond the plan's inventory domain/SQL/panels/owning tests/new migration paths,
necessary additions or amendments are:

- `src/app/game/page.tsx`, `src/app/globals.css`, `src/lib/api/gateway.ts`:
  mount/style the panels and allow the three live item commands.
- `_shared/backend/commands.ts`, `_shared/backend/database.ts`: parser,
  preparation, handler dispatch, adapter and receipt contracts.
- `_shared/contracts/reads.ts`, `_shared/domain/catalog-v1.ts`,
  `_shared/domain/types.ts`: owned cosmetics, salvage/banner catalog and frozen
  preparation input. Existing activity snapshot shapes remain intact.
- `tests/fixtures/domain.ts`, `tests/backend/commands.test.ts`,
  `tests/backend/edge.deno.ts`: additive fixture/parser/handler coverage from
  the WIP and continuation.
- `tests/db/activities.test.ts`: frozen historical-score input regression.
- `tests/db/build-schedule.test.ts`: precise earlier-guard error expectation.
- `tests/browser/inventory.spec.ts`: live/fixture desktop/mobile flows.
- `docs/operations/migrations.md`, this report and the preserved original
  `docs/implementation/task-08-claude-dispatch.md` provenance document.

No assets, scenes, replay code/tests, scanner, HANDOFF, other task reports,
vendor skills, committed earlier migrations or package versions changed.

Remaining gates are explicit:

1. **Task 9:** wire reward planning/XP/overflow into fenced settlement with
   permanent idempotency, atomic credits, reportable conversions, dependency
   gating, summary whitelist/validation and long-simulation lease renewal from
   the reviewed Task 7 handoff. No expedition executor is claimed here.
2. **Task 13:** connect camp merchant events to these sub-tabs, render owned
   cosmetics as appropriate and finish live world/processing integration.
3. **Task 16:** combine level/earned points/historical legal gear in the league
   formula and promote only at boundaries. The legacy field is not total
   strength. **Task 18:** preserve common sorted lock order, binding, held fees,
   reservations and acquisition-history updates for market transfers.
4. Existing hosted OAuth/exact-origin CORS, scheduler/Vault deployment,
   retention, performance and physical-device checks remain Tasks 22–24.
   Current local gateway CORS limitations documented in the migration guide
   are unchanged. No push or deployment was attempted.

The approved persistent migration guidance already covers the observed draft
omissions and replay procedure; no further skill change is proposed. Controller
review must cover the entire base-to-final range, including the imported WIP.
