# Task 18 independent reviews: fixed-price marketplace

Plan: [Task 18 plan](../superpowers/plans/2026-10-17-task-18-marketplace.md). Spec: [game design §9](../superpowers/specs/2026-10-11-gladiator-arena-design.md) and the [full-screen camp](../superpowers/specs/2026-10-14-full-screen-camp-design.md) Menus row. Each checkpoint has a fresh implementer and an independent reviewer; reviewers may run read-only catalog queries against the local stack "Cloudiator".

## 18.1: Atomic listings in the database (M14)

Range `a96c330..b052ea0`: `b052ea0` adds `supabase/sql/12-market.sql`, migration M14 and `tests/db/market.test.ts`. [Implementer report](task-18.1-report.md).

**Implementer evidence:**
- Unit tests 995/995; typecheck clean.
- `test:db` 190/190 on the source, and again on a clean M01–M14 replay, with the Edge start time unchanged.
- The replay fingerprint (956 lines) is identical to the source. Lint is empty; advisors INFO only.
- Two deliberate faults each failed their own test: reading the clock before the locks, and taking the buyer's lock first.

**Verdicts:** spec compliant; quality Approved; no Critical or Important findings.

**What the reviewer confirmed:**
- **Locks and clock:**
  - The purchase reads its seller without a lock, then takes both account locks in `gladiator_id` order.
  - Rows lock in order: gladiators, wallets, items, then the listing.
  - Database time is sampled once, after the locks.
  - Status, expiry, self-purchase, capacity, funds and the seller-credit cap are re-validated under the locks.
- **Atomicity:** one terminal state per listing, enforced by a guard trigger and CHECKs; one item owner; only the fee leaves the money supply (tested).
- **Item transfer:** the two-UPDATE transfer works correctly with the item guards.
- **Receipts:** replay is idempotent and a changed payload gives `conflict`. The seller receipt and the two ledger rows follow Decision 5.
- **Expiry sweep:** it try-locks each seller and uses `SKIP LOCKED`, inside `cron_tick`'s own exception block.
- **Offers:**
  - The projection is sanitized (no item id, owner or reservation).
  - RLS hides expired-but-unswept offers.
  - Visitors get read-only access, with no executes.
  - No world-revision bump (Ruling 2).
- **Processing gate:** the purchase's gate covers buyer and seller (Ruling 1).
- **Migration:** M14's nine function bodies match the source byte for byte, as do its ACLs and policies. The discarded first draft left no history.

**Implementer interpretations accepted:**
- Cancel or buy of a sold or expired listing returns `sold` or `expired`; a cancelled listing returns `not-found`.
- An unknown item gives a recorded `not-found`.
- A seller's wallet may reach the cap exactly.
- The database allows salvage stacks.

**Controller rulings:**
- 18.3's Sell tab offers equipment only.
- 18.3 refreshes the page on `not-found` as well as on `sold` and `expired`.

**Deferred Minors:**
- **Carried to 18.2:**
  - The "cannot deadlock a boundary" claim is too strong, because the boundary does not always take account locks in global order. Map a 40P01 to a retryable `processing` result in the adapter, and reword the claim.
  - Add a test racing the sweep against a held seller lock.
- **For Task 23:** one inconsistent listing would stop every expiry, because the sweep runs in a single exception block.
- **Other:**
  - a `1.0` price raises instead of returning `invalid` (unreachable through Edge);
  - the race tests do not assert that both terminal orders occurred.

## 18.2: Market commands and pages

Range `a4523ae..ae5d0c3`: `ae5d0c3` (feature). [Implementer report](task-18.2-report.md).

**Implementer evidence:**
- Unit tests 1002/1002; typecheck clean.
- `test:db` 193/193 with the Edge start time unchanged.
- Build and `verify:static` clean; development browser suite 394 passed.
- Three mutations proved the new tests: the deadlock mapping, the sweep's try-lock, and `SKIP LOCKED`.

**Verdicts:** spec compliant; quality Approved; no Critical or Important findings.

**What the reviewer confirmed:**
- **Prices:** the price cap (1,000,000,000) is enforced before any RPC.
- **Ids:** they are lowercased, which SQL requires; this is tested end to end through the real Edge runtime.
- **Buy preparation:** it matches `buy-shop`'s historical-strength preparation. A stale or null preparation still reaches SQL, so a committed receipt replays.
- **Error mapping:** 40P01 and 40001 map to a retryable `processing`; `sold`, `expired` and `not-found` pass through. A real deadlock test proves nothing changes and the retry replays.
- **`readMarket`:**
  - newest first, with a `listedAtMs:id` cursor;
  - at most 50 rows per page;
  - an optional seller filter;
  - read publicly without a session;
  - paged through anonymous PostgREST in the DB test.
- **Fixture market:** it has the live shape.
- **Carried items from 18.1:**
  - the deadlock claim is reworded in the guide and the test name only;
  - the sweep is tested against a held seller lock and a locked row.

**Deferred Minors:**
- **Carried to 18.3:**
  - the Marketplace panel keeps the same `operationId` on `processing`;
  - the sample seller's listed item gets its listing reservation in the owner fixture;
  - Buy is hidden for a signed-in account without a gladiator;
  - the fixture expiry comes from the rules.
- **Other:** the deadlock test assumes the second session reaches its lock within the 1 s deadlock check; document that.
