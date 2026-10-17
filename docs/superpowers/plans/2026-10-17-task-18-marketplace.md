# Task 18: Fixed-Price Marketplace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Players list, cancel and buy equipment at fixed prices through atomic database transactions, and anyone (visitors included) can browse open listings from the 💰 Marketplace menu.

**Architecture:**
- **Data.** An authoritative private listings table and a sanitized public offers projection. Visitors can read the offers projection as `anon`.
- **Commands.** Three receipt-backed commands (create, cancel, buy) through the existing `game-command` path, plus an expiry sweep. One purchase transaction moves the item, the buyer's money, the seller's credit and the fee.
- **UI.** A `MarketPanel` in the full-screen shell's 💰 menu.

**Tech Stack:** Next.js 16.4 static export, React 19, Supabase Postgres 17 (CLI 2.120.0), Deno Edge functions, Vitest, Playwright (Chrome channel).

**Spec:** [game design §9, "Economy, NPC shops, and marketplace"](../specs/2026-10-11-gladiator-arena-design.md) (with §13 item 10) and the [full-screen camp spec](../specs/2026-10-14-full-screen-camp-design.md) Menus row "💰 Marketplace — Player: Buy, sell, list, cancel; Visitor: Browse listings only". This plan refines Task 18 of the [24-task plan](2026-10-11-gladiator-arena-implementation.md).

## Global Constraints

- "Fixed-price listings have one seller, item, price, and expiry. Proposed limits: five active listings per account; seven-day expiry; 5% sale fee rounded down. No listing fee; NPC-sale value is shown for comparison."
- "Listings reserve the item, making it unavailable for equipping, NPC sale, or another listing. Equipped or pending-build-reserved items cannot be listed. Owner cancellation or expiry returns the same item. Players cannot purchase their own listing."
- "Purchase transaction locks the listing, buyer/seller state, and item; verifies open status, money, capacity, and tradability; transfers ownership; debits buyer; credits seller minus fee; writes ledger entries and marks sold. Two buyers cannot both succeed. Retrying a successful purchase returns the original receipt. Listing cancellation and purchase races have exactly one terminal result."
- "Renown gear is untradable"; bound items never enter the marketplace.
- Whole prices from 1 to 1,000,000,000. Wallet arithmetic stays below 9,007,199,254,740,991 and is checked in the database.
- Total currency changes only by the explicit fee.
- Public projections are readable by anyone, including visitors; all commands require Google sign-in.
- Marketplace pages load on demand, at most 50 rows per page.
- No package or tool downloads.
- Read `node_modules/next/dist/docs/` before changing Next code.
- Gate order and the database-test rule: `docs/operations/verification-gates.md` and AGENTS.md.
- Generated-migration completion: AGENTS.md.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A purchase racing the seller's cancel or the expiry sweep.** Exactly one terminal state results; the item has one owner; no money is created or lost beyond the fee. Test: 18.1.
- **A listed item used elsewhere.** Equipping it in a queued build, NPC-selling it, discarding it or listing it again must all be refused while it is listed, and must work again once it returns. Test: 18.1.
- **A buyer at 60 items, or a seller whose wallet is near the cap.** Refused with `inventory-full`, or with `invalid` for the seller's overflow, with no partial effect. Test: 18.1.
- **A stale page.** Buying a listing that has since sold, expired or been cancelled returns `sold` or `expired`, never a crash, and the panel refreshes. Test: 18.3.
- **A visitor.** Browses listings with no command sent; buy and sell controls never appear. Test: 18.3.

---

## Decisions (controller, binding)

1. **Names.** SQL source `supabase/sql/12-market.sql`, generated migration M14. The old plan's `08-market.sql` and "M08" names are obsolete.
2. **Price cap.**
   - `RULES_V1.marketplace.maximumPrice` becomes `1_000_000_000`.
   - The command parser and the SQL check both enforce whole prices from 1 to 1,000,000,000.
   - Fee = `price * 5 / 100` in bigint integer division, so prices 1/19/20/101 give fees 0/0/1/5.
   - The seller receives `price − fee`.
3. **Storage.**
   - **`private.market_listings`** (authoritative). Columns: `id uuid`, `seller_gladiator_id`, `item_id`, `price`, `listed_at_ms`, `expires_at_ms`, `status ('open'|'sold'|'cancelled'|'expired')`, `terminal_receipt_id`, `buyer_gladiator_id`. It has no client grants.
   - **`public.market_offers`** (sanitized projection, open listings only). Columns: `id`, `seller_gladiator_id`, `seller_name`, `item` (jsonb: `catalogId`, `catalogVersion`, `tier`, `rarity`, `stats`, `quantity`), `price`, `listed_at_ms`, `expires_at_ms`. A row is inserted on create and deleted on any terminal transition.
   - **Offers RLS:** policy `player_read for select to anon, authenticated using (expires_at_ms > database now ms)`, so an expired listing that has not been swept yet is never shown.
   - **Grants:** revoke all from everyone first; SELECT to `anon` and `authenticated`; DML to `service_role` only.
   - **Revision:** the offers do NOT bump `world_revision`. They load on demand.
4. **Reservation.**
   - Listing sets `item.reservation = {kind: 'listing', referenceId: <listingId>}`.
   - A sale clears the reservation in one UPDATE, then changes `gladiator_id` and `item.ownerId` in a second UPDATE. This is required by `guard_reserved_item`.
   - Cancel and expiry clear the reservation; the item stays with the seller.
5. **Receipts and ledger.**
   - Create, cancel and buy each use the actor's operation receipt. The existing pattern applies: a duplicate key with a changed payload returns `conflict`, and an identical one returns the stored result.
   - A purchase also writes a seller receipt with a generated operation id and `request {kind: 'market-sale', listingId}`, as settlement does.
   - Ledger rows: the buyer gets `reason 'market-purchase'` (`money_delta −price`); the seller gets `reason 'market-sale'` (`money_delta +price−fee`).
   - Create and cancel write no ledger row.
6. **Locks.**
   - **Create and cancel:** the existing single-account order — account advisory lock, gladiator row, wallet, items by id, then the listing row.
   - **Buy:**
     - Read the listing's seller without locking.
     - Take BOTH account advisory locks in `gladiator_id` order (the `boundary_start` precedent); then both gladiator rows in `gladiator_id` order, both wallets, the buyer's items and the listed item by id, and the listing row `FOR UPDATE`.
     - Sample `private.planning_now_ms()` after all locks.
     - Re-validate: status `open`, `now < expires_at_ms`, buyer ≠ seller, buyer capacity < 60, buyer available money ≥ price, and the seller's credit stays below the cap.
   - **Processing gate:** buy returns `processing` if EITHER character's `processed_slot_index` is behind the current slot. Create and cancel gate only on the actor.
7. **Expiry.**
   - `private.expire_listings(now_ms bigint) returns integer` (milliseconds, the codebase's clock convention; this replaces the old plan's `timestamptz` argument) sweeps open listings with `expires_at_ms <= now_ms`, using `FOR UPDATE SKIP LOCKED` and the account lock per seller (skip a seller whose lock is busy). Each listing becomes `expired`, its item reservation is cleared, and its offer row is deleted.
   - It runs from `private.cron_tick()` in its own `begin … exception` block, after coordination.
   - Every create, cancel and buy also expires the acting seller's own due listings first, so the five-listing count and the seller's inventory are never stale.
   - A buy of an expired-but-unswept listing returns `expired`.
8. **Purchase history.**
   - The Edge adapter prepares the buyer's new historical strength with `historicalGearScore` from `owner_state` plus the listing's item, as `buy-shop` does.
   - SQL checks it against the baseline.
   - A stale preparation still reaches SQL first, so a committed receipt replays.
9. **Refusal codes.**

   | Situation | Code |
   | --- | --- |
   | Bad shape; price out of range; self-purchase; bound, renown or reserved item; more than five active listings; seller credit overflow | `invalid` |
   | Buyer cannot afford the price | `insufficient-funds` |
   | Buyer has no inventory slot | `inventory-full` |
   | Listing already bought | `sold` |
   | Listing past its expiry | `expired` |
   | Cancel or buy of an unknown or not-open listing, or a cancel by someone else | `not-found` |

10. **Reads.**
    - `GameGateway.market(cursor?: string, seller?: GladiatorId): Promise<MarketPage>`.
    - Sorted by `listed_at_ms desc, id`; cursor `listedAtMs:id`; pages of at most 50; a malformed cursor gives `unavailable`; with `seller`, only that seller's open listings.
    - `MarketListing` keeps its shape and gains `listedAtMs`.
11. **UI.**
    - The 💰 Marketplace menu (`id 'market'`, `visitor: true`) sits between Inventory and shops, and Arena.
    - `MarketPanel` has the tabs **Browse**, **My listings** and **Sell**. Visitors see Browse only, with "Sign in with Google to trade".
    - Each offer shows the item name, tier, rarity, stats, seller, price, the NPC-sale value for comparison (from the catalog), and time left.
    - Inventory shows a listed item as "Listed for sale".

## Execution

- Branch `claude/task-18` in `C:\Avi\Studies\Projects\Cloudiator-claude`, from `925d125`.
- One reviewed checkpoint per task: a fresh implementer, an independent spec and quality reviewer (plus visual review for 18.3), a review record, then a push.

---

### Task 18.1: Atomic listings in the database (M14)

**Files:**
- Create: `supabase/sql/12-market.sql`, `tests/db/market.test.ts`
- Generate: `supabase/migrations/<timestamp>_market.sql` (M14)
- Modify:
  - `tests/db/visitor-access.test.ts` (add `market_offers` to `OPEN`)
  - `supabase/functions/_shared/domain/rules-v1.ts:22` (`maximumPrice: 1_000_000_000`)
  - `docs/operations/migrations.md` (M14 section)

**Interfaces:**
- Produces:
  - **Commands:** `public.create_listing(actor_id uuid, operation_id uuid, input jsonb) returns jsonb`, and `cancel_listing` and `buy_listing` with the same signature. `input = {command, prepared}`.
    - Security invoker, `search_path=''`.
    - EXECUTE for `service_role` only.
  - **Success results:**
    - create: `{ok: true, receiptId, value: {listingId, expiresAtMs}}`
    - cancel: `{ok: true, receiptId, value: {listingId, itemId}}`
    - buy: `{ok: true, receiptId, value: {listingId, itemId, price, fee}}`
  - **Sweep:** `private.expire_listings(now_ms bigint) returns integer`, granted to nobody, called from `private.cron_tick()`.
  - **Tables:** `private.market_listings` and `public.market_offers`, per Decision 3.
  - **Prepared buy:** `prepared` = `{baselinePeakStrength: number, nextPeakStrength: number}`.

- [ ] **Step 1: Write the failing tests** in `tests/db/market.test.ts`. Use helpers in the style of `fighter()`, `send` through `handleCommand` or direct RPC calls, and `toHaveCode` from `tests/db/shops.test.ts`.

```ts
test('lets exactly one of two buyers and a cancel reach a terminal state', ...)
// raceTwoBuyersAndCancel({ price: 101 }): one terminal transition, one item owner,
// total money change = -fee (5) when sold and 0 when cancelled
test('replays a successful purchase without new debits or items, and rejects a changed payload', ...)
test('floors the 5% fee: prices 1, 19, 20, 101 pay 0, 0, 1, 5', ...)
test('refuses self-purchase, bound and renown items, equipped and pending-build items, and a sixth active listing', ...)
test('blocks equip, NPC sale, discard and relisting while listed, and allows them after cancel or expiry', ...)
test('lets exactly one of a concurrent listing and a build reservation or NPC sale of the same item succeed', ...)   // list-versus-equip / list-versus-sale races
test('refuses a buyer at 60 items with inventory-full and a short buyer with insufficient-funds, with no partial effect', ...)
test('refuses a seller credit that would pass the wallet cap', ...)
test('expires due listings once, returns the item, and buy after expiry returns expired', ...)
test('takes both account locks in gladiator order so a purchase cannot deadlock a boundary', ...)   // pg_blocking_pids interleaving
test('returns processing while either character is behind the current slot', ...)
test('raises the buyer historical strength from the baseline-checked preparation', ...)
test('denies clients the private listings table and every market function, and serves open offers to visitors read-only', ...)
// market_offers: anon + authenticated SELECT only; an expired-but-unswept offer is hidden by RLS
```

- [ ] **Step 2: Run** `npm run test:db -- tests/db/market.test.ts`, under the Edge start-time rule. Expected: FAIL; `create_listing` does not exist.
- [ ] **Step 3: Implement `supabase/sql/12-market.sql`.**
  - It must be reapplicable, and its header documents the lock order (Decision 6), the two-UPDATE transfer, and that offers do not bump the revision.
  - Hook `expire_listings` into `cron_tick`.
  - Iterate with the tested local `psql` fallback.
- [ ] **Step 4: Run** `npm run test:db` (all suites). Expected: PASS, with the Edge start time unchanged.
- [ ] **Step 5: Generate and complete M14.** Run `db pull market`, then complete the draft per AGENTS.md, including:
  - revokes before grants;
  - function ACLs;
  - the `cron_tick` replacement and any cron registration.

  Then:
  - clean replay with `db reset --local --no-seed --yes`;
  - parity fingerprint;
  - `npm run test:db`;
  - lint empty, and advisors INFO only.
- [ ] **Step 6: Commit** `feat: trade equipment through atomic listings`. Include the source, M14, the tests, the rules change and `migrations.md`.

### Task 18.2: Market commands and reads

**Files:**
- Modify:
  - `supabase/functions/_shared/backend/commands.ts:12,43-44,50-51,78` (price cap, `MARKET_KINDS`, dispatch)
  - `supabase/functions/_shared/backend/database.ts` (a `market(command)` adapter with buy preparation)
  - `src/lib/api/gateway.ts:23,100,136` (`market` read, command allowlist)
  - `src/lib/api/reads.ts` (`readMarket`)
  - `supabase/functions/_shared/contracts/reads.ts:47-52` (`listedAtMs`)
  - `src/lib/api/fixture-gateway.ts:64` (fixture market)
- Create: `tests/fixtures/market.ts`
- Test:
  - `tests/backend/commands.test.ts` (`cancel-listing` no longer `unavailable`)
  - `tests/api/live-gateway.test.ts`, `tests/api/fixture-gateway.test.ts`, `tests/reads.test.ts`
  - `tests/db/market.test.ts` (one real-Edge case through `directEdge`)

**Interfaces:**
- Consumes: 18.1's RPCs and `market_offers`.
- Produces:
  - `readMarket(client, cursor?: string, seller?: string): Promise<MarketPage>`;
  - `GameGateway.market(cursor?, seller?)` as a public read (no session required);
  - the three listing kinds accepted by the Edge function and the browser gateway;
  - `FIXTURE_MARKET: MarketPage[]`, with at least six offers across tiers, rarities and sellers, one owned by the fixture owner (Aster).

- [ ] **Step 1: Write the failing tests:**

```ts
test('routes create, cancel and buy listing commands to their RPCs with the buyer preparation', ...)   // backend
test('refuses a price above 1,000,000,000 before any RPC', ...)
test('pages open offers newest first, 50 at a time, and filters by seller', ...)          // reads + fixture
test('reads offers without a session', ...)                                            // live gateway
test('buys a listing through the real authenticated Edge runtime', ...)                 // DB, directEdge
```

- [ ] **Step 2: Run** the named files. Expected: FAIL; the market read and the commands are unavailable.
- [ ] **Step 3: Implement** the adapter, the parser cap, the dispatch, the reads, the gateway and the fixture.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run test:db`, then `npm run build` and `npm run verify:static`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: serve marketplace commands and pages`.

### Task 18.3: The Marketplace menu

**Files:**
- Create: `src/features/market/MarketPanel.tsx` and `src/features/market/market-text.ts`, `tests/domain/market-panel.test.ts`, `tests/browser/market.spec.ts`
- Modify:
  - `src/features/shell/menus.ts` (add `{ id: 'market', icon: '💰', label: 'Marketplace', visitor: true }` between Inventory and shops, and Arena; update the header comment)
  - `src/features/shell/CampShell.tsx` (the menu content)
  - `src/features/inventory/InventoryPanel.tsx:46-51,71` ("Listed for sale"; copy for `sold`/`expired`)
  - `tests/domain/menus.test.ts`, `tests/browser/visitor.spec.ts` (`PUBLIC_MENUS` gains Marketplace)
  - `tests/browser/live-routes.ts` (a `market_offers` table)

**Interfaces:**
- Consumes: `gateway.market`, `gateway.command`, `useGameState`.
- Produces:
  - `MarketPanel({ reads: Pick<GameGateway, 'market'>, gateway: GameGateway | null, owner: OwnerState | null, viewer: Viewer, clock: DisplayClock, refreshOwner(): Promise<void>, fixture: boolean })`.
  - `marketFee(price: number): number`, `sellerReceives(price: number): number`, `timeLeft(expiresAtMs, nowMs): string`.

- [ ] **Step 1: Write the failing tests:**

```ts
// tests/domain/market-panel.test.ts
expect([1, 19, 20, 101].map(marketFee)).toEqual([0, 0, 1, 5]);
expect(sellerReceives(101)).toBe(96);
// tests/browser/market.spec.ts
test('lets a visitor browse listings with no command and no buy or sell controls', ...)   // live routes, signed out
test('buys a listing, shows the receipt and the item in inventory', ...)                    // signed in
test('lists an eligible item with the fee and NPC value shown, then cancels it', ...)
test('explains sold and expired results and refreshes the page', ...)                       // Review Focus 4
test('keeps a failed purchase input for a retry with the same operation', ...)
test('fits the Marketplace sheet at 360 px with no horizontal scroll', ...)
```

- [ ] **Step 2: Run** the named files. Expected: FAIL; there is no Marketplace menu.
- [ ] **Step 3: Implement** `MarketPanel` (Browse, My listings, Sell; confirm before buying; the same `operationId` on a retry), the menu entry, and the Inventory copy.
- [ ] **Step 4: Run** the full gate in the order of `verification-gates.md`: the development browser suite, then the isolated production gate with the repo's `playwright.config.ts`. Save screenshots (`market-` prefix) for the visual review. Expected: PASS.
- [ ] **Step 5: Commit** `feat: trade equipment through an atomic marketplace`. Then commit `docs: report Task 18` separately, with `docs/implementation/task-18-report.md`.
