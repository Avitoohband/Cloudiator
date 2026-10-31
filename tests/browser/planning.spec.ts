import { test, expect, type BrowserContext, type Locator, type Page } from './fixtures';
import { randomUUID } from 'node:crypto';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1';
import { itemFixture, ownerFixture } from '../fixtures/domain';
import type { GameCommand, Phase } from '../../supabase/functions/_shared/contracts/commands';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads';
import { SLOT_MS, emptyWorld, isPresence, routeLiveReads } from './live-routes';
import { reviewShot, reviewShot360 } from './review-shots';
import { openMenu } from './shell-helpers';
import { expectTimeOnOneLine, slotTime, storeClock } from './slot-time';
import { contrastIssues, expectPointsFit, focusDrops, focusedElement, noHorizontalScroll, watchFocus } from './a11y-helpers';

async function planningFlow(context: BrowserContext, setup?: (state: OwnerState) => void) {
  let state = structuredClone(ownerFixture);
  state.wallets.money = 300;
  setup?.(state);
  state.processedSlotIndex = Math.floor(Date.now() / 4_800_000);
  const commands: GameCommand[] = [];
  let lose = false, processing = false, conflict = false, scheduleConflict = false;
  /** The server time the day command is received at (the part running then is the one a change to waits out); null is the real time. */
  let receivedAt: number | null = null;
  const receipts = new Map<string, unknown>();
  const user = { id: randomUUID(), aud: 'authenticated', role: 'authenticated', email: 'planning@example.invalid',
    app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: {}, identities: [], created_at: new Date().toISOString() };
  await context.addInitScript(({ user }) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = `${btoa(JSON.stringify({ alg: 'HS256' }))}.${btoa(JSON.stringify({ sub: user.id, exp }))}.test-only`;
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: token, refresh_token: 'test-only', token_type: 'bearer', expires_at: exp, expires_in: 3600, user }));
  }, { user });
  // The live camp's public reads; this spec's own handler (registered next, so it runs first) hands it everything else.
  const publicReads = await routeLiveReads(context, { world: emptyWorld() });
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
      // Another session changed the afternoon first: the saved schedule is a new version the command's expected version does not match.
      if (scheduleConflict && command.kind === 'edit-day-schedule') { scheduleConflict = false; state.scheduleVersion++; state.schedule.afternoon = { kind: 'rest' }; return json({ ok: false, code: 'conflict' }, 409); }
      let result = receipts.get(command.operationId);
      if (!result) {
        if (command.kind === 'queue-build') {
          // As the server does since the fixed class and points release: the class and every attribute are fixed at the current
          // build's (a pending build may be revised down to it, not below), and every allowed change is free.
          const current = state.currentBuild;
          if (command.classId !== current.classId || (Object.keys(current.allocations) as (keyof typeof current.allocations)[]).some(key => command.allocation[key] < current.allocations[key])) {
            return json({ ok: false, code: 'invalid' }, 409);
          }
          state.buildVersion++;
          state.pendingBuild = { build: { version: state.buildVersion, classId: command.classId, stance: command.stance, allocations: command.allocation, equipment: command.equipment },
            effectiveSlotIndex: state.processedSlotIndex + 1, reservedMoney: 0, reservedItemIds: [], operationId: command.operationId };
          result = { ok: true, receiptId: randomUUID(), value: state.pendingBuild };
        } else if (command.kind === 'cancel-build') {
          state.buildVersion++; state.pendingBuild = null;
          result = { ok: true, receiptId: randomUUID(), value: { buildVersion: state.buildVersion } };
        } else if (command.kind === 'edit-day-schedule') {
          if (command.expectedVersion !== state.scheduleVersion) return json({ ok: false, code: 'conflict' }, 409);
          const at = receivedAt ?? Date.now(), current = Math.floor(at / SLOT_MS);
          const parts: Record<Phase, { effectiveSlotIndex: number; effectiveAtMs: number } | null> = { morning: null, afternoon: null, evening: null };
          (['morning', 'afternoon', 'evening'] as const).forEach((phase, index) => {
            if (JSON.stringify(state.schedule[phase]) === JSON.stringify(command.day[phase])) return;
            // Written apart from the panel: slot n is phase n mod 3, and a change starts with the part's next occurrence (three slots on for the running part).
            const effectiveSlotIndex = current + (((index - (current % 3) + 3) % 3) || 3);
            parts[phase] = { effectiveSlotIndex, effectiveAtMs: effectiveSlotIndex * SLOT_MS };
            state.schedule[phase] = command.day[phase];
          });
          state.scheduleVersion++;
          result = { ok: true, receiptId: randomUUID(), value: { version: state.scheduleVersion, receivedAtMs: at, parts } };
        } else throw new Error('Unexpected planning command');
        receipts.set(command.operationId, result);
      }
      if (lose) { lose = false; return route.abort('failed'); }
      return json(result);
    }
    return route.fallback();
  });
  return { commands, processedSlotIndex: state.processedSlotIndex, loseNext: () => { lose = true; }, processing: (value: boolean) => { processing = value; }, conflictNext: () => { conflict = true; },
    scheduleConflictNext: () => { scheduleConflict = true; }, receivedAt: (ms: number | null) => { receivedAt = ms; }, state: () => state,
    publish: () => publicReads.setWorld({ ...emptyWorld(), revision: randomUUID() }) };
}

test.beforeEach(() => { test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Live UI uses development-only intercepted identity transport.'); });

/** The shared display clock's time in the page. */
const clockNow = (page: Page) => page.evaluate(() => window.__cloudiatorShell!.clock.now());

test('queues, confirms and cancels pending builds without optimistic current replacement', async ({ page, context }, testInfo) => {
  const flow = await planningFlow(context);
  await page.goto('/game/');
  await openMenu(page, 'My gladiator');
  await expect(page.getByRole('heading', { name: 'Current build', exact: true })).toBeVisible();
  // Task 7b: the currency is said as gold, and the data's 300 `money` is that amount.
  await expect(page.getByText('Available gold: 300. Reserved fees remain in your wallet until activation.')).toBeVisible();
  // The class is fixed, so the change to queue is the stance, and every build change is free: no reservation is estimated.
  await page.getByLabel('Stance', { exact: true }).selectOption('offensive');
  await expect(page.getByText(/^Estimated reservation/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Queue build' }).click();
  await expect(page.getByRole('heading', { name: 'Pending build', exact: true })).toBeVisible();
  await expect(page.getByTestId('current-build')).toContainText('balanced');
  await expect(page.getByTestId('pending-build')).toContainText('offensive');
  await expect(page.getByTestId('pending-build')).toContainText('Reserved: 0 gold');
  // The effective time is the next boundary, as a short local time (Task 23.10), shown against the display clock.
  const effective = page.getByTestId('pending-build').getByText(/^Effective /);
  await expect(effective).toHaveText(`Effective ${await slotTime(page, (flow.processedSlotIndex + 1) * SLOT_MS, await clockNow(page))}`);
  await expect(effective).not.toContainText(/\d:\d\d:\d\d|\d\/\d/);
  await expectTimeOnOneLine(page, effective, 'the pending build\'s effective time');
  await reviewShot360(page, testInfo, 'planning-build-effective', effective);
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
  await page.getByLabel('Stance', { exact: true }).selectOption('offensive');
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

// ---- The build step: points left, capped, class fixed (Avi, 2026-10-28) -------------------------------------------------------

/** A Berserker who levelled up: 12 points earned, 9 spent (strength 4, agility 2, and 1 in each of the others), so 3 are left. */
const levelled = (state: OwnerState) => {
  state.currentBuild = { ...state.currentBuild, classId: 'berserker', allocations: { strength: 4, agility: 2, vitality: 1, endurance: 1, precision: 1 } };
  state.progression = { ...state.progression, level: 2, earnedAttributePoints: 12, unspentAttributePoints: 3 };
};
const points = (page: Page, name: string) => page.getByRole('spinbutton', { name, exact: true });
const spentNote = "Adding points is free. Points can't be taken back once this build takes effect, and your class is fixed. Respec and class changes will come later as paid options.";

test('shows the points left, caps a typed number and never goes below the saved build', async ({ page, context }, testInfo) => {
  const flow = await planningFlow(context, levelled);
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');
  const build = mine.locator('.planning-form');
  const strength = points(page, 'strength'), agility = points(page, 'agility');
  // The class is shown, not chosen, and the old fee lines are gone: every build change is free.
  await expect(build.getByText('Class: Berserker', { exact: true })).toBeVisible();
  await expect(mine.getByLabel('Class', { exact: true })).toHaveCount(0);
  await expect(mine.getByRole('combobox', { name: /class/i })).toHaveCount(0);
  await expect(mine.getByText(/^Estimated reservation/)).toHaveCount(0);
  await expect(mine.getByText(/Decreasing any current allocation/)).toHaveCount(0);
  await expect(build.getByText(spentNote, { exact: true })).toBeVisible();
  // 12 earned, 9 spent: 3 left. Each field stops at its own value plus what is left, and at the saved build's value below.
  await expect(build.getByText('3 of 12 left', { exact: true })).toBeVisible();
  await expect(strength).toHaveAttribute('min', '4');
  await expect(strength).toHaveAttribute('max', '7');
  await expect(agility).toHaveAttribute('min', '2');
  await expect(agility).toHaveAttribute('max', '5');
  // Typing below the saved value raises it back when the field is left (Tab), with the line that says why.
  await strength.fill('0');
  await page.keyboard.press('Tab');
  await expect(strength).toHaveValue('4');
  await expect(build.getByText("Strength can't go below 4: added points are permanent.", { exact: true })).toBeVisible();
  await expect(build.getByText('3 of 12 left', { exact: true })).toBeVisible();
  // Typing more than is left is capped at the field's value plus what is left, with the creation dialog's line.
  await strength.fill('99');
  await page.keyboard.press('Tab');
  await expect(strength).toHaveValue('7');
  await expect(build.getByText('Strength can take at most 7, so it was set to 7.', { exact: true })).toBeVisible();
  await expect(build.getByText("Strength can't go below 4", { exact: false })).toHaveCount(0);
  await expect(build.getByText('All 12 spent', { exact: true })).toBeVisible();
  await expect(build.getByText(/of 12 left/)).toHaveCount(0);
  await expect(strength).toHaveAttribute('max', '7');
  await expect(agility).toHaveAttribute('max', '2');
  // Nothing is left to add.
  await agility.fill('9');
  await page.keyboard.press('Tab');
  await expect(agility).toHaveValue('2');
  await expect(build.getByText('No points left to add, so Agility stays at 2.', { exact: true })).toBeVisible();
  // For Avi's visual review (the panel scrolls, so viewport shots): the class, the counter and the points; then the status line and the note.
  await build.getByText('Class: Berserker', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('build-points-top.png') });
  await build.getByText(spentNote, { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('build-points-note.png') });
  // Giving back points added in this draft is free, down to the saved value; the points come back to the counter.
  await strength.fill('5');
  await expect(build.getByText('2 of 12 left', { exact: true })).toBeVisible();
  await expect(build.getByText(/can take at most|can't go below|No points left/)).toHaveCount(0);
  await strength.fill('7');
  await mine.getByLabel('Stance', { exact: true }).selectOption('defensive');
  // Queue build sends the current class, the typed points and the stance, and the server (as faked) takes it.
  await page.getByRole('button', { name: 'Queue build' }).click();
  await expect(page.getByRole('heading', { name: 'Pending build', exact: true })).toBeVisible();
  expect(flow.commands).toHaveLength(1);
  expect(flow.commands[0]).toMatchObject({ kind: 'queue-build', classId: 'berserker', stance: 'defensive',
    allocation: { strength: 7, agility: 2, vitality: 1, endurance: 1, precision: 1 } });
  await expect(build.getByText('All 12 spent', { exact: true })).toBeVisible();
  // The floor is the CURRENT build's: the pending build can be revised down to it, and no lower.
  await strength.fill('1');
  await page.keyboard.press('Tab');
  await expect(strength).toHaveValue('4');
  await expect(build.getByText("Strength can't go below 4: added points are permanent.", { exact: true })).toBeVisible();
  await expect(build.getByText('3 of 12 left', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

// ---- Points on a phone (Avi, 2026-10-29, production hotfix) ----------------------------------------------------------------------
// "People can't add points. When they write any number, it automatically reset to max." Every keystroke was applied at once, so a
// phone's caret after the 4 made 45 (capped to 7), and Backspace was raised straight back to the floor. Now a tap or click selects
// the whole value, an empty or out-of-range field waits for Tab or Enter, and −, +1 and +5 sit beside every field.

/** Puts the focus in a field the way the project's player does: a tap on the phone, a click on the desktop. */
const press = (testInfo: { project: { name: string } }, field: ReturnType<typeof points>) => testInfo.project.name === 'mobile' ? field.tap() : field.click();

test('types over a build point after a tap or click, waits for Tab out of range, and steps by 1 and 5', async ({ page, context }, testInfo) => {
  const flow = await planningFlow(context, levelled);
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');
  const build = mine.locator('.planning-form');
  const strength = points(page, 'strength');
  const counter = build.getByRole('status').filter({ hasText: /of 12 left|All 12 spent/ });
  const lines = build.getByText(/can take at most|can't go below|No points left/);
  const add = build.getByRole('button', { name: 'Add a point to Strength', exact: true });
  const addFive = build.getByRole('button', { name: 'Add 5 points to Strength', exact: true });
  await expect(counter).toHaveText('3 of 12 left');
  // 1. The tap (or click) selects the 4, so the 5 replaces it and is applied at once.
  await press(testInfo, strength);
  await page.keyboard.type('5');
  await expect(strength).toHaveValue('5');
  await expect(counter).toHaveText('2 of 12 left');
  // 2. An emptied field stays empty and changes nothing; the next digit is applied.
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await expect(strength).toHaveValue('');
  await expect(counter).toHaveText('2 of 12 left');
  await page.keyboard.type('6');
  await expect(strength).toHaveValue('6');
  await expect(counter).toHaveText('1 of 12 left');
  // 3. Above the cap it stays as typed until Tab, then takes the cap with the capped line.
  await page.keyboard.press('Backspace');
  await page.keyboard.type('9');
  await expect(strength).toHaveValue('9');
  await expect(counter).toHaveText('1 of 12 left');
  await expect(lines).toHaveCount(0);
  await reviewShot(page, testInfo, 'points-build-typing');
  await page.keyboard.press('Tab');
  await expect(strength).toHaveValue('7');
  await expect(build.getByText('Strength can take at most 7, so it was set to 7.', { exact: true })).toBeVisible();
  await expect(counter).toHaveText('All 12 spent');
  // 4. Below the floor it waits too, then is raised with its line.
  await strength.fill('1');
  await expect(strength).toHaveValue('1');
  await expect(counter).toHaveText('All 12 spent');
  await page.keyboard.press('Tab');
  await expect(strength).toHaveValue('4');
  await expect(build.getByText("Strength can't go below 4: added points are permanent.", { exact: true })).toBeVisible();
  await expect(counter).toHaveText('3 of 12 left');
  // An emptied field shows its value again on Tab, with no change and no line.
  await strength.fill('');
  await expect(strength).toHaveValue('');
  await page.keyboard.press('Tab');
  await expect(strength).toHaveValue('4');
  await expect(counter).toHaveText('3 of 12 left');
  // 5. +1 adds one; +5 with 2 left stops at the cap with no capped line (the counter says it), and both then stop.
  await add.click();
  await expect(strength).toHaveValue('5');
  await expect(counter).toHaveText('2 of 12 left');
  await addFive.click();
  await expect(strength).toHaveValue('7');
  await expect(counter).toHaveText('All 12 spent');
  await expect(lines).toHaveCount(0);
  await expect(add).toHaveAttribute('aria-disabled', 'true');
  await expect(addFive).toHaveAttribute('aria-disabled', 'true');
  await expect(build.getByRole('button', { name: 'Add 5 points to Agility', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await addFive.click({ force: true });
  await expect(strength).toHaveValue('7');
  await expect(lines).toHaveCount(0);
  // 6. No − in the build step: points can't be taken back, respec comes later as a paid option (Avi, change round 1). Typing still
  // fixes an unqueued +5, down to the saved 4.
  await expect(build.getByRole('button', { name: /^Remove a point from/ })).toHaveCount(0);
  await strength.fill('4');
  await page.keyboard.press('Tab');
  await expect(strength).toHaveValue('4');
  await expect(counter).toHaveText('3 of 12 left');
  await expect(lines).toHaveCount(0);
  await expect(add).not.toHaveAttribute('aria-disabled', 'true');
  // Enter commits a waiting number and does not queue the build; ArrowUp still steps.
  await strength.fill('99');
  await page.keyboard.press('Enter');
  await expect(strength).toHaveValue('7');
  await expect(build.getByText('Strength can take at most 7, so it was set to 7.', { exact: true })).toBeVisible();
  await expect(strength).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(strength).toHaveValue('6');
  await expect(counter).toHaveText('1 of 12 left');
  await page.keyboard.press('ArrowUp');
  await expect(strength).toHaveValue('7');
  expect(flow.commands).toHaveLength(0);
});

// Fix round 2 (review Minor 1): a waiting number is corrected when the field loses the focus. The press that took the focus away is
// skipped once, so one tap never both corrects the number and queues the build or adds a point: the player reads the line first.
test('skips the Queue build press that corrected a waiting number, so its line is read first', async ({ page, context }, testInfo) => {
  const flow = await planningFlow(context, levelled);
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');
  const build = mine.locator('.planning-form');
  const strength = points(page, 'strength');
  const queue = page.getByRole('button', { name: 'Queue build', exact: true });
  await press(testInfo, strength);
  await page.keyboard.type('9');
  await expect(strength).toHaveValue('9');
  await (testInfo.project.name === 'mobile' ? queue.tap() : queue.click());
  await expect(strength).toHaveValue('7');
  await expect(build.getByText('Strength can take at most 7, so it was set to 7.', { exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  expect(flow.commands).toHaveLength(0);
  await expect(page.getByRole('heading', { name: 'Pending build', exact: true })).toHaveCount(0);
  // The next press acts.
  await (testInfo.project.name === 'mobile' ? queue.tap() : queue.click());
  await expect(page.getByRole('heading', { name: 'Pending build', exact: true })).toBeVisible();
  expect(flow.commands).toHaveLength(1);
  expect(flow.commands[0]).toMatchObject({ kind: 'queue-build', allocation: { strength: 7 } });
});

test('skips the +1 press that corrected a waiting number; the next press acts', async ({ page, context }, testInfo) => {
  const flow = await planningFlow(context, levelled);
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');
  const build = mine.locator('.planning-form');
  const strength = points(page, 'strength');
  const add = build.getByRole('button', { name: 'Add a point to Strength', exact: true });
  const tap = (locator: typeof add) => testInfo.project.name === 'mobile' ? locator.tap() : locator.click();
  const raised = build.getByText("Strength can't go below 4: added points are permanent.", { exact: true });
  // Below the floor: the +1 press raises the 1 to 4 and is skipped, so the raised line stays; the next +1 adds one.
  await press(testInfo, strength);
  await page.keyboard.type('1');
  await tap(add);
  await expect(strength).toHaveValue('4');
  await expect(raised).toBeVisible();
  await page.waitForTimeout(300);
  await expect(strength).toHaveValue('4');
  await expect(raised).toBeVisible();
  await tap(add);
  await expect(strength).toHaveValue('5');
  await expect(raised).toHaveCount(0);
  // Over the cap: the +1 press caps the 9 at 7 with its line; another +1 does nothing at the cap and adds no line of its own.
  await press(testInfo, strength);
  await page.keyboard.type('9');
  await tap(add);
  await expect(strength).toHaveValue('7');
  const capped = build.getByText(/can take at most|can't go below|No points left/);
  await expect(capped).toHaveText('Strength can take at most 7, so it was set to 7.');
  await add.click({ force: true });
  await expect(strength).toHaveValue('7');
  await expect(capped).toHaveText('Strength can take at most 7, so it was set to 7.');
  expect(flow.commands).toHaveLength(0);
});

test('Enter with an applied number still queues the build', async ({ page, context }, testInfo) => {
  // The other half of the Enter rule: Enter takes only a waiting number; an applied one sends the form as before.
  const flow = await planningFlow(context, levelled);
  await page.goto('/game/');
  await openMenu(page, 'My gladiator');
  const strength = points(page, 'strength');
  await press(testInfo, strength);
  await page.keyboard.type('5');
  await expect(strength).toHaveValue('5');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Pending build', exact: true })).toBeVisible();
  expect(flow.commands).toHaveLength(1);
  expect(flow.commands[0]).toMatchObject({ kind: 'queue-build', allocation: { strength: 5 } });
});

test('a press dragged out of a points field leaves no stale selection for the next click', async ({ page, context }, testInfo) => {
  // Fix round 2 (review Minor 3): the press that focuses a field selects its value on release. Released outside the field, it must
  // not select the value at the next click inside the still focused field: that click places the caret.
  test.skip(testInfo.project.name !== 'desktop', 'A mouse drag.');
  await planningFlow(context, levelled);
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');
  const strength = points(page, 'strength');
  await strength.scrollIntoViewIfNeeded();
  const box = (await strength.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 60, { steps: 4 });
  await page.mouse.up();
  await expect(strength).toBeFocused();
  // A click at the field's right end puts the caret after the 4, so a typed 5 makes 45 (which waits, over the cap of 7).
  await strength.click({ position: { x: box.width - 4, y: box.height / 2 } });
  await page.keyboard.type('5');
  await expect(strength).toHaveValue('45');
  await expect(mine.locator('.planning-form').getByText('3 of 12 left', { exact: true })).toBeVisible();
});

test('commits a waiting number against the floor of a pending build that took effect while the field had the focus', async ({ page, context }) => {
  // The React async-state rule: a background owner read moves the floor under typed text; the commit uses the new floor.
  const flow = await planningFlow(context, state => {
    levelled(state);
    state.buildVersion = 2;
    state.pendingBuild = { build: { ...state.currentBuild, version: 2, allocations: { strength: 6, agility: 2, vitality: 1, endurance: 1, precision: 1 } },
      effectiveSlotIndex: Math.floor(Date.now() / SLOT_MS) + 1, reservedMoney: 0, reservedItemIds: [], operationId: randomUUID() };
  });
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');
  const build = mine.locator('.planning-form');
  const strength = points(page, 'strength');
  await expect(strength).toHaveValue('6');
  await strength.fill('2');
  await expect(strength).toHaveValue('2');
  await takeEffect(page, flow);
  await expect(strength).toHaveAttribute('min', '6');
  await expect(strength).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(strength).toHaveValue('6');
  await expect(build.getByText("Strength can't go below 6: added points are permanent.", { exact: true })).toBeVisible();
  await expect(build.getByText('1 of 12 left', { exact: true })).toBeVisible();
});

test('fits the build points on a 360 x 740 phone: no sideways scroll, 44 px controls, five whole rows', async ({ page, context }, testInfo) => {
  await planningFlow(context, levelled);
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');
  const group = mine.locator('.planning-form').getByRole('group', { name: /^Attribute points/ });
  await group.scrollIntoViewIfNeeded();
  await reviewShot(page, testInfo, 'points-build-wide');
  await page.setViewportSize({ width: 360, height: 740 });
  await page.waitForTimeout(500);
  await expectPointsFit(page, group, ['strength', 'agility', 'vitality', 'endurance', 'precision'], ['Strength', 'Agility', 'Vitality', 'Endurance', 'Precision'], { minus: false });
  // The field, +1 and +5 for each attribute, then Respec; it too fits the phone and is a 44 px target. With 3 points left the
  // counter row also offers "Suggested for Berserker" (Patch A Task 5).
  expect(await group.locator('button, input').count()).toBe(5 * 3 + 1 + 1);
  const respec = (await group.getByRole('button', { name: 'Respec', exact: true }).boundingBox())!, area = (await group.boundingBox())!;
  expect(respec.x >= area.x && respec.x + respec.width <= area.x + area.width && respec.height >= 44 && respec.width >= 44, JSON.stringify(respec)).toBe(true);
  await group.scrollIntoViewIfNeeded();
  await reviewShot(page, testInfo, 'points-build-360');
  await group.getByRole('button', { name: 'Respec', exact: true }).scrollIntoViewIfNeeded();
  await reviewShot(page, testInfo, 'points-build-360-respec');
});

test('shows Respec as a paid option to come: gray, aria-disabled, described, and pressing it does nothing', async ({ page, context }) => {
  // Avi, change round 1 (2026-10-29): "No option for take back points for now, only respec the future with real money. So you can add
  // a respec button in gray or something, like it's disabled, so people will know that it is a feature that should come in the future."
  const flow = await planningFlow(context, levelled);
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');
  const build = mine.locator('.planning-form');
  const group = build.getByRole('group', { name: /^Attribute points/ });
  const respec = group.getByRole('button', { name: 'Respec', exact: true });
  await expect(respec).toBeVisible();
  await expect(respec).toHaveText('Respec');
  await expect(respec).toHaveAttribute('aria-disabled', 'true');
  expect(await respec.evaluate(el => (el as HTMLButtonElement).disabled), 'focusable, not disabled').toBe(false);
  await expect(respec).toHaveAccessibleDescription('Coming later as a paid option');
  await expect(group.getByText('Coming later as a paid option', { exact: true })).toBeVisible();
  expect(await respec.evaluate(el => getComputedStyle(el).cursor)).toBe('not-allowed');
  const box = (await respec.boundingBox())!;
  expect(box.width >= 44 && box.height >= 44, JSON.stringify(box)).toBe(true);
  // Pressing it, by pointer or by keyboard, sends nothing and changes nothing on the form.
  const form = () => build.evaluate(el => `${(el as HTMLElement).innerText}|${[...el.querySelectorAll('input, select')].map(field => (field as HTMLInputElement).value).join(',')}`);
  const before = await form();
  await respec.click({ force: true });
  await respec.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  await expect(respec).toBeFocused();
  expect(await form()).toBe(before);
  await expect(build.getByRole('status').filter({ hasText: /can take at most|can't go below|No points left|Build queued/ })).toHaveCount(0);
  await expect(build.getByRole('alert')).toHaveCount(0);
  expect(flow.commands).toHaveLength(0);
});

test('counts the pending build against the points earned, and can still cancel it', async ({ page, context }) => {
  const flow = await planningFlow(context, state => {
    levelled(state);
    state.buildVersion = 2;
    state.pendingBuild = { build: { ...state.currentBuild, version: 2, allocations: { strength: 6, agility: 2, vitality: 1, endurance: 1, precision: 1 } },
      effectiveSlotIndex: Math.floor(Date.now() / SLOT_MS) + 1, reservedMoney: 0, reservedItemIds: [], operationId: randomUUID() };
  });
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');
  const build = mine.locator('.planning-form');
  // The form opens on the pending build (11 spent, 1 left), but its floor is the current build (strength 4).
  await expect(build.getByRole('heading', { name: 'Revise pending build', exact: true })).toBeVisible();
  await expect(build.getByText('1 of 12 left', { exact: true })).toBeVisible();
  await expect(points(page, 'strength')).toHaveValue('6');
  await expect(points(page, 'strength')).toHaveAttribute('min', '4');
  await expect(points(page, 'strength')).toHaveAttribute('max', '7');
  await points(page, 'strength').fill('4');
  await expect(build.getByText('3 of 12 left', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Queue build' }).click();
  await expect(page.getByTestId('pending-build')).toContainText('4');
  expect(flow.commands[0]).toMatchObject({ kind: 'queue-build', expectedVersion: 2, classId: 'berserker', allocation: { strength: 4 } });
  await page.getByRole('button', { name: 'Cancel pending build' }).click();
  await expect(page.getByRole('heading', { name: 'Pending build', exact: true })).not.toBeVisible();
  expect(flow.commands.map(command => command.kind)).toEqual(['queue-build', 'cancel-build']);
});

test('keeps the current class when a build queued before the release holds another one', async ({ page, context }) => {
  // A class change queued before the release stays pending with its fee, but the form never offers or sends a class change.
  const flow = await planningFlow(context, state => {
    state.buildVersion = 2;
    state.pendingBuild = { build: { ...state.currentBuild, version: 2, classId: 'berserker' },
      effectiveSlotIndex: Math.floor(Date.now() / SLOT_MS) + 1, reservedMoney: 100, reservedItemIds: [], operationId: randomUUID() };
    state.reservedFees.money = 100;
  });
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');
  await expect(mine.getByTestId('pending-build')).toContainText('berserker');
  await expect(mine.locator('.planning-form').getByText('Class: Guardian', { exact: true })).toBeVisible();
  await expect(mine.getByLabel('Class', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Queue build' }).click();
  await expect(page.locator('.planning-form [role="status"]').filter({ hasText: 'Build queued.' })).toBeVisible();
  expect(flow.commands[0]).toMatchObject({ kind: 'queue-build', classId: 'guardian' });
  expect(flow.state().pendingBuild?.build.classId).toBe('guardian');
});

test('clears a points line when the build is reloaded after a conflict', async ({ page, context }) => {
  const flow = await planningFlow(context, levelled);
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');
  const build = mine.locator('.planning-form');
  await points(page, 'strength').fill('99');
  await page.keyboard.press('Tab');
  await expect(build.getByText('Strength can take at most 7, so it was set to 7.', { exact: true })).toBeVisible();
  // Another session changed the build: the refusal reloads it, and the line about the old draft goes with the draft.
  flow.conflictNext();
  await page.getByRole('button', { name: 'Queue build' }).click();
  await expect(page.locator('.planning-form [role="alert"]')).toContainText('changed');
  await expect(points(page, 'strength')).toHaveValue('4');
  await expect(build.getByText('3 of 12 left', { exact: true })).toBeVisible();
  await expect(build.getByText(/can take at most/)).toHaveCount(0);
});

/**
 * The boundary applies the pending build with the panel open: the server's current build becomes it and the pending build goes, while the
 * build version the commands carry stays (`apply_pending_build` does not bump it). The page learns on its next owner read.
 */
async function takeEffect(page: Page, flow: Awaited<ReturnType<typeof planningFlow>>) {
  const state = flow.state();
  state.currentBuild = structuredClone(state.pendingBuild!.build);
  state.pendingBuild = null;
  flow.publish();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

test('raises an unsent lower edit to the new floor when a pending build takes effect under the open panel', async ({ page, context }) => {
  const flow = await planningFlow(context, state => {
    levelled(state);
    state.buildVersion = 2;
    state.pendingBuild = { build: { ...state.currentBuild, version: 2, allocations: { strength: 6, agility: 2, vitality: 1, endurance: 1, precision: 1 } },
      effectiveSlotIndex: Math.floor(Date.now() / SLOT_MS) + 1, reservedMoney: 0, reservedItemIds: [], operationId: randomUUID() };
  });
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');
  const build = mine.locator('.planning-form');
  await expect(points(page, 'strength')).toHaveValue('6');
  // An unsent edit back down to the current 4 (allowed while the pending build is not the current one).
  await points(page, 'strength').fill('4');
  await expect(points(page, 'strength')).toHaveValue('4');
  await expect(build.getByText('3 of 12 left', { exact: true })).toBeVisible();
  // The pending build takes effect: 6 is now the current build, so the floor is 6 and the draft cannot stay at 4.
  await takeEffect(page, flow);
  await expect(points(page, 'strength')).toHaveAttribute('min', '6');
  await expect(points(page, 'strength')).toHaveValue('6');
  await expect(build.getByText('1 of 12 left', { exact: true })).toBeVisible();
  await expect(build.getByRole('heading', { name: 'Plan a build', exact: true })).toBeVisible();
  // Queue build is accepted at once: the draft holds the new floor, and nothing says the build was reloaded.
  await mine.getByLabel('Stance', { exact: true }).selectOption('defensive');
  await page.getByRole('button', { name: 'Queue build' }).click();
  await expect(page.getByRole('heading', { name: 'Pending build', exact: true })).toBeVisible();
  await expect(page.locator('.planning-form [role="alert"]')).toHaveCount(0);
  expect(flow.commands).toHaveLength(1);
  expect(flow.commands[0]).toMatchObject({ kind: 'queue-build', classId: 'berserker', stance: 'defensive',
    allocation: { strength: 6, agility: 2, vitality: 1, endurance: 1, precision: 1 } });
});

test('takes the new class when a pending class change from before the release takes effect under the open panel', async ({ page, context }) => {
  const flow = await planningFlow(context, state => {
    state.buildVersion = 2;
    state.pendingBuild = { build: { ...state.currentBuild, version: 2, classId: 'berserker' },
      effectiveSlotIndex: Math.floor(Date.now() / SLOT_MS) + 1, reservedMoney: 100, reservedItemIds: [], operationId: randomUUID() };
    state.reservedFees.money = 100;
  });
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');
  const build = mine.locator('.planning-form');
  // The form shows the current class (Guardian), never the pending one.
  await expect(build.getByText('Class: Guardian', { exact: true })).toBeVisible();
  await takeEffect(page, flow);
  await expect(build.getByText('Class: Berserker', { exact: true })).toBeVisible();
  await mine.getByLabel('Stance', { exact: true }).selectOption('offensive');
  await page.getByRole('button', { name: 'Queue build' }).click();
  await expect(page.getByRole('heading', { name: 'Pending build', exact: true })).toBeVisible();
  await expect(page.locator('.planning-form [role="alert"]')).toHaveCount(0);
  expect(flow.commands[0]).toMatchObject({ kind: 'queue-build', classId: 'berserker', stance: 'offensive' });
});

// ---- Class bonuses and the suggested split (Patch A item 4) ---------------------------------------------------------------------

/** A Guardian with 13 points earned and 10 spent the class's way (2/0/5/2/1): 3 are left. */
const guardianWithThreeLeft = (state: OwnerState) => {
  state.currentBuild = { ...state.currentBuild, classId: 'guardian', allocations: { strength: 2, agility: 0, vitality: 5, endurance: 2, precision: 1 } };
  state.progression = { ...state.progression, level: 2, earnedAttributePoints: 13, unspentAttributePoints: 3 };
};
const fieldValues = async (page: Page) => Promise.all((['strength', 'agility', 'vitality', 'endurance', 'precision'] as const).map(name => points(page, name).inputValue()));
const suggestButton = (build: Locator) => build.getByRole('button', { name: /^Suggested for /});
const undoSplit = (build: Locator) => build.getByRole('button', { name: 'Undo', exact: true });
const splitSentence = '+1 Strength, +1 Vitality, +1 Endurance: the Guardian split.';

test('spends the points left the class way with Suggested, and Undo puts them back', async ({ page, context }, testInfo) => {
  const flow = await planningFlow(context, guardianWithThreeLeft);
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');
  const build = mine.locator('.planning-form');
  // The class's bonuses sit beside "Class: Guardian" in Plan a build.
  const classLine = build.getByText('Class: Guardian', { exact: true });
  const vitality = build.getByText('Vitality +5%', { exact: true }), endurance = build.getByText('Endurance +5%', { exact: true });
  await expect(vitality).toBeVisible();
  await expect(endurance).toBeVisible();
  const inRow = async (chip: Locator) => {
    const [text, box] = await Promise.all([classLine.boundingBox(), chip.boundingBox()]);
    return text!.y < box!.y + box!.height && box!.y < text!.y + text!.height;
  };
  if (testInfo.project.name === 'desktop') expect(await inRow(vitality), 'Vitality +5% is on the class line').toBe(true);
  await expect(build.locator('.build-class')).toContainText(/^Class: GuardianVitality \+5%Endurance \+5%$/);
  // 3 of 13 are left, and the button is beside the counter.
  await expect(build.getByText('3 of 13 left', { exact: true })).toBeVisible();
  expect(await fieldValues(page)).toEqual(['2', '0', '5', '2', '1']);
  await expect(suggestButton(build)).toHaveText('Suggested for Guardian');
  await expect(suggestButton(build)).toBeVisible();
  await expect(undoSplit(build)).toHaveCount(0);
  await suggestButton(build).scrollIntoViewIfNeeded();
  await reviewShot(page, testInfo, 'split-plan-before');
  // Suggested: +1 Strength, +1 Vitality, +1 Endurance (the largest remainders), all 13 spent, a line that says so, and Undo.
  await suggestButton(build).click();
  expect(await fieldValues(page)).toEqual(['3', '0', '6', '3', '1']);
  await expect(build.getByText('All 13 spent', { exact: true })).toBeVisible();
  await expect(build.getByText(splitSentence, { exact: true })).toBeVisible();
  await expect(build.getByRole('status').filter({ hasText: splitSentence })).toHaveCount(1);
  await expect(suggestButton(build)).toHaveCount(0);
  await expect(undoSplit(build)).toBeVisible();
  await undoSplit(build).scrollIntoViewIfNeeded();
  await reviewShot(page, testInfo, 'split-plan-after');
  // Nothing is saved: no command goes out before Queue build.
  expect(flow.commands).toEqual([]);
  // Undo puts the fields back, and the counter, and takes the line and itself away.
  await undoSplit(build).click();
  expect(await fieldValues(page)).toEqual(['2', '0', '5', '2', '1']);
  await expect(build.getByText('3 of 13 left', { exact: true })).toBeVisible();
  await expect(build.getByText(splitSentence, { exact: true })).toHaveCount(0);
  await expect(undoSplit(build)).toHaveCount(0);
  await expect(suggestButton(build)).toBeVisible();
  expect(flow.commands).toEqual([]);
  // Any other edit takes the line and Undo away too: the fields are then what the player typed, not a suggestion to undo.
  await suggestButton(build).click();
  await expect(undoSplit(build)).toBeVisible();
  await points(page, 'strength').fill('2');
  await expect(undoSplit(build)).toHaveCount(0);
  await expect(build.getByText(splitSentence, { exact: true })).toHaveCount(0);
  expect(await fieldValues(page)).toEqual(['2', '0', '6', '3', '1']);
  // A point given back brings the button back (with nothing left it is absent). One left goes to the biggest share, Vitality: it adds to what is there.
  await expect(build.getByText('1 of 13 left', { exact: true })).toBeVisible();
  await suggestButton(build).click();
  expect(await fieldValues(page)).toEqual(['2', '0', '7', '3', '1']);
  await expect(build.getByText('+1 Vitality: the Guardian split.', { exact: true })).toBeVisible();
  await undoSplit(build).click();
  expect(await fieldValues(page)).toEqual(['2', '0', '6', '3', '1']);
  // Queue build sends what the fields hold, as always, after the suggestion.
  await points(page, 'vitality').fill('5');
  await points(page, 'endurance').fill('2');
  await expect(build.getByText('3 of 13 left', { exact: true })).toBeVisible();
  await suggestButton(build).click();
  expect(await fieldValues(page)).toEqual(['3', '0', '6', '3', '1']);
  await page.getByRole('button', { name: 'Queue build' }).click();
  await expect(page.getByRole('heading', { name: 'Pending build', exact: true })).toBeVisible();
  expect(flow.commands).toHaveLength(1);
  expect(flow.commands[0]).toMatchObject({ kind: 'queue-build', classId: 'guardian', allocation: { strength: 3, agility: 0, vitality: 6, endurance: 3, precision: 1 } });
  // The queued build is the new draft: the suggestion's line and its Undo went with the old one (Undo must not put back fields the server now holds).
  await expect(undoSplit(build)).toHaveCount(0);
  await expect(build.getByText(splitSentence, { exact: true })).toHaveCount(0);
  expect(await fieldValues(page)).toEqual(['3', '0', '6', '3', '1']);
  // My gladiator: the class card (bars on a desktop) and, at 390 × 844, the one-line split and no bars.
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = await openMenu(page, 'My gladiator');
  const phoneCard = phone.getByTestId('class-card');
  await phoneCard.scrollIntoViewIfNeeded();
  await expect(phoneCard.getByText('GUARDIAN BONUSES', { exact: true })).toBeVisible();
  await expect(phoneCard.getByText('Vitality +5%', { exact: true })).toBeVisible();
  await expect(phoneCard.getByText('SUGGESTED SPLIT · OF EVERY 10', { exact: true })).toBeVisible();
  await expect(phoneCard.getByText('Vitality 5 · Strength 2 · Endurance 2 · Precision 1', { exact: true })).toBeVisible();
  await expect(phoneCard.getByTestId('split-points').first()).toBeHidden();
  await expect(phoneCard.getByText('SUGGESTED SPLIT · OF EVERY 10 POINTS', { exact: true })).toBeHidden();
  await expect(phoneCard.getByText('From points and gear alike: more health and more stamina.', { exact: true })).toBeHidden();
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('shows the class card between the class line and the activity, with bars on a desktop and one line on a phone', async ({ page, context }, testInfo) => {
  await planningFlow(context, guardianWithThreeLeft);
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');
  const card = mine.getByTestId('class-card');
  const phoneLayout = await page.evaluate(() => matchMedia('(hover: none), (max-width: 480px)').matches);
  // Between the class line and the activity box, in that order.
  const [classLine, cardBox, activity] = await Promise.all([mine.getByText(/^Guardian · Level 2/).boundingBox(), card.boundingBox(),
    mine.getByText(/^CURRENT ACTIVITY$/).boundingBox()]);
  expect(classLine!.y + classLine!.height).toBeLessThanOrEqual(cardBox!.y + 1);
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(activity!.y + 1);
  await expect(card.getByText('GUARDIAN BONUSES', { exact: true })).toBeVisible();
  await expect(card.getByTestId('class-bonus')).toHaveText(['Vitality +5%', 'Endurance +5%']);
  if (!phoneLayout) {
    // Desktop: the meaning line, "SUGGESTED SPLIT · OF EVERY 10 POINTS" and one bar per attribute, largest share first; no one-line form.
    await expect(card.getByText('From points and gear alike: more health and more stamina.', { exact: true })).toBeVisible();
    await expect(card.getByText('SUGGESTED SPLIT · OF EVERY 10 POINTS', { exact: true })).toBeVisible();
    await expect(card.getByTestId('split-points')).toHaveText(['5', '2', '2', '1', '0']);
    await expect(card.getByTestId('split-points').first()).toBeVisible();
    await expect(card.getByText('SUGGESTED SPLIT · OF EVERY 10', { exact: true })).toBeHidden();
    await expect(card.getByText('Vitality 5 · Strength 2 · Endurance 2 · Precision 1', { exact: true })).toBeHidden();
    expect(await card.locator('li').evaluateAll(rows => rows.filter(row => row.querySelector('i')).map(row => Math.round(parseFloat((row.querySelector('i') as HTMLElement).style.width))))).toEqual([100, 40, 40, 20, 0]);
    // The mockup's rows: a 7 px bar and a 3 px gap, so each row is about 20 px high and its bar sits level with its label and number
    // (the stamina bar's own rules once leaked onto these bars: 9 px high with margins, rows 35 px apart, bars above their labels).
    const rows = await card.locator('li').filter({ has: page.getByTestId('split-points') }).evaluateAll(items => items.map(item => {
      const row = item.getBoundingClientRect(), bar = item.querySelector('[aria-hidden="true"]')!.getBoundingClientRect();
      return { height: Math.round(row.height), barHeight: Math.round(bar.height), centre: Math.abs((bar.top + bar.bottom) / 2 - (row.top + row.bottom) / 2) };
    }));
    expect(rows).toHaveLength(5);
    for (const row of rows) { expect(row.height, `row ${JSON.stringify(rows)}`).toBeLessThan(24); expect(row.barHeight).toBe(7); expect(row.centre).toBeLessThan(2); }
    await expect(mine).toHaveCSS('opacity', '1');
    expect(await contrastIssues(mine), 'My gladiator with the class card').toEqual([]);
    await card.scrollIntoViewIfNeeded();
    await reviewShot(page, testInfo, 'class-card-summary');
  }
  // The stamina bar keeps its own look (square ends, 9 px, no fill of its own): the card's bars must not style it.
  const stamina = mine.locator('progress');
  await stamina.scrollIntoViewIfNeeded();
  expect(await stamina.evaluate(bar => { const style = getComputedStyle(bar); return { radius: style.borderTopLeftRadius, height: style.height, top: style.marginTop, bottom: style.marginBottom, background: style.backgroundColor }; }))
    .toEqual({ radius: '0px', height: '9px', top: '7.2px', bottom: '16px', background: 'rgba(0, 0, 0, 0)' });
  // A phone: the chips and the one line (zeros left out), no bars, no meaning line. 390 × 844, then 360 × 740 with nothing spilling sideways.
  for (const size of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
    await page.setViewportSize(size);
    const sheet = await openMenu(page, 'My gladiator');
    const phoneCard = sheet.getByTestId('class-card');
    await phoneCard.scrollIntoViewIfNeeded();
    await expect(phoneCard.getByText('Vitality 5 · Strength 2 · Endurance 2 · Precision 1', { exact: true })).toBeVisible();
    await expect(phoneCard.getByText('SUGGESTED SPLIT · OF EVERY 10', { exact: true })).toBeVisible();
    await expect(phoneCard.getByTestId('split-points').first()).toBeHidden();
    expect(await noHorizontalScroll(page), `no sideways scroll at ${size.width}`).toBe(true);
    expect(await phoneCard.evaluate(element => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().right <= window.innerWidth), `the card fits at ${size.width}`).toBe(true);
    await expect(sheet).toHaveCSS('opacity', '1'); // a phone's sheet rises in: its contrast is read once it has
    expect(await contrastIssues(sheet), `My gladiator with the class card at ${size.width}`).toEqual([]);
    await reviewShot(page, testInfo, `class-card-phone${size.width}`);
  }
});

test('keeps the keyboard focus on the split controls: Suggested hands it to Undo, and Undo hands it back', async ({ page, context }) => {
  await planningFlow(context, guardianWithThreeLeft);
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');
  const build = mine.locator('.planning-form');
  await points(page, 'strength').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(suggestButton(build)).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await fieldValues(page)).toEqual(['3', '0', '6', '3', '1']);
  await expect(undoSplit(build)).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await fieldValues(page)).toEqual(['2', '0', '5', '2', '1']);
  await expect(suggestButton(build)).toBeFocused();
});

// The split's line and its Undo belong to the draft they were made on (AGENTS.md: a flag that outlives a reload is scoped to the record version that set it).
test('drops the split line and Undo when the build is reloaded in the background', async ({ page, context }) => {
  const flow = await planningFlow(context, guardianWithThreeLeft);
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');
  const build = mine.locator('.planning-form');
  await suggestButton(build).click();
  await expect(build.getByText(splitSentence, { exact: true })).toBeVisible();
  await expect(undoSplit(build)).toBeVisible();
  // Another session queued a build: the owner read brings a new build version, the draft is reloaded from it, and the line and Undo go with the old draft.
  flow.state().buildVersion += 1;
  flow.publish();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(build.getByText('3 of 13 left', { exact: true })).toBeVisible();
  expect(await fieldValues(page)).toEqual(['2', '0', '5', '2', '1']);
  await expect(build.getByText(splitSentence, { exact: true })).toHaveCount(0);
  await expect(undoSplit(build)).toHaveCount(0);
  await expect(suggestButton(build)).toBeVisible();
  expect(flow.commands).toEqual([]);
});

test('drops the split line and Undo when a pending build takes effect under the open panel', async ({ page, context }) => {
  // A pending build holds 2/0/6/2/1 (11 of 13): the form opens on it with 2 left, and Suggested gives them to Strength and Vitality.
  const flow = await planningFlow(context, state => {
    guardianWithThreeLeft(state);
    state.buildVersion = 2;
    state.pendingBuild = { build: { ...state.currentBuild, version: 2, allocations: { strength: 2, agility: 0, vitality: 6, endurance: 2, precision: 1 } },
      effectiveSlotIndex: Math.floor(Date.now() / SLOT_MS) + 1, reservedMoney: 0, reservedItemIds: [], operationId: randomUUID() };
  });
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');
  const build = mine.locator('.planning-form');
  await expect(build.getByText('2 of 13 left', { exact: true })).toBeVisible();
  await suggestButton(build).click();
  expect(await fieldValues(page)).toEqual(['3', '0', '7', '2', '1']);
  await expect(build.getByText('+1 Strength, +1 Vitality: the Guardian split.', { exact: true })).toBeVisible();
  await expect(undoSplit(build)).toBeVisible();
  // The boundary applies the pending build: the floor moves under the draft (the build version does not), and the old line and Undo go; the fields stay as typed.
  await takeEffect(page, flow);
  await expect(points(page, 'vitality')).toHaveAttribute('min', '6');
  await expect(undoSplit(build)).toHaveCount(0);
  await expect(build.getByText('+1 Strength, +1 Vitality: the Guardian split.', { exact: true })).toHaveCount(0);
  expect(await fieldValues(page)).toEqual(['3', '0', '7', '2', '1']);
  await expect(build.getByText('All 13 spent', { exact: true })).toBeVisible();
  expect(flow.commands).toEqual([]);
});

// Guardian has the widest chips ("Vitality +5%" and "Endurance +5%" next to "Class: Guardian"); Duelist is the other class with two.
for (const { classId, name, chips, builds, sentence } of [
  { classId: 'guardian', name: 'Guardian', chips: ['Vitality +5%', 'Endurance +5%'], builds: { strength: 2, agility: 0, vitality: 5, endurance: 2, precision: 1 }, sentence: splitSentence },
  { classId: 'duelist', name: 'Duelist', chips: ['Agility +5%', 'Precision +5%'], builds: { strength: 2, agility: 4, vitality: 0, endurance: 0, precision: 4 }, sentence: '+1 Strength, +1 Agility, +1 Precision: the Duelist split.' },
] as const) {
  test(`fits the ${name}'s Build panel at 360 × 740: the chips wrap, the Suggested and Undo buttons are 44 px high, and nothing scrolls sideways`, async ({ page, context }, testInfo) => {
    await planningFlow(context, state => { guardianWithThreeLeft(state); state.currentBuild = { ...state.currentBuild, classId, allocations: { ...builds } }; });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/game/');
    const mine = await openMenu(page, 'My gladiator');
    const build = mine.locator('.planning-form');
    await expect(build.getByText(`Class: ${name}`, { exact: true })).toBeVisible();
    for (const chip of chips) await expect(build.getByText(chip, { exact: true })).toBeVisible();
    await suggestButton(build).scrollIntoViewIfNeeded();
    await expect(suggestButton(build)).toHaveText(`Suggested for ${name}`);
    const inside = (locator: Locator) => locator.evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= window.innerWidth; });
    for (const chip of [...chips.map(chip => build.getByText(chip, { exact: true })), suggestButton(build)]) expect(await inside(chip)).toBe(true);
    expect((await suggestButton(build).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await noHorizontalScroll(page)).toBe(true);
    await build.getByText(`Class: ${name}`, { exact: true }).scrollIntoViewIfNeeded();
    await reviewShot(page, testInfo, `split-plan-${classId}-360-class`);
    await suggestButton(build).scrollIntoViewIfNeeded();
    await reviewShot(page, testInfo, `split-plan-${classId}-360-before`);
    await suggestButton(build).click();
    await expect(undoSplit(build)).toBeVisible();
    await expect(build.getByText(sentence, { exact: true })).toBeVisible();
    expect((await undoSplit(build).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await inside(undoSplit(build))).toBe(true);
    expect(await inside(build.getByText(sentence, { exact: true }))).toBe(true);
    expect(await noHorizontalScroll(page)).toBe(true);
    await expect(mine).toHaveCSS('opacity', '1'); // a phone's sheet rises in: its contrast is read once it has
    expect(await contrastIssues(mine), 'the Build panel with Suggested and Undo').toEqual([]);
    await undoSplit(build).scrollIntoViewIfNeeded();
    await reviewShot(page, testInfo, `split-plan-${classId}-360-after`);
  });
}

/** The select values a part offers (read from the page, apart from the panel's own lists). */
const optionValues = (page: Page, phase: string) => page.getByLabel(`${phase} activity`).locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
/** The line under a part's select (its choice's hint). */
const hintOf = (page: Page, phase: Phase) => page.locator('.schedule-slot').filter({ has: page.getByRole('heading', { name: phase, exact: true }) }).locator('.slot-hint');
const saveDay = (page: Page) => page.getByRole('button', { name: 'Save schedule', exact: true });
const undoDay = (page: Page) => page.getByRole('button', { name: 'Undo changes', exact: true });

test('offers Arena only in the evening and says why under the morning and the afternoon', async ({ page, context }) => {
  // The tournament hour below is written in the 24-hour form; the 12-hour form is pinned in tests/domain/schedule-text.test.ts.
  await storeClock(context, '24');
  await planningFlow(context);
  await page.goto('/game/');
  const schedule = await openMenu(page, 'Schedule');
  expect(await optionValues(page, 'morning')).not.toContain('arena');
  expect(await optionValues(page, 'afternoon')).not.toContain('arena');
  expect(await optionValues(page, 'evening')).toContain('arena');
  // The reason sits under the two parts that cannot hold Arena, and not under the evening.
  await expect(schedule.getByText('Arena runs in the evening only.')).toHaveCount(2);
  for (const phase of ['morning', 'afternoon']) {
    await expect(page.getByLabel(`${phase} activity`)).toHaveAccessibleDescription(/Arena runs in the evening only\./);
  }
  await expect(page.getByLabel('evening activity')).not.toHaveAccessibleDescription(/Arena runs in the evening only\./);
  // Each choice says what it costs; Arena also says when its bout is revealed and that Wednesday and Saturday evenings are the tournament.
  await expect(schedule.getByText('Practice yard: builds experience. Costs 20 stamina.')).toBeVisible();
  await expect(schedule.getByText('Gathers loot and gold over the slot. Costs 30 stamina.')).toBeVisible();
  // A Rest says what it gives back (Patch A item 6): the number depends on the part running now and is pinned below, with the clock held.
  await expect(hintOf(page, 'evening')).toHaveText(/^(Refills stamina to full: \+\d+ \(\d+ → 104\)|Stamina will already be full \(104\): this rest adds nothing)\. Costs nothing\.$/);
  await page.getByLabel('evening activity').selectOption('arena');
  await expect(schedule.getByText('Bout revealed at minute 60, rewards at 80. Wed and Sat 18:40 UTC: the tournament. Costs 25 stamina.')).toBeVisible();
});

// Patch A item 6: a Rest says how much stamina it gives, projected from the owner's stamina and the draft day. The shared clock is held in a
// morning (slot n is phase n mod 3; 373248 is a morning) with the owner's training running and paid; the saved day is training, training, rest.
test.describe('what a Rest gives back', () => {
  const MORNING_SLOT = 373_248, EVENING_SLOT = MORNING_SLOT + 2;
  const MORNING = MORNING_SLOT * SLOT_MS + 25 * 60_000;
  const NO_NUMBER = 'Refills stamina to full. Costs nothing.';
  /** The owner at `stamina` of 104 with the morning's training running and a Rest saved for the evening; `more` changes it further. */
  const rester = (stamina: number, more?: (state: OwnerState) => void) => (state: OwnerState) => {
    state.stamina = { current: stamina, maximum: 104 };
    state.schedule = { morning: { kind: 'training' }, afternoon: { kind: 'training' }, evening: { kind: 'rest' } };
    state.currentActivity = { ...state.currentActivity!, kind: 'training', startsAtMs: MORNING_SLOT * SLOT_MS, endsAtMs: (MORNING_SLOT + 1) * SLOT_MS };
    more?.(state);
  };
  /** Opens the Schedule with the clock held in the morning; `processedSlotIndex` is the slot the owner read says the server has processed (the real current one when left out). */
  async function openAtMorning(page: Page, context: BrowserContext, stamina: number, more?: (state: OwnerState) => void, processedSlotIndex?: number) {
    const flow = await planningFlow(context, rester(stamina, more));
    if (processedSlotIndex !== undefined) flow.state().processedSlotIndex = processedSlotIndex;
    await page.goto('/game/');
    const schedule = await openMenu(page, 'Schedule');
    await page.waitForFunction(() => window.__cloudiatorShell?.clock.synced() === true);
    await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), MORNING);
    return { flow, schedule };
  }
  /** The owner wearing every heavy piece of tier 1: 29 load against a capacity of 24.7, so training costs 24, an expedition 36 and Arena 30. */
  const heavy = (state: OwnerState) => {
    const worn = ['axe:1:common', 'round-shield:1:common', 'iron-helmet:1:common', 'heavy-armor:1:common', 'heavy-boots:1:common'].map(id => itemFixture(CATALOG_V1.items[id]));
    const [weapon, offHand, head, body, feet] = worn;
    state.inventory = worn;
    state.currentBuild = { ...state.currentBuild, equipment: { weapon: weapon.id, offHand: offHand.id, head: head.id, body: body.id, feet: feet.id } };
  };
  /** A build queued to take effect at slot `effectiveSlotIndex`. */
  const pending = (effectiveSlotIndex: number) => (state: OwnerState) => {
    state.pendingBuild = { build: { ...state.currentBuild, version: 2, stance: 'offensive' }, effectiveSlotIndex, reservedMoney: 0, reservedItemIds: [], operationId: randomUUID() };
    state.buildVersion = 2;
  };

  test('says how much stamina a Rest gives back, from the draft day', async ({ page, context }, testInfo) => {
    const { flow, schedule } = await openAtMorning(page, context, 74);
    // 74 now, the afternoon's training takes 20: the evening's Rest finds 54 and gives 50. The other choices keep their own hint.
    await expect(hintOf(page, 'evening')).toHaveText('Refills stamina to full: +50 (54 → 104). Costs nothing.');
    await expect(hintOf(page, 'morning')).toHaveText('Practice yard: builds experience. Costs 20 stamina.');
    await expect(hintOf(page, 'afternoon')).toHaveText('Practice yard: builds experience. Costs 20 stamina.');
    // The gain is the one emphasised thing in the line (the approved mockup's bold "+50").
    await expect(hintOf(page, 'evening').locator('b')).toHaveText('+50');
    await expect(schedule).toHaveCSS('opacity', '1'); // a phone's sheet rises in: its contrast is read once it has
    expect(await contrastIssues(schedule), 'the schedule with a Rest that gives stamina').toEqual([]);
    await hintOf(page, 'evening').scrollIntoViewIfNeeded();
    await reviewShot(page, testInfo, 'rest-stamina-evening');
    await reviewShot360(page, testInfo, 'rest-stamina-evening', hintOf(page, 'evening'));
    // The afternoon becomes a Rest in the draft: it gives what the running part left (74 -> 104), and the evening's then adds nothing.
    await page.getByLabel('afternoon activity').selectOption('rest');
    await expect(hintOf(page, 'afternoon')).toHaveText('Refills stamina to full: +30 (74 → 104). Costs nothing.');
    await expect(hintOf(page, 'evening')).toHaveText('Stamina will already be full (104): this rest adds nothing. Costs nothing.');
    await reviewShot(page, testInfo, 'rest-stamina-full');
    await reviewShot360(page, testInfo, 'rest-stamina-full', hintOf(page, 'evening'));
    // On a 360 px phone the longest of the lines wraps inside its card: nothing spills out of it and the page does not scroll sideways.
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: 360, height: 740 });
    await hintOf(page, 'evening').scrollIntoViewIfNeeded();
    expect(await noHorizontalScroll(page), 'no sideways scroll at 360 px').toBe(true);
    expect(await hintOf(page, 'evening').evaluate(line => line.scrollWidth <= line.clientWidth && line.getBoundingClientRect().right <= window.innerWidth), 'the line fits its card at 360 px').toBe(true);
    await page.setViewportSize(size);
    // The hint describes its select, and a change is only a draft: nothing is sent until Save.
    await expect(page.getByLabel('evening activity')).toHaveAccessibleDescription(/Stamina will already be full \(104\)/);
    expect(flow.commands).toEqual([]);
    // Undo puts back the saved day, and its number.
    await undoDay(page).click();
    await expect(hintOf(page, 'evening')).toHaveText('Refills stamina to full: +50 (54 → 104). Costs nothing.');
    // A Rest in the morning looks to the next morning, after the afternoon's training and the evening's Rest (74 - 20, then full).
    await page.getByLabel('morning activity').selectOption('rest');
    await expect(hintOf(page, 'morning')).toHaveText('Stamina will already be full (104): this rest adds nothing. Costs nothing.');
    // The number follows the clock: in the afternoon the evening's Rest comes straight after the running, paid, afternoon.
    await undoDay(page).click();
    await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), (MORNING_SLOT + 1) * SLOT_MS + 25 * 60_000);
    await expect(hintOf(page, 'evening')).toHaveText('Refills stamina to full: +30 (74 → 104). Costs nothing.');
    expect(flow.commands).toEqual([]);
  });

  test('uses the costs of an overloaded build, as the boundary does', async ({ page, context }) => {
    // An expedition costs 36 here where the base is 30: 74 - 36 = 38 reaches the evening's Rest (the unloaded build would have 44).
    await openAtMorning(page, context, 74, state => { heavy(state); state.schedule.afternoon = { kind: 'expedition', expeditionId: 'woodland' }; });
    await expect(hintOf(page, 'evening')).toHaveText('Refills stamina to full: +66 (38 → 104). Costs nothing.');
    // The training of the draft's afternoon costs 24 for this build, not 20.
    await page.getByLabel('afternoon activity').selectOption('training');
    await expect(hintOf(page, 'evening')).toHaveText('Refills stamina to full: +54 (50 → 104). Costs nothing.');
  });

  test('turns a part the overloaded build cannot afford into a Rest, though the base cost is affordable', async ({ page, context }) => {
    // 34 stamina: the base expedition (30) would leave 4, but this build pays 36, cannot, and rests instead: the evening then adds nothing.
    await openAtMorning(page, context, 34, state => { heavy(state); state.schedule.afternoon = { kind: 'expedition', expeditionId: 'woodland' }; });
    await expect(hintOf(page, 'evening')).toHaveText('Stamina will already be full (104): this rest adds nothing. Costs nothing.');
  });

  test('gives no number while a pending build takes effect at or before the Rest', async ({ page, context }) => {
    const { schedule } = await openAtMorning(page, context, 74, pending(EVENING_SLOT));
    await expect(hintOf(page, 'evening')).toHaveText(NO_NUMBER);
    // The other parts keep their own hints.
    await expect(hintOf(page, 'morning')).toHaveText('Practice yard: builds experience. Costs 20 stamina.');
    await expect(schedule).toHaveCSS('opacity', '1'); // a phone's sheet rises in: its contrast is read once it has
    expect(await contrastIssues(schedule), 'the schedule with no number').toEqual([]);
    // A Rest that comes before the build takes effect (the afternoon's) keeps its number; the evening's still has none.
    await page.getByLabel('afternoon activity').selectOption('rest');
    await expect(hintOf(page, 'afternoon')).toHaveText('Refills stamina to full: +30 (74 → 104). Costs nothing.');
    await expect(hintOf(page, 'evening')).toHaveText(NO_NUMBER);
  });

  // The server debits a slot's activity at its boundary, in the same transaction that sets `processedSlotIndex`; the clock moves to the slot at
  // the cutoff, a minute or two earlier. Until the owner read says the slot is processed, the stamina it shows is not the paid one.
  test('gives no number while the slot the clock is in is not processed yet, and the number once the owner read says it is', async ({ page, context }) => {
    const { flow } = await openAtMorning(page, context, 74, undefined, MORNING_SLOT - 1);
    await expect(hintOf(page, 'evening')).toHaveText(NO_NUMBER);
    // The other choices keep their own hints, and a draft Rest has no number either.
    await expect(hintOf(page, 'morning')).toHaveText('Practice yard: builds experience. Costs 20 stamina.');
    await page.getByLabel('afternoon activity').selectOption('rest');
    await expect(hintOf(page, 'afternoon')).toHaveText(NO_NUMBER);
    await page.getByLabel('afternoon activity').selectOption('training');
    // The boundary is processed: the background owner read brings processedSlotIndex (and, in the real world, the paid stamina) and the number comes by itself.
    flow.state().processedSlotIndex = MORNING_SLOT;
    flow.publish();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(hintOf(page, 'evening')).toHaveText('Refills stamina to full: +50 (54 → 104). Costs nothing.');
    expect(flow.commands).toEqual([]);
  });

  test('gives its number to a Rest that comes before the pending build takes effect', async ({ page, context }) => {
    await openAtMorning(page, context, 74, pending(EVENING_SLOT + 1));
    await expect(hintOf(page, 'evening')).toHaveText('Refills stamina to full: +50 (54 → 104). Costs nothing.');
  });

  test('says on My gladiator what the running Rest will give, and nothing once it is over', async ({ page, context }, testInfo) => {
    await planningFlow(context, state => {
      state.stamina = { current: 74, maximum: 104 };
      state.currentActivity = { ...state.currentActivity!, kind: 'rest', label: 'Resting in camp', startsAtMs: MORNING_SLOT * SLOT_MS, endsAtMs: (MORNING_SLOT + 1) * SLOT_MS };
    });
    await page.goto('/game/');
    const summary = await openMenu(page, 'My gladiator');
    await page.waitForFunction(() => window.__cloudiatorShell?.clock.synced() === true);
    await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), MORNING);
    const gain = page.getByTestId('rest-gain');
    await expect(gain).toHaveText('Stamina refills to 104 when it ends: +30');
    await expect(gain.locator('b')).toHaveText('+30');
    // It sits in the activity box, under the status line.
    await expect(summary.getByRole('status').filter({ hasText: /^In progress/ })).toBeVisible();
    await expect(summary).toHaveCSS('opacity', '1'); // a phone's sheet rises in: its contrast is read once it has
    expect(await contrastIssues(summary), 'My gladiator with the running Rest').toEqual([]);
    await reviewShot(page, testInfo, 'rest-gain-mygladiator');
    await reviewShot360(page, testInfo, 'rest-gain-mygladiator', gain);
    // Past it (the afternoon, its results settled) the line is gone: past rests show no number.
    await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), (MORNING_SLOT + 1) * SLOT_MS + 25 * 60_000);
    await expect(page.getByTestId('rest-gain')).toHaveCount(0);
  });

  test('gives no number on My gladiator while a pending build takes effect when the Rest ends', async ({ page, context }) => {
    await planningFlow(context, state => {
      state.stamina = { current: 74, maximum: 104 };
      state.currentActivity = { ...state.currentActivity!, kind: 'rest', label: 'Resting in camp', startsAtMs: MORNING_SLOT * SLOT_MS, endsAtMs: (MORNING_SLOT + 1) * SLOT_MS };
      pending(MORNING_SLOT + 1)(state);
    });
    await page.goto('/game/');
    await openMenu(page, 'My gladiator');
    await page.waitForFunction(() => window.__cloudiatorShell?.clock.synced() === true);
    await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), MORNING);
    await expect(page.getByTestId('rest-gain')).toHaveText('Stamina refills to full when it ends.');
  });

  test('gives no number when the current build\'s costs cannot be derived', async ({ page, context }) => {
    // The equipped weapon is not among the owner's items, so the build does not validate and its overload is not known.
    await openAtMorning(page, context, 74, state => { state.currentBuild = { ...state.currentBuild, equipment: { ...state.currentBuild.equipment, weapon: 'item-that-is-gone' } }; });
    await expect(hintOf(page, 'evening')).toHaveText(NO_NUMBER);
    await expect(hintOf(page, 'morning')).toHaveText('Practice yard: builds experience. Costs 20 stamina.');
  });
});

test('saves the whole day with one button as one command, and Undo restores the saved day', async ({ page, context }, testInfo) => {
  const flow = await planningFlow(context);
  await page.goto('/game/');
  const schedule = await openMenu(page, 'Schedule');
  // One Save for the day: no per-part buttons, and nothing to save or undo yet.
  await expect(schedule.getByRole('button', { name: /^Save (morning|afternoon|evening)$/ })).toHaveCount(0);
  await expect(saveDay(page)).toBeDisabled();
  await expect(undoDay(page)).toBeDisabled();
  await expect(schedule.getByText(/^Unsaved changes/)).toHaveCount(0);
  // Edits are a draft: nothing is sent, and the parts that differ are named.
  await page.getByLabel('morning activity').selectOption('rest');
  await page.getByLabel('evening activity').selectOption('arena');
  await expect(schedule.getByText('Unsaved changes: morning, evening.')).toBeVisible();
  await expect(saveDay(page)).toBeEnabled();
  await expect(undoDay(page)).toBeEnabled();
  // The running notice, the badge, the unsaved line and the enabled buttons all meet the contrast minimums.
  expect(await contrastIssues(schedule), 'the schedule with unsaved changes').toEqual([]);
  expect(flow.commands).toEqual([]);
  // Undo puts back the saved day.
  await undoDay(page).click();
  await expect(page.getByLabel('morning activity')).toHaveValue('training');
  await expect(page.getByLabel('afternoon activity')).toHaveValue('expedition:woodland');
  await expect(page.getByLabel('evening activity')).toHaveValue('rest');
  await expect(saveDay(page)).toBeDisabled();
  await expect(undoDay(page)).toBeDisabled();
  await expect(schedule.getByText(/^Unsaved changes/)).toHaveCount(0);
  // Edit again and save once: one command carries the whole day (the unchanged afternoon too).
  await page.getByLabel('morning activity').selectOption('rest');
  await page.getByLabel('evening activity').selectOption('arena');
  await saveDay(page).click();
  const saved = page.getByRole('status').filter({ hasText: /^Saved\./ });
  await expect(saved).toHaveText(/^Saved\. Morning: Rest from .+\. Evening: Arena from .+\.$/);
  // The part that did not change is not named.
  await expect(saved).not.toContainText('Afternoon');
  expect(flow.commands).toHaveLength(1);
  expect(flow.commands[0]).toMatchObject({ kind: 'edit-day-schedule', expectedVersion: 1,
    day: { morning: { kind: 'rest' }, afternoon: { kind: 'expedition', expeditionId: 'woodland' }, evening: { kind: 'arena' } } });
  expect(flow.commands[0]).not.toHaveProperty('phase');
  // The saved day is now the saved plan: nothing left to save.
  await expect(saveDay(page)).toBeDisabled();
  await expect(undoDay(page)).toBeDisabled();
  expect(await contrastIssues(schedule), 'the schedule with the saved line').toEqual([]);
  await expect(page.getByLabel('morning activity')).toHaveValue('rest');
  await expect(page.getByLabel('afternoon activity').locator('option[value="expedition:mountain"]')).toBeDisabled();
  await reviewShot360(page, testInfo, 'planning-schedule-saved', saved);
});

test('retries processing with the same operation id', async ({ page, context }) => {
  const flow = await planningFlow(context);
  await page.goto('/game/');
  const schedule = await openMenu(page, 'Schedule');
  await page.getByLabel('morning activity').selectOption('rest');
  flow.processing(true);
  await saveDay(page).click();
  await expect(schedule.getByRole('alert')).toContainText('processing');
  // The draft stays as it was, ready to save again; nothing is marked as the player's mistake.
  await expect(page.getByLabel('morning activity')).toHaveValue('rest');
  await expect(page.getByLabel('morning activity')).not.toHaveAttribute('aria-invalid', 'true');
  await saveDay(page).click();
  await expect(schedule.getByRole('alert')).toContainText('processing');
  flow.processing(false);
  await saveDay(page).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved\. Morning: Rest from / })).toBeVisible();
  expect(flow.commands).toHaveLength(3);
  expect(flow.commands[0]).toEqual(flow.commands[1]);
  expect(flow.commands[0]).toEqual(flow.commands[2]);
});

test('an edit after a refused save sends a new operation, not the refused one', async ({ page, context }) => {
  const flow = await planningFlow(context);
  await page.goto('/game/');
  const schedule = await openMenu(page, 'Schedule');
  await page.getByLabel('evening activity').selectOption('arena');
  flow.processing(true);
  await saveDay(page).click();
  await expect(schedule.getByRole('alert')).toContainText('processing');
  await page.getByLabel('evening activity').selectOption('training');
  // Editing clears the refusal and starts a new request.
  await expect(schedule.getByRole('alert')).toHaveCount(0);
  flow.processing(false);
  await saveDay(page).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved\. Evening: Training from / })).toBeVisible();
  expect(flow.commands).toHaveLength(2);
  expect(flow.commands[0].operationId).not.toBe(flow.commands[1].operationId);
  expect(flow.commands[0]).toMatchObject({ kind: 'edit-day-schedule', day: { evening: { kind: 'arena' } } });
  expect(flow.commands[1]).toMatchObject({ kind: 'edit-day-schedule', expectedVersion: 1, day: { evening: { kind: 'training' } } });
});

test('retries an unknown outcome as the same request and gets the stored answer', async ({ page, context }) => {
  const flow = await planningFlow(context);
  await page.goto('/game/');
  const schedule = await openMenu(page, 'Schedule');
  await page.getByLabel('evening activity').selectOption('arena');
  // The server applied the day, but the answer was lost: the panel does not know, and says so.
  flow.loseNext();
  await saveDay(page).click();
  await expect(schedule.getByRole('alert')).toContainText('could not be confirmed');
  await expect(page.getByLabel('evening activity')).toHaveValue('arena');
  await saveDay(page).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved\. Evening: Arena from / })).toBeVisible();
  expect(flow.commands).toHaveLength(2);
  expect(flow.commands[0]).toEqual(flow.commands[1]);
});

test('clears an unknown-outcome alert when the saved schedule arrives in the background', async ({ page, context }) => {
  const flow = await planningFlow(context);
  await page.goto('/game/');
  const schedule = await openMenu(page, 'Schedule');
  await page.getByLabel('evening activity').selectOption('arena');
  flow.loseNext();
  await saveDay(page).click();
  await expect(schedule.getByRole('alert')).toContainText('could not be confirmed');
  await expect(saveDay(page)).toBeEnabled();
  // The accepted day is found by the background revision/owner read, not by resending the command.
  flow.publish();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(saveDay(page)).toBeDisabled();
  await expect(undoDay(page)).toBeDisabled();
  await expect(page.getByLabel('evening activity')).toHaveValue('arena');
  await expect(schedule.getByRole('alert')).toHaveCount(0);
  expect(flow.commands).toHaveLength(1);
});

test('keeps a new success line but clears it when another schedule version arrives', async ({ page, context }) => {
  const flow = await planningFlow(context);
  await page.goto('/game/');
  const schedule = await openMenu(page, 'Schedule');
  await page.getByLabel('morning activity').selectOption('rest');
  await saveDay(page).click();
  await expect(schedule.getByRole('status').filter({ hasText: /^Saved\. Morning: Rest from / })).toBeVisible();
  flow.state().scheduleVersion++;
  flow.state().schedule.morning = { kind: 'training' };
  flow.publish();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('morning activity')).toHaveValue('training');
  await expect(saveDay(page)).toBeDisabled();
  await expect(undoDay(page)).toBeDisabled();
  await expect(schedule.locator('.schedule-saved')).toHaveCount(0);
});

test('loads the latest schedule after a conflict and saves nothing over it', async ({ page, context }) => {
  const flow = await planningFlow(context);
  await page.goto('/game/');
  const schedule = await openMenu(page, 'Schedule');
  await page.getByLabel('morning activity').selectOption('rest');
  flow.scheduleConflictNext();
  await saveDay(page).click();
  await expect(schedule.getByRole('alert')).toContainText('Your schedule changed');
  // The latest saved plan is loaded: the draft is replaced (the afternoon is what the other session saved), and nothing is left to save.
  await expect(page.getByLabel('morning activity')).toHaveValue('training');
  await expect(page.getByLabel('afternoon activity')).toHaveValue('rest');
  await expect(saveDay(page)).toBeDisabled();
  await expect(schedule.getByRole('alert')).toContainText('Your schedule changed');
  await page.getByLabel('morning activity').selectOption('rest');
  await saveDay(page).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved\. Morning: Rest from / })).toBeVisible();
  expect(flow.commands).toHaveLength(2);
  expect(flow.commands[1]).toMatchObject({ kind: 'edit-day-schedule', expectedVersion: 2, day: { morning: { kind: 'rest' }, afternoon: { kind: 'rest' } } });
  expect(flow.commands[1].operationId).not.toBe(flow.commands[0].operationId);
});

test('clears a previous conflict explanation on a later background schedule refresh', async ({ page, context }) => {
  const flow = await planningFlow(context);
  await page.goto('/game/');
  const schedule = await openMenu(page, 'Schedule');
  await page.getByLabel('morning activity').selectOption('rest');
  flow.scheduleConflictNext();
  await saveDay(page).click();
  await expect(saveDay(page)).toBeDisabled();
  await expect(schedule.getByRole('alert')).toContainText('Your schedule changed');
  flow.state().scheduleVersion++;
  flow.publish();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(schedule.getByRole('alert')).toHaveCount(0);
});

test('clears a conflict after its reload returns a version already loaded in the background', async ({ page, context }) => {
  const flow = await planningFlow(context);
  let release!: () => void;
  const reply = new Promise<void>(resolve => { release = resolve; });
  await context.route('http://127.0.0.1:54321/functions/v1/game-command', async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON().kind !== 'edit-day-schedule') return route.fallback();
    await reply;
    return route.fulfill({ status: 409, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'conflict' }) });
  });
  await page.goto('/game/');
  const schedule = await openMenu(page, 'Schedule');
  await page.getByLabel('morning activity').selectOption('rest');
  const sent = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/game-command') && request.postDataJSON().kind === 'edit-day-schedule');
  await saveDay(page).click();
  await sent;
  try {
    // Another session's v2 arrives while the v1 command is still awaiting its conflict response.
    flow.state().scheduleVersion++;
    flow.state().schedule.afternoon = { kind: 'rest' };
    flow.publish();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByLabel('afternoon activity')).toHaveValue('rest');
    await expect(page.getByLabel('morning activity')).toHaveValue('training');
  } finally { release(); }
  await expect(schedule.getByRole('alert')).toContainText('Your schedule changed');
  await expect(saveDay(page)).toBeDisabled();
  // The conflict refresh returned that same v2; v3 must still clear its old explanation.
  flow.state().scheduleVersion++;
  flow.publish();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(schedule.getByRole('alert')).toHaveCount(0);
});

test('keeps the keyboard focus on the page after Save and after Undo', async ({ page, context }) => {
  await watchFocus(page);
  await planningFlow(context);
  await page.goto('/game/');
  await openMenu(page, 'Schedule');
  // By keyboard: change the morning (Down on the closed select), Tab through the other two selects to Save, and press it.
  const morning = page.getByLabel('morning activity');
  await morning.focus();
  await page.keyboard.press('ArrowDown');
  await expect(morning).toHaveValue('rest');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(saveDay(page)).toBeFocused();
  await page.keyboard.press('Enter');
  // The saved line takes the focus the disabled Save button loses.
  const saved = page.getByRole('status').filter({ hasText: /^Saved\./ });
  await expect(saved).toBeFocused();
  // Undo by keyboard: the button disables itself, and the focus must not be left on <body>.
  await morning.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(undoDay(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(undoDay(page)).toBeDisabled();
  // The first changed part (the morning) takes the focus the disabled Undo button loses.
  await expect(morning).toBeFocused();
  expect(await focusedElement(page)).not.toBe('body');
  expect(await focusDrops(page)).toEqual([]);
});

// Chrome drops the focus of a control that has become disabled at its next frame, after the page's DOM-change checks have
// run, so nothing put it back until the save settled: a keyboard player was on <body> for the whole save (the release
// gate's flake, seen when a check landed in that window). Here the reply waits, and a long task holds the page as the
// saved line appears, so a frame is drawn before any later work.
test('keeps the keyboard focus on Save while the day is sent, and hands it straight to the saved line', async ({ page, context }) => {
  await watchFocus(page);
  const flow = await planningFlow(context);
  let release!: () => void;
  const reply = new Promise<void>(resolve => { release = resolve; });
  await context.route('http://127.0.0.1:54321/functions/v1/game-command', async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON().kind !== 'edit-day-schedule') return route.fallback();
    await reply;
    return route.fallback();
  });
  await page.goto('/game/');
  await openMenu(page, 'Schedule');
  const morning = page.getByLabel('morning activity');
  await morning.focus();
  await page.keyboard.press('ArrowDown');
  await expect(morning).toHaveValue('rest');
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Tab');
  await expect(saveDay(page)).toBeFocused();
  // Every moment the focus falls to <body> from here, even one the page moves on from, and the long task.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __toBody: string[] }).__toBody = seen;
    document.addEventListener('focusout', event => {
      if (!event.relatedTarget && document.hasFocus()) seen.push((event.target as Element).textContent?.trim().slice(0, 40) ?? '');
    }, true);
    new MutationObserver(records => {
      if (!records.some(r => [...r.addedNodes].some(n => n instanceof Element && n.matches('[role="status"]') && !!n.closest('.planning-form')))) return;
      const until = performance.now() + 150;
      while (performance.now() < until) { /* a loaded host */ }
    }).observe(document.body, { subtree: true, childList: true });
  });
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const sent = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/game-command') && request.postDataJSON().kind === 'edit-day-schedule');
  await page.keyboard.press('Enter');
  await sent;
  try {
    // Frames later, Save still has the focus, unavailable while it is sent; pressing it again sends nothing, and a change
    // elsewhere on the page (a script added to <head>) finds the focus in place.
    await frames();
    await expect(saveDay(page)).toBeFocused();
    await expect(saveDay(page)).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Enter');
    await page.evaluate(() => { document.head.append(document.createElement('script')); });
    await frames();
    await expect(saveDay(page)).toBeFocused();
  } finally { release(); }
  await expect(page.getByRole('status').filter({ hasText: /^Saved\./ })).toBeFocused();
  await expect(saveDay(page)).toBeDisabled();
  expect(flow.commands.filter(command => command.kind === 'edit-day-schedule')).toHaveLength(1);
  expect(await page.evaluate(() => (window as unknown as { __toBody: string[] }).__toBody)).toEqual([]);
  expect(await focusDrops(page)).toEqual([]);
});

test('keeps the keyboard focus on Save after a refused save, with the reason marked as where it goes next', async ({ page, context }) => {
  await watchFocus(page);
  const flow = await planningFlow(context);
  await page.goto('/game/');
  const schedule = await openMenu(page, 'Schedule');
  const morning = page.getByLabel('morning activity');
  await morning.focus();
  await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Tab');
  await expect(saveDay(page)).toBeFocused();
  flow.processing(true);
  await page.keyboard.press('Enter');
  const reason = schedule.getByRole('alert');
  await expect(reason).toContainText('processing');
  // The draft is still unsaved, so Save is usable again and keeps the focus; the reason is where a later loss would go.
  await expect(saveDay(page)).toBeEnabled();
  await expect(saveDay(page)).toBeFocused();
  await expect(reason).toHaveAttribute('data-focus-target', '');
  expect(await focusDrops(page)).toEqual([]);
});

test('does not move focus to the first changed select after pointer Undo', async ({ page, context }) => {
  await planningFlow(context);
  await page.goto('/game/');
  await openMenu(page, 'Schedule');
  const morning = page.getByLabel('morning activity');
  await morning.selectOption('rest');
  await undoDay(page).click();
  await expect(morning).toHaveValue('training');
  await expect(undoDay(page)).toBeDisabled();
  await expect(saveDay(page)).toBeDisabled();
  await expect(morning).not.toBeFocused();
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
  const expected = await Promise.all(next.map(async ms => `Estimated next start: ${await slotTime(page, ms, later)}`));
  await expect(starts).toHaveText(expected);
  expect(expected).not.toEqual(before);
});

// Task 23.10: the wording follows the display clock past midnight. The zone is held, so the expected texts are written out.
test.describe('estimated starts around local midnight', () => {
  test.use({ timezoneId: 'America/New_York', locale: 'en-US' });

  test('says tomorrow for a start after midnight, and the time alone once the clock is past it', async ({ page, context }, testInfo) => {
    await planningFlow(context);
    await page.goto('/game/');
    await openMenu(page, 'Schedule');
    const starts = page.locator('.planning-form p').filter({ hasText: /^Estimated next start:/ });
    await expect(starts).toHaveCount(3);
    await page.waitForFunction(() => window.__cloudiatorShell?.clock.synced() === true);
    // (The time's own spaces are no-break spaces; the expected texts below are written with ordinary ones.)
    const times = async () => (await starts.allTextContents()).map(text => text.replace('Estimated next start: ', '').replace(/\xA0/g, ' ')).sort();
    // 22:00 on 14 July 2026 in New York (02:00 UTC): the next three boundaries (80 minutes apart) are 22:40, midnight and 01:20.
    await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), Date.UTC(2026, 6, 15, 2, 0));
    await expect.poll(times).toEqual(['10:40 PM', 'tomorrow 12:00 AM', 'tomorrow 1:20 AM'].sort());
    for (const index of [0, 1, 2]) await expectTimeOnOneLine(page, starts.nth(index), `estimated start ${index + 1}`);
    await reviewShot360(page, testInfo, 'planning-schedule-tomorrow', starts.first());
    // Half past midnight: all three are on the same local day as the clock now, so the time alone.
    await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), Date.UTC(2026, 6, 15, 4, 30));
    await expect.poll(times).toEqual(['1:20 AM', '2:40 AM', '4:00 AM']);
  });
});

// Launch feedback: the part running now says so, when it ends and that a change to it waits for its next occurrence. The zone is held, so
// the expected texts are written out. Slot n is phase n mod 3 and UTC midnight is a slot boundary: 01:20 UTC is an afternoon's start.
test.describe('the running part of the day', () => {
  test.use({ timezoneId: 'America/New_York', locale: 'en-US' });
  /** 10:00 PM on 14 July in New York (02:00 UTC on the 15th): the afternoon (01:20-02:40 UTC) is running. */
  const AFTERNOON_RUNNING = Date.UTC(2026, 6, 15, 2, 0);
  const card = (page: Page, phase: string) => page.locator('.schedule-slot').filter({ has: page.getByRole('heading', { name: phase, exact: true }) });

  test('shows the running part, when it ends and when a change starts, and follows the clock to the next part', async ({ page, context }, testInfo) => {
    await planningFlow(context);
    await page.goto('/game/');
    const schedule = await openMenu(page, 'Schedule');
    await page.waitForFunction(() => window.__cloudiatorShell?.clock.synced() === true);
    await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), AFTERNOON_RUNNING);
    const notice = schedule.getByRole('note');
    await expect(notice).toHaveText('Afternoon is running now (ends 10:40 PM). A change to the afternoon starts with the next afternoon, tomorrow 1:20 AM.');
    await expectTimeOnOneLine(page, notice, 'the running part\'s notice');
    // Only the running part wears the badge.
    await expect(schedule.getByText('Running now', { exact: true })).toHaveCount(1);
    await expect(card(page, 'afternoon').getByText('Running now', { exact: true })).toBeVisible();
    await expect(card(page, 'morning').getByText('Running now')).toHaveCount(0);
    await reviewShot360(page, testInfo, 'planning-schedule-running', notice);
    // 80 minutes on, the evening is running: the notice and the badge follow the clock.
    await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), AFTERNOON_RUNNING + SLOT_MS);
    await expect(notice).toHaveText('Evening is running now (ends tomorrow 12:00 AM). A change to the evening starts with the next evening, tomorrow 2:40 AM.');
    await expect(schedule.getByText('Running now', { exact: true })).toHaveCount(1);
    await expect(card(page, 'evening').getByText('Running now', { exact: true })).toBeVisible();
    await expect(card(page, 'afternoon').getByText('Running now')).toHaveCount(0);
  });

  test('names a change to the running part in the saved line, after the running part', async ({ page, context }, testInfo) => {
    const flow = await planningFlow(context);
    await page.goto('/game/');
    const schedule = await openMenu(page, 'Schedule');
    await page.waitForFunction(() => window.__cloudiatorShell?.clock.synced() === true);
    await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), AFTERNOON_RUNNING);
    flow.receivedAt(AFTERNOON_RUNNING);
    await page.getByLabel('morning activity').selectOption('rest');
    await page.getByLabel('afternoon activity').selectOption('training');
    await saveDay(page).click();
    // The morning starts with the next morning (04:00 UTC, midnight in New York); the running afternoon's change starts with the one after it (05:20 UTC).
    const saved = schedule.getByRole('status').filter({ hasText: /^Saved\./ });
    await expect(saved).toHaveText('Saved. Morning: Rest from tomorrow 12:00 AM. Afternoon: Training from tomorrow 1:20 AM, after the running afternoon.');
    await expectTimeOnOneLine(page, saved, 'the saved line\'s first time');
    await reviewShot360(page, testInfo, 'planning-schedule-saved-running', saved);
    expect(flow.commands).toHaveLength(1);
  });
});
