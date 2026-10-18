# Task 18.2 report: market commands and reads

- **Status:** DONE_WITH_CONCERNS. Every gate passed. The concerns are interpretation choices and notes for 18.3.
- **Branch and base:** branch `claude/task-18` in `C:\Avi\Studies\Projects\Cloudiator-claude`, base `a4523ae`.
- **Commit:** `ae5d0c3 feat: serve marketplace commands and pages`. It is not pushed.

## What I implemented

### Edge command path (`supabase/functions/_shared/backend/`)

**`commands.ts`**
- `create-listing` now accepts only whole prices from 1 to `RULES_V1.marketplace.maximumPrice` (1,000,000,000), so a larger
  price is a 400 `invalid` before any RPC.
- `MARKET_KINDS` lists the three listing kinds. They join the allowlist and dispatch to `database.market`.
  `CommandDependencies.database` picks `market`.

**`database.ts`**
- The `market(actor, command)` adapter follows the `inventory` model. It lowercases `operationId` and the `itemId` or
  `listingId`, then calls `create_listing`, `cancel_listing` or `buy_listing` with `{ command, prepared }`.
- **Create and cancel** send `prepared: null` and read nothing first.
- **Buy** reads `owner_state` (the buyer) and `market_offers.item` (the listing) in parallel through the service-role
  client. It then prepares `{ baselinePeakStrength, nextPeakStrength }` with the new exported `prepareListingPurchase`
  (Decision 8):
  - The baseline is `progression.peakStrength`.
  - The next value is `historicalGearScore([...inventory, listed item], baseline)`.
  - A listed item is never renown gear, because SQL refuses to list one. So it scores without the Arena modifier.
- **No open offer** (sold, cancelled, expired or unknown): the baseline stands (next = baseline). SQL then answers `sold`,
  `expired` or `not-found` from the listing itself, never `invalid`.
- **No character, or malformed stored stats:** the preparation is `null`. The call still reaches SQL, so a committed receipt
  replays first.
- **Carried item 1:** an RPC error with SQLSTATE `40P01` or `40001` returns `{ ok: false, code: 'processing',
  retryAfterMs: 1000 }`. Any other error throws `market-unavailable`, which the handler answers with a 503 `unavailable`
  and no driver text.
- New exported types: `MarketCommand`, the three value types and `MarketValue`, and `ListingPurchasePreparation`.

### Contract, reads and gateways

**`supabase/functions/_shared/contracts/reads.ts`:** `MarketListing` gains `listedAtMs`.

**`src/lib/api/reads.ts`**
- **`parseMarketRead(cursor?, seller?)`** runs before any query is built.
  - The cursor `listedAtMs:listingId` reuses the results cursor rules: none when absent, null or empty; `unavailable` when
    malformed.
  - A seller must be a gladiator UUID, in any letter case; it is lowercased. Anything else, including `''`, is
    `unavailable`, so an empty seller never widens to every seller.
- **`readMarket(client, cursor?, seller?)`**
  - Reads `market_offers`, newest `listed_at_ms` first, then `id` ascending, `limit 50`.
  - With a seller, it filters `seller_gladiator_id=eq.<seller>`.
  - After a cursor, it filters `or=(listed_at_ms.lt.T,and(listed_at_ms.eq.T,id.gt.ID))`.
  - It cuts the answer to 50 rows and copies only the six sanitized item fields.
  - A full page names its last row as `nextCursor`.

**`src/lib/api/gateway.ts`**
- `GameGateway.market(cursor?, seller?: GladiatorId)` is documented.
- The live gateway serves it through `publicRead`, so it needs no session.
- The command allowlist gains the three listing kinds.
- The now-unused `unavailable` helper is removed.

**`src/lib/api/fixture-gateway.ts`:** `market(cursor, seller)` serves `FIXTURE_MARKET` with the same parse rules.
- A seller re-pages only that seller's offers.
- A well-formed cursor that no page issued ends the list.
- Callers get copies.

**`tests/fixtures/market.ts`** (new). It has no JSON imports, so 18.3's browser specs can import it.
- `MARKET_ROWS`: 7 offers in the live order.
- `marketPages(rows, size=50)` and `FIXTURE_MARKET: MarketPage[]` (one page).
- The offers:
  - tiers 1, 5 and 10; rarities common, uncommon and rare;
  - five sellers (Varro, Aster, Cassia, Severus and Lucilla), one offer owned by the fixture owner Aster (an Iron helmet,
    tier 5 uncommon, 95);
  - all tradable catalog equipment, with stats from the catalog, priced above the NPC sale value;
  - listed 4 minutes to 6 days 22 hours before the fixture time, so every offer is open; the oldest has 2 hours left.

### Carried 18.1 review items

1. **Deadlocks.**
   - **Mapping:** the adapter maps 40P01 and 40001, with a unit test.
   - **Wording:** `docs/operations/migrations.md` (M14 section) drops "as `boundary_start` does". A new **Deadlocks**
     paragraph says the purchase's order "matches `boundary_start`'s order; a residual deadlock aborts atomically and the
     same operation can be retried", and describes the mapping and the test.
   - **Old comment:** the paragraph also records that the comment "a purchase cannot deadlock a boundary" stays in
     `12-market.sql:166` and M14 line 271. Both are unedited, because M14 is immutable and the source must stay at parity.
   - **Test:** it is renamed to *"takes both account locks in gladiator order, which matches boundary_start's order; a
     residual deadlock aborts atomically and the same operation can be retried"*. It now also produces a **real** deadlock
     through the adapter and the Data API:
     1. Session B holds the higher account's lock, with `set local deadlock_timeout='30s'` so that only the purchase runs
        the deadlock check.
     2. The purchase takes the lower lock and waits for the higher one; the test proves the wait through `pg_locks`.
     3. B then asks for the lower lock.
     4. The adapter returns `processing`.
     5. The test checks that nothing moved: no receipt, no sale receipt, wallets unchanged, the listing open and the item
        still reserved.
     6. Sending the same `operationId` again succeeds, and a third send replays the same result.
2. **Sweep against a held lock.** The new test is *"skips a seller whose account lock or listing row is held, without
   waiting, and expires the listing once it is free"*.
   - It uses the operator connection inside `withClock` and makes a listing that is already due.
   - Variant one holds the seller's account advisory lock in one session. Variant two holds only the listing row
     `FOR UPDATE`, to cover the `SKIP LOCKED` path as well.
   - In each variant, `private.expire_listings(private.planning_now_ms())` runs with `lock_timeout='2s'`. It returns 0 in
     under 2 s, and the listing, offer and reservation are unchanged.
   - After both holds are released, the sweep returns 1: the listing is `expired`, the item is returned and the offer is
     deleted.

### Other tests added (beyond the brief's five)

- Unit:
  - `answers a deadlocked or serialization-failed market transaction as retryable processing`;
  - `sends the listing commands to the authenticated command endpoint and keeps their business codes` (live gateway).
- DB: `pages the public offers newest first through the visitor Data API, 50 at a time`.
  - It creates 55 offers from 11 sellers and pages them with `readMarket(anonymous)` against real PostgREST.
  - The concatenated pages equal the SQL order of visible offers, the first page is 50 rows, and the seller filter equals
    SQL.
- **Changed:**
  - `tests/backend/commands.test.ts`: the `cancel-listing` → `unavailable` assertion is gone. The item routing test now also
    guards that item commands never reach `market`.
  - `tests/api/fixture-gateway.test.ts`: `market` is no longer in the "unimplemented" test.
  - `tests/api/live-gateway.test.ts`: it now mocks the browser client (null by default). The old test is renamed to say it
    covers a missing backend; `market()` without a client is still `unavailable`.
  - `tests/backend/edge.deno.ts`: its database stub gains `market`.

## TDD evidence

### RED

**Unit.** `npx vitest run` on the four unit files: 7 failed, 33 passed.

| Test | Failure |
| --- | --- |
| reads: pages open offers… | `TypeError: readMarket is not a function` |
| fixture market | `Cannot find module '/tests/fixtures/market'` |
| live: reads offers without a session | `Error: unavailable` |
| live: listing commands | results were all `unavailable` (the allowlist refused them) |
| backend: routes… | `expected 503 to be 409` (the market kinds were `unavailable`) |
| backend: price above 1,000,000,000 | `1000000001: expected 503 to be 400` |
| backend: deadlock mapping | `TypeError: database.market is not a function` |

**DB.** `npm run test:db -- tests/db/market.test.ts`, with the Edge start time `15:03:13.793699991Z` before and after: 3
failed, 13 passed.

| Test | Failure |
| --- | --- |
| deadlock | `TypeError: database.market is not a function` |
| real Edge | `expected { status: 503, … } to match object { status: 200, … }` |
| DB paging | `TypeError: readMarket is not a function` |

The run also hit an `afterAll` hook timeout. That was a test bug: a synchronous throw before `try` left session B holding
a lock, so `sql.end()` hung. I moved the adapter call inside `try`; every later run was clean.

**The sweep test passed at RED.** It characterizes 18.1 behavior, so I proved its power with SQL mutations instead (below).

### GREEN

- The four unit files: 40/40.
- The market DB file: 16/16, with the Edge start time stable at `15:19:15.070570992Z`.

### Mutation checks (each restored and verified)

| Mutation | Owning test | Result |
| --- | --- | --- |
| Adapter: the 40P01/40001 mapping line removed | the deadlock test (`-t "residual deadlock"`) | FAIL: `Error: market-unavailable`, after ~1.6 s, the deadlock timeout. A real 40P01 from PostgREST went unmapped. |
| SQL: the sweep's `continue when not pg_try_advisory_xact_lock(...)` became a blocking `perform pg_advisory_xact_lock(...)` | the sweep test | FAIL: `canceling statement due to lock timeout` |
| SQL: the sweep's `for update skip locked` became `for update` | the sweep test | FAIL: `canceling statement due to lock timeout` |

**How each was restored:**
- **Adapter mutation:** made on the working file and restored from a saved copy. `cmp` confirmed it identical.
- **SQL mutations:** installed and restored by `scratchpad/t182/sweep-mutation.cjs`. The script discovers the DB URL in
  memory, the way `scripts/test-db.mjs` does, and prints nothing secret.
  - It captured `pg_get_functiondef('private.expire_listings(bigint)')` before the first mutation.
  - It restored the function from that exact text, never through a shell or psql.
  - It reported "restored: byte-identical to the captured definition" after each mutation (AGENTS.md stand-in rule).

## Gate results (in order, after all committed-file edits)

| # | Gate | Result |
| --- | --- | --- |
| 1 | `npm test` | **1002/1002** in 44 files (995 before; 7 new) |
| 2 | `npm run typecheck` | pass: tsc, `deno check` of both functions, Deno runtime smoke 2/2 |
| 2b | `node assets/source/build-assets.mjs --check` (gate guide step 2) | assets up to date (28 files) |
| 3 | `npm run test:db` | **193/193** in 10 files (190 before; 3 new). The Edge start time was unchanged. The known flaky `arena.test.ts:642` did not fail. |
| 4 | `npm run build`, then `npm run verify:static` | build OK (7 static pages); "5 fixed routes; 89 assets scanned; no forbidden backend material; no fixture preview data" |
| 5 | `npx playwright test --config node_modules/.cache/pw-claude.config.mjs` (port 3200) | **394 passed, 22 skipped**, 0 failed or flaky, 10.1 min, 416 cases on 2 workers. The skips are the specs' own per-project skips (desktop-only or phone-only cases). Port 3200 was free afterwards. |
| 6 | `git diff --check` (and `--cached --check` before the commit) | clean |

The build ran only after the browser-free gates. The browser suite started only after the build had finished, and nothing
else ran during it.

## Edge start times (`supabase_edge_runtime_Cloudiator`), all on 2026-10-17

| Run | Before | After | Counted |
| --- | --- | --- | --- |
| RED, market file only (3 failed, 13 passed) | 15:03:13.793699991Z | same | RED evidence |
| Iteration, market file 16/16 | 15:19:15.070570992Z | same | no |
| Adapter mutation, deadlock test only (FAIL as intended) | 15:19:15.070570992Z | recreating just after the restore; back at 15:22:46.153673583Z | mutation evidence |
| Two SQL sweep mutations, sweep test only (FAIL as intended) | not recorded (these runs use only the operator SQL connection) | not recorded | mutation evidence |
| **Full suite, 193/193** | **15:22:46.153673583Z** | **same** | **yes** |

**Recreations.** The recreations at 15:19 and 15:22 coincided with my edits to Edge source: the implementation, and the
adapter mutation's restore. AGENTS.md describes this. No counted run overlapped one. There was one counted DB run, with no
discards.

## Files changed

| File | Change |
| --- | --- |
| `supabase/functions/_shared/backend/commands.ts` | price cap, `MARKET_KINDS`, allowlist, dispatch, `Pick` gains `market` |
| `supabase/functions/_shared/backend/database.ts` | `market` adapter, `prepareListingPurchase`, market types, 40P01/40001 mapping |
| `supabase/functions/_shared/contracts/reads.ts` | `MarketListing.listedAtMs` |
| `src/lib/api/reads.ts` | `parseMarketRead`, `readMarket` |
| `src/lib/api/gateway.ts` | `market(cursor?, seller?)` public read, listing kinds allowed |
| `src/lib/api/fixture-gateway.ts` | fixture `market` |
| `tests/fixtures/market.ts` | new: `MARKET_ROWS`, `marketPages`, `FIXTURE_MARKET` |
| `tests/backend/commands.test.ts` | 3 new tests; routing test updated |
| `tests/backend/edge.deno.ts` | `market` stub |
| `tests/reads.test.ts` | 1 new test |
| `tests/api/live-gateway.test.ts` | client mock; 2 new tests; the no-backend test renamed |
| `tests/api/fixture-gateway.test.ts` | 1 new test; `market` dropped from the "unimplemented" test |
| `tests/db/market.test.ts` | deadlock test renamed and extended; 3 new tests (sweep against held locks, real Edge, real paging) |
| `docs/operations/migrations.md` | M14 section: deadlock wording, Deadlocks paragraph, Release note |

`supabase/sql/12-market.sql` and M14 are unchanged.

## Concerns

1. **Fixture owner's listing.** Aster's fixture offer has no matching reserved item in the owner fixture's inventory, which
   is empty in `ARENA_OWNER`. I left it unchanged because many existing tests pin it. If 18.3 previews "Listed for sale" in
   Inventory, it should add the item with `reservation: {kind:'listing', referenceId: <Aster's listing id>}`.
2. **Mapping scope.** The 40P01/40001 mapping lives in the `market` adapter only, as the brief scoped it. `plan`,
   `inventory` and `setTournamentOptIn` still answer an aborted transaction with `unavailable`. They could adopt
   `RETRYABLE_ABORTS` later.
3. **No character.** A buyer with no character sends `prepared: null`, so SQL answers `invalid` (it validates the
   preparation's shape before its `not-found` check). This follows the `inventory` adapter's `if (data)` precedent. It is
   not reachable from the UI.
4. **Stale page.** A purchase on a stale page sends a no-change preparation (next = baseline) when the offer row is gone,
   so SQL returns `sold`, `expired` or `not-found` (Review Focus 4). If the buyer's inventory changes between the read and
   the transaction, the stale baseline is a stored `conflict`, as `buy-shop` does (18.1's accepted interpretation).
5. **Seller filter.** An empty seller is `unavailable`, while an empty cursor means "first page" (the existing results
   rule). I chose this so that a missing id can never list every seller's offers as "mine".
6. **Deadlock test timing.** The test relies on the Data API session's default 1 s `deadlock_timeout`, with B's raised to
   30 s locally. Postgres accepted `set local deadlock_timeout` from the `postgres` role, as verified. The mutation run
   confirmed that a real 40P01 reaches the adapter.
7. **Old SQL comment.** The overstated comment in `12-market.sql` and M14 remains in the deployed function body. Only a
   later source change and migration can reword it; the migration guide now records it as superseded.
