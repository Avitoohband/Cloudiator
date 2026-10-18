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

## 18.3: The Marketplace menu

Range `60f3a68..78104fd`: `32e73cf` (feature) and `78104fd` ([Task 18 report](task-18-report.md)). [Implementer report](task-18.3-report.md).

**Implementer evidence:**
- Unit tests 1015/1015; typecheck clean.
- `test:db` 193/193 with the Edge start time unchanged.
- Build and `verify:static` clean.
- Development browser suite 410 passed, 22 skipped, 0 failed; production gate (repo config) 16 passed.
- Three mutations proved the new tests: Buy shown to every viewer, a new operation id on retry, and the old Inventory wording.

**Verdicts (spec, quality and visual):** spec compliant; quality Approved; no Critical or Important findings; visually faithful to the mockup's Marketplace panel.

**What the reviewer confirmed:**
- **Menu and listings.** The 💰 Marketplace menu sits between Inventory and shops and Arena. Offers show name, tier, rarity, stats, seller, price, NPC sale value and time left.
- **Sell eligibility.** The Sell tab offers equipment only, and its eligibility is at least as strict as every SQL refusal.
- **Closed listings.** `sold`, `expired` and `not-found` explain themselves and refresh the page and the owner.
- **Retries.** The same `operationId` is kept on `processing`, `rate-limited` and `unavailable`.
- **Fixtures.** The fixture owner's listed helmet matches the market fixture, and the fixture expiry comes from the rules.
- **Who can trade.** Visitors and gladiator-less viewers see Browse only and never receive the command gateway; both cases are mutation-proven. Review Focus 4 and 5 are tested.

**Deferred Minors:**
- **Focus and copy:**
  - focus falls to `body` after a trade;
  - create-listing `not-found` uses the "no longer open" wording;
  - "Create your gladiator to trade" is text, not a button.
- **Test coverage:**
  - disabled Buy (money or inventory full);
  - disabled List at five listings;
  - fractional and over-cap prices;
  - a fixture-mode Marketplace spec.
- **Consistency:**
  - "2,000" in the market versus "2000" in the chip and Inventory;
  - rarity capitalization differs.
- **Accessibility polish:** price validation and the blocked-Buy reason are not linked to their controls.
- **Code size:** `MarketPanel.tsx` (366 lines) and its 407-line CSS module could be split.
- **Visual:** the visitor's sign-in prompt sits below the whole list, off-screen with several offers.

## Final whole-branch review and fix wave

Range `925d125..78104fd` (7 commits). **Verdict: ready to merge with one fix.** No Critical findings.

**What it confirmed across checkpoints:**
- **Money:** every layer agrees on whole prices from 1 to 1,000,000,000 and on the floored 5 % fee. Only the fee leaves the money supply, and held fees are excluded from spendable money.
- **Concurrency:**
  - the purchase takes both account locks in gladiator order and samples the clock after its locks;
  - the sweep never waits;
  - no other writer of items or reservations can disturb an open listing;
  - a deadlock is retried with the same operation id.
- **Privacy:** offers carry no private item, owner or reservation data; the visitor-access set is pinned.
- **Read volume:** market reads happen on demand only.
- **Production export:** no fixture market ships.
- **Migration:** M14 matches the source.

**Important finding I1:** the Marketplace panel decided from a stale owner after the player's own listings sold or expired. Sales do not bump the world revision (Ruling 2), so a seller could be wrongly blocked from listing or buying.

**Controller ruling:** one final fix wave (`248debe`, [report](task-18-final-fix-report.md)) landed I1 and four small Minors in the same area:
- the owner is read when the panel opens and on Refresh;
- create-specific `not-found` copy;
- the fee derived from `RULES_V1.fees.marketRate`, plus a note that SQL's market literals need a new migration when the rules change;
- corrected comment citations;
- non-equipment offers show their quantity, the correct NPC value and a neutral glyph.

**Scoped re-review:** all five ADDRESSED, no new breakage.

**Fix-wave evidence:**
- unit tests 1020/1020;
- development browser suite 412 passed, 22 skipped;
- production gate 16 passed.

**Carried to later tasks:**
- **Task 22:**
  - the expiry sweep runs in one exception block and leaves no durable error record; move to one subtransaction per seller with a stored error;
  - terminal listings are never pruned.
- **Task 23:**
  - accessibility: focus after a trade, controls not linked to their validation and reasons;
  - coverage gaps: disabled Buy and List states, fractional and over-cap prices, a fixture-mode Marketplace spec, My listings' Refresh;
  - the deadlock test needs a superuser-settable `deadlock_timeout` in CI.
- **Polish:**
  - money format ("2,000" versus "2000") and rarity capitalization should be decided app-wide;
  - "Create your gladiator to trade" should become a button;
  - `MarketPanel.tsx` and its CSS module could be split;
  - Inventory has unreachable `sold`/`expired` copy;
  - the visitor sign-in prompt sits below the list;
  - a salvage offer shows "Level 1 · Common · Weight 0".
- **Recorded:**
  - Inventory opened on its own can show a sold item as "Listed for sale" until the next owner read (Ruling 2);
  - the purchase's stale check covers peak strength only, which heals at the next acquisition;
  - a lost response followed by closing the menu shows "already sold" for the buyer's own purchase, as Inventory does.

## Appendix: every controller ruling (from the execution ledger)

Each line gives what was decided, why, and what it costs if wrong. They are copied verbatim from the ledger before its deletion.

- Ruling 1: the purchase's processing gate covers both buyer and seller (Decision 6) — the seller's wallet and items change too, and the boundary must not interleave with an unprocessed seller — cost if wrong: buys retry for up to a boundary's duration when the seller lags.
- Ruling 2: market_offers do not bump world_revision (Decision 3) — a bump reloads every client's whole world; offers load on demand per spec §10.5 — cost if wrong: a seller's wallet updates only on the next owner re-read.
- Ruling: 18.3's Sell tab offers equipment only (no salvage stacks), though the database allows listing a stack — the plan goal and spec talk about trading equipment, and salvage has a fixed NPC value — cost if wrong: one filter to drop later.
- Ruling: 18.3 refreshes the page on not-found too (a cancelled listing returns not-found per Decision 9, while Review Focus 4 said sold/expired) — cost if wrong: none.
- Ruling: the Task 18 final fix wave lands I1 plus four small Minors in the same area: create-listing not-found copy; fee rate from RULES_V1.fees.marketRate; fix the comments citing a nonexistent 'Ruling 3'; show quantity and the correct NPC value (salvage per unit) for non-equipment offers in Browse — cost if wrong: one fix wave.
