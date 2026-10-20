import { test, expect, type BrowserContext } from './fixtures';
import { randomUUID } from 'node:crypto';
import { ownerFixture } from '../fixtures/domain';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands';
import { emptyWorld, isPresence, routeLiveReads } from './live-routes';
import { openMenu } from './shell-helpers';

async function planningFlow(context: BrowserContext) {
  let state = structuredClone(ownerFixture);
  state.wallets.money = 300;
  state.processedSlotIndex = Math.floor(Date.now() / 4_800_000);
  const commands: GameCommand[] = [];
  let lose = false, processing = false, conflict = false;
  const receipts = new Map<string, unknown>();
  const user = { id: randomUUID(), aud: 'authenticated', role: 'authenticated', email: 'planning@example.invalid',
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
    // The player's presence (Task 23.9) is the live transport's.
    if (path === '/functions/v1/game-command' && isPresence(request)) return route.fallback();
    if (path === '/functions/v1/game-command') {
      const command = request.postDataJSON() as GameCommand; commands.push(command);
      expect(request.headers().authorization).toMatch(/^Bearer /);
      expect(command).not.toHaveProperty('ownerId');
      if (processing) return json({ ok: false, code: 'processing', retryAfterMs: 1000 }, 409);
      if (conflict) { conflict = false; state.buildVersion++; return json({ ok: false, code: 'conflict' }, 409); }
      let result = receipts.get(command.operationId);
      if (!result) {
        if (command.kind === 'queue-build') {
          state.buildVersion++;
          state.pendingBuild = { build: { version: state.buildVersion, classId: command.classId, stance: command.stance, allocations: command.allocation, equipment: command.equipment },
            effectiveSlotIndex: state.processedSlotIndex + 1, reservedMoney: 100, reservedItemIds: [], operationId: command.operationId };
          state.reservedFees.money = 100;
          result = { ok: true, receiptId: randomUUID(), value: state.pendingBuild };
        } else if (command.kind === 'cancel-build') {
          state.buildVersion++; state.pendingBuild = null; state.reservedFees.money = 0;
          result = { ok: true, receiptId: randomUUID(), value: { buildVersion: state.buildVersion } };
        } else if (command.kind === 'edit-schedule') {
          state.schedule[command.phase] = command.choice; state.scheduleVersion++;
          result = { ok: true, receiptId: randomUUID(), value: { version: state.scheduleVersion, effectiveAtMs: (state.processedSlotIndex + 3) * 4_800_000 } };
        } else throw new Error('Unexpected planning command');
        receipts.set(command.operationId, result);
      }
      if (lose) { lose = false; return route.abort('failed'); }
      return json(result);
    }
    return route.fallback();
  });
  return { commands, loseNext: () => { lose = true; }, processing: (value: boolean) => { processing = value; }, conflictNext: () => { conflict = true; } };
}

test.beforeEach(() => { test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Live UI uses development-only intercepted identity transport.'); });

test('queues, confirms and cancels pending builds without optimistic current replacement', async ({ page, context }, testInfo) => {
  const flow = await planningFlow(context);
  await page.goto('/game/');
  await openMenu(page, 'My gladiator');
  await expect(page.getByRole('heading', { name: 'Current build', exact: true })).toBeVisible();
  await page.getByLabel('Class', { exact: true }).selectOption('berserker');
  await expect(page.getByText('Estimated reservation: 100 money')).toBeVisible();
  await page.getByRole('button', { name: 'Queue build' }).click();
  await expect(page.getByRole('heading', { name: 'Pending build', exact: true })).toBeVisible();
  await expect(page.getByTestId('current-build')).toContainText('guardian');
  await expect(page.getByTestId('pending-build')).toContainText('berserker');
  await expect(page.getByTestId('pending-build')).toContainText('Effective');
  await page.locator('.planning-form').screenshot({ path: testInfo.outputPath('planning.png') });
  await page.getByRole('button', { name: 'Cancel pending build' }).click();
  await expect(page.getByRole('heading', { name: 'Pending build', exact: true })).not.toBeVisible();
  expect(flow.commands.map(c => c.kind)).toEqual(['queue-build', 'cancel-build']);
  expect(flow.commands[1]).toHaveProperty('expectedVersion', 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('reuses immutable operation after unknown outcome and reloads a version conflict', async ({ page, context }) => {
  const flow = await planningFlow(context);
  await page.goto('/game/');
  await openMenu(page, 'My gladiator');
  await page.getByLabel('Class', { exact: true }).selectOption('berserker');
  flow.loseNext();
  await page.getByRole('button', { name: 'Queue build' }).click();
  await expect(page.locator('.planning-form [role="alert"]')).toContainText('could not be confirmed');
  await page.getByRole('button', { name: 'Queue build' }).click();
  await expect(page.getByRole('heading', { name: 'Pending build', exact: true })).toBeVisible();
  expect(flow.commands[0]).toEqual(flow.commands[1]);
  flow.conflictNext();
  await page.getByRole('button', { name: 'Cancel pending build' }).click();
  await expect(page.locator('.planning-form [role="alert"]')).toContainText('changed');
  await page.getByRole('button', { name: 'Cancel pending build' }).click();
  expect(flow.commands.at(-1)).toHaveProperty('expectedVersion', 3);
  expect(flow.commands.at(-1)?.operationId).not.toBe(flow.commands.at(-2)?.operationId);
});

test('edits future repeating phases and retries processing without local authority', async ({ page, context }) => {
  const flow = await planningFlow(context);
  await page.goto('/game/');
  await openMenu(page, 'Schedule');
  await page.getByLabel('morning activity').selectOption('arena');
  flow.processing(true);
  await page.getByRole('button', { name: 'Save morning' }).click();
  await expect(page.locator('.planning-form [role="alert"]')).toContainText('processing');
  flow.processing(false);
  await page.getByRole('button', { name: 'Save morning' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Effective' })).toBeVisible();
  expect(flow.commands[0]).toEqual(flow.commands[1]);
  await expect(page.getByLabel('afternoon activity').locator('option[value="expedition:mountain"]')).toBeDisabled();
});

test('re-estimates the next start after a boundary passes while the panel stays open', async ({ page, context }) => {
  await planningFlow(context);
  await page.goto('/game/');
  await openMenu(page, 'Schedule');
  const starts = page.locator('.planning-form p').filter({ hasText: /^Estimated next start:/ });
  await expect(starts).toHaveCount(3);
  // The shared clock has its server time from the first revision read.
  await page.waitForFunction(() => window.__cloudiatorShell?.clock.synced() === true);
  const before = await starts.allTextContents();
  // One slot (80 minutes) later, with the panel still open: the phase that has just started moves to its next
  // occurrence, and no estimate is in the past. Written apart from the panel: slot n is phase n mod 3.
  const later = await page.evaluate(() => { const clock = window.__cloudiatorShell!.clock; const t = clock.now() + 80 * 60_000; clock.freeze(t); return t; });
  const slot = Math.floor(later / 4_800_000);
  const next = [0, 1, 2].map(phase => (slot + ((phase - (slot % 3) + 3) % 3 || 3)) * 4_800_000);
  for (const ms of next) expect(ms).toBeGreaterThan(later);
  const expected = await page.evaluate(times => times.map(ms => `Estimated next start: ${new Date(ms).toLocaleString()}`), next);
  await expect(starts).toHaveText(expected);
  expect(expected).not.toEqual(before);
});
