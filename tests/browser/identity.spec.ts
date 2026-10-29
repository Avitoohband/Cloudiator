import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Locator, type Page } from './fixtures';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands';
import { ownerFixture } from '../fixtures/domain';
import { emptyWorld, isPresence, routeLiveReads } from './live-routes';
import { chipToggle, cornerChip, creationDialog, joinButton, openMenu, signOutFromChip, spendSuggestedPoints } from './shell-helpers';

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
      expect(Object.keys(command).sort()).toEqual(['allocation', 'appearance', 'classId', 'kind', 'name', 'operationId']);
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
    commands, userId, characterCount: () => creationCount,
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
  // Task 7b: what a new gladiator starts with (shown in the preview once a class and the points are chosen) is said in gold.
  await expect(dialog).toContainText('Common sword · Light body armor · 100 gold · 0 renown');
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
  const capped = dialog.getByRole('status').filter({ hasText: /points? left, so|No points left|can take at most/ });
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
  const capped = dialog.getByRole('status').filter({ hasText: /points? left, so|No points left|can take at most/ });
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

test('caps a number typed one key at a time at what the field can take, as the capped line says', async ({ page, context }) => {
  // Fix round 1: with 7 left, "10" typed digit by digit passes through 1 (6 left) and still says 7, never "Only 6 points left".
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  const dialog = creationDialog(page);
  await expect(dialog).toBeVisible();
  const counter = dialog.getByRole('status').filter({ hasText: /of 10 left|All 10 spent/ });
  const capped = dialog.getByRole('status').filter({ hasText: /points? left, so|No points left|can take at most/ });
  const field = (name: string) => dialog.getByLabel(`${name} points`);
  const typeOver = async (name: string, keys: string[]) => {
    await field(name).focus();
    await field(name).selectText();
    for (const key of keys) await page.keyboard.press(key);
  };
  await field('Strength').fill('3');
  await expect(counter).toHaveText('7 of 10 left');
  // The first digit fits, the second passes the cap: 7 left at the start, so 7.
  await typeOver('Endurance', ['1']);
  await expect(field('Endurance')).toHaveValue('1');
  await expect(counter).toHaveText('6 of 10 left');
  await expect(capped).toHaveCount(0);
  await page.keyboard.press('0');
  await expect(field('Endurance')).toHaveValue('7');
  await expect(capped).toHaveText('Only 7 points left, so Endurance was set to 7.');
  await expect(counter).toHaveText('All 10 spent');
  // Final review fix (ruling R10): typed over a field that already holds points, it can take its own points plus those left
  // (2 + 5), and the line names that cap: only 5 were left, so "Only 7 points left" would be wrong.
  await dialog.getByRole('button', { name: 'Reset points', exact: true }).click();
  await field('Strength').fill('2');
  await field('Agility').fill('3');
  await expect(counter).toHaveText('5 of 10 left');
  await typeOver('Strength', ['9']);
  await expect(field('Strength')).toHaveValue('7');
  await expect(capped).toHaveText('Strength can take at most 7, so it was set to 7.');
  await expect(counter).toHaveText('All 10 spent');
  // The same, one key at a time over a field of 2 (it takes the focus holding 2): "1" fits (it holds 1, 6 left), "10" names
  // the cap of 7.
  await dialog.getByRole('button', { name: 'Reset points', exact: true }).click();
  await field('Agility').fill('2');
  await field('Vitality').fill('3');
  await expect(counter).toHaveText('5 of 10 left');
  await typeOver('Agility', ['1']);
  await expect(field('Agility')).toHaveValue('1');
  await expect(capped).toHaveCount(0);
  await page.keyboard.press('0');
  await expect(field('Agility')).toHaveValue('7');
  await expect(capped).toHaveText('Agility can take at most 7, so it was set to 7.');
  // Several digits at once, over a field of 0: the same line.
  await dialog.getByRole('button', { name: 'Reset points', exact: true }).click();
  await field('Strength').fill('3');
  await field('Precision').focus();
  await field('Precision').selectText();
  await field('Precision').pressSequentially('10');
  await expect(field('Precision')).toHaveValue('7');
  await expect(capped).toHaveText('Only 7 points left, so Precision was set to 7.');
});

test('a saved draft keeps its points, unless the counter could not show them', async ({ page, context }) => {
  // Fix round 1: a draft saved by the old form could hold a fraction or more than 10 points. Its name and class are kept and its
  // points start again at 0; a draft of 10 (the old 2-each) or fewer whole points keeps its values.
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  const dialog = creationDialog(page);
  await expect(dialog).toBeVisible();
  const create = dialog.getByRole('button', { name: 'Create gladiator', exact: true });
  const counter = dialog.getByRole('status').filter({ hasText: /of 10 left|All 10 spent/ });
  const names = ['Strength', 'Agility', 'Vitality', 'Endurance', 'Precision'];
  const keys = ['strength', 'agility', 'vitality', 'endurance', 'precision'] as const;
  const seed = async (allocation: Record<string, number>) => {
    await page.evaluate(draft => localStorage.setItem('cloudiator.creation-draft.v1', JSON.stringify(draft)),
      { version: 1, name: 'Seeded Fighter', classId: 'guardian', allocation });
    await page.reload();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Gladiator name')).toHaveValue('Seeded Fighter');
    await expect(dialog.getByLabel('Guardian', { exact: true })).toBeChecked();
  };
  const reset = [
    { what: 'a fraction in one field', allocation: { strength: 2.5, agility: 2, vitality: 2, endurance: 2, precision: 1.5 } },
    { what: 'a fraction with fewer than 10 in all', allocation: { strength: 2.5, agility: 0, vitality: 0, endurance: 0, precision: 0 } },
    { what: '11 points in all', allocation: { strength: 3, agility: 2, vitality: 2, endurance: 2, precision: 2 } },
    { what: '50 points in all', allocation: { strength: 10, agility: 10, vitality: 10, endurance: 10, precision: 10 } },
  ];
  for (const { what, allocation } of reset) {
    await seed(allocation);
    await expect(counter, what).toHaveText('10 of 10 left');
    for (const name of names) await expect(dialog.getByLabel(`${name} points`), what).toHaveValue('0');
    await expect(create, what).toBeDisabled();
  }
  const kept = [
    { what: '2 each (the old default)', allocation: { strength: 2, agility: 2, vitality: 2, endurance: 2, precision: 2 }, text: 'All 10 spent' },
    { what: 'all 10 on one attribute', allocation: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 10 }, text: 'All 10 spent' },
    { what: 'one whole point', allocation: { strength: 1, agility: 0, vitality: 0, endurance: 0, precision: 0 }, text: '9 of 10 left' },
  ];
  for (const { what, allocation, text } of kept) {
    await seed(allocation);
    await expect(counter, what).toHaveText(text);
    for (const [index, name] of names.entries()) await expect(dialog.getByLabel(`${name} points`), what).toHaveValue(String(allocation[keys[index]]));
    if (text === 'All 10 spent') await expect(create, what).toBeEnabled();
    else await expect(create, what).toBeDisabled();
  }
  expect(flow.commands).toHaveLength(0);
});

// ---------------------------------------------------------------------------------------------------------------------
// Choosing a look (gladiator appearance, Task 6): the "Choose a look" step after the name, with a live animated preview.
const DRAFT_KEY = 'cloudiator.creation-draft.v1';
const lookGroups = (dialog: Locator) => ({
  body: dialog.getByRole('group', { name: 'Body', exact: true }),
  hair: dialog.getByRole('group', { name: 'Hair', exact: true }),
  skin: dialog.getByRole('group', { name: /^Skin tone · / }),
  hairColour: dialog.getByRole('group', { name: /^Hair colour · / }),
  cloth: dialog.getByRole('group', { name: /^Clothes colour · / }),
});
const pressedIn = (group: Locator) => group.getByRole('button', { pressed: true });
/** The layers the preview draws, in order, with the tint of each (`null`: drawn as it is). */
const drawn = (dialog: Locator) => dialog.locator('[data-layer]').evaluateAll(els => els.map(el => [el.getAttribute('data-layer'), el.getAttribute('data-tint')]));
/** Every look control has exactly one choice pressed, so the dialog always shows one valid look. */
async function expectOneLook(dialog: Locator) {
  for (const group of Object.values(lookGroups(dialog))) await expect(pressedIn(group)).toHaveCount(1);
}
/**
 * The dialog's random generator pinned at 0.3 (the fixture build's `__cloudiatorLookRandom` hook; pinning Math.random itself breaks
 * Phaser): its random look is then male, long hair, Tan, Black hair, Purple clothes.
 */
const pinRandom = (page: Page) => page.addInitScript(() => { (window as unknown as { __cloudiatorLookRandom: () => number }).__cloudiatorLookRandom = () => 0.3; });
const PINNED_SUMMARY = 'Male, long hair, tan skin, black hair, purple clothes';
const readDraft = (page: Page) => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), DRAFT_KEY);

test('opens with a random valid look after the name and before the class, with a preview and a text summary', async ({ page, context }) => {
  await pinRandom(page);
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  const dialog = creationDialog(page);
  await expect(dialog).toBeVisible();
  const picker = dialog.getByRole('group', { name: 'Choose a look', exact: true });
  await expect(picker).toBeVisible();
  await expect(picker.getByText('Your look is set when you create your gladiator.', { exact: true })).toBeVisible();
  // The step sits between the name and the class.
  const top = async (locator: Locator) => (await locator.boundingBox())!.y;
  const nameTop = await top(dialog.getByLabel('Gladiator name')), lookTop = await top(picker), classTop = await top(dialog.getByRole('group', { name: 'Choose a class' }));
  expect(nameTop).toBeLessThan(lookTop);
  expect(lookTop).toBeLessThan(classTop);
  await expectOneLook(dialog);
  const groups = lookGroups(dialog);
  await expect(pressedIn(groups.body)).toHaveAccessibleName('Male');
  await expect(pressedIn(groups.hair)).toHaveAccessibleName('Long');
  await expect(pressedIn(groups.skin)).toHaveAccessibleName('Skin tone Tan');
  await expect(pressedIn(groups.hairColour)).toHaveAccessibleName('Hair colour Black');
  await expect(pressedIn(groups.cloth)).toHaveAccessibleName('Clothes colour Purple');
  // The buttons of each group.
  await expect(groups.body.getByRole('button')).toHaveText(['Male', 'Female']);
  await expect(groups.hair.getByRole('button')).toHaveText(['Short', 'Long', 'Ponytail', 'Bald']);
  await expect(groups.skin.getByRole('button')).toHaveCount(5);
  await expect(groups.hairColour.getByRole('button')).toHaveCount(6);
  await expect(groups.cloth.getByRole('button')).toHaveCount(12);
  // The decorative preview shows the look, and a visually hidden line says it for a screen reader.
  const preview = dialog.getByTestId('look-preview');
  await expect(preview).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(() => drawn(dialog)).toEqual([['body', '#eac3a0'], ['cloth', '#6a4fb8'], ['hair-long', '#2a2024'], ['accent', '#6a4fb8']]);
  await expect(dialog.getByTestId('look-summary')).toHaveText(PINNED_SUMMARY);
  await expect(dialog.getByTestId('look-summary')).toHaveAttribute('role', 'status');
  // The preview names the gladiator above it, as the game's name labels do.
  await expect(preview).toContainText('Your gladiator');
  await dialog.getByLabel('Gladiator name').fill('Preview Pat');
  await expect(preview).toContainText('Preview Pat');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('every control changes the look and the preview follows it', async ({ page, context }) => {
  await pinRandom(page);
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  const dialog = creationDialog(page);
  await expect(dialog).toBeVisible();
  const groups = lookGroups(dialog);
  const summary = dialog.getByTestId('look-summary');
  const press = (group: Locator, name: string) => group.getByRole('button', { name, exact: true }).click();
  // Female swaps in the female body and clothes; the labels name the current choice.
  await press(groups.body, 'Female');
  await expect(pressedIn(groups.body)).toHaveAccessibleName('Female');
  await expect.poll(() => drawn(dialog)).toEqual([['body-female', '#eac3a0'], ['cloth-female', '#6a4fb8'], ['hair-long', '#2a2024'], ['accent', '#6a4fb8']]);
  await press(groups.hair, 'Ponytail');
  await expect.poll(() => drawn(dialog)).toEqual([['body-female', '#eac3a0'], ['cloth-female', '#6a4fb8'], ['hair-ponytail', '#2a2024'], ['accent', '#6a4fb8']]);
  await press(groups.hair, 'Short');
  await expect.poll(() => drawn(dialog)).toEqual([['body-female', '#eac3a0'], ['cloth-female', '#6a4fb8'], ['hair', '#2a2024'], ['accent', '#6a4fb8']]);
  await press(groups.hair, 'Ponytail');
  // Each colour group: its label names the choice, its swatch is pressed, and the layers it tints change.
  await press(groups.skin, 'Skin tone Olive');
  await expect(dialog.getByRole('group', { name: 'Skin tone · Olive', exact: true })).toBeVisible();
  await press(groups.hairColour, 'Hair colour Red');
  await expect(dialog.getByRole('group', { name: 'Hair colour · Red', exact: true })).toBeVisible();
  await press(groups.cloth, 'Clothes colour Teal');
  await expect(dialog.getByRole('group', { name: 'Clothes colour · Teal', exact: true })).toBeVisible();
  await expect.poll(() => drawn(dialog)).toEqual([['body-female', '#cf9a74'], ['cloth-female', '#22a39d'], ['hair-ponytail', '#8a3324'], ['accent', '#22a39d']]);
  await expect(summary).toHaveText('Female, ponytail, olive skin, red hair, teal clothes');
  await expect(pressedIn(dialog.getByRole('group', { name: 'Skin tone · Olive', exact: true }))).toHaveCount(1);
  // Bald draws no hair, and the hair colour stays selectable (it is kept).
  await press(groups.hair, 'Bald');
  await expect.poll(() => drawn(dialog)).toEqual([['body-female', '#cf9a74'], ['cloth-female', '#22a39d'], ['accent', '#22a39d']]);
  await expect(summary).toHaveText('Female, bald, olive skin, teal clothes');
  await expect(groups.hairColour.getByRole('button').first()).toBeEnabled();
  await press(groups.hairColour, 'Hair colour Blond');
  await expect(pressedIn(groups.hairColour)).toHaveAccessibleName('Hair colour Blond');
  await press(groups.hair, 'Long');
  await expect.poll(() => drawn(dialog)).toEqual([['body-female', '#cf9a74'], ['cloth-female', '#22a39d'], ['hair-long', '#e6c06a'], ['accent', '#22a39d']]);
  await expectOneLook(dialog);
});

test('the Tab key never leaves the focus under the sticky Not now and Create bar', async ({ page, context }) => {
  // Final review item 5: the dialog scrolls under its sticky action bar, so each control the Tab key reaches is scrolled clear of
  // the bar, not left in its band at the foot of the dialog. A short screen makes the dialog scroll.
  await page.setViewportSize({ width: 360, height: 640 });
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  const dialog = creationDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Gladiator name').focus();
  const reached: string[] = [];
  for (let step = 0; step < 80; step++) {
    const at = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const box = el.closest('dialog')!;
      let bar = [...box.querySelectorAll('button')].find(b => b.textContent === 'Not now') as HTMLElement | null;
      while (bar && getComputedStyle(bar).position !== 'sticky') bar = bar.parentElement;
      const rect = el.getBoundingClientRect();
      return { name: el.getAttribute('aria-label') || el.textContent?.trim() || el.id, inBar: !!bar?.contains(el), bottom: rect.bottom, top: rect.top,
        barTop: bar!.getBoundingClientRect().top, boxTop: box.getBoundingClientRect().top, scrolls: box.scrollHeight > box.clientHeight };
    });
    expect(at.scrolls, 'the dialog scrolls at 360 × 640').toBe(true);
    if (at.inBar) break;
    reached.push(at.name);
    expect(at.bottom, `${at.name} is under the action bar`).toBeLessThanOrEqual(at.barTop + 0.5);
    expect(at.top, `${at.name} is above the dialog`).toBeGreaterThanOrEqual(at.boxTop - 0.5);
    await page.keyboard.press('Tab');
  }
  // Every look control, the class, the shortcuts and the points were reached before the bar.
  expect(reached).toEqual(expect.arrayContaining(['Female', 'Bald', 'Random look', 'Skin tone Deep brown', 'Hair colour Red', 'Clothes colour Sky',
    'Reset points', 'Add a point to Precision']));
  expect(flow.commands).toHaveLength(0);
});

test('Random look rolls another valid look, and the choice is kept in the draft', async ({ page, context }) => {
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  const dialog = creationDialog(page);
  await expect(dialog).toBeVisible();
  const summary = dialog.getByTestId('look-summary');
  const roll = dialog.getByRole('button', { name: 'Random look', exact: true });
  await expectOneLook(dialog);
  const seen = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const before = await summary.textContent();
    await roll.click();
    await expectOneLook(dialog);
    await expect(summary).not.toHaveText(before!);
    seen.add((await summary.textContent())!);
  }
  expect(seen.size).toBeGreaterThan(3);
  // The rolled look is what the draft holds (version 2), and it comes back after a reload.
  const draft = await readDraft(page);
  expect(draft.version).toBe(2);
  expect(Object.keys(draft.appearance).sort()).toEqual(['body', 'cloth', 'hair', 'hairColor', 'skin']);
  const text = await summary.textContent();
  await page.reload();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('look-summary')).toHaveText(text!);
});

test('opening the dialog again shows the look it first opened with, though nothing was edited', async ({ page, context }) => {
  // Final review item 4: the dialog is mounted afresh each time it opens, so the random look it opens with is saved at once.
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  const dialog = creationDialog(page);
  await expect(dialog).toBeVisible();
  await expectOneLook(dialog);
  const summary = dialog.getByTestId('look-summary');
  const opened = (await summary.textContent())!;
  const layers = await drawn(dialog);
  const offer = cornerChip(page).getByRole('button', { name: 'Create your gladiator', exact: true });
  // Not now, then the chip; Escape, then My gladiator; then a reload. The same look every time, and the draft holds it.
  await dialog.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(dialog).toBeHidden();
  await offer.click();
  await expect(dialog).toBeVisible();
  await expect(summary).toHaveText(opened);
  expect(await drawn(dialog)).toEqual(layers);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const mine = await openMenu(page, 'My gladiator');
  await mine.getByRole('button', { name: 'Create your gladiator', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(summary).toHaveText(opened);
  await page.reload();
  await expect(dialog).toBeVisible();
  await expect(summary).toHaveText(opened);
  expect(await drawn(dialog)).toEqual(layers);
  expect(await readDraft(page)).toMatchObject({ version: 2, name: '', classId: 'berserker' });
  expect(flow.commands).toHaveLength(0);
});

test('Create sends exactly the chosen look, and no other key changes', async ({ page, context }) => {
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  const dialog = creationDialog(page);
  await expect(dialog).toBeVisible();
  const groups = lookGroups(dialog);
  const press = (group: Locator, name: string) => group.getByRole('button', { name, exact: true }).click();
  await press(groups.body, 'Female');
  await press(groups.hair, 'Long');
  await press(groups.skin, 'Skin tone Brown');
  await press(groups.hairColour, 'Hair colour Auburn');
  await press(groups.cloth, 'Clothes colour Rose');
  await dialog.getByLabel('Gladiator name').fill('Look Fighter');
  await dialog.getByLabel('Duelist', { exact: true }).check();
  await spendSuggestedPoints(page);
  await dialog.getByRole('button', { name: 'Create gladiator', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Look Fighter', exact: true })).toBeVisible();
  expect(flow.commands).toHaveLength(1);
  const command = flow.commands[0] as Extract<GameCommand, { kind: 'create-character' }>;
  expect(command.appearance).toEqual({ body: 'female', hair: 'long', skin: 3, hairColor: 2, cloth: 10 });
  expect(Object.keys(command.appearance!).sort()).toEqual(['body', 'cloth', 'hair', 'hairColor', 'skin']);
  expect(command).toMatchObject({ kind: 'create-character', name: 'Look Fighter', classId: 'duelist' });
  // The draft is gone once the gladiator exists.
  expect(await readDraft(page)).toBeNull();
});

test('a lost response retries the same command with the same look', async ({ page, context }) => {
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  const dialog = creationDialog(page);
  await dialog.getByLabel('Gladiator name').fill('Retry Look');
  await dialog.getByRole('group', { name: 'Body', exact: true }).getByRole('button', { name: 'Female', exact: true }).click();
  await spendSuggestedPoints(page);
  flow.loseNextResponse();
  await dialog.getByRole('button', { name: 'Create gladiator', exact: true }).click();
  await expect(page.locator('p[role=alert]')).toContainText('could not be confirmed');
  // The look cannot change under the saved attempt: it is part of what was sent. Retrying replays it.
  await dialog.getByRole('button', { name: 'Create gladiator', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Retry Look', exact: true })).toBeVisible();
  expect(flow.commands).toHaveLength(2);
  expect(flow.commands[1]).toEqual(flow.commands[0]);
  expect((flow.commands[0] as Extract<GameCommand, { kind: 'create-character' }>).appearance?.body).toBe('female');
});

test('a draft keeps its look: version 2 restores it, version 1 gets a random look and keeps name, class and points', async ({ page, context }) => {
  await pinRandom(page);
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  const dialog = creationDialog(page);
  await expect(dialog).toBeVisible();
  const groups = lookGroups(dialog);
  const seed = async (draft: unknown) => {
    await page.evaluate(([key, value]) => localStorage.setItem(key as string, JSON.stringify(value)), [DRAFT_KEY, draft]);
    await page.reload();
    await expect(dialog).toBeVisible();
  };
  const split = { strength: 2, agility: 4, vitality: 0, endurance: 0, precision: 4 };
  // Version 1 (before the look could be chosen): name, class and points stay; the look is the (pinned) random one.
  await seed({ version: 1, name: 'Old Draft', classId: 'duelist', allocation: split });
  await expect(dialog.getByLabel('Gladiator name')).toHaveValue('Old Draft');
  await expect(dialog.getByLabel('Duelist', { exact: true })).toBeChecked();
  await expect(dialog.getByLabel('Agility points')).toHaveValue('4');
  await expect(dialog.getByRole('status').filter({ hasText: 'All 10 spent' })).toBeVisible();
  await expectOneLook(dialog);
  await expect(dialog.getByTestId('look-summary')).toHaveText(PINNED_SUMMARY);
  // An edit saves it again as version 2, with the look that is shown.
  await dialog.getByLabel('Gladiator name').fill('Old Draft 2');
  const saved = await readDraft(page);
  expect(saved).toMatchObject({ version: 2, name: 'Old Draft 2', classId: 'duelist', appearance: { body: 'male', hair: 'long', skin: 1, hairColor: 1, cloth: 3 } });
  // Version 2 keeps the chosen look, whatever the random one would be.
  const chosen = { body: 'female', hair: 'ponytail', skin: 4, hairColor: 5, cloth: 11 };
  await seed({ version: 2, name: 'New Draft', classId: 'guardian', allocation: split, appearance: chosen });
  await expect(dialog.getByLabel('Gladiator name')).toHaveValue('New Draft');
  await expect(dialog.getByLabel('Guardian', { exact: true })).toBeChecked();
  await expect(pressedIn(groups.body)).toHaveAccessibleName('Female');
  await expect(pressedIn(groups.hair)).toHaveAccessibleName('Ponytail');
  await expect(pressedIn(groups.skin)).toHaveAccessibleName('Skin tone Deep brown');
  await expect(pressedIn(groups.hairColour)).toHaveAccessibleName('Hair colour Red');
  await expect(pressedIn(groups.cloth)).toHaveAccessibleName('Clothes colour Sky');
  // A damaged look in a version-2 draft is replaced by the random one; the rest of the draft stays.
  for (const appearance of [{ ...chosen, skin: 9 }, { ...chosen, hair: 'mohawk' }, { ...chosen, extra: 1 }, 'female', null]) {
    await seed({ version: 2, name: 'Damaged Look', classId: 'berserker', allocation: split, appearance });
    await expect(dialog.getByLabel('Gladiator name')).toHaveValue('Damaged Look');
    await expect(dialog.getByTestId('look-summary')).toHaveText(PINNED_SUMMARY);
  }
  expect(flow.commands).toHaveLength(0);
});

test('a version-1 draft that was sent before the look existed starts a new attempt with the look shown', async ({ page, context }) => {
  // The old build saved the command it sent (no look) so a retry could replay it. This build's retry carries the shown look, so the
  // old attempt is dropped: a new operation id; if the first one had reached the server the account already has a gladiator, which
  // the dialog already handles (it reads the owner).
  await pinRandom(page);
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  const dialog = creationDialog(page);
  await expect(dialog).toBeVisible();
  const allocation = { strength: 2, agility: 4, vitality: 0, endurance: 0, precision: 4 };
  const old = { kind: 'create-character', operationId: randomUUID(), name: 'Sent Before', classId: 'duelist', allocation };
  await page.evaluate(([key, draft]) => localStorage.setItem(key as string, JSON.stringify(draft)),
    [DRAFT_KEY, { version: 1, name: 'Sent Before', classId: 'duelist', allocation, attempt: { account: flow.userId, command: old } }]);
  await page.reload();
  await expect(dialog.getByLabel('Gladiator name')).toHaveValue('Sent Before');
  await dialog.getByRole('button', { name: 'Create gladiator', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sent Before', exact: true })).toBeVisible();
  const sent = flow.commands[0] as Extract<GameCommand, { kind: 'create-character' }>;
  expect(sent.operationId).not.toBe(old.operationId);
  expect(sent.appearance).toEqual({ body: 'male', hair: 'long', skin: 1, hairColor: 1, cloth: 3 });
});

test('the preview idles through four frames, and shows one still frame when motion is reduced', async ({ page, context }) => {
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  const preview = creationDialog(page).getByTestId('look-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute('data-motion', 'animated');
  const frames = new Set<string>();
  await expect.poll(async () => { frames.add((await preview.getAttribute('data-frame'))!); return frames.size; }, { intervals: [60], timeout: 5_000 }).toBe(4);
  expect([...frames].sort()).toEqual(['0', '1', '2', '3']);
  // Reduced motion: the first frame stays.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(preview).toHaveAttribute('data-motion', 'still');
  await expect(preview).toHaveAttribute('data-frame', '0');
  await page.waitForTimeout(1200);
  await expect(preview).toHaveAttribute('data-frame', '0');
  // And it starts again when the preference is turned off.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(preview).toHaveAttribute('data-motion', 'animated');
  await expect.poll(async () => preview.getAttribute('data-frame'), { intervals: [60], timeout: 3_000 }).not.toBe('0');
});

test('a reduced-motion visitor opens the dialog with the still frame from the start', async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  const preview = creationDialog(page).getByTestId('look-preview');
  await expect(preview).toHaveAttribute('data-motion', 'still');
  await page.waitForTimeout(1200);
  await expect(preview).toHaveAttribute('data-frame', '0');
});

test('the preview draws pixel art: a cropped atlas frame, multiplied by its tint, kept to the art by a mask', async ({ page, context }) => {
  await pinRandom(page);
  const flow = await identityFlow(context);
  await page.goto('/game/');
  await flow.signIn(page);
  const dialog = creationDialog(page);
  await expect(dialog.locator('[data-layer]')).toHaveCount(4);
  const style = await dialog.locator('[data-layer="body"]').evaluate(el => {
    const css = getComputedStyle(el);
    return { rendering: css.imageRendering, blend: css.backgroundBlendMode, width: el.getBoundingClientRect().width, image: css.backgroundImage,
      mask: css.maskImage || css.webkitMaskImage };
  });
  expect(style.rendering).toBe('pixelated');
  expect(style.blend).toBe('multiply');
  expect(style.width).toBe(192);
  // The atlas image the manifest names, by its content (final review F1), and it loads.
  const image = (JSON.parse(readFileSync('public/assets/manifest.json', 'utf8')) as { atlases: { gladiators: { image: string } } }).atlases.gladiators.image;
  expect(image).toMatch(/^actors\/gladiators\.[0-9a-f]{10}\.png$/);
  expect(style.image).toContain(`/assets/${image}`);
  expect(style.mask).toContain(`/assets/${image}`);
  expect((await page.request.get(`/assets/${image}`)).status()).toBe(200);
  // The sash is tinted by the clothes colour, as in the camp (the manifest's tint key of the accent layer).
  await expect(dialog.locator('[data-layer="accent"]')).toHaveAttribute('data-tint', '#6a4fb8');
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
