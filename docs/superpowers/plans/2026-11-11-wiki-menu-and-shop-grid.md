# Patch 1.9 Wiki Menu and Shop Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development with test-first implementation, a separate review for each task, and an exact combined-candidate gate.

**Goal:** Replace the Wiki's 14 topic buttons with one short scrolling topic list (variant D), and show the Weaponsmith's and Armorer's offers as an icon grid with the inventory's detail card.

**Architecture:** Both changes are client-only, inside the existing 1.9 branch `codex/game-info` (on top of `d01e83a`). The Wiki list keeps the published Game Info data and the editor untouched. The shop grid reuses the inventory's grid, tile and card styles and `item-presentation.ts`, and keeps the existing `buy-shop` command path and its rules.

**Tech Stack:** Next.js 16 static client, React, CSS modules, Playwright (private config `node_modules/.cache/pw-design.config.mjs`, port 3500), Vitest.

**Spec:** Avi approved both mockups on 2026-11-11.
- Wiki menu variant D: `.superpowers/design/2026-11-11-wiki-menu/` (`wiki-menu-mockup.html`, `variant-d-desktop.png`, `variant-d-phone.png`, `variant-d-desktop-scrolled.png`).
- Shop grid: `.superpowers/design/2026-11-11-shop-grid/` (`shop-grid-mockup.html`, `shop-grid-desktop.png`, `shop-grid-phone.png`; real "today" captures in `shots/`).

## Global Constraints

- Use installed tools offline. No package downloads. Production, the Game Info function and setup, the client release and content publication stay on hold.
- Never run a build or a second browser run while a browser run is active in `design` (AGENTS.md, output separation). Run browser cases with `--config node_modules/.cache/pw-design.config.mjs`.
- Keep item balance, prices, level and currency rules, inventory capacity, quantity limits (1-60), preview mode and busy handling exactly as today.
- Desktop and 360 px phone. No horizontal page scroll. Keyboard, pointer and touch all work.
- Detail cards that apply an item (AGENTS.md, 2026-11-11): test two same-name offers with different IDs and stats; the card's values and the submitted offer must agree as hover or keyboard focus changes, and pointer movement must not move focus off an active keyboard action.

## Review Focus

- Same-name offers (Sword L1, L5, L10; gold and renown versions at L5) stay distinguishable in names, cards and the submitted catalog ID.
- A currency or filter change that hides the selected offer selects a visible one; Buy never submits a hidden offer.
- A click on the Weaponsmith or Armorer in the camp still opens the shops scrolled into view, now with Weapons or Armor chosen.
- The Wiki list keeps the chosen topic visible on open and after keyboard moves; the Edit Wiki path still edits the chosen topic.
- The Arena banner stays buyable and shows Owned once bought.

---

### Task 1: Wiki topic list (variant D)

**Files:** Modify `src/features/game-info/GameInfoPanel.tsx`, `src/features/game-info/game-info.module.css`. Test `tests/browser/game-info.spec.ts`.

- [ ] **Step 1: Failing browser case** "Wiki topics are one short scrolling list", both Chrome projects: the Wiki tab shows one `listbox` named "Wiki topics" with 14 `option`s; no topic buttons; the list's visible height fits about 4 rows (client height under 5 row heights, scroll height larger than client height); the chosen option (default "Combat, dodge, and critical hits") has `aria-selected="true"`, a visible ✓ and is inside the list's visible area; ArrowDown, ArrowUp, Home and End move the choice and the article heading follows; a click chooses a topic; the chosen option stays scrolled into view; no horizontal overflow at 360 px.
- [ ] **Step 2: Run it and watch it fail** for the missing listbox.
- [ ] **Step 3: Implement.** Replace the `<nav aria-label="Wiki topics">` buttons with a `role="listbox"` (one tab stop, `aria-activedescendant`, options `role="option"`), styled like the mockup's open drop-down: bordered panel, about 4 rows tall, `overflow-y: auto`, chosen row highlighted with ✓. Selection follows the keyboard. Keep `setTopic`, the article, copy blocking, the videos, the Future Updates tab and `GameInfoEditor selectedId` unchanged.
- [ ] **Step 4: Run the new case and the existing Game Info cases** (`game-info.spec.ts`, `game-info-editor.spec.ts`) on both projects; all pass.
- [ ] **Step 5: Commit** `feat: Wiki topics as one short scrolling list`.

### Task 2: Shop icon grid

**Files:** Modify `src/features/shops/ShopPanel.tsx` (may add `src/features/shops/ShopPanel.module.css`), reuse `src/features/inventory/InventoryPanel.module.css` classes or `ItemPresentation`. Update tests `tests/browser/inventory.spec.ts`, `tests/browser/management.spec.ts`, `tests/browser/release.spec.ts`, `tests/domain/profile-card.test.ts` where they drive the old merchant buttons, `Shop tier` or `Shop currency` selects.

**Interfaces:** `ShopPanel` props stay `{ owner, busy, preview, buy(catalogId, quantity), initialMerchant? }`. Cells keep `data-testid="offer-<catalogId>"`. Buy keeps its accessible name `Buy <item name>`; the quantity field keeps its label `Purchase quantity`.

- [ ] **Step 1: Failing browser cases**, both Chrome projects:
  - "Shop offers show as an icon grid": filter group "Shop filters" with All / Weapons / Armor (`aria-pressed`), currency group with Gold / Renown (`aria-pressed`); Gold + All shows the 33 gold offers as icon cells sorted by required level, each with a level tag, a price and the item's atlas icon; cells above the player's level are dimmed with a lock and a "Requires level N" description; prices the player cannot afford are marked.
  - "Shop card matches the chosen offer": choose Sword L1, then Sword L5 by keyboard (arrow keys move between cells, Enter or Space chooses); the card shows the L5 name, level, stats, weight and price; Buy submits `sword:5:common` (fixture spy or preview message); moving the pointer over another cell while focus is on Buy does not change the card or what Buy submits; Gold to Renown switch with Sword L5 chosen shows `sword:5:renown` at 100 renown.
  - "Merchant click opens the right filter": opening the shops from the Weaponsmith chooses Weapons, from the Armorer chooses Armor, and the shops scroll into view.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement** the approved layout: Shops heading with Gold and Renown balances; filters and currency switch; one grid of square cells (inventory tile look) with all tiers; the inventory's detail card beside it on desktop and below it on phone, with `itemStatLines`, slot and "sold by the Weaponsmith/Armorer", price each and total, NPC sell value or "Account-bound · Cannot sell", the quantity field, the existing messages (invalid quantity, inventory full, level lock, not enough currency) and Buy with today's disabled rules. Keep the renown and gold explainer lines. Default choice: the first visible cell; a filter or currency change that hides the choice picks the first visible cell. The Arena banner: a cell in Renown with All or Armor (sold by the Armorer), its own card text and Owned state as today; if the atlas has no banner frame, draw a simple CSS banner tile (no new art file).
- [ ] **Step 4: Update the existing journeys** that used the merchant buttons, `Shop tier` or `Shop currency` to choose cells instead. Run `inventory.spec.ts`, `management.spec.ts`, the shop cases in `release.spec.ts`, the profile-card unit test, `npm test` and `npm run typecheck`; all pass.
- [ ] **Step 5: Commit** `feat: shops as an icon grid with the inventory's detail card`.

### Task 3: Final-review fixes and the demo bag

Avi added four features after Tasks 1-2 (2026-11-11, mockups approved): search and sort, menu pin and position, equipping from My gladiator, and a new renown laurel. Tasks 3-7 build them; Task 8 is the combined candidate.

**Files:** `src/lib/api/fixture-gateway.ts`, `src/features/shops/*`, `src/features/game-info/*`, tests.

- [ ] **Demo bag first.** Replace the uncommitted preview-only demo bag in `fixture-gateway.ts` with an opt-in fixture query: `/game/?mode=fixture&bag=demo` gives Aster 18 extra catalog items with duplicates (the list in the uncommitted edit); the default fixture is unchanged. Unit test both. Commit before any browser run.
- [ ] **Shop grid on phones (Important).** Pad the shop grid like the inventory (no extra empty rows outside the full view). After a filter, currency, search or sort change, scroll the chosen cell into view inside the grid only. Mobile case: scroll All to the bottom, tap Weapons, the chosen cell is inside the grid's visible area.
- [ ] **Wiki list on short screens (Important).** Remove `overscroll-behavior: contain` from `.topics`. Make the Wiki tabpanel focusable (`tabIndex={0}`) like Future Updates; add `editing` to the topic-scroll effect's dependencies.
- [ ] **Polish.** Buy's `aria-describedby` also names the chosen offer's level and price; a `shop-offers.ts` Vitest (pair counts, non-empty pairs, a counterpart for every offer, the banner only in Renown under All or Armor); an empty-result guard; fix the stale comment at `release.spec.ts` ~794.
- [ ] Run the touched specs on both projects, `npm test`, `npm run typecheck`. Commit.

### Task 4: Search and sort (Inventory and Shops)

**Spec:** `.superpowers/design/2026-11-11-search/` (`search-mockup.html`, `search-desktop.png`, `search-sort-desktop.png`, `search-phone.png`, `search-inventory-desktop.png`, `search-empty-desktop.png`).

- [ ] Failing cases first, both projects: a "Search items" field with a clear (×) button above each grid; case-insensitive part-of-name match combined with the filters and currency; "N items match "<text>"" line; no-match state `No items match "<text>"` with Clear search; Escape clears; a chosen item that stops matching gives way to the first match. A "Sort" select: Shops Level (default) / Price / Name / Damage / Armor / Weight; Inventory Newest (default) / Level / Name / Damage / Armor / Weight / Sell value. Level, Price and Name ascend; Damage, Armor, Weight and Sell value descend; ties keep the default order. Phone: search and sort share a row.
- [ ] Implement with one shared pure helper for matching and sorting (unit-tested), used by both panels. Keep every Wear/Sell/Discard/Buy rule. Run the inventory, management and release specs, `npm test`, `npm run typecheck`. Commit.

### Task 5: Menu pin and position

**Spec:** `.superpowers/design/2026-11-11-menu-pin/` (`menu-pin-mockup.html`, `menu-left-pinned.png`, `menu-right-pinned.png`, `menu-bottom-pinned.png`, `menu-controls-zoom.png`).

- [ ] Failing cases first (desktop project; phone unchanged): after the zoom buttons, a Pin button ("Pin menu" / "Unpin menu", pressed when pinned) and a "Menu position" button opening Left / Right / Bottom ("Menu on the left/right/bottom"); pinned keeps the rail shown; unpinned keeps today's reveal and 300 ms hide at the chosen edge; Right sits clear of the corner chip and arrival banner; Bottom is a centred horizontal bar with tooltips above; panels open beside the rail (right of it, left of it, above it). Saved in this browser (`localStorage`, read in try/catch; a bad or missing value means Left, unpinned) and restored on reload. The phone ☰ layout is unchanged.
- [ ] Implement in `src/features/shell/` (`MenuRail.tsx`, `rail-reveal.ts` reducer events, `shell.module.css`, panel placement in `CampShell.tsx`). Run the shell, camp and menu specs on both projects, `npm test`, `npm run typecheck`. Commit.

### Task 6: Equip from My gladiator

**Spec:** `.superpowers/design/2026-11-11-equip-from-gladiator/` (`equip-mockup.html`, `equip-desktop-picker.png`, `equip-desktop-queued.png`, `equip-phone.png`, `equip-desktop-twohanded.png`, `equip-desktop-overload.png`).

- [ ] Failing cases first, both projects (use `&bag=demo`): a Worn equipment slot opens a picker of fitting inventory items (inventory tile look, level tag, copy number, lock above level or when listed, ✓ worn, → next, a Remove tile when filled); choosing shows Worn / New / difference rows (Damage, Attack interval, Hands for two-handed, Armor for armour, Weight, Load against capacity, bonuses when any) and "Wear <name> · Item <n>"; Wear queues the same `queue-build` change as the Inventory and the slot shows Next with Undo; a two-handed weapon names the off-hand piece that comes off and blocks the off-hand picker; overload turns Load red with "This would overload your gladiator" and Wear stays enabled. Duplicates: the AGENTS.md detail-card rule (two same-name instances; comparison and Wear agree as focus and hover change). Desktop popover under the slots; phone sheet with Back and a sticky Wear bar; Escape closes and returns focus to the slot.
- [ ] Implement in `src/features/character/` with `src/features/inventory/gear.ts` (add only the Remove helper, same command). The build planner's own picker stays unchanged (Avi: keep both). Run the character, planning, inventory specs on both projects, `npm test`, `npm run typecheck`. Commit.

### Task 7: Renown laurel

- [ ] After Avi picks a candidate from `.superpowers/design/2026-11-11-renown-icon/`, replace `ICONS.renown` in `assets/source/generators/effects.mjs`, rebuild the assets (`node assets/source/build-assets.mjs`, then `--check`), and show the laurel in the corner chip and its phone bar instead of ★ (accessible text "Renown" unchanged). Update provenance if the build requires it. Run the shell specs on both projects, `npm test`. Commit.

### Task 8: Combined candidate

- [ ] Final review of Tasks 3-7. Add 1.9 changelog lines for the Wiki list, shop grid, search and sort, menu pin, equipping from My gladiator and the laurel. Commit.
- [ ] Run the complete offline 12-stage gate (native32, `pw-design-tcp.config.mjs`, 32 browser shards) on the exact committed candidate. Record the result and gate.json SHA-256 in HANDOFF and here. Stop at local readiness.
