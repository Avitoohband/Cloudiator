import { test, expect, type BrowserContext, type Page } from './fixtures';
import { randomUUID } from 'node:crypto';
import { ownerFixture } from '../fixtures/domain';
import type { GameCommand, Phase } from '../../supabase/functions/_shared/contracts/commands';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads';
import { SLOT_MS, emptyWorld, isPresence, routeLiveReads } from './live-routes';
import { reviewShot360 } from './review-shots';
import { openMenu } from './shell-helpers';
import { expectTimeOnOneLine, slotTime } from './slot-time';
import { contrastIssues, focusDrops, focusedElement, watchFocus } from './a11y-helpers';

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
  // The class is fixed, so the change to queue is the stance, and every build change is free: no reservation is estimated.
  await page.getByLabel('Stance', { exact: true }).selectOption('offensive');
  await expect(page.getByText(/^Estimated reservation/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Queue build' }).click();
  await expect(page.getByRole('heading', { name: 'Pending build', exact: true })).toBeVisible();
  await expect(page.getByTestId('current-build')).toContainText('balanced');
  await expect(page.getByTestId('pending-build')).toContainText('offensive');
  await expect(page.getByTestId('pending-build')).toContainText('Reserved: 0 money');
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
  // Typing below the saved value raises it back, with the line that says why.
  await strength.fill('0');
  await expect(strength).toHaveValue('4');
  await expect(build.getByText("Strength can't go below 4: added points are permanent.", { exact: true })).toBeVisible();
  await expect(build.getByText('3 of 12 left', { exact: true })).toBeVisible();
  // Typing more than is left is capped at the field's value plus what is left, with the creation dialog's line.
  await strength.fill('99');
  await expect(strength).toHaveValue('7');
  await expect(build.getByText('Strength can take at most 7, so it was set to 7.', { exact: true })).toBeVisible();
  await expect(build.getByText("Strength can't go below 4", { exact: false })).toHaveCount(0);
  await expect(build.getByText('All 12 spent', { exact: true })).toBeVisible();
  await expect(build.getByText(/of 12 left/)).toHaveCount(0);
  await expect(strength).toHaveAttribute('max', '7');
  await expect(agility).toHaveAttribute('max', '2');
  // Nothing is left to add.
  await agility.fill('9');
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
  await expect(strength).toHaveValue('4');
  await expect(build.getByText("Strength can't go below 4: added points are permanent.", { exact: true })).toBeVisible();
  await expect(build.getByText('3 of 12 left', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
  await expect(build.getByText('Strength can take at most 7, so it was set to 7.', { exact: true })).toBeVisible();
  // Another session changed the build: the refusal reloads it, and the line about the old draft goes with the draft.
  flow.conflictNext();
  await page.getByRole('button', { name: 'Queue build' }).click();
  await expect(page.locator('.planning-form [role="alert"]')).toContainText('changed');
  await expect(points(page, 'strength')).toHaveValue('4');
  await expect(build.getByText('3 of 12 left', { exact: true })).toBeVisible();
  await expect(build.getByText(/can take at most/)).toHaveCount(0);
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
