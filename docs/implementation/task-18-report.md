# Task 18 report: fixed-price marketplace

- **Plan:** [Task 18 plan](../superpowers/plans/2026-10-17-task-18-marketplace.md). **Spec:** [game design §9](../superpowers/specs/2026-10-11-gladiator-arena-design.md) and the [full-screen camp](../superpowers/specs/2026-10-14-full-screen-camp-design.md) Menus row "💰 Marketplace — Player: Buy, sell, list, cancel; Visitor: Browse listings only".
- **Branch:** `claude/task-18` in `C:\Avi\Studies\Projects\Cloudiator-claude`, from `925d125`.
- **Checkpoints:** three, each with a fresh implementer and an independent review. Reviews: [task-18-review.md](task-18-review.md).

| Checkpoint | Commits | Report |
| --- | --- | --- |
| Plan | `a96c330 docs: plan Task 18 as three reviewed marketplace checkpoints` | — |
| 18.1 Atomic listings in the database (M14) | `b052ea0 feat: trade equipment through atomic listings`; records `a4523ae` | [task-18.1-report.md](task-18.1-report.md) |
| 18.2 Market commands and reads | `ae5d0c3 feat: serve marketplace commands and pages`; records `60f3a68` | [task-18.2-report.md](task-18.2-report.md) |
| 18.3 The Marketplace menu | `32e73cf feat: trade equipment through an atomic marketplace`; this report | this file, "18.3" below |

## What each checkpoint delivered

### 18.1: atomic listings in the database (M14)

- **Source and migration:** `supabase/sql/12-market.sql` and M14 `supabase/migrations/20261017144347_market.sql`.
- **`private.market_listings`** is authoritative: one seller, item, whole price (1 to 1,000,000,000), listed and expiry
  times, and a status (`open`, `sold`, `cancelled`, `expired`). CHECKs and a guard trigger give each listing exactly one
  terminal state. No client grants.
- **`public.market_offers`** is the sanitized projection of open listings (no item id, owner, origin or reservation).
  Visitors read it as `anon`; RLS hides an offer from its expiry time on, swept or not. Offers never bump the world revision.
- **Commands:** `create_listing`, `cancel_listing` and `buy_listing`, receipt-backed, service-role only.
  - Listing reserves the item (`{kind: 'listing', referenceId}`); cancel and expiry return the same item.
  - A purchase takes both account locks in gladiator order, then both gladiators, wallets, items and the listing row,
    samples database time once after every lock, and re-validates status, expiry, self-purchase, capacity, funds and the
    seller's credit cap. It moves the item in two UPDATEs, debits the buyer, credits the seller minus the 5% fee, writes a
    seller receipt and two ledger rows (`market-purchase`, `market-sale`).
  - Every command first expires its seller's own due listings.
- **Expiry sweep:** `private.expire_listings(now_ms)` from `cron_tick`, try-locking each seller and using `SKIP LOCKED`.
- **Rules:** `RULES_V1.marketplace.maximumPrice` became 1,000,000,000.

### 18.2: market commands and reads

- **Edge:** `create-listing`, `cancel-listing` and `buy-listing` join the command allowlist; the parser refuses prices
  outside 1 to 1,000,000,000 before any RPC. The `market` adapter lowercases ids, prepares a purchase's historical gear
  strength (Decision 8), and maps a deadlock or serialization failure (40P01, 40001) to a retryable `processing`.
- **Reads:** `GameGateway.market(cursor?, seller?)`, a public read without a session: newest listing first, cursor
  `listedAtMs:listingId`, at most 50 rows, an optional seller filter; a malformed cursor or seller is `unavailable`.
  `MarketListing` gained `listedAtMs`.
- **Fixtures:** `tests/fixtures/market.ts` (`MARKET_ROWS`, `marketPages`, `FIXTURE_MARKET`), served by the fixture gateway.
- **Carried from 18.1:** the deadlock claim reworded (guide and test name; the SQL comment stays in immutable M14) and a
  real-deadlock test; the sweep tested against a held seller lock and a locked row.

### 18.3: the Marketplace menu

- **Menu:** `{ id: 'market', icon: '💰', label: 'Marketplace', visitor: true }` between Inventory and shops, and Arena.
  A player has eight menus; every other viewer the six public ones.
- **`MarketPanel`** (`src/features/market/`), in the shell's menu content:
  - **Browse:** open offers, newest first, 50 at a time with More, and Refresh. Each row shows the item, tier, rarity and
    stats, the seller, the time left, the price and the NPC sale value. A player's own offer says "Your listing" and has no
    Buy. Buy opens a "Confirm purchase" dialog; the receipt names the item, the price and a short receipt id.
  - **My listings:** the seller-filtered read, each with Cancel and what the sale would pay after the fee.
  - **Sell:** equipment only (tradable, not renown, bound, equipped, held by a pending build or reserved), a whole price,
    and the NPC sale value, the 5% fee and the credit shown before listing; at most five active listings.
  - **Visitors:** Browse only, "Browsing only. Sign in to buy or sell." and a "Sign in with Google to trade" button; no
    wallet, no tab and no trading control. **Signed in without a gladiator:** Browse only, with "Create your gladiator to trade".
    The shell gives the panel the command gateway for a player only.
  - **Retries:** an identical retry keeps its operation id after `processing`, `unavailable` or `rate-limited` (or a lost
    response); any other answer ends that operation. `sold`, `expired` and `not-found` are explained and the page and the
    owner are read again.
- **Inventory:** a listed item says "Listed for sale"; `sold` and `expired` have words instead of a raw code.
- **Fixtures:** the fixture owner (`ARENA_OWNER`) holds the Iron helmet that Aster's fixture offer sells, reserved by that
  listing (`ASTER_LISTED_ITEM`); the fixture market's listing time comes from `RULES_V1.marketplace.expiryMs`.
- **Live test transport:** `tests/browser/live-routes.ts` serves `market_offers` (with the expiry RLS) and `setMarket`.
- **Tests:** `tests/domain/market-panel.test.ts` (fees, time left, listable items, refusal words, the three viewers'
  panels, offer rows) and `tests/browser/market.spec.ts` (visitor, no gladiator, buy with receipt, list and cancel, stale
  page, retries, 360 px). The menu pins (`menus.test.ts`, `PUBLIC_MENUS` in `visitor.spec.ts`, the Tab order in
  `full-screen.spec.ts`) gain Marketplace; Inventory's fixture test now expects the listed helmet.

## Decisions and rulings

- **Plan decisions (binding):** names `12-market.sql`/M14 (1); prices 1 to 1,000,000,000, fee `price * 5 / 100` (2);
  storage, offer RLS and grants, no revision bump (3); listing reservation and two-UPDATE transfer (4); receipts and ledger
  (5); lock order and the buyer-and-seller processing gate (6); expiry in milliseconds, swept and expired on each command
  (7); purchase history preparation (8); refusal codes (9); reads (10); the menu (11).
- **Controller rulings:**
  - The purchase's processing gate covers buyer and seller; offers do not bump the revision.
  - The Sell tab offers equipment only, though the database allows a salvage stack.
  - The panel refreshes on `not-found` as well as on `sold` and `expired` (a cancelled listing returns `not-found`).
  - 18.3 keeps the same operation id on `processing`, so a retry after a rolled-back deadlock replays it.
- **Accepted interpretations:** cancel or buy of a sold or expired listing returns `sold` or `expired`; an unknown item gives
  a recorded `not-found`; a seller's wallet may reach the cap exactly; an empty seller filter is `unavailable`.

## Measurements

| Checkpoint | Unit | Database (`test:db`) | Development browser suite | Other |
| --- | --- | --- | --- | --- |
| 18.1 | 995 | 190 on the source and on a clean M01–M14 replay | — | replay fingerprint 956 lines, byte-identical; lint empty; advisors INFO only |
| 18.2 | 1002 | 193 | 394 passed, 22 skipped | build and `verify:static` clean |
| 18.3 | 1015 in 45 files | 193 (Edge start time unchanged, 2026-10-18 08:44:27Z) | 410 passed, 22 skipped (432 cases) | build and `verify:static` clean; isolated production gate 16 passed, 416 skipped (static-only cases) |

- **Mutation checks:** 18.1 (clock sampled before the locks; buyer-first account locks), 18.2 (the 40P01/40001 mapping; the
  sweep's try-lock; `SKIP LOCKED`), 18.3 (Buy shown to every viewer; a new operation id on every retry; Inventory without the
  `sold`/`expired` words). Each made its owning test fail, and each was restored.
- **Edge start times:** every counted `test:db` run had an unchanged start time; 18.1 discarded one run during a recreation.

## Deferred items

- **Task 23:** the expiry sweep runs in one exception block, so one inconsistent listing would stop every expiry; move to a
  per-seller subtransaction with a recorded error.
- **SQL (unreachable through Edge):** a price of `1.0` raises instead of returning `invalid`.
- **Tests:** the 18.1 race tests do not assert that both terminal orders occurred; the 18.2 deadlock test assumes the second
  session reaches its lock within the 1 s `deadlock_timeout` (document it; it needs a superuser-settable timeout).
- **Edge:** only the `market` adapter maps 40P01/40001 to `processing`; `plan`, `inventory` and `setTournamentOptIn` still
  answer an aborted transaction with `unavailable`.
- **SQL comment:** "a purchase cannot deadlock a boundary" stays in `12-market.sql` and M14; the migration guide marks it
  superseded. A later source change and migration can reword it.
- **UI:** the Sell tab counts active listings from the owner's listing-reserved items, so a listing past its expiry but
  not yet swept still counts (and can disable List for sale at five) until the sweep or the seller's next command expires it.
  "Create your gladiator to trade" is a line of text, not a button (the corner chip and My gladiator offer creation).
  Offers are read again each time the menu opens or a tab is shown, with no cache; Task 23 measures visitor reads.
- **Skill-upkeep proposal from 18.1 (not in AGENTS.md as of this report):** add "table creation order for foreign keys
  between new tables, across `public` and `private`" to the generated-migration compare list (see the 18.1 report).
