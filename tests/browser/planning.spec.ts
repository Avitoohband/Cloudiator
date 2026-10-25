import { test, expect, type BrowserContext, type Page } from './fixtures';
import { randomUUID } from 'node:crypto';
import { ownerFixture } from '../fixtures/domain';
import type { GameCommand, Phase } from '../../supabase/functions/_shared/contracts/commands';
import { SLOT_MS, emptyWorld, isPresence, routeLiveReads } from './live-routes';
import { reviewShot360 } from './review-shots';
import { openMenu } from './shell-helpers';
import { expectTimeOnOneLine, slotTime } from './slot-time';
import { contrastIssues, focusDrops, focusedElement, watchFocus } from './a11y-helpers';

async function planningFlow(context: BrowserContext) {
  let state = structuredClone(ownerFixture);
  state.wallets.money = 300;
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
      // Another session changed the afternoon first: the saved schedule is a new version the command's expected version does not match.
      if (scheduleConflict && command.kind === 'edit-day-schedule') { scheduleConflict = false; state.scheduleVersion++; state.schedule.afternoon = { kind: 'rest' }; return json({ ok: false, code: 'conflict' }, 409); }
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
    scheduleConflictNext: () => { scheduleConflict = true; }, receivedAt: (ms: number | null) => { receivedAt = ms; }, state: () => state };
}

test.beforeEach(() => { test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Live UI uses development-only intercepted identity transport.'); });

/** The shared display clock's time in the page. */
const clockNow = (page: Page) => page.evaluate(() => window.__cloudiatorShell!.clock.now());

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

/** The select values a part offers (read from the page, apart from the panel's own lists). */
const optionValues = (page: Page, phase: string) => page.getByLabel(`${phase} activity`).locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
const saveDay = (page: Page) => page.getByRole('button', { name: 'Save schedule', exact: true });
const undoDay = (page: Page) => page.getByRole('button', { name: 'Undo changes', exact: true });

test('offers Arena only in the evening and says why under the morning and the afternoon', async ({ page, context }) => {
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
  await expect(schedule.getByText('Gathers loot and money over the slot. Costs 30 stamina.')).toBeVisible();
  await expect(schedule.getByText('Recovers stamina. Costs nothing.')).toBeVisible();
  await page.getByLabel('evening activity').selectOption('arena');
  await expect(schedule.getByText('Bout revealed at minute 60, rewards at 80. Wed and Sat 18:40 UTC: the tournament. Costs 25 stamina.')).toBeVisible();
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
  // The running notice, the badge, the unsaved line and the enabled buttons all meet the contrast minimums.
  expect(await contrastIssues(schedule), 'the schedule with unsaved changes').toEqual([]);
  await expect(saveDay(page)).toBeEnabled();
  await expect(undoDay(page)).toBeEnabled();
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
  expect(await contrastIssues(schedule), 'the schedule with the saved line').toEqual([]);
  // The saved day is now the saved plan: nothing left to save.
  await expect(saveDay(page)).toBeDisabled();
  await expect(undoDay(page)).toBeDisabled();
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
  await page.getByLabel('morning activity').selectOption('rest');
  await saveDay(page).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved\. Morning: Rest from / })).toBeVisible();
  expect(flow.commands).toHaveLength(2);
  expect(flow.commands[1]).toMatchObject({ kind: 'edit-day-schedule', expectedVersion: 2, day: { morning: { kind: 'rest' }, afternoon: { kind: 'rest' } } });
  expect(flow.commands[1].operationId).not.toBe(flow.commands[0].operationId);
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
