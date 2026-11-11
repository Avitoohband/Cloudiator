import { test, expect, type BrowserContext, type Locator, type Page } from './fixtures';
import { randomUUID } from 'node:crypto';
import { ownerFixture, itemFixture } from '../fixtures/domain';
import type { ItemInstance } from '../../supabase/functions/_shared/contracts/reads';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1';
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
  let lose = false, code = '';
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
    if (path === '/rest/v1/owner_state') return json([{ state }]);
    // The player's presence (Task 23.9) is the live transport's.
    if (path === '/functions/v1/game-command' && isPresence(request)) return route.fallback();
    if (path === '/functions/v1/game-command') {
      const command = request.postDataJSON() as GameCommand; commands.push(command);
      expect(request.headers().authorization).toMatch(/^Bearer /);
      expect(command).not.toHaveProperty('ownerId');
      if (code) return json({ ok: false, code }, 409);
      let result = receipts.get(command.operationId);
      if (!result) {
        if (command.kind === 'buy-shop') {
          if (command.catalogId === 'banner') { state.wallets.renown -= 50; state.ownedCosmetics.push({ catalogId: 'banner', catalogVersion: 'v1', binding: 'bound' }); }
          else {
            state.wallets.money -= 40 * command.quantity;
            for (let i = 0; i < command.quantity; i++) state.inventory.push({ ...itemFixture(CATALOG_V1.items[command.catalogId]), id: randomUUID() });
          }
        } else if (command.kind === 'sell-item' || command.kind === 'discard-item') {
          const sold = state.inventory.find(item => item.id === command.itemId);
          if (sold && sold.quantity > command.quantity) sold.quantity -= command.quantity;
          else state.inventory = state.inventory.filter(item => item.id !== command.itemId);
          if (command.kind === 'sell-item') state.wallets.money += 10;
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
  return { commands, state, pieces, live, loseNext: () => { lose = true; }, reject: (value: string) => { code = value; } };
}

test.beforeEach(() => { test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Live UI uses development-only intercepted identity transport.'); });

const tile = (scope: Page | Locator, piece: ItemInstance) => scope.getByTestId(`tile-${piece.id}`);
const card = (scope: Page | Locator, piece: ItemInstance) => scope.getByTestId(`item-${piece.id}`);
async function selectItem(scope: Page | Locator, piece: ItemInstance) {
  await tile(scope, piece).click();
  return card(scope, piece);
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
  const filter = (name: string) => page.getByRole('button', { name, exact: true });
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
  const sell = card(menu, axe).getByRole('button', { name: 'Sell', exact: true });
  await sell.focus();

  const spear = { ...itemFixture(CATALOG_V1.items['spear:1:common']), id: randomUUID() };
  flow.state.inventory.unshift(spear);
  await publishInventoryRefresh(page, flow);
  await expect(tile(menu, spear)).toBeVisible();
  await expect(tile(menu, axe)).toHaveAttribute('aria-pressed', 'true');
  await expect(sell).toBeFocused();

  await menu.getByRole('button', { name: 'Armor', exact: true }).click();
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
  await expect(tile(menu, bound).getByText('#1', { exact: true })).toBeVisible();
  await expect(tile(menu, tradable).getByText('#2', { exact: true })).toBeVisible();
  await expect(await selectItem(menu, bound)).toContainText('Level 1 · common · Account-bound · Item 1');
  await expect(await selectItem(menu, tradable)).toContainText('Level 1 · common · Tradable · Item 2');
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
  await page.getByRole('button', { name: 'Armorer', exact: true }).click();
  // Patch 1.6 (spec "The Arena banner"): the shop says where the banner shows, before and after it is bought.
  const offer = page.locator('.cosmetic-offer');
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

test('retries the same operation after a lost response and explains processing without optimistic changes', async ({ page, context }) => {
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
  await page.getByRole('button', { name: 'Buy Axe', exact: true }).click();
  await expect(page.locator('.inventory-panel').getByRole('alert')).toContainText('processing');
  await expect(page.getByText('4 / 60 slots')).toBeVisible();
});

test('shows level locks and reservation restrictions with both currencies', async ({ page, context }) => {
  const flow = await inventoryFlow(context);
  await page.goto('/game/'); await openMenu(page, 'Inventory and shops');
  const equipped = await selectItem(page, flow.state.inventory[2]);
  await expect(equipped.getByRole('button', { name: 'Sell' })).toBeDisabled();
  await expect(equipped.getByRole('button', { name: 'Discard' })).toBeDisabled();
  await page.getByLabel('Shop tier').selectOption('5');
  await expect(page.getByRole('button', { name: 'Buy Sword', exact: true })).toBeDisabled();
  await expect(page.getByTestId('offer-sword:5:common')).toContainText('120 gold');
  await page.getByLabel('Shop currency').selectOption('renown');
  await expect(page.getByTestId('offer-sword:5:renown')).toContainText('100 renown');
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
  await expect(card(page, listed).getByText('Listed for sale', { exact: true })).toBeVisible();
  // Said once (final review fix: the availability line and a note both said it, so a screen reader read it twice).
  expect((await card(page, listed).innerText()).match(/Listed for sale/g)).toHaveLength(1);
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
  test(`keeps keyboard focus on a busy inventory ${action} button and ignores repeated activation`, async ({ page, context }) => {
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
    if (action === 'sell-item') button = (await selectItem(panel, flow.state.inventory[0])).getByRole('button', { name: 'Sell', exact: true });
    else if (action === 'discard-item') button = (await selectItem(panel, flow.state.inventory[1])).getByRole('button', { name: 'Discard', exact: true });
    else {
      if (action === 'buy-banner') await panel.getByRole('button', { name: 'Armorer', exact: true }).click();
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
    const outcome = panel.getByRole('status').filter({ hasText: action === 'sell-item' ? 'Sale confirmed.' : action === 'discard-item' ? 'Item discarded.' : 'Purchase confirmed.' });
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
