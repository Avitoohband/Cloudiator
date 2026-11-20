import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures';
import { contrastIssues, expectNamedControls } from './a11y-helpers';
import { worldFixture, ownerFixture } from '../fixtures/domain';
import { arenaActivityId } from '../fixtures/arena-ids';
import { emptyWorld, routeLiveReads, seedSession, SLOT_MS, SUPABASE_URL, type LiveNotification } from './live-routes';
import { campReady, menuDialog, openMenu, spendSuggestedPoints } from './shell-helpers';

test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Uses the fixture camp or development-only player transport.');

const now = worldFixture.serverNowMs;
const minute = 60_000;
const key = 'cloudiator.away-seen.v1';
const id = ownerFixture.gladiatorId;
const away = (page: Page) => page.getByRole('dialog', { name: 'While you were away' });
const fixtureUrl = '/game/?mode=fixture&as=away';
const seen = (page: Page) => page.evaluate(({ key, id }) => JSON.parse(localStorage.getItem(key) ?? '{}')[id], { key, id });
const slotOf = (time: number) => Math.floor((time - 1) / SLOT_MS);

function result(kind: LiveNotification['summary']['resolvedKind'], settledAtMs: number, items: LiveNotification['summary']['rewards']['items'] = []): LiveNotification {
  return { ...(kind === 'expedition' ? { expeditionId: 'woodland' } : {}), summary: {
    activityId: randomUUID(), receiptId: randomUUID(), resolvedKind: kind, result: 'completed', success: true, settledAtMs,
    replayExpiry: { state: 'expired' }, rewards: { xp: 0, money: 4, renown: 1, attributePoints: 0, items, overflowMoney: 0 },
    ...(kind === 'dungeon' ? { dungeon: { id: 'wolf-den', terminalFight: 4, partyWon: true } as const } : {}),
  } };
}

async function expectFits(page: Page, bodyMayScroll = false) {
  const dialog = away(page);
  await expect(dialog).toBeVisible();
  if (!bodyMayScroll) {
    await expect.poll(() => dialog.getByTestId('away-summary-body').evaluate(body => body.scrollHeight - body.clientHeight)).toBeLessThanOrEqual(1);
  }
  const lines = dialog.getByRole('listitem');
  expect(await lines.count()).toBeGreaterThan(0);
  expect(await lines.evaluateAll(rows => rows.flatMap(row => {
    const text = row.lastElementChild as HTMLElement;
    const style = getComputedStyle(text);
    return text.scrollWidth > text.clientWidth || style.textOverflow === 'ellipsis' || style.whiteSpace === 'nowrap'
      ? [{ text: text.textContent, width: text.clientWidth, content: text.scrollWidth, overflow: style.textOverflow, whitespace: style.whiteSpace }] : [];
  })), 'each result wraps without truncation').toEqual([]);
  if (page.viewportSize()!.width === 360) {
    const lefts = await lines.evaluateAll(rows => rows.map(row => row.getBoundingClientRect().left));
    expect(new Set(lefts).size, 'phone result lines stay in one column').toBe(1);
  }
  for (const name of [/^(Open )?My gladiator$/, /^(See )?[Aa]ll results$/, /^Got it$/]) {
    await expect(dialog.getByRole('button', { name })).toBeInViewport({ ratio: 1 });
  }
  await expectNamedControls(dialog, 'away summary');
  expect(await contrastIssues(dialog)).toEqual([]);
}

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
  await expectFits(page);
  await expect(dialog.getByTestId('away-summary-item').first()).toHaveAccessibleName('Rare Spear (tier 5)');
  expect(await seen(page)).toBe(now - 1_180 * minute);
  await capture(page, hasTouch, 'big');
  await dialog.getByRole('button', { name: 'Got it' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => seen(page)).toBeGreaterThanOrEqual(now);
  await expect(page.getByTestId('corner-chip').locator('[data-messages-button]')).toHaveAccessibleName('Messages, 2 new');
  await page.reload();
  await campReady(page);
  await expect(dialog).toBeHidden();
});

test('a background owner read failure leaves the summary open and Got it still marks the results', async ({ page, context }) => {
  const user = await seedSession(context);
  const since = now - 120 * minute;
  const owner = structuredClone(ownerFixture);
  owner.inbox.notificationsSeenMs = since;
  const note = result('expedition', now - 15 * minute);
  const world = emptyWorld(now);
  const live = await routeLiveReads(context, { world, owner, notifications: [note], ownerAccountId: user.id, serverNowMs: () => now });
  const marks: number[] = [];
  await context.route(`${SUPABASE_URL}/functions/v1/game-command`, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const command = route.request().postDataJSON();
    if (command.kind !== 'see-notifications') return route.fallback();
    marks.push(command.upToMs);
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, json: { ok: true, value: { seenMs: command.upToMs } } });
  });
  await seedVisit(page, since);
  await visit(page, '/game/');
  await expect(away(page)).toBeVisible();
  live.fail('owner_state');
  live.setWorld({ ...world, revision: 'away-owner-error' });
  const failed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/owner_state') && !response.ok());
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await failed;
  await expect(away(page).getByRole('button', { name: 'Got it' })).toBeEnabled();
  expect(await seen(page)).toBe(since);
  await away(page).getByRole('button', { name: 'Got it' }).click();
  await expect.poll(() => marks).toEqual([note.summary.settledAtMs]);
  await expect.poll(() => seen(page)).toBeGreaterThanOrEqual(now);
});

test('Got it records dismissal time while results settled with the summary open stay in Notifications', async ({ page, context }) => {
  await page.clock.install();
  const user = await seedSession(context);
  const since = now - 120 * minute;
  let serverNow = now;
  const owner = structuredClone(ownerFixture);
  owner.inbox = { ...owner.inbox, notificationsSeenMs: since, unread: 0, newNotifications: 1 };
  const first = result('expedition', now - 15 * minute);
  const later = result('training', now + 30 * minute);
  const live = await routeLiveReads(context, { world: emptyWorld(now), owner, notifications: [first], ownerAccountId: user.id, serverNowMs: () => serverNow });
  const marks: number[] = [];
  await context.route(`${SUPABASE_URL}/functions/v1/game-command`, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const command = route.request().postDataJSON();
    if (command.kind !== 'see-notifications') return route.fallback();
    marks.push(command.upToMs);
    owner.inbox.notificationsSeenMs = command.upToMs;
    owner.inbox.newNotifications = 1;
    live.setOwner(owner);
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, json: { ok: true, value: { seenMs: command.upToMs } } });
  });
  await seedVisit(page, since);
  await visit(page, '/game/');
  const dialog = away(page);
  await expect(dialog).toContainText('1 result');
  serverNow += 45 * minute;
  live.setNotifications([later, first]);
  await page.evaluate(time => window.__cloudiatorShell!.clock.freeze(time), serverNow);
  await expect(dialog).toBeVisible();
  expect(await seen(page)).toBe(since);
  await dialog.getByRole('button', { name: 'Got it' }).click();
  await expect.poll(() => marks).toEqual([first.summary.settledAtMs]);
  await expect.poll(() => seen(page)).toBe(serverNow);
  await page.clock.fastForward(60_000);
  await expect(dialog).toBeHidden();
  await page.getByTestId('corner-chip').locator('[data-messages-button]').click();
  const panel = page.getByRole('region', { name: 'Messages', exact: true });
  await expect(panel.getByRole('tab', { name: /^Notifications/ })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('Training finished')).toBeVisible();
});

test('another tab dismisses an open copy at its cutoff without any storage write back', async ({ page }) => {
  await seedVisit(page);
  await visit(page);
  const dialog = away(page);
  await expect(dialog).toBeVisible();
  const dispatch = (time: number) => page.evaluate(async ({ key, id, time }) => {
    localStorage.setItem(key, JSON.stringify({ [id]: time }));
    const original = Storage.prototype.setItem;
    let writes = 0;
    Storage.prototype.setItem = function (name, value) { if (name === key) writes++; original.call(this, name, value); };
    try {
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify({ [id]: time }), storageArea: localStorage }));
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return writes;
    } finally { Storage.prototype.setItem = original; }
  }, { key, id, time });
  expect(await dispatch(now - 1)).toBe(0);
  await expect(dialog).toBeVisible();
  expect(await dispatch(now)).toBe(0);
  await expect(dialog).toBeHidden();
  expect(await seen(page)).toBe(now);
  await expect(page.locator('[data-camp-view] [role="application"]')).toBeFocused();
});

test('reload while the summary is open shows it again without saving the visit', async ({ page }) => {
  const since = now - 1_180 * minute;
  await seedVisit(page, since);
  await visit(page);
  await expect(away(page)).toContainText('12 results');
  expect(await seen(page)).toBe(since);
  await page.reload();
  await campReady(page);
  await expect(away(page)).toContainText('12 results');
  expect(await seen(page)).toBe(since);
});

test('a six-item day with two dungeons and Arena uses wrapped single-column results without dense mode', async ({ page, context, hasTouch }) => {
  await page.setViewportSize(hasTouch ? { width: 360, height: 780 } : { width: 1280, height: 720 });
  const user = await seedSession(context);
  const since = now - 120 * minute;
  const owner = structuredClone(ownerFixture);
  owner.inbox.notificationsSeenMs = since;
  const items = Array.from({ length: 6 }, () => ({ catalogId: 'spear:5:common', catalogVersion: 'v1' as const, tier: 5 as const, rarity: 'common' as const, quantity: 1 }));
  const arena = [12, -10, 12].map((ratingDelta, index) => {
    const note = result('arena', now - (index + 5) * minute);
    note.summary.result = ratingDelta > 0 ? 'victory' : 'defeat';
    note.summary.ratingDelta = ratingDelta;
    return note;
  });
  await routeLiveReads(context, { world: emptyWorld(now), owner, notifications: [
    result('expedition', now - minute, items), result('dungeon', now - 2 * minute), result('dungeon', now - 3 * minute), ...arena,
  ], ownerAccountId: user.id, serverNowMs: () => now });
  await seedVisit(page, since);
  await visit(page, '/game/');
  const dialog = away(page);
  await expect(dialog).not.toHaveAttribute('data-dense');
  await expect(dialog).toContainText('Arena: 2 won · 1 lost · rating +14');
  await expect(dialog.getByRole('listitem').filter({ hasText: /^Arena:/ })).toHaveCount(1);
  await expect(dialog.getByRole('listitem').filter({ hasText: /^Wolf Den:/ })).toHaveCount(2);
  await expect(dialog.getByTestId('away-summary-item')).toHaveCount(6);
  await expectFits(page);
});

test('fits a week of tournament and dungeon results with the footer in view', async ({ page, context, hasTouch }) => {
  await page.setViewportSize(hasTouch ? { width: 360, height: 780 } : { width: 1280, height: 720 });
  const user = await seedSession(context);
  const since = now - 7 * 24 * 60 * minute;
  const owner = structuredClone(ownerFixture);
  owner.inbox.notificationsSeenMs = since;
  owner.inbox.unread = 1;
  owner.titles = ['rare-find', 'victor', 'tiro'].map(id => ({ id, earnedAtMs: now - SLOT_MS, activityId: null, source: 'result', detail: null }));
  const item = (rarity: 'common' | 'rare') => ({ catalogId: `spear:5:${rarity}`, catalogVersion: 'v1' as const, tier: 5 as const, rarity, quantity: 1 });
  const tournaments = Array.from({ length: 7 }, (_, index) => result('tournament', now - (index * 9 + 1) * SLOT_MS));
  const dungeons = Array.from({ length: 7 }, (_, index) => result('dungeon', now - (index * 9 + 2) * SLOT_MS,
    index === 6 ? [item('rare')] : Array.from({ length: 2 }, () => item('common'))));
  const history = tournaments.map(({ summary }) => ({ gladiator_id: id, kind: 'tournament', entry_id: randomUUID(), activity_id: summary.activityId,
    fought_at_ms: summary.settledAtMs - 2 * minute, settled_at_ms: summary.settledAtMs, result: 'victory', success: true,
    league: 'silver', tournament_id: `tournament:${slotOf(summary.settledAtMs)}:silver`, round: 'Final', place: 1 }));
  const extra: LiveNotification[] = [result('arena', now - 3 * SLOT_MS), result('training', now - 4 * SLOT_MS),
    ...(['woodland', 'outpost', 'mountain'] as const).map((expeditionId, index) => ({
      ...result('expedition', now - (5 + index) * SLOT_MS), expeditionId,
    }))];
  extra[0].summary.rewards.overflowMoney = 4;
  await routeLiveReads(context, { world: emptyWorld(now), owner, notifications: [...tournaments, ...dungeons, ...extra], history,
    rests: [{ activityId: randomUUID(), slotIndex: slotOf(now) - 8, requested: { kind: 'expedition', expeditionId: 'woodland' }, fallback: true, settled: true, name: 'Aster' }],
    messages: [{ id: 1124, kind: 'team-reply', title: 'We replied', preview: 'Thanks for writing in', body: [], action: null, publishedAtMs: now - SLOT_MS }],
    ownerAccountId: user.id, serverNowMs: () => now });
  await seedVisit(page, since);
  await visit(page, '/game/');
  const dialog = away(page);
  await expect(dialog).toContainText('19 results');
  await expect(dialog).toContainText(/5 more dungeon runs.*9 items/);
  await expect(dialog).toContainText('5 more tournaments');
  for (const name of ['Rare Find', 'Victor', 'Tiro']) await expect(dialog.getByText(name, { exact: true })).toBeVisible();
  await expect(dialog).toContainText('Bag full');
  await expect(dialog.getByTestId('away-summary-item').first()).toHaveAccessibleName('Rare Spear (tier 5)');
  const copy = await dialog.getByRole('listitem').allTextContents();
  const tournamentMore = copy.findIndex(line => line.includes('5 more tournaments'));
  const dungeonMore = copy.findIndex(line => line.includes('5 more dungeon runs'));
  expect(copy[tournamentMore - 1]).toContain('Silver Tournament: 1st place');
  expect(copy[dungeonMore - 1]).toContain('Wolf Den: your party won');
  await expectFits(page, hasTouch);
  await capture(page, hasTouch, 'week');
  for (const name of ['Open schedule', 'Read']) {
    const action = dialog.getByRole('button', { name, exact: true });
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole('button', { name: 'Got it' })).toBeInViewport({ ratio: 1 });
  }
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

test('a storage event does not write a heartbeat back to the other tab', async ({ page }) => {
  await seedVisit(page, now - 10 * minute);
  await visit(page, fixtureUrl + '&day=empty');
  await expect.poll(() => seen(page)).toBeGreaterThanOrEqual(now);
  const writes = await page.evaluate(({ key, id }) => {
    const mark = JSON.parse(localStorage.getItem(key)!)[id];
    const original = Storage.prototype.setItem;
    let writes = 0;
    Storage.prototype.setItem = function (name, value) { if (name === key) writes++; original.call(this, name, value); };
    try {
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify({ [id]: mark }), storageArea: localStorage }));
      return writes;
    } finally { Storage.prototype.setItem = original; }
  }, { key, id });
  expect(writes).toBe(0);
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

test('the visit that creates a gladiator writes its record and never opens the summary', async ({ page, context }) => {
  const user = await seedSession(context);
  const since = now - 120 * minute;
  const owner = structuredClone(ownerFixture);
  owner.inbox.notificationsSeenMs = since;
  const live = await routeLiveReads(context, { world: emptyWorld(now), owner: null, ownerAccountId: user.id,
    serverNowMs: () => now, notifications: [result('training', now - 10 * minute)] });
  await context.route(`${SUPABASE_URL}/functions/v1/game-command`, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const command = route.request().postDataJSON();
    if (command.kind !== 'create-character') return route.fallback();
    live.setOwner({ ...owner, name: command.name });
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, json: { ok: true, receiptId: randomUUID(), value: { gladiatorId: id } } });
  });
  await seedVisit(page, since);
  await visit(page, '/game/');
  const creation = page.getByRole('dialog', { name: 'Create your gladiator' });
  await creation.getByRole('textbox', { name: /name/i }).fill('New Fighter');
  await spendSuggestedPoints(page);
  await creation.getByRole('button', { name: 'Create gladiator', exact: true }).click();
  await expect(creation).toBeHidden();
  await expect.poll(() => seen(page)).toBeGreaterThanOrEqual(now);
  await expect(away(page)).toBeHidden();
  expect(live.requests.filter(request => request.table === 'activities' && request.query.get('limit') === '50')).toHaveLength(0);
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

test('retries a failed summary after the clock wakes without focus or visibility events', async ({ page, context }) => {
  const user = await seedSession(context);
  const since = now - 120 * minute;
  let serverNow = now;
  const owner = structuredClone(ownerFixture);
  owner.inbox.notificationsSeenMs = since;
  await routeLiveReads(context, { world: emptyWorld(now), owner, notifications: [result('expedition', now - 15 * minute)], ownerAccountId: user.id,
    serverNowMs: () => serverNow });
  let unavailable = true;
  const failed = page.waitForResponse(response => !response.ok() && new URL(response.url()).searchParams.get('limit') === '50');
  await context.route(`${SUPABASE_URL}/rest/v1/activities?**`, async route => {
    if (!unavailable || new URL(route.request().url()).searchParams.get('limit') !== '50') return route.fallback();
    await route.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*' }, json: { message: 'Temporary failure' } });
  });
  await seedVisit(page, since);
  await visit(page, '/game/');
  await failed;
  await expect(away(page)).toBeHidden();
  serverNow += 45 * minute;
  unavailable = false;
  await page.evaluate(end => window.__cloudiatorShell!.clock.freeze(end), serverNow);
  await expect(away(page)).toContainText('Woodland Path: won');
});

test('My gladiator opens Overview when the previous visit left a different section selected', async ({ page, context }) => {
  const user = await seedSession(context);
  const owner = structuredClone(ownerFixture);
  owner.inbox.notificationsSeenMs = now - 2 * minute;
  let serverNow = now;
  const live = await routeLiveReads(context, { world: emptyWorld(now), owner, ownerAccountId: user.id, serverNowMs: () => serverNow });
  await seedVisit(page, now - 2 * minute);
  await visit(page, '/game/');
  const menu = await openMenu(page, 'My gladiator');
  await menu.getByRole('button', { name: 'Go to section: History' }).click();
  await expect(menu.getByRole('button', { name: 'Go to section: History' })).toHaveAttribute('aria-current', 'step');
  await menu.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(menu).toBeHidden();
  serverNow += 45 * minute;
  live.setNotifications([result('expedition', now + 30 * minute)]);
  await page.evaluate(end => window.__cloudiatorShell!.clock.freeze(end), serverNow);
  await away(page).getByRole('button', { name: /^(Open )?My gladiator$/ }).click();
  await expect(menu.getByRole('button', { name: 'Go to section: Overview' })).toHaveAttribute('aria-current', 'step');
});

// Patch 1.9.2: when the Training line says points wait ("to spend"), Open My gladiator opens Worn equipment at Plan a build, where they are spent:
// the heading at the top of the menu, with the focus. Without points waiting it opens the Overview, as above.
test('Open My gladiator opens Worn equipment at Plan a build when Training left points to spend (1.9.2)', async ({ page, context }) => {
  const user = await seedSession(context);
  const owner = structuredClone(ownerFixture);
  owner.inbox.notificationsSeenMs = now - 2 * minute;
  owner.progression = { ...owner.progression, earnedAttributePoints: 12, unspentAttributePoints: 2 };
  let serverNow = now;
  const live = await routeLiveReads(context, { world: emptyWorld(now), owner, ownerAccountId: user.id, serverNowMs: () => serverNow });
  await seedVisit(page, now - 2 * minute);
  await visit(page, '/game/');
  serverNow += 45 * minute;
  const trained = result('training', now + 30 * minute);
  trained.summary.rewards.attributePoints = 2;
  live.setNotifications([trained]);
  await page.evaluate(end => window.__cloudiatorShell!.clock.freeze(end), serverNow);
  await expect(away(page)).toContainText(/Training: \+2 attribute points to spend/);
  await away(page).getByRole('button', { name: /^(Open )?My gladiator$/ }).click();
  await expect(away(page)).toBeHidden();
  const menu = menuDialog(page, 'My gladiator');
  await expect(menu.getByRole('button', { name: 'Go to section: Worn equipment' })).toHaveAttribute('aria-current', 'step');
  const heading = menu.getByRole('heading', { name: 'Plan a build', exact: true });
  await expect(heading).toBeFocused();
  // (Read once the phone sheet has risen: boxes measured during its rise move between two reads.)
  await menu.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
  const body = (await menu.getByTestId('menu-body').boundingBox())!, top = (await heading.boundingBox())!;
  expect(top.y).toBeGreaterThanOrEqual(body.y - 1);
  expect(top.y).toBeLessThan(body.y + 40);
  await expect(menu.locator('.build-counter')).toHaveText('2 of 12 left');
});

test('uses the shared return read for a newly earned title', async ({ page, context }) => {
  let serverNowMs = now;
  const user = await seedSession(context);
  const owner = structuredClone(ownerFixture);
  owner.inbox.notificationsSeenMs = now - 180 * minute;
  const live = await routeLiveReads(context, { world: emptyWorld(now), owner, ownerAccountId: user.id, serverNowMs: () => serverNowMs });
  let releaseOwner!: () => void;
  const held = new Promise<void>(resolve => { releaseOwner = resolve; });
  let attempts = 0;
  let returning = false;
  await context.route(`${SUPABASE_URL}/rest/v1/owner_state?**`, async route => {
    if (returning) {
      attempts += 1;
      await held;
    }
    await route.fallback();
  });
  await page.clock.install();
  await seedVisit(page, now - 10 * minute);
  await visit(page, '/game/');
  await expect.poll(() => seen(page)).toBeGreaterThanOrEqual(now);
  await page.clock.fastForward(2_500);
  const before = await seen(page);
  serverNowMs = now + 45 * minute;
  owner.titles = [{ id: 'rare-find', earnedAtMs: now + 30 * minute, source: 'result', activityId: null, detail: null }];
  live.setOwner(owner);
  returning = true;
  try {
    await page.evaluate(end => {
      window.__cloudiatorShell!.clock.freeze(end);
      window.dispatchEvent(new Event('focus'));
    }, serverNowMs);
    await expect.poll(() => attempts).toBeGreaterThan(0);
    await expect(away(page)).toBeHidden();
    expect(await seen(page)).toBe(before);
  } finally {
    releaseOwner();
  }
  await expect(away(page)).toContainText('Rare Find');
  expect(attempts).toBe(1);
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

test('stops after three tournament history pages and keeps the run without a place', async ({ page, context }) => {
  const user = await seedSession(context);
  const owner = structuredClone(ownerFixture);
  const since = now - 120 * minute;
  owner.inbox.notificationsSeenMs = since;
  const note = result('tournament', since + 10 * minute);
  const history = Array.from({ length: 61 }, (_, index) => ({ gladiator_id: id, kind: 'tournament', entry_id: randomUUID(),
    activity_id: index === 60 ? note.summary.activityId : randomUUID(), fought_at_ms: since - index * minute,
    settled_at_ms: since + 5 * minute, result: 'defeat', success: false, league: 'silver', tournament_id: 'tournament:40:silver', round: 'Semifinal', place: 3 }));
  const live = await routeLiveReads(context, { world: emptyWorld(now), owner, ownerAccountId: user.id, serverNowMs: () => now, history, notifications: [note] });
  await seedVisit(page, since);
  await visit(page, '/game/');
  await expect(away(page)).toContainText('Tournament: finished');
  expect(live.count('gladiator_history_reads')).toBe(3);
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

async function capture(page: Page, phone: boolean, day: 'big' | 'small' | 'week') {
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
