# Task 18.3 report: the Marketplace menu

- **Status:** DONE_WITH_CONCERNS. Every gate passed in its counted run. The concerns are interpretation choices, two tests written after the code (their power proved by mutation), and test-only fixes made between browser runs.
- **Branch and base:** branch `claude/task-18` in `C:\Avi\Studies\Projects\Cloudiator-claude`, base `60f3a68`.
- **Commits (not pushed):** `32e73cf feat: trade equipment through an atomic marketplace`, then `78104fd docs: report Task 18` (`docs/implementation/task-18-report.md`). HANDOFF is not edited.

## What I implemented

### The menu and the shell
- `src/features/shell/menus.ts`: `{ id: 'market', icon: '💰', label: 'Marketplace', visitor: true }` between Inventory and
  shops, and Arena; `MenuId` gains `market`; the header and `menusFor` comment say eight and six.
- `src/features/shell/CampShell.tsx`: the `market` case renders `MarketPanel` with `reads` (the fixture or live gateway),
  `gateway` only when the viewer is a player (null otherwise), the owner, viewer, shared display clock, `refreshOwner` and
  `fixture`. It is keyed by the owner id or viewer, so an account change starts it afresh. Before the fixture gateway loads,
  it shows the same loading or failure line as Results.

### `src/features/market/market-text.ts`
- `marketFee(price)` = `Math.floor(price * 5 / 100)` (1/19/20/101 → 0/0/1/5; exact for every price up to 1,000,000,000);
  `sellerReceives(price)`; `validPrice`; `MAXIMUM_PRICE` and `MAXIMUM_LISTINGS` from `RULES_V1`.
- `timeLeft(expiresAtMs, nowMs)`: the two largest whole units, never rounded up ("6 d 22 h left", "2 h 30 min left",
  "45 min left", "Under a minute left", "Expired").
- Item words: `itemName`, `itemGrade` ("Level 5 · Uncommon"), `itemStats` (non-zero damage and armor, and weight),
  `itemIcon`, `npcValue`/`npcValueText` (the catalog's NPC sale value for the exact variant).
- `listableItems(owner)`: equipment only (Ruling 1): catalog equipment of this catalog version, tradable, not renown,
  quantity 1, no reservation, and not in the current build's equipment, the pending build's equipment or its reserved ids.
- `activeListings(owner)`, `STALE_CODES`, `RETRY_CODES`, and `marketErrorText(code, kind)` for every `ApiErrorCode`.

### `src/features/market/MarketPanel.tsx` (+ `MarketPanel.module.css`)
- **Player:** a wallet line ("Available money: 2,000", inventory slots) and a tablist **Browse / My listings / Sell**
  (`role=tablist`, roving tabindex, ArrowLeft/ArrowRight/Home/End).
- **Browse** (`OfferList` → pure `MarketOffers`): `readOffers` reads 50 at a time (More appends, de-duplicated; a stale
  generation is dropped), with Refresh and a failure state. Each row: icon, item name, "seller · time left",
  "grade · stats", "NPC sale value", and the price (💰 450, "money" for screen readers). Buy is on others' offers only
  (own: "Your listing"), disabled when expired, too dear for the available money, or with a full inventory. Buy opens a
  modal "Confirm purchase" dialog ("Buy Spear (Level 10 · Rare) from Varro for 450 money?", "Keep browsing" focused first).
- **My listings:** the seller-filtered read (`market(undefined, ownerId)`), each with Cancel and "You receive N money
  after the 5% fee".
- **Sell:** "Active listings: N of 5", the fee/expiry terms, the listable items as radio choices, "Price in money" (whole
  1 to 1,000,000,000, with a hint and a validation line), then the NPC sale value, "Sale fee (5%)" and "You receive" for the
  chosen item and price; List for sale is disabled without an item, a valid price, or at five listings.
- **Visitor:** Browse only, "Browsing only. Sign in to buy or sell." above and a "Sign in with Google to trade" button (the
  existing Google flow, disabled in the fixture preview) below; no tab, Buy, Cancel, Sell or wallet.
- **No gladiator:** Browse only with "Create your gladiator to trade."; no trading control, no prompt to sign in.
- **Commands** (`create-listing`, `cancel-listing`, `buy-listing`) follow InventoryPanel: an identical retry reuses the kept
  operation id while the last answer was `processing`, `unavailable` or `rate-limited` (or the response was lost); any other
  answer drops it (the 18.2 review's item carried to 18.3). Success: a receipt line ("Purchase confirmed: Spear for 450 money, now in your inventory.
  Receipt 1a2b3c4d."), then the page re-reads and `refreshOwner` runs (a failed owner read does not hide the receipt).
  A final refusal: the words for its code, and the same re-read; `sold`, `expired` and `not-found` say the listings were
  refreshed (Ruling 2). The fixture preview browses and says actions are unavailable.
- **Layout:** no motion of its own (the global reduced-motion rule covers the shell); text wraps inside its column; the
  price column never shrinks; the dialog is `min(400px, 100vw − 32px)`.

### Inventory
- `InventoryPanel.tsx`: a listing-reserved item says "Listed for sale" (other reservations unchanged); `sold` and `expired`
  have words and refresh the inventory.

### Fixtures and test transport (Ruling 4)
- `tests/fixtures/market.ts`: `LISTING_MS = RULES_V1.marketplace.expiryMs`; new `ASTER_LISTED_ITEM`, the tier 5 uncommon
  Iron helmet with `reservation: {kind: 'listing', referenceId: fixtureUuid('market-listing-aster-helmet')}` (Aster's offer id).
- `tests/fixtures/arena-build.ts`: `ARENA_OWNER.inventory = [ASTER_LISTED_ITEM]` (the fixture gateway's owner).
  `ownerFixture`, which the live specs use, is unchanged.
- `tests/browser/live-routes.ts`: a `market_offers` table (open offers only, RLS by expiry), `LiveData.market` and
  `setMarket`.

## TDD evidence

### RED
**Unit, before any implementation.** `npx vitest run tests/domain/market-panel.test.ts tests/domain/menus.test.ts tests/api/fixture-gateway.test.ts`: 3 failed, 16 passed, and the new file failed to load.

| Test | Failure |
| --- | --- |
| `market-panel.test.ts` (whole file) | `Cannot find package '@/features/market/market-text'` |
| menus: eight menus in rail order | `expected [ … ](7) to deeply equal [ … ](8)` (no Marketplace) |
| menus: six visitor menus | `visitor: expected [ 'My gladiator', 'Arena', …(3) ] to deeply equal [ 'My gladiator', 'Marketplace', …(4) ]` |
| fixture market (owner consistency added) | `expected [] to deeply equal [ Array(1) ]`: the owner's inventory held no listing-reserved item |

**Browser, before any implementation.** `npx playwright test --config node_modules/.cache/pw-claude.config.mjs market.spec.ts --project=desktop`: all 6 cases failed, each with `locator.click: Test timeout of 90000ms exceeded` waiting for `getByRole('navigation', { name: 'Game menus' }).getByRole('button', { name: 'Marketplace', exact: true })`: there was no Marketplace menu.

**Written after the code (not a pre-implementation RED):** the browser case *"shows a signed-in account without a gladiator Browse only, with no trading control"* and the Inventory case *"explains Marketplace outcomes for an item in words, with nothing to retry"*. Their power is proved by the mutations below. The `PUBLIC_MENUS`, Inventory fixture (`1 / 60 slots`, "Listed for sale") and full-screen Tab-order pins were updated with the feature; the menus unit RED above covers the list itself.

### GREEN
- **Unit:** the three files 32/32 after implementation (13 in `market-panel.test.ts`); the full suite 1015/1015.
- **Browser, iterating (not counted):**
  1. Desktop `market.spec.ts`: 4/6. Two test bugs: a `/ left$/` regex anchored at the row's end (the row continues with the NPC value and price), and the stale-page case closed all three listings before the first purchase, so the first refresh had already removed the other two rows. Fixed: a time-left pattern, and each listing is closed just before its own purchase.
  2. Both projects: 12/14; the visitor case expected `1250 money` where the panel shows `1,250 money` (thousands separators). The spec now formats prices with `toLocaleString('en-US')`.
  3. `market.spec.ts`, `inventory.spec.ts` and `visitor.spec.ts` on both projects: 37 passed, 3 skipped (the specs' own per-project skips).
  4. After the visual pass (rows reordered to the mockup's "seller · time left"; price shown as `💰 450` with "money" for screen readers; non-zero stats only): 14/14.
  5. The 360 px case, after the measuring fix below: `--repeat-each=3` on both projects, 42/42.

### Mutation checks (each restored and verified with `cmp`)
Each was applied to the working file, run on desktop, then restored from a saved copy; `cmp` confirmed byte equality.

| Mutation | Owning test(s) | Result |
| --- | --- | --- |
| `action={trader ? 'buy' : null}` → `action={'buy'}` (Buy for every viewer) | visitor case; no-gladiator case | both FAIL: `expect(locator).toHaveCount(expected)` Expected 0, Received 7 |
| `const command = previous && comparable…` → `false && previous && comparable…` (a new operation id on every send) | *keeps a failed purchase input for a retry with the same operation* | FAIL: `operationId` `3976e53f-…` expected, `c28aad69-…` received |
| `InventoryPanel.tsx` restored from `HEAD` (no `sold`/`expired` words) | *explains Marketplace outcomes for an item in words, with nothing to retry* | FAIL: Expected substring "sold on the Marketplace", Received "Request rejected: sold." |

## Gate results (in order)
Run one after another in this worktree; no build overlapped a browser run, and nothing else ran during `test:db`.

| # | Gate | Result |
| --- | --- | --- |
| 1 | `npm test` | **1015/1015** in 45 files (1002 before; 13 new). Rerun after the browser-spec fixes: 1015/1015. |
| 2 | `npm run typecheck` | pass: `tsc`, `deno check` of both functions, Deno runtime smoke 2/2. Rerun after the spec fixes: pass. `node assets/source/build-assets.mjs --check`: assets up to date (28 files). |
| 3 | `npm run test:db` | **193/193** in 10 files. Edge start time `2026-10-18T08:44:27.168093563Z` before and after. One run, none discarded; the known flaky `arena.test.ts:642` did not fail. |
| 4 | `npm run build`, then `npm run verify:static` | build OK (7 static pages); "Static export verified: 5 fixed routes; 89 assets scanned; no forbidden backend material; no fixture preview data." |
| 5 | `npx playwright test --config node_modules/.cache/pw-claude.config.mjs` (port 3200) | **Counted run (the third): 410 passed, 22 skipped, 0 failed**, 432 cases, 7.2 min; port 3200 free afterwards. Earlier runs below. |
| 6 | `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build`; `npm run verify:static -- .next/browser-test`; `PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test` (repo config, port 4173) | build OK; the same verify message; **16 passed, 416 skipped** (live and fixture specs skip in the static export by design) |
| 7 | `git diff --check`, and `git diff --cached --check` before each commit | clean. The cached check caught a trailing blank line in the new unit test; it was removed and the file rerun (13/13) before the commit. |

**Earlier development runs (not counted):**
1. 408 passed, 2 failed, 22 skipped:
   - `full-screen.spec.ts:114` (desktop): its Tab-order loop pressed Tab a fixed 10 times, which pinned the old seven menus. It now presses once per expected stop. A test update.
   - `tournament.spec.ts:597` (mobile): `page.waitForFunction` timed out after 45 s waiting for the camp scene to be ready. It passed alone, and in both later full runs. Load timing, unrelated to the market.
2. 408 passed, 2 failed (`market.spec.ts` 360 px, both projects): the sheet's bottom measured 647.1 > 640.5 while its rise animation was still running. The case now waits for the sheet's animations to finish, as `full-screen.spec.ts` does. A test fix.

After those test-only edits I reran gates 1 and 2. Gates 3 and 4 were not rerun: they do not read browser specs, and no source file changed after the build.

**Edge start times (`supabase_edge_runtime_Cloudiator`):** `2026-10-18T08:18:42.345522035Z` when I started; `08:44:27.168093563Z` before and after the counted `test:db` run. The recreation between them came during my editing; I changed no Edge or SQL source, and the cause is not known.

## Files changed
| File | Change |
| --- | --- |
| `src/features/market/MarketPanel.tsx` | new: `MarketPanel`, `MarketOffers`, `readOffers`, Browse / My listings / Sell, the confirmation dialog |
| `src/features/market/MarketPanel.module.css` | new: the mockup's rows and tabs, the Sell form, the dialog; fits 360 px |
| `src/features/market/market-text.ts` | new: `marketFee`, `sellerReceives`, `timeLeft`, item words, `listableItems`, `marketErrorText` |
| `src/features/shell/menus.ts` | the `market` entry, `MenuId`, header and comment |
| `src/features/shell/CampShell.tsx` | the `market` menu content; the command gateway for players only |
| `src/features/inventory/InventoryPanel.tsx` | "Listed for sale"; `sold`/`expired` words and refresh |
| `tests/domain/market-panel.test.ts` | new, 13 tests |
| `tests/domain/menus.test.ts` | eight menus; six for other viewers |
| `tests/api/fixture-gateway.test.ts` | the owner fixture and the fixture market agree |
| `tests/browser/market.spec.ts` | new, 7 cases × 2 projects |
| `tests/browser/inventory.spec.ts` | new `sold`/`expired` words case; the fixture case expects the listed helmet |
| `tests/browser/visitor.spec.ts` | `PUBLIC_MENUS` gains Marketplace, with its Browse-only checks |
| `tests/browser/full-screen.spec.ts` | the Tab-order loop follows the menu count |
| `tests/browser/live-routes.ts` | `market_offers` table, `LiveData.market`, `setMarket` |
| `tests/fixtures/market.ts` | `RULES_V1.marketplace.expiryMs`; `ASTER_LISTED_ITEM` |
| `tests/fixtures/arena-build.ts` | `ARENA_OWNER.inventory = [ASTER_LISTED_ITEM]` |
| `docs/implementation/task-18-report.md` | new (second commit) |

## Screenshots (not committed)
Captured by `market.spec.ts` in the counted development run (after the camp scene was ready) and copied to `C:\Avi\Studies\Projects\Cloudiator-claude\.superpowers\sdd\2026-10-17-task-18-marketplace\shots\`. The folder is git-ignored.

- `C:\Avi\Studies\Projects\Cloudiator-claude\.superpowers\sdd\2026-10-17-task-18-marketplace\shots\market-browse-desktop.png`: Browse, player, desktop 1280×720
- `C:\Avi\Studies\Projects\Cloudiator-claude\.superpowers\sdd\2026-10-17-task-18-marketplace\shots\market-browse-pixel7.png`: Browse, player, Pixel 7 bottom sheet
- `C:\Avi\Studies\Projects\Cloudiator-claude\.superpowers\sdd\2026-10-17-task-18-marketplace\shots\market-sell-desktop.png`: Sell with the axe chosen at 101: NPC sale value 30, fee 5, you receive 96 (desktop)
- `C:\Avi\Studies\Projects\Cloudiator-claude\.superpowers\sdd\2026-10-17-task-18-marketplace\shots\market-my-listings-desktop.png`: My listings after listing the axe (desktop)
- `C:\Avi\Studies\Projects\Cloudiator-claude\.superpowers\sdd\2026-10-17-task-18-marketplace\shots\market-visitor-browse-desktop.png`: the visitor's Browse (desktop)
- `C:\Avi\Studies\Projects\Cloudiator-claude\.superpowers\sdd\2026-10-17-task-18-marketplace\shots\market-visitor-browse-pixel7.png`: extra: visitor, Pixel 7
- `C:\Avi\Studies\Projects\Cloudiator-claude\.superpowers\sdd\2026-10-17-task-18-marketplace\shots\market-sell-pixel7.png`: extra: Sell, Pixel 7
- `C:\Avi\Studies\Projects\Cloudiator-claude\.superpowers\sdd\2026-10-17-task-18-marketplace\shots\market-my-listings-pixel7.png`: extra: My listings, Pixel 7

## Concerns
1. **Owner fixture.** Ruling 4's Iron helmet is in `ARENA_OWNER`, the fixture gateway's owner, which the fixture market goes with. `ownerFixture`, which many live specs use as their owner, is unchanged. Only Inventory's fixture case pinned the old empty inventory.
2. **No gladiator.** "Create your gladiator to trade." is a line of text, not a button: the specified `MarketPanel` props carry no creation callback. The corner chip and My gladiator already offer creation.
3. **Visitor sign-in.** Following the mockup, a visitor sees "Browsing only. Sign in to buy or sell." above the list and a "Sign in with Google to trade" button below it, which starts the existing Google flow (disabled in the fixture preview). It sends no command.
4. **Active-listing count.** The Sell tab counts the owner's listing-reserved items. A listing past its expiry but not yet swept still counts until the sweep or the seller's next command expires it, so at five, List for sale can stay disabled briefly while the server would accept it.
5. **Refresh on every final refusal.** Besides `sold`, `expired` and `not-found`, the panel also re-reads the page and owner on `invalid`, `insufficient-funds`, `inventory-full`, `conflict` and `unauthenticated`; only the stale codes say the listings were refreshed.
6. **Number format.** Market amounts use thousands separators ("2,000", "1,250"), while Inventory and the corner chip show plain numbers ("2000"). The receipt shows the first 8 characters of the receipt id.
7. **Inventory words.** Inventory's new `sold`/`expired` words are not reachable from its own commands today (Decision 9 never returns them for `buy-shop`, `sell-item` or `discard-item`); they were added as the brief asked.
8. **Post-hoc tests.** Two tests were written after the code (see RED); each failed under a mutation of the behavior it guards.
9. **Infrastructure.** One full run had a tournament case time out waiting for the camp scene (it passed alone and in both later runs), and the Edge container was recreated once before the counted DB run with no Edge edits of mine.
