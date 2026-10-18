# Task 18 final-review fix wave: report

- **Status:** DONE_WITH_CONCERNS. Every gate passed in its counted run. The concerns are small interpretation choices, one residual I1 limit outside the brief's scope, and two unrelated scene-load timeouts in earlier full browser runs.
- **Branch and base:** branch `claude/task-18` in `C:\Avi\Studies\Projects\Cloudiator-claude`, base `95da283` (`docs: record the Task 18.3 review and checkpoint the Marketplace menu`).
- **Commit (not pushed):** `248debe fix: read the seller's state when the Marketplace opens or refreshes`.
- **Scope:** exactly I1, M-a, M-b, M-c and M-d.
  - No SQL or migration change (M14 untouched), so `test:db` was not run.
  - HANDOFF was not edited.
  - Nothing was pushed or merged.
  - No package or tool was downloaded.
  - No subagent or reviewer was dispatched.

## Findings verified against the code first

| Finding | What the code at `95da283` showed |
| --- | --- |
| I1 | <ul><li>`MarketPanel.tsx:196` and `:223-224` count listings from `owner` and disable List at five.</li><li>`:265-266` take the available money and inventory-full from `owner`.</li><li>`:181` Refresh re-reads the offers only.</li><li>`:269-272` `settle` re-reads the owner only after the panel's own command.</li><li>`useGameState` reads the owner only on an account, revision or slot change, a tab return, or `refreshOwner()`.</li><li>Offers never bump the revision (Ruling 2, `progress.md`).</li></ul> |
| M-a | `12-market.sql:235`: `create-listing` returns `not-found` when the actor does not own the item. `market-text.ts:109` said "This listing is no longer open" for every command. |
| M-b | `market-text.ts:10`: `MARKET_FEE_PERCENT = 5` was hard-coded; `RULES_V1.fees.marketRate` is `0.05`. |
| M-c | <ul><li>`MarketPanel.tsx:16` and `market-text.ts:95` cited "Ruling 3". The Task 18 rulings in `progress.md` are Ruling 1, Ruling 2 and two unnumbered rulings.</li><li>The same citation also appeared in a comment at `tests/browser/market.spec.ts:316`. That comment is fixed too.</li></ul> |
| M-d | <ul><li>In `market-text.ts:60-72` and `MarketPanel.tsx:110-119`, a salvage offer showed no quantity, said "NPC merchants do not buy this item", and used the 🗡 glyph.</li><li>SQL accepts a salvage stack (an accepted 18.1 interpretation).</li></ul> |

## What changed

### I1: read a trader's owner when the panel opens and on Refresh
- **`ownerReads(read)`** (new, exported from `MarketPanel.tsx`). It returns `{ open, refresh }`:
  - `open` reads at most once per panel. React Strict Mode runs a mount effect twice in development.
  - `refresh` reads every time.
  - Both ignore a failed read, so the owner already shown stays, as `settle` does.
- **`MarketPanel`:**
  - It keeps one `ownerReads` instance (a `useState` initializer) that reads through a ref to the latest `refreshOwner`. A new `refreshOwner` identity therefore does not cause another read.
  - A mount effect calls `open()` for a trader only (`viewer === 'player' && owner`). Visitors and accounts without a gladiator make no new read.
- **`OfferList`** gains `onRefresh`. Its Refresh button (in Browse and My listings) re-reads the offers and, for a trader, calls `owners.refresh()`.
- Command settlement (`settle`) is unchanged.

### M-a: create-specific `not-found` copy
- `marketErrorText('not-found', 'create-listing')` now says "That item is no longer in your inventory. Your inventory has been refreshed." The panel's `settle` re-reads the owner after every final refusal, so the second sentence is true.
- Cancel and buy keep "This listing is no longer open. The listings have been refreshed."

### M-b: fee from the rules
- `MARKET_FEE_PERCENT = Math.round(RULES_V1.fees.marketRate * 100)`.
- `marketFee` stays `Math.floor(price * MARKET_FEE_PERCENT / 100)`. This is exact integer math: at most 1e9 × 100, well below 2^53.
- `docs/operations/migrations.md`, M14 section: a new "Rule literals" paragraph. SQL repeats `5/100`, `604800000`, `1000000000` and the five-listing limit, so changing those rules needs a new migration.

### M-c: citations (comments only)
These three comments now cite "the Task 18.2 review's item carried to 18.3: keep the same operationId on `processing`":
- the `MarketPanel.tsx` header;
- the `market-text.ts` `RETRY_CODES` doc comment;
- the retry comment in `market.spec.ts`.

`grep "Ruling 3"` over `src`, `tests`, `docs/operations` and `supabase/functions` now finds nothing.

### M-d: non-equipment offers in Browse
- **Quantity.** New `offerName(item)` gives "12 × Salvage" when the quantity is above 1 (the "N × name" form Inventory uses), and the bare name otherwise. The Browse rows, the Buy and Cancel labels, the purchase confirmation and the receipt all use it.
- **NPC value.** `npcValue` is now the unit value times the quantity, and it knows salvage (`CATALOG_V1.salvage.npcSellValue`, which is `RULES_V1.inventory.salvageSellValue`, 10). `npcValueText` adds "(10 each)" for a stack.
- **Glyph.** `itemIcon` uses 🗡 only for the weapon slot, and 📦 for anything that is not equipment.

## TDD evidence

### RED (all tests written before any implementation)
**Unit.** `npx vitest run tests/domain/market-panel.test.ts`: 5 failed, 13 passed.

| Finding | Test | Failure (right reason) |
| --- | --- | --- |
| M-b | *takes the rate from the rules as a whole percent, with exact integer floor math*. It `vi.doMock`s `@domain/rules-v1` with `marketRate: 0.1` and re-imports `market-text`. | `expected 5 to be 10`: the panel ignored the rules' rate |
| I1 | *reads the owner once when the panel opens, however often opening runs, and again on each Refresh* | `TypeError: ownerReads is not a function` |
| I1 | *keeps the owner last shown when a read fails* | `TypeError: ownerReads is not a function` |
| M-a | *says a listing was not created because the item is gone, not that a listing closed* | `expected 'This listing is no longer open. The l…' to match /^That item is no longer in your inven…/` |
| M-d | *describes a salvage stack listed through the command endpoint by its quantity and NPC value* | `expected ' 🗡 Salvage Cassia · 1 d left Level 1 · Common · Weight 0 NPC merchants do not buy this item 💰 150 money Buy ' to contain '12 × Salvage'` |

**Browser (I1).** The new case is *reads the owner when the menu opens and on Refresh, after listings sold elsewhere*. Command: `npx playwright test --config node_modules/.cache/pw-claude.config.mjs market.spec.ts -g "reads the owner when the menu opens"`. Both projects failed at `market.spec.ts:356`.
- **Setup:**
  - Aster has 1,000 money and five listings.
  - Two of them sell after the page has read her owner state.
  - Then she opens the Marketplace.
- **Assertion that failed:** `toContainText('Active listings: 3 of 5')`.
- **Received:** "Active listings: 5 of 5 … You have 5 active listings, the most allowed. Cancel one to list another." My listings had already shown 3 offers (the previous assertion passed). This is the reviewer's symptom.

**M-c** is comment-only, so it has no test. It is verified by the `grep` above.

### GREEN
- **Unit:** `market-panel.test.ts` 18/18; the full suite 1020/1020 (1015 before, plus 5 new).
- **Browser:** `market.spec.ts`, `inventory.spec.ts` and `visitor.spec.ts` on both projects: 41 passed, 3 skipped (the specs' own per-project skips). The new case passed on desktop and mobile.

**What the new browser case asserts:**
- **After opening the menu:**
  - My listings shows 3.
  - Sell says "Active listings: 3 of 5" and List for sale is enabled (axe chosen, price 100).
  - "Available money: 1,760", which is 1,000 + 285 + 475.
  - Cassia's 1,250 bow can now be bought (it was "Not enough available money" at 1,000).
  - Exactly one owner read since the page loaded, checked after four tab switches.
- **After a third listing sells while the menu is open:**
  - Refresh shows "Available money: 1,950" and "Active listings: 2 of 5".
  - Exactly two owner reads in total.
  - No command was sent.
  - Inventory no longer shows the three sold items.

### Mutation checks (desktop)
For each mutation I saved a copy, applied it, ran the test, restored the copy, and confirmed byte equality with `cmp`.

| Mutation | Result |
| --- | --- |
| The open effect calls `owners.refresh()` instead of `owners.open()` (no once-only guard) | FAIL at `expect(owners()).toBe(read + 1)`: Expected 2, Received 3. Development Strict Mode runs the mount effect twice, so the once-only `open` is needed. |
| Refresh no longer calls `onRefresh` | FAIL: `getByText('Available money: 1,950')` was not visible |

## Gate results (in order, one after another in this worktree; no build overlapped a browser run)

| # | Gate | Result |
| --- | --- | --- |
| 1 | `npm test` | **1020/1020** in 45 files |
| 2 | `npm run typecheck` | Pass: `tsc`, `deno check` of both functions, and the Deno runtime smoke test 2/2. Also `node assets/source/build-assets.mjs --check` (step 2 of `verification-gates.md`): "assets up to date (28 files)". |
| 3 | `npm run build`, then `npm run verify:static` | Build OK (7 static pages). "Static export verified: 5 fixed routes; 89 assets scanned; no forbidden backend material; no fixture preview data." |
| 4 | `npx playwright test --config node_modules/.cache/pw-claude.config.mjs` (port 3200) | **Counted run (the third): 412 passed, 22 skipped, 0 failed** (434 cases, 7.3 min). Port 3200 was free afterwards. The two earlier runs are below. |
| 5 | `CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build`; `npm run verify:static -- .next/browser-test`; `PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test` (repo config, port 4173) | Build OK; the same verify message; **16 passed, 418 skipped** (live and fixture specs skip in the static export by design). Port 4173 was free afterwards. |
| 6 | `git diff --check`, and `git diff --cached --check` before the commit | Clean |

**Earlier full development runs (not counted).** Each had one failure, a 45 s page-load wait for a Phaser scene that timed out before any interaction. Neither case involves the Marketplace, and the panel only mounts while its menu is open.
1. 411 passed, 1 failed:
   - **Case:** `camp.spec.ts:67` (mobile).
   - **Failure:** `page.waitForFunction` timed out waiting for `__cloudiatorCamp.state().ready` in `openCamp`.
   - **Alone:** `--repeat-each=3` passed 3/3.
2. 411 passed, 1 failed:
   - **Case:** `replay.spec.ts:224` (desktop).
   - **Failure:** `page.waitForFunction` timed out waiting for `__cloudiatorReplay.state()` in `openReplay`.
   - **Alone:** `--repeat-each=3` passed 3/3.

No other dev or static server was listening on ports 3000, 3100, 3200, 3300, 4173 or 4174. This is the same class of load-timing noise as the uncounted 18.3 timeout in `tournament.spec.ts:597`. I report it as infrastructure noise, not product evidence.

**Line endings.** Git warns "LF will be replaced by CRLF" for the four `.ts`/`.tsx` files. `git ls-files --eol` shows `i/lf w/lf` for them, the same as the untouched `CampShell.tsx`. `git diff --numstat` shows only the intended lines, so there is no line-ending churn.

## Files changed

| File | Change |
| --- | --- |
| `src/features/market/MarketPanel.tsx` | `ownerReads`; the owner reads on open and on Refresh for a trader; `offerName` for offers; the M-c comment |
| `src/features/market/market-text.ts` | The fee percent from the rules; `offerName`; the neutral glyph; NPC value per unit × quantity, including salvage; the create `not-found` copy; the M-c comment |
| `tests/domain/market-panel.test.ts` | 5 new tests: the fee from the rules (M-b); `ownerReads` ×2 (I1); create `not-found` (M-a); a salvage offer (M-d) |
| `tests/browser/market.spec.ts` | The new I1 case (× 2 projects); `marketFlow` gains `listed` and `soldElsewhere`; the M-c comment |
| `docs/operations/migrations.md` | The M14 "Rule literals" paragraph |
| `.superpowers/sdd/2026-10-17-task-18-marketplace/final-fix-report.md` | This report (git-ignored, not committed) |

## Concerns

1. **I1's residual limit (outside the brief).**
   - The fix reads the owner only when the Marketplace opens and on Refresh, as the brief specifies.
   - Opening Inventory directly, without the Marketplace, still shows the last owner read (for example a sold item as "Listed for sale") until a revision, slot or tab-return read.
   - After a failed offers load, "Try again" re-reads the offers but not the owner.
   - In the fixture preview, the open read calls the fixture gateway's owner read, which is harmless.
2. **How I1 is tested.**
   - The repo has no DOM test environment, and packages cannot be downloaded. So the unit test covers the extracted `ownerReads` helper.
   - The browser case, with its exact owner-read counts, and the two mutations cover the wiring and the once-per-open behavior.
3. **Interpretation choices beyond the reviewer's example text:**
   - **M-a:** the copy adds "Your inventory has been refreshed."
   - **M-b:** the doc paragraph also names the five-listing literal (`>=5`), not only the three listed.
   - **M-c:** the same wrong citation in the `market.spec.ts` comment is also fixed.
   - **M-d:** the quantity also appears in the Buy and Cancel labels, the confirmation and the receipt, because they share `offerName`.
4. **M-b rounding.** `MARKET_FEE_PERCENT` rounds the rate to a whole percent. The unit test pins `MARKET_FEE_PERCENT / 100 === RULES_V1.fees.marketRate`, so a rate that is not a whole percent fails that test instead of rounding silently. Such a change would need a new migration anyway.
5. **Not changed (outside scope):**
   - A salvage offer's grade line still reads "Level 1 · Common · Weight 0".
   - The `market.spec.ts` comment citing "Ruling 5" (no gladiator) also matches no numbered ruling in `progress.md`.
6. **Infrastructure.** Two earlier full development runs each had one unrelated 45 s scene-load timeout (see the gate notes). Each case passed alone 3/3, and the counted third run was clean.
