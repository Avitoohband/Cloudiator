import { test, expect, type BrowserContext, type Locator, type Page } from './fixtures';
import { randomUUID } from 'node:crypto';
import { ownerFixture, itemFixture } from '../fixtures/domain';
import type { ItemInstance } from '../../supabase/functions/_shared/contracts/reads';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1';
import { shopOffers } from '../../supabase/functions/_shared/domain/inventory';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands';
import { SLOT_MS, emptyWorld, isPresence, routeLiveReads } from './live-routes';
import { openMenu } from './shell-helpers';
import { slotTime } from './slot-time';
import { contrastIssues, focusDrops, focusedElement, watchFocus } from './a11y-helpers';

/** The pieces of the gear scenario by name: the player wears the sword, the shield and the light armor. */
const GEAR = ['sword:1:common', 'sword:1:uncommon', 'spear:1:common', 'round-shield:1:common', 'iron-helmet:1:common', 'light-armor:1:common'] as const;
type GearName = 'sword' | 'sword2' | 'spear' | 'shield' | 'helmet' | 'armor';
const GEAR_NAMES: GearName[] = ['sword', 'sword2', 'spear', 'shield', 'helmet', 'armor'];

/** `rulesVersion`: the active rules version the revision read names (Patch 1.6; the live transport's 'v1' when left out). */
async function inventoryFlow(context: BrowserContext, options: { gear?: boolean; rulesVersion?: string } = {}) {
  const state = structuredClone(ownerFixture);
  state.wallets = { money: 300, renown: 100 };
  state.inventory = ['axe:1:common', 'sword:1:renown', 'light-armor:1:common'].map(id => ({ ...itemFixture(CATALOG_V1.items[id]), id: randomUUID() }));
  state.inventory[2].reservation = { kind: 'equipment', referenceId: state.gladiatorId };
  /** The gear scenario's pieces by name (empty unless `gear`), worn ones reserved by their build as the server does. */
  const pieces = {} as Record<GearName, ItemInstance>;
  if (options.gear) {
    state.processedSlotIndex = Math.floor(Date.now() / SLOT_MS);
    state.inventory = GEAR.map(id => ({ ...itemFixture(CATALOG_V1.items[id]), id: randomUUID() }));
    GEAR_NAMES.forEach((name, index) => { pieces[name] = state.inventory[index]; });
    state.currentBuild.equipment = { weapon: pieces.sword.id, offHand: pieces.shield.id, head: null, body: pieces.armor.id, feet: null };
    for (const worn of [pieces.sword, pieces.shield, pieces.armor]) worn.reservation = { kind: 'equipment', referenceId: state.gladiatorId };
  }
  const commands: GameCommand[] = [], receipts = new Map<string, unknown>();
  let lose = false, code = '', sales = 0, refuseAt = 0, refuseCode = '', ownerDown = false;
  const user = { id: randomUUID(), aud: 'authenticated', role: 'authenticated', email: 'inventory@example.invalid',
    app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: {}, identities: [], created_at: new Date().toISOString() };
  await context.addInitScript(({ user }) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = `${btoa(JSON.stringify({ alg: 'HS256' }))}.${btoa(JSON.stringify({ sub: user.id, exp }))}.test-only`;
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: token, refresh_token: 'test-only', token_type: 'bearer', expires_at: exp, expires_in: 3600, user }));
  }, { user });
  // The live camp's public reads; this spec's own handler (registered next, so it runs first) hands it everything else.
  const live = await routeLiveReads(context, { world: emptyWorld(), rulesVersion: options.rulesVersion });
  await context.route('http://127.0.0.1:54321/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    const json = (body: unknown, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (path === '/auth/v1/user') return json(user);
    if (path === '/auth/v1/logout') return route.fulfill({ status: 204, headers });
    // `failOwnerReads(true)`: the owner read fails (a server error) until it is turned off again.
    if (path === '/rest/v1/owner_state') return ownerDown ? json({ message: 'unavailable' }, 503) : json([{ state }]);
    // The player's presence (Task 23.9) is the live transport's.
    if (path === '/functions/v1/game-command' && isPresence(request)) return route.fallback();
    if (path === '/functions/v1/game-command') {
      const command = request.postDataJSON() as GameCommand; commands.push(command);
      expect(request.headers().authorization).toMatch(/^Bearer /);
      expect(command).not.toHaveProperty('ownerId');
      if (code) return json({ ok: false, code }, 409);
      let result = receipts.get(command.operationId);
      // A sale the test refuses (the `at`-th sell-item this page sends): the server answers it with `code` and nothing changes.
      if (!result && command.kind === 'sell-item' && refuseAt && ++sales === refuseAt) return json({ ok: false, code: refuseCode }, 409);
      if (!result) {
        if (command.kind === 'buy-shop') {
          if (command.catalogId === 'banner') { state.wallets.renown -= 50; state.ownedCosmetics.push({ catalogId: 'banner', catalogVersion: 'v1', binding: 'bound' }); }
          else {
            state.wallets.money -= 40 * command.quantity;
            for (let i = 0; i < command.quantity; i++) state.inventory.push({ ...itemFixture(CATALOG_V1.items[command.catalogId]), id: randomUUID() });
          }
        } else if (command.kind === 'sell-item' || command.kind === 'discard-item') {
          const sold = state.inventory.find(item => item.id === command.itemId);
          const unit = sold ? (CATALOG_V1.items[sold.catalogId] ?? CATALOG_V1.salvage).npcSellValue ?? 0 : 0;
          if (sold && sold.quantity > command.quantity) sold.quantity -= command.quantity;
          else state.inventory = state.inventory.filter(item => item.id !== command.itemId);
          if (command.kind === 'sell-item' && sold) state.wallets.money += unit * command.quantity;
        } else if (command.kind === 'queue-build' || command.kind === 'cancel-build') {
          // As the server does: a stale version is a conflict, a queue replaces the pending build, a cancel clears it.
          if (command.expectedVersion !== state.buildVersion) return json({ ok: false, code: 'conflict' }, 409);
          const current = state.currentBuild;
          // The class and every attribute are fixed at the current build's (a class change or a lower attribute is invalid).
          if (command.kind === 'queue-build' && (command.classId !== current.classId
            || (Object.keys(current.allocations) as (keyof typeof current.allocations)[]).some(key => command.allocation[key] < current.allocations[key]))) return json({ ok: false, code: 'invalid' }, 409);
          state.buildVersion++;
          if (command.kind === 'queue-build') {
            const reservedItemIds = Object.values(command.equipment).filter((id): id is string => id !== null);
            state.pendingBuild = { build: { version: state.buildVersion, classId: command.classId, stance: command.stance, allocations: command.allocation, equipment: command.equipment },
              effectiveSlotIndex: state.processedSlotIndex + 1, reservedMoney: 0, reservedItemIds, operationId: command.operationId };
            result = { ok: true, receiptId: randomUUID(), value: state.pendingBuild };
          } else { state.pendingBuild = null; result = { ok: true, receiptId: randomUUID(), value: { buildVersion: state.buildVersion } }; }
        } else throw new Error('Unexpected inventory command');
        if (command.kind !== 'queue-build' && command.kind !== 'cancel-build') result = { ok: true, receiptId: randomUUID(), value: {} };
        receipts.set(command.operationId, result);
      }
      if (lose) { lose = false; return route.abort('failed'); }
      return json(result);
    }
    return route.fallback();
  });
  return { commands, state, pieces, live, loseNext: () => { lose = true; }, refuseSale: (at: number, value: string) => { refuseAt = at; refuseCode = value; sales = 0; }, reject: (value: string) => { code = value; },
    failOwnerReads: (on: boolean) => { ownerDown = on; } };
}

test.beforeEach(() => { test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Live UI uses development-only intercepted identity transport.'); });

const tile = (scope: Page | Locator, piece: ItemInstance) => scope.getByTestId(`tile-${piece.id}`);
const card = (scope: Page | Locator, piece: ItemInstance) => scope.getByTestId(`item-${piece.id}`);
async function selectItem(scope: Page | Locator, piece: ItemInstance) {
  await tile(scope, piece).click();
  return card(scope, piece);
}

// The shops as one icon grid (Patch 1.9): a cell per offer, filters, a currency switch and the chosen offer's card.
const shopsRegion = (scope: Page | Locator) => scope.getByRole('region', { name: 'Shops', exact: true });
const offerCell = (scope: Page | Locator, catalogId: string) => scope.getByTestId(`offer-${catalogId}`);
const offerDetails = (scope: Page | Locator) => scope.getByRole('region', { name: 'Offer details', exact: true });
const shopButton = (shops: Locator, group: 'Shop filters' | 'Shop currency', name: string) =>
  shops.getByRole('group', { name: group, exact: true }).getByRole('button', { name, exact: true });
/** Chooses a shop cell the way the player's device does: a tap on the phone, a click on the desktop. */
async function chooseOffer(shops: Locator, catalogId: string, mobile: boolean) {
  const cell = offerCell(shops, catalogId);
  if (mobile) await cell.tap(); else await cell.click();
  await expect(cell).toHaveAttribute('aria-pressed', 'true');
}

/** The camp reads the owner again when its next sync sees a new world revision. */
async function publishInventoryRefresh(page: Page, flow: Awaited<ReturnType<typeof inventoryFlow>>) {
  await page.waitForFunction(() => window.__cloudiatorShell!.syncs() > 0);
  const revision = randomUUID();
  flow.live.setWorld({ ...emptyWorld(), revision });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(expected => window.__cloudiatorCamp?.world()?.revision === expected, revision);
}

test('shows a square pixel-art inventory and selected item details', async ({ page, context }, info) => {
  const flow = await inventoryFlow(context);
  const [axe, sword, armor] = flow.state.inventory;
  sword.stats.damage = 12.08;
  const salvage: ItemInstance = { id: randomUUID(), ownerId: flow.state.gladiatorId, catalogId: CATALOG_V1.salvage.id, catalogVersion: CATALOG_V1.version,
    tier: 1, rarity: 'common', stats: structuredClone(CATALOG_V1.salvage.stats), quantity: 12, origin: 'expedition', binding: 'tradable', reservation: null };
  flow.state.inventory.push(salvage);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/game/');
  await openMenu(page, 'Inventory and shops');

  const grid = page.getByTestId('inventory-grid');
  const tiles = grid.getByRole('button');
  const detail = page.getByRole('region', { name: 'Item details' });
  // The shops below have All, Weapons and Armor too (Patch 1.9): these are the inventory's.
  const filter = (name: string) => page.getByRole('group', { name: 'Inventory filters', exact: true }).getByRole('button', { name, exact: true });
  await expect(tiles).toHaveCount(4);
  const geometry = await tiles.evaluateAll(nodes => nodes.map(node => {
    const { width, height } = node.getBoundingClientRect();
    const hasPixelArt = Array.from(node.querySelectorAll('*')).some(element => {
      const style = getComputedStyle(element);
      return style.imageRendering === 'pixelated' && (style.backgroundImage !== 'none' || element instanceof HTMLImageElement);
    });
    return { difference: Math.abs(width - height), hasPixelArt };
  }));
  for (const { difference, hasPixelArt } of geometry) {
    expect(difference).toBeLessThanOrEqual(1);
    expect(hasPixelArt).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(tile(grid, axe)).toHaveAccessibleName(/Axe.*level 1.*common/i);
  await expect(tile(grid, axe)).toHaveAccessibleDescription('Weight 6');
  if (info.project.name === 'mobile') await tile(grid, sword).tap();
  else await tile(grid, sword).click();
  await expect(tile(grid, sword)).toHaveAttribute('aria-pressed', 'true');
  await expect(detail.getByRole('heading', { name: 'Sword', exact: true })).toBeInViewport();
  await expect(detail).toContainText(/Damage\s*12\.08/);
  await expect(detail).toContainText(/Weight\s*4/);

  await filter('Weapons').click();
  await expect(tiles).toHaveCount(2);
  await expect(tile(grid, sword)).toHaveAttribute('aria-pressed', 'true');
  await filter('Armor').click();
  await expect(tiles).toHaveCount(1);
  await expect(tile(grid, armor)).toHaveAttribute('aria-pressed', 'true');
  await expect(detail).toContainText('Light armor');
  await filter('Materials').click();
  await expect(tiles).toHaveCount(1);
  await expect(tile(grid, salvage)).toContainText('×12');
  await expect(detail).toContainText('NPC sell value: 10 gold each');
  await filter('All').click();
  await expect(tiles).toHaveCount(4);
});

test('explains a stale discard after an inventory refresh and recovers keyboard focus', async ({ page, context }) => {
  await watchFocus(page);
  const flow = await inventoryFlow(context);
  const [axe] = flow.state.inventory;
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const selected = await selectItem(menu, axe);
  await selected.getByRole('button', { name: 'Discard', exact: true }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Confirm discard' });
  await expect(dialog.getByRole('button', { name: 'Keep item' })).toBeFocused();

  flow.state.inventory = flow.state.inventory.filter(item => item.id !== axe.id);
  await publishInventoryRefresh(page, flow);
  await expect(tile(menu, axe)).toHaveCount(0);
  await expect(dialog).toBeHidden();
  const notice = menu.getByRole('alert').filter({ hasText: /inventory changed.*discarding/i });
  await expect(notice).toBeFocused();
  expect(flow.commands).toEqual([]);
  expect(await focusDrops(page)).toEqual([]);
});

test('keeps the default and filtered inventory selections through an ordered refresh', async ({ page, context }) => {
  const flow = await inventoryFlow(context);
  const [axe, , armor] = flow.state.inventory;
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  await expect(tile(menu, axe)).toHaveAttribute('aria-pressed', 'true');
  const sell = card(menu, axe).getByRole('button', { name: /^Sell / });
  await sell.focus();

  const spear = { ...itemFixture(CATALOG_V1.items['spear:1:common']), id: randomUUID() };
  flow.state.inventory.unshift(spear);
  await publishInventoryRefresh(page, flow);
  await expect(tile(menu, spear)).toBeVisible();
  await expect(tile(menu, axe)).toHaveAttribute('aria-pressed', 'true');
  await expect(sell).toBeFocused();

  await menu.getByRole('group', { name: 'Inventory filters', exact: true }).getByRole('button', { name: 'Armor', exact: true }).click();
  await expect(tile(menu, armor)).toHaveAttribute('aria-pressed', 'true');
  const boots = { ...itemFixture(CATALOG_V1.items['light-boots:1:common']), id: randomUUID() };
  flow.state.inventory.unshift(boots);
  await publishInventoryRefresh(page, flow);
  await expect(tile(menu, boots)).toBeVisible();
  await expect(tile(menu, armor)).toHaveAttribute('aria-pressed', 'true');
});

test('distinguishes same-name bound and tradable inventory pieces on tiles and details', async ({ page, context }) => {
  const flow = await inventoryFlow(context);
  const bound = flow.state.inventory[1];
  const tradable = { ...itemFixture(CATALOG_V1.items['sword:1:common']), id: randomUUID() };
  flow.state.inventory.push(tradable);
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  // Different bindings never stack: each has its own tile, with its level, and the card says which it is.
  await expect(tile(menu, bound).getByText('L1', { exact: true })).toBeVisible();
  await expect(tile(menu, tradable).getByText('L1', { exact: true })).toBeVisible();
  await expect(tile(menu, bound)).toHaveAccessibleName(/Account-bound/);
  await expect(tile(menu, tradable)).toHaveAccessibleName(/Tradable/);
  await expect(await selectItem(menu, bound)).toContainText('Level 1 · common · Account-bound');
  await expect(await selectItem(menu, tradable)).toContainText('Level 1 · common · Tradable');
});

test('can sell the last unit after partially selling a material stack', async ({ page, context }) => {
  const flow = await inventoryFlow(context);
  const salvage: ItemInstance = { id: randomUUID(), ownerId: flow.state.gladiatorId, catalogId: CATALOG_V1.salvage.id, catalogVersion: CATALOG_V1.version,
    tier: 1, rarity: 'common', stats: structuredClone(CATALOG_V1.salvage.stats), quantity: 12, origin: 'expedition', binding: 'tradable', reservation: null };
  flow.state.inventory.push(salvage);
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const selected = await selectItem(menu, salvage);
  const quantity = selected.getByRole('spinbutton', { name: 'Quantity for Salvage' });
  const sell = selected.getByRole('button', { name: 'Sell', exact: true });
  await quantity.fill('11');
  await sell.click();
  await expect(selected).toContainText('1 owned');
  await expect(quantity).toHaveCount(0);
  await expect(sell).toBeEnabled();
  await expect(selected.getByRole('button', { name: 'Discard', exact: true })).toBeEnabled();
  await sell.click();
  await expect(tile(menu, salvage)).toHaveCount(0);
  expect(flow.commands).toMatchObject([{ kind: 'sell-item', itemId: salvage.id, quantity: 11 }, { kind: 'sell-item', itemId: salvage.id, quantity: 1 }]);
});

test('buys through the live gateway, refreshes inventory, and confirms bound discard without a cash reward', async ({ page, context }, info) => {
  const flow = await inventoryFlow(context);
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  await expect(page.getByText('3 / 60 slots')).toBeVisible();
  await page.getByRole('button', { name: 'Buy Sword', exact: true }).click();
  await expect(page.getByText('4 / 60 slots')).toBeVisible();
  const boundItem = flow.state.inventory[1];
  const bound = await selectItem(page, boundItem);
  await expect(bound.getByRole('button', { name: 'Sell' })).toBeDisabled();
  await bound.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm discard' })).toBeVisible();
  expect(flow.commands).toHaveLength(1);
  await page.getByRole('button', { name: 'Keep item' }).click();
  await bound.getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('button', { name: 'Confirm discard', exact: true }).click();
  await expect(tile(page, boundItem)).toHaveCount(0);
  expect(flow.commands.map(command => command.kind)).toEqual(['buy-shop', 'discard-item']);
  await expect(page.getByText('Available gold: 260')).toBeVisible();
  // Patch 1.9: the banner is a Renown cell, sold by the Armorer. Patch 1.6 (spec "The Arena banner"): its card says where the
  // banner shows, before and after it is bought.
  const shops = shopsRegion(menu);
  await shopButton(shops, 'Shop currency', 'Renown').click();
  await chooseOffer(shops, 'banner', info.project.name === 'mobile');
  const offer = offerDetails(shops);
  const DESCRIPTION = 'Cosmetic · Account-bound · Shown on your profile card · No inventory slot or combat bonus';
  await expect(offer.getByText(DESCRIPTION, { exact: true })).toBeVisible();
  await offer.scrollIntoViewIfNeeded();
  await offer.screenshot({ path: `.superpowers/sdd/2026-10-30-economy-1-6/task-9-shots/shop-banner-${info.project.name}-unowned.png` });
  await page.getByRole('button', { name: 'Buy Arena banner', exact: true }).click();
  await expect(offer.getByText('Arena banner · Owned · Shown on your profile card', { exact: true })).toBeVisible();
  await expect(offer.getByText(DESCRIPTION, { exact: true })).toBeVisible();
  await expect(page.getByText('Owned · Account-bound')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await menu.screenshot({ path: info.outputPath('inventory-shops.png') });
  await offer.screenshot({ path: `.superpowers/sdd/2026-10-30-economy-1-6/task-9-shots/shop-banner-${info.project.name}-owned.png` });
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 360, height: 740 });
  await offer.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.superpowers/sdd/2026-10-30-economy-1-6/task-9-shots/shop-banner-${info.project.name}-owned-360.png` });
  await page.setViewportSize(size);
});

test('retries the same operation after a lost response and explains processing without optimistic changes', async ({ page, context }, info) => {
  const flow = await inventoryFlow(context);
  await page.goto('/game/'); await openMenu(page, 'Inventory and shops');
  flow.loseNext();
  await page.getByRole('button', { name: 'Buy Sword', exact: true }).click();
  await expect(page.locator('.inventory-panel').getByRole('alert')).toContainText('could not be confirmed');
  await expect(page.getByText('3 / 60 slots')).toBeVisible();
  await page.getByRole('button', { name: 'Retry request' }).click();
  await expect(page.getByText('4 / 60 slots')).toBeVisible();
  expect(flow.commands[1]).toEqual(flow.commands[0]);
  flow.reject('processing');
  await chooseOffer(shopsRegion(page), 'axe:1:common', info.project.name === 'mobile');
  await page.getByRole('button', { name: 'Buy Axe', exact: true }).click();
  await expect(page.locator('.inventory-panel').getByRole('alert')).toContainText('processing');
  await expect(page.getByText('4 / 60 slots')).toBeVisible();
});

test('shows level locks and reservation restrictions with both currencies', async ({ page, context }, info) => {
  const flow = await inventoryFlow(context);
  await page.goto('/game/'); await openMenu(page, 'Inventory and shops');
  const equipped = await selectItem(page, flow.state.inventory[2]);
  await expect(equipped.getByRole('button', { name: 'Sell' })).toBeDisabled();
  await expect(equipped.getByRole('button', { name: 'Discard' })).toBeDisabled();
  // A level 1 player: the level 5 Sword is locked in both currencies, its card says why, and Buy stays disabled.
  const shops = shopsRegion(page), details = offerDetails(shops);
  await chooseOffer(shops, 'sword:5:common', info.project.name === 'mobile');
  await expect(offerCell(shops, 'sword:5:common')).toContainText('120');
  await expect(offerCell(shops, 'sword:5:common')).toHaveAccessibleDescription('Requires level 5');
  const buy = details.getByRole('button', { name: 'Buy Sword', exact: true });
  await expect(buy).toBeDisabled();
  await expect(buy).toHaveAccessibleDescription(/Requires level 5/);
  await expect(details).toContainText('120 gold each');
  await shopButton(shops, 'Shop currency', 'Renown').click();
  await expect(offerCell(shops, 'sword:5:renown')).toHaveAttribute('aria-pressed', 'true');
  await expect(offerCell(shops, 'sword:5:renown')).toContainText('100');
  await expect(details).toContainText('100 renown each');
  await expect(buy).toBeDisabled();
  expect(flow.commands).toHaveLength(0);
});

test('explains Marketplace outcomes for an item in words, with nothing to retry', async ({ page, context }) => {
  // Task 18.3: an item that a Marketplace sale or expiry changed is explained in words, never as a raw code.
  const flow = await inventoryFlow(context);
  await page.goto('/game/'); await openMenu(page, 'Inventory and shops');
  const axe = await selectItem(page, flow.state.inventory[0]);
  const alert = page.locator('.inventory-panel').getByRole('alert');
  for (const [code, words] of [['sold', 'sold on the Marketplace'], ['expired', 'listing has expired']] as const) {
    flow.reject(code);
    await axe.getByRole('button', { name: 'Sell' }).click();
    await expect(alert).toContainText(words);
    await expect(alert).not.toContainText('rejected');
    await expect(page.getByRole('button', { name: 'Retry request' })).toHaveCount(0);
  }
});

// Patch 1.6 (spec "Inventory and market"): a salvage stack's NPC value is the active rules' (10 gold a unit under v1, 4 after the economy
// switch); gear values do not change.
for (const [rulesVersion, unit] of [['v1', 10], ['v2', 4]] as const) {
  test(`values a salvage stack at ${unit} gold a unit under rules ${rulesVersion}, and gear the same`, async ({ page, context }, info) => {
    const flow = await inventoryFlow(context, { rulesVersion });
    const salvage: ItemInstance = { id: randomUUID(), ownerId: flow.state.gladiatorId, catalogId: CATALOG_V1.salvage.id, catalogVersion: CATALOG_V1.version,
      tier: 1, rarity: 'common', stats: structuredClone(CATALOG_V1.salvage.stats), quantity: 12, origin: 'expedition', binding: 'tradable', reservation: null };
    flow.state.inventory.push(salvage);
    await page.goto('/game/');
    await openMenu(page, 'Inventory and shops');
    const axe = await selectItem(page, flow.state.inventory[0]);
    await expect(axe).toContainText(`NPC sell value: ${CATALOG_V1.items['axe:1:common'].npcSellValue} gold each`);
    const stack = await selectItem(page, salvage);
    await expect(stack).toContainText(`NPC sell value: ${unit} gold each`);
    if (rulesVersion === 'v2') {
      await stack.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`economy-salvage-${info.project.name}.png`) });
      if (process.env.PERF_SHOTS) await page.screenshot({ path: `${process.env.PERF_SHOTS}/economy-${info.project.name}-salvage.png` });
    }
  });
}

test('fixture inventory and shops remain read-only alongside the camp', async ({ page }) => {
  await page.goto('/game/?mode=fixture');
  await openMenu(page, 'Inventory and shops');
  await expect(page.getByRole('heading', { name: 'Shops', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Buy Sword', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'unavailable in this preview' })).toBeVisible();
  // The fixture owner's Iron helmet is listed in the fixture market (Task 18.3): reserved, so it cannot be sold or discarded.
  await expect(page.getByText('1 / 60 slots')).toBeVisible();
  await page.getByTestId('inventory-grid').getByRole('button', { name: /^Iron helmet/ }).click();
  const helmet = page.getByRole('region', { name: 'Item details' });
  await expect(helmet).toContainText('Listed for sale');
  await expect(helmet.getByRole('button', { name: 'Sell' })).toBeDisabled();
  await expect(helmet.getByRole('button', { name: 'Discard' })).toBeDisabled();
});

// ---- The shops as an icon grid (Patch 1.9, the approved shop-grid mockup) ---------------------------------------------------

test('shows the shop offers as an icon grid by level, locks pieces above the level and marks prices the wallet cannot pay', async ({ page, context }, info) => {
  const flow = await inventoryFlow(context);
  flow.state.progression.level = 5;
  flow.state.wallets = { money: 100, renown: 100 };
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const shops = shopsRegion(menu);
  const filters = shops.getByRole('group', { name: 'Shop filters', exact: true });
  const currencies = shops.getByRole('group', { name: 'Shop currency', exact: true });
  await expect(filters.getByRole('button')).toHaveText(['All', 'Weapons', 'Armor']);
  await expect(filters.getByRole('button', { pressed: true })).toHaveText(['All']);
  await expect(currencies.getByRole('button')).toHaveText(['Gold', 'Renown']);
  await expect(currencies.getByRole('button', { pressed: true })).toHaveText(['Gold']);
  // The heading's balances are what can be spent, worded as the Inventory words them (final review Minor 7).
  await expect(shops.locator('p').filter({ hasText: 'Available gold' })).toHaveText(/Available gold\s*100\s*Available renown\s*100/);

  const gold = shopOffers(CATALOG_V1).filter(offer => offer.currency === 'money');
  expect(gold).toHaveLength(33);
  const cells = shops.locator('[data-testid^="offer-"]');
  await expect(cells).toHaveCount(33);
  const shown = await cells.evaluateAll(nodes => nodes.map(node => {
    const { width, height } = node.getBoundingClientRect();
    const art = Array.from(node.querySelectorAll('[data-item-icon]')).find(element => {
      const style = getComputedStyle(element);
      return style.imageRendering === 'pixelated' && style.backgroundImage !== 'none';
    });
    return { id: node.getAttribute('data-testid')!.slice('offer-'.length), text: node.textContent ?? '', square: Math.abs(width - height) <= 1,
      icon: art?.getAttribute('data-item-icon') ?? null, iconOpacity: art ? Number(getComputedStyle(art).opacity) : null,
      lock: node.querySelector('[data-shop-lock]') !== null, locked: node.hasAttribute('data-locked'), poor: node.hasAttribute('data-poor'),
      priceColor: getComputedStyle(node.querySelector('[data-shop-price]')!).color, tag: node.querySelector('[data-shop-level]')?.textContent ?? '' };
  }));
  expect(shown.map(cell => cell.id).sort()).toEqual(gold.map(offer => offer.catalogId).sort());
  const levels = shown.map(cell => gold.find(offer => offer.catalogId === cell.id)!.requiredLevel);
  expect(levels).toEqual([...levels].sort((a, b) => a - b));
  for (const cell of shown) {
    const offer = gold.find(entry => entry.catalogId === cell.id)!;
    expect(cell.square, cell.id).toBe(true);
    expect(cell.tag, cell.id).toBe(`L${offer.requiredLevel}`);
    expect(cell.text, cell.id).toContain(String(offer.unitPrice));
    expect(cell.icon, cell.id).not.toBeNull();
    const locked = offer.requiredLevel > 5;
    expect([cell.locked, cell.lock, cell.poor], cell.id).toEqual([locked, locked, !locked && offer.unitPrice > 100]);
    expect(cell.iconOpacity! < 1, cell.id).toBe(locked);
  }
  const color = (id: string) => shown.find(cell => cell.id === id)!.priceColor;
  expect(color('sword:5:common')).not.toBe(color('sword:1:common'));
  await expect(offerCell(shops, 'sword:10:common')).toHaveAccessibleDescription('Requires level 10');
  await expect(offerCell(shops, 'sword:5:common')).toHaveAccessibleDescription('Not enough available gold');
  await expect(offerCell(shops, 'sword:1:common')).toHaveAccessibleDescription('');
  await expect(offerCell(shops, 'sword:1:common')).toHaveAccessibleName(/^Sword, level 1, 40 gold/);

  // The first cell is chosen; its card sits beside the grid on the desktop and below it on the phone.
  await expect(offerCell(shops, shown[0].id)).toHaveAttribute('aria-pressed', 'true');
  const details = offerDetails(shops);
  await expect(details.getByRole('heading', { name: 'Sword', exact: true })).toBeVisible();
  await expect(details).toContainText('Weapon · sold by the Weaponsmith');
  await expect(details).toContainText('40 gold each');
  await expect(details).toContainText(`NPC sell value: ${CATALOG_V1.items['sword:1:common'].npcSellValue} gold each`);
  const grid = (await shops.getByRole('group', { name: 'Shop items' }).boundingBox())!, card = (await details.boundingBox())!;
  if (info.project.name === 'mobile') expect(card.y).toBeGreaterThanOrEqual(grid.y + grid.height - 1);
  else expect(card.x).toBeGreaterThanOrEqual(grid.x + grid.width - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shops.screenshot({ path: info.outputPath(`shop-grid-${info.project.name}.png`) });
});

test('after a filter or currency change the chosen shop cell is inside the grid, with no empty rows below a short list', async ({ page, context }, info) => {
  await inventoryFlow(context);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const shops = shopsRegion(menu);
  const scroll = shops.getByRole('group', { name: 'Shop items', exact: true });
  const inside = async (testId: string) => {
    const box = (await scroll.boundingBox())!, cell = (await shops.getByTestId(testId).boundingBox())!;
    return cell.y >= box.y - 1 && cell.y + cell.height <= box.y + box.height + 1;
  };
  await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await shopButton(shops, 'Shop filters', 'Weapons').click();
  await expect.poll(() => inside('offer-sword:1:common')).toBe(true);
  // A short list adds no empty rows below its last cell: the grid is no taller than its cells plus one row.
  const cells = await shops.locator('[data-testid^="offer-"]').count();
  const slots = await scroll.locator(':scope > div > *').count();
  expect(slots).toBeLessThanOrEqual(Math.max(cells, 6));
  await shopButton(shops, 'Shop currency', 'Renown').click();
  await expect.poll(() => inside('offer-sword:1:renown')).toBe(true);
});

test('keeps the shop card, the keyboard choice and Buy on the same one of two same-name offers', async ({ page, context }, info) => {
  const mobile = info.project.name === 'mobile';
  const flow = await inventoryFlow(context);
  flow.state.progression.level = 5;
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const shops = shopsRegion(menu), details = offerDetails(shops);
  const first = offerCell(shops, 'sword:1:common'), fifth = offerCell(shops, 'sword:5:common');
  const [low, high] = [CATALOG_V1.items['sword:1:common'], CATALOG_V1.items['sword:5:common']];
  expect(low.stats.damage).not.toBe(high.stats.damage);
  await chooseOffer(shops, 'sword:1:common', mobile);
  await expect(details).toContainText('Level 1 · common · Tradable');
  await expect(details).toContainText(new RegExp(`Damage\\s*${low.stats.damage}(?!\\d)`));

  // The arrow keys move between cells without choosing; Enter or Space chooses.
  await first.focus();
  await page.keyboard.press('ArrowDown');
  await expect(first).not.toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(first).toBeFocused();
  for (let step = 0; step < 11; step++) await page.keyboard.press('ArrowRight');
  await expect(fifth).toBeFocused();
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(details).toContainText('Level 1 · common');
  await page.keyboard.press('Enter');
  await expect(fifth).toHaveAttribute('aria-pressed', 'true');
  await expect(first).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Space');
  await expect(offerCell(shops, 'heavy-boots:1:common')).toHaveAttribute('aria-pressed', 'true');
  await expect(details.getByRole('heading', { name: 'Heavy boots', exact: true })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(fifth).toHaveAttribute('aria-pressed', 'true');
  await expect(details.getByRole('heading', { name: 'Sword', exact: true })).toBeVisible();
  await expect(details).toContainText('Level 5 · common · Tradable');
  await expect(details).toContainText(new RegExp(`Damage\\s*${high.stats.damage}(?!\\d)`));
  await expect(details).toContainText(/Weight\s*4/);
  await expect(details).toContainText(`${high.moneyPrice} gold each`);

  // A pointer passing over another cell while the keyboard is on Buy changes neither the card nor what Buy sends.
  const buy = details.getByRole('button', { name: 'Buy Sword', exact: true });
  await buy.focus();
  await offerCell(shops, 'axe:1:common').hover();
  await expect(buy).toBeFocused();
  await expect(fifth).toHaveAttribute('aria-pressed', 'true');
  await expect(details).toContainText('Level 5 · common · Tradable');
  await page.keyboard.press('Enter');
  await expect(menu.getByRole('status').filter({ hasText: 'Purchase confirmed.' })).toBeVisible();
  expect(flow.commands).toMatchObject([{ kind: 'buy-shop', catalogId: 'sword:5:common', quantity: 1 }]);

  // Gold to Renown keeps the chosen piece: the renown Sword of level 5.
  await shopButton(shops, 'Shop currency', 'Renown').click();
  await expect(offerCell(shops, 'sword:5:renown')).toHaveAttribute('aria-pressed', 'true');
  await expect(details).toContainText('100 renown each');
  await expect(details).toContainText('Level 5 · common · Account-bound');
  await expect(details).toContainText('Account-bound · Cannot sell');
  await details.getByRole('button', { name: 'Buy Sword', exact: true }).click();
  await expect.poll(() => flow.commands.length).toBe(2);
  expect(flow.commands[1]).toMatchObject({ kind: 'buy-shop', catalogId: 'sword:5:renown', quantity: 1 });
});

test('chooses the first visible offer when a filter hides the choice, and sells the Arena banner in Renown at the Armorer', async ({ page, context }, info) => {
  const mobile = info.project.name === 'mobile';
  const flow = await inventoryFlow(context);
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const shops = shopsRegion(menu), details = offerDetails(shops);
  const cells = shops.locator('[data-testid^="offer-"]');
  await chooseOffer(shops, 'axe:1:common', mobile);
  await shopButton(shops, 'Shop filters', 'Weapons').click();
  await expect(cells).toHaveCount(12);
  await expect(offerCell(shops, 'axe:1:common')).toHaveAttribute('aria-pressed', 'true');
  await shopButton(shops, 'Shop filters', 'Armor').click();
  await expect(cells).toHaveCount(21);
  await expect(offerCell(shops, 'round-shield:1:common')).toHaveAttribute('aria-pressed', 'true');
  await expect(details.getByRole('button', { name: 'Buy Round shield', exact: true })).toBeVisible();
  await expect(details).toContainText('Off-hand · sold by the Armorer');

  await shopButton(shops, 'Shop currency', 'Renown').click();
  await expect(cells).toHaveCount(22);
  const banner = offerCell(shops, 'banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(String(CATALOG_V1.cosmetics.banner.renownPrice));
  await chooseOffer(shops, 'banner', mobile);
  await expect(details).toContainText('Cosmetic · Account-bound · Shown on your profile card · No inventory slot or combat bonus');
  await expect(details).toContainText(`${CATALOG_V1.cosmetics.banner.renownPrice} renown`);
  await expect(details.getByRole('spinbutton', { name: 'Purchase quantity' })).toHaveCount(0);
  await shopButton(shops, 'Shop filters', 'Weapons').click();
  await expect(banner).toHaveCount(0);
  await expect(offerCell(shops, 'sword:1:renown')).toHaveAttribute('aria-pressed', 'true');
  await shopButton(shops, 'Shop filters', 'All').click();
  await expect(cells).toHaveCount(34);
  await shopButton(shops, 'Shop currency', 'Gold').click();
  await expect(cells).toHaveCount(33);
  await expect(offerCell(shops, 'sword:1:common')).toHaveAttribute('aria-pressed', 'true');
  expect(flow.commands).toEqual([]);
});

// ---- The gear view (launch feedback, note 9) ------------------------------------------------------------------------------

/** The shared display clock's time in the page. */
const clockNow = (page: Page) => page.evaluate(() => window.__cloudiatorShell!.clock.now());
const wear = (page: Page, piece: ItemInstance) => card(page, piece).getByRole('button', { name: /^Wear / });
const undo = (page: Page, piece: ItemInstance) => card(page, piece).getByRole('button', { name: /^Undo wearing / });
const wearing = (page: Page, piece: ItemInstance) => card(page, piece).getByRole('button', { name: /^Wearing / });
const badge = (page: Page, piece: ItemInstance) => tile(page, piece).locator('[data-gear-badge]');
async function wearItem(page: Page, piece: ItemInstance) {
  await selectItem(page, piece);
  await wear(page, piece).click();
}
const wearingNow = (page: Page) => page.getByRole('region', { name: 'Wearing now' });
const cancelChanges = (page: Page) => page.getByRole('button', { name: 'Cancel changes', exact: true });
/** The queued build's effective time as the page shows it (the next slot), worked out in the page apart from the panel. */
const effectiveTime = async (page: Page, processedSlotIndex: number) => slotTime(page, (processedSlotIndex + 1) * SLOT_MS, await clockNow(page));
/** A stance change another session (the build panel) queued: the pending build holds the current gear and an offensive stance. */
function queueStanceChange(flow: Awaited<ReturnType<typeof inventoryFlow>>) {
  const { state, pieces } = flow;
  state.buildVersion = 2;
  state.pendingBuild = { build: { ...state.currentBuild, version: 2, stance: 'offensive' }, effectiveSlotIndex: state.processedSlotIndex + 1,
    reservedMoney: 0, reservedItemIds: [pieces.sword.id, pieces.shield.id, pieces.armor.id], operationId: randomUUID() };
}

test('shows what is worn and swaps a second sword with its badges, Undo and Cancel changes', async ({ page, context }, info) => {
  const flow = await inventoryFlow(context, { gear: true });
  const { sword, sword2, shield, armor, helmet } = flow.pieces;
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  // The row names the five slots and what is worn in each.
  const row = wearingNow(page), cells = row.getByRole('listitem');
  await expect(cells).toHaveCount(5);
  const slots = [['Weapon', 'Sword'], ['Off-hand', 'Round shield'], ['Head', 'Empty'], ['Body', 'Light armor'], ['Feet', 'Empty']];
  for (const [index, [label, piece]] of slots.entries()) {
    await expect(cells.nth(index)).toContainText(label);
    await expect(cells.nth(index)).toContainText(piece);
  }
  await expect(cancelChanges(page)).toHaveCount(0);
  // Each worn piece says so; the others offer Wear, and nothing says a swap is queued.
  await selectItem(page, sword);
  await expect(badge(page, sword)).toHaveText('Wearing');
  await expect(wearing(page, sword)).toBeDisabled();
  await selectItem(page, sword2);
  await expect(badge(page, sword2)).toHaveCount(0);
  await expect(wear(page, sword2)).toHaveAccessibleName('Wear Sword, level 1 uncommon');
  await expect(wear(page, sword2)).toBeEnabled();
  // Wear queues the whole build with only the weapon changed, from the next slot.
  await wear(page, sword2).click();
  await expect(card(page, sword2).getByRole('status')).toHaveText('Sword will be worn from the next slot.');
  expect(flow.commands).toHaveLength(1);
  expect(flow.commands[0]).toMatchObject({ kind: 'queue-build', expectedVersion: 1, classId: 'guardian', stance: 'balanced',
    allocation: ownerFixture.currentBuild.allocations, equipment: { weapon: sword2.id, offHand: shield.id, head: null, body: armor.id, feet: null } });
  const time = await effectiveTime(page, flow.state.processedSlotIndex);
  await expect(badge(page, sword2)).toHaveText(`Wears from ${time}`);
  await expect(badge(page, sword)).toHaveText(`Off at ${time}`);
  await expect(badge(page, shield)).toHaveText('Wearing');
  await expect(row.getByText(/^Gear changes start/)).toHaveText(`Gear changes start at the next slot, ${time}. Anything already running keeps the gear it started with.`);
  await expect(cells.nth(0)).toContainText('Next: Sword, level 1 · uncommon');
  await expect(cells.nth(0)).toContainText('Level 1 · common');
  await expect(undo(page, sword2)).toBeEnabled();
  await selectItem(page, sword);
  await expect(wear(page, sword)).toBeEnabled();
  await selectItem(page, sword2);
  expect(await contrastIssues(menu)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await row.scrollIntoViewIfNeeded();
  await menu.screenshot({ path: info.outputPath('inventory-gear-queued.png') });
  // Undo takes the only queued change back: nothing is left to queue, so the pending build is canceled.
  await undo(page, sword2).click();
  await expect(card(page, sword2).getByRole('status')).toHaveText('Swap undone. Sword stays worn.');
  expect(flow.commands[1]).toMatchObject({ kind: 'cancel-build', expectedVersion: 2 });
  expect(flow.state.pendingBuild).toBeNull();
  await expect(badge(page, sword2)).toHaveCount(0);
  await expect(badge(page, sword)).toHaveText('Wearing');
  await expect(row.getByText(/^Gear changes start/)).toHaveCount(0);
  // Two pieces queued, then Cancel changes puts all the gear back.
  await wearItem(page, helmet);
  await expect(card(page, helmet).getByRole('status')).toHaveText('Iron helmet will be worn from the next slot.');
  await wearItem(page, sword2);
  await expect(badge(page, sword2)).toHaveText(`Wears from ${time}`);
  expect(flow.commands[3]).toMatchObject({ kind: 'queue-build', expectedVersion: 4,
    equipment: { weapon: sword2.id, offHand: shield.id, head: helmet.id, body: armor.id, feet: null } });
  await expect(cells.nth(2)).toContainText('Next: Iron helmet, level 1 · common');
  await cancelChanges(page).click();
  await expect(row.getByRole('status')).toHaveText('Gear changes canceled.');
  expect(flow.commands[4]).toMatchObject({ kind: 'cancel-build', expectedVersion: 5 });
  await expect(badge(page, helmet)).toHaveCount(0);
  await expect(cancelChanges(page)).toHaveCount(0);
  // Wearing the piece that is going off again lands back on the current build: the same as an undo.
  await wearItem(page, sword2);
  await expect(badge(page, sword)).toHaveText(`Off at ${time}`);
  await wearItem(page, sword);
  await expect(card(page, sword).getByRole('status')).toHaveText('Back to your current gear. No gear change is queued.');
  expect(flow.commands.at(-1)).toMatchObject({ kind: 'cancel-build' });
  await expect(badge(page, sword)).toHaveText('Wearing');
  await expect(badge(page, sword2)).toHaveCount(0);
});

test('keeps a queued stance change when gear is swapped, undone or canceled', async ({ page, context }) => {
  const flow = await inventoryFlow(context, { gear: true });
  const { sword, sword2, shield, armor } = flow.pieces;
  queueStanceChange(flow);
  await page.goto('/game/');
  await openMenu(page, 'Inventory and shops');
  // A stance change alone queues no gear: no gear note, no Cancel changes.
  await expect(badge(page, sword)).toHaveText('Wearing');
  await expect(wearingNow(page).getByText(/^Gear changes start/)).toHaveCount(0);
  await expect(cancelChanges(page)).toHaveCount(0);
  // Wear sends the whole queued build, the offensive stance included, on the pending build's version.
  await wearItem(page, sword2);
  await expect(badge(page, sword2)).toBeVisible();
  expect(flow.commands[0]).toMatchObject({ kind: 'queue-build', expectedVersion: 2, classId: 'guardian', stance: 'offensive',
    equipment: { weapon: sword2.id, offHand: shield.id, head: null, body: armor.id, feet: null } });
  // Undo restores the sword and keeps the stance change, so it is a queue-build, not a cancel-build.
  await undo(page, sword2).click();
  await expect(card(page, sword2).getByRole('status')).toHaveText('Swap undone. Sword stays worn.');
  expect(flow.commands[1]).toMatchObject({ kind: 'queue-build', expectedVersion: 3, classId: 'guardian', stance: 'offensive',
    equipment: { weapon: sword.id, offHand: shield.id, head: null, body: armor.id, feet: null } });
  expect(flow.state.pendingBuild?.build.stance).toBe('offensive');
  // Cancel changes puts the gear back and says the other queued changes stay.
  await wearItem(page, sword2);
  await expect(wearingNow(page).getByText(/^Gear changes start/)).toContainText('Cancel changes puts the gear back; your other queued build changes stay.');
  await cancelChanges(page).click();
  await expect(wearingNow(page).getByRole('status')).toHaveText('Gear changes canceled. Your other queued build changes are kept.');
  expect(flow.commands[3]).toMatchObject({ kind: 'queue-build', expectedVersion: 5, classId: 'guardian', stance: 'offensive',
    equipment: { weapon: sword.id, offHand: shield.id, head: null, body: armor.id, feet: null } });
  expect(flow.state.pendingBuild?.build.stance).toBe('offensive');
  await expect(badge(page, sword2)).toHaveCount(0);
  await expect(cancelChanges(page)).toHaveCount(0);
});

test('drops a class change queued before the release when gear is swapped, so the server never refuses it', async ({ page, context }) => {
  const flow = await inventoryFlow(context, { gear: true });
  const { sword2, shield, armor } = flow.pieces;
  // A pending build from before the class was fixed: it holds a Berserker class and keeps its old fee.
  flow.state.buildVersion = 2;
  flow.state.pendingBuild = { build: { ...flow.state.currentBuild, version: 2, classId: 'berserker' }, effectiveSlotIndex: flow.state.processedSlotIndex + 1,
    reservedMoney: 100, reservedItemIds: [flow.pieces.sword.id, shield.id, armor.id], operationId: randomUUID() };
  await page.goto('/game/');
  await openMenu(page, 'Inventory and shops');
  await wearItem(page, sword2);
  await expect(badge(page, sword2)).toBeVisible();
  // The whole build is sent with the CURRENT class (the server refuses a class change), and the gear change is accepted.
  expect(flow.commands[0]).toMatchObject({ kind: 'queue-build', expectedVersion: 2, classId: 'guardian',
    equipment: { weapon: sword2.id, offHand: shield.id, head: null, body: armor.id, feet: null } });
  expect(flow.state.pendingBuild?.build.classId).toBe('guardian');
  await expect(card(page, sword2).getByRole('alert')).toHaveCount(0);
});

test('frees the off-hand for a two-handed weapon, and undoing it brings the shield back', async ({ page, context }) => {
  const flow = await inventoryFlow(context, { gear: true });
  const { sword, spear, shield, armor } = flow.pieces;
  queueStanceChange(flow);
  await page.goto('/game/');
  await openMenu(page, 'Inventory and shops');
  await selectItem(page, shield);
  await expect(wear(page, shield)).toHaveCount(0);
  await expect(wearing(page, shield)).toBeDisabled();
  await wearItem(page, spear);
  await expect(badge(page, spear)).toBeVisible();
  expect(flow.commands[0]).toMatchObject({ kind: 'queue-build', classId: 'guardian', stance: 'offensive', equipment: { weapon: spear.id, offHand: null, head: null, body: armor.id, feet: null } });
  // The shield is going off and cannot be worn while the spear is next: its button says why, in words.
  const time = await effectiveTime(page, flow.state.processedSlotIndex);
  await expect(badge(page, shield)).toHaveText(`Off at ${time}`);
  await selectItem(page, shield);
  await expect(card(page, shield).getByText('Needs a free hand', { exact: true })).toBeVisible();
  await expect(wear(page, shield)).toBeDisabled();
  await expect(wear(page, shield)).toHaveAccessibleName('Wear Round shield, level 1 common');
  await expect(wear(page, shield)).toHaveAccessibleDescription('Needs a free hand');
  await expect(wearingNow(page).getByRole('listitem').nth(1)).toContainText('Next: Empty');
  await selectItem(page, sword);
  await expect(wear(page, sword)).toBeEnabled();
  // Undo brings the sword and the shield back together; the stance change stays queued.
  await selectItem(page, spear);
  await undo(page, spear).click();
  await expect(card(page, spear).getByRole('status')).toHaveText('Swap undone. Sword stays worn.');
  expect(flow.commands[1]).toMatchObject({ kind: 'queue-build', classId: 'guardian', stance: 'offensive', equipment: { weapon: sword.id, offHand: shield.id, head: null, body: armor.id, feet: null } });
  await expect(badge(page, shield)).toHaveText('Wearing');
  await selectItem(page, shield);
  await expect(card(page, shield).getByText('Needs a free hand')).toHaveCount(0);
  await expect(badge(page, sword)).toHaveText('Wearing');
  await expect(wearing(page, shield)).toBeDisabled();
});

test('brings the shield back when a one-handed weapon is worn after a two-handed one, without Undo', async ({ page, context }) => {
  // The player presses Wear on the spear, changes their mind and presses Wear on a sword instead of Undo: the off-hand follows
  // the weapon's hands, so the shield is not dropped (the approved mockup derives it the same way).
  const flow = await inventoryFlow(context, { gear: true });
  const { sword, sword2, spear, shield, armor } = flow.pieces;
  await page.goto('/game/');
  await openMenu(page, 'Inventory and shops');
  const offHandCell = wearingNow(page).getByRole('listitem').nth(1);
  await wearItem(page, spear);
  await expect(badge(page, spear)).toBeVisible();
  await expect(badge(page, shield)).toHaveText(/^Off at /);
  await expect(offHandCell).toContainText('Next: Empty');
  // The other sword: a queue-build with the shield still worn, only the weapon changed.
  await wearItem(page, sword2);
  await expect(badge(page, sword2)).toBeVisible();
  expect(flow.commands[1]).toMatchObject({ kind: 'queue-build', equipment: { weapon: sword2.id, offHand: shield.id, head: null, body: armor.id, feet: null } });
  await expect(badge(page, shield)).toHaveText('Wearing');
  await selectItem(page, shield);
  await expect(card(page, shield).getByText('Needs a free hand')).toHaveCount(0);
  await expect(offHandCell).not.toContainText('Next:');
  await expect(wearingNow(page).getByRole('listitem').nth(0)).toContainText('Next: Sword, level 1 · uncommon');
  await expect(badge(page, spear)).toHaveCount(0);
  // The spear again, then the sword that is worn now: back on the current build, so the pending build is canceled.
  await wearItem(page, spear);
  await expect(badge(page, shield)).toHaveText(/^Off at /);
  await wearItem(page, sword);
  expect(flow.commands[3]).toMatchObject({ kind: 'cancel-build' });
  expect(flow.state.pendingBuild).toBeNull();
  await expect(badge(page, shield)).toHaveText('Wearing');
  await expect(badge(page, sword)).toHaveText('Wearing');
  await expect(card(page, sword).getByRole('status')).toHaveText('Back to your current gear. No gear change is queued.');
});

test('says why a piece cannot be worn: a level not reached, or a Marketplace listing', async ({ page, context }) => {
  const flow = await inventoryFlow(context, { gear: true });
  const high = { ...itemFixture(CATALOG_V1.items['axe:5:common']), id: randomUUID() };
  const listed = { ...itemFixture(CATALOG_V1.items['leather-hood:1:common']), id: randomUUID(), reservation: { kind: 'listing' as const, referenceId: randomUUID() } };
  flow.state.inventory.push(high, listed);
  await page.goto('/game/');
  await openMenu(page, 'Inventory and shops');
  await selectItem(page, high);
  await expect(wear(page, high)).toBeDisabled();
  await expect(wear(page, high)).toHaveAccessibleDescription('Needs level 5');
  await expect(card(page, high).getByText('Needs level 5', { exact: true })).toBeVisible();
  await selectItem(page, listed);
  await expect(wear(page, listed)).toBeDisabled();
  await expect(wear(page, listed)).toHaveAccessibleDescription('Listed for sale');
  // Said once to a screen reader (final review fix: the availability line and a note both said it, so it was read twice). The Sell box
  // repeats it for the eye only (the stacks mockup), hidden from assistive technology, and the Sell button is described by the first.
  expect((await card(page, listed).innerText()).match(/Listed for sale/g)).toHaveLength(2);
  await expect(card(page, listed).getByText('Listed for sale', { exact: true })).toHaveCount(2);
  await expect(card(page, listed).locator('p[aria-hidden="true"]')).toHaveText('Listed for sale');
  await expect(card(page, listed).getByRole('button', { name: /^Sell / })).toHaveAccessibleDescription('Listed for sale');
  expect(flow.commands).toHaveLength(0);
});

test('explains a gear change the server no longer allows in words, and reloads the gear', async ({ page, context }) => {
  // Final review fix: the server answers `invalid` for any build that fails its checks, here a piece listed for sale in
  // another session since the view was loaded. The card says so in words, offers no retry, and the reload shows why.
  const flow = await inventoryFlow(context, { gear: true });
  const { sword2 } = flow.pieces;
  await page.goto('/game/');
  await openMenu(page, 'Inventory and shops');
  await selectItem(page, sword2);
  await expect(wear(page, sword2)).toBeEnabled();
  sword2.reservation = { kind: 'listing', referenceId: randomUUID() };
  flow.reject('invalid');
  await wear(page, sword2).click();
  await expect(card(page, sword2).getByRole('alert')).toHaveText('That gear change is no longer possible. Your gear has been reloaded.');
  await expect(card(page, sword2).getByRole('button', { name: 'Retry request' })).toHaveCount(0);
  await expect(wear(page, sword2)).toBeDisabled();
  await expect(wear(page, sword2)).toHaveAccessibleDescription('Listed for sale');
  expect(flow.commands).toHaveLength(1);
});

for (const action of ['sell-item', 'discard-item', 'buy-shop', 'buy-banner'] as const) {
  test(`keeps keyboard focus on a busy inventory ${action} button and ignores repeated activation`, async ({ page, context }, info) => {
    await watchFocus(page);
    const flow = await inventoryFlow(context);
    flow.reject('processing');
    const kind = action === 'buy-banner' ? 'buy-shop' : action;
    let release!: () => void;
    const reply = new Promise<void>(resolve => { release = resolve; });
    let requests = 0;
    await context.route('http://127.0.0.1:54321/functions/v1/game-command', async route => {
      if (route.request().method() !== 'POST' || route.request().postDataJSON().kind !== kind) return route.fallback();
      requests++;
      await reply;
      return route.fallback();
    });
    await page.goto('/game/');
    const panel = await openMenu(page, 'Inventory and shops');
    let button: Locator;
    if (action === 'sell-item') button = (await selectItem(panel, flow.state.inventory[0])).getByRole('button', { name: /^Sell / });
    else if (action === 'discard-item') button = (await selectItem(panel, flow.state.inventory[1])).getByRole('button', { name: 'Discard', exact: true });
    else {
      if (action === 'buy-banner') {
        await shopButton(shopsRegion(panel), 'Shop currency', 'Renown').click();
        await chooseOffer(shopsRegion(panel), 'banner', info.project.name === 'mobile');
      }
      button = panel.getByRole('button', { name: action === 'buy-banner' ? 'Buy Arena banner' : 'Buy Sword', exact: true });
    }
    const activate = async () => {
      await button.focus();
      await page.keyboard.press('Enter');
      if (action === 'discard-item') {
        await expect(page.getByRole('dialog', { name: 'Confirm discard' }).getByRole('button', { name: 'Keep item' })).toBeFocused();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Enter');
      }
    };
    const sent = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/game-command') && request.postDataJSON().kind === kind);
    await activate();
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
      await expect(page.getByRole('dialog', { name: 'Confirm discard' })).not.toBeVisible();
      expect(requests).toBe(1);
    } finally { release(); }
    const refused = panel.getByRole('alert');
    await expect(refused).toContainText('processing');
    await expect(button).toBeFocused();
    await expect(refused).not.toBeFocused();
    await expect(refused).toHaveAttribute('data-focus-target', '');
    expect(flow.commands.map(command => command.kind)).toEqual([kind]);
    // Success removes Sell, Discard and the owned cosmetic's Buy, but an equipment Buy survives. Focus follows that result.
    flow.reject('');
    await activate();
    const outcome = panel.getByRole('status').filter({ hasText: action === 'sell-item' ? /^Sold Axe for \d+ gold\.$/ : action === 'discard-item' ? 'Item discarded.' : 'Purchase confirmed.' });
    await expect(outcome).toBeVisible();
    if (action === 'buy-shop') await expect(button).toBeFocused();
    else await expect(outcome).toBeFocused();
    expect(flow.commands).toHaveLength(2);
    expect(flow.commands[1]).toEqual(flow.commands[0]);
    expect(await focusDrops(page)).toEqual([]);
  });
}

for (const kind of ['queue-build', 'cancel-build'] as const) {
  test(`keeps keyboard focus on a busy build ${kind} button and ignores repeated activation`, async ({ page, context }) => {
    await watchFocus(page);
    const flow = await inventoryFlow(context, { gear: true });
    if (kind === 'cancel-build') {
      flow.state.buildVersion++;
      flow.state.pendingBuild = {
        build: { ...structuredClone(flow.state.currentBuild), version: flow.state.buildVersion, stance: 'offensive' },
        effectiveSlotIndex: flow.state.processedSlotIndex + 1, reservedMoney: 0, reservedItemIds: [], operationId: randomUUID(),
      };
    }
    flow.reject('processing');
    let release!: () => void;
    const reply = new Promise<void>(resolve => { release = resolve; });
    let requests = 0;
    await context.route('http://127.0.0.1:54321/functions/v1/game-command', async route => {
      if (route.request().method() !== 'POST' || route.request().postDataJSON().kind !== kind) return route.fallback();
      requests++;
      await reply;
      return route.fallback();
    });
    await page.goto('/game/');
    const panel = await openMenu(page, 'My gladiator');
    const button = panel.getByRole('button', { name: kind === 'queue-build' ? 'Queue build' : 'Cancel pending build', exact: true });
    await button.focus();
    const sent = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/game-command') && request.postDataJSON().kind === kind);
    await page.keyboard.press('Enter');
    await sent;
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    try {
      await frames();
      // The shell observes body mutations before Chrome's later disabled-button blur. A head mutation lets the watcher
      // sample that later frame without giving the shell another body mutation on which it could rescue the focus.
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
      expect(requests).toBe(1);
    } finally { release(); }
    const refused = panel.getByRole('alert');
    await expect(refused).toContainText('processing');
    await expect(button).toBeFocused();
    await expect(refused).not.toBeFocused();
    await expect(refused).toHaveAttribute('data-focus-target', '');
    expect(flow.commands.map(command => command.kind)).toEqual([kind]);
    // Retrying the same operation succeeds: a surviving Queue keeps its focus; the removed Cancel hands it to the result.
    flow.reject('');
    await page.keyboard.press('Enter');
    const outcome = panel.getByRole('status').filter({ hasText: kind === 'queue-build' ? 'Build queued.' : 'Pending build canceled.' });
    await expect(outcome).toBeVisible();
    if (kind === 'cancel-build') await expect(outcome).toBeFocused();
    else await expect(button).toBeFocused();
    expect(flow.commands).toHaveLength(2);
    expect(flow.commands[1]).toEqual(flow.commands[0]);
    expect(await focusDrops(page)).toEqual([]);
  });
}

// Enter in an attribute field submits the form, and the busy fieldsets disable that field. The shell's rescue puts the
// focus on the menu panel at once (never on <body>), and the result takes it when the command settles (`useOutcomeFocus`).
test('keeps the focus in the panel when Enter in an attribute field sends the build, then gives it to the result', async ({ page, context }) => {
  await watchFocus(page);
  const flow = await inventoryFlow(context, { gear: true });
  let release!: () => void;
  const reply = new Promise<void>(resolve => { release = resolve; });
  await context.route('http://127.0.0.1:54321/functions/v1/game-command', async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON().kind !== 'queue-build') return route.fallback();
    await reply;
    return route.fallback();
  });
  await page.goto('/game/');
  const panel = await openMenu(page, 'My gladiator');
  const field = panel.getByRole('spinbutton', { name: 'strength', exact: true });
  const button = panel.getByRole('button', { name: 'Queue build', exact: true });
  await field.focus();
  const sent = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/game-command') && request.postDataJSON().kind === 'queue-build');
  await page.keyboard.press('Enter');
  await sent;
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  try {
    await frames();
    // As in the busy-button tests: a head mutation samples Chrome's later blur of the field the busy fieldset disabled.
    await page.evaluate(() => { document.head.append(document.createElement('script')); });
    await frames();
    expect(await focusDrops(page)).toEqual([]);
    await expect(field).toBeDisabled();
    await expect(panel).toBeFocused();
    await expect(button).toHaveAttribute('aria-disabled', 'true');
  } finally { release(); }
  const outcome = panel.getByRole('status').filter({ hasText: 'Build queued.' });
  await expect(outcome).toBeFocused();
  await expect(field).toBeEnabled();
  expect(flow.commands.map(command => command.kind)).toEqual(['queue-build']);
  expect(await focusDrops(page)).toEqual([]);
});

test('explains an invalid build change in words and reloads the latest inventory', async ({ page, context }) => {
  const flow = await inventoryFlow(context, { gear: true });
  const { sword2 } = flow.pieces;
  await page.goto('/game/');
  await openMenu(page, 'My gladiator');
  const weapon = page.locator('[data-equipment-slot="weapon"]');
  const option = page.locator(`[data-equipment-option="${sword2.id}"]`);
  await weapon.click();
  await expect(option).toBeEnabled();
  await option.click();
  await page.getByRole('button', { name: 'Use Sword', exact: true }).click();
  // Another session lists the selected piece after this build draft was opened.
  sword2.reservation = { kind: 'listing', referenceId: randomUUID() };
  flow.reject('invalid');
  await page.getByRole('button', { name: 'Queue build', exact: true }).click();
  await expect(page.locator('.planning-form').getByRole('alert')).toHaveText('That build change is no longer possible. Your build has been reloaded.');
  await weapon.click();
  await expect(option).toBeDisabled();
  expect(flow.commands).toHaveLength(1);
  expect(flow.state.pendingBuild).toBeNull();
});

test('retries a gear change with the same operation after a refusal, and reloads on a conflict', async ({ page, context }) => {
  const flow = await inventoryFlow(context, { gear: true });
  const { sword2 } = flow.pieces;
  await page.goto('/game/');
  await openMenu(page, 'Inventory and shops');
  flow.reject('processing');
  await wearItem(page, sword2);
  await expect(card(page, sword2).getByRole('alert')).toHaveText('The world is processing previous results. Retry shortly.');
  await expect(badge(page, sword2)).toHaveCount(0);
  flow.reject('');
  await card(page, sword2).getByRole('button', { name: 'Retry request' }).click();
  await expect(badge(page, sword2)).toBeVisible();
  expect(flow.commands).toHaveLength(2);
  expect(flow.commands[1]).toEqual(flow.commands[0]);
  // Another session cancels the pending build: the next command is stale, says so, and the latest build is loaded.
  flow.state.pendingBuild = null; flow.state.buildVersion++;
  flow.reject('conflict');
  await undo(page, sword2).click();
  await expect(card(page, sword2).getByRole('alert')).toHaveText('Your build changed. The latest state has been loaded; review and try again.');
  await expect(card(page, sword2).getByRole('button', { name: 'Retry request' })).toHaveCount(0);
  await expect(badge(page, sword2)).toHaveCount(0);
  await expect(wear(page, sword2)).toBeEnabled();
  flow.reject('');
  await wear(page, sword2).click();
  expect(flow.commands.at(-1)).toMatchObject({ kind: 'queue-build', expectedVersion: 3 });
  expect(flow.commands.at(-1)?.operationId).not.toBe(flow.commands[1].operationId);
  await expect(badge(page, sword2)).toBeVisible();
});

test('keeps the keyboard focus on the page through Wear, Undo and Cancel changes', async ({ page, context }) => {
  await watchFocus(page);
  const flow = await inventoryFlow(context, { gear: true });
  const { sword, sword2, helmet } = flow.pieces;
  await page.goto('/game/');
  await openMenu(page, 'Inventory and shops');
  const reach = async (button: Locator) => { await button.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await expect(button).toBeFocused(); };
  const inspect = async (piece: ItemInstance) => {
    await tile(page, piece).focus();
    await page.keyboard.press('Enter');
    await expect(tile(page, piece)).toHaveAttribute('aria-pressed', 'true');
  };
  // Wear by keyboard: the button the player pressed becomes Undo and keeps the focus; the result is announced in its card.
  await inspect(sword2);
  await reach(wear(page, sword2));
  await page.keyboard.press('Enter');
  await expect(card(page, sword2).getByRole('status')).toHaveText('Sword will be worn from the next slot.');
  await expect(undo(page, sword2)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card(page, sword2).getByRole('status')).toHaveText('Swap undone. Sword stays worn.');
  await expect(wear(page, sword2)).toBeFocused();
  // Wearing the piece that is going off again disables its button: the focus goes to the outcome, never to <body>.
  await page.keyboard.press('Enter');
  await expect(undo(page, sword2)).toBeFocused();
  await inspect(sword);
  await reach(wear(page, sword));
  await page.keyboard.press('Enter');
  await expect(card(page, sword).getByRole('status')).toHaveText('Back to your current gear. No gear change is queued.');
  await expect(card(page, sword).getByRole('status')).toBeFocused();
  // Cancel changes leaves with its section: the outcome takes the focus.
  await inspect(helmet);
  await reach(wear(page, helmet));
  await page.keyboard.press('Enter');
  await expect(undo(page, helmet)).toBeFocused();
  await reach(cancelChanges(page));
  await page.keyboard.press('Enter');
  await expect(wearingNow(page).getByRole('status')).toHaveText('Gear changes canceled.');
  await expect(wearingNow(page).getByRole('status')).toBeFocused();
  expect(await focusedElement(page)).not.toBe('body');
  expect(await focusDrops(page)).toEqual([]);
});

test('previews the gear read-only: Wear is disabled and says why', async ({ page }) => {
  await page.goto('/game/?mode=fixture');
  await openMenu(page, 'Inventory and shops');
  await expect(wearingNow(page)).toBeVisible();
  await expect(wearingNow(page).getByRole('listitem')).toHaveCount(5);
  await expect(wearingNow(page).getByText('Gear changes are unavailable in this preview.')).toBeVisible();
  await page.getByTestId('inventory-grid').getByRole('button', { name: /^Iron helmet/ }).click();
  const helmet = page.getByRole('region', { name: 'Item details' });
  await expect(helmet.getByRole('button', { name: /^Wear / })).toBeDisabled();
  await expect(helmet.getByRole('button', { name: /^Wear / })).toHaveAccessibleDescription(/Gear changes are unavailable in this preview\./);
});

// ---- Search and sort in the Inventory and the Shops (Patch 1.9, the approved search mockup) ---------------------------------

// Each panel's search landmark, field and Sort have names of their own (final review Minor 4): the Shops' by default, the Inventory's by name.
const ITEM_SEARCH = 'Search your items', ITEM_SORT = 'Sort your items';
const searchField = (scope: Locator, name = 'Search the shops') => scope.getByRole('searchbox', { name, exact: true });
const sortSelect = (scope: Locator, name = 'Sort the shops') => scope.getByRole('combobox', { name, exact: true });
/** The live lines that speak of matches: the count under the grid only (the no-match box in the grid is not announced again). */
const matchStatus = (scope: Locator) => scope.getByRole('status').filter({ hasText: /match/ });
const matchLine = (scope: Locator, text: RegExp | string) => scope.getByText(text);
const shopIds = (shops: Locator) => shops.locator('[data-testid^="offer-"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')!.slice('offer-'.length)));
const tileIds = (inv: Locator) => inv.getByTestId('inventory-grid').locator('[data-testid^="tile-"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')!.slice('tile-'.length)));
const entryName = (catalogId: string) => CATALOG_V1.items[catalogId].name;
const BANNER_ID = CATALOG_V1.cosmetics.banner.id;

test('searches the shop by part of a name, with the filters and the currency, and says how many match', async ({ page, context }, info) => {
  const mobile = info.project.name === 'mobile';
  const flow = await inventoryFlow(context);
  flow.state.progression.level = 5;
  flow.state.wallets = { money: 300, renown: 100 };
  if (mobile) await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const shops = shopsRegion(menu), details = offerDetails(shops), field = searchField(shops);
  await expect(menu.getByRole('search', { name: 'Search the shops', exact: true })).toHaveCount(1);
  await expect(menu.getByRole('search', { name: ITEM_SEARCH, exact: true })).toHaveCount(1);
  await expect(menu.getByRole('combobox', { name: ITEM_SORT, exact: true })).toHaveCount(1);
  await expect(field).toBeVisible();
  await expect(field).toHaveValue('');
  await expect(shops.getByRole('button', { name: 'Clear search', exact: true })).toHaveCount(0);
  await expect(matchLine(shops, /items? match/)).toHaveCount(0);
  await chooseOffer(shops, 'axe:1:common', mobile);
  // Case does not matter, and the chosen axe no longer matches: the first match takes its place.
  await field.fill('SwOrD');
  await expect(shops.locator('[data-testid^="offer-"]')).toHaveCount(3);
  expect(await shopIds(shops)).toEqual(['sword:1:common', 'sword:5:common', 'sword:10:common']);
  await expect(matchLine(shops, '3 items match “SwOrD”')).toBeVisible();
  await expect(offerCell(shops, 'sword:1:common')).toHaveAttribute('aria-pressed', 'true');
  await expect(details.getByRole('heading', { name: 'Sword' })).toBeVisible();
  await expect(details).toContainText('Level 1');
  // The chips and the currency still apply: no armor is a sword, and the box says the filter hides the matches (final review Minor 6),
  // announced once, by the count line.
  await shopButton(shops, 'Shop filters', 'Armor').click();
  await expect(shops.locator('[data-testid^="offer-"]')).toHaveCount(0);
  await expect(shops.getByText('No match for “SwOrD” in Armor')).toBeVisible();
  await expect(matchStatus(shops)).toHaveText(['0 items match “SwOrD” in Armor']);
  await shopButton(shops, 'Shop filters', 'All').click();
  await shopButton(shops, 'Shop currency', 'Renown').click();
  expect(await shopIds(shops)).toEqual(['sword:1:renown', 'sword:5:renown', 'sword:10:renown']);
  await field.fill(' heavy ');
  await expect(matchLine(shops, '6 items match “heavy”')).toBeVisible();
  await field.fill('banner');
  expect(await shopIds(shops)).toEqual([BANNER_ID]);
  await expect(matchLine(shops, '1 item match “banner”')).toBeVisible();
});

test('clears the shop search with the x button, Escape or Clear search, and a search with no match says so', async ({ page, context }, info) => {
  await inventoryFlow(context);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const shops = shopsRegion(menu), field = searchField(shops);
  await field.fill('dagger');
  await expect(shops.getByText('No items match “dagger”')).toBeVisible();
  await expect(matchStatus(shops)).toHaveText(['0 items match “dagger”']);
  await expect(shops.locator('[data-testid^="offer-"]')).toHaveCount(0);
  await expect(offerDetails(shops)).toContainText('Clear the search');
  await shops.getByRole('button', { name: 'Clear search', exact: true }).last().click();
  await expect(field).toHaveValue('');
  await expect(shops.locator('[data-testid^="offer-"]')).toHaveCount(33);
  await field.fill('axe');
  await shops.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();
  await expect(shops.locator('[data-testid^="offer-"]')).toHaveCount(33);
  await field.fill('bow');
  await field.press('Escape');
  await expect(field).toHaveValue('');
  await expect(shops.locator('[data-testid^="offer-"]')).toHaveCount(33);
  // Escape in an empty field leaves the menu to close as it always did.
  await expect(menu).toBeVisible();
  await field.press('Escape');
  await expect(menu).toBeHidden();
});

test('sorts the shop: Level, Price and Name ascend, Damage, Armor and Weight descend, ties keep the level order', async ({ page, context }, info) => {
  await inventoryFlow(context);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const shops = shopsRegion(menu), sort = sortSelect(shops);
  await expect(sort.locator('option')).toHaveText(['Level', 'Price', 'Name', 'Damage', 'Armor', 'Weight']);
  await expect(sort).toHaveValue('level');
  await expect(sort).not.toHaveAttribute('data-changed', /.*/);
  const baseline = await shopIds(shops);
  const priceOf = (id: string) => shopOffers(CATALOG_V1).find(offer => offer.catalogId === id)!.unitPrice;
  await sort.selectOption('price');
  await expect(sort).toHaveAttribute('data-changed', '');
  let ids = await shopIds(shops);
  expect(ids).toHaveLength(33);
  for (let i = 1; i < ids.length; i++) {
    expect(priceOf(ids[i]), `price ${ids[i - 1]} then ${ids[i]}`).toBeGreaterThanOrEqual(priceOf(ids[i - 1]));
    if (priceOf(ids[i]) === priceOf(ids[i - 1])) expect(baseline.indexOf(ids[i])).toBeGreaterThan(baseline.indexOf(ids[i - 1]));
  }
  await sort.selectOption('name');
  ids = await shopIds(shops);
  const names = ids.map(entryName);
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
  for (const stat of ['damage', 'armor', 'weight'] as const) {
    await sort.selectOption(stat);
    ids = await shopIds(shops);
    for (let i = 1; i < ids.length; i++) {
      const [before, after] = [CATALOG_V1.items[ids[i - 1]].stats[stat], CATALOG_V1.items[ids[i]].stats[stat]];
      expect(after, `${stat} ${ids[i - 1]} then ${ids[i]}`).toBeLessThanOrEqual(before);
      if (after === before) expect(baseline.indexOf(ids[i])).toBeGreaterThan(baseline.indexOf(ids[i - 1]));
    }
  }
  await sort.selectOption('level');
  expect(await shopIds(shops)).toEqual(baseline);
  await expect(sort).not.toHaveAttribute('data-changed', /.*/);
  // The Arena banner has no stats: it comes after every piece of equipment under a stat sort, and sorts by its renown price under Price.
  await shopButton(shops, 'Shop currency', 'Renown').click();
  await sort.selectOption('damage');
  ids = await shopIds(shops);
  expect(ids.at(-1)).toBe(BANNER_ID);
  await sort.selectOption('price');
  ids = await shopIds(shops);
  const prices = (await shops.locator('[data-shop-price]').allTextContents()).map(Number);
  const banner = ids.indexOf(BANNER_ID);
  expect(banner).toBeGreaterThan(0);
  expect(prices[banner]).toBe(CATALOG_V1.cosmetics.banner.renownPrice);
  expect(prices[banner]).toBeGreaterThanOrEqual(prices[banner - 1]);
  expect(prices[banner]).toBeLessThanOrEqual(prices[banner + 1] ?? Infinity);
});

test('keeps the shop card, the chosen cell and Buy on the same offer as search and sort change the grid', async ({ page, context }, info) => {
  const mobile = info.project.name === 'mobile';
  const flow = await inventoryFlow(context);
  flow.state.progression.level = 10;
  flow.state.wallets = { money: 1000, renown: 100 };
  if (mobile) await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const shops = shopsRegion(menu), details = offerDetails(shops);
  await searchField(shops).fill('sword');
  await sortSelect(shops).selectOption('damage');
  // Highest damage first; the chosen level 1 sword is still a match, so it stays chosen and its card stays.
  expect(await shopIds(shops)).toEqual(['sword:10:common', 'sword:5:common', 'sword:1:common']);
  await expect(offerCell(shops, 'sword:1:common')).toHaveAttribute('aria-pressed', 'true');
  await expect(details).toContainText('Level 1');
  await chooseOffer(shops, 'sword:10:common', mobile);
  await expect(details).toContainText('Level 10');
  await expect(details.getByRole('button', { name: /^Buy Sword/ })).toBeVisible();
  await chooseOffer(shops, 'sword:5:common', mobile);
  await sortSelect(shops).selectOption('price');
  await expect(offerCell(shops, 'sword:5:common')).toHaveAttribute('aria-pressed', 'true');
  await expect(details).toContainText('Level 5');
  await expect(shops.locator('[data-testid^="offer-"][aria-pressed="true"]')).toHaveCount(1);
  await searchField(shops).fill('');
  await expect(offerCell(shops, 'sword:5:common')).toHaveAttribute('aria-pressed', 'true');
  await expect(details).toContainText('Level 5');
});

test('the chosen shop cell stays inside the grid after a search or a sort change', async ({ page, context }, info) => {
  await inventoryFlow(context);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const shops = shopsRegion(menu), scroll = shops.getByRole('group', { name: 'Shop items', exact: true });
  const inside = async (testId: string) => {
    const box = (await scroll.boundingBox())!, cell = (await shops.getByTestId(testId).boundingBox())!;
    return cell.y >= box.y - 1 && cell.y + cell.height <= box.y + box.height + 1;
  };
  await sortSelect(shops).selectOption('price');
  await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await searchField(shops).fill('shield');
  const first = (await shopIds(shops))[0];
  await expect.poll(() => inside(`offer-${first}`)).toBe(true);
  await searchField(shops).fill('');
  await sortSelect(shops).selectOption('name');
  const [chosen] = await shops.locator('[data-testid^="offer-"][aria-pressed="true"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')!));
  await expect.poll(() => inside(chosen)).toBe(true);
});

test('lays the search field above the chips with Sort beside it, on one row at 360 px', async ({ page, context }, info) => {
  await inventoryFlow(context);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  // The phone sheet rises for 0.2 s: read the boxes once it has settled.
  await menu.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
  const shops = shopsRegion(menu), field = searchField(shops), sort = sortSelect(shops);
  const chips = shops.getByRole('group', { name: 'Shop filters', exact: true });
  const [f, s, c, g] = await Promise.all([field.boundingBox(), sort.boundingBox(), chips.boundingBox(), shops.getByRole('group', { name: 'Shop items', exact: true }).boundingBox()]);
  expect(Math.abs((f!.y + f!.height / 2) - (s!.y + s!.height / 2))).toBeLessThan(8);
  expect(s!.x).toBeGreaterThan(f!.x + f!.width - 1);
  expect(f!.y + f!.height).toBeLessThanOrEqual(c!.y + 1);
  expect(c!.y).toBeLessThan(g!.y);
  expect(f!.width).toBeGreaterThan(120);
  if (info.project.name === 'mobile') {
    // 16 px on a phone, as the search field is, so iOS does not zoom in on focus (final review Minor 5).
    for (const control of [field, sort]) expect(await control.evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
  }
  await field.fill('sword');
  await sort.selectOption('price');
  await shops.screenshot({ path: info.outputPath(`shop-search-${info.project.name}.png`) });
});

const demoBag = async (page: Page) => {
  await page.goto('/game/?mode=fixture&bag=demo');
  return openMenu(page, 'Inventory and shops');
};
const inventoryRegion = (menu: Locator) => menu.locator('.inventory-panel');

test('searches and sorts the inventory; a chosen piece that stops matching gives way to the first match', async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  const menu = await demoBag(page);
  const inv = inventoryRegion(menu), field = searchField(inv, ITEM_SEARCH), sort = sortSelect(inv, ITEM_SORT);
  await expect(page.getByText('19 / 60 slots')).toBeVisible();
  await expect(sort.locator('option')).toHaveText(['Newest', 'Level', 'Name', 'Damage', 'Armor', 'Weight', 'Sell value']);
  await expect(sort).toHaveValue('newest');
  await expect(matchLine(inv, /items? match/)).toHaveCount(0);
  const all = await tileIds(inv);
  expect(all).toHaveLength(14);
  const name = (id: string) => inv.getByTestId(`tile-${id}`).getAttribute('aria-label').then(label => label!.split(',')[0]);
  // Choose a sword, then search for boots: the chosen sword stops matching and the first boots take its place.
  const sword = (await Promise.all(all.map(async id => [id, await name(id)] as const))).find(([, n]) => n === 'Sword')![0];
  await inv.getByTestId(`tile-${sword}`).click();
  await expect(inv.getByTestId(`item-${sword}`)).toBeVisible();
  await field.fill('BOOTS');
  const boots = await tileIds(inv);
  expect(boots).toHaveLength(2);
  await expect(matchLine(inv, '4 items match “BOOTS”')).toBeVisible();
  await expect(inv.getByTestId(`tile-${boots[0]}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(inv.getByTestId(`item-${boots[0]}`)).toBeVisible();
  await expect(inv.locator('[data-testid^="item-"]')).toHaveCount(1);
  // Sorted by Weight (heaviest first): Heavy boots lead; the chosen boots still match, so they stay chosen with their card.
  await sort.selectOption('weight');
  await expect(sort).toHaveAttribute('data-changed', '');
  const byWeight = await tileIds(inv);
  expect(await name(byWeight[0])).toBe('Heavy boots');
  await expect(inv.getByTestId(`tile-${boots[0]}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(inv.getByTestId(`item-${boots[0]}`)).toBeVisible();
  // No match: the status and a Clear search button, and the card says so.
  await field.fill('dagger');
  await expect(inv.getByText('No items match “dagger”')).toBeVisible();
  await expect(inv.getByTestId('inventory-grid').locator('[data-testid^="tile-"]')).toHaveCount(0);
  await expect(matchStatus(inv)).toHaveText(['0 items match “dagger”']);
  await inv.getByRole('button', { name: 'Clear search', exact: true }).last().click();
  await expect(field).toHaveValue('');
  expect(await tileIds(inv)).toHaveLength(14);
  // Swords are in the bag, but not under Armor: the box says so.
  await inv.getByRole('group', { name: 'Inventory filters', exact: true }).getByRole('button', { name: 'Armor', exact: true }).click();
  await field.fill('sword');
  await expect(inv.getByText('No match for “sword” in Armor')).toBeVisible();
  await expect(matchStatus(inv)).toHaveText(['0 items match “sword” in Armor']);
  await inv.getByRole('group', { name: 'Inventory filters', exact: true }).getByRole('button', { name: 'All', exact: true }).click();
  await field.fill('');
  await field.fill('x');
  await field.press('Escape');
  await expect(field).toHaveValue('');
  await expect(menu).toBeVisible();
  await sort.selectOption('newest');
  expect(await tileIds(inv)).toEqual(all);
});

test('sorts the inventory by level, name, damage, armor, weight and sell value, ties in the newest order', async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  const menu = await demoBag(page);
  const inv = inventoryRegion(menu), sort = sortSelect(inv, ITEM_SORT);
  const newest = await tileIds(inv);
  type Entry = (typeof CATALOG_V1.items)[string] & { bound: boolean };
  const catalogOf = async (id: string): Promise<Entry | undefined> => {
    const label = (await inv.getByTestId(`tile-${id}`).getAttribute('aria-label'))!;
    const match = /^(.+?), level (\d+) (\w+)/.exec(label)!;
    const found = Object.values(CATALOG_V1.items).find(entry => entry.name === match[1] && entry.tier === Number(match[2]) && entry.rarity === match[3]);
    return found && { ...found, bound: label.includes('Account-bound') };
  };
  const read = async (key: string, value: (entry: Entry) => number | string, direction: 1 | -1) => {
    await sort.selectOption(key);
    const ids = await tileIds(inv), entries = (await Promise.all(ids.map(catalogOf))) as Entry[];
    for (let i = 1; i < ids.length; i++) {
      const [a, b] = [value(entries[i - 1]), value(entries[i])];
      const order = typeof a === 'string' ? a.localeCompare(String(b), 'en') : (a as number) - (b as number);
      expect(order * direction, `${key}: ${ids[i - 1]} then ${ids[i]}`).toBeLessThanOrEqual(0);
      if (order === 0) expect(newest.indexOf(ids[i])).toBeGreaterThan(newest.indexOf(ids[i - 1]));
    }
  };
  await read('level', entry => entry.tier, 1);
  await read('name', entry => entry.name, 1);
  await read('damage', entry => entry.stats.damage, -1);
  await read('armor', entry => entry.stats.armor, -1);
  await read('weight', entry => entry.stats.weight, -1);
  await read('sell', entry => entry.bound ? 0 : entry.npcSellValue ?? 0, -1);
});

test('keeps the inventory card on the same one of several same-name pieces as search and sort change the grid', async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  const menu = await demoBag(page);
  const inv = inventoryRegion(menu);
  await searchField(inv, ITEM_SEARCH).fill('sword');
  // The two identical level 1 swords are one tile; the uncommon and the level 5 sword each have their own.
  const swords = await tileIds(inv);
  expect(swords).toHaveLength(3);
  await expect(inv.getByTestId(`tile-${swords[0]}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(inv.getByTestId(`item-${swords[0]}`)).toContainText('Level 1 · common');
  await expect(inv.getByTestId(`item-${swords[0]}`)).toContainText('2 owned');
  await inv.getByTestId(`tile-${swords[2]}`).click();
  await expect(inv.getByTestId(`item-${swords[2]}`)).toContainText('Level 5 · common');
  await sortSelect(inv, ITEM_SORT).selectOption('name');
  await expect(inv.getByTestId(`tile-${swords[2]}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(inv.getByTestId(`item-${swords[2]}`)).toContainText('Level 5 · common');
  await expect(inv.locator('[data-testid^="item-"]')).toHaveCount(1);
});

test('lays the inventory search field above its chips, with Sort beside it', async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  const menu = await demoBag(page);
  const inv = inventoryRegion(menu), field = searchField(inv, ITEM_SEARCH), sort = sortSelect(inv, ITEM_SORT);
  const [f, s, c] = await Promise.all([field.boundingBox(), sort.boundingBox(), inv.getByRole('group', { name: 'Inventory filters', exact: true }).boundingBox()]);
  expect(Math.abs((f!.y + f!.height / 2) - (s!.y + s!.height / 2))).toBeLessThan(8);
  expect(f!.y + f!.height).toBeLessThanOrEqual(c!.y + 1);
  await field.fill('sword');
  await inv.screenshot({ path: info.outputPath(`inventory-search-${info.project.name}.png`) });
});

// ---- Stacked duplicates and a Sell quantity (Patch 1.9, the approved stacks mockup) ---------------------------------------

const BOOTS = 'light-boots:1:common';
const bootsValue = CATALOG_V1.items[BOOTS].npcSellValue!;
const gridTile = (inv: Locator, name: RegExp | string) => inv.getByTestId('inventory-grid').getByRole('button', { name });
/** Waits for the phone sheet's rise (0.2 s) so boxes and screenshots read the settled layout. */
const settled = async (locator: Locator) => { await locator.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished))); return locator; };
const details = (inv: Locator) => inv.getByRole('region', { name: 'Item details', exact: true });
const sellButton = (inv: Locator) => details(inv).getByRole('button', { name: /^Sell(ing)? / });
const quantityField = (inv: Locator) => details(inv).getByRole('spinbutton', { name: /^Quantity of / });
const bootsPieces = (count: number) => Array.from({ length: count }, () => ({ ...itemFixture(CATALOG_V1.items[BOOTS]), id: randomUUID() }));
/** The grid's tiles as "Name, level N rarity", in order. */
const tileNames = (inv: Locator) => inv.getByTestId('inventory-grid').locator('[data-testid^="tile-"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')!.split(',').slice(0, 2).join(',')));

test('shows identical pieces as one tile with a layered edge and a count, every tile with its level, and the card says what is owned', async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  const menu = await demoBag(page);
  const inv = inventoryRegion(menu);
  await settled(menu);
  await expect(page.getByText('19 / 60 slots')).toBeVisible();
  // 19 pieces: 3 Light boots, 2 Swords, 2 Round shields and 2 Light armor are one tile each.
  const tiles = inv.getByTestId('inventory-grid').locator('[data-testid^="tile-"]');
  await expect(tiles).toHaveCount(14);
  await expect(inv.getByText('14 tiles · 19 items · each item still uses a slot', { exact: true })).toBeVisible();
  const boots = gridTile(inv, /^Light boots/);
  await expect(boots).toHaveCount(1);
  await expect(boots).toHaveAttribute('data-stack', '3');
  await expect(boots).toContainText('×3');
  await expect(boots).toHaveAccessibleName(/^Light boots, level 1 common, Tradable, 3 owned/);
  await expect(boots).toHaveCSS('box-shadow', /rgb\(74, 64, 54\) 3px 3px 0px -0\.5px/);
  await expect(gridTile(inv, /^Sword, level 1 common/)).toContainText('×2');
  await expect(gridTile(inv, /^Round shield/)).toContainText('×2');
  await expect(gridTile(inv, /^Light armor/)).toContainText('×2');
  // Pieces of another level or rarity never stack; a single piece has no count and no layered edge.
  await expect(gridTile(inv, /^Sword, level 1 uncommon/)).not.toContainText('×');
  await expect(gridTile(inv, /^Sword, level 5 common/)).not.toContainText('×');
  await expect(gridTile(inv, /^Heavy boots/)).not.toHaveAttribute('data-stack', /.*/);
  // Every tile names its level; the old copy numbers are gone.
  for (const tile of await tiles.all()) await expect(tile.getByText(/^L\d+$/)).toHaveCount(1);
  await expect(inv.getByText(/^#\d$/)).toHaveCount(0);
  await expect(gridTile(inv, /^Sword, level 5 common/).getByText('L5', { exact: true })).toBeVisible();
  // The card of the stack: its count, one-at-a-time Wear and Discard, and the Sell box with its quantity.
  await boots.click();
  const card = details(inv);
  await expect(card).toContainText('3 owned');
  await expect(card).not.toContainText('Item 1');
  await expect(card).toContainText('Wear and Discard use one item at a time.');
  await expect(card.getByText('Sell to the NPC', { exact: true })).toBeVisible();
  await expect(card.getByText('of 3', { exact: true })).toBeVisible();
  await expect(quantityField(inv)).toHaveValue('1');
  await expect(sellButton(inv)).toHaveText(`Sell Light boots · ${bootsValue} gold`);
  await quantityField(inv).fill('2');
  await expect(sellButton(inv)).toHaveText(`Sell 2 × Light boots · ${bootsValue * 2} gold`);
  const [field, max] = await Promise.all([quantityField(inv).boundingBox(), card.getByRole('button', { name: 'Max', exact: true }).boundingBox()]);
  expect(Math.abs((field!.y + field!.height / 2) - (max!.y + max!.height / 2))).toBeLessThan(8);
  await card.getByRole('button', { name: 'Max', exact: true }).click();
  await expect(quantityField(inv)).toHaveValue('3');
  await expect(sellButton(inv)).toHaveText(`Sell 3 × Light boots · ${bootsValue * 3} gold`);
  await quantityField(inv).fill('4');
  await expect(sellButton(inv)).toBeDisabled();
  await expect(card.getByText('Enter a quantity from 1 to 3', { exact: true })).toBeVisible();
  await quantityField(inv).fill('3');
  await settled(menu);
  await inv.screenshot({ path: info.outputPath(`stacks-${info.project.name}.png`) });
});

test('stacks work with search and every sort: a stack sorts by its pieces\' shared values and keeps its place', async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  const menu = await demoBag(page);
  const inv = inventoryRegion(menu), sort = sortSelect(inv, ITEM_SORT);
  // The count line is one live region that stays mounted: the first search count is announced there.
  const count = inv.locator('p[role="status"]').filter({ hasText: 'each item still uses a slot' });
  await count.evaluate(node => node.setAttribute('data-kept', ''));
  await searchField(inv, ITEM_SEARCH).fill('sword');
  await expect(inv.locator('p[role="status"][data-kept]')).toHaveText('4 items match “sword”');
  await expect(inv.getByTestId('inventory-grid').locator('[data-testid^="tile-"]')).toHaveCount(3);
  await expect(matchLine(inv, '4 items match “sword”')).toBeVisible();
  const common1 = 'Sword, level 1 common', uncommon1 = 'Sword, level 1 uncommon', common5 = 'Sword, level 5 common';
  expect(await tileNames(inv)).toEqual([common1, uncommon1, common5]);
  await sort.selectOption('level');
  expect(await tileNames(inv)).toEqual([common1, uncommon1, common5]);
  await sort.selectOption('damage');
  expect(await tileNames(inv)).toEqual([common5, uncommon1, common1]);
  await sort.selectOption('sell');
  expect(await tileNames(inv)).toEqual([common5, uncommon1, common1]);
  await searchField(inv, ITEM_SEARCH).fill('');
  await sort.selectOption('weight');
  expect((await tileNames(inv))[0]).toBe('Heavy armor, level 5 common');
  expect(await tileNames(inv)).toHaveLength(14);
  // "Newest" keeps the bag's order: a stack sits where its first piece does.
  await sort.selectOption('newest');
  expect((await tileNames(inv))[0]).toBe('Iron helmet, level 5 uncommon');
});

test('one tile per worn, queued and listed copy, each with its tag; Sell says why it is unavailable; Wear takes one piece', async ({ page, context }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  const flow = await inventoryFlow(context, { gear: true });
  const [free1, free2, free3, listed] = bootsPieces(4);
  listed.reservation = { kind: 'listing', referenceId: randomUUID() };
  flow.state.inventory.push(free1, free2, free3, listed);
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const inv = inventoryRegion(menu);
  await settled(menu);
  await expect(tile(inv, free1)).toContainText('×3');
  await expect(tile(inv, listed)).not.toContainText('×');
  await expect(tile(inv, listed)).toContainText('Listed');
  await expect(tile(inv, listed)).toHaveAccessibleName(/Listed for sale/);
  await expect(tile(inv, flow.pieces.sword)).toContainText('Worn');
  await selectItem(inv, listed);
  await expect(sellButton(inv)).toBeDisabled();
  await expect(details(inv)).toContainText('Listed for sale');
  await selectItem(inv, flow.pieces.sword);
  await expect(sellButton(inv)).toBeDisabled();
  await expect(details(inv)).toContainText('Worn: change it first to sell it');
  // Wear takes one piece of the stack: it leaves with a Next tile; Undo puts it back.
  await selectItem(inv, free1);
  const wearBoots = details(inv).getByRole('button', { name: /^Wear Light boots/ });
  await expect(wearBoots).toHaveAccessibleName('Wear Light boots, level 1 common (one of 3)');
  await wearBoots.click();
  await expect(details(inv).getByRole('status').first()).toHaveText('Light boots will be worn from the next slot. 2 left in the stack.');
  await expect(tile(inv, free1)).toContainText('Next');
  await expect(tile(inv, free1)).not.toContainText('×');
  await expect(tile(inv, free2)).toContainText('×2');
  await expect(tile(inv, free1)).toHaveAttribute('aria-pressed', 'true');
  await expect(details(inv)).toContainText('Reserved: pending-build');
  await expect(sellButton(inv)).toBeDisabled();
  expect(flow.commands.at(-1)).toMatchObject({ kind: 'queue-build', equipment: { feet: free1.id } });
  await details(inv).getByRole('button', { name: /^Undo wearing / }).click();
  await expect(tile(inv, free1)).toContainText('×3');
  await expect(tile(inv, free1)).toHaveAttribute('aria-pressed', 'true');
  await expect(details(inv)).toContainText('3 owned');
  await expect(details(inv).getByRole('status')).toHaveText('Swap undone. Light boots is back in the stack.');
  await expect(sellButton(inv)).toBeEnabled();
});

test('sells several pieces one at a time, shows the progress and the result, and the stack and gold follow each sale', async ({ page, context }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  const flow = await inventoryFlow(context);
  const boots = bootsPieces(3);
  flow.state.inventory = [...boots];
  flow.state.wallets = { money: 100, renown: 0 };
  let sells = 0;
  let release!: () => void;
  const second = new Promise<void>(resolve => { release = resolve; });
  await context.route('http://127.0.0.1:54321/functions/v1/game-command', async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON().kind !== 'sell-item') return route.fallback();
    if (++sells === 2) await second;
    return route.fallback();
  });
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const inv = inventoryRegion(menu);
  await settled(menu);
  await expect(tile(inv, boots[0])).toContainText('×3');
  await quantityField(inv).fill('2');
  await expect(sellButton(inv)).toHaveText(`Sell 2 × Light boots · ${bootsValue * 2} gold`);
  await sellButton(inv).click();
  // The first sale is done: the stack and the gold show it while the second is on its way.
  await expect(sellButton(inv)).toHaveText('Selling Light boots…');
  await expect(sellButton(inv)).toHaveAttribute('aria-disabled', 'true');
  await expect(details(inv).getByText('Selling Light boots: 1 of 2 sold', { exact: true })).toBeVisible();
  await expect(details(inv).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
  await expect(tile(inv, boots[0])).toContainText('×2');
  await expect(inv.getByText(`Available gold: ${100 + bootsValue}`, { exact: true })).toBeVisible();
  await settled(menu);
  await inv.screenshot({ path: info.outputPath(`stacks-progress-${info.project.name}.png`) });
  release();
  await expect(details(inv).getByRole('status').filter({ hasText: `Sold 2 × Light boots for ${bootsValue * 2} gold.` })).toBeVisible();
  expect(flow.commands.map(command => command.kind)).toEqual(['sell-item', 'sell-item']);
  // One sale per piece, taken from the end of the stack so the stack keeps its first piece and its card.
  expect(flow.commands).toMatchObject([{ itemId: boots[2].id, quantity: 1 }, { itemId: boots[1].id, quantity: 1 }]);
  expect(new Set(flow.commands.map(command => command.operationId)).size).toBe(2);
  await expect(tile(inv, boots[0])).not.toContainText('×');
  await expect(tile(inv, boots[0])).toHaveAttribute('aria-pressed', 'true');
  await expect(details(inv)).toContainText('1 owned');
  await expect(inv.getByText(`Available gold: ${100 + bootsValue * 2}`, { exact: true })).toBeVisible();
  await expect(details(inv).getByRole('progressbar')).toHaveCount(0);
  // A single piece sells with the plain button, and the last one leaves the grid.
  await expect(sellButton(inv)).toHaveText(`Sell Light boots · ${bootsValue} gold`);
  await expect(quantityField(inv)).toHaveCount(0);
  await sellButton(inv).click();
  await expect(details(inv).getByRole('status').filter({ hasText: `Sold Light boots for ${bootsValue} gold.` })).toBeVisible();
  await expect(tile(inv, boots[0])).toHaveCount(0);
});

test('stops at the first refused sale, reports the partial result as an alert and resets the quantity', async ({ page, context }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  const flow = await inventoryFlow(context);
  const boots = bootsPieces(3);
  flow.state.inventory = [...boots];
  flow.refuseSale(2, 'conflict');
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const inv = inventoryRegion(menu);
  await settled(menu);
  await quantityField(inv).fill('3');
  await sellButton(inv).click();
  const alert = details(inv).getByRole('alert');
  await expect(alert).toHaveText(`Sold 1 of 3 Light boots for ${bootsValue} gold. Sale 2 was refused: your inventory changed. Review the updated items and sell the rest again.`);
  // It stopped there: no third command, and the stack shows what is left, with the quantity back to 1.
  expect(flow.commands).toHaveLength(2);
  await expect(tile(inv, boots[0])).toContainText('×2');
  await expect(quantityField(inv)).toHaveValue('1');
  await expect(sellButton(inv)).toHaveText(`Sell Light boots · ${bootsValue} gold`);
  await expect(sellButton(inv)).toBeEnabled();
  await settled(menu);
  await inv.screenshot({ path: info.outputPath(`stacks-partial-${info.project.name}.png`) });
});

test('never sells a piece that became listed while the sale was running', async ({ page, context }) => {
  const flow = await inventoryFlow(context);
  const boots = bootsPieces(3);
  flow.state.inventory = [...boots];
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const inv = inventoryRegion(menu);
  await quantityField(inv).fill('3');
  // The second piece to sell is listed on the Marketplace while the first sale is on its way.
  await context.route('http://127.0.0.1:54321/functions/v1/game-command', async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON().kind !== 'sell-item') return route.fallback();
    boots[1].reservation = { kind: 'listing', referenceId: randomUUID() };
    return route.fallback();
  });
  await sellButton(inv).click();
  await expect(details(inv).getByRole('alert')).toContainText(`Sold 1 of 3 Light boots for ${bootsValue} gold. Sale 2 was refused: your inventory changed.`);
  expect(flow.commands).toHaveLength(1);
});

test('a single piece keeps the plain Sell button and the existing refusal and retry behaviour', async ({ page, context }) => {
  const flow = await inventoryFlow(context);
  flow.reject('processing');
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const inv = inventoryRegion(menu);
  const axe = flow.state.inventory[0], value = CATALOG_V1.items['axe:1:common'].npcSellValue;
  await selectItem(inv, axe);
  await expect(quantityField(inv)).toHaveCount(0);
  await expect(sellButton(inv)).toHaveText(`Sell Axe · ${value} gold`);
  await sellButton(inv).click();
  await expect(details(inv).getByRole('alert')).toContainText('processing');
  await details(inv).getByRole('button', { name: 'Retry request' }).click();
  await expect(details(inv).getByRole('alert')).toContainText('processing');
  flow.reject('');
  await details(inv).getByRole('button', { name: 'Retry request' }).click();
  await expect(details(inv).getByRole('status').filter({ hasText: `Sold Axe for ${value} gold.` })).toBeVisible();
  expect(new Set(flow.commands.map(command => command.operationId)).size).toBe(1);
});

test('keeps the keyboard on Sell through a multi-sale and gives the focus to its result', async ({ page, context }) => {
  await watchFocus(page);
  const flow = await inventoryFlow(context);
  const boots = bootsPieces(3);
  flow.state.inventory = [...boots];
  let sells = 0;
  let release!: () => void;
  const second = new Promise<void>(resolve => { release = resolve; });
  await context.route('http://127.0.0.1:54321/functions/v1/game-command', async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON().kind !== 'sell-item') return route.fallback();
    if (++sells === 2) await second;
    return route.fallback();
  });
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const inv = inventoryRegion(menu);
  await settled(menu);
  const max = details(inv).getByRole('button', { name: 'Max', exact: true });
  await max.focus();
  await page.keyboard.press('Enter');
  await expect(quantityField(inv)).toHaveValue('3');
  await page.keyboard.press('Tab');
  await expect(sellButton(inv)).toBeFocused();
  await page.keyboard.press('Enter');
  // The first sale is done and the stack has shrunk below the quantity asked for: Sell stays the focused, aria-disabled button.
  await expect(details(inv).getByRole('status').filter({ hasText: 'Selling Light boots: 1 of 3 sold' })).toBeVisible();
  await expect(tile(inv, boots[0])).toContainText('×2');
  await expect(sellButton(inv)).toBeFocused();
  await expect(sellButton(inv)).toHaveAttribute('aria-disabled', 'true');
  await expect(sellButton(inv)).not.toHaveAttribute('disabled');
  await expect(sellButton(inv)).toHaveText('Selling Light boots…');
  await expect(details(inv).getByText('Enter a quantity', { exact: false })).toHaveCount(0);
  release();
  const result = details(inv).getByRole('status').filter({ hasText: `Sold 3 × Light boots for ${bootsValue * 3} gold.` });
  await expect(result).toBeVisible();
  await expect(result).toBeFocused();
  expect(await focusDrops(page)).toEqual([]);
  expect(flow.commands).toHaveLength(3);
});

test('discards one piece of a stack, and the card and the sold or worn piece are the tile\'s own', async ({ page, context }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  const flow = await inventoryFlow(context);
  flow.state.progression.level = 5;
  const boots = bootsPieces(3);
  const [commonA, commonB] = ['sword:1:common', 'sword:1:common'].map(id => ({ ...itemFixture(CATALOG_V1.items[id]), id: randomUUID() }));
  const high = { ...itemFixture(CATALOG_V1.items['sword:5:common']), id: randomUUID() };
  flow.state.inventory = [...boots, commonA, high, commonB];
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const inv = inventoryRegion(menu);
  await settled(menu);
  await details(inv).getByRole('button', { name: 'Discard', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm discard' });
  await expect(dialog).toContainText('Discard 1 × Light boots?');
  await dialog.getByRole('button', { name: 'Confirm discard' }).click();
  expect(flow.commands).toMatchObject([{ kind: 'discard-item', itemId: boots[2].id, quantity: 1 }]);
  await expect(tile(inv, boots[0])).toContainText('×2');
  // The level 5 sword's card and its Sell act on that sword, not on a level 1 sword of the same name.
  await tile(inv, high).click();
  await expect(details(inv)).toContainText('Level 5 · common');
  await expect(sellButton(inv)).toHaveText(`Sell Sword · ${CATALOG_V1.items['sword:5:common'].npcSellValue} gold`);
  await sellButton(inv).click();
  await expect(details(inv).getByRole('status').filter({ hasText: /^Sold Sword for/ })).toBeVisible();
  expect(flow.commands.at(-1)).toMatchObject({ kind: 'sell-item', itemId: high.id, quantity: 1 });
  expect(flow.state.wallets.money).toBe(300 + CATALOG_V1.items['sword:5:common'].npcSellValue!);
  // Wear on the stack of two level 1 swords wears the piece the card shows (its first).
  await tile(inv, commonA).click();
  await details(inv).getByRole('button', { name: /^Wear Sword/ }).click();
  await expect(details(inv).getByRole('status')).toHaveText('Sword will be worn from the next slot. 1 left in the stack.');
  expect(flow.commands.at(-1)).toMatchObject({ kind: 'queue-build', equipment: { weapon: commonA.id } });
});

test('a transient refusal in the middle of a run stops it, and Sell again replays that piece with the same operation id', async ({ page, context }) => {
  const flow = await inventoryFlow(context);
  const boots = bootsPieces(3);
  flow.state.inventory = [...boots];
  flow.refuseSale(2, 'processing');
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const inv = inventoryRegion(menu);
  await quantityField(inv).fill('3');
  await sellButton(inv).click();
  await expect(details(inv).getByRole('alert')).toHaveText(`Sold 1 of 3 Light boots for ${bootsValue} gold. Sale 2 was refused: the world is processing previous results. Review the updated items and sell the rest again.`);
  flow.refuseSale(0, '');
  await expect(sellButton(inv)).toBeEnabled();
  await sellButton(inv).click();
  await expect(details(inv).getByRole('status').filter({ hasText: `Sold Light boots for ${bootsValue} gold.` })).toBeVisible();
  expect(flow.commands.map(command => command.kind)).toEqual(['sell-item', 'sell-item', 'sell-item']);
  expect(flow.commands[2].operationId).toBe(flow.commands[1].operationId);
  expect(flow.commands[2]).toMatchObject({ itemId: boots[1].id });
  expect(flow.state.wallets.money).toBe(300 + bootsValue * 2);
  await expect(tile(inv, boots[0])).not.toContainText('×');
});

test('a sale whose answer is lost is reported as unknown, not refused, and the bag is read again', async ({ page, context }) => {
  const flow = await inventoryFlow(context);
  const boots = bootsPieces(3);
  flow.state.inventory = [...boots];
  flow.loseNext();
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const inv = inventoryRegion(menu);
  await quantityField(inv).fill('3');
  await sellButton(inv).click();
  await expect(details(inv).getByRole('alert')).toHaveText('The result of sale 1 is unknown; check your gold. Review the updated items and sell the rest again.');
  expect(flow.commands).toHaveLength(1);
  expect(flow.state.inventory).toHaveLength(2);
  await expect(tile(inv, boots[0])).toContainText('×2');
});

test('describes Sell by the listing for a listed piece above the player\'s level', async ({ page, context }) => {
  const flow = await inventoryFlow(context);
  const listed = { ...itemFixture(CATALOG_V1.items['sword:5:common']), id: randomUUID(), reservation: { kind: 'listing' as const, referenceId: randomUUID() } };
  flow.state.inventory = [listed];
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const inv = inventoryRegion(menu);
  await expect(sellButton(inv)).toBeDisabled();
  await expect(sellButton(inv)).toHaveAccessibleDescription('Listed for sale');
  await expect(details(inv).getByRole('button', { name: /^Wear / })).toHaveAccessibleDescription('Needs level 5');
});

// ---- Review leftovers (Patch 1.9, Task 21: planned as 1.9.1, folded into 1.9) -----------------------------------------------

/** Where `target` is in the menu body's visible part (clipped to the window): its top in view, wholly in view, its top at the view's top. */
const placeIn = async (body: Locator, target: Locator) => target.evaluate((el, scroller) => {
  const box = el.getBoundingClientRect(), view = (scroller as HTMLElement).getBoundingClientRect();
  const top = Math.max(view.top, 0), bottom = Math.min(view.bottom, innerHeight);
  return { topIn: box.top >= top - 1 && box.top < bottom - 1, whole: box.top >= top - 1 && box.bottom <= bottom + 1, atTop: Math.abs(box.top - top) <= 2 };
}, await body.elementHandle());
/** Scrolls the menu body so `target`'s top sits just under the body's visible bottom, out of view (as far as the body scrolls). */
const hideBelow = async (body: Locator, target: Locator) => target.evaluate((el, scroller) => {
  const box = scroller as HTMLElement;
  box.scrollTop += el.getBoundingClientRect().top - Math.min(box.getBoundingClientRect().bottom, innerHeight) + 8;
}, await body.elementHandle());
/** Scrolls the menu body so `target`'s top is the body's visible top (as far as the body scrolls). */
const toTop = async (body: Locator, target: Locator) => target.evaluate((el, scroller) => {
  const box = scroller as HTMLElement;
  box.scrollTop += el.getBoundingClientRect().top - Math.max(box.getBoundingClientRect().top, 0);
}, await body.elementHandle());
/** The first of `cells` whose box lies wholly inside the window and the menu body's visible part. */
async function visibleCell(body: Locator, cells: Locator) {
  const view = (await body.boundingBox())!, height = await body.evaluate(() => innerHeight);
  for (const cell of await cells.all()) {
    const box = await cell.boundingBox();
    if (box && box.y >= Math.max(view.y, 0) && box.y + box.height <= Math.min(view.y + view.height, height)) return cell;
  }
  throw new Error('no cell in view');
}

test('on a phone a tapped tile or shop cell brings its card into view; a pointer leaves the menu where it is (Task 21 item 1)', async ({ page }, info) => {
  const mobile = info.project.name === 'mobile';
  const menu = await demoBag(page);
  await settled(menu);
  const body = menu.getByTestId('menu-body'), inv = inventoryRegion(menu), shops = shopsRegion(menu);
  const invGrid = inv.getByTestId('inventory-grid'), shopGrid = shops.getByRole('group', { name: 'Shop items', exact: true });
  for (const [name, grid, cells, card] of [
    ['inventory', invGrid, invGrid.locator('[data-testid^="tile-"]'), details(inv)],
    ['shops', shopGrid, shopGrid.locator('[data-shop-cell]'), offerDetails(shops)],
  ] as const) {
    // A phone shows the card under its grid: as far out of view below as the menu scrolls (at rest the Inventory's card shows only
    // its first lines). A pointer window shows it beside the grid, from the grid's top row up: the grid goes to the menu's top.
    if (mobile) await hideBelow(body, card); else await toTop(body, grid);
    const before = await placeIn(body, card);
    if (mobile || name === 'inventory') expect(before.whole, `${name}: the card starts partly or wholly out of view`).toBe(false);
    if (!mobile && name === 'inventory') expect(before.topIn, 'its top out of view').toBe(false);
    const scrolled = await body.evaluate(el => el.scrollTop);
    const cell = await visibleCell(body, cells);
    if (mobile) await cell.tap(); else await cell.click();
    await expect(cell).toHaveAttribute('aria-pressed', 'true');
    if (mobile) {
      // The card comes into view: whole, or (taller than the view) from its top.
      await expect.poll(async () => { const now = await placeIn(body, card); return now.topIn && (now.whole || now.atTop); }, `${name}: the tapped card is in view`).toBe(true);
    } else {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await body.evaluate(el => el.scrollTop), `${name}: a pointer click moves nothing`).toBe(scrolled);
    }
    // The page itself never scrolls.
    expect(await page.evaluate(() => [scrollX, scrollY])).toEqual([0, 0]);
  }
});

test('a definite refusal whose owner refresh fails leaves a working Retry: the same operation again, then the refusal once the bag loads (Task 21 item 2)', async ({ page, context }) => {
  // HANDOFF (pre-existing): a definitive refusal followed by a failed owner refresh.
  const flow = await inventoryFlow(context);
  await page.goto('/game/');
  const menu = await openMenu(page, 'Inventory and shops');
  const inv = inventoryRegion(menu);
  const axe = flow.state.inventory[0];
  await selectItem(inv, axe);
  flow.reject('conflict');
  flow.failOwnerReads(true);
  await sellButton(inv).click();
  const alert = details(inv).getByRole('alert'), retry = details(inv).getByRole('button', { name: 'Retry request' });
  await expect(alert).toBeVisible();
  // The refusal is said, then (once the owner read has given up, after its own retries) that the bag could not be read again: not
  // "could not be confirmed", since the server did answer. Observed before the fix: that sentence, and a Retry that sent nothing.
  await expect.soft(alert).toContainText('Your inventory changed');
  await expect.soft(alert).toContainText('could not be loaded', { timeout: 20_000 });
  await expect(retry).toBeVisible({ timeout: 20_000 });
  flow.failOwnerReads(false);
  await retry.click();
  await expect.poll(() => flow.commands.length, 'Retry sends the command again').toBe(2);
  expect(flow.commands[1]).toEqual(flow.commands[0]);
  // The server refuses it again and the bag now loads: the refusal stands, with nothing more to retry.
  await expect(alert).toHaveText('Your inventory changed or this cosmetic is already owned. Review the refreshed state.');
  await expect(retry).toHaveCount(0);
});

test('clearing a search with no match brings back the chosen piece in the Inventory, as it does in the Shops (Task 21 item 3)', async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  const menu = await demoBag(page);
  const inv = inventoryRegion(menu), field = searchField(inv, ITEM_SEARCH);
  const chosen = (await tileIds(inv))[3];
  await inv.getByTestId(`tile-${chosen}`).click();
  await expect(inv.getByTestId(`tile-${chosen}`)).toHaveAttribute('aria-pressed', 'true');
  for (const clear of ['button', 'escape'] as const) {
    await field.fill('dagger');
    await expect(inv.getByText('No items match “dagger”')).toBeVisible();
    if (clear === 'button') await inv.getByRole('button', { name: 'Clear search', exact: true }).last().click();
    else await field.press('Escape');
    await expect(field).toHaveValue('');
    await expect(inv.getByTestId(`tile-${chosen}`), `cleared by ${clear}`).toHaveAttribute('aria-pressed', 'true');
    await expect(inv.getByTestId(`item-${chosen}`)).toBeVisible();
  }
  // The Shops already do so.
  const shops = shopsRegion(menu), shopField = searchField(shops);
  await offerCell(shops, 'axe:1:common').click();
  await shopField.fill('dagger');
  await expect(shops.getByText('No items match “dagger”')).toBeVisible();
  await shops.getByRole('button', { name: 'Clear search', exact: true }).last().click();
  await expect(offerCell(shops, 'axe:1:common')).toHaveAttribute('aria-pressed', 'true');
});
