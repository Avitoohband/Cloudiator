import { createHash, randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands';
import { ownerFixture } from '../fixtures/domain';
import { emptyWorld, routeLiveReads } from './live-routes';
import { cornerChip, openChipMenu, openMenu, signOutFromChip } from './shell-helpers';

// Explicitly test-only HTTP identity transport. Production uses the unchanged Supabase SDK.
// Task 4 owns real Auth/database authority; hosted Google consent is Task 24's release gate.
async function identityFlow(context: BrowserContext, options: { expiresIn?: number; ownerError?: boolean } = {}) {
  const userId = randomUUID();
  let owner: OwnerState | null = null;
  let failResponse = false;
  let forceConflict = false;
  let readsFail = options.ownerError ?? false;
  let creationCount = 0;
  const commands: GameCommand[] = [];
  const receipts = new Map<string, unknown>();
  const challenges = new Map<string, string>();
  let codeNumber = 0;
  let delayedOwnerRead: { started(): void; wait: Promise<void>; done(): void } | null = null;
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'test@example.invalid',
    app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: {},
    identities: [{ id: randomUUID(), user_id: userId, provider: 'google', identity_data: { sub: userId } }],
    created_at: new Date().toISOString() };
  const session = () => {
    const expiresIn = options.expiresIn ?? 3600;
    const now = Math.floor(Date.now() / 1000);
    const jwt = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: userId, aud: 'authenticated', role: 'authenticated', exp: now + expiresIn, iat: now })).toString('base64url'), 'test-signature'].join('.');
    return { access_token: jwt, refresh_token: 'test-refresh', token_type: 'bearer', expires_in: expiresIn, expires_at: now + expiresIn, user };
  };
  // The live camp's public reads; this spec's own handler (registered next, so it runs first) hands it everything else.
  await routeLiveReads(context, { world: emptyWorld() });
  await context.route('http://127.0.0.1:54321/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    const json = (body: unknown, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/auth/v1/authorize') {
      expect(url.searchParams.get('provider')).toBe('google');
      expect(url.searchParams.get('scopes')).toBe('openid email profile');
      expect(url.searchParams.get('code_challenge_method')).toBe('s256');
      const callback = new URL(url.searchParams.get('redirect_to')!);
      expect(callback.pathname).toBe('/auth/callback/');
      const code = `test-code-${++codeNumber}`;
      challenges.set(code, url.searchParams.get('code_challenge')!);
      return route.fulfill({ contentType: 'text/html', body: `<html><body><h1>Test-only Google consent</h1><a href="${callback.origin}/auth/callback/?code=${code}">Approve test Google</a><a href="${callback.origin}/auth/callback/?error=access_denied&error_description=Untrusted%20provider%20text">Cancel test Google</a></body></html>` });
    }
    if (url.pathname === '/auth/v1/token') {
      const body = request.postDataJSON();
      if (url.searchParams.get('grant_type') !== 'pkce') return json({ msg: 'Refresh denied', error_code: 'refresh_token_not_found' }, 400);
      const challenge = challenges.get(body.auth_code);
      if (!challenge) return json({ msg: 'Code expired', error_code: 'flow_state_not_found' }, 400);
      expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(challenge);
      challenges.delete(body.auth_code);
      return json(session());
    }
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/auth/v1/user') return json(user);
    if (url.pathname === '/rest/v1/owner_state') {
      expect(url.searchParams.get('select')).toBe('state');
      expect(request.headers().authorization).toMatch(/^Bearer /);
      if (readsFail) return json({ message: 'Read unavailable', code: 'XX000' }, 400);
      if (delayedOwnerRead) {
        const delayed = delayedOwnerRead;
        delayedOwnerRead = null;
        const snapshot = owner ? structuredClone(owner) : null;
        delayed.started();
        await delayed.wait;
        await json(snapshot ? [{ state: snapshot }] : []);
        delayed.done();
        return;
      }
      return json(owner ? [{ state: owner }] : []);
    }
    if (url.pathname === '/functions/v1/game-command') {
      const command = request.postDataJSON() as GameCommand;
      commands.push(command);
      expect(Object.keys(command).sort()).toEqual(['allocation', 'classId', 'kind', 'name', 'operationId']);
      expect(command.operationId).toMatch(/^[0-9a-f-]{36}$/);
      let result = receipts.get(command.operationId);
      if (!result && command.kind === 'create-character') {
        if (forceConflict || owner) result = { ok: false, code: 'conflict' };
        else {
          owner = structuredClone(ownerFixture);
          owner.name = command.name;
          owner.currentBuild.classId = command.classId;
          owner.currentBuild.allocations = command.allocation;
          creationCount++;
          result = { ok: true, receiptId: randomUUID(), value: { gladiatorId: owner.gladiatorId } };
        }
        receipts.set(command.operationId, result);
      }
      if (failResponse) { failResponse = false; return route.abort('failed'); }
      return json(result, (result as { ok: boolean }).ok ? 200 : 409);
    }
    return route.fallback();
  });
  return {
    commands, characterCount: () => creationCount,
    loseNextResponse: () => { failResponse = true; },
    switchAccount: () => { user.id = randomUUID(); },
    holdNextOwnerRead() {
      let started = () => {};
      let done = () => {};
      let release = () => {};
      const startedPromise = new Promise<void>(resolve => { started = resolve; });
      const donePromise = new Promise<void>(resolve => { done = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      delayedOwnerRead = { started, done, wait };
      return { started: startedPromise, done: donePromise, release };
    },
    conflict: (value: boolean) => { forceConflict = value; },
    failOwner: (value: boolean) => { readsFail = value; },
    async signIn(page: Page) {
      await openMenu(page, 'My gladiator');
      await page.getByRole('button', { name: 'Continue with Google' }).click();
      await page.getByRole('link', { name: 'Approve test Google' }).click();
      await expect(page).toHaveURL(/\/game\/$/);
      await expect((await openChipMenu(page)).getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      await cornerChip(page).getByRole('button').first().click();
      await openMenu(page, 'My gladiator');
    },
    async cancelGoogleAndReturn(page: Page) {
      await openMenu(page, 'My gladiator');
      await page.getByRole('button', { name: 'Continue with Google' }).click();
      await page.getByRole('link', { name: 'Cancel test Google' }).click();
      await expect(page.getByText('Google sign-in was canceled. Your creation draft is safe.')).toBeVisible();
      await expect(page.getByText('Untrusted provider text')).toHaveCount(0);
      await page.reload();
      await page.getByRole('link', { name: 'Return to the camp' }).click();
    },
  };
}

test.beforeEach(() => { test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Mock HTTP transport is development-only.'); });

test('retains creation draft through canceled OAuth, back and refresh', async ({ page, context }) => {
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await openMenu(page, 'My gladiator');
  await page.getByLabel('Gladiator name').fill('Avi Fighter');
  await page.getByLabel('Duelist', { exact: true }).check();
  await flow.cancelGoogleAndReturn(page);
  await openMenu(page, 'My gladiator');
  await expect(page.getByLabel('Gladiator name')).toHaveValue('Avi Fighter');
  await expect(page.getByLabel('Duelist', { exact: true })).toBeChecked();
  await page.reload();
  await openMenu(page, 'My gladiator');
  await expect(page.getByLabel('Gladiator name')).toHaveValue('Avi Fighter');
  await page.goBack();
  await expect(page).toHaveURL(/\/auth\/callback\//);
});

test('retries a lost response with the same operation ID and reloads online owner after refresh', async ({ page, context }) => {
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await openMenu(page, 'My gladiator');
  await page.getByLabel('Gladiator name').fill('Avi Fighter');
  await flow.signIn(page);
  flow.loseNextResponse();
  await page.getByRole('button', { name: 'Create gladiator', exact: true }).dblclick();
  await expect(page.locator('p[role=alert]')).toContainText('could not be confirmed');
  await page.getByRole('button', { name: 'Create gladiator', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Avi Fighter', exact: true })).toBeVisible();
  // Hide the owner read just for the reload, then retry the same original command.
  flow.failOwner(true);
  await page.reload();
  await openMenu(page, 'My gladiator');
  await expect(page.locator('p[role=alert]')).toContainText('could not be loaded');
  flow.failOwner(false);
  await page.getByRole('button', { name: 'Retry owner load' }).click();
  await expect(page.getByRole('heading', { name: 'Avi Fighter', exact: true })).toBeVisible();
  expect(flow.characterCount()).toBe(1);
  expect(flow.commands).toHaveLength(2);
  expect(flow.commands[1].operationId).toBe(flow.commands[0].operationId);
});

test('a command retry retains its ID and editing a conflicted draft obtains a fresh ID', async ({ page, context }) => {
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await openMenu(page, 'My gladiator');
  await page.getByLabel('Gladiator name').fill('Name Taken');
  await flow.signIn(page);
  flow.conflict(true);
  await page.getByRole('button', { name: 'Create gladiator', exact: true }).click();
  await expect(page.locator('p[role=alert]')).toContainText('name may already be taken');
  await page.reload();
  await openMenu(page, 'My gladiator');
  await page.getByRole('button', { name: 'Create gladiator', exact: true }).click();
  await expect(page.locator('p[role=alert]')).toContainText('name may already be taken');
  expect(flow.commands[1].operationId).toBe(flow.commands[0].operationId);
  await page.getByLabel('Gladiator name').fill('Fresh Fighter');
  flow.conflict(false);
  await page.getByRole('button', { name: 'Create gladiator', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fresh Fighter', exact: true })).toBeVisible();
  expect(flow.commands[2].operationId).not.toBe(flow.commands[0].operationId);
});

test('two signed-in tabs converge on one online character and sign-out clears both views', async ({ page, context }) => {
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await openMenu(page, 'My gladiator');
  await page.getByLabel('Gladiator name').fill('Twin Fighter');
  await flow.signIn(page);
  const other = await context.newPage();
  await other.goto('/game/');
  await openMenu(other, 'My gladiator');
  await expect(other.getByRole('button', { name: 'Create gladiator', exact: true })).toBeEnabled();
  await Promise.all([page.getByRole('button', { name: 'Create gladiator', exact: true }).click(), other.getByRole('button', { name: 'Create gladiator', exact: true }).click()]);
  await expect(page.getByRole('heading', { name: 'Twin Fighter', exact: true })).toBeVisible();
  await expect(other.getByRole('heading', { name: 'Twin Fighter', exact: true })).toBeVisible();
  expect(flow.characterCount()).toBe(1);
  await signOutFromChip(other);
  await expect(other.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Twin Fighter', exact: true })).toHaveCount(0);
});

test('validates names and finite whole-point allocation, derives starters and permits keyboard creation without mobile overflow', async ({ page, context }, testInfo) => {
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  await page.getByLabel('Gladiator name').fill('!bad');
  await page.getByRole('button', { name: 'Create gladiator', exact: true }).click();
  await expect(page.locator('p[role=alert]')).toContainText('3–20');
  await page.getByLabel('Gladiator name').fill('  Keyboard Fighter  ');
  await page.getByLabel('Strength points').fill('2.5');
  await expect(page.getByText('Allocate exactly 10 whole points.')).toBeVisible();
  await page.getByLabel('Strength points').fill('3');
  await expect(page.getByText('Allocate exactly 10 whole points.')).toBeVisible();
  await page.getByLabel('Strength points').fill('2');
  await page.getByLabel('Guardian', { exact: true }).check();
  await expect(page.getByTestId('preview-hp')).toHaveText('123');
  await expect(page.getByTestId('preview-stamina')).toHaveText('104');
  await expect(page.getByTestId('preview-load')).toHaveText('7 / 24.7');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('creation-preview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Create gladiator', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Keyboard Fighter', exact: true })).toBeVisible();
  expect(flow.commands[0]).toMatchObject({ name: 'Keyboard Fighter', classId: 'guardian', allocation: { strength: 2, agility: 2, vitality: 2, endurance: 2, precision: 2 } });
});

test('expiry removes private owner and requires sign-in when refresh fails', async ({ page, context }) => {
  const flow = await identityFlow(context, { expiresIn: 5 });
  await page.goto('/game/');
  await openMenu(page, 'My gladiator');
  await page.getByLabel('Gladiator name').fill('Short Session');
  await flow.signIn(page);
  await page.getByRole('button', { name: 'Create gladiator', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Short Session', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Short Session', exact: true })).toHaveCount(0);
});

test('owner read errors do not offer creation and callback failure has safe fixed navigation', async ({ page, context }) => {
  const flow = await identityFlow(context, { ownerError: true });
  await page.goto('/game/');
  await flow.signIn(page);
  await expect(page.locator('p[role=alert]')).toContainText('could not be loaded');
  await expect(page.getByRole('button', { name: 'Create gladiator', exact: true })).toHaveCount(0);
  await page.goto('/auth/callback/?code=invalid&next=https://example.invalid/');
  await expect(page.locator('p[role=alert]')).toContainText('could not be completed');
  await expect(page.getByRole('link', { name: 'Return to the camp' })).toHaveAttribute('href', '/game/');
});

test('fragment OAuth errors are canceled safely and cannot display provider text', async ({ page }) => {
  await page.goto('/auth/callback/#error=access_denied&error_description=Untrusted%20fragment');
  await expect(page.locator('p[role=alert]')).toContainText('was canceled');
  await expect(page.getByText('Untrusted fragment')).toHaveCount(0);
  await expect(page).toHaveURL(/\/auth\/callback\/$/);
});

test('account changes cannot reuse another account creation attempt', async ({ page, context }) => {
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await openMenu(page, 'My gladiator');
  await page.getByLabel('Gladiator name').fill('Account Draft');
  await flow.signIn(page);
  flow.conflict(true);
  await page.getByRole('button', { name: 'Create gladiator', exact: true }).click();
  await expect(page.locator('p[role=alert]')).toContainText('name may already be taken');
  const firstId = flow.commands[0].operationId;
  await signOutFromChip(page);
  flow.switchAccount();
  await flow.signIn(page);
  await expect(page.getByLabel('Gladiator name')).toHaveValue('Account Draft');
  flow.conflict(false);
  await page.getByRole('button', { name: 'Create gladiator', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Account Draft', exact: true })).toBeVisible();
  expect(flow.commands[1].operationId).not.toBe(firstId);
  expect(await page.evaluate(() => localStorage.getItem('cloudiator.creation-draft.v1'))).toBeNull();
});

test('a slow no-character focus read cannot replace the confirmed creation owner', async ({ page, context }) => {
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await openMenu(page, 'My gladiator');
  await page.getByLabel('Gladiator name').fill('Confirmed Fighter');
  await flow.signIn(page);
  await expect(page.getByRole('button', { name: 'Create gladiator', exact: true })).toBeEnabled();
  const held = flow.holdNextOwnerRead();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await held.started;
  await page.getByRole('button', { name: 'Create gladiator', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirmed Fighter', exact: true })).toBeVisible();
  const response = page.waitForResponse(url => url.url().includes('/rest/v1/owner_state'));
  held.release();
  await Promise.all([held.done, response]);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('heading', { name: 'Confirmed Fighter', exact: true })).toBeVisible();
  expect(flow.characterCount()).toBe(1);
});
