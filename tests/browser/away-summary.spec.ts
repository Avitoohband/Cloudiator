import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures';
import { contrastIssues } from './a11y-helpers';
import { worldFixture, ownerFixture } from '../fixtures/domain';
import { arenaActivityId } from '../fixtures/arena-ids';
import { emptyWorld, routeLiveReads, seedSession, SLOT_MS, SUPABASE_URL } from './live-routes';
import { menuDialog } from './shell-helpers';

test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Uses the fixture camp or development-only player transport.');

const now = worldFixture.serverNowMs;
const minute = 60_000;
const key = 'cloudiator.away-seen.v1';
const id = ownerFixture.gladiatorId;
const away = (page: Page) => page.getByRole('dialog', { name: 'While you were away' });
const fixtureUrl = '/game/?mode=fixture&as=away';
const campReady = (page: Page) => page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true);
const seen = (page: Page) => page.evaluate(({ key, id }) => JSON.parse(localStorage.getItem(key) ?? '{}')[id], { key, id });

async function seedVisit(page: Page, time = now - 1_180 * minute) {
  await page.addInitScript(({ key, id, time }) => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ [id]: time }));
  }, { key, id, time });
}

async function visit(page: Page, url = fixtureUrl) {
  await page.goto(url);
  await campReady(page);
}

test('shows the big day once and marks the results seen on Got it', async ({ page, hasTouch }) => {
  await page.setViewportSize(hasTouch ? { width: 360, height: 780 } : { width: 1280, height: 720 });
  await seedVisit(page);
  await visit(page);
  const dialog = away(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'While you were away' })).toBeFocused();
  await expect(dialog).toContainText(/19 h 40 min/);
  for (const copy of [/12 results/, /Level 6 → 7/, /\+348 XP/, /168 \/ 700 XP/, /\+66 gold/, /\+37 renown/,
    /Arena: 2 won · 1 lost · rating \+14/, /Silver Tournament: 3rd place/, /Ruined Outpost ×5: 4 won/,
    /Wolf Den: your party won/, /Training ×2: \+2 attribute points to spend/, /Rare Find/, /Rested once instead of the Ruined Outpost expedition/,
    /2 new messages/, /answer to your feedback/]) await expect(dialog).toContainText(copy);
  await expect(dialog.getByRole('img', { name: 'Rare Spear (tier 5)' })).toBeVisible();
  await expect.poll(() => seen(page)).toBeGreaterThanOrEqual(now);
  await capture(page, hasTouch, 'big');
  await dialog.getByRole('button', { name: 'Got it' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('corner-chip').locator('[data-messages-button]')).toHaveAccessibleName('Messages, 2 new');
  await page.reload();
  await campReady(page);
  await expect(dialog).toBeHidden();
});

test('opens on a new device from the notification mark and ignores an ordinary fixture visit', async ({ page }) => {
  await visit(page, '/game/?mode=fixture');
  await expect(away(page)).toBeHidden();
  await visit(page);
  await expect(away(page)).toBeVisible();
  await expect(away(page)).toContainText(/2 d/);
});

test('quiet visits stay quiet and advance the record', async ({ page }) => {
  await seedVisit(page, now - 10 * minute);
  await visit(page);
  await expect.poll(() => seen(page)).toBeGreaterThanOrEqual(now);
  await expect(away(page)).toBeHidden();
  await page.evaluate(({ key, id, time }) => localStorage.setItem(key, JSON.stringify({ [id]: time })), { key, id, time: now - 120 * minute });
  await visit(page, fixtureUrl + '&day=empty');
  await expect.poll(() => seen(page)).toBeGreaterThanOrEqual(now);
  await expect(away(page)).toBeHidden();
});

test('never opens for a visitor or signed-in account without a gladiator', async ({ page, context }) => {
  await seedVisit(page);
  await visit(page, '/game/?mode=fixture&as=visitor');
  await expect(away(page)).toBeHidden();
  const user = await seedSession(context);
  await routeLiveReads(context, { world: worldFixture, owner: null, ownerAccountId: user.id });
  await visit(page, '/game/');
  await expect(page.getByRole('dialog', { name: 'Create your gladiator' })).toBeVisible();
  await expect(away(page)).toBeHidden();
});

for (const method of ['close', 'Escape', 'backdrop'] as const) {
  test('dismisses with ' + method + ' and restores camp focus', async ({ page }) => {
    await seedVisit(page);
    await visit(page);
    await expect(away(page)).toBeVisible();
    if (method === 'close') await away(page).getByRole('button', { name: 'Close', exact: true }).click();
    else if (method === 'Escape') await page.keyboard.press('Escape');
    else await page.mouse.click(8, 8);
    await expect(away(page)).toBeHidden();
    await expect(page.locator('[data-camp-view] [role="application"]')).toBeFocused();
    await expect(page.locator('[data-arrival-slot]')).toContainText(/arriv/i);
  });
}

test('waits for the replay opened with the camp', async ({ page }) => {
  await seedVisit(page);
  await visit(page, fixtureUrl + '&view=replay&activity=' + arenaActivityId('ownerHumanWin'));
  const replay = page.getByRole('dialog', { name: 'Replay', exact: true });
  await expect(replay).toBeVisible();
  await expect(away(page)).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(replay).toBeHidden();
  await expect(away(page)).toBeVisible();
});

test('checks again after the tab has been hidden', async ({ page, context }) => {
  let serverNowMs = now;
  const user = await seedSession(context);
  const owner = structuredClone(ownerFixture);
  owner.inbox.notificationsSeenMs = now - 180 * minute;
  const live = await routeLiveReads(context, { world: emptyWorld(now), owner, ownerAccountId: user.id, serverNowMs: () => serverNowMs });
  await seedVisit(page, now - 10 * minute);
  await visit(page, '/game/');
  await expect.poll(() => seen(page)).toBeGreaterThanOrEqual(now);
  await expect(away(page)).toBeHidden();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  serverNowMs = now + 45 * minute;
  live.setNotifications([{ expeditionId: 'woodland', summary: {
    activityId: randomUUID(), receiptId: randomUUID(), resolvedKind: 'expedition', result: 'completed', success: true,
    settledAtMs: now + 30 * minute, replayExpiry: { state: 'expired' },
    rewards: { xp: 0, money: 4, renown: 0, attributePoints: 0, items: [], overflowMoney: 0 },
  } }]);
  await page.evaluate(end => {
    const clock = window.__cloudiatorShell!.clock;
    clock.freeze(end);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, serverNowMs);
  await expect(away(page)).toContainText(/4[45] min/);
  await expect(away(page)).toContainText(/Woodland Path: won/);
  const read = live.requests.find(request => request.table === 'activities' && request.query.get('limit') === '50' && request.query.has('resolved_kind'));
  expect(read?.reader).toBe(user.id);
  expect(read?.query.get('gladiator_id')).toBe('eq.' + id);
});

for (const runningRest of [false, true]) {
  test(`defers the ${runningRest ? 'running Rest popup' : 'next activity warning'} and patch notice`, async ({ page, context }) => {
    const slot = 373_248 + Number(runningRest);
    const end = slot * SLOT_MS + 25 * minute;
    const activityId = randomUUID();
    const user = await seedSession(context);
    const owner = structuredClone(ownerFixture);
    owner.inbox.notificationsSeenMs = end - 180 * minute;
    owner.stamina = { current: 12, maximum: 104 };
    owner.processedSlotIndex = slot;
    owner.currentActivity = { id: activityId, kind: runningRest ? 'rest' : 'training', status: 'active',
      startsAtMs: slot * SLOT_MS, endsAtMs: (slot + 1) * SLOT_MS, label: runningRest ? 'Resting' : 'Training' };
    await routeLiveReads(context, { world: emptyWorld(end), owner, ownerAccountId: user.id, serverNowMs: () => end, latestPatch: '9.0',
      rests: [{ activityId: randomUUID(), slotIndex: slot - 1, requested: { kind: 'expedition', expeditionId: 'woodland' }, fallback: true, settled: true, name: 'Aster' },
        ...(runningRest ? [{ activityId, slotIndex: slot, requested: { kind: 'expedition', expeditionId: 'woodland' }, fallback: true, settled: false, name: 'Aster' }] : [])] });
    await seedVisit(page, end - 120 * minute);
    await visit(page, '/game/');
    const dialog = away(page);
    const stamina = page.locator(runningRest ? '[data-stamina-popup]' : '[data-stamina-notice]');
    const patch = page.getByRole('status').filter({ hasText: /Patch 9\.0/ }).filter({ has: page.getByRole('button', { name: 'Reload', exact: true }) });
    await expect(dialog).toBeVisible();
    await expect(stamina).toHaveText('');
    await expect(patch).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(stamina).toContainText(runningRest ? 'is resting instead of' : 'Not enough stamina for your next Expedition');
    await expect(patch).toBeVisible();
  });
}

test('retries a failed summary on a later return even when a dialog must close first', async ({ page, context }) => {
  const user = await seedSession(context);
  const owner = structuredClone(ownerFixture);
  owner.inbox.notificationsSeenMs = now - 180 * minute;
  await routeLiveReads(context, { world: emptyWorld(now), owner, ownerAccountId: user.id, serverNowMs: () => now,
    rests: [{ activityId: randomUUID(), slotIndex: Math.floor(now / SLOT_MS) - 1, requested: { kind: 'expedition', expeditionId: 'woodland' }, fallback: true, settled: true, name: 'Aster' }] });
  let failed = 0;
  let unavailable = true;
  await context.route(`${SUPABASE_URL}/rest/v1/activities?**`, async route => {
    if (!unavailable || !new URL(route.request().url()).searchParams.has('resolved_kind')) return route.fallback();
    failed += 1;
    await route.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*' }, json: { message: 'Temporary result read failure' } });
  });
  await seedVisit(page, now - 120 * minute);
  await visit(page, '/game/');
  await expect.poll(() => failed).toBeGreaterThan(0);
  await expect(away(page)).toBeHidden();
  expect(await seen(page)).toBe(now - 120 * minute);
  unavailable = false;
  await page.evaluate(() => {
    const modal = Object.assign(document.createElement('dialog'), { id: 'test-return-blocker' });
    document.body.append(modal);
    modal.showModal();
    window.dispatchEvent(new Event('focus'));
  });
  await expect(away(page)).toBeHidden();
  await page.evaluate(() => {
    const modal = document.querySelector<HTMLDialogElement>('#test-return-blocker')!;
    modal.close();
    modal.remove();
  });
  await expect(away(page)).toContainText('Rested once');
});

test('finds the placement of a tournament settled while away when its bout predates the last visit', async ({ page, context }) => {
  const user = await seedSession(context);
  const owner = structuredClone(ownerFixture);
  const since = now - 120 * minute;
  owner.inbox.notificationsSeenMs = since;
  const activityId = randomUUID();
  const olderBouts = Array.from({ length: 21 }, (_, index) => ({
    gladiator_id: id, kind: 'tournament', entry_id: randomUUID(), activity_id: index === 20 ? activityId : randomUUID(),
    fought_at_ms: since - (index + 1) * minute, settled_at_ms: since + 5 * minute,
    result: 'defeat', success: false, league: 'silver', tournament_id: 'tournament:40:silver', round: 'Semifinal', place: 3,
  }));
  await routeLiveReads(context, { world: emptyWorld(now), owner, ownerAccountId: user.id, serverNowMs: () => now, history: olderBouts,
    notifications: [{ summary: { activityId, receiptId: randomUUID(), result: 'defeat', resolvedKind: 'tournament', success: false,
      settledAtMs: since + 5 * minute, replayExpiry: { state: 'expired' },
      rewards: { xp: 0, money: 0, renown: 0, attributePoints: 0, items: [], overflowMoney: 0 } } }] });
  await seedVisit(page, since);
  await visit(page, '/game/');
  await expect(away(page)).toContainText(/Silver Tournament: 3rd place/);
});

test('shows only small-day gains and fits the approved phone sheet', async ({ page, hasTouch }) => {
  await page.setViewportSize(hasTouch ? { width: 360, height: 780 } : { width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seedVisit(page, now - 125 * minute);
  await visit(page, fixtureUrl + '&day=small');
  const dialog = away(page);
  await expect(dialog).toContainText(/2 h 05 min.*1 result/);
  await expect(dialog).toContainText(/Level 6/);
  await expect(dialog).toContainText(/\+75 XP/);
  await expect(dialog).toContainText(/Ruined Outpost: won/);
  await expect(dialog.getByText(/level up|new items|renown|new messages/i)).toHaveCount(0);
  const size = await dialog.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const body = el.querySelector('[data-testid="away-summary-body"]')!;
    return { width: rect.width, bottom: rect.bottom, fits: body.scrollHeight <= body.clientHeight + 1,
      overflow: el.scrollWidth > el.clientWidth, animation: getComputedStyle(el).animationName };
  });
  expect(size.animation).toBe('none');
  expect(size.fits).toBe(true);
  expect(size.overflow).toBe(false);
  expect(await contrastIssues(dialog)).toEqual([]);
  if (hasTouch) {
    expect(size.width).toBe(360);
    expect(size.bottom).toBe(780);
    await expect(page.locator('[data-menu-burger]')).toBeHidden();
    const heights = await dialog.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
  }
  await capture(page, hasTouch, 'small');
});

async function capture(page: Page, phone: boolean, day: 'big' | 'small') {
  const shots = process.env.TASK35_SHOTS;
  if (!shots) return;
  await expect(away(page).getByTestId('profile-look').locator('[data-layer]').first()).toBeVisible();
  await page.screenshot({ path: join(shots, 'task-35-' + (phone ? 'phone' : 'desktop') + '-' + day + '.png'), scale: 'css', animations: 'disabled' });
}

for (const [action, target] of [
  [/^(Open )?My gladiator$/, 'My gladiator'], [/^(See )?[Aa]ll results$/, 'Notifications'], [/^Read$/, 'Messages'], [/^Open schedule$/, 'Schedule'],
] as const) {
  test('routes the ' + target + ' action', async ({ page }) => {
    await seedVisit(page);
    await visit(page);
    const dialog = away(page);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: action }).click();
    await expect(dialog).toBeHidden();
    if (target === 'Notifications' || target === 'Messages') {
      await expect(page.getByRole('tab', { name: new RegExp('^' + target) })).toHaveAttribute('aria-selected', 'true');
    } else await expect(menuDialog(page, target)).toBeVisible();
  });
}
