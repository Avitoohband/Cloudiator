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
import { campReady, expectOwnerShown, joinButton, openMenu } from './shell-helpers';
import { a11yShot, focusDrops, watchFocus } from './a11y-helpers';
import { forbidRemote } from './remote';
import { showChoice } from './show-choice';

// Task 18.3: the 💰 Marketplace menu. Anyone browses the open offers (the public `market_offer_reads` view over the `market_offers` projection, M37); a player
// buys (after a confirmation), lists an eligible item and cancels a listing through the authenticated command endpoint.
// A stale page's purchase is explained and the page refreshed (Review Focus 4); a visitor sends no command and never sees
// a trading control (Review Focus 5). Live reads come from `routeLiveReads`; this spec answers the commands itself.

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
/** The database's fee (launch feedback): 5 % floored but at least 1, `greatest(1, price*5/100)`; its lowest listing price is 2. */
const feeOf = (price: number) => Math.max(RULES_V1.fees.marketMinimum, Math.floor(price * 5 / 100));
const LOWEST_PRICE = 'The lowest price is 2 gold, so you always receive something after the fee.';
const escaped = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const world = (): WorldSnapshot => ({ ...worldFixture, revision: 'live-1' });
const offer = (catalogId: string) => MARKET_ROWS.find(row => row.item.catalogId === catalogId)!;
const SPEAR = offer('spear:10:rare'), SHIELD = offer('round-shield:1:common'), BOOTS = offer('heavy-boots:10:uncommon'), AXE = offer('axe:5:common');
const BOW = offer('bow:10:common'), ARMOR = offer('light-armor:1:rare');
/** The fixture owner's own offer: Aster's Iron helmet, reserved in her inventory by that listing. */
const HELMET = MARKET_ROWS.find(row => row.seller.gladiatorId === ARENA_OWNER.gladiatorId)!;

/** Every request the page sends to an Edge Function (the game's commands). */
function watchCommands(page: Page) {
  const sent: string[] = [];
  page.on('request', request => { if (request.url().includes('/functions/v1/')) sent.push(request.url()); });
  return sent;
}
const row = (scope: Locator, listing: MarketListing) => scope.getByTestId(`listing-${listing.listingId}`);
/** Task 26: My listings is a chip in Browse's filter row (no longer a tab), showing the seller's own open listings. */
const myListings = (market: Locator) => market.getByRole('group', { name: 'Marketplace filters' }).getByRole('button', { name: /^My listings/ });
const ownList = (market: Locator) => market.getByRole('list', { name: 'Your open listings' });
/** One part of a listing row (Task 26): its icon tile, its details, its price and action, or its seller band. */
const part = (scope: Locator, name: 'icon' | 'details' | 'deal' | 'seller') => scope.locator(`[data-part="${name}"]`);
/** Waits until the menu has stopped animating (its fade-in or rise), so a capture for the visual review shows it as it stays. */
const settledMenu = (market: Locator) => market.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
/** The game's gold (`--gold`), as computed styles give it. */
const GOLD = 'rgb(242, 198, 107)';
/** A tile's border colour and box shadow (its chosen ring and, for a stack, the layers behind it). */
const tileLook = (tile: Locator) => tile.evaluate(el => { const style = getComputedStyle(el); return { border: style.borderTopColor, shadow: style.boxShadow }; });
const itemName = (listing: MarketListing) => CATALOG_V1.items[listing.item.catalogId].name;
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
/** Waits until the camp scene is drawn, so a capture for the visual review shows the camp behind the menu. */

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
 * A signed-in Aster with 2,000 gold and the fixture market. Her inventory holds the helmet she listed, one listable axe,
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
  await row(market, listing).getByRole('button', { name: `Buy ${itemName(listing)} for ${listing.price.toLocaleString('en-US')} gold`, exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm purchase' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Confirm purchase', exact: true }).click();
  await expect(confirm).toBeHidden();
}

// The cases below read what a listing says and does, not how the list pages: Show 50 puts every offer on the page (Patch 1.9 Task 32).
test.beforeEach(async ({ context }) => {
  test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Live mode uses development-only intercepted Supabase transport.');
  await showChoice(context, { market: 50 });
});

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
    await expect(offerRow).toContainText(`${listing.price.toLocaleString('en-US')} gold`);
    await expect(offerRow).toContainText(`NPC sale value: ${CATALOG_V1.items[listing.item.catalogId].npcSellValue} gold`);
    await expect(offerRow).toContainText(/\d+ (d|h|min)( \d+ (h|min))? left/);
    // Task 26: the seller in front, by name (these rows carry no class, league or level: the band without them), and the visitor's own words.
    await expect(part(offerRow, 'seller')).toContainText(`Sold by${listing.seller.name}`);
    await expect(part(offerRow, 'seller')).not.toContainText(/league|Level \d/);
    await expect(offerRow.getByRole('button', { name: `View profile of ${listing.seller.name}`, exact: true })).toBeVisible();
    await expect(offerRow).toContainText('Sign in to buy.');
  }
  await expect(market.getByText('Browsing only. Sign in to buy or sell.')).toBeVisible();
  await expect(market.getByRole('button', { name: 'Sign in with Google to trade' })).toBeEnabled();
  // Browse only: no tabs, and no Buy, Cancel or Sell control, and no wallet.
  await expect(market.getByRole('tab')).toHaveCount(0);
  await expect(market.getByRole('button', { name: /^(Buy|Cancel listing|List for sale)/ })).toHaveCount(0);
  await expect(market.getByText(/My listings|Available gold/)).toHaveCount(0);
  await campReady(page);
  await page.screenshot({ path: info.outputPath(`market-visitor-browse-${info.project.name}.png`) });
  // Read-only: public offer pages as a visitor, never the owner state or a seller's page, and no command.
  expect(commands).toEqual([]);
  expect(live.count('market_offer_reads')).toBeGreaterThan(0);
  expect(live.requests.every(r => r.reader === null)).toBe(true);
  expect(live.count('owner_state')).toBe(0);
  expect(live.requests.filter(r => r.table === 'market_offer_reads').some(r => r.query.has('seller_gladiator_id'))).toBe(false);
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
  await expect(market.getByText(/My listings|Available gold/)).toHaveCount(0);
  expect(commands).toEqual([]);
  expect(live.count('market_offer_reads')).toBeGreaterThan(0);
});

test('shows the seller band from the live read: class, league and level when the view names them, the name only without', async ({ page, context }) => {
  // Task 26 with M37: the `market_offer_reads` view's seller columns reach the band; each null part is left out.
  const rows = MARKET_ROWS.map((listing): MarketListing => listing === SPEAR ? { ...listing, sellerClassId: 'berserker', sellerLeague: 'bronze', sellerLevel: 3 }
    : listing === BOOTS ? { ...listing, sellerClassId: null, sellerLeague: 'silver', sellerLevel: null } : listing);
  const live = await routeLiveReads(context, { world: world(), market: rows });
  await page.goto('/game/');
  await expect(joinButton(page)).toBeVisible();
  const market = await openMenu(page, 'Marketplace');
  await expect(part(row(market, SPEAR), 'seller')).toContainText('Berserker · Bronze league · Level 3');
  await expect(part(row(market, BOOTS), 'seller')).toContainText('Silver league');
  await expect(part(row(market, BOOTS), 'seller')).not.toContainText(/Guardian|Level \d/);
  await expect(part(row(market, AXE), 'seller')).toContainText(`Sold by${AXE.seller.name}`);
  await expect(part(row(market, AXE), 'seller')).not.toContainText(/league|Level \d/);
  expect(live.count('market_offer_reads')).toBeGreaterThan(0);
});

test('buys a listing, shows the receipt and the item in inventory', { tag: '@render' }, async ({ page, context }, info) => {
  const flow = await marketFlow(context);
  const market = await openMarket(page);
  await expect(market.getByText('Available gold: 2,000')).toBeVisible();
  // The player's own offer is marked, and cannot be bought.
  await expect(row(market, HELMET)).toContainText('Your listing');
  await expect(part(row(market, HELMET), 'seller')).toContainText('Your listing, sold byAster (you)');
  await expect(row(market, HELMET).getByRole('button', { name: /^Buy/ })).toHaveCount(0);
  await expect(row(market, HELMET).getByRole('button', { name: 'Cancel listing: Iron helmet for 95 gold', exact: true })).toBeVisible();
  await expect(row(market, SPEAR).getByRole('button', { name: 'Buy Spear for 450 gold', exact: true })).toHaveText('Buy for 450 gold');
  await campReady(page);
  await page.screenshot({ path: info.outputPath(`market-browse-${info.project.name}.png`) });
  // Buying asks first; keeping browsing sends nothing.
  await row(market, SPEAR).getByRole('button', { name: 'Buy Spear for 450 gold', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm purchase' });
  await expect(confirm).toContainText('Buy Spear (Level 10 · Rare) from Varro for 450 gold?');
  await confirm.getByRole('button', { name: 'Keep browsing', exact: true }).click();
  await expect(confirm).toBeHidden();
  expect(flow.commands).toHaveLength(0);
  await buy(page, market, SPEAR);
  const receipt = market.getByRole('status').filter({ hasText: 'Purchase confirmed' });
  await expect(receipt).toContainText('Spear for 450 gold');
  await expect(receipt).toContainText('now in your inventory');
  await expect(receipt).toContainText(/Receipt [0-9a-f]{8}/);
  expect(flow.commands).toEqual([{ kind: 'buy-listing', operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), listingId: SPEAR.listingId }]);
  // The page and the wallet are refreshed: the offer is gone and the price is paid.
  await expect(row(market, SPEAR)).toHaveCount(0);
  await expect(market.getByText('Available gold: 1,550')).toBeVisible();
  const inventory = await openMenu(page, 'Inventory and shops');
  await inventory.getByTestId(`tile-${flow.bought[0].id}`).click();
  await expect(inventory.getByTestId(`item-${flow.bought[0].id}`)).toContainText('Spear');
  await expect(inventory.getByTestId(`item-${flow.bought[0].id}`)).toContainText('Level 10 · rare · Tradable');
});

test('lists an eligible item with the fee and NPC value shown, then cancels it', { tag: '@render' }, async ({ page, context }, info) => {
  const flow = await marketFlow(context);
  const market = await openMarket(page);
  // The tabs answer the arrow keys: Browse and Sell (Task 26: My listings is a chip in Browse).
  await expect(market.getByRole('tab')).toHaveText(['Browse', 'Sell']);
  await market.getByRole('tab', { name: 'Browse', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(market.getByRole('tab', { name: 'Sell', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(market.getByRole('tab', { name: 'Sell', exact: true })).toBeFocused();
  await market.getByRole('tab', { name: 'Sell', exact: true }).click();
  const sell = market.getByRole('tabpanel', { name: 'Sell' });
  // Equipment only, and only what can be sold: not the listed helmet, the bound renown sword, the equipped armor or salvage.
  await expect(sell.getByRole('radio')).toHaveCount(1);
  await expect(sell).toContainText('Active listings: 1 of 5');
  await sell.getByRole('radio', { name: /^Axe/ }).check();
  await expect(sell).toContainText('NPC sale value: 30 gold');
  const price = sell.getByLabel('Price in gold');
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
  await expect(sell).toContainText('Buyer pays: 2 gold');
  await expect(sell).toContainText('Market fee (5%, at least 1): 1 gold');
  await expect(sell).toContainText('You receive: 1 gold');
  await price.fill('11');
  await expect(sell).toContainText('Buyer pays: 11 gold');
  await expect(sell).toContainText('Market fee (5%, at least 1): 1 gold');
  await expect(sell).toContainText('You receive: 10 gold');
  // From 40 the floored 5 % is above the minimum.
  await price.fill('101');
  await expect(sell).toContainText('Buyer pays: 101 gold');
  await expect(sell).toContainText('Market fee (5%, at least 1): 5 gold');
  await expect(sell).toContainText('You receive: 96 gold');
  await campReady(page);
  await page.screenshot({ path: info.outputPath(`market-sell-${info.project.name}.png`) });
  await sell.getByRole('button', { name: 'List for sale', exact: true }).click();
  await expect(market.getByRole('status').filter({ hasText: 'Listed for sale: Axe at 101 gold' })).toBeVisible();
  expect(flow.commands).toEqual([{ kind: 'create-listing', operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), itemId: flow.listable.id, price: 101 }]);
  const listingId = (flow.listable.reservation as { referenceId: string }).referenceId;
  // The listed axe is reserved: nothing more to list.
  await expect(sell.getByRole('radio')).toHaveCount(0);
  await expect(sell).toContainText('Active listings: 2 of 5');
  await market.getByRole('tab', { name: 'Browse', exact: true }).click();
  await expect(myListings(market)).toHaveAccessibleName('My listings (2)');
  await myListings(market).click();
  await expect(myListings(market)).toHaveAttribute('aria-pressed', 'true');
  const mine = ownList(market);
  await expect(mine.getByRole('listitem')).toHaveCount(2);
  await expect(market).toContainText('2 of your 5 listings');
  await expect(mine.getByTestId(`listing-${listingId}`)).toContainText('You receive 96 gold after the market fee (5%, at least 1)');
  await campReady(page);
  await page.screenshot({ path: info.outputPath(`market-my-listings-${info.project.name}.png`) });
  expect(flow.live.requests.filter(r => r.table === 'market_offer_reads').some(r => r.query.get('seller_gladiator_id') === `eq.${flow.state.gladiatorId}`)).toBe(true);
  // Inventory says the axe is listed for sale.
  const inventory = await openMenu(page, 'Inventory and shops');
  await inventory.getByTestId(`tile-${flow.listable.id}`).click();
  await expect(inventory.getByTestId(`item-${flow.listable.id}`)).toContainText('Listed for sale');
  await expect(inventory.getByTestId(`item-${flow.listable.id}`).getByRole('button', { name: 'Sell' })).toBeDisabled();
  const again = await openMenu(page, 'Marketplace');
  await myListings(again).click();
  await again.getByRole('button', { name: 'Cancel listing: Axe for 101 gold', exact: true }).click();
  await expect(again.getByRole('status').filter({ hasText: 'Listing cancelled. Axe is back in your inventory.' })).toBeVisible();
  await expect(ownList(again).getByRole('listitem')).toHaveCount(1);
  await expect(myListings(again)).toHaveAccessibleName('My listings (1)');
  expect(flow.commands.map(c => c.kind)).toEqual(['create-listing', 'cancel-listing']);
  expect(flow.commands[1]).toMatchObject({ listingId });
  const back = await openMenu(page, 'Inventory and shops');
  await back.getByTestId(`tile-${flow.listable.id}`).click();
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
    const reads = flow.live.count('market_offer_reads');
    await buy(page, market, listing);
    await expect(alert).toHaveText(explained);
    await expect(row(market, listing)).toHaveCount(0);
    expect(flow.live.count('market_offer_reads')).toBeGreaterThan(reads);
    // Nothing to retry: the outcome is final.
    await expect(market.getByRole('button', { name: 'Retry request' })).toHaveCount(0);
  }
  expect(flow.commands.map(c => (c as { listingId: string }).listingId)).toEqual([SPEAR.listingId, BOOTS.listingId, SHIELD.listingId]);
  expect(new Set(flow.commands.map(c => c.operationId)).size).toBe(3);
  await expect(market.getByText('Available gold: 2,000')).toBeVisible();
  expect(flow.bought).toEqual([]);
});

test('reads the owner when the menu opens and on Refresh, after listings sold elsewhere', { tag: '@render' }, async ({ page, context }) => {
  // Final review I1: a sale changes the seller's wallet and inventory without a new world revision (Ruling 2), so nothing
  // else reads her owner state again. Aster has 1,000 gold and five listings; two sell while the menu is closed.
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
  await myListings(market).click();
  await expect(ownList(market).getByRole('listitem')).toHaveCount(3);
  await expect(myListings(market)).toHaveAccessibleName('My listings (3)');
  await market.getByRole('tab', { name: 'Sell', exact: true }).click();
  const sell = market.getByRole('tabpanel', { name: 'Sell' });
  await expect(sell).toContainText('Active listings: 3 of 5');
  await sell.getByRole('radio', { name: /^Axe/ }).check();
  await sell.getByLabel('Price in gold').fill('100');
  await expect(sell.getByRole('button', { name: 'List for sale', exact: true })).toBeEnabled();
  // The available gold includes the proceeds (1,000 + 285 + 475), so Cassia's bow at 1,250 can be bought.
  await expect(market.getByText('Available gold: 1,760')).toBeVisible();
  await market.getByRole('tab', { name: 'Browse', exact: true }).click();
  await market.getByRole('button', { name: 'All', exact: true }).click();
  await expect(row(market, offer('bow:10:common')).getByRole('button', { name: /^Buy/ })).toBeEnabled();
  // One owner read for the opening, however many tabs were shown since.
  expect(owners()).toBe(read + 1);
  // A third listing sells while the menu is open: Refresh reads the owner again, once.
  flow.soldElsewhere(hood.listing);
  await market.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(market.getByText('Available gold: 1,950')).toBeVisible();
  await market.getByRole('tab', { name: 'Sell', exact: true }).click();
  await expect(sell).toContainText('Active listings: 2 of 5');
  expect(owners()).toBe(read + 2);
  expect(flow.commands).toEqual([]);
  // Inventory shows the same owner: the sold items are gone.
  const inventory = await openMenu(page, 'Inventory and shops');
  for (const sold of [sword, boots, hood]) await expect(inventory.getByTestId(`tile-${sold.item.id}`)).toHaveCount(0);
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
  await expect(market.getByRole('status').filter({ hasText: 'Purchase confirmed' })).toContainText('Round shield for 18 gold');
  expect(flow.commands).toHaveLength(2);
  expect(flow.commands[1]).toEqual(flow.commands[0]);
  // Rate limited: buying the same listing again (not Retry) still sends the same operation.
  flow.answerNext('rate-limited');
  await buy(page, market, AXE);
  await expect(alert).toContainText('retry');
  await buy(page, market, AXE);
  await expect(market.getByRole('status').filter({ hasText: 'Purchase confirmed' })).toContainText('Axe for 90 gold');
  expect(flow.commands[3]).toEqual(flow.commands[2]);
  // A lost response after the server committed: Retry replays the stored receipt, and the item is bought once.
  flow.loseNext();
  await buy(page, market, BOOTS);
  await expect(alert).toContainText('could not be confirmed');
  await market.getByRole('button', { name: 'Retry request', exact: true }).click();
  await expect(market.getByRole('status').filter({ hasText: 'Purchase confirmed' })).toContainText('Heavy boots for 240 gold');
  expect(flow.commands[5]).toEqual(flow.commands[4]);
  expect(new Set(flow.commands.map(c => c.operationId)).size).toBe(3);
  expect(flow.bought.map(item => item.catalogId)).toEqual(['round-shield:1:common', 'axe:5:common', 'heavy-boots:10:uncommon']);
  await expect(market.getByText('Available gold: 1,652')).toBeVisible();
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
  await myListings(market).click();
  await expect(ownList(market).getByRole('listitem')).toHaveCount(1);
  await fits('My listings');
  await market.getByRole('tab', { name: 'Sell', exact: true }).click();
  const sell = market.getByRole('tabpanel', { name: 'Sell' });
  await sell.getByRole('radio', { name: /^Axe/ }).check();
  await sell.getByLabel('Price in gold').fill('1000000000');
  await expect(sell).toContainText('You receive: 950,000,000 gold');
  await fits('Sell');
});

// Task 26 (Avi approved the revised mockup on 2026-11-13): the Marketplace as a list with big item icons, every detail on the row and the
// seller in front; My listings is a chip; the Sell tab is a tile grid with the price and fee lines in the card. Rules, fees and words stay.

test('shows each listing as a row: the big icon, the details, the price and action, then the seller band', { tag: '@render' }, async ({ page, context }, info) => {
  await marketFlow(context);
  const market = await openMarket(page);
  const phone = info.project.name === 'mobile';
  // A desktop gets the Inventory's 704 px; a phone keeps its bottom sheet.
  if (!phone) expect(Math.round((await market.boundingBox())!.width)).toBe(704);
  await expect(market.getByRole('group', { name: 'Marketplace filters' }).getByRole('button')).toHaveText(['All', 'Weapons', 'Armor', /^My listings/]);
  await expect(market.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(myListings(market)).toHaveAccessibleName('My listings (1)');
  await expect(market.getByRole('combobox', { name: 'Sort the Marketplace' })).toHaveValue('newest');
  await expect(market).toContainText(`${MARKET_ROWS.length} open listings · newest first`);
  const spear = row(market, SPEAR);
  await expect(spear).toHaveAccessibleName('Spear, level 10, rare, sold by Varro, 450 gold');
  await expect(part(spear, 'icon')).toContainText('L10');
  await expect(part(spear, 'details')).toContainText('Level 10 · rare · Tradable');
  await expect(part(spear, 'details')).toContainText(/Listed (just now|\d+ min ago) · 6 d 23 h left · NPC sale value: 78 gold/);
  await expect(part(spear, 'deal')).toContainText('450 gold');
  await expect(part(spear, 'seller')).toContainText('Sold byVarro');
  const [icon, details, deal, seller, whole] = await Promise.all([part(spear, 'icon'), part(spear, 'details'), part(spear, 'deal'), part(spear, 'seller'), spear]
    .map(async locator => (await locator.boundingBox())!));
  // The icon tile is big (92 px on a desktop, 72 px on a phone) and left of the details; the seller band runs under the details.
  expect(Math.round(icon.width)).toBe(phone ? 72 : 92);
  expect(icon.x + icon.width).toBeLessThanOrEqual(details.x);
  expect(seller.y).toBeGreaterThanOrEqual(details.y + details.height - 1);
  if (phone) {
    // A phone: the seller band, then the price and Buy across the whole row under it.
    expect(deal.y).toBeGreaterThanOrEqual(seller.y + seller.height - 1);
    expect(deal.width).toBeGreaterThan(whole.width * 0.85);
    expect(seller.width).toBeGreaterThan(whole.width * 0.85);
  } else {
    // A desktop: the price and action right of the details, the seller band under the details and the action.
    expect(deal.x).toBeGreaterThanOrEqual(details.x + details.width - 1);
    expect(Math.abs(seller.x - details.x)).toBeLessThanOrEqual(1);
    expect(seller.x + seller.width).toBeCloseTo(deal.x + deal.width, 0);
  }
  // Every control a finger uses on a phone is at least 44 px tall.
  if (phone) {
    const controls = { Buy: spear.getByRole('button', { name: /^Buy/ }), 'View profile': spear.getByRole('button', { name: /^View profile/ }), 'My listings': myListings(market),
      All: market.getByRole('button', { name: 'All', exact: true }), Sell: market.getByRole('tab', { name: 'Sell', exact: true }), Refresh: market.getByRole('button', { name: 'Refresh', exact: true }),
      Search: market.getByRole('searchbox', { name: 'Search the Marketplace' }), Sort: market.getByRole('combobox', { name: 'Sort the Marketplace' }),
      Cancel: row(market, HELMET).getByRole('button', { name: /^Cancel listing/ }) };
    for (const [name, control] of Object.entries(controls)) {
      await control.scrollIntoViewIfNeeded();
      expect((await control.boundingBox())!.height, name).toBeGreaterThanOrEqual(43.5);
    }
  }
  expect(await noHorizontalScroll(page)).toBe(true);
  await campReady(page);
  await settledMenu(market);
  await page.screenshot({ path: info.outputPath(`task-26-live-${info.project.name}.png`) });
});

test('keeps Buy and Cancel listing at 44 px in a wide touch layout (a tablet)', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'mobile', 'A touch screen: the phone project, widened.');
  await page.setViewportSize({ width: 1024, height: 768 });
  await marketFlow(context);
  const market = await openMarket(page);
  const spear = row(market, SPEAR);
  const [details, deal] = await Promise.all([part(spear, 'details'), part(spear, 'deal')].map(async locator => (await locator.boundingBox())!));
  // The wide row (price and action at the right), on a touch screen.
  expect(deal.x).toBeGreaterThanOrEqual(details.x + details.width - 1);
  for (const [name, control] of [['Buy', spear.getByRole('button', { name: /^Buy/ })], ['Cancel listing', row(market, HELMET).getByRole('button', { name: /^Cancel listing/ })],
    ['View profile', spear.getByRole('button', { name: /^View profile/ })]] as const) {
    expect((await control.boundingBox())!.height, name).toBeGreaterThanOrEqual(43.5);
  }
});

test('filters by Weapons and Armor, searches by name, and sorts by price and level', async ({ page, context }) => {
  const flow = await marketFlow(context);
  const market = await openMarket(page);
  const list = market.getByRole('list', { name: 'Open listings' });
  const order = () => list.getByRole('listitem').evaluateAll(items => items.map(item => item.getAttribute('data-testid')));
  const ids = (...rows: MarketListing[]) => rows.map(listing => `listing-${listing.listingId}`);
  await market.getByRole('button', { name: 'Weapons', exact: true }).click();
  await expect.poll(order).toEqual(ids(SPEAR, AXE, BOW));
  await market.getByRole('button', { name: 'Armor', exact: true }).click();
  await expect.poll(order).toEqual(ids(HELMET, SHIELD, BOOTS, ARMOR));
  // A bow is not armor: the search says so, with All one chip away.
  await market.getByRole('searchbox', { name: 'Search the Marketplace' }).fill('bow');
  await expect(market).toContainText('No match for “bow” in Armor');
  await market.getByRole('button', { name: 'All', exact: true }).click();
  await expect.poll(order).toEqual(ids(BOW));
  await expect(market).toContainText('1 listing match “bow”');
  await market.getByRole('button', { name: 'Clear search', exact: true }).click();
  const sort = market.getByRole('combobox', { name: 'Sort the Marketplace' });
  await expect(sort.locator('option')).toHaveText(['Newest', 'Price low-high', 'Price high-low', 'Level']);
  await sort.selectOption({ label: 'Price high-low' });
  await expect.poll(order).toEqual(ids(...[...MARKET_ROWS].sort((a, b) => b.price - a.price)));
  await expect(market).toContainText(`${MARKET_ROWS.length} open listings · dearest first`);
  await sort.selectOption({ label: 'Price low-high' });
  await expect.poll(order).toEqual(ids(...[...MARKET_ROWS].sort((a, b) => a.price - b.price)));
  await expect(market).toContainText('cheapest first');
  await sort.selectOption({ label: 'Level' });
  await expect.poll(order).toEqual(ids(...[...MARKET_ROWS].sort((a, b) => a.item.tier - b.item.tier)));
  await expect(market).toContainText('lowest level first');
  // My listings keeps the search and the sort, and reads the seller's own listings.
  await myListings(market).click();
  await expect(ownList(market).getByRole('listitem')).toHaveCount(1);
  await expect(market).toContainText('1 of your 5 listings');
  expect(flow.commands).toEqual([]);
});

test('lists from a tile grid of the free, tradable pieces, stacked as in the Inventory, with the price and fee lines in the card', async ({ page, context }) => {
  const flow = await marketFlow(context);
  // Two identical swords share one tile; a listing takes the first of them.
  const swords = [0, 1].map(() => ({ ...itemFixture(CATALOG_V1.items['sword:1:common']), id: randomUUID() }));
  flow.state.inventory.push(...swords);
  flow.live.setOwner(flow.state);
  const market = await openMarket(page);
  await market.getByRole('tab', { name: 'Sell', exact: true }).click();
  const sell = market.getByRole('tabpanel', { name: 'Sell' });
  const grid = sell.getByRole('radiogroup', { name: 'Item to list' });
  const axe = grid.getByRole('radio', { name: 'Axe, level 5, common', exact: true });
  const sword = grid.getByRole('radio', { name: 'Sword, level 1, common, 2 owned', exact: true });
  await expect(grid.getByRole('radio')).toHaveCount(2);
  await expect(sword).toContainText('×2');
  await expect(sell).toContainText('2 tiles · free, tradable equipment only');
  await expect(sell).toContainText('Active listings: 1 of 5');
  await expect(sell).toContainText('Not offered: equipped or reserved items, account-bound or renown gear, salvage.');
  await expect(sell).toContainText('Choose an item from the grid to list it.');
  await expect(sell.getByRole('button', { name: 'List for sale' })).toHaveCount(0);
  // One Tab stop: the arrow keys choose the next piece, as radio buttons do.
  await axe.click();
  await expect(axe).toHaveAttribute('aria-checked', 'true');
  // Fix round 1: the chosen tile looks chosen (a gold border and an inset gold ring), with the pointer away from it too.
  await page.mouse.move(0, 0);
  await expect.poll(() => tileLook(axe)).toEqual({ border: GOLD, shadow: expect.stringContaining(`${GOLD} 0px 0px 0px 1px inset`) });
  expect((await tileLook(sword)).border).not.toBe(GOLD);
  await expect(sell).toContainText('List on the Marketplace');
  await expect(sell).toContainText('NPC sale value: 30 gold');
  await axe.focus();
  await page.keyboard.press('ArrowRight');
  await expect(sword).toBeFocused();
  await expect(sword).toHaveAttribute('aria-checked', 'true');
  await expect(axe).toHaveAttribute('aria-checked', 'false');
  await expect(axe).toHaveAttribute('tabindex', '-1');
  // A chosen stack keeps its layers behind the ring; the tile left behind loses the ring.
  await expect.poll(() => tileLook(sword)).toEqual({ border: GOLD,
    shadow: expect.stringMatching(new RegExp(`^${GOLD.replace(/[()]/g, '\\$&')} 0px 0px 0px 1px inset, rgb\\(74, 64, 54\\) 3px 3px`)) });
  expect((await tileLook(axe)).border).not.toBe(GOLD);
  expect((await tileLook(axe)).shadow).toBe('none');
  await page.keyboard.press('ArrowLeft');
  await expect(axe).toBeFocused();
  await expect(axe).toHaveAttribute('aria-checked', 'true');
  await sword.click();
  const price = sell.getByLabel('Price in gold');
  await price.fill('40');
  await expect(sell).toContainText('Buyer pays: 40 gold');
  await expect(sell).toContainText('Market fee (5%, at least 1): 2 gold');
  await expect(sell).toContainText('You receive: 38 gold');
  // The search and the chips narrow the grid.
  await sell.getByRole('searchbox', { name: 'Search your items' }).fill('axe');
  await expect(grid.getByRole('radio')).toHaveCount(1);
  await sell.getByRole('button', { name: 'Clear search', exact: true }).click();
  await sell.getByRole('button', { name: 'Armor', exact: true }).click();
  await expect(sell).toContainText('No armor to list.');
  await expect(sell).toContainText('Choose an item from the grid to list it.');
  await sell.getByRole('button', { name: 'All', exact: true }).click();
  await sword.click();
  await sell.getByRole('button', { name: 'List for sale', exact: true }).click();
  await expect(market.getByRole('status').filter({ hasText: 'Listed for sale: Sword at 40 gold' })).toBeVisible();
  expect(flow.commands).toEqual([{ kind: 'create-listing', operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), itemId: swords[0].id, price: 40 }]);
  // The other sword is free: a tile of its own, with no count.
  await expect(grid.getByRole('radio', { name: 'Sword, level 1, common', exact: true })).toBeVisible();
  await expect(sell).toContainText('Active listings: 2 of 5');
});

test('shows the seller’s class, league and level when the listing carries them, and opens the seller’s profile card', { tag: '@render' }, async ({ page, baseURL }, info) => {
  test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'The camp harness runs on the fixture preview only.');
  const commands = watchCommands(page);
  const remote = forbidRemote(page, baseURL);
  await page.goto('/game/?mode=fixture');
  await expectOwnerShown(page, 'Aster');
  const market = await openMenu(page, 'Marketplace');
  // The fixture's market read joins each seller's public profile, as the live read does since M37: Varro is a level 3
  // Berserker in the Bronze league, Lucilla a level 6 Guardian in the Silver league.
  const spear = row(market, SPEAR);
  await expect(part(spear, 'seller')).toContainText('Berserker · Bronze league · Level 3');
  await expect(part(spear, 'seller').locator('[data-class="berserker"]')).toHaveText('VB');
  await expect(part(row(market, BOOTS), 'seller')).toContainText('Guardian · Silver league · Level 6');
  await expect(part(row(market, HELMET), 'seller')).toContainText('Your listing, sold byAster (you)');
  await campReady(page);
  await settledMenu(market);
  await page.screenshot({ path: info.outputPath(`task-26-browse-${info.project.name}.png`) });
  // View profile opens the seller's card (their gladiator id), and closing it gives the focus back.
  const view = spear.getByRole('button', { name: 'View profile of Varro', exact: true });
  await view.click();
  const card = page.getByRole('dialog', { name: 'Profile: Varro', exact: true });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Close profile', exact: true }).click();
  await expect(card).toBeHidden();
  await expect(view).toBeFocused();
  // My listings and the Sell tab, for the visual review.
  await myListings(market).click();
  await expect(ownList(market).getByRole('listitem')).toHaveCount(1);
  await settledMenu(market);
  await page.screenshot({ path: info.outputPath(`task-26-my-listings-${info.project.name}.png`) });
  expect(commands).toEqual([]);
  expect(remote).toEqual([]);
});

test('shows the Sell tab of the demo bag for the visual review', { tag: '@render' }, async ({ page, baseURL }, info) => {
  test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'The camp harness runs on the fixture preview only.');
  const remote = forbidRemote(page, baseURL);
  await page.goto('/game/?mode=fixture&bag=demo');
  await expectOwnerShown(page, 'Aster');
  const market = await openMenu(page, 'Marketplace');
  await market.getByRole('tab', { name: 'Sell', exact: true }).click();
  const sell = market.getByRole('tabpanel', { name: 'Sell' });
  await sell.getByRole('radio', { name: /^Axe, level 1/ }).click();
  await sell.getByLabel('Price in gold').fill('101');
  await expect(sell).toContainText('You receive: 96 gold');
  expect(await noHorizontalScroll(page)).toBe(true);
  // The pointer off the tile, so the capture shows the chosen look, not the hover border (fix round 1).
  await page.mouse.move(0, 0);
  expect((await tileLook(sell.getByRole('radio', { name: /^Axe, level 1/ }))).border).toBe(GOLD);
  // A phone's tap brought the card into view below the grid: the capture shows the grid with its chosen tile.
  if (info.project.name === 'mobile') await sell.getByRole('radiogroup', { name: 'Item to list' }).evaluate(el => el.scrollIntoView({ block: 'center' }));
  await campReady(page);
  await settledMenu(market);
  await page.screenshot({ path: info.outputPath(`task-26-sell-${info.project.name}.png`) });
  await sell.getByRole('button', { name: 'List for sale', exact: true }).click();
  await expect(market.getByRole('status').filter({ hasText: 'Actions are unavailable in this preview.' })).toBeVisible();
  expect(remote).toEqual([]);
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
      await market.getByLabel('Price in gold').fill('120');
      button = market.getByRole('button', { name: 'List for sale', exact: true });
    } else if (kind === 'cancel-listing') {
      await myListings(market).click();
      button = row(ownList(market), HELMET).getByRole('button', { name: /^Cancel listing:/ });
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
      // A busy button looks unavailable, like a natively disabled one (an inactive control has no contrast requirement).
      await expect(button).toHaveCSS('cursor', 'not-allowed');
      await expect(button).toHaveCSS('opacity', '0.7');
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
      - paragraph: Buy Spear (Level 10 · Rare) from Varro for 450 gold?
      - paragraph: "Available gold after the purchase: 1,550 gold."
      - button "Keep browsing"
      - button "Confirm purchase"
  `);
});

test('leaves the focus and the rows in view where they are after a pointer trade', async ({ page, context }) => {
  // Fix round 1 (the controller's ruling on review Minor 1): a trade sent with the pointer moves nothing. The bought row
  // leaves, so the focus goes to the menu panel, never to the receipt or <body>. Task 26 (its fix round 1): the receipt now
  // shows above the list, under the tabs; the browser's scroll anchoring scrolls the menu by its height, so the rows in view
  // stay where they are on screen. When the bought row then leaves, the browser keeps one of its neighbours where it was (the
  // one it anchors on: the row above on a desktop, the row below on a phone, where the rows above slide down into the gap).
  await watchFocus(page);
  const flow = await marketFlow(context);
  const market = await openMarket(page);
  const body = market.getByTestId('menu-body');
  // A real pointer click at the button where it is: a locator click may scroll its target into view first. On a phone the
  // menu is a bottom sheet that rises into place as it opens (`rise`, 0.2 s, in shell.module.css), so a box read during the
  // rise is below the button by the time the click lands (Task 24.0b: under load the point fell beside Axe's Buy and no
  // confirmation opened). The button is measured once the sheet has stopped moving. Task 26: the rows are taller, so the
  // list is scrolled until the Axe's Buy is in the middle of the menu (a scroll that the trade must keep).
  await market.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
  const axeBuy = row(market, AXE).getByRole('button', { name: /^Buy/ });
  await axeBuy.evaluate(el => el.scrollIntoView({ block: 'center' }));
  const before = await body.evaluate(el => el.scrollTop);
  expect(before).toBeGreaterThan(0);
  const buy = (await axeBuy.boundingBox())!;
  const view = (await body.boundingBox())!;
  // The rows just above and below the Axe's (the Round shield's and the Heavy boots'), on screen.
  const topOf = (listing: MarketListing) => row(market, listing).evaluate(el => el.getBoundingClientRect().top);
  const [shieldBefore, bootsBefore] = [await topOf(SHIELD), await topOf(BOOTS)];
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
  await expect(confirm).toContainText(`Buy ${itemName(AXE)} (Level 5 · Common) from ${AXE.seller.name} for 90 gold?`);
  expect(await body.evaluate(el => el.scrollTop)).toBe(before);
  // The listings read after the purchase is held, so the receipt shows while the Axe's row is still there.
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname.endsWith('/rest/v1/market_offer_reads'), async route => { await held; await route.fallback(); });
  await confirm.getByRole('button', { name: 'Confirm purchase', exact: true }).click();
  const receipt = market.getByRole('status').filter({ hasText: 'Purchase confirmed' });
  await expect(receipt).toBeVisible();
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await frames();
  await expect(row(market, AXE)).toHaveCount(1);
  expect(await body.evaluate(el => el.scrollTop), 'the menu scrolled by the receipt').toBeGreaterThan(before);
  expect(Math.abs((await topOf(SHIELD)) - shieldBefore), 'the Round shield row moved when the receipt showed').toBeLessThanOrEqual(1);
  expect(Math.abs((await topOf(BOOTS)) - bootsBefore), 'the Heavy boots row moved when the receipt showed').toBeLessThanOrEqual(1);
  release();
  await expect(row(market, AXE)).toHaveCount(0);
  await expect(receipt).not.toBeFocused();
  await frames();
  const kept = [Math.abs((await topOf(SHIELD)) - shieldBefore), Math.abs((await topOf(BOOTS)) - bootsBefore)];
  expect(Math.min(...kept), `a neighbour of the bought row stays where it was (moved ${kept.join(' and ')} px)`).toBeLessThanOrEqual(1);
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
  await sell.getByLabel('Price in gold').fill('120');
  await sell.getByRole('button', { name: 'List for sale', exact: true }).focus();
  await page.keyboard.press('Enter');
  const listed = market.getByRole('status').filter({ hasText: 'Listed for sale: Axe at 120 gold' });
  await expect(listed).toBeFocused();
  await market.getByRole('tab', { name: 'Browse', exact: true }).click();
  await myListings(market).click();
  const cancel = market.getByRole('button', { name: 'Cancel listing: Axe for 120 gold', exact: true });
  await cancel.focus();
  await page.keyboard.press('Enter');
  const cancelled = market.getByRole('status').filter({ hasText: 'Listing cancelled. Axe is back in your inventory.' });
  await expect(cancelled).toBeFocused();
  await expect(cancel).toHaveCount(0);
  await expect(cancelled).toBeFocused();
  expect(flow.commands.map(c => c.kind)).toEqual(['buy-listing', 'buy-listing', 'create-listing', 'cancel-listing']);
  expect(await focusDrops(page)).toEqual([]);
});

test('disables Buy with its reason when the gold is short or the inventory full', async ({ page, context }) => {
  const flow = await marketFlow(context);
  flow.state.wallets.money = 100;
  const market = await openMarket(page);
  // Too dear: the Spear (450); affordable: the Round shield (18).
  const spear = row(market, SPEAR).getByRole('button', { name: /^Buy/ });
  await expect(spear).toBeDisabled();
  await expect(row(market, SPEAR)).toContainText('Not enough available gold');
  await expect(spear).toHaveAccessibleDescription('Not enough available gold');
  const shield = row(market, SHIELD).getByRole('button', { name: /^Buy/ });
  await expect(shield).toBeEnabled();
  // The inventory fills elsewhere (no new revision): Refresh reads the owner, and each Buy says why it cannot be used.
  flow.state.inventoryCapacity = flow.state.inventory.length;
  flow.live.setOwner(flow.state);
  await market.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(shield).toBeDisabled();
  await expect(shield).toHaveAccessibleDescription('Your inventory is full');
  await expect(spear).toHaveAccessibleDescription('Not enough available gold');
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
  const price = sell.getByLabel('Price in gold');
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
  await expect(sell).toContainText('You receive: 1 gold');
  await price.fill('1000000000');
  await expect(price).not.toHaveAttribute('aria-invalid', 'true');
  await expect(sell).toContainText('You receive: 950,000,000 gold');
  // A valid price at the limit: List for sale stays disabled, and says why.
  await expect(list).toBeDisabled();
  await expect(list).toHaveAccessibleDescription(/You have 5 active listings, the most allowed/);
  expect(flow.commands).toEqual([]);
});

test('refreshes My listings and the owner with its Refresh', async ({ page, context }) => {
  const flow = await marketFlow(context);
  const { listing } = flow.listed('sword:5:common', 300);
  const market = await openMarket(page, MARKET_ROWS.length + 1);
  await myListings(market).click();
  const mine = ownList(market);
  await expect(mine.getByRole('listitem')).toHaveCount(2);
  const owners = flow.live.count('owner_state');
  const sellerReads = () => flow.live.requests.filter(r => r.table === 'market_offer_reads' && r.query.get('seller_gladiator_id') === `eq.${flow.state.gladiatorId}`).length;
  const reads = sellerReads();
  flow.soldElsewhere(listing);
  // Refresh sits beside the count under the list.
  await market.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(mine.getByRole('listitem')).toHaveCount(1);
  await expect(market).toContainText('1 of your 5 listings');
  await expect(market.getByText('Available gold: 2,285')).toBeVisible();
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
  await expect(market.getByText('Available gold: 100')).toBeVisible();
  await row(market, SHIELD).getByRole('button', { name: /^Buy/ }).click();
  const preview = market.getByRole('status').filter({ hasText: 'Actions are unavailable in this preview.' });
  await expect(preview).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Confirm purchase' })).toHaveCount(0);
  await myListings(market).click();
  await market.getByRole('button', { name: /^Cancel listing: Iron helmet/ }).click();
  await expect(preview).toBeVisible();
  await expect(ownList(market).getByRole('listitem')).toHaveCount(1);
  expect(commands).toEqual([]);
  expect(remote).toEqual([]);
});

// Patch 1.9 Task 32 (menus with Back and Next): the Browse list shows three cards a page of the fifty a server page holds. Next past the fifty read
// reads the next fifty ("Page 17" with "more to see" until the last is read), a chip, a search or a sort goes back to page 1, a failed read keeps the
// page and says so, and a second Next during a read does nothing. The seller band, fees, limits and messages stay as the cases above read them.
test.describe('the Marketplace in pages', () => {
  const many = (count: number) => Array.from({ length: count }, (_, i): MarketListing => ({ ...MARKET_ROWS[i % MARKET_ROWS.length], listingId: randomUUID(),
    listedAtMs: MARKET_ROWS[i % MARKET_ROWS.length].listedAtMs - i * 1000 }));
  async function openPaged(page: Page, context: BrowserContext, count = 120) {
    // This case is about paging: it takes the Fit size, whatever the cases above save.
    await context.addInitScript(() => { try { localStorage.removeItem('cloudiator.page-size.v1'); } catch { /* none */ } });
    const live = await routeLiveReads(context, { world: world(), market: many(count) });
    await page.goto('/game/');
    await expect(joinButton(page)).toBeVisible();
    const market = await openMenu(page, 'Marketplace');
    const cards = market.getByRole('list', { name: 'Open listings' }).getByRole('listitem');
    await expect(cards).toHaveCount(3, { timeout: 45_000 });
    const bar = market.getByRole('navigation', { name: 'Pages' });
    return { live, market, cards, bar, label: bar.locator('b').first(), next: bar.getByRole('button', { name: 'Next page', exact: true }) };
  }

  test('three cards a page; Next past the fifty read reads the next fifty, once; a chip goes back to page 1', async ({ page, context }) => {
    const { live, market, cards, bar, label, next } = await openPaged(page, context);
    await expect(label).toHaveText('Page 1');
    await expect(bar).toContainText('more to see');
    await expect(market.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);
    // Every card keeps its seller band.
    await expect(market.locator('[data-part="seller"]')).toHaveCount(3);
    await next.click();
    await expect(label).toHaveText('Page 2');
    await expect(cards.first()).toBeFocused();
    // Fifty offers are sixteen full pages; the next Next reads the next fifty (and a second Next while it reads does nothing).
    await bar.getByRole('button', { name: 'Go to page 16', exact: true }).click();
    await expect(label).toHaveText('Page 16');
    const before = live.count('market_offer_reads');
    live.delay('market_offer_reads', 800);
    await next.click();
    await next.dispatchEvent('click');
    await expect(label).toHaveText('Page 17', { timeout: 15_000 });
    expect(live.count('market_offer_reads') - before).toBe(1);
    await expect(cards).toHaveCount(3);
    live.delay('market_offer_reads', 0);
    // A chip is another view of the loaded offers: back to page 1.
    await market.getByRole('group', { name: 'Marketplace filters' }).getByRole('button', { name: 'Weapons', exact: true }).click();
    await expect(label).toHaveText('Page 1');
    // A sort and a search do the same.
    await next.click();
    await expect(label).toHaveText('Page 2');
    await market.getByRole('combobox', { name: 'Sort the Marketplace' }).selectOption({ label: 'Price low-high' });
    await expect(label).toHaveText('Page 1');
  });

  test('a search goes back to page 1, and a Refresh keeps the page', async ({ page, context }) => {
    const { live, market, bar, label, next } = await openPaged(page, context);
    await next.click();
    await next.click();
    await expect(label).toHaveText('Page 3');
    // Refresh reads the first page again and keeps the page asked for (the offers are the same fifty).
    const before = live.count('market_offer_reads');
    await market.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => live.count('market_offer_reads')).toBeGreaterThan(before);
    await expect(label).toHaveText('Page 3');
    // A search is another view of the loaded offers: back to page 1.
    await market.getByRole('searchbox', { name: 'Search the Marketplace' }).fill('spear');
    await expect(label).toHaveText('Page 1');
    await expect(bar).toContainText('more to see');
  });

  test('under a price sort, reading more starts again at page 1 of the new order, and no offer shows twice going forward', async ({ page, context }) => {
    // Offers listed later are dearer, so the oldest (read last) are the cheapest: a sort by price puts them first once they are read.
    const rows = Array.from({ length: 120 }, (_, i): MarketListing => ({ ...MARKET_ROWS[i % MARKET_ROWS.length], listingId: randomUUID(),
      listedAtMs: MARKET_ROWS[0].listedAtMs - i * 1000, price: 1000 - i * 5 }));
    await context.addInitScript(() => { try { localStorage.removeItem('cloudiator.page-size.v1'); } catch { /* none */ } });
    await routeLiveReads(context, { world: world(), market: rows });
    await page.goto('/game/');
    await expect(joinButton(page)).toBeVisible();
    const market = await openMenu(page, 'Marketplace');
    const cards = market.getByRole('list', { name: 'Open listings' }).getByRole('listitem');
    await expect(cards).toHaveCount(3, { timeout: 45_000 });
    const bar = market.getByRole('navigation', { name: 'Pages' });
    const label = bar.locator('b').first(), next = bar.getByRole('button', { name: 'Next page', exact: true });
    await market.getByRole('combobox', { name: 'Sort the Marketplace' }).selectOption({ label: 'Price low-high' });
    await expect(label).toHaveText('Page 1');
    // The cheapest of the first fifty is the 50th offer (price 755).
    await expect(cards.first()).toContainText('755');
    await bar.getByRole('button', { name: 'Go to page 16', exact: true }).click();
    await next.click();
    // The next fifty are read, and the view starts again at page 1 of the order of all hundred: its cheapest is the 100th offer (price 505).
    await expect(label).toHaveText('Page 1', { timeout: 15_000 });
    await expect(cards.first()).toContainText('505');
    const seen: string[] = [];
    for (let turn = 0; turn < 6; turn += 1) {
      seen.push(...await cards.evaluateAll(items => items.map(item => item.getAttribute('data-testid') ?? '')));
      await next.click();
      await expect(label).toHaveText(`Page ${turn + 2}`);
    }
    expect(new Set(seen).size, 'no offer twice going forward').toBe(seen.length);
  });

  test('the last read ends the list and the label knows it; a failed read keeps the page and says so', async ({ page, context }) => {
    const { live, market, cards, bar, label, next } = await openPaged(page, context, 52);
    await bar.getByRole('button', { name: 'Go to page 16', exact: true }).click();
    live.fail('market_offer_reads');
    await next.click();
    await expect(bar).toContainText('Could not load more. Try Next again.');
    await expect(label).toHaveText('Page 16');
    await expect(cards).toHaveCount(3);
    live.fail('market_offer_reads', false);
    await next.click();
    // Fifty-two offers: seventeen pages, the last of one.
    await expect(label).toHaveText('Page 17 of 18');
    await bar.getByRole('button', { name: 'Go to page 18', exact: true }).click();
    await expect(cards).toHaveCount(1);
    await expect(next).toHaveAttribute('aria-disabled', 'true');
  });
});
