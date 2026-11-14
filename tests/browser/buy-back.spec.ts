import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Locator, type Page, type TestInfo } from './fixtures';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands';
import type { BuyBackEntry, ItemInstance } from '../../supabase/functions/_shared/contracts/reads';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1';
import { itemFixture, ownerFixture } from '../fixtures/domain';
import { worldToScreen } from '../../src/game/iso';
import { emptyWorld, isPresence, routeLiveReads, seedSession, SUPABASE_URL } from './live-routes';
import { contrastIssues, noHorizontalScroll } from './a11y-helpers';
import { expectOwnerShown, menuDialog, openMenu, quietArrivals } from './shell-helpers';
import { openSection } from './section-helpers';

// Patch 1.9 Task 23: Buy back in the Shops (the approved mockup, .superpowers/design/2026-11-12-feedback-buyback, notes.md "Buy back"). The owner
// read lists the gladiator's last 10 gear sales of the current game day (`OwnerState.buyBack`, Task 22's M34); the Shops show them behind a
// "Buy back (n)" chip with the same grid and card, and Buy back sends one `buy-back` command. Live mode: the development-only intercepted transport
// stands in for the server (the price is what the sale paid; the bag holds 60; the next game day is every 14,400,000 ms).
const DAY = 14_400_000;
const MIN = 60_000;
/**
 * The server's time, held (fix round 1: the card's "today" must not depend on the wall clock): 13:40 UTC, 15:40 in Israel, 100 minutes into
 * the game day that started at 12:00 UTC, so every sale below is from this game day and the next starts in 2 h 20 min.
 */
const NOW = Date.UTC(2026, 10, 12, 13, 40);
test.use({ timezoneId: 'Asia/Jerusalem' });

async function shot(page: Page, info: TestInfo, name: string, show?: Locator) {
  // The view at the top of the menu, as the player looks at it.
  await show?.evaluate(element => {
    // The menu's own scroller only (the page itself never scrolls), as the shell brings the shops into view.
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const { overflowY } = getComputedStyle(parent);
      if (overflowY === 'auto' || overflowY === 'scroll') { parent.scrollTop += element.getBoundingClientRect().top - parent.getBoundingClientRect().top; return; }
    }
  });
  const file = `task-23-${name}-${info.project.name === 'mobile' ? 'phone' : 'desktop'}.png`;
  await page.screenshot({ path: info.outputPath(file) });
  if (process.env.TASK23_SHOTS) {
    mkdirSync(process.env.TASK23_SHOTS, { recursive: true });
    await page.screenshot({ path: `${process.env.TASK23_SHOTS}/${file}` });
  }
}

const piece = (catalogId: string): ItemInstance => ({ ...itemFixture(CATALOG_V1.items[catalogId]), id: randomUUID() });
/** The mockup's five sales, newest first: a rare Sword L5 for 39, an uncommon Iron helmet L5 for 34, two Round shields for 7, Heavy boots for 10. */
const SALES: [string, number, number][] = [['sword:5:rare', 39, 20], ['iron-helmet:5:uncommon', 34, 38], ['round-shield:1:common', 7, 69], ['round-shield:1:common', 7, 69],
  ['heavy-boots:1:common', 10, 95]];

/** `olderServer`: an owner read without `buyBack` (a server before M34), whose sales are not kept for buying back. */
type Options = { money?: number; bagSize?: number; sales?: typeof SALES; refuse?: 'expired' | 'processing'; olderServer?: boolean };
async function shopFlow(context: BrowserContext, options: Options = {}) {
  await quietArrivals(context);
  await seedSession(context);
  const now = NOW;
  const state = structuredClone(ownerFixture);
  state.wallets = { money: options.money ?? 100, renown: 25 };
  state.inventory = [piece('axe:1:common'), ...Array.from({ length: (options.bagSize ?? 19) - 1 }, () => piece('light-boots:1:common'))];
  let saleIds = 100;
  const entry = (catalogId: string, price: number, minutesAgo: number, item = piece(catalogId)): BuyBackEntry =>
    ({ saleId: ++saleIds, item, price, soldAtMs: now - minutesAgo * MIN, expiresAtMs: (Math.floor(now / DAY) + 1) * DAY });
  state.buyBack = (options.sales ?? SALES).map(([id, price, ago]) => entry(id, price, ago));
  if (options.olderServer) delete (state as Partial<typeof state>).buyBack;
  const live = await routeLiveReads(context, { world: emptyWorld(now), owner: state, serverNowMs: () => now });
  const commands: GameCommand[] = [];
  let refusal = options.refuse;
  await context.route(`${SUPABASE_URL}/functions/v1/game-command`, async route => {
    if (route.request().method() !== 'POST' || isPresence(route.request())) return route.fallback();
    const command = route.request().postDataJSON() as GameCommand;
    commands.push(command);
    const answer = (status: number, body: unknown) => route.fulfill({ status, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify(body) });
    if (command.kind === 'buy-back') {
      const sale = state.buyBack.find(s => s.saleId === command.saleId);
      if (refusal === 'processing') { refusal = undefined; return answer(409, { ok: false, code: 'processing', retryAfterMs: 1000 }); }
      if (refusal === 'expired' || !sale) {
        // The game day turned: the server no longer lists the sale.
        state.buyBack = state.buyBack.filter(s => s.saleId !== command.saleId);
        live.setOwner(state);
        return answer(409, { ok: false, code: 'expired' });
      }
      if (state.wallets.money < sale.price) return answer(409, { ok: false, code: 'insufficient-funds' });
      if (state.inventory.length >= state.inventoryCapacity) return answer(409, { ok: false, code: 'inventory-full' });
      state.wallets.money -= sale.price;
      state.inventory.push(sale.item);
      state.buyBack = state.buyBack.filter(s => s !== sale);
      live.setOwner(state);
      return answer(200, { ok: true, receiptId: randomUUID(), value: { itemId: sale.item.id, moneyDebit: sale.price } });
    }
    if (command.kind === 'sell-item') {
      const sold = state.inventory.find(item => item.id === command.itemId);
      if (!sold) return answer(404, { ok: false, code: 'not-found' });
      const price = CATALOG_V1.items[sold.catalogId].npcSellValue ?? 0;
      state.inventory = state.inventory.filter(item => item !== sold);
      state.wallets.money += price;
      if (!options.olderServer) state.buyBack = [entry(sold.catalogId, price, 0, sold), ...state.buyBack].slice(0, 10);
      live.setOwner(state);
      return answer(200, { ok: true, receiptId: randomUUID(), value: {} });
    }
    return answer(409, { ok: false, code: 'invalid' });
  });
  return { state, commands, live };
}

test.beforeEach(() => { test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Buy back uses the development-only intercepted live transport.'); });

const shopsOf = (scope: Page | Locator) => scope.getByRole('region', { name: 'Shops', exact: true });
const filters = (shops: Locator) => shops.getByRole('group', { name: 'Shop filters', exact: true });
const chip = (shops: Locator) => filters(shops).getByRole('button', { name: /^Buy back/ });
const cells = (shops: Locator) => shops.locator('[data-buyback-cell]');
const card = (shops: Locator) => shops.getByRole('region', { name: 'Offer details', exact: true });
const buyBacks = (commands: readonly GameCommand[]) => commands.filter(c => c.kind === 'buy-back');

type Prop = { frame: string; x: number; y: number };
const stallProps = (JSON.parse(readFileSync('public/assets/camp/map.json', 'utf8')) as { props: Prop[] }).props;
/**
 * Clicks (or taps) a merchant's stall on its awning while the Inventory and shops menu stays open: the camera puts the awning on a point of
 * the camp the menu does not cover (right of the panel on a desktop, above the tall sheet on a phone).
 */
async function clickStallBeside(page: Page, frame: 'stall-weapons' | 'stall-armor') {
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
  const prop = stallProps.find(p => p.frame === frame)!;
  const box = (await page.locator('canvas').boundingBox())!;
  const target = (await page.evaluate(() => matchMedia('(hover: none), (max-width: 480px)').matches))
    // Patch 1.9 Task 30: the Inventory and shops sheet opens tall (top 96 px from the window's top), so on a phone the open camp is the
    // strip above it, beside the chip row's left end.
    ? { x: box.x + 24, y: box.y + 84 } : { x: box.x + box.width - 260, y: box.y + box.height / 2 };
  const awning = (() => { const a = worldToScreen(prop.x, prop.y); return { x: a.x + 14, y: a.y - 23 }; })();
  const zoom = 2;
  // The camera centre (world px) that puts the awning on `target`, as a tile for centerOn.
  const centre = { x: awning.x + box.width / (2 * zoom) - (target.x - box.x) / zoom, y: awning.y + box.height / (2 * zoom) - (target.y - box.y) / zoom };
  const tile = { x: (centre.x / 32 + centre.y / 16) / 2, y: (centre.y / 16 - centre.x / 32) / 2 };
  await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 2), tile);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const { camera } = await page.evaluate(() => window.__cloudiatorCamp!.state()!);
  const at = { x: box.x + (awning.x - camera.worldView.x) * camera.zoom, y: box.y + (awning.y - camera.worldView.y) * camera.zoom };
  expect(await page.evaluate(p => document.elementFromPoint(p.x, p.y) instanceof HTMLCanvasElement, at), `${frame} is on the open camp`).toBe(true);
  if (await page.evaluate(() => matchMedia('(hover: none)').matches)) await page.touchscreen.tap(at.x, at.y);
  else await page.mouse.click(at.x, at.y);
}

async function openBuyBack(page: Page) {
  await page.goto('/game/');
  await expectOwnerShown(page, ownerFixture.name);
  // Patch 1.9 Task 33: the Shops are the menu's second section.
  const menu = await openSection(await openMenu(page, 'Inventory and shops'), 'Shops');
  const shops = shopsOf(menu);
  await chip(shops).click();
  await expect(chip(shops)).toHaveAttribute('aria-pressed', 'true');
  return { menu, shops };
}

test('the chip counts the sales; the card shows the sold time, the price and the time left; Buy back sends one command', async ({ page, context }, info) => {
  const flow = await shopFlow(context);
  const { menu, shops } = await openBuyBack(page);
  await expect(chip(shops)).toHaveAccessibleName('Buy back (5)');
  // The view: the Gold/Renown group is gone, the sort is Newest, five cells (price chips the sale prices) and the count line.
  await expect(shops.getByRole('group', { name: 'Shop currency', exact: true })).toHaveCount(0);
  await expect(shops.getByRole('combobox', { name: 'Sort the shops' })).toHaveValue('newest');
  await expect(cells(shops)).toHaveCount(5);
  await expect(cells(shops).nth(0)).toHaveAccessibleName('Sword, level 5, rare, buy back for 39 gold');
  await expect(cells(shops).nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(cells(shops).nth(0)).toContainText('L5');
  await expect(cells(shops).nth(0)).toContainText('39');
  await expect(cells(shops).nth(1)).toHaveAttribute('data-rarity', 'uncommon');
  await expect(shops).toContainText('5 items to buy back · your last 10 sales of this game day. 19 / 60 bag slots used.');
  // Fix round 1: a compact grid, as the mockup's (no tall empty box under two rows of sales).
  const gridHeight = await shops.getByRole('group', { name: 'Items to buy back' }).evaluate(element => element.getBoundingClientRect().height);
  expect(gridHeight).toBeLessThanOrEqual(260);
  const details = card(shops);
  await expect(details.getByRole('heading', { name: 'Sword', exact: true })).toBeVisible();
  await expect(details).toContainText('Level 5 · rare · Tradable');
  await expect(details).toContainText(/Damage\s*11\.7/);
  await expect(details).toContainText(/Sold for 39 gold · today (3:20\sPM|15:20)/);
  await expect(details).toContainText(/Available until the next game day \(in (\d+\s*h(?: \d+\s*min)?|\d+\s*min|under a minute)\)\./);
  await expect(details).toContainText('Same price you were paid. It comes back with its level, rarity and stats.');
  const buy = details.getByRole('button', { name: 'Buy back for 39 gold' });
  await expect(buy).toBeEnabled();
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await contrastIssues(shops)).toEqual([]);
  await shot(page, info, 'buyback', shops);

  // Another cell: its own card.
  await cells(shops).nth(1).click();
  await expect(details.getByRole('heading', { name: 'Iron helmet', exact: true })).toBeVisible();
  await expect(details).toContainText('Sold for 34 gold');
  await cells(shops).nth(0).click();

  await buy.click();
  await expect(details.getByRole('status').filter({ hasText: 'Bought back. Sword is in your bag again.' })).toBeVisible();
  expect(buyBacks(flow.commands)).toEqual([{ kind: 'buy-back', operationId: expect.any(String), saleId: 101 }]);
  await expect(chip(shops)).toHaveAccessibleName('Buy back (4)');
  await expect(cells(shops)).toHaveCount(4);
  await expect(shops).toContainText('4 items to buy back · your last 10 sales of this game day. 20 / 60 bag slots used.');
  await expect(shops).toContainText(/Available gold\s*61/);
  // The sword is in the bag again, with its own id (Task 33: in the Inventory section).
  const sword = flow.state.inventory.at(-1)!;
  await openSection(menu, 'Inventory');
  await expect(menu.getByTestId(`tile-${sword.id}`)).toBeVisible();
  await openSection(menu, 'Shops');
  await shot(page, info, 'buyback-after', shops);
});

// Patch 1.9 Task 33: the Buy back list pages at 5 (a list: the Show choice too); the chosen sale stays chosen while the pages turn.
test('the Buy back list shows 5 sales a page, and the chosen sale stays chosen across pages', async ({ page, context }) => {
  const more: typeof SALES = [...SALES, ['axe:1:common', 10, 110], ['spear:1:common', 10, 120]];
  await shopFlow(context, { sales: more });
  const { menu, shops } = await openBuyBack(page);
  await expect(chip(shops)).toHaveAccessibleName('Buy back (7)');
  const bar = menu.getByRole('navigation', { name: 'Pages', exact: true });
  await expect(cells(shops)).toHaveCount(5);
  await expect(bar.locator('b').first()).toHaveText('Page 1 of 2');
  await expect(bar.getByRole('combobox', { name: 'Rows per page' })).toHaveValue('5');
  await expect(bar.getByRole('combobox', { name: 'Rows per page' }).locator('option').first()).toHaveText('Fit (5)');
  await expect(cells(shops).nth(0)).toHaveAttribute('aria-pressed', 'true');
  await bar.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(bar.locator('b').first()).toHaveText('Page 2 of 2');
  await expect(cells(shops)).toHaveCount(2);
  await expect(cells(shops).nth(0)).toHaveAccessibleName('Axe, level 1, common, buy back for 10 gold');
  await expect(cells(shops).nth(0)).toBeFocused();
  // Paging changes no choice: the card is still the newest sale's.
  await expect(card(shops).getByRole('heading', { name: 'Sword', exact: true })).toBeVisible();
  await cells(shops).nth(1).click();
  await expect(card(shops).getByRole('heading', { name: 'Spear', exact: true })).toBeVisible();
  // A sort goes back to page 1, unless it keeps the chosen sale further on: by name the Spear is sixth, so page 2 shows with it.
  await shops.getByRole('combobox', { name: 'Sort the shops' }).selectOption('name');
  await expect(bar.locator('b').first()).toHaveText('Page 2 of 2');
  await expect(shops.locator('[data-buyback-cell][aria-pressed="true"]')).toHaveAccessibleName(/^Spear/);
  await shops.getByRole('combobox', { name: 'Sort the shops' }).selectOption('price');
  await expect(shops.locator('[data-buyback-cell][aria-pressed="true"]')).toHaveAccessibleName(/^Spear/);
  await expect(card(shops).getByRole('heading', { name: 'Spear', exact: true })).toBeVisible();
});

// Task 33 fix 2 (seen while filming the 1.9 candidate): pressing "Buy back for N gold" moved the Shops down by about 106 px while the purchase
// was on its way. Nothing moves while a command is pending.
test('nothing in the Shops moves while a buy back is on its way', async ({ page, context }, info) => {
  // Seen on a 1920 x 1080 desktop, after a sale and Open Buy back.
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1920, height: 1080 });
  const flow = await shopFlow(context);
  let release = () => {}, sent = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  // Registered after the flow's handler, so it runs first: the buy back waits until released, then the flow answers it.
  await context.route(`${SUPABASE_URL}/functions/v1/game-command`, async route => {
    const request = route.request();
    if (request.method() === 'POST' && !isPresence(request) && (request.postDataJSON() as GameCommand).kind === 'buy-back') { sent++; await held; }
    return route.fallback();
  });
  await page.goto('/game/');
  await expectOwnerShown(page, ownerFixture.name);
  const menu = await openMenu(page, 'Inventory and shops');
  const axe = flow.state.inventory[0];
  await menu.getByTestId(`tile-${axe.id}`).click();
  await menu.getByTestId(`item-${axe.id}`).getByRole('button', { name: 'Sell Axe · 10 gold' }).click();
  await menu.getByRole('region', { name: 'Item details' }).getByRole('button', { name: 'Open Buy back' }).click();
  const shops = shopsOf(menu);
  await expect(chip(shops)).toHaveAttribute('aria-pressed', 'true');
  const places = () => Promise.all([shops, shops.getByRole('group', { name: 'Items to buy back' }), card(shops)]
    .map(locator => locator.evaluate(element => Math.round(element.getBoundingClientRect().top))));
  // The menu scrolled to its end, as a player reading the whole card leaves it, with the button in view (the click itself scrolls nothing).
  const buy = card(shops).getByRole('button', { name: 'Buy back for 10 gold' });
  await menu.getByTestId('menu-body').evaluate(body => { body.scrollTop = body.scrollHeight; });
  await buy.scrollIntoViewIfNeeded();
  const before = await places();
  // Every frame from the press while the purchase is on its way: where the Shops, their grid and the card are.
  await shops.evaluate(element => {
    const parts = [element, element.querySelector('[role="group"][aria-label="Items to buy back"]')!, element.querySelector('[aria-label="Offer details"]')!];
    const seen: number[][] = [];
    const state = { seen, on: true };
    (window as unknown as { __shopsSeen: typeof state }).__shopsSeen = state;
    const look = () => { if (!state.on) return; seen.push(parts.map(node => Math.round(node.getBoundingClientRect().top))); requestAnimationFrame(look); };
    requestAnimationFrame(look);
  });
  await buy.click();
  await expect.poll(() => sent).toBe(1);
  for (let look = 0; look < 5; look++) {
    expect(await places()).toEqual(before);
    await page.waitForTimeout(100);
  }
  const seen = await page.evaluate(() => { const state = (window as unknown as { __shopsSeen: { seen: number[][]; on: boolean } }).__shopsSeen; state.on = false; return state.seen; });
  expect(seen.length).toBeGreaterThan(5);
  expect([...new Set(seen.map(at => at.join(',')))]).toEqual([before.join(',')]);
  release();
  await expect(card(shops).getByRole('status').filter({ hasText: 'Bought back. Axe is in your bag again.' })).toBeVisible();
  expect(buyBacks(flow.commands)).toHaveLength(1);
});

test('not enough gold turns Buy back off and says why', async ({ page, context }, info) => {
  await shopFlow(context, { money: 30 });
  const { shops } = await openBuyBack(page);
  const details = card(shops);
  await expect(details.getByRole('button', { name: /^Buy back/ })).toBeDisabled();
  await expect(details).toContainText('Not enough gold (you have 30).');
  await expect(cells(shops).nth(0)).toHaveAttribute('data-poor', '');
  await expect(cells(shops).nth(1)).toHaveAttribute('data-poor', '');
  await expect(cells(shops).nth(2)).not.toHaveAttribute('data-poor', '');
  await cells(shops).nth(2).click();
  await expect(details.getByRole('button', { name: 'Buy back for 7 gold' })).toBeEnabled();
  await shot(page, info, 'buyback-nogold', shops);
});

test('a full bag turns Buy back off', async ({ page, context }) => {
  const flow = await shopFlow(context, { bagSize: 60 });
  const { shops } = await openBuyBack(page);
  const details = card(shops);
  await expect(details).toContainText('Your bag is full (60 / 60 slots). Free a slot to buy it back.');
  await expect(details.getByRole('button', { name: /^Buy back/ })).toBeDisabled();
  await expect(shops).toContainText('60 / 60 bag slots used.');
  expect(buyBacks(flow.commands)).toEqual([]);
});

test('the empty state, then a sale: the after-sale line and Open Buy back', async ({ page, context }, info) => {
  const flow = await shopFlow(context, { sales: [] });
  const { menu, shops } = await openBuyBack(page);
  await expect(chip(shops)).toHaveAccessibleName('Buy back');
  await expect(cells(shops)).toHaveCount(0);
  await expect(shops).toContainText('Nothing to buy back. Items you sell today can be bought back until the next game day.');
  await expect(card(shops)).toContainText('Sold items show here, newest first, for the rest of the game day.');
  await expect(shops).toContainText('0 items to buy back · your last 10 sales of this game day.');
  await shot(page, info, 'buyback-empty', shops);

  // Sell the axe (in the Inventory section, Task 33): the line says where to buy it back, and Open Buy back shows the Shops section on it.
  const axe = flow.state.inventory[0];
  await openSection(menu, 'Inventory');
  await menu.getByTestId(`tile-${axe.id}`).click();
  await menu.getByTestId(`item-${axe.id}`).getByRole('button', { name: 'Sell Axe · 10 gold' }).click();
  const itemDetails = menu.getByRole('region', { name: 'Item details' });
  await expect(itemDetails.getByRole('status').filter({ hasText: 'Sold for 10 gold. You can buy it back in Shops until the next game day.' })).toBeVisible();
  await shot(page, info, 'after-sale');
  await itemDetails.getByRole('button', { name: 'Open Buy back' }).click();
  await expect(menu.getByRole('navigation', { name: 'Sections', exact: true }).locator('b').first()).toHaveText('Shops');
  await expect(chip(shops)).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(shops)).toHaveAccessibleName('Buy back (1)');
  await expect(chip(shops)).toBeFocused();
  await expect(cells(shops)).toHaveCount(1);
  await expect(cells(shops).nth(0)).toHaveAccessibleName('Axe, level 1, common, buy back for 10 gold');
  await expect(chip(shops)).toBeInViewport();
});

// Final fix wave: an owner read without `buyBack` (an older server, before M34) hides Buy back: no chip in the Shops, and a sale says only
// what it sold for, with no buy-back line and no "Open Buy back".
test('an older server without Buy back: no Buy back chip, and a sale says only what it sold for', async ({ page, context }) => {
  const flow = await shopFlow(context, { olderServer: true });
  await page.goto('/game/');
  await expectOwnerShown(page, ownerFixture.name);
  const menu = await openSection(await openMenu(page, 'Inventory and shops'), 'Shops');
  const shops = shopsOf(menu);
  await expect(filters(shops).getByRole('button')).toHaveText(['All', 'Weapons', 'Armor']);
  await expect(chip(shops)).toHaveCount(0);
  const axe = flow.state.inventory[0];
  await openSection(menu, 'Inventory');
  await menu.getByTestId(`tile-${axe.id}`).click();
  await menu.getByTestId(`item-${axe.id}`).getByRole('button', { name: 'Sell Axe · 10 gold' }).click();
  const itemDetails = menu.getByRole('region', { name: 'Item details' });
  await expect(itemDetails.getByRole('status').filter({ hasText: 'Sold Axe for 10 gold.' })).toBeVisible();
  await expect(menu).not.toContainText('buy it back');
  await expect(menu.getByRole('button', { name: 'Open Buy back' })).toHaveCount(0);
  await openSection(menu, 'Shops');
  await expect(filters(shops).getByRole('button')).toHaveText(['All', 'Weapons', 'Armor']);
  await expect(chip(shops)).toHaveCount(0);
  expect(flow.commands.map(command => command.kind)).toEqual(['sell-item']);
});

// Fix round 1: "Open Buy back" once must not keep opening Buy back: a merchant's stall clicked later opens that merchant's shop.
test('after Open Buy back, a stall opens its merchant shop, not Buy back', async ({ page, context }) => {
  const flow = await shopFlow(context, { sales: [] });
  const { menu, shops } = await openBuyBack(page);
  await shops.getByRole('group', { name: 'Shop filters', exact: true }).getByRole('button', { name: 'All', exact: true }).click();
  const axe = flow.state.inventory[0];
  await openSection(menu, 'Inventory');
  await menu.getByTestId(`tile-${axe.id}`).click();
  await menu.getByTestId(`item-${axe.id}`).getByRole('button', { name: 'Sell Axe · 10 gold' }).click();
  await menu.getByRole('region', { name: 'Item details' }).getByRole('button', { name: 'Open Buy back' }).click();
  await expect(chip(shops)).toHaveAttribute('aria-pressed', 'true');
  const inventory = menuDialog(page, 'Inventory and shops');
  const pressed = () => shopsOf(inventory).getByRole('group', { name: 'Shop filters', exact: true }).getByRole('button', { pressed: true });
  // A merchant request that reaches the open panel (the camp's `open-merchant`, as a stall sends it): the shops remount at that merchant
  // while the inventory stays, and must not take the earlier "Open Buy back" again.
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
  for (const [merchant, filter] of [['weapons', 'Weapons'], ['armor', 'Armor']] as const) {
    await page.evaluate(m => window.__cloudiatorCamp!.emit('open-merchant', { merchant: m }), merchant);
    await expect(inventory).toBeVisible();
    await expect(pressed()).toHaveText([filter]);
    await expect(chip(shopsOf(inventory))).not.toBeFocused();
  }
  // The Inventory section keeps its after-sale line and its Open Buy back (Task 33: the merchant's shop is the Shops section).
  await openSection(menu, 'Inventory');
  await expect(menu.getByRole('region', { name: 'Item details' }).getByRole('button', { name: 'Open Buy back' })).toBeVisible();
  // And a real click on each stall (the camp's click closes and reopens the menu).
  for (const [frame, filter] of [['stall-weapons', 'Weapons'], ['stall-armor', 'Armor']] as const) {
    await clickStallBeside(page, frame);
    await expect(inventory).toBeVisible();
    await expect(pressed()).toHaveText([filter]);
    await expect(chip(shopsOf(inventory))).not.toBeFocused();
  }
});

test('a sale that can no longer be bought back says so, and the list is read again', async ({ page, context }) => {
  const flow = await shopFlow(context, { refuse: 'expired' });
  const { shops } = await openBuyBack(page);
  await card(shops).getByRole('button', { name: 'Buy back for 39 gold' }).click();
  await expect(card(shops).getByRole('alert')).toHaveText('This sale can no longer be bought back. The list is up to date.');
  await expect(chip(shops)).toHaveAccessibleName('Buy back (4)');
  await expect(cells(shops)).toHaveCount(4);
  expect(buyBacks(flow.commands)).toHaveLength(1);
});

test('processing keeps the same buy back for Retry', async ({ page, context }) => {
  const flow = await shopFlow(context, { refuse: 'processing' });
  const { shops } = await openBuyBack(page);
  await card(shops).getByRole('button', { name: 'Buy back for 39 gold' }).click();
  await expect(card(shops).getByRole('alert')).toContainText('The world is processing previous results.');
  await card(shops).getByRole('button', { name: 'Retry request' }).click();
  await expect(card(shops).getByRole('status').filter({ hasText: 'Bought back. Sword is in your bag again.' })).toBeVisible();
  const [first, second] = buyBacks(flow.commands);
  expect(second.operationId).toBe(first.operationId);
});

test('the fixture preview lists sample sales and refuses the command', async ({ page }) => {
  test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'The camp harness runs on the fixture preview only.');
  await quietArrivals(page.context());
  await page.goto('/game/?mode=fixture&bag=demo');
  await expectOwnerShown(page, 'Aster');
  const menu = await openSection(await openMenu(page, 'Inventory and shops'), 'Shops');
  const shops = shopsOf(menu);
  await expect(chip(shops)).toHaveAccessibleName('Buy back (5)');
  await chip(shops).click();
  await card(shops).getByRole('button', { name: /^Buy back for \d+ gold$/ }).click();
  await expect(card(shops).getByRole('status')).toHaveText('Actions are unavailable in this preview.');
});
