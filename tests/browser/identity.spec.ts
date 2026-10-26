import { createHash, randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from './fixtures';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands';
import { ownerFixture } from '../fixtures/domain';
import { emptyWorld, isPresence, routeLiveReads } from './live-routes';
import { chipToggle, creationDialog, joinButton, openMenu, signOutFromChip, spendSuggestedPoints } from './shell-helpers';

/** A visitor's My gladiator panel (Task 13.6). */
const VISITOR_PROMPT = 'Sign in with Google to create your gladiator';

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
    // A created gladiator's presence (Task 23.9) is the live transport's.
    if (url.pathname === '/functions/v1/game-command' && isPresence(request)) return route.fallback();
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
    /** Signs in from the visitor's corner chip (Task 13.6); without a gladiator the creation dialog then opens over the camp. */
    async signIn(page: Page) {
      await joinButton(page).click();
      await page.getByRole('link', { name: 'Approve test Google' }).click();
      await expect(page).toHaveURL(/\/game\/$/);
      await expect(chipToggle(page)).toBeVisible();
    },
    /** Starts a sign-in from the chip and cancels it: back on the camp as a visitor, with a short message (plan Decision 6). */
    async cancelGoogleAndReturn(page: Page) {
      await joinButton(page).click();
      await page.getByRole('link', { name: 'Cancel test Google' }).click();
      await expect(page).toHaveURL(/\/game\/$/);
      await expect(page.getByRole('status').filter({ hasText: 'Google sign-in was canceled.' })).toBeVisible();
      await expect(page.getByText('Untrusted provider text')).toHaveCount(0);
      await expect(joinButton(page)).toBeVisible();
    },
  };
}

/** Closes the creation dialog with "Not now" (it is modal), then signs out from the corner chip. */
async function dismissAndSignOut(page: Page) {
  await creationDialog(page).getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(creationDialog(page)).toBeHidden();
  await signOutFromChip(page);
  await expect(joinButton(page)).toBeVisible();
}

test.beforeEach(() => { test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Mock HTTP transport is development-only.'); });

test('retains creation draft through canceled OAuth, back and refresh', async ({ page, context }) => {
  // Task 13.6: the draft is written in the creation dialog after sign-in, and kept on this device through a later
  // canceled sign-in, the Back button and a refresh.
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  const dialog = creationDialog(page);
  await dialog.getByLabel('Gladiator name').fill('Avi Fighter');
  await dialog.getByLabel('Duelist', { exact: true }).check();
  await spendSuggestedPoints(page);
  await dismissAndSignOut(page);
  await flow.cancelGoogleAndReturn(page);
  // The canceled return replaced the callback in history (plan Decision 6): Back leaves the camp, never to the callback.
  await page.goBack();
  await expect(page).not.toHaveURL(/\/auth\/callback\//);
  await page.goForward();
  await expect(page).toHaveURL(/\/game\/$/);
  await flow.signIn(page);
  await expect(dialog.getByLabel('Gladiator name')).toHaveValue('Avi Fighter');
  await expect(dialog.getByLabel('Duelist', { exact: true })).toBeChecked();
  // A saved draft keeps its points too: the Duelist's suggested split, all 10 spent.
  await expect(dialog.getByRole('status').filter({ hasText: 'All 10 spent' })).toBeVisible();
  await expect(dialog.getByLabel('Agility points')).toHaveValue('4');
  await page.reload();
  await expect(dialog.getByLabel('Gladiator name')).toHaveValue('Avi Fighter');
  await expect(dialog.getByLabel('Agility points')).toHaveValue('4');
  await expect(dialog.getByLabel('Precision points')).toHaveValue('4');
});

test('retries a lost response with the same operation ID and reloads online owner after refresh', async ({ page, context }) => {
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  await creationDialog(page).getByLabel('Gladiator name').fill('Avi Fighter');
  await spendSuggestedPoints(page);
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
  await expect(creationDialog(page)).toHaveCount(0);
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
  await flow.signIn(page);
  await creationDialog(page).getByLabel('Gladiator name').fill('Name Taken');
  await spendSuggestedPoints(page);
  flow.conflict(true);
  await page.getByRole('button', { name: 'Create gladiator', exact: true }).click();
  await expect(page.locator('p[role=alert]')).toContainText('name may already be taken');
  // After a reload the dialog opens again over the camp, with the saved attempt.
  await page.reload();
  await expect(creationDialog(page)).toBeVisible();
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
  await flow.signIn(page);
  await creationDialog(page).getByLabel('Gladiator name').fill('Twin Fighter');
  await spendSuggestedPoints(page);
  const other = await context.newPage();
  await other.goto('/game/');
  // The second tab is signed in too, so its creation dialog opens over its camp, with the shared draft.
  await expect(creationDialog(other).getByLabel('Gladiator name')).toHaveValue('Twin Fighter');
  await expect(other.getByRole('button', { name: 'Create gladiator', exact: true })).toBeEnabled();
  await Promise.all([page.getByRole('button', { name: 'Create gladiator', exact: true }).click(), other.getByRole('button', { name: 'Create gladiator', exact: true }).click()]);
  await expect(page.getByRole('heading', { name: 'Twin Fighter', exact: true })).toBeVisible();
  await expect(other.getByRole('heading', { name: 'Twin Fighter', exact: true })).toBeVisible();
  expect(flow.characterCount()).toBe(1);
  await signOutFromChip(other);
  // Both tabs return to the visitor view: My gladiator, still open, offers sign-in instead of the gladiator.
  await expect(other.getByRole('button', { name: VISITOR_PROMPT })).toBeVisible();
  await expect(page.getByRole('button', { name: VISITOR_PROMPT })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Twin Fighter', exact: true })).toHaveCount(0);
});

test('validates names and the ten whole points, derives starters and permits keyboard creation without mobile overflow', async ({ page, context }, testInfo) => {
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  const dialog = creationDialog(page);
  await expect(dialog).toBeVisible();
  const create = dialog.getByRole('button', { name: 'Create gladiator', exact: true });
  const counter = dialog.getByRole('status').filter({ hasText: /of 10 left|All 10 spent/ });
  const capped = dialog.getByRole('status').filter({ hasText: /points? left, so|No points left/ });
  // The points start at 0, so Create is off until all 10 are spent, and nothing is sent before that.
  await expect(counter).toHaveText('10 of 10 left');
  await expect(create).toBeDisabled();
  await spendSuggestedPoints(page);
  await dialog.getByLabel('Gladiator name').fill('!bad');
  await create.click();
  await expect(page.locator('p[role=alert]')).toContainText('3–20');
  expect(flow.commands).toHaveLength(0);
  await dialog.getByLabel('Gladiator name').fill('  Keyboard Fighter  ');
  // A typed number is a whole number: a fraction is floored, an empty field counts as 0, and more than is left is capped
  // at what is left (Avi: with 7 left, typing 10 sets 7) with a short line saying so.
  const strength = dialog.getByLabel('Strength points'), agility = dialog.getByLabel('Agility points');
  await dialog.getByRole('button', { name: 'Reset points' }).click();
  await strength.fill('2.5');
  await expect(strength).toHaveValue('2');
  await expect(counter).toHaveText('8 of 10 left');
  await strength.fill('3');
  await expect(counter).toHaveText('7 of 10 left');
  await agility.fill('10');
  await expect(agility).toHaveValue('7');
  await expect(capped).toHaveText('Only 7 points left, so Agility was set to 7.');
  await expect(counter).toHaveText('All 10 spent');
  await agility.fill('');
  await expect(agility).toHaveValue('0');
  await expect(counter).toHaveText('7 of 10 left');
  await expect(capped).toHaveCount(0);
  // The picked class's suggestion fills the split, and the starting build is derived from it (Guardian: vitality 5 + 5, x 1.05).
  await dialog.getByLabel('Guardian', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Suggested for Guardian', exact: true }).click();
  await expect(counter).toHaveText('All 10 spent');
  await expect(page.getByTestId('preview-hp')).toHaveText('155');
  await expect(page.getByTestId('preview-stamina')).toHaveText('104');
  await expect(page.getByTestId('preview-load')).toHaveText('7 / 24.7');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('creation-preview.png'), fullPage: true });
  await create.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Keyboard Fighter', exact: true })).toBeVisible();
  expect(flow.commands[0]).toMatchObject({ name: 'Keyboard Fighter', classId: 'guardian', allocation: { strength: 2, agility: 0, vitality: 5, endurance: 2, precision: 1 } });
});

test('spends the ten points with a counter, steppers, a cap and the class suggestion, and keeps them in the draft', async ({ page, context }) => {
  // Launch feedback (2026-10-25), goal 1: "-10 points remaining" was confusing; the points start at 0 and say what they do.
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  const dialog = creationDialog(page);
  await expect(dialog).toBeVisible();
  const create = dialog.getByRole('button', { name: 'Create gladiator', exact: true });
  const counter = dialog.getByRole('status').filter({ hasText: /of 10 left|All 10 spent/ });
  const capped = dialog.getByRole('status').filter({ hasText: /points? left, so|No points left/ });
  const field = (name: string) => dialog.getByLabel(`${name} points`);
  const add = (name: string) => dialog.getByRole('button', { name: `Add a point to ${name}`, exact: true });
  const remove = (name: string) => dialog.getByRole('button', { name: `Remove a point from ${name}`, exact: true });
  const total = (name: string) => field(name).locator('xpath=ancestor::div[1]').getByText(/^Total = \d+$/);
  const pips = (state: string) => dialog.locator(`[aria-hidden="true"] > span[data-on="${state}"]`);
  const names = ['Strength', 'Agility', 'Vitality', 'Endurance', 'Precision'];
  const hints = ['More damage with every hit', 'Faster attacks, harder to hit', '+10 health per point', '+2 stamina per point, carries more', 'Hits more often, more critical hits'];
  // A fresh draft: 0 points everywhere, "5 + 0 = 5" with the one-line effect, ten pips, and Create off with the reason why.
  await expect(counter).toHaveText('10 of 10 left');
  await expect(dialog.getByText('Every attribute starts at 5. Points add on top.')).toBeVisible();
  for (const [index, name] of names.entries()) {
    await expect(field(name)).toHaveValue('0');
    await expect(total(name)).toHaveText('Total = 5');
    await expect(dialog.getByText(hints[index], { exact: true })).toBeVisible();
    await expect(field(name)).not.toHaveAttribute('aria-invalid', 'true');
  }
  await expect(pips('false')).toHaveCount(10);
  await expect(pips('true')).toHaveCount(0);
  await expect(create).toBeDisabled();
  await expect(create).toHaveAccessibleDescription('Spend 10 more points to continue.');
  // The steppers add and take back one point; − stops at 0 and does nothing there.
  for (let i = 0; i < 3; i++) await add('Strength').click();
  await expect(field('Strength')).toHaveValue('3');
  await expect(total('Strength')).toHaveText('Total = 8');
  await expect(counter).toHaveText('7 of 10 left');
  await expect(create).toHaveAccessibleDescription('Spend 7 more points to continue.');
  await expect(pips('true')).toHaveCount(3);
  await remove('Strength').click();
  await expect(field('Strength')).toHaveValue('2');
  await expect(remove('Agility')).toHaveAttribute('aria-disabled', 'true');
  await remove('Agility').click({ force: true });
  await expect(field('Agility')).toHaveValue('0');
  await expect(counter).toHaveText('8 of 10 left');
  // Typing more than is left is capped at what is left, and says so; the next change clears the line.
  await field('Strength').fill('3');
  await field('Agility').fill('10');
  await expect(field('Agility')).toHaveValue('7');
  await expect(capped).toHaveText('Only 7 points left, so Agility was set to 7.');
  await expect(counter).toHaveText('All 10 spent');
  await expect(create).toBeEnabled();
  await expect(create).toHaveAccessibleDescription('Ready. You can change your build later.');
  await expect(page.getByTestId('preview-hp')).toBeVisible();
  // With nothing left every + stops (it stays focusable, and a click does nothing).
  for (const name of names) await expect(add(name)).toHaveAttribute('aria-disabled', 'true');
  await add('Vitality').click({ force: true });
  await expect(field('Vitality')).toHaveValue('0');
  await field('Strength').fill('99');
  await expect(field('Strength')).toHaveValue('3');
  await expect(capped).toHaveText('No points left to add, so Strength stays at 3.');
  await field('Agility').fill('4');
  await expect(capped).toHaveCount(0);
  await expect(counter).toHaveText('3 of 10 left');
  await expect(dialog).not.toContainText(/-\d/);
  // Reset points takes everything back.
  await dialog.getByRole('button', { name: 'Reset points', exact: true }).click();
  await expect(counter).toHaveText('10 of 10 left');
  for (const name of names) await expect(field(name)).toHaveValue('0');
  await expect(create).toBeDisabled();
  // "Suggested for {class}" follows the class picker and fills that class's split.
  const splits = { Berserker: [5, 1, 2, 1, 1], Guardian: [2, 0, 5, 2, 1], Duelist: [2, 4, 0, 0, 4] };
  for (const [className, split] of Object.entries(splits)) {
    await dialog.getByLabel(className, { exact: true }).check();
    await dialog.getByRole('button', { name: `Suggested for ${className}`, exact: true }).click();
    await expect(counter).toHaveText('All 10 spent');
    for (const [index, name] of names.entries()) await expect(field(name)).toHaveValue(String(split[index]));
    await expect(create).toBeEnabled();
  }
  // A saved draft keeps its values across a reload.
  await page.reload();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Duelist', { exact: true })).toBeChecked();
  await expect(counter).toHaveText('All 10 spent');
  for (const [index, name] of names.entries()) await expect(field(name)).toHaveValue(String(splits.Duelist[index]));
  // An empty field counts as 0.
  await field('Precision').fill('');
  await expect(field('Precision')).toHaveValue('0');
  await expect(counter).toHaveText('4 of 10 left');
  await expect(dialog.getByText('Spend 4 more points to continue.')).toBeVisible();
  expect(flow.commands).toHaveLength(0);
});

test('expiry removes private owner and requires sign-in when refresh fails', async ({ page, context }) => {
  const flow = await identityFlow(context, { expiresIn: 5 });
  await page.goto('/game/');
  await flow.signIn(page);
  await creationDialog(page).getByLabel('Gladiator name').fill('Short Session');
  await spendSuggestedPoints(page);
  await page.getByRole('button', { name: 'Create gladiator', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Short Session', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: VISITOR_PROMPT })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Short Session', exact: true })).toHaveCount(0);
});

test('owner read errors do not offer creation and callback failure has safe fixed navigation', async ({ page, context }) => {
  const flow = await identityFlow(context, { ownerError: true });
  await page.goto('/game/');
  await flow.signIn(page);
  const mine = await openMenu(page, 'My gladiator');
  await expect(page.locator('p[role=alert]')).toContainText('could not be loaded');
  await expect(page.getByRole('button', { name: 'Create gladiator', exact: true })).toHaveCount(0);
  await expect(mine.getByRole('button', { name: 'Create your gladiator' })).toHaveCount(0);
  await expect(creationDialog(page)).toHaveCount(0);
  // A failed callback returns to the fixed camp route with a short message (plan Decision 6), never to `next`.
  await page.goto('/auth/callback/?code=invalid&next=https://example.invalid/');
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\/game\/$/);
  await expect(page.getByRole('status').filter({ hasText: 'Google sign-in could not be completed.' })).toBeVisible();
});

test('fragment OAuth errors are canceled safely and cannot display provider text', async ({ page, context }) => {
  // The callback returns to the live camp, whose public reads are answered here.
  await routeLiveReads(context, { world: emptyWorld() });
  await page.goto('/auth/callback/#error=access_denied&error_description=Untrusted%20fragment');
  await expect(page.getByRole('status').filter({ hasText: 'Google sign-in was canceled.' })).toBeVisible();
  await expect(page.getByText('Untrusted fragment')).toHaveCount(0);
  await expect(page).toHaveURL(/\/game\/$/);
});

test('account changes cannot reuse another account creation attempt', async ({ page, context }) => {
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  await creationDialog(page).getByLabel('Gladiator name').fill('Account Draft');
  await spendSuggestedPoints(page);
  flow.conflict(true);
  await page.getByRole('button', { name: 'Create gladiator', exact: true }).click();
  await expect(page.locator('p[role=alert]')).toContainText('name may already be taken');
  const firstId = flow.commands[0].operationId;
  await dismissAndSignOut(page);
  flow.switchAccount();
  await flow.signIn(page);
  await expect(creationDialog(page).getByLabel('Gladiator name')).toHaveValue('Account Draft');
  flow.conflict(false);
  await page.getByRole('button', { name: 'Create gladiator', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Account Draft', exact: true })).toBeVisible();
  expect(flow.commands[1].operationId).not.toBe(firstId);
  expect(await page.evaluate(() => localStorage.getItem('cloudiator.creation-draft.v1'))).toBeNull();
});

test('a slow no-character focus read cannot replace the confirmed creation owner', async ({ page, context }) => {
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  await creationDialog(page).getByLabel('Gladiator name').fill('Confirmed Fighter');
  await spendSuggestedPoints(page);
  await expect(page.getByRole('button', { name: 'Create gladiator', exact: true })).toBeEnabled();
  const held = flow.holdNextOwnerRead();
  // A tab return reads the owner only 2 s or more after the last read (final review Minor 5).
  await page.waitForTimeout(2_100);
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
