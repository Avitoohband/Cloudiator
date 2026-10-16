import { test, expect, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerFixture, itemFixture } from '../fixtures/domain';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands';
import { emptyWorld, routeLiveReads } from './live-routes';

async function inventoryFlow(context: BrowserContext) {
  const state = structuredClone(ownerFixture);
  state.wallets = { money: 300, renown: 100 };
  state.inventory = ['axe:1:common', 'sword:1:renown', 'light-armor:1:common'].map(id => ({ ...itemFixture(CATALOG_V1.items[id]), id: randomUUID() }));
  state.inventory[2].reservation = { kind: 'equipment', referenceId: state.gladiatorId };
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
  await routeLiveReads(context, { world: emptyWorld() });
  await context.route('http://127.0.0.1:54321/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    const json = (body: unknown, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (path === '/auth/v1/user') return json(user);
    if (path === '/auth/v1/logout') return route.fulfill({ status: 204, headers });
    if (path === '/rest/v1/owner_state') return json([{ state }]);
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
          state.inventory = state.inventory.filter(item => item.id !== command.itemId);
          if (command.kind === 'sell-item') state.wallets.money += 10;
        } else throw new Error('Unexpected inventory command');
        result = { ok: true, receiptId: randomUUID(), value: {} }; receipts.set(command.operationId, result);
      }
      if (lose) { lose = false; return route.abort('failed'); }
      return json(result);
    }
    return route.fallback();
  });
  return { commands, state, loseNext: () => { lose = true; }, reject: (value: string) => { code = value; } };
}

test.beforeEach(() => { test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Live UI uses development-only intercepted identity transport.'); });

test('buys through the live gateway, refreshes inventory, and confirms bound discard without a cash reward', async ({ page, context }, info) => {
  const flow = await inventoryFlow(context);
  await page.goto('/game/');
  await page.getByRole('button', { name: 'Inventory', exact: true }).click();
  await expect(page.getByText('3 / 60 slots')).toBeVisible();
  await page.getByRole('button', { name: 'Buy Sword', exact: true }).click();
  await expect(page.getByText('4 / 60 slots')).toBeVisible();
  const bound = page.getByTestId(`item-${flow.state.inventory[1].id}`);
  await expect(bound.getByRole('button', { name: 'Sell' })).toBeDisabled();
  await bound.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm discard' })).toBeVisible();
  expect(flow.commands).toHaveLength(1);
  await page.getByRole('button', { name: 'Keep item' }).click();
  await bound.getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('button', { name: 'Confirm discard', exact: true }).click();
  await expect(bound).toHaveCount(0);
  expect(flow.commands.map(command => command.kind)).toEqual(['buy-shop', 'discard-item']);
  await expect(page.getByText('Available money: 260')).toBeVisible();
  await page.getByRole('button', { name: 'Armorer', exact: true }).click();
  await page.getByRole('button', { name: 'Buy Arena banner', exact: true }).click();
  await expect(page.getByText('Arena banner · Owned · Account-bound')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#management-panel').screenshot({ path: info.outputPath('inventory-shops.png') });
});

test('retries the same operation after a lost response and explains processing without optimistic changes', async ({ page, context }) => {
  const flow = await inventoryFlow(context);
  await page.goto('/game/'); await page.getByRole('button', { name: 'Inventory', exact: true }).click();
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
  await page.goto('/game/'); await page.getByRole('button', { name: 'Inventory', exact: true }).click();
  const equipped = page.getByTestId(`item-${flow.state.inventory[2].id}`);
  await expect(equipped.getByRole('button', { name: 'Sell' })).toBeDisabled();
  await expect(equipped.getByRole('button', { name: 'Discard' })).toBeDisabled();
  await page.getByLabel('Shop tier').selectOption('5');
  await expect(page.getByRole('button', { name: 'Buy Sword', exact: true })).toBeDisabled();
  await expect(page.getByTestId('offer-sword:5:common')).toContainText('120 money');
  await page.getByLabel('Shop currency').selectOption('renown');
  await expect(page.getByTestId('offer-sword:5:renown')).toContainText('100 renown');
  expect(flow.commands).toHaveLength(0);
});

test('fixture inventory and shops remain read-only alongside the camp', async ({ page }) => {
  await page.goto('/game/?mode=fixture');
  await page.getByRole('button', { name: 'Inventory', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shops', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Buy Sword', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'unavailable in this preview' })).toBeVisible();
  await expect(page.getByText('0 / 60 slots')).toBeVisible();
});
