import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Locator, type Page } from './fixtures';
import type { RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import type { OwnerState, PublicActor, WorldSnapshot } from '../../supabase/functions/_shared/contracts/reads';
import { EXPEDITION_FIXTURES, EXPEDITION_GLADIATORS, type ExpeditionFixtureKey } from '../fixtures/expedition-ids';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { contrastIssues, expectNamedControls, focusDrops, noHorizontalScroll, watchFocus } from './a11y-helpers';
import { SLOT_MS, SUPABASE_URL, emptyWorld, routeLiveReads, seedSession, type LiveTransport } from './live-routes';
import { closeMenu, cornerChip, expectOwnerShown, openChipMenu, openMenu, quietArrivals, railMenus, revealRail, touchLayout } from './shell-helpers';

// Patch A Task 11 (spec "Item 3 + Task 10", "The button on the camp", the approved mockup; plan Review Focus 2 and 4): while a player's
// gladiator is away on an expedition, a button on the camp says where it is and opens the live view; once it is back, the same button
// offers the whole trip with the player's own result, until the slot after the trip ends or until it is closed. On a phone it sits beside
// the ☰ button. The owner is Aster, routed through the development-only Supabase transport, with the Woodland and Outpost fixture
// timelines; the shared display clock is held (`window.__cloudiatorShell.clock`) at the minute a test is about.

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const MIN = 60_000;
const CLOSED_KEY = 'cloudiator.trip-closed.v1';
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const TIMELINES = { woodland: readJson('tests/fixtures/expeditions/woodland.json'), outpost: readJson('tests/fixtures/expeditions/outpost.json') } as Record<'woodland' | 'outpost', RevealedTimeline>;
type Key = keyof typeof TIMELINES;
const idOf = (key: ExpeditionFixtureKey) => EXPEDITION_FIXTURES[key].activityId;
const startOf = (key: Key) => TIMELINES[key].stages[0].startedAtMs;
const ASTER = EXPEDITION_GLADIATORS.aster;
const PLACE = { woodland: 'Woodland Path', outpost: 'Ruined Outpost' } as const;

/** Aster's public actor: away on the expedition (a trip running), or in camp (once it is back). */
const asterActor = (key: Key, at: 'trip' | 'camp'): PublicActor => ({ ...worldFixture.actors[0], gladiatorId: ASTER.id, name: 'Aster',
  location: at === 'trip' ? `expedition:${key}` : 'camp', activityId: at === 'trip' ? idOf(key) : null, activityStatus: at === 'trip' ? 'active' : 'idle',
  startsAtMs: at === 'trip' ? startOf(key) : null, endsAtMs: at === 'trip' ? startOf(key) + SLOT_MS : null, visibleStage: null, resting: false });
/** The owner on its trip (`running`), or resting in the slot after it with the result not yet seen. */
function ownerOf(key: Key, state: 'running' | 'after', over: Partial<OwnerState> = {}): OwnerState {
  const start = startOf(key);
  const currentActivity: OwnerState['currentActivity'] = state === 'running'
    ? { id: idOf(key), kind: 'expedition', status: 'active', startsAtMs: start, endsAtMs: start + SLOT_MS, label: PLACE[key] }
    : { id: randomUUID(), kind: 'rest', status: 'active', startsAtMs: start + SLOT_MS, endsAtMs: start + 2 * SLOT_MS, label: 'Resting in camp' };
  return { ...structuredClone(ownerFixture), processedSlotIndex: Math.floor(start / SLOT_MS) + (state === 'after' ? 1 : 0), currentActivity,
    inbox: { ...ownerFixture.inbox, newNotifications: state === 'after' ? 1 : 0 }, ...over };
}
const worldOf = (key: Key, state: 'running' | 'after', at: number, extra: PublicActor[] = []): WorldSnapshot =>
  ({ ...emptyWorld(at), revision: `away-${key}-${state}`, actors: [asterActor(key, state === 'running' ? 'trip' : 'camp'), ...extra] });

/** A signed-in player's live camp: the owner, the world, the timelines and the settled results, with the server held at `at`. */
async function live(context: BrowserContext, { key, state, at, extra, over, withResult = state === 'after' }: { key: Key; state: 'running' | 'after'; at: number; extra?: PublicActor[]; over?: Partial<OwnerState>; withResult?: boolean }): Promise<LiveTransport> {
  await seedSession(context);
  await quietArrivals(context);
  // The owner's settled result is one `activities` row, which the notifications list and the timeline's owner summary both read: it is given
  // once, as a notification, so the timeline carries none of its own.
  const { summary, ...timeline } = structuredClone(TIMELINES[key]);
  const notifications = withResult && summary ? [{ summary, expeditionId: key }] : [];
  return routeLiveReads(context, { world: worldOf(key, state, at, extra), owner: ownerOf(key, state, over), timelines: { [idOf(key)]: withResult ? timeline : { ...timeline, summary } }, notifications, serverNowMs: () => at });
}

const awayButton = (page: Page) => page.getByTestId('away-button');
const awayMain = (page: Page) => awayButton(page).locator('[data-away-main]');
const dismiss = (page: Page) => awayButton(page).getByRole('button', { name: 'Dismiss', exact: true });
const expeditionDialog = (page: Page) => page.getByRole('dialog', { name: 'Expedition', exact: true });
const backToCamp = (page: Page) => page.getByRole('button', { name: 'Back to camp' });
const search = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams);
type Box = { x: number; y: number; width: number; height: number };
const boxOf = async (locator: Locator): Promise<Box> => (await locator.boundingBox())!;
/** Whether two boxes share no area (half a pixel of rounding allowed). */
const clear = (a: Box, b: Box) => a.x >= b.x + b.width - 0.5 || b.x >= a.x + a.width - 0.5 || a.y >= b.y + b.height - 0.5 || b.y >= a.y + a.height - 0.5;
const burger = (page: Page) => page.getByRole('button', { name: 'Menus', exact: true });
/** Holds the shared display clock at `ms`, which the button (and a scene opened over the camp) show. */
const hold = (page: Page, ms: number) => page.evaluate(at => window.__cloudiatorShell!.clock.freeze(at), ms);

/**
 * How many lines the first occurrence of `needle` in the button's text is drawn on (a range over the text, which may run across the
 * spans holding it): 1 when it is kept whole, 2 when a line break falls inside it.
 */
const linesOf = (scope: Locator, needle: string) => scope.evaluate((root, text) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let all = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) { nodes.push(node as Text); all += (node as Text).data; }
  const at = all.indexOf(text);
  if (at < 0) throw new Error(`"${text}" is not in "${all}"`);
  const locate = (offset: number): [Text, number] => {
    let seen = 0;
    for (const node of nodes) { if (offset <= seen + node.data.length) return [node, offset - seen]; seen += node.data.length; }
    throw new Error('offset out of range');
  };
  const range = document.createRange();
  range.setStart(...locate(at));
  range.setEnd(...locate(at + text.length));
  return new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top))).size;
}, needle);

/** A camp click on `id`'s body, centred at zoom 2 (the click a player makes on a gladiator), which opens its profile card. */
async function clickInCamp(page: Page, id: string) {
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
  const actor = (await page.evaluate(() => window.__cloudiatorCamp!.state()!)).actors.find(a => a.id === id)!;
  await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 2), { x: actor.x, y: actor.y });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  const at = (await page.evaluate(x => window.__cloudiatorCamp!.screenOf(x), id))!;
  const box = (await page.locator('canvas').boundingBox())!;
  await page.mouse.click(box.x + at.x, box.y + at.y - 16);
}

/** Opens the camp as the signed-in owner, with the display clock held at `at`. */
async function openCamp(page: Page, at: number, url = '/game/') {
  await page.goto(url);
  await expectOwnerShown(page, 'Aster');
  await page.waitForFunction(() => window.__cloudiatorShell?.clock.synced() === true, null, { timeout: 45_000 });
  await hold(page, at);
}

test.describe('the away button on the camp', () => {
  test.skip(production, 'The away button checks use the development-only intercepted Supabase transport and fixture timelines.');

  test('shows where my gladiator is and opens the live view', async ({ page, context }) => {
    const start = startOf('woodland');
    await live(context, { key: 'woodland', state: 'running', at: start + 30 * MIN });
    await watchFocus(page);
    await openCamp(page, start + 30 * MIN);
    const compact = await touchLayout(page);

    // Where the gladiator is, how far the trip is, and what is next.
    await expect(awayButton(page)).toBeVisible();
    await expect(awayButton(page)).toHaveAttribute('data-state', 'running');
    await expect(awayMain(page)).toContainText(compact ? 'Aster · Woodland Path' : 'Aster is on the Woodland Path');
    await expect(awayMain(page)).toContainText(compact ? 'Minute 30 of 80' : 'Minute 30 of 80 · next fight at minute 40');
    if (compact) await expect(awayMain(page)).not.toContainText('next fight');
    await expect(awayMain(page)).toContainText(compact ? '● Live' : '● Watch live');
    await expect(awayMain(page).locator('b')).toHaveText('Aster');
    // Closing is for a trip that is over: nothing to dismiss while it runs.
    await expect(dismiss(page)).toHaveCount(0);
    expect(await contrastIssues(awayButton(page))).toEqual([]);
    await expectNamedControls(awayButton(page), 'the away button');

    // Watch live opens the live view over the camp (no `play`), at the held minute.
    await awayMain(page).click();
    await expect(expeditionDialog(page)).toBeVisible();
    await expect(expeditionDialog(page).getByTestId('live-badge')).toContainText(compact ? 'LIVE' : 'LIVE · minute 30');
    expect(search(page)).toEqual({ view: 'expedition', activity: idOf('woodland') });
    // The button gives way to the scene, and is back with Back to camp, which gives the focus back to it.
    await expect(awayButton(page)).toHaveCount(0);
    await backToCamp(page).click();
    await expect(expeditionDialog(page)).toHaveCount(0);
    expect(search(page)).toEqual({});
    await expect(awayButton(page)).toBeVisible();
    await expect(awayMain(page)).toBeFocused();
    expect(await focusDrops(page)).toEqual([]);
  });

  test('offers the whole trip once back, with my own result, until I close it', async ({ page, context }) => {
    const start = startOf('woodland');
    const at = start + SLOT_MS + 10 * MIN;
    await live(context, { key: 'woodland', state: 'after', at });
    await watchFocus(page);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await openCamp(page, at);
    const compact = await touchLayout(page);

    await expect(awayButton(page)).toHaveAttribute('data-state', 'back');
    await expect(awayMain(page)).toContainText(compact ? 'Aster · back from Woodland Path' : 'Aster is back from the Woodland Path');
    // The owner's own settled result (the fixture summary: 20 gold and 100 XP; the items are not named).
    await expect(awayMain(page)).toContainText('Success · +20 gold · +100 XP');
    await expect(awayMain(page)).toContainText(compact ? '▶ Replay' : '▶ Watch the whole trip');
    await expect(awayButton(page).locator('i')).toHaveCount(0);
    expect(await contrastIssues(awayButton(page))).toEqual([]);
    await expectNamedControls(awayButton(page), 'the away button, back');

    // The whole trip: the replay at its first chapter.
    await awayMain(page).click();
    await expect(expeditionDialog(page)).toBeVisible();
    await expect(expeditionDialog(page).getByTestId('replay-badge')).toContainText(compact ? '▶ REPLAY' : '▶ REPLAY · THE WHOLE TRIP');
    expect(search(page)).toEqual({ view: 'expedition', activity: idOf('woodland'), play: 'trip' });
    await backToCamp(page).click();
    await expect(awayButton(page)).toBeVisible();

    // × closes it, with the keyboard too (the focus is not left on the page), and a reload keeps it closed on this device.
    await dismiss(page).focus();
    await page.keyboard.press('Enter');
    await expect(awayButton(page)).toHaveCount(0);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '[]'), CLOSED_KEY)).toEqual([idOf('woodland')]);
    expect(await focusDrops(page)).toEqual([]);
    await page.reload();
    await expectOwnerShown(page, 'Aster');
    await page.waitForFunction(() => window.__cloudiatorShell?.clock.synced() === true, null, { timeout: 45_000 });
    await hold(page, at);
    await page.waitForTimeout(600);
    await expect(awayButton(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('shows a lost trip with no rewards, and the result still processing while it is', async ({ page, context }) => {
    const start = startOf('outpost');
    // The Outpost trip is over (minute 85) and settled in the slot after it; the owner's result: a defeat, nothing earned, all gear kept.
    const timeline = TIMELINES.outpost;
    const lostSummary = { activityId: idOf('outpost'), resolvedKind: 'expedition' as const, result: 'defeat' as const, success: false, receiptId: 'receipt-lost', settledAtMs: start + SLOT_MS + 45_000,
      rewards: { money: 0, renown: 0, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 }, replayExpiry: { state: 'available' as const, expiresAtMs: start + 8 * SLOT_MS } };
    const at = start + SLOT_MS + 5 * MIN;
    await seedSession(context);
    await quietArrivals(context);
    const transport = await routeLiveReads(context, { world: worldOf('outpost', 'after', at), owner: ownerOf('outpost', 'after'), timelines: { [idOf('outpost')]: structuredClone(timeline) },
      notifications: [{ summary: lostSummary, expeditionId: 'outpost' }], serverNowMs: () => at });
    await openCamp(page, at);
    const compact = await touchLayout(page);
    await expect(awayMain(page)).toContainText(compact ? 'Aster · back after a defeat' : 'Aster is back after a defeat on the Ruined Outpost');
    await expect(awayMain(page)).toContainText('No rewards · all gear kept');

    // The trip is over and still the owner's current activity, with no result yet: processing.
    transport.setOwner(ownerOf('outpost', 'running'));
    transport.setNotifications([]);
    transport.setWorld({ ...worldOf('outpost', 'running', at), revision: 'away-processing' });
    await page.waitForTimeout(2_200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(awayMain(page)).toContainText('Processing results…', { timeout: 15_000 });
    await expect(awayMain(page)).toContainText(compact ? 'Aster · back from Ruined Outpost' : 'Aster is back from the Ruined Outpost');
    await expect(awayMain(page)).not.toContainText('No rewards');
  });

  test('says the next fight is off after a revealed defeat, and reads the owner’s timeline once after each fight’s minute', async ({ page, context }) => {
    const start = startOf('outpost');
    let serverNow = start + 30 * MIN;
    await seedSession(context);
    await quietArrivals(context);
    const transport = await routeLiveReads(context, { world: worldOf('outpost', 'running', serverNow), owner: ownerOf('outpost', 'running'),
      timelines: { [idOf('outpost')]: structuredClone(TIMELINES.outpost) }, serverNowMs: () => serverNow });
    const timelineReads = () => transport.requests.filter(r => r.table === 'visible_events' && r.query.get('activity_id') === `eq.${idOf('outpost')}`).length;
    await openCamp(page, start + 30 * MIN);
    // Minute 30: the first fight is won, the second still ahead.
    const wide = !(await touchLayout(page));
    await expect(awayMain(page)).toContainText(wide ? 'Aster is on the Ruined Outpost' : 'Aster · Ruined Outpost');
    if (wide) await expect(awayMain(page)).toContainText('Minute 30 of 80 · next fight at minute 40');
    const first = timelineReads();
    expect(first, 'the timeline is read when the button appears').toBeGreaterThanOrEqual(1);
    // Minute 40 (the fight is on): the same fights bucket, so no new read and no news.
    serverNow = start + 40 * MIN + 5_000;
    await hold(page, start + 40 * MIN);
    if (wide) await expect(awayMain(page)).toContainText('Minute 40 of 80 · next fight at minute 60');
    await page.waitForTimeout(700);
    expect(timelineReads()).toBe(first);
    // Minute 45: after the fight's minute the timeline is read once more, and it shows the lost fight: no next fight, back at minute 80.
    serverNow = start + 45 * MIN;
    await hold(page, start + 45 * MIN);
    if (wide) await expect(awayMain(page)).toContainText('Minute 45 of 80 · back at minute 80');
    else await expect(awayMain(page)).toContainText('Minute 45 of 80');
    await expect.poll(timelineReads).toBe(first + 1);
    // And it stays so for the rest of the trip.
    await hold(page, start + 65 * MIN);
    if (wide) await expect(awayMain(page)).toContainText('Minute 65 of 80 · back at minute 80');
    await page.waitForTimeout(500);
    expect(timelineReads()).toBeLessThanOrEqual(first + 2);
  });

  test('a later notifications read wins over an earlier slow one', async ({ page, context }) => {
    const start = startOf('woodland');
    const at = start + SLOT_MS + 10 * MIN;
    // The owner rests after a trip whose result is not in its notifications yet: the first read (empty) is slow.
    const transport = await live(context, { key: 'woodland', state: 'after', at, withResult: false });
    let releaseStale!: () => void;
    const stale = new Promise<void>(resolve => { releaseStale = resolve; });
    let served = 0, answeredLate = false;
    await context.route(`${SUPABASE_URL}/rest/v1/activities**`, async route => {
      const request = route.request();
      if (request.method() !== 'GET' || !request.url().includes('requested') || served > 0) return route.fallback();
      served += 1;
      await stale;
      answeredLate = true;
      // What the server answered before the result was credited: no settled result at all.
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: '[]' });
    });
    await openCamp(page, at);
    await expect.poll(() => served).toBe(1);
    await expect(awayButton(page)).toHaveCount(0);
    // The trip is credited: the owner's current activity changes and its result is listed. The newer read shows it.
    transport.setNotifications([{ summary: structuredClone(TIMELINES.woodland.summary!), expeditionId: 'woodland' }]);
    transport.setOwner(ownerOf('woodland', 'after', { currentActivity: { id: randomUUID(), kind: 'rest', status: 'active', startsAtMs: start + SLOT_MS, endsAtMs: start + 2 * SLOT_MS, label: 'Resting in camp' } }));
    transport.setWorld({ ...worldOf('woodland', 'after', at), revision: 'away-credited' });
    await page.waitForTimeout(2_200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(awayMain(page)).toContainText('Success · +20 gold · +100 XP', { timeout: 15_000 });
    // The slow read answers last, with what was true before: it must not take the button away.
    releaseStale();
    await expect.poll(() => answeredLate).toBe(true);
    await page.waitForTimeout(800);
    await expect(awayMain(page)).toContainText('Success · +20 gold · +100 XP');
  });

  test('stays closed for the page’s life when the device’s storage throws', async ({ page, context }) => {
    const start = startOf('woodland');
    const at = start + SLOT_MS + 10 * MIN;
    const transport = await live(context, { key: 'woodland', state: 'after', at });
    // Only this key is refused (the session lives in the same storage): a private window's or a blocked site's behaviour.
    await context.addInitScript(key => {
      const read = Storage.prototype.getItem, write = Storage.prototype.setItem;
      Storage.prototype.getItem = function (name: string) { if (name === key) throw new Error('blocked'); return read.call(this, name); };
      Storage.prototype.setItem = function (name: string, value: string) { if (name === key) throw new Error('blocked'); return write.call(this, name, value); };
    }, CLOSED_KEY);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await openCamp(page, at);
    await expect(awayButton(page)).toBeVisible();
    await dismiss(page).click();
    await expect(awayButton(page)).toHaveCount(0);
    // A new revision reads the owner (in a new activity) and the notifications again: the button does not come back while this page lives.
    transport.setOwner(ownerOf('woodland', 'after', { currentActivity: { id: randomUUID(), kind: 'rest', status: 'active', startsAtMs: start + SLOT_MS, endsAtMs: start + 2 * SLOT_MS, label: 'Resting in camp' } }));
    transport.setWorld({ ...worldOf('woodland', 'after', at), revision: 'away-reread' });
    const reads = transport.count('activities');
    await page.waitForTimeout(2_200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => transport.count('activities')).toBeGreaterThan(reads);
    await page.waitForTimeout(500);
    await expect(awayButton(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('ends with the slot after the trip, and is never offered for a trip settled earlier', async ({ page, context }) => {
    const start = startOf('woodland');
    const at = start + 2 * SLOT_MS + 5 * MIN;
    // The Woodland trip settled two slots ago: the owner has long been resting, and the button is gone.
    await live(context, { key: 'woodland', state: 'after', at });
    await openCamp(page, at);
    await page.waitForTimeout(1_200);
    await expect(awayButton(page)).toHaveCount(0);
    // Back in the slot after the trip the same camp offers it.
    await hold(page, start + SLOT_MS + 10 * MIN);
    await expect(awayButton(page)).toBeVisible();
    // And the minute the slot after the trip ends, it goes.
    await hold(page, start + 2 * SLOT_MS);
    await expect(awayButton(page)).toHaveCount(0);
  });

  test('shows nothing to a visitor', async ({ page, context }) => {
    const start = startOf('woodland');
    // A visitor's live camp, with Aster away: public reads only, and no button.
    const visitor = await routeLiveReads(context, { world: worldOf('woodland', 'running', start + 30 * MIN), serverNowMs: () => start + 30 * MIN });
    await quietArrivals(context);
    await page.goto('/game/');
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true && (window.__cloudiatorCamp.world()?.actors.length ?? 0) > 0, null, { timeout: 45_000 });
    await page.waitForTimeout(800);
    await expect(awayButton(page)).toHaveCount(0);
    expect(visitor.requests.every(r => r.reader === null)).toBe(true);
    expect(visitor.count('activities')).toBe(0);
  });

  test('is hidden while a scene is open, the live view or the whole trip, and comes back with the camp', async ({ page, context }) => {
    const start = startOf('woodland');
    await live(context, { key: 'woodland', state: 'running', at: start + 30 * MIN });
    // Opened by a link (no camp entry below it): the button is not drawn behind it.
    await openCamp(page, start + 30 * MIN, `/game/?view=expedition&activity=${idOf('woodland')}`);
    await expect(expeditionDialog(page)).toBeVisible();
    await expect(awayButton(page)).toHaveCount(0);
    await backToCamp(page).click();
    await expect(expeditionDialog(page)).toHaveCount(0);
    await expect(awayButton(page)).toBeVisible();
    await page.goto(`/game/?view=expedition&activity=${idOf('woodland')}&play=trip`);
    await expectOwnerShown(page, 'Aster');
    await expect(expeditionDialog(page)).toBeVisible();
    await expect(awayButton(page)).toHaveCount(0);
  });

  test('desktop: bottom centre, and beside an open menu panel, never under it', async ({ page, context }) => {
    const start = startOf('woodland');
    await live(context, { key: 'woodland', state: 'running', at: start + 30 * MIN });
    await page.setViewportSize({ width: 1280, height: 720 });
    await openCamp(page, start + 30 * MIN);
    test.skip(await touchLayout(page), 'The touch layout has its own placement (the phone test).');
    const away = await boxOf(awayButton(page));
    expect(away.width).toBeLessThanOrEqual(540.5);
    expect(away.width).toBeGreaterThan(480);
    expect(Math.abs(away.x + away.width / 2 - 640), 'centred in the window').toBeLessThanOrEqual(1.5);
    expect(720 - (away.y + away.height), 'its distance from the bottom edge').toBeGreaterThanOrEqual(20);
    expect(720 - (away.y + away.height)).toBeLessThanOrEqual(28);
    // With a panel open it keeps clear of it, on its right.
    const panel = await openMenu(page, 'My gladiator');
    await expect(awayButton(page)).toBeVisible();
    const beside = await boxOf(awayButton(page));
    expect(clear(beside, await boxOf(panel))).toBe(true);
    expect(beside.x).toBeGreaterThanOrEqual((await boxOf(panel)).x + (await boxOf(panel)).width);
    // In a window too narrow to hold it beside the panel, it waits for the panel to close.
    await page.setViewportSize({ width: 800, height: 720 });
    await expect(awayButton(page)).toBeHidden();
    await panel.locator('[data-menu-close]').click();
    await expect(awayButton(page)).toBeVisible();
    const narrow = await boxOf(awayButton(page));
    expect(narrow.x).toBeGreaterThanOrEqual(11.5);
    expect(narrow.x + narrow.width).toBeLessThanOrEqual(800 - 11.5);
  });

  test('phone: beside ☰, hidden under a sheet or the icon row', async ({ page, context }) => {
    const start = startOf('woodland');
    const ursa: PublicActor = { ...worldFixture.actors[0], gladiatorId: 'a0000000-0000-4000-8000-000000000001', name: 'Ursa', classId: 'guardian', location: 'orientation',
      activityId: null, activityStatus: 'active', startsAtMs: start + 28 * MIN, endsAtMs: start + 28 * MIN + SLOT_MS };
    await live(context, { key: 'woodland', state: 'running', at: start + 30 * MIN, extra: [ursa] });
    // The arrival banner is wanted here: it shares the screen with the button.
    await page.addInitScript(() => { try { localStorage.removeItem('cloudiator.arrivals-seen.v1'); } catch { /* none */ } });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/game/?signin=failed');
    await expectOwnerShown(page, 'Aster');
    await page.waitForFunction(() => window.__cloudiatorShell?.clock.synced() === true, null, { timeout: 45_000 });
    await hold(page, start + 30 * MIN);
    await expect(awayButton(page)).toBeVisible();

    // Beside ☰: its left a little right of ☰'s right edge, its bottom at ☰'s bottom.
    const away = await boxOf(awayButton(page)), menu = await boxOf(burger(page));
    expect(away.x).toBeGreaterThanOrEqual(menu.x + menu.width + 8 - 0.5);
    expect(Math.abs(away.y + away.height - (menu.y + menu.height))).toBeLessThanOrEqual(2);
    expect(away.x + away.width).toBeLessThanOrEqual(390 - 12 + 0.5);
    expect(away.height).toBeGreaterThanOrEqual(44);
    await expect(awayMain(page)).toContainText('Aster · Woodland Path');
    await expect(awayMain(page)).toContainText('Minute 30 of 80');
    await expect(awayMain(page)).toContainText('● Live');

    // Under the banner, the notice, the chip and its open menu: no overlap, at 360 × 740.
    await page.setViewportSize({ width: 360, height: 740 });
    await expect(page.getByTestId('arrival-banner')).toBeVisible();
    await expect(page.getByText('Google sign-in could not be completed')).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    const small = await boxOf(awayButton(page));
    expect(small.x + small.width, 'its right edge').toBeLessThanOrEqual(348.5);
    const smallBurger = await boxOf(burger(page));
    expect(clear(small, smallBurger)).toBe(true);
    expect(small.x).toBeGreaterThanOrEqual(smallBurger.x + smallBurger.width + 8 - 0.5);
    for (const [what, locator] of [['the arrival banner', page.getByTestId('arrival-banner')], ['the sign-in notice', page.getByText('Google sign-in could not be completed')], ['the chip', cornerChip(page)]] as const) {
      expect(clear(small, await boxOf(locator)), `no overlap with ${what}`).toBe(true);
    }
    const menuOfChip = await openChipMenu(page);
    expect(clear(small, await boxOf(menuOfChip)), 'no overlap with the chip’s open menu').toBe(true);
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.keyboard.press('Escape');

    // Under a sheet it is hidden (it is not in the way of the sheet). Closing the sheet leaves the icon row, which takes its place: the
    // button is back when ☰ hides the row.
    await openMenu(page, 'Results');
    await expect(awayButton(page)).toBeHidden();
    await closeMenu(page);
    await expect(railMenus(page)).toBeVisible();
    await expect(awayButton(page)).toBeHidden();
    await burger(page).click();
    await expect(railMenus(page)).toBeHidden();
    await expect(awayButton(page)).toBeVisible();
    // Under the icon row ☰ reveals: the row takes its place.
    await revealRail(page);
    await expect(awayButton(page)).toBeHidden();
    await burger(page).click();
    await expect(awayButton(page)).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('phone: the back state and a long name fit 360 × 740 beside ☰', async ({ page, context }) => {
    const start = startOf('woodland');
    const at = start + SLOT_MS + 10 * MIN;
    await live(context, { key: 'woodland', state: 'after', at, over: { name: 'Quintus Maximilianus' } });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/game/');
    await expectOwnerShown(page, 'Quintus Maximilianus');
    await page.waitForFunction(() => window.__cloudiatorShell?.clock.synced() === true, null, { timeout: 45_000 });
    await hold(page, at);
    await expect(awayButton(page)).toBeVisible();
    await expect(awayMain(page)).toContainText('Quintus Maximilianus · back from Woodland Path');
    expect(await noHorizontalScroll(page)).toBe(true);
    const away = await boxOf(awayButton(page)), menu = await boxOf(burger(page));
    expect(clear(away, menu)).toBe(true);
    expect(away.x).toBeGreaterThanOrEqual(menu.x + menu.width + 8 - 0.5);
    expect(away.x + away.width).toBeLessThanOrEqual(348.5);
    expect(away.y).toBeGreaterThanOrEqual(740 - 14 - 96);
    // The × is a 44 px target, and the main button too.
    expect((await boxOf(dismiss(page))).width).toBeGreaterThanOrEqual(43.5);
    expect((await boxOf(dismiss(page))).height).toBeGreaterThanOrEqual(43.5);
    expect((await boxOf(awayMain(page))).height).toBeGreaterThanOrEqual(43.5);
    // Each part of the line under the name stays whole: "+100 XP" is not split between two lines.
    for (const part of ['Success', '+20 gold', '+100 XP']) expect(await linesOf(awayButton(page), part), `"${part}" on one line`).toBe(1);
  });

  test('phone: hidden while a profile card covers the bottom, and back when it closes', async ({ page, context }) => {
    const start = startOf('woodland');
    const at = start + SLOT_MS + 10 * MIN;
    // The worst case for the card's sheet: the tallest pill (the back state with a 20-character name), and a gladiator in camp to click.
    const corvina: PublicActor = { ...worldFixture.actors[0], gladiatorId: 'a0000000-0000-4000-8000-0000000000c1', name: 'Corvina', classId: 'duelist', location: 'camp',
      activityId: null, activityStatus: 'active', startsAtMs: at - 4_000_000, endsAtMs: at + 800_000, visibleStage: null, resting: false };
    await live(context, { key: 'woodland', state: 'after', at, extra: [corvina], over: { name: 'Quintus Maximilianus' } });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/game/');
    await expectOwnerShown(page, 'Quintus Maximilianus');
    await page.waitForFunction(() => window.__cloudiatorShell?.clock.synced() === true, null, { timeout: 45_000 });
    await hold(page, at);
    await expect(awayButton(page)).toBeVisible();
    // A camp click on Corvina opens her card as a sheet above ☰ (bottom 76 px), which would cover the top of the pill: the pill gives way.
    await clickInCamp(page, corvina.gladiatorId);
    const card = page.getByRole('dialog', { name: 'Profile: Corvina', exact: true });
    await expect(card).toBeVisible();
    expect((await boxOf(card)).y + (await boxOf(card)).height).toBeGreaterThan(740 - 76 - 1);
    await expect(awayButton(page)).toBeHidden();
    expect(await noHorizontalScroll(page)).toBe(true);
    // Closing the card brings it back.
    await card.getByRole('button', { name: 'Close profile' }).click();
    await expect(card).toHaveCount(0);
    await expect(awayButton(page)).toBeVisible();
  });

  test('desktop: at 830 px the back state fits beside an open panel with its ×, and below that it waits', async ({ page, context }) => {
    const start = startOf('woodland');
    const at = start + SLOT_MS + 10 * MIN;
    await live(context, { key: 'woodland', state: 'after', at });
    await page.setViewportSize({ width: 830, height: 720 });
    await openCamp(page, at);
    test.skip(await touchLayout(page), 'The touch layout has its own placement (the phone tests).');
    const panel = await openMenu(page, 'My gladiator');
    await expect(awayButton(page)).toBeVisible();
    // The panel takes the left 458 px (its 66 px start, its 380 px width, and 12 px of air): the pill is what is left, 360 px with 12 px of margin.
    const away = await boxOf(awayButton(page)), beside = await boxOf(panel);
    expect(Math.abs(away.x - 458), 'its left edge').toBeLessThanOrEqual(1);
    expect(Math.abs(away.width - 360), 'its width').toBeLessThanOrEqual(1);
    expect(Math.abs(away.x + away.width - (830 - 12)), 'its right edge, 12 px from the window').toBeLessThanOrEqual(1);
    expect(clear(away, beside)).toBe(true);
    // Everything in it fits: the × inside the pill, the text and the action not cut off.
    const cross = await boxOf(dismiss(page)), main = await boxOf(awayMain(page));
    expect(cross.x).toBeGreaterThanOrEqual(away.x - 0.5);
    expect(cross.x + cross.width).toBeLessThanOrEqual(away.x + away.width + 0.5);
    expect(main.x + main.width).toBeLessThanOrEqual(cross.x + 0.5);
    expect(await awayMain(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await noHorizontalScroll(page)).toBe(true);
    // One pixel less and there is no room beside the panel: it waits for the panel to close.
    await page.setViewportSize({ width: 829, height: 720 });
    await expect(awayButton(page)).toBeHidden();
    await page.setViewportSize({ width: 830, height: 720 });
    await expect(awayButton(page)).toBeVisible();
  });
});
