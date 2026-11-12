import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Locator, type Page, type TestInfo } from './fixtures';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands';
import type { BuyBackEntry, ItemInstance } from '../../supabase/functions/_shared/contracts/reads';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1';
import { itemFixture, ownerFixture } from '../fixtures/domain';
import { emptyWorld, isPresence, routeLiveReads, seedSession, SUPABASE_URL } from './live-routes';
import { contrastIssues, noHorizontalScroll } from './a11y-helpers';
import { expectOwnerShown, openMenu, quietArrivals } from './shell-helpers';

// Patch 1.9 Task 23: Buy back in the Shops (the approved mockup, .superpowers/design/2026-11-12-feedback-buyback, notes.md "Buy back"). The owner
// read lists the gladiator's last 10 gear sales of the current game day (`OwnerState.buyBack`, Task 22's M34); the Shops show them behind a
// "Buy back (n)" chip with the same grid and card, and Buy back sends one `buy-back` command. Live mode: the development-only intercepted transport
// stands in for the server (the price is what the sale paid; the bag holds 60; the next game day is every 14,400,000 ms).
const DAY = 14_400_000;
const MIN = 60_000;

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

type Options = { money?: number; bagSize?: number; sales?: typeof SALES; refuse?: 'expired' | 'processing' };
async function shopFlow(context: BrowserContext, options: Options = {}) {
  await quietArrivals(context);
  await seedSession(context);
  const now = Date.now();
  const state = structuredClone(ownerFixture);
  state.wallets = { money: options.money ?? 100, renown: 25 };
  state.inventory = [piece('axe:1:common'), ...Array.from({ length: (options.bagSize ?? 19) - 1 }, () => piece('light-boots:1:common'))];
  let saleIds = 100;
  const entry = (catalogId: string, price: number, minutesAgo: number, item = piece(catalogId)): BuyBackEntry =>
    ({ saleId: ++saleIds, item, price, soldAtMs: now - minutesAgo * MIN, expiresAtMs: (Math.floor(now / DAY) + 1) * DAY });
  state.buyBack = (options.sales ?? SALES).map(([id, price, ago]) => entry(id, price, ago));
  const live = await routeLiveReads(context, { world: emptyWorld(now), owner: state });
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
      state.buyBack = [entry(sold.catalogId, price, 0, sold), ...state.buyBack].slice(0, 10);
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

async function openBuyBack(page: Page) {
  await page.goto('/game/');
  await expectOwnerShown(page, ownerFixture.name);
  const menu = await openMenu(page, 'Inventory and shops');
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
  const details = card(shops);
  await expect(details.getByRole('heading', { name: 'Sword', exact: true })).toBeVisible();
  await expect(details).toContainText('Level 5 · rare · Tradable');
  await expect(details).toContainText(/Damage\s*11\.7/);
  await expect(details).toContainText(/Sold for 39 gold · today \d{1,2}:\d{2}/);
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
  // The sword is in the bag again, with its own id.
  const sword = flow.state.inventory.at(-1)!;
  await expect(menu.getByTestId(`tile-${sword.id}`)).toBeVisible();
  await shot(page, info, 'buyback-after', shops);
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

  // Sell the axe: the line says where to buy it back, and Open Buy back shows it on top.
  const axe = flow.state.inventory[0];
  await menu.getByTestId(`tile-${axe.id}`).click();
  await menu.getByTestId(`item-${axe.id}`).getByRole('button', { name: 'Sell Axe · 10 gold' }).click();
  const itemDetails = menu.getByRole('region', { name: 'Item details' });
  await expect(itemDetails.getByRole('status').filter({ hasText: 'Sold for 10 gold. You can buy it back in Shops until the next game day.' })).toBeVisible();
  await shot(page, info, 'after-sale');
  await itemDetails.getByRole('button', { name: 'Open Buy back' }).click();
  await expect(chip(shops)).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(shops)).toHaveAccessibleName('Buy back (1)');
  await expect(chip(shops)).toBeFocused();
  await expect(cells(shops)).toHaveCount(1);
  await expect(cells(shops).nth(0)).toHaveAccessibleName('Axe, level 1, common, buy back for 10 gold');
  await expect(chip(shops)).toBeInViewport();
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
  const menu = await openMenu(page, 'Inventory and shops');
  const shops = shopsOf(menu);
  await expect(chip(shops)).toHaveAccessibleName('Buy back (5)');
  await chip(shops).click();
  await card(shops).getByRole('button', { name: /^Buy back for \d+ gold$/ }).click();
  await expect(card(shops).getByRole('status')).toHaveText('Actions are unavailable in this preview.');
});
