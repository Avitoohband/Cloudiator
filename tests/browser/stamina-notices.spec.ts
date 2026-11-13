import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Locator, type Page, type TestInfo } from './fixtures';
import type { OwnerState, ResultRow } from '../../supabase/functions/_shared/contracts/reads';
import { ownerFixture } from '../fixtures/domain';
import { EXPEDITION_FIXTURES } from '../fixtures/expedition-ids';
import { SLOT_MS, SUPABASE_URL, emptyWorld, isPresence, routeLiveReads, seedSession, type LiveData, type LiveRest, type LiveTransport } from './live-routes';
import { everyoneResults, expectOwnerShown, openMenu, quietArrivals } from './shell-helpers';
import { contrastIssues, noHorizontalScroll } from './a11y-helpers';

// Patch 1.9 Task 29 (approved mockup 2026-11-13, `.superpowers/design/2026-11-13-stamina-notices/`): the Schedule marks a part that will rest
// instead (not enough stamina, or the daily Training limit), a notice says so for the next slot, the running card says what really runs,
// and afterwards the owner's Notifications and own Results line say it rested instead (other players still read "finished resting"). Live
// mode: the owner Aster is routed through the development-only Supabase transport, and the shared display clock is held at the minute a test
// is about (slot 373248 is a morning: slot n is phase n mod 3).

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const MIN = 60_000;
const MORNING_SLOT = 373_248, AFTERNOON_SLOT = MORNING_SLOT + 1;
const MORNING = MORNING_SLOT * SLOT_MS + 25 * MIN, AFTERNOON = AFTERNOON_SLOT * SLOT_MS + 25 * MIN;
const SHOTS = '.superpowers/sdd/2026-11-12-1.9-additions';

/** Aster at `stamina` of 104 with `kind` running in `slot` (processed), the fixture's day (training, Woodland Path, rest) unless `more` changes it. */
function aster(stamina: number, slot = MORNING_SLOT, more?: (state: OwnerState) => void): OwnerState {
  const state = structuredClone(ownerFixture);
  state.stamina = { current: stamina, maximum: 104 };
  state.processedSlotIndex = slot;
  state.currentActivity = { id: randomUUID(), kind: 'training', status: 'active', startsAtMs: slot * SLOT_MS, endsAtMs: (slot + 1) * SLOT_MS, label: 'Training' };
  more?.(state);
  return state;
}

async function live(context: BrowserContext, data: Omit<LiveData, 'world'>) {
  return routeAndSeed(context, data);
}
async function routeAndSeed(context: BrowserContext, data: Omit<LiveData, 'world'>): Promise<LiveTransport> {
  await seedSession(context);
  await quietArrivals(context);
  return routeLiveReads(context, { world: emptyWorld(), ...data });
}
/** Opens the camp as Aster with the shared display clock held at `at`. */
async function openCamp(page: Page, at: number) {
  await page.goto('/game/');
  await expectOwnerShown(page, 'Aster');
  await page.waitForFunction(() => window.__cloudiatorShell?.clock.synced() === true, null, { timeout: 45_000 });
  await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), at);
}
const card = (page: Page, phase: string) => page.locator('.schedule-slot').filter({ has: page.getByRole('heading', { name: phase, exact: true }) });
const mark = (page: Page, phase: string) => page.getByTestId(`stamina-mark-${phase}`);
const notice = (page: Page) => page.locator('[data-stamina-notice]');
const popup = (page: Page) => page.locator('[data-stamina-popup]');
/** Holds the shared display clock at `at`. */
const hold = (page: Page, at: number) => page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), at);
/** Reloads the camp as Aster, the clock held at `at` again. */
async function reloadAt(page: Page, at: number) {
  await page.reload();
  await expectOwnerShown(page, 'Aster');
  await page.waitForFunction(() => window.__cloudiatorShell?.clock.synced() === true, null, { timeout: 45_000 });
  await hold(page, at);
}
/** Whether a notice spans the phone's width with the 12 px gutters (the approved phone mockup); on a desktop it keeps its 320 px. */
const phoneWide = (locator: Locator) => locator.evaluate(el => { const r = el.getBoundingClientRect(); return { width: r.width, room: window.innerWidth - 24 }; });
/** Aster resting in `slot` instead of the Woodland Path (not enough stamina), with the activity row that says so. */
function restingInstead(slot: number) {
  const owner = aster(12, slot, state => { state.currentActivity = { ...state.currentActivity!, kind: 'rest', label: 'Resting (not enough stamina)' }; });
  const rests: LiveRest[] = [{ activityId: owner.currentActivity!.id, slotIndex: slot, requested: { kind: 'expedition', expeditionId: 'woodland' }, fallback: true, settled: false, name: 'Aster' }];
  return { owner, rests };
}
/** The server's notifications mark: `see-notifications` moves the owner's `notificationsSeenMs` up (never back), as the Edge function does. */
async function serveSeenMarks(context: BrowserContext, live: LiveTransport, owner: OwnerState) {
  const marks: number[] = [];
  await context.route(`${SUPABASE_URL}/functions/v1/game-command`, async route => {
    const request = route.request();
    if (request.method() !== 'POST' || isPresence(request)) return route.fallback();
    const command = request.postDataJSON() as { kind: string; upToMs?: number };
    if (command.kind !== 'see-notifications') return route.fallback();
    marks.push(command.upToMs!);
    owner.inbox = { ...owner.inbox, notificationsSeenMs: Math.max(owner.inbox.notificationsSeenMs, command.upToMs!) };
    live.setOwner(structuredClone(owner));
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json',
      body: JSON.stringify({ ok: true, value: { seenMs: owner.inbox.notificationsSeenMs } }) });
  });
  return marks;
}
/** A review screenshot for the task's report, in the SDD folder: `task-29-<name>-<project>.png`. */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/task-29-${name}-${testInfo.project.name}.png` });
}
/** Whether `locator` lies inside the viewport's width (nothing cut off at a phone's edge). */
const fitsWidth = (locator: Locator) => locator.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 0.5; });

test.describe('stamina notices', () => {
  test.skip(production, 'Live mode uses the development-only intercepted Supabase transport.');

  test('marks the part that will rest instead, and the stamina after the parts that run', async ({ page, context }, testInfo) => {
    // 12 of 104 with the morning's training running and paid: the afternoon's Woodland Path costs 30 and becomes a Rest; the evening's Rest
    // refills.
    await live(context, { owner: aster(12) });
    await openCamp(page, MORNING);
    const schedule = await openMenu(page, 'Schedule');
    await expect(mark(page, 'afternoon')).toHaveText('⚠ Not enough stamina: your gladiator will rest insteadNeeds 30, will have 12. Add a Rest before it or pick a cheaper activity.');
    await expect(mark(page, 'afternoon').locator('small')).toHaveText('Needs 30, will have 12. Add a Rest before it or pick a cheaper activity.');
    // The morning runs now: its card shows no quiet line (fix round 1); its next occurrence's 84 is not repeated there.
    await expect(mark(page, 'morning')).toHaveCount(0);
    await expect(mark(page, 'evening')).toHaveCount(0);
    // The mark describes its select, under the hint line.
    await expect(page.getByLabel('afternoon activity')).toHaveAccessibleDescription(/Not enough stamina: your gladiator will rest instead/);
    await expect(schedule).toHaveCSS('opacity', '1');
    expect(await contrastIssues(card(page, 'afternoon')), 'the warning on the afternoon').toEqual([]);
    await mark(page, 'afternoon').scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'schedule-marks');
    // A Rest before it fixes the plan: the draft's afternoon Rest has no mark, and the morning after the evening's Rest still runs.
    await page.getByLabel('afternoon activity').selectOption('rest');
    await expect(mark(page, 'afternoon')).toHaveCount(0);
    // On a 360 px phone the warning wraps inside its card: no sideways scroll.
    await page.getByLabel('afternoon activity').selectOption('expedition:woodland');
    await page.setViewportSize({ width: 360, height: 740 });
    await mark(page, 'afternoon').scrollIntoViewIfNeeded();
    expect(await noHorizontalScroll(page), 'no sideways scroll at 360 px').toBe(true);
    expect(await fitsWidth(mark(page, 'afternoon'))).toBe(true);
  });

  test('marks a third Training of a game day under the daily limit', async ({ page, context }, testInfo) => {
    await live(context, { owner: aster(100, MORNING_SLOT, state => { state.schedule = { morning: { kind: 'training' }, afternoon: { kind: 'training' }, evening: { kind: 'training' } }; }),
      rulesVersion: 'v2' });
    await openCamp(page, MORNING);
    await openMenu(page, 'Schedule');
    await expect(mark(page, 'evening')).toHaveText('⚠ Training limit: this becomes Rest (2 a game day)Pick another activity for this part, or leave it as a Rest.');
    await expect(mark(page, 'afternoon')).toHaveText(/^Stamina after: \d+$/);
    await mark(page, 'evening').scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'schedule-limit');
  });

  test('says on screen when the next slot will not run, once per slot, with Open schedule', async ({ page, context }, testInfo) => {
    await live(context, { owner: aster(12) });
    await openCamp(page, MORNING);
    await expect(notice(page)).toContainText('STAMINA', { ignoreCase: true });
    await expect(notice(page)).toContainText('Not enough stamina for your next Expedition (starts in 55 min). Your gladiator will rest instead.');
    expect(await fitsWidth(notice(page))).toBe(true);
    expect(await noHorizontalScroll(page)).toBe(true);
    expect(await contrastIssues(notice(page))).toEqual([]);
    // Fix round 1: on a phone it spans the width (the approved phone mockup).
    if (testInfo.project.name === 'mobile') {
      const { width, room } = await phoneWide(notice(page));
      expect(width).toBeGreaterThanOrEqual(room - 1);
    }
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    await shot(page, testInfo, 'notice');
    // Open schedule opens the Schedule, with the warning on the afternoon.
    await notice(page).getByRole('button', { name: 'Open schedule', exact: true }).click();
    await openMenu(page, 'Schedule');
    await expect(mark(page, 'afternoon')).toContainText('Not enough stamina');
    // Dismissed, it stays dismissed for that slot, also as the minutes pass.
    await notice(page).getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(notice(page)).toHaveText('');
    await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), MORNING + 20 * MIN);
    await page.waitForTimeout(500);
    await expect(notice(page)).toHaveText('');
    // Task 29 addition: the dismissal survives a reload in the same slot.
    await reloadAt(page, MORNING + 21 * MIN);
    await page.waitForTimeout(800);
    await expect(notice(page)).toHaveText('');
  });

  test('shows no notice when the next slot runs', async ({ page, context }) => {
    await live(context, { owner: aster(74) });
    await openCamp(page, MORNING);
    await openMenu(page, 'Schedule');
    await expect(mark(page, 'afternoon')).toHaveText('Stamina after: 44');
    await expect(notice(page)).toHaveText('');
  });

  test('says on the running card what really runs: a Rest instead of the planned expedition', async ({ page, context }, testInfo) => {
    const owner = aster(12, AFTERNOON_SLOT, state => {
      state.currentActivity = { ...state.currentActivity!, kind: 'rest', label: 'Resting (not enough stamina)' };
    });
    const rests: LiveRest[] = [{ activityId: owner.currentActivity!.id, slotIndex: AFTERNOON_SLOT, requested: { kind: 'expedition', expeditionId: 'woodland' }, fallback: true,
      settled: false, name: 'Aster' }];
    await live(context, { owner, rests });
    await openCamp(page, AFTERNOON);
    const schedule = await openMenu(page, 'Schedule');
    const running = card(page, 'afternoon');
    await expect(running.locator('.running-badge')).toHaveText('Running now');
    await expect(running.getByTestId('running-truth')).toHaveText('Restinginstead of Expedition: not enough staminaPlanned: Expedition · Woodland Path (had 12, needed 30)');
    // Fix round 1: the running card has no quiet "Stamina after" line.
    await expect(mark(page, 'afternoon')).toHaveCount(0);
    await expect(mark(page, 'morning')).toHaveText(/^Stamina after: \d+$/);
    await expect(page.locator('.schedule-running')).toHaveText(/^Afternoon is resting now instead of an Expedition \(not enough stamina\)\. It ends .+\. A change to the afternoon starts with the next afternoon, .+\.$/);
    await expect(schedule).toHaveCSS('opacity', '1'); // a phone's sheet rises in: its contrast is read once it has
    expect(await contrastIssues(running)).toEqual([]);
    await running.getByTestId('running-truth').scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'running-card');
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('keeps the planned card while the next slot is only prepared (the boundary window)', async ({ page, context }) => {
    // The clock is in the afternoon, but the server has processed only the morning: the owner read already holds the afternoon's prepared Rest.
    const owner = aster(12, MORNING_SLOT, state => {
      state.currentActivity = { id: randomUUID(), kind: 'rest', status: 'queued', startsAtMs: AFTERNOON_SLOT * SLOT_MS, endsAtMs: (AFTERNOON_SLOT + 1) * SLOT_MS, label: 'Resting (not enough stamina)' };
    });
    await live(context, { owner, rests: [{ activityId: owner.currentActivity!.id, slotIndex: AFTERNOON_SLOT, requested: { kind: 'expedition', expeditionId: 'woodland' }, fallback: true, settled: false, name: 'Aster' }] });
    await openCamp(page, AFTERNOON_SLOT * SLOT_MS + MIN);
    await openMenu(page, 'Schedule');
    await expect(card(page, 'afternoon').locator('.running-badge')).toHaveText('Running now');
    await page.waitForTimeout(800);
    await expect(card(page, 'afternoon').getByTestId('running-truth')).toHaveCount(0);
    const gladiator = await openMenu(page, 'My gladiator');
    await expect(gladiator).toBeVisible();
    await expect(gladiator.getByText('Resting (not enough stamina)')).toHaveCount(0);
    // Fix round 1: the queued slot reads as being prepared, not "In progress".
    await expect(gladiator.getByRole('status').filter({ hasText: 'Preparing your next activity' })).toBeVisible();
    await expect(gladiator.getByRole('status').filter({ hasText: /^In progress/ })).toHaveCount(0);
  });

  test('pops up while the running slot rests instead, once per slot, also after a reload', async ({ page, context }, testInfo) => {
    const first = restingInstead(AFTERNOON_SLOT);
    const live = await routeAndSeed(context, { owner: first.owner, rests: first.rests });
    await openCamp(page, AFTERNOON);
    await expect(popup(page)).toContainText('STAMINA', { ignoreCase: true });
    await expect(popup(page).locator('p')).toHaveText('Aster is resting instead of the Woodland Path expedition: not enough stamina (had 12, needed 30).');
    await expect(popup(page)).toHaveAttribute('role', 'status');
    // The next slot (the evening's Rest) runs: no pre-slot notice beside it.
    await expect(notice(page)).toHaveText('');
    expect(await fitsWidth(popup(page))).toBe(true);
    expect(await noHorizontalScroll(page)).toBe(true);
    expect(await contrastIssues(popup(page))).toEqual([]);
    if (testInfo.project.name === 'mobile') {
      const { width, room } = await phoneWide(popup(page));
      expect(width).toBeGreaterThanOrEqual(room - 1);
    }
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    await shot(page, testInfo, 'popup');
    // On a 360 px phone the pop-up wraps inside the view: no sideways scroll (both projects; the size is put back for the steps below).
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: 360, height: 740 });
    await expect(popup(page).locator('p')).toBeVisible();
    expect(await fitsWidth(popup(page)), 'the pop-up fits at 360 px').toBe(true);
    expect(await noHorizontalScroll(page), 'no sideways scroll at 360 px').toBe(true);
    await page.setViewportSize(size);
    // Open schedule opens the Schedule, where the running card says the same.
    await popup(page).getByRole('button', { name: 'Open schedule', exact: true }).click();
    await openMenu(page, 'Schedule');
    await expect(card(page, 'afternoon').getByTestId('running-truth')).toContainText('instead of Expedition: not enough stamina');
    // × dismisses it, and it stays dismissed after a reload within the slot.
    await popup(page).getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(popup(page)).toHaveText('');
    await reloadAt(page, AFTERNOON + 10 * MIN);
    await page.waitForTimeout(800);
    await expect(popup(page)).toHaveText('');
    // The next afternoon rests instead again: that slot gets its own pop-up.
    const later = restingInstead(AFTERNOON_SLOT + 3);
    live.setOwner(later.owner);
    live.setRests(later.rests);
    await reloadAt(page, (AFTERNOON_SLOT + 3) * SLOT_MS + 25 * MIN);
    await expect(popup(page).locator('p')).toHaveText('Aster is resting instead of the Woodland Path expedition: not enough stamina (had 12, needed 30).');
  });

  test('says the Training limit in the pop-up', async ({ page, context }) => {
    // The evening's third Training of the game day became a Rest. (A running Rest refills before the next part, so the pre-slot notice cannot
    // hold for the next part at the same time in practice; the two would stack in the column if it did.)
    const owner = aster(100, MORNING_SLOT + 2, state => {
      state.schedule = { morning: { kind: 'training' }, afternoon: { kind: 'training' }, evening: { kind: 'training' } };
      state.currentActivity = { ...state.currentActivity!, kind: 'rest', label: 'Resting' };
    });
    await routeAndSeed(context, { owner, rulesVersion: 'v2',
      rests: [{ activityId: owner.currentActivity!.id, slotIndex: MORNING_SLOT + 2, requested: { kind: 'training' }, fallback: false, settled: false, name: 'Aster' }] });
    await openCamp(page, (MORNING_SLOT + 2) * SLOT_MS + 25 * MIN);
    await expect(popup(page)).toContainText('TRAINING LIMIT', { ignoreCase: true });
    await expect(popup(page).locator('p')).toHaveText('Aster is resting instead of Training: 2 Trainings a game day.');
  });

  test('marks a rest newer than every result as seen, so its dot does not come back', async ({ page, context }) => {
    const now = Date.now(), last = Math.floor(now / SLOT_MS) - 1;
    const owner = aster(104, Math.floor(now / SLOT_MS));
    const rest: LiveRest = { activityId: randomUUID(), slotIndex: last, requested: { kind: 'expedition', expeditionId: 'outpost' }, fallback: true, settled: true, name: 'Aster' };
    const live = await routeAndSeed(context, { owner, rests: [rest] });
    const marks = await serveSeenMarks(context, live, owner);
    await page.goto('/game/');
    await expectOwnerShown(page, 'Aster');
    const panel = page.getByRole('region', { name: 'Messages', exact: true });
    await page.getByTestId('corner-chip').getByRole('button', { name: /^Messages/ }).click();
    await panel.getByRole('tab', { name: /^Notifications/ }).click();
    await expect(panel.locator('[data-rested]')).toHaveCount(1);
    await panel.locator('[data-mark-notes]').click();
    await expect(panel.locator('[data-rested][data-unread]')).toHaveCount(0);
    // The server's mark reached the rest's settled time.
    await expect.poll(() => marks.at(-1)).toBe((last + 1) * SLOT_MS);
    // Reopened after a reload: no dot, and Mark all has nothing to do.
    await page.reload();
    await expectOwnerShown(page, 'Aster');
    await page.getByTestId('corner-chip').getByRole('button', { name: /^Messages/ }).click();
    await panel.getByRole('tab', { name: /^Notifications/ }).click();
    await expect(panel.locator('[data-rested]')).toHaveCount(1);
    await expect(panel.locator('[data-rested][data-unread]')).toHaveCount(0);
    await expect(panel.locator('[data-mark-notes]')).toBeDisabled();
  });

  test("lists the rest in Notifications and on the owner's own Results line; others still read finished resting", async ({ page, context }, testInfo) => {
    const now = Date.now(), last = Math.floor(now / SLOT_MS) - 1;
    const restA = randomUUID(), restB = randomUUID(), other = randomUUID();
    const rests: LiveRest[] = [
      { activityId: restA, slotIndex: last, requested: { kind: 'expedition', expeditionId: 'outpost' }, fallback: true, settled: true, name: 'Aster' },
      { activityId: restB, slotIndex: last - 1, requested: { kind: 'training' }, fallback: false, settled: true, name: 'Aster' },
    ];
    const restRow = (activityId: string, gladiatorId: string, name: string, slot: number): ResultRow => ({ gladiatorId, name,
      summary: { activityId, resolvedKind: 'rest', result: 'completed', success: true, settledAtMs: (slot + 1) * SLOT_MS, replayExpiry: { state: 'expired' } } });
    const recent = [restRow(restA, ownerFixture.gladiatorId, 'Aster', last), restRow(restB, ownerFixture.gladiatorId, 'Aster', last - 1),
      restRow(other, randomUUID(), 'Cassia', last - 1)];
    const notesOwner = aster(104, Math.floor(now / SLOT_MS));
    const transport = await routeAndSeed(context, { owner: notesOwner, rests, recent, rulesVersion: 'v2' });
    await serveSeenMarks(context, transport, notesOwner);
    await page.goto('/game/');
    await expectOwnerShown(page, 'Aster');

    // Notifications: the owner's own rows, with the reason as the line under the title.
    await page.getByTestId('corner-chip').getByRole('button', { name: /^Messages/ }).click();
    const panel = page.getByRole('region', { name: 'Messages', exact: true });
    await panel.getByRole('tab', { name: /^Notifications/ }).click();
    const rows = panel.locator('[data-rested]');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('[data-notification-title]')).toHaveText('Aster rested instead of the Ruined Outpost expedition');
    await expect(rows.nth(0).getByRole('listitem')).toHaveText(['Not enough stamina']);
    await expect(rows.nth(1).locator('[data-notification-title]')).toHaveText('Aster rested instead of Training');
    await expect(rows.nth(1).getByRole('listitem')).toHaveText(['Training limit: 2 a game day']);
    expect(await contrastIssues(panel)).toEqual([]);
    expect(await fitsWidth(rows.nth(0))).toBe(true);
    await shot(page, testInfo, 'notification');
    await page.keyboard.press('Escape');

    // Results, Everyone: the owner's own rows say why; another player's rest still reads only "finished resting".
    const results = await everyoneResults(page);
    const list = results.getByRole('list', { name: 'Recent results' });
    await expect(list.getByRole('listitem').filter({ hasText: 'Aster rested instead of Expedition: not enough stamina' })).toHaveCount(1);
    await expect(list.getByRole('listitem').filter({ hasText: 'Aster rested instead of Training: Training limit, 2 a game day' })).toHaveCount(1);
    await expect(list.getByRole('listitem').filter({ hasText: 'Cassia finished resting' })).toHaveCount(1);
    await expect(list.getByRole('listitem').filter({ hasText: 'Cassia rested instead' })).toHaveCount(0);
    expect(await noHorizontalScroll(page)).toBe(true);
    await shot(page, testInfo, 'results');
  });
});

test.describe('the expedition view after a defeat', () => {
  test.skip(production, 'The camp harness runs on the fixture preview only.');

  test('says the gladiator is on an expedition, resting at the safe return point', async ({ page }, testInfo) => {
    await page.goto(`/expedition/?mode=fixture&activity=${EXPEDITION_FIXTURES.outpost.activityId}&minute=65`);
    await page.waitForFunction(() => !!window.__cloudiatorExpedition?.state(), null, { timeout: 45_000 });
    await expect(page.getByTestId('phase-status')).toHaveText('On an expedition · resting at the safe return point after a defeat');
    await expect(page.getByText('Returning without rewards')).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    await shot(page, testInfo, 'expedition-defeat');
  });
});
