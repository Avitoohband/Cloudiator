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

### Task 3: Combined candidate

- [ ] Final review of both tasks' diff. Add Wiki menu and shop grid lines to the 1.9 changelog section. Commit.
- [ ] Run the complete offline 12-stage gate (native32, `pw-design-tcp.config.mjs`, 32 browser shards) on the exact committed candidate. Record the result and gate.json SHA-256 in HANDOFF and here. Stop at local readiness.
