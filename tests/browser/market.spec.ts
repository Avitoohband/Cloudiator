import { test, expect, type BrowserContext, type Locator, type Page } from './fixtures';
import { randomUUID } from 'node:crypto';
import type { ApiErrorCode, GameCommand } from '../../supabase/functions/_shared/contracts/commands';
import type { ItemInstance, MarketListing, OwnerState, WorldSnapshot } from '../../supabase/functions/_shared/contracts/reads';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1';
import { WHOLE_PRICE_TEXT } from '../../src/features/market/market-text';
import { ARENA_OWNER } from '../fixtures/arena-build';
import { itemFixture, worldFixture } from '../fixtures/domain';
import { MARKET_ROWS } from '../fixtures/market';
import { SUPABASE_URL, isPresence, routeLiveReads, seedSession, type LiveTransport } from './live-routes';
import { expectOwnerShown, joinButton, openMenu } from './shell-helpers';
import { a11yShot, contrastIssues, focusDrops, watchFocus } from './a11y-helpers';
import { forbidRemote } from './remote';

// Task 18.3: the 💰 Marketplace menu. Anyone browses the open offers (the public `market_offers` projection); a player
// buys (after a confirmation), lists an eligible item and cancels a listing through the authenticated command endpoint.
// A stale page's purchase is explained and the page refreshed (Review Focus 4); a visitor sends no command and never sees
// a trading control (Review Focus 5). Live reads come from `routeLiveReads`; this spec answers the commands itself.

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
/** The database's fee (launch feedback): 5 % floored but at least 1, `greatest(1, price*5/100)`; its lowest listing price is 2. */
const feeOf = (price: number) => Math.max(RULES_V1.fees.marketMinimum, Math.floor(price * 5 / 100));
const LOWEST_PRICE = 'The lowest price is 2 money, so you always receive something after the fee.';
const escaped = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const world = (): WorldSnapshot => ({ ...worldFixture, revision: 'live-1' });
const offer = (catalogId: string) => MARKET_ROWS.find(row => row.item.catalogId === catalogId)!;
const SPEAR = offer('spear:10:rare'), SHIELD = offer('round-shield:1:common'), BOOTS = offer('heavy-boots:10:uncommon'), AXE = offer('axe:5:common');
/** The fixture owner's own offer: Aster's Iron helmet, reserved in her inventory by that listing. */
const HELMET = MARKET_ROWS.find(row => row.seller.gladiatorId === ARENA_OWNER.gladiatorId)!;

/** Every request the page sends to an Edge Function (the game's commands). */
function watchCommands(page: Page) {
  const sent: string[] = [];
  page.on('request', request => { if (request.url().includes('/functions/v1/')) sent.push(request.url()); });
  return sent;
}
const row = (scope: Locator, listing: MarketListing) => scope.getByTestId(`listing-${listing.listingId}`);
const itemName = (listing: MarketListing) => CATALOG_V1.items[listing.item.catalogId].name;
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
/** Waits until the camp scene is drawn, so a capture for the visual review shows the camp behind the menu. */
const campReady = (page: Page) => page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });

type Flow = {
  live: LiveTransport; state: OwnerState; offers: MarketListing[]; commands: GameCommand[]; bought: ItemInstance[];
  /** The listable axe, and the items that must never be offered for sale. */
  listable: ItemInstance;
  /** The server's next answer, whatever the command: a refusal with no effect (`processing` after a deadlock, `rate-limited`). */
  answerNext(code: ApiErrorCode): void;
  /** The listing is gone on the server (bought, expired or cancelled elsewhere) and its purchase answers `code`. */
  close(listing: MarketListing, code: 'sold' | 'expired' | 'not-found'): void;
  /** The next response is lost after the server committed it (a retry replays the stored receipt). */
  loseNext(): void;
  /** A listing the player made before the page loaded: its item is in her inventory, reserved by its open offer. */
  listed(catalogId: string, price: number): { listing: MarketListing; item: ItemInstance };
  /**
   * Another buyer bought the player's own listing: the item leaves her inventory and she is credited the price less the fee,
   * with no new world revision (Ruling 2).
   */
  soldElsewhere(listing: MarketListing): void;
};

/**
 * A signed-in Aster with 2,000 money and the fixture market. Her inventory holds the helmet she listed, one listable axe,
 * and items that cannot be listed: bound renown gear, an equipped (reserved) armor and a salvage stack.
 */
async function marketFlow(context: BrowserContext): Promise<Flow> {
  const state: OwnerState = structuredClone(ARENA_OWNER);
  state.wallets.money = 2_000;
  const listable = { ...itemFixture(CATALOG_V1.items['axe:5:common']), id: randomUUID() };
  const armor: ItemInstance = { ...itemFixture(CATALOG_V1.items['light-armor:1:common']), id: randomUUID(), reservation: { kind: 'equipment', referenceId: state.gladiatorId } };
  const salvage: ItemInstance = { id: randomUUID(), ownerId: state.gladiatorId, catalogId: 'salvage', catalogVersion: CATALOG_V1.version, tier: 1, rarity: 'common',
    stats: structuredClone(CATALOG_V1.salvage.stats), quantity: 12, origin: 'expedition', binding: 'tradable', reservation: null };
  state.inventory.push(listable, { ...itemFixture(CATALOG_V1.items['sword:1:renown']), id: randomUUID() }, armor, salvage);
  state.currentBuild.equipment.body = armor.id;
  const offers = MARKET_ROWS.map(o => structuredClone(o));
  await seedSession(context);
  const live = await routeLiveReads(context, { world: world(), owner: state, market: offers });
  const commands: GameCommand[] = [], bought: ItemInstance[] = [];
  const receipts = new Map<string, unknown>(), refusals = new Map<string, ApiErrorCode>(), next: ApiErrorCode[] = [];
  let lose = false;
  const publish = () => { live.setOwner(state); live.setMarket(offers); };
  const take = (listingId: string) => {
    const at = offers.findIndex(o => o.listingId === listingId);
    return at < 0 ? null : offers.splice(at, 1)[0];
  };
  function commit(command: GameCommand): unknown {
    const refused = (code: ApiErrorCode) => ({ ok: false, code });
    if (command.kind === 'buy-listing') {
      const refusal = refusals.get(command.listingId);
      if (refusal) return refused(refusal);
      const listing = take(command.listingId);
      if (!listing) return refused('not-found');
      const item: ItemInstance = { id: randomUUID(), ownerId: state.gladiatorId, ...structuredClone(listing.item), origin: 'shop', binding: 'tradable', reservation: null };
      state.inventory.push(item); bought.push(item);
      state.wallets.money -= listing.price;
      return { ok: true, receiptId: randomUUID(), value: { listingId: listing.listingId, itemId: item.id, price: listing.price, fee: feeOf(listing.price) } };
    }
    if (command.kind === 'create-listing') {
      const item = state.inventory.find(i => i.id === command.itemId);
      if (!item || item.reservation || command.price < RULES_V1.marketplace.minimumPrice) return refused('invalid');
      const listingId = randomUUID(), listedAtMs = live.serverNowMs(), expiresAtMs = listedAtMs + RULES_V1.marketplace.expiryMs;
      item.reservation = { kind: 'listing', referenceId: listingId };
      const { catalogId, catalogVersion, tier, rarity, stats, quantity } = item;
      offers.unshift({ listingId, seller: { gladiatorId: state.gladiatorId, name: state.name }, item: { catalogId, catalogVersion, tier, rarity, stats, quantity },
        price: command.price, listedAtMs, expiresAtMs });
      return { ok: true, receiptId: randomUUID(), value: { listingId, expiresAtMs } };
    }
    if (command.kind === 'cancel-listing') {
      const listing = offers.find(o => o.listingId === command.listingId);
      if (!listing || listing.seller.gladiatorId !== state.gladiatorId) return refused('not-found');
      take(command.listingId);
      const item = state.inventory.find(i => i.reservation?.kind === 'listing' && i.reservation.referenceId === command.listingId)!;
      item.reservation = null;
      return { ok: true, receiptId: randomUUID(), value: { listingId: command.listingId, itemId: item.id } };
    }
    throw new Error(`Unexpected market command ${command.kind}`);
  }
  await context.route(`${SUPABASE_URL}/functions/v1/game-command`, async route => {
    const request = route.request();
    // The player's presence (Task 23.9) is the live transport's.
    if (request.method() !== 'POST' || isPresence(request)) return route.fallback();
    const command = request.postDataJSON() as GameCommand;
    commands.push(command);
    expect(request.headers().authorization).toMatch(/^Bearer /);
    expect(command).not.toHaveProperty('ownerId');
    const json = (body: unknown, status = 200) => route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    const transient = next.shift();
    if (transient) return json({ ok: false, code: transient, retryAfterMs: 1000 }, transient === 'rate-limited' ? 429 : 409);
    let result = receipts.get(command.operationId);
    if (!result) {
      result = commit(command);
      receipts.set(command.operationId, result);
      publish();
    }
    if (lose) { lose = false; return route.abort('failed'); }
    return json(result, (result as { ok: boolean }).ok ? 200 : 409);
  });
  return {
    live, state, offers, commands, bought, listable,
    answerNext: code => { next.push(code); },
    close: (listing, code) => { refusals.set(listing.listingId, code); take(listing.listingId); publish(); },
    loseNext: () => { lose = true; },
    listed: (catalogId, price) => {
      const listingId = randomUUID(), listedAtMs = live.serverNowMs() - 60_000;
      const item: ItemInstance = { ...itemFixture(CATALOG_V1.items[catalogId]), id: randomUUID(), ownerId: state.gladiatorId,
        reservation: { kind: 'listing', referenceId: listingId } };
      state.inventory.push(item);
      const { catalogVersion, tier, rarity, stats, quantity } = item;
      const listing: MarketListing = { listingId, seller: { gladiatorId: state.gladiatorId, name: state.name },
        item: { catalogId, catalogVersion, tier, rarity, stats, quantity }, price, listedAtMs, expiresAtMs: listedAtMs + RULES_V1.marketplace.expiryMs };
      offers.push(listing);
      publish();
      return { listing, item };
    },
    soldElsewhere: listing => {
      take(listing.listingId);
      state.inventory = state.inventory.filter(i => !(i.reservation?.kind === 'listing' && i.reservation.referenceId === listing.listingId));
      state.wallets.money += listing.price - feeOf(listing.price);
      publish();
    },
  };
}

/** The signed-in camp with the Marketplace open at Browse, its listings loaded. */
async function openMarket(page: Page, offers = MARKET_ROWS.length) {
  await page.goto('/game/');
  await expectOwnerShown(page, 'Aster');
  const market = await openMenu(page, 'Marketplace');
  await expect(market.getByRole('tab', { name: 'Browse', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(market.getByRole('list', { name: 'Open listings' }).getByRole('listitem')).toHaveCount(offers);
  return market;
}

/** Buys `listing` from its row, through the confirmation. */
async function buy(page: Page, market: Locator, listing: MarketListing) {
  await row(market, listing).getByRole('button', { name: `Buy ${itemName(listing)} for ${listing.price.toLocaleString('en-US')} money`, exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm purchase' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Confirm purchase', exact: true }).click();
  await expect(confirm).toBeHidden();
}

test.beforeEach(() => { test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Live mode uses development-only intercepted Supabase transport.'); });

test('lets a visitor browse listings with no command and no buy or sell controls', { tag: '@render' }, async ({ page, context }, info) => {
  const live = await routeLiveReads(context, { world: world(), market: MARKET_ROWS });
  const commands = watchCommands(page);
  await page.goto('/game/');
  await expect(joinButton(page)).toBeVisible();
  const market = await openMenu(page, 'Marketplace');
  const list = market.getByRole('list', { name: 'Open listings' });
  await expect(list.getByRole('listitem')).toHaveCount(MARKET_ROWS.length);
  for (const listing of MARKET_ROWS) {
    const offerRow = row(market, listing);
    await expect(offerRow).toContainText(itemName(listing));
    await expect(offerRow).toContainText(listing.seller.name);
    await expect(offerRow).toContainText(`${listing.price.toLocaleString('en-US')} money`);
    await expect(offerRow).toContainText(`NPC sale value: ${CATALOG_V1.items[listing.item.catalogId].npcSellValue} money`);
    await expect(offerRow).toContainText(/\d+ (d|h|min)( \d+ (h|min))? left/);
  }
  await expect(market.getByText('Browsing only. Sign in to buy or sell.')).toBeVisible();
  await expect(market.getByRole('button', { name: 'Sign in with Google to trade' })).toBeEnabled();
  // Browse only: no tabs, and no Buy, Cancel or Sell control, and no wallet.
  await expect(market.getByRole('tab')).toHaveCount(0);
  await expect(market.getByRole('button', { name: /^(Buy|Cancel listing|List for sale)/ })).toHaveCount(0);
  await expect(market.getByText(/My listings|Available money/)).toHaveCount(0);
  await campReady(page);
  await page.screenshot({ path: info.outputPath(`market-visitor-browse-${info.project.name}.png`) });
  // Read-only: public offer pages as a visitor, never the owner state or a seller's page, and no command.
  expect(commands).toEqual([]);
  expect(live.count('market_offers')).toBeGreaterThan(0);
  expect(live.requests.every(r => r.reader === null)).toBe(true);
  expect(live.count('owner_state')).toBe(0);
  expect(live.requests.filter(r => r.table === 'market_offers').some(r => r.query.has('seller_gladiator_id'))).toBe(false);
});

test('shows a signed-in account without a gladiator Browse only, with no trading control', async ({ page, context }) => {
  // Ruling 5: signed in, but no gladiator yet: the offers, "Create your gladiator to trade", and no Buy, Sell or My listings.
  await seedSession(context);
  const live = await routeLiveReads(context, { world: world(), owner: null, market: MARKET_ROWS });
  const commands = watchCommands(page);
  await page.goto('/game/');
  const creation = page.getByRole('dialog', { name: 'Create your gladiator', exact: true });
  await creation.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(creation).toBeHidden();
  const market = await openMenu(page, 'Marketplace');
  await expect(market.getByRole('list', { name: 'Open listings' }).getByRole('listitem')).toHaveCount(MARKET_ROWS.length);
  await expect(market.getByText('Create your gladiator to trade.')).toBeVisible();
  await expect(market.getByRole('tab')).toHaveCount(0);
  await expect(market.getByRole('button', { name: /^(Buy|Cancel listing|List for sale|Sign in)/ })).toHaveCount(0);
  await expect(market.getByText(/My listings|Available money/)).toHaveCount(0);
  expect(commands).toEqual([]);
  expect(live.count('market_offers')).toBeGreaterThan(0);
});

test('buys a listing, shows the receipt and the item in inventory', { tag: '@render' }, async ({ page, context }, info) => {
  const flow = await marketFlow(context);
  const market = await openMarket(page);
  await expect(market.getByText('Available money: 2,000')).toBeVisible();
  // The player's own offer is marked, and cannot be bought.
  await expect(row(market, HELMET)).toContainText('Your listing');
  await expect(row(market, HELMET).getByRole('button')).toHaveCount(0);
  await campReady(page);
  await page.screenshot({ path: info.outputPath(`market-browse-${info.project.name}.png`) });
  // Buying asks first; keeping browsing sends nothing.
  await row(market, SPEAR).getByRole('button', { name: 'Buy Spear for 450 money', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm purchase' });
  await expect(confirm).toContainText('Buy Spear (Level 10 · Rare) from Varro for 450 money?');
  await confirm.getByRole('button', { name: 'Keep browsing', exact: true }).click();
  await expect(confirm).toBeHidden();
  expect(flow.commands).toHaveLength(0);
  await buy(page, market, SPEAR);
  const receipt = market.getByRole('status').filter({ hasText: 'Purchase confirmed' });
  await expect(receipt).toContainText('Spear for 450 money');
  await expect(receipt).toContainText('now in your inventory');
  await expect(receipt).toContainText(/Receipt [0-9a-f]{8}/);
  expect(flow.commands).toEqual([{ kind: 'buy-listing', operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), listingId: SPEAR.listingId }]);
  // The page and the wallet are refreshed: the offer is gone and the price is paid.
  await expect(row(market, SPEAR)).toHaveCount(0);
  await expect(market.getByText('Available money: 1,550')).toBeVisible();
  const inventory = await openMenu(page, 'Inventory and shops');
  await expect(inventory.getByTestId(`item-${flow.bought[0].id}`)).toContainText('Spear');
  await expect(inventory.getByTestId(`item-${flow.bought[0].id}`)).toContainText('Level 10 · rare · Tradable');
});

test('lists an eligible item with the fee and NPC value shown, then cancels it', { tag: '@render' }, async ({ page, context }, info) => {
  const flow = await marketFlow(context);
  const market = await openMarket(page);
  // The tabs answer the arrow keys.
  await market.getByRole('tab', { name: 'Browse', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(market.getByRole('tab', { name: 'My listings', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(market.getByRole('tab', { name: 'My listings', exact: true })).toBeFocused();
  await market.getByRole('tab', { name: 'Sell', exact: true }).click();
  const sell = market.getByRole('tabpanel', { name: 'Sell' });
  // Equipment only, and only what can be sold: not the listed helmet, the bound renown sword, the equipped armor or salvage.
  await expect(sell.getByRole('radio')).toHaveCount(1);
  await expect(sell).toContainText('Active listings: 1 of 5');
  await sell.getByRole('radio', { name: /^Axe/ }).check();
  await expect(sell).toContainText('NPC sale value: 30 money');
  const price = sell.getByLabel('Price in money');
  const listButton = sell.getByRole('button', { name: 'List for sale', exact: true });
  await expect(sell).toContainText('A whole price from 2 to 1,000,000,000.');
  // Below 2 the lowest price is explained, nothing is offered to list, and no breakdown is shown.
  for (const low of ['0', '1']) {
    await price.fill(low);
    await expect(listButton).toBeDisabled();
    await expect(sell.getByRole('status').filter({ hasText: LOWEST_PRICE })).toBeVisible();
    await expect(price).toHaveAttribute('aria-invalid', 'true');
    await expect(sell).not.toContainText('Market fee');
  }
  // The lowest price pays the minimum fee of 1 and the seller receives 1; Avi's 11 pays 1 (5 % floored to 0 before), not nothing.
  await price.fill('2');
  await expect(listButton).toBeEnabled();
  await expect(price).not.toHaveAttribute('aria-invalid', 'true');
  await expect(sell).not.toContainText(LOWEST_PRICE);
  await expect(sell).toContainText('Buyer pays: 2 money');
  await expect(sell).toContainText('Market fee (5%, at least 1): 1 money');
  await expect(sell).toContainText('You receive: 1 money');
  await price.fill('11');
  await expect(sell).toContainText('Buyer pays: 11 money');
  await expect(sell).toContainText('Market fee (5%, at least 1): 1 money');
  await expect(sell).toContainText('You receive: 10 money');
  // From 40 the floored 5 % is above the minimum.
  await price.fill('101');
  await expect(sell).toContainText('Buyer pays: 101 money');
  await expect(sell).toContainText('Market fee (5%, at least 1): 5 money');
  await expect(sell).toContainText('You receive: 96 money');
  await campReady(page);
  await page.screenshot({ path: info.outputPath(`market-sell-${info.project.name}.png`) });
  await sell.getByRole('button', { name: 'List for sale', exact: true }).click();
  await expect(market.getByRole('status').filter({ hasText: 'Listed for sale: Axe at 101 money' })).toBeVisible();
  expect(flow.commands).toEqual([{ kind: 'create-listing', operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), itemId: flow.listable.id, price: 101 }]);
  const listingId = (flow.listable.reservation as { referenceId: string }).referenceId;
  // The listed axe is reserved: nothing more to list.
  await expect(sell.getByRole('radio')).toHaveCount(0);
  await expect(sell).toContainText('Active listings: 2 of 5');
  await market.getByRole('tab', { name: 'My listings', exact: true }).click();
  const mine = market.getByRole('tabpanel', { name: 'My listings' });
  await expect(mine.getByRole('listitem')).toHaveCount(2);
  await expect(mine.getByTestId(`listing-${listingId}`)).toContainText('You receive 96 money after the market fee (5%, at least 1)');
  await campReady(page);
  await page.screenshot({ path: info.outputPath(`market-my-listings-${info.project.name}.png`) });
  expect(flow.live.requests.filter(r => r.table === 'market_offers').some(r => r.query.get('seller_gladiator_id') === `eq.${flow.state.gladiatorId}`)).toBe(true);
  // Inventory says the axe is listed for sale.
  const inventory = await openMenu(page, 'Inventory and shops');
  await expect(inventory.getByTestId(`item-${flow.listable.id}`)).toContainText('Listed for sale');
  await expect(inventory.getByTestId(`item-${flow.listable.id}`).getByRole('button', { name: 'Sell' })).toBeDisabled();
  const again = await openMenu(page, 'Marketplace');
  await again.getByRole('tab', { name: 'My listings', exact: true }).click();
  await again.getByRole('button', { name: 'Cancel listing: Axe for 101 money', exact: true }).click();
  await expect(again.getByRole('status').filter({ hasText: 'Listing cancelled. Axe is back in your inventory.' })).toBeVisible();
  await expect(again.getByRole('tabpanel', { name: 'My listings' }).getByRole('listitem')).toHaveCount(1);
  expect(flow.commands.map(c => c.kind)).toEqual(['create-listing', 'cancel-listing']);
  expect(flow.commands[1]).toMatchObject({ listingId });
  const back = await openMenu(page, 'Inventory and shops');
  await expect(back.getByTestId(`item-${flow.listable.id}`)).toContainText('Available');
});

test('explains sold and expired results and refreshes the page', { tag: '@render' }, async ({ page, context }) => {
  const flow = await marketFlow(context);
  const market = await openMarket(page);
  // Each time, the page is stale: another buyer took the spear, the boots' listing expired, then Cassia cancelled her shield,
  // all after the page last read the offers.
  const alert = market.getByRole('alert');
  const cases = [[SPEAR, 'sold', /already sold.*refreshed/], [BOOTS, 'expired', /expired.*refreshed/], [SHIELD, 'not-found', /no longer open.*refreshed/]] as const;
  for (const [listing, code, explained] of cases) {
    flow.close(listing, code);
    await expect(row(market, listing)).toHaveCount(1);
    const reads = flow.live.count('market_offers');
    await buy(page, market, listing);
    await expect(alert).toHaveText(explained);
    await expect(row(market, listing)).toHaveCount(0);
    expect(flow.live.count('market_offers')).toBeGreaterThan(reads);
    // Nothing to retry: the outcome is final.
    await expect(market.getByRole('button', { name: 'Retry request' })).toHaveCount(0);
  }
  expect(flow.commands.map(c => (c as { listingId: string }).listingId)).toEqual([SPEAR.listingId, BOOTS.listingId, SHIELD.listingId]);
  expect(new Set(flow.commands.map(c => c.operationId)).size).toBe(3);
  await expect(market.getByText('Available money: 2,000')).toBeVisible();
  expect(flow.bought).toEqual([]);
});

test('reads the owner when the menu opens and on Refresh, after listings sold elsewhere', { tag: '@render' }, async ({ page, context }) => {
  // Final review I1: a sale changes the seller's wallet and inventory without a new world revision (Ruling 2), so nothing
  // else reads her owner state again. Aster has 1,000 money and five listings; two sell while the menu is closed.
  const flow = await marketFlow(context);
  flow.state.wallets.money = 1_000;
  const [hood, sword, , boots] = ([['leather-hood:5:common', 200], ['sword:5:common', 300], ['bow:1:common', 400], ['light-boots:1:uncommon', 500]] as const)
    .map(([catalogId, price]) => flow.listed(catalogId, price));
  const owners = () => flow.live.count('owner_state');
  await page.goto('/game/');
  await expectOwnerShown(page, 'Aster');
  const read = owners();
  expect(read).toBeGreaterThan(0);
  flow.soldElsewhere(sword.listing);
  flow.soldElsewhere(boots.listing);
  const market = await openMenu(page, 'Marketplace');
  // My listings counts three, and so does Sell, whose List for sale is enabled again.
  await market.getByRole('tab', { name: 'My listings', exact: true }).click();
  await expect(market.getByRole('tabpanel', { name: 'My listings' }).getByRole('listitem')).toHaveCount(3);
  await market.getByRole('tab', { name: 'Sell', exact: true }).click();
  const sell = market.getByRole('tabpanel', { name: 'Sell' });
  await expect(sell).toContainText('Active listings: 3 of 5');
  await sell.getByRole('radio', { name: /^Axe/ }).check();
  await sell.getByLabel('Price in money').fill('100');
  await expect(sell.getByRole('button', { name: 'List for sale', exact: true })).toBeEnabled();
  // The available money includes the proceeds (1,000 + 285 + 475), so Cassia's bow at 1,250 can be bought.
  await expect(market.getByText('Available money: 1,760')).toBeVisible();
  await market.getByRole('tab', { name: 'Browse', exact: true }).click();
  await expect(row(market, offer('bow:10:common')).getByRole('button', { name: /^Buy/ })).toBeEnabled();
  // One owner read for the opening, however many tabs were shown since.
  expect(owners()).toBe(read + 1);
  // A third listing sells while the menu is open: Refresh reads the owner again, once.
  flow.soldElsewhere(hood.listing);
  await market.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(market.getByText('Available money: 1,950')).toBeVisible();
  await market.getByRole('tab', { name: 'Sell', exact: true }).click();
  await expect(sell).toContainText('Active listings: 2 of 5');
  expect(owners()).toBe(read + 2);
  expect(flow.commands).toEqual([]);
  // Inventory shows the same owner: the sold items are gone.
  const inventory = await openMenu(page, 'Inventory and shops');
  for (const sold of [sword, boots, hood]) await expect(inventory.getByTestId(`item-${sold.item.id}`)).toHaveCount(0);
});

test('keeps a failed purchase input for a retry with the same operation', { tag: '@render' }, async ({ page, context }) => {
  const flow = await marketFlow(context);
  const market = await openMarket(page);
  const alert = market.getByRole('alert');
  // The world is processing (a slot behind, or a deadlock the server rolled back): nothing changes, and Retry replays the
  // same operation (the Task 18.2 review's item carried to 18.3: keep the same operationId on `processing`).
  flow.answerNext('processing');
  await buy(page, market, SHIELD);
  await expect(alert).toContainText('processing');
  await expect(row(market, SHIELD)).toHaveCount(1);
  await market.getByRole('button', { name: 'Retry request', exact: true }).click();
  await expect(market.getByRole('status').filter({ hasText: 'Purchase confirmed' })).toContainText('Round shield for 18 money');
  expect(flow.commands).toHaveLength(2);
  expect(flow.commands[1]).toEqual(flow.commands[0]);
  // Rate limited: buying the same listing again (not Retry) still sends the same operation.
  flow.answerNext('rate-limited');
  await buy(page, market, AXE);
  await expect(alert).toContainText('retry');
  await buy(page, market, AXE);
  await expect(market.getByRole('status').filter({ hasText: 'Purchase confirmed' })).toContainText('Axe for 90 money');
  expect(flow.commands[3]).toEqual(flow.commands[2]);
  // A lost response after the server committed: Retry replays the stored receipt, and the item is bought once.
  flow.loseNext();
  await buy(page, market, BOOTS);
  await expect(alert).toContainText('could not be confirmed');
  await market.getByRole('button', { name: 'Retry request', exact: true }).click();
  await expect(market.getByRole('status').filter({ hasText: 'Purchase confirmed' })).toContainText('Heavy boots for 240 money');
  expect(flow.commands[5]).toEqual(flow.commands[4]);
  expect(new Set(flow.commands.map(c => c.operationId)).size).toBe(3);
  expect(flow.bought.map(item => item.catalogId)).toEqual(['round-shield:1:common', 'axe:5:common', 'heavy-boots:10:uncommon']);
  await expect(market.getByText('Available money: 1,652')).toBeVisible();
});

test('fits the Marketplace sheet at 360 px with no horizontal scroll', async ({ page, context }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await marketFlow(context);
  const market = await openMarket(page);
  const fits = async (label: string) => {
    // Measured where the sheet stays: after its rise (an animation) has ended.
    await market.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    const box = (await market.boundingBox())!;
    expect(box.x, label).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, label).toBeLessThanOrEqual(360);
    expect(box.y + box.height, label).toBeLessThanOrEqual(640.5);
    expect(await noHorizontalScroll(page), label).toBe(true);
    expect(await market.getByTestId('menu-body').evaluate(el => el.scrollWidth <= el.clientWidth), label).toBe(true);
  };
  await fits('Browse');
  await row(market, BOOTS).getByRole('button', { name: /^Buy/ }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm purchase' });
  const dialog = (await confirm.boundingBox())!;
  expect(dialog.x).toBeGreaterThanOrEqual(0);
  expect(dialog.x + dialog.width).toBeLessThanOrEqual(360);
  await confirm.getByRole('button', { name: 'Keep browsing', exact: true }).click();
  await market.getByRole('tab', { name: 'My listings', exact: true }).click();
  await expect(market.getByRole('tabpanel', { name: 'My listings' }).getByRole('listitem')).toHaveCount(1);
  await fits('My listings');
  await market.getByRole('tab', { name: 'Sell', exact: true }).click();
  const sell = market.getByRole('tabpanel', { name: 'Sell' });
  await sell.getByRole('radio', { name: /^Axe/ }).check();
  await sell.getByLabel('Price in money').fill('1000000000');
  await expect(sell).toContainText('You receive: 950,000,000 money');
  await fits('Sell');
});

// Task 23.5 (C18, carried from the Task 18 review): the focus after a trade, and the coverage gaps.

for (const kind of ['create-listing', 'buy-listing', 'cancel-listing'] as const) {
  test(`keeps keyboard focus on a busy market ${kind} button and ignores repeated activation`, async ({ page, context }) => {
    await watchFocus(page);
    const flow = await marketFlow(context);
    flow.answerNext('processing');
    let release!: () => void;
    const reply = new Promise<void>(resolve => { release = resolve; });
    let requests = 0;
    await context.route(`${SUPABASE_URL}/functions/v1/game-command`, async route => {
      if (route.request().method() !== 'POST' || route.request().postDataJSON().kind !== kind) return route.fallback();
      requests++;
      await reply;
      return route.fallback();
    });
    const market = await openMarket(page);
    let button: Locator;
    if (kind === 'create-listing') {
      await market.getByRole('tab', { name: 'Sell', exact: true }).click();
      await market.getByRole('radio', { name: /^Axe/ }).check();
      await market.getByLabel('Price in money').fill('120');
      button = market.getByRole('button', { name: 'List for sale', exact: true });
    } else if (kind === 'cancel-listing') {
      await market.getByRole('tab', { name: 'My listings', exact: true }).click();
      button = row(market, HELMET).getByRole('button', { name: /^Cancel listing:/ });
    } else button = row(market, SHIELD).getByRole('button', { name: /^Buy/ });
    await button.focus();
    if (kind === 'buy-listing') {
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: 'Confirm purchase' }).getByRole('button', { name: 'Keep browsing' })).toBeFocused();
      await page.keyboard.press('Tab');
    }
    const sent = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/game-command') && request.postDataJSON().kind === kind);
    await page.keyboard.press('Enter');
    await sent;
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    try {
      await frames();
      await page.evaluate(() => { document.head.append(document.createElement('script')); });
      await frames();
      expect(await focusDrops(page)).toEqual([]);
      await expect(button).toBeFocused();
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(button).not.toHaveAttribute('disabled');
      expect(await contrastIssues(button)).toEqual([]);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      await button.click({ force: true });
      await frames();
      await expect(page.getByRole('dialog', { name: 'Confirm purchase' })).not.toBeVisible();
      expect(requests).toBe(1);
    } finally { release(); }
    const refused = market.getByRole('alert');
    await expect(refused).toContainText('processing');
    await expect(button).toBeFocused();
    await expect(refused).not.toBeFocused();
    await expect(refused).toHaveAttribute('data-focus-target', '');
    expect(flow.commands.map(command => command.kind)).toEqual([kind]);
    expect(await focusDrops(page)).toEqual([]);
  });
}

test('pins the purchase confirmation in an accessibility snapshot', async ({ page, context }) => {
  // Plan Decision 8 (Task 23.5 fix round 1, I3).
  await marketFlow(context);
  const market = await openMarket(page);
  await row(market, SPEAR).getByRole('button', { name: /^Buy/ }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm purchase' })).toMatchAriaSnapshot(`
    - dialog "Confirm purchase":
      - heading "Confirm purchase" [level=2]
      - paragraph: Buy Spear (Level 10 · Rare) from Varro for 450 money?
      - paragraph: "Available money after the purchase: 1,550 money."
      - button "Keep browsing"
      - button "Confirm purchase"
  `);
});

test('leaves the focus and the scroll where they are after a pointer trade', async ({ page, context }) => {
  // Fix round 1 (the controller's ruling on review Minor 1): a trade sent with the pointer moves nothing. The bought row
  // leaves, so the focus goes to the menu panel without scrolling it, never to the receipt or <body>.
  await watchFocus(page);
  const flow = await marketFlow(context);
  const market = await openMarket(page);
  const body = market.getByTestId('menu-body');
  await body.evaluate(el => { el.scrollTop = 120; });
  const before = await body.evaluate(el => el.scrollTop);
  expect(before).toBeGreaterThan(0);
  // A real pointer click at the button where it is: a locator click may scroll its target into view first. On a phone the
  // menu is a bottom sheet that rises into place as it opens (`rise`, 0.2 s, in shell.module.css), so a box read during the
  // rise is below the button by the time the click lands (Task 24.0b: under load the point fell beside Axe's Buy and no
  // confirmation opened). The button is measured once the sheet has stopped moving.
  await market.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
  const axeBuy = row(market, AXE).getByRole('button', { name: /^Buy/ });
  const buy = (await axeBuy.boundingBox())!;
  const view = (await body.boundingBox())!;
  expect(buy.y >= view.y && buy.y + buy.height <= view.y + view.height, 'Buy is in view').toBe(true);
  const point = { x: buy.x + buy.width / 2, y: buy.y + buy.height / 2 };
  // What the pointer will land on: Axe's Buy itself, not whatever lies at that point by the time the click arrives.
  expect(await axeBuy.evaluate((button, { x, y }) => {
    const at = document.elementFromPoint(x, y);
    if (at && (at === button || button.contains(at))) return 'the Axe Buy button';
    return at ? `${at.tagName} ${at.closest('button')?.getAttribute('aria-label') ?? at.closest('[data-testid]')?.getAttribute('data-testid') ?? ''}`.trim() : 'nothing';
  }, point), 'the element at the click point').toBe('the Axe Buy button');
  await page.mouse.click(point.x, point.y);
  const confirm = page.getByRole('dialog', { name: 'Confirm purchase' });
  await expect(confirm).toBeVisible();
  // The confirmation is for the Axe, before it is confirmed.
  await expect(confirm).toContainText(`Buy ${itemName(AXE)} (Level 5 · Common) from ${AXE.seller.name} for 90 money?`);
  expect(await body.evaluate(el => el.scrollTop)).toBe(before);
  await confirm.getByRole('button', { name: 'Confirm purchase', exact: true }).click();
  const receipt = market.getByRole('status').filter({ hasText: 'Purchase confirmed' });
  await expect(receipt).toBeVisible();
  await expect(row(market, AXE)).toHaveCount(0);
  await expect(receipt).not.toBeFocused();
  expect(await body.evaluate(el => el.scrollTop)).toBe(before);
  expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-menu-surface'))).toBe(true);
  expect(flow.commands.map(c => c.kind)).toEqual(['buy-listing']);
  expect(await focusDrops(page)).toEqual([]);
});

test('never takes a focus the player moved while a keyboard trade was pending', async ({ page, context }) => {
  // Fix round 1 (Minor 1 ruling): the command is held; meanwhile the player moves to the Sell tab. The receipt arrives and
  // the bought row leaves, and the focus stays on Sell.
  await watchFocus(page);
  const flow = await marketFlow(context);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let sent = false;
  await context.route(`${SUPABASE_URL}/functions/v1/game-command`, async route => {
    if (route.request().method() === 'POST' && !isPresence(route.request())) { sent = true; await held; }
    await route.fallback();
  });
  const market = await openMarket(page);
  await row(market, SHIELD).getByRole('button', { name: /^Buy/ }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect.poll(() => sent).toBe(true);
  const sellTab = market.getByRole('tab', { name: 'Sell', exact: true });
  await sellTab.focus();
  release();
  await expect(market.getByRole('status').filter({ hasText: 'Purchase confirmed' })).toBeVisible();
  await expect(sellTab).toBeFocused();
  await page.waitForTimeout(500);
  await expect(sellTab).toBeFocused();
  expect(flow.commands.map(c => c.kind)).toEqual(['buy-listing']);
  expect(await focusDrops(page)).toEqual([]);
});

test('moves the focus to the outcome of each trade, never to the page', { tag: '@render' }, async ({ page, context }, info) => {
  await watchFocus(page);
  const flow = await marketFlow(context);
  const market = await openMarket(page);
  // Buy by keyboard: the confirmation opens on Keep browsing; Confirm purchase sends it; the receipt takes the focus and
  // keeps it when the bought row leaves the refreshed page.
  await row(market, SHIELD).getByRole('button', { name: /^Buy/ }).focus();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('dialog', { name: 'Confirm purchase' });
  await expect(confirm.getByRole('button', { name: 'Keep browsing' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(confirm.getByRole('button', { name: 'Confirm purchase' })).toBeFocused();
  await page.keyboard.press('Enter');
  const receipt = market.getByRole('status').filter({ hasText: 'Purchase confirmed' });
  await expect(receipt).toBeFocused();
  await expect(row(market, SHIELD)).toHaveCount(0);
  await expect(receipt).toBeFocused();
  await campReady(page);
  await a11yShot(page, info, 'market-receipt-focused');
  // A refused purchase (sold elsewhere): its reason takes the focus.
  flow.close(SPEAR, 'sold');
  await row(market, SPEAR).getByRole('button', { name: /^Buy/ }).focus();
  await page.keyboard.press('Enter');
  await expect(confirm.getByRole('button', { name: 'Keep browsing' })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(market.getByRole('alert')).toBeFocused();
  await expect(row(market, SPEAR)).toHaveCount(0);
  // List, then cancel: each outcome takes the focus; the cancelled row is gone from My listings.
  await market.getByRole('tab', { name: 'Sell', exact: true }).click();
  const sell = market.getByRole('tabpanel', { name: 'Sell' });
  await sell.getByRole('radio', { name: /^Axe/ }).check();
  await sell.getByLabel('Price in money').fill('120');
  await sell.getByRole('button', { name: 'List for sale', exact: true }).focus();
  await page.keyboard.press('Enter');
  const listed = market.getByRole('status').filter({ hasText: 'Listed for sale: Axe at 120 money' });
  await expect(listed).toBeFocused();
  await market.getByRole('tab', { name: 'My listings', exact: true }).click();
  const cancel = market.getByRole('button', { name: 'Cancel listing: Axe for 120 money', exact: true });
  await cancel.focus();
  await page.keyboard.press('Enter');
  const cancelled = market.getByRole('status').filter({ hasText: 'Listing cancelled. Axe is back in your inventory.' });
  await expect(cancelled).toBeFocused();
  await expect(cancel).toHaveCount(0);
  await expect(cancelled).toBeFocused();
  expect(flow.commands.map(c => c.kind)).toEqual(['buy-listing', 'buy-listing', 'create-listing', 'cancel-listing']);
  expect(await focusDrops(page)).toEqual([]);
});

test('disables Buy with its reason when the money is short or the inventory full', async ({ page, context }) => {
  const flow = await marketFlow(context);
  flow.state.wallets.money = 100;
  const market = await openMarket(page);
  // Too dear: the Spear (450); affordable: the Round shield (18).
  const spear = row(market, SPEAR).getByRole('button', { name: /^Buy/ });
  await expect(spear).toBeDisabled();
  await expect(row(market, SPEAR)).toContainText('Not enough available money');
  await expect(spear).toHaveAccessibleDescription('Not enough available money');
  const shield = row(market, SHIELD).getByRole('button', { name: /^Buy/ });
  await expect(shield).toBeEnabled();
  // The inventory fills elsewhere (no new revision): Refresh reads the owner, and each Buy says why it cannot be used.
  flow.state.inventoryCapacity = flow.state.inventory.length;
  flow.live.setOwner(flow.state);
  await market.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(shield).toBeDisabled();
  await expect(shield).toHaveAccessibleDescription('Your inventory is full');
  await expect(spear).toHaveAccessibleDescription('Not enough available money');
  expect(flow.commands).toEqual([]);
});

test('refuses fractional, over-cap and under-2 prices, and List for sale at the listing limit', async ({ page, context }) => {
  const flow = await marketFlow(context);
  // Four more open listings than the helmet: five, the most allowed.
  for (const [catalogId, price] of [['leather-hood:5:common', 200], ['sword:5:common', 300], ['bow:1:common', 400], ['light-boots:1:uncommon', 500]] as const) flow.listed(catalogId, price);
  const market = await openMarket(page, MARKET_ROWS.length + 4);
  await market.getByRole('tab', { name: 'Sell', exact: true }).click();
  const sell = market.getByRole('tabpanel', { name: 'Sell' });
  await expect(sell).toContainText('Active listings: 5 of 5');
  await sell.getByRole('radio', { name: /^Axe/ }).check();
  const price = sell.getByLabel('Price in money');
  const list = sell.getByRole('button', { name: 'List for sale', exact: true });
  // A whole price under 2 is told why 2 is the lowest; a fractional or too large one is asked for a whole price from 2.
  for (const [value, said] of [['1.5', WHOLE_PRICE_TEXT], ['1000000001', WHOLE_PRICE_TEXT], ['-3', LOWEST_PRICE], ['1', LOWEST_PRICE], ['0', LOWEST_PRICE]]) {
    await price.fill(value);
    await expect(sell, value).toContainText(said);
    await expect(price, value).toHaveAttribute('aria-invalid', 'true');
    await expect(list, value).toBeDisabled();
    await expect(list, value).toHaveAccessibleDescription(escaped(said));
  }
  // Two is the lowest price that is accepted (the listing limit still keeps List for sale disabled below).
  await price.fill('2');
  await expect(price).not.toHaveAttribute('aria-invalid', 'true');
  await expect(sell).toContainText('You receive: 1 money');
  await price.fill('1000000000');
  await expect(price).not.toHaveAttribute('aria-invalid', 'true');
  await expect(sell).toContainText('You receive: 950,000,000 money');
  // A valid price at the limit: List for sale stays disabled, and says why.
  await expect(list).toBeDisabled();
  await expect(list).toHaveAccessibleDescription(/You have 5 active listings, the most allowed/);
  expect(flow.commands).toEqual([]);
});

test('refreshes My listings and the owner with its Refresh', async ({ page, context }) => {
  const flow = await marketFlow(context);
  const { listing } = flow.listed('sword:5:common', 300);
  const market = await openMarket(page, MARKET_ROWS.length + 1);
  await market.getByRole('tab', { name: 'My listings', exact: true }).click();
  const mine = market.getByRole('tabpanel', { name: 'My listings' });
  await expect(mine.getByRole('listitem')).toHaveCount(2);
  const owners = flow.live.count('owner_state');
  const sellerReads = () => flow.live.requests.filter(r => r.table === 'market_offers' && r.query.get('seller_gladiator_id') === `eq.${flow.state.gladiatorId}`).length;
  const reads = sellerReads();
  flow.soldElsewhere(listing);
  await mine.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(mine.getByRole('listitem')).toHaveCount(1);
  await expect(market.getByText('Available money: 2,285')).toBeVisible();
  expect(sellerReads()).toBe(reads + 1);
  expect(flow.live.count('owner_state')).toBe(owners + 1);
});

test('browses the fixture preview Marketplace, whose actions say they are unavailable', async ({ page, baseURL }) => {
  const commands = watchCommands(page);
  const remote = forbidRemote(page, baseURL);
  await page.goto('/game/?mode=fixture');
  await expectOwnerShown(page, 'Aster');
  const market = await openMenu(page, 'Marketplace');
  await expect(market.getByRole('list', { name: 'Open listings' }).getByRole('listitem')).toHaveCount(MARKET_ROWS.length);
  await expect(market.getByText('Available money: 100')).toBeVisible();
  await row(market, SHIELD).getByRole('button', { name: /^Buy/ }).click();
  const preview = market.getByRole('status').filter({ hasText: 'Actions are unavailable in this preview.' });
  await expect(preview).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Confirm purchase' })).toHaveCount(0);
  await market.getByRole('tab', { name: 'My listings', exact: true }).click();
  await market.getByRole('button', { name: /^Cancel listing: Iron helmet/ }).click();
  await expect(preview).toBeVisible();
  await expect(market.getByRole('tabpanel', { name: 'My listings' }).getByRole('listitem')).toHaveCount(1);
  expect(commands).toEqual([]);
  expect(remote).toEqual([]);
});
