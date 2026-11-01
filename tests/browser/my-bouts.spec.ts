import { mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page, type TestInfo } from './fixtures';
import type { BattleLog, RevealedStage, RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import { arenaActivityId } from '../fixtures/arena-ids';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { REPLAY_FIXTURES } from '../fixtures/replay-ids';
import { noHorizontalScroll } from './a11y-helpers';
import { SLOT_MS, emptyWorld, routeLiveReads, seedSession, testUser, type LiveTransport } from './live-routes';
import { closeMenu, expectOwnerShown, menuDialog, openMenu, quietArrivals, touchLayout } from './shell-helpers';

// Arena replays Task 4 (spec 1, the approved mockup; plan Review Focus 1 and 5): a player's 📜 Results opens on My bouts, the owner's
// own Arena and tournament bouts, newest first, by day, with the result, the opponent, the renown and the rating, a gold dot until
// watched on this device and ▶ Watch (Result once the replay is gone). Everyone (today's list) is one tab away; a visitor sees it
// alone. The fixture owner Aster's eight bouts, in Etc/GMT-3 and 12-hour form, as the plan's Fixture reference lists them.

test.use({ timezoneId: 'Etc/GMT-3', locale: 'en-US' });

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const KEY = 'cloudiator.bouts-watched.v1';
const VARRO = arenaActivityId('ownerHumanWin');
const MIN = 60_000, DAY = 86_400_000;
test.describe('final review regressions', () => {
  test.skip(production, 'These regressions require the development fixture or routed transport.');
// Final review: real lifecycle transitions through the routed gateway.
for (const empty of [false, true]) test(`final R3 Arena refreshes a ready ${empty ? 'empty' : 'old'} cache on reopen`, async ({ page, context }) => {
  await quietArrivals(context); await seedSession(context);
  const now = Date.now(), old = liveBout(now, 2, 'defeat'), fresh = liveBout(now, 1, 'victory');
  const live = await routeLiveReads(context, { world: emptyWorld(now), owner: ownerFixture, bouts: empty ? [] : [old] });
  await page.goto('/game/'); await expectOwnerShown(page, 'Aster');
  let arena = await openMenu(page, 'Arena');
  await expect.poll(() => boutReads(live).length).toBe(1);
  if (!empty) await expect(names(arena)).toHaveText(['vs Varro']);
  await closeMenu(page); live.setBouts([fresh, old]);
  arena = await openMenu(page, 'Arena');
  await expect(names(arena)).toHaveText(['vs Varro', 'vs Varro']);
  await expect(rows(arena).first().getByText('Won', { exact: true })).toHaveCount(1);
  await expect(rows(arena).nth(1).getByText('Lost', { exact: true })).toHaveCount(1);
  await page.waitForTimeout(500); expect(boutReads(live)).toEqual(['all', 'all']);
});

test('final R2 stops bookmark discovery when the native origin changes before a held page commits', async ({ page, context }, testInfo) => {
  await quietArrivals(context); await seedSession(context);
  const now = Date.now(), bouts = Array.from({ length: 43 }, (_, i) => liveBout(now, i + 1, 'victory'));
  const live = await routeLiveReads(context, { world: emptyWorld(now), owner: ownerFixture, bouts });
  await page.addInitScript(() => {
    const race = { reads: 0, held: false, resume: null as (() => void) | null, origin: null as string | null };
    (window as unknown as { __discovery: typeof race }).__discovery = race;
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetch(...args), url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), location.href);
      if (!url.pathname.endsWith('/visible_events') || !url.searchParams.get('select')?.includes('p0name') || ++race.reads !== 2) return response;
      const body = await response.text();
      Object.defineProperty(response, 'text', { value: async () => {
        await new Promise<void>(resolve => { race.resume = resolve; race.held = true; });
        race.origin = new URL(location.href).searchParams.get('from'); return body;
      } }); return response;
    };
  });
  await page.goto(`/game/?view=replay&activity=${bouts[42].activityId}&from=bouts`);
  await page.waitForFunction(() => (window as unknown as { __discovery: { held: boolean } }).__discovery.held);
  expect(await page.evaluate(() => window.__cloudiatorReplay!.queue())).toBeNull();
  await expect(replayScene(page).locator('[data-bout-counter]')).toHaveCount(0);
  await page.evaluate(() => {
    const url = new URL(location.href); url.searchParams.set('from', 'bouts-lost'); history.pushState({ cloudiatorScene: 1 }, '', url);
    (window as unknown as { __discovery: { resume(): void } }).__discovery.resume();
  });
  await expect.poll(() => boutReads(live).filter(x => x === 'lost').length).toBe(1);
  await nextFrames(page);
  expect(boutReads(live).filter(x => x === 'all')).toHaveLength(2);
  expect(search(page)).toMatchObject({ activity: bouts[42].activityId, from: 'bouts-lost' });
  expect(await page.evaluate(() => window.__cloudiatorReplay!.queue())).toBeNull();
  const observed = await page.evaluate(() => (window as unknown as { __discovery: { origin: string } }).__discovery.origin);
  expect(observed).toBe('bouts-lost');
  await testInfo.attach('native-bookmark-discovery', { body: JSON.stringify({ observed, reads: boutReads(live) }), contentType: 'application/json' });
});

test('final R2 locates an old settled bookmark in newest to oldest order', async ({ page, context }) => {
  await quietArrivals(context); await seedSession(context);
  const now = Date.now(), bouts = Array.from({ length: 23 }, (_, i) => liveBout(now, i + 1, 'victory'));
  const live = await routeLiveReads(context, { world: emptyWorld(now), owner: ownerFixture, bouts });
  await page.goto(`/game/?view=replay&activity=${bouts[21].activityId}&from=bouts`);
  await page.waitForFunction(() => !!window.__cloudiatorReplay);
  await expect.poll(() => page.evaluate(() => window.__cloudiatorReplay?.queue())).toMatchObject({ index: 21, count: 23, previous: bouts[20].activityId, next: bouts[22].activityId });
  expect(boutReads(live)).toEqual(['all', 'all']);
  const length = await page.evaluate(() => history.length);
  await replayScene(page).getByRole('group', { name: 'Replay controls', exact: true }).getByRole('button', { name: 'Next bout', exact: true }).click();
  await expect.poll(() => search(page).activity).toBe(bouts[22].activityId);
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.getByRole('button', { name: 'Back to My bouts', exact: true }).click();
  await expect(replayScene(page)).toHaveCount(0); await expect(menuDialog(page, 'Results')).toBeVisible();
});

for (const signOut of [false, true]) test(`final R5 pending Results choice resets on ${signOut ? 'signout then signin' : 'direct account switch'} with unknown owners`, async ({ page, context }) => {
  await quietArrivals(context); await seedSession(context);
  const now = Date.now(), loss = liveBout(now, 1, 'defeat');
  const live = await routeLiveReads(context, { world: emptyWorld(now), owner: ownerFixture, bouts: [loss] });
  const release = live.hold('owner_state');
  await page.goto(`/game/?view=replay&activity=${loss.activityId}&from=bouts-lost`);
  await expect.poll(() => live.count('owner_state')).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Back to My bouts', exact: true }).click();
  const results = menuDialog(page, 'Results'); await expect(results).toBeVisible();
  if (signOut) {
    await page.evaluate(() => { localStorage.removeItem('sb-127-auth-token'); const c = new BroadcastChannel('sb-127-auth-token'); c.postMessage({ event: 'SIGNED_OUT', session: null }); c.close(); });
    await expect(page.getByTestId('corner-chip').getByRole('button', { name: /^Sign in (with Google )?to join$/ })).toBeVisible();
  }
  const other = testUser('final-brutus@example.invalid'); await seedSession(context, other);
  live.setOwner({ ...structuredClone(ownerFixture), gladiatorId: randomUUID(), name: 'Brutus' }); live.setBouts([]);
  await page.evaluate(user => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = btoa(JSON.stringify({ alg: 'HS256' })) + '.' + btoa(JSON.stringify({ sub: user.id, exp })) + '.test-only';
    const session = { access_token: token, refresh_token: 'test-only:' + user.id, token_type: 'bearer', expires_at: exp, expires_in: 3600, user };
    localStorage.setItem('sb-127-auth-token', JSON.stringify(session)); const c = new BroadcastChannel('sb-127-auth-token'); c.postMessage({ event: 'SIGNED_IN', session }); c.close();
  }, other);
  await expect.poll(() => live.requests.some(r => r.table === 'owner_state' && r.reader === other.id)).toBe(true);
  await expect(results.getByRole('tablist')).toHaveCount(0);
  await page.evaluate(() => {
    const choices: string[] = []; (window as unknown as { __firstChoices: string[] }).__firstChoices = choices;
    new MutationObserver(() => { const chip = document.querySelector('[aria-label="Show bouts"] button[aria-pressed="true"]'); if (chip) choices.push(chip.textContent ?? ''); }).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  release(); await expectOwnerShown(page, 'Brutus');
  await expect(myBoutsTab(results)).toHaveAttribute('aria-selected', 'true'); await expect(chip(results, 'All')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => (window as unknown as { __firstChoices: string[] }).__firstChoices)).not.toContain('Lost');
});
});

/** The fixture world's slot start: Varro's bout (one slot back) settled then, so its replay is kept until 7 days later. */
const SLOT_START = worldFixture.serverNowMs - (worldFixture.serverNowMs % SLOT_MS);
const VARRO_EXPIRY = SLOT_START + 7 * DAY;
const freezeShellClock = (page: Page, ms: number) => page.evaluate(t => window.__cloudiatorShell!.clock.freeze(t), ms);

/** The owner Aster's settled Arena bout against Varro (the fixture PvP log) `slotsAgo` slots before `nowMs`, with its credited summary. */
function liveBout(nowMs: number, slotsAgo: number, result: 'victory' | 'defeat'): RevealedTimeline {
  const activityId = randomUUID();
  const start = (Math.floor(nowMs / SLOT_MS) - slotsAgo) * SLOT_MS, settledAtMs = start + SLOT_MS;
  const log = JSON.parse(readFileSync('tests/fixtures/battles/pvp.json', 'utf8')) as BattleLog;
  const stage = (n: number, kind: RevealedStage['kind'], from: number, to: number, label: string, battleLog?: BattleLog): RevealedStage =>
    ({ id: `${activityId}:${n}`, kind, revealedAtMs: start + from * MIN, startedAtMs: start + from * MIN, endsAtMs: start + to * MIN, label, ...(battleLog ? { battleLog } : {}) });
  const replayExpiry = { state: 'available' as const, expiresAtMs: settledAtMs + 7 * DAY };
  const won = result === 'victory';
  return {
    activityId, serverNowMs: nowMs, visibleThroughMs: nowMs,
    stages: [stage(0, 'staging', 0, 60, 'Warm-up in the arena staging area'), stage(1, 'bout', 60, 80, `Bout: ${result}`, log), stage(2, 'settlement', 80, 80, 'Result credited')],
    summary: { activityId, resolvedKind: 'arena', result, success: won, rewards: { money: 0, renown: won ? 10 : 2, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 },
      receiptId: `my-bouts-${activityId}`, settledAtMs, replayExpiry, ratingDelta: won ? 12 : -11 },
    completion: { activityId, resolvedKind: 'arena', result, success: won, settledAtMs, replayExpiry },
  };
}
/** The My bouts reads the transport answered, by the chip each asked for ('all', 'won' or 'lost'). */
const boutReads = (live: LiveTransport) => live.requests.filter(r => r.table === 'activities' && (r.query.get('select') ?? '').includes('starts_at_ms'))
  .map(r => { const result = r.query.get('summary->>result'); return result === 'eq.victory' ? 'won' : result === 'eq.defeat' ? 'lost' : 'all'; });

type Row = { name: string; tag?: 'NPC' | 'TOURNAMENT'; letter: 'W' | 'L'; sub: string; gone?: boolean };
/** The plan's Fixture reference, newest first, by day. */
const GROUPS: { day: string; rows: Row[] }[] = [
  { day: 'TODAY · SAT 10 OCT', rows: [
    { name: 'vs Varro', letter: 'W', sub: 'Arena · 2:40\xA0AM · +10 renown · Rating +13' },
    { name: 'vs Cassia', letter: 'L', sub: 'Arena · 1:20\xA0AM · +2 renown · Rating −13' },
    { name: 'vs Iron Warden', tag: 'NPC', letter: 'W', sub: 'Arena · 12:00\xA0AM · +3 renown' },
  ] },
  { day: 'FRI 9 OCT', rows: [
    { name: 'vs Bronze Sentinel', tag: 'NPC', letter: 'L', sub: 'Arena · 10:40\xA0PM' },
    { name: 'vs Severus', letter: 'W', sub: 'Arena · 9:20\xA0PM · won on a tie-break · +10 renown · Rating +15' },
  ] },
  { day: 'WED 30 SEP', rows: [{ name: 'Arena bout', letter: 'L', sub: '4:00\xA0AM · replay no longer kept', gone: true }] },
  { day: 'SAT 26 SEP', rows: [{ name: 'Tournament bout', letter: 'L', sub: '9:40\xA0PM · replay no longer kept', gone: true }] },
  { day: 'WED 23 SEP', rows: [{ name: 'Tournament bout', letter: 'W', sub: '9:40\xA0PM · replay no longer kept', gone: true }] },
];

const campReady = (page: Page) => page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
async function openCamp(page: Page, url = '/game/?mode=fixture') {
  await page.goto(url);
  await campReady(page);
}
const replayScene = (page: Page) => page.getByRole('dialog', { name: 'Replay', exact: true });
const myBoutsTab = (results: Locator) => results.getByRole('tab', { name: /^My bouts/ });
const chip = (results: Locator, name: 'All' | 'Won' | 'Lost') => results.getByRole('group', { name: 'Show bouts' }).getByRole('button', { name, exact: true });
const rows = (results: Locator) => results.locator('[data-bout-row]');
const rowOf = (results: Locator, name: string) => results.locator(`[data-bout-row="${name}"]`);
const names = (results: Locator) => results.locator('[data-bout-name]');
const search = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams);
const nextFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
/** Waits for the menu's slide and anything else animating, before a screenshot. */
const settled = async (page: Page) => { await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished))); await nextFrames(page); };

/** Results, opened on My bouts once the owner's list has loaded. */
async function myBouts(page: Page): Promise<Locator> {
  const results = await openMenu(page, 'Results');
  await expect(myBoutsTab(results)).toHaveAttribute('aria-selected', 'true', { timeout: 45_000 });
  await expect(rows(results)).toHaveCount(8, { timeout: 45_000 });
  return results;
}

/** A screenshot for Avi's review, in the test's output and in TASK_SHOTS when set (the task's shots folder). */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  const file = `${name}-${testInfo.project.name}${production ? '-production' : ''}.png`;
  await page.screenshot({ path: testInfo.outputPath(file) });
  if (process.env.TASK_SHOTS) {
    mkdirSync(process.env.TASK_SHOTS, { recursive: true });
    await page.screenshot({ path: `${process.env.TASK_SHOTS}/${file}` });
  }
}

test.describe('My bouts in Results', () => {
  test.skip(production, 'These checks use the fixture preview.');
  test.beforeEach(async ({ context }) => { await quietArrivals(context); });

test('the Arena menu lists my three latest bouts and links to all of them', async ({ page, context }, testInfo) => {
  await quietArrivals(context);
  await openCamp(page);
  const initialResults = await myBouts(page);
  await chip(initialResults, 'Lost').click();
  await initialResults.getByRole('tab', { name: 'Everyone', exact: true }).click();
  await closeMenu(page);
  const arena = await openMenu(page, 'Arena');
  const recent = arena.getByRole('region', { name: 'Your recent bouts', exact: true });
  await expect(names(recent)).toHaveText(['vs Varro', 'vs Cassia', 'vs Iron Warden']);
  await expect(recent.locator('[data-sub]:visible')).toHaveText(['Today, 2:40 AM · Rating +13', 'Today, 1:20 AM · Rating −13', 'Today, 12:00 AM · +3 renown']);
  const current = arena.getByRole('button', { name: 'Your arena bout', exact: true });
  if (await current.count()) expect((await current.boundingBox())!.y).toBeLessThan((await recent.boundingBox())!.y);
  await shot(page, testInfo, 'arena-recent');
  await rows(recent).first().getByRole('button').click();
  await expect(replayScene(page).getByRole('heading', { name: 'Aster vs Varro', exact: true })).toBeVisible();
  await expect(replayScene(page).locator('[data-bout-counter]')).toContainText('1');
  await expect(replayScene(page).locator('[data-bout-counter]')).toContainText('5');
  await page.getByRole('button', { name: 'Back to Arena', exact: true }).click();
  await expect(arena).toBeVisible();
  await expect(rows(recent).first().locator('[data-unwatched-dot]')).toHaveCount(0);
  await recent.getByRole('button', { name: /All my bouts/ }).click();
  const results = menuDialog(page, 'Results');
  await expect(myBoutsTab(results)).toHaveAttribute('aria-selected', 'true');
  await expect(chip(results, 'All')).toHaveAttribute('aria-pressed', 'true');
  await closeMenu(page);
  await openMenu(page, 'Arena');
  await page.setViewportSize({ width: 360, height: 740 });
  await recent.scrollIntoViewIfNeeded();
  expect(await noHorizontalScroll(page)).toBe(true);
  const rects = await recent.getByRole('button').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; }));
  expect(rects.every(r => r.w >= 44 && r.h >= 44)).toBe(true);
  await shot(page, testInfo, 'arena-recent-360');
});

  test('turns a row into a Result row when the clock passes its replay’s expiry', async ({ page }) => {
    // Review fix round 1, Minor 4: the server's time decides, on the shared display clock, without a new read.
    await openCamp(page);
    await freezeShellClock(page, VARRO_EXPIRY - MIN);
    const results = await myBouts(page);
    const first = rows(results).first();
    await expect(first.locator('[data-bout-name]')).toHaveText('vs Varro');
    await expect(first.getByRole('button')).toHaveText('▶ Watch');
    await expect(first.locator('[data-unwatched-dot]')).toHaveCount(1);
    // Every other kept bout settled earlier, so it has gone already: Varro is the one bout not watched.
    await expect(results.getByRole('tab', { name: 'My bouts, 1 not watched', exact: true })).toBeVisible();
    await freezeShellClock(page, VARRO_EXPIRY);
    await expect(first.locator('[data-bout-name]')).toHaveText('Arena bout');
    await expect(first).toHaveAttribute('data-gone', '');
    await expect(first.getByRole('button')).toHaveText('Result');
    await expect(first.getByRole('button')).toHaveAccessibleName('Result: Arena bout, Sat 10 Oct, 2:40\xA0AM');
    await expect(first.locator('[data-sub]:visible')).toHaveText('2:40\xA0AM · replay no longer kept');
    await expect(first.locator('[data-unwatched-dot]')).toHaveCount(0);
    await expect(results.getByRole('tab', { name: 'My bouts', exact: true })).toBeVisible();
    await expect(results.locator('[data-gone]')).toHaveCount(8);
  });

  test('opens Results on My bouts, by day, with the result, the opponent and the rating', async ({ page }, testInfo) => {
    await openCamp(page);
    const results = await myBouts(page);
    await expect(results.getByRole('tab', { name: 'My bouts, 5 not watched', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(results.getByRole('tab', { name: 'Everyone', exact: true })).toHaveAttribute('aria-selected', 'false');
    await expect(results.getByText('Replays are kept 7 days · ● not watched yet', { exact: true })).toBeVisible();
    await expect(chip(results, 'All')).toHaveAttribute('aria-pressed', 'true');
    await expect(results.locator('[data-results-tab="mine"]')).toContainText('5');

    // The day groups, in order, each with its rows.
    const touch = await touchLayout(page);
    const sections = results.locator('[role="tabpanel"] section');
    await expect(sections.locator(':scope > p.eyebrow')).toHaveText(GROUPS.map(g => g.day));
    for (const [n, group] of GROUPS.entries()) {
      const section = sections.nth(n);
      // Each day is a region named by its eyebrow.
      await expect(section).toHaveAccessibleName(group.day);
      const shown = section.locator('[data-bout-row]');
      await expect(shown, group.day).toHaveCount(group.rows.length);
      for (const [i, row] of group.rows.entries()) {
        const item = shown.nth(i);
        await expect(item.locator('[data-bout-name]'), `${n}.${i}`).toHaveText(row.name);
        // The badge says Won or Lost to a screen reader; its letter is the picture.
        await expect(item.getByText(row.letter === 'W' ? 'Won' : 'Lost', { exact: true })).toHaveCount(1);
        if (row.tag) await expect(item.getByText(row.tag, { exact: true })).toBeVisible();
        // The phone's sub-line leaves out the leading kind word.
        const sub = touch && row.sub.startsWith('Arena · ') ? row.sub.slice('Arena · '.length) : row.sub;
        await expect(item.locator(`[data-sub="${touch ? 'narrow' : 'wide'}"]`), `${row.name} sub-line`).toHaveText(sub);
        await expect(item.locator(`[data-sub="${touch ? 'wide' : 'narrow'}"]`)).toBeHidden();
        await expect(item.getByRole('button')).toHaveText(row.gone ? 'Result' : '▶ Watch');
      }
    }
    // Five gold dots, one for each kept replay not watched yet; the three dimmed rows offer Result, named for their day and time.
    await expect(results.locator('[data-unwatched-dot]')).toHaveCount(5);
    await expect(results.getByText('Not watched yet:', { exact: false })).toHaveCount(5);
    await expect(results.locator('[data-gone]')).toHaveCount(3);
    await expect(results.locator('[data-gone]').getByRole('button')).toHaveText(['Result', 'Result', 'Result']);
    await expect(results.getByRole('button', { name: 'Result: Arena bout, Wed 30 Sep, 4:00\xA0AM', exact: true })).toBeVisible();
    await expect(results.getByRole('button', { name: 'Watch: vs Varro, Sat 10 Oct, 2:40\xA0AM', exact: true })).toBeVisible();
    await expect(results.getByRole('button', { name: 'Watch: vs Severus, Fri 9 Oct, 9:20\xA0PM', exact: true })).toBeVisible();
    // Eight bouts are one page: no More.
    await expect(results.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);
    await settled(page);
    await shot(page, testInfo, 'my-bouts');
  });

  test('filters Won and Lost', async ({ page }, testInfo) => {
    await openCamp(page);
    const results = await myBouts(page);
    await chip(results, 'Lost').click();
    await expect(chip(results, 'Lost')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip(results, 'All')).toHaveAttribute('aria-pressed', 'false');
    await expect(names(results)).toHaveText(['vs Cassia', 'vs Bronze Sentinel', 'Arena bout', 'Tournament bout']);
    await expect(results.getByText('Lost', { exact: true }).locator('xpath=ancestor::li[@data-bout-row]')).toHaveCount(4);
    await settled(page);
    await shot(page, testInfo, 'my-bouts-lost');
    await chip(results, 'Won').click();
    await expect(chip(results, 'Won')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip(results, 'Lost')).toHaveAttribute('aria-pressed', 'false');
    await expect(names(results)).toHaveText(['vs Varro', 'vs Iron Warden', 'vs Severus', 'Tournament bout']);
    // The count stays the All list's: five kept bouts not watched.
    await expect(results.getByRole('tab', { name: 'My bouts, 5 not watched', exact: true })).toBeVisible();
    await chip(results, 'All').click();
    await expect(rows(results)).toHaveCount(8);
    // The chip is kept when Results closes and opens again.
    await chip(results, 'Lost').click();
    await expect(names(results)).toHaveCount(4);
    await closeMenu(page);
    await expect(results).toBeHidden();
    const again = await openMenu(page, 'Results');
    await expect(chip(again, 'Lost')).toHaveAttribute('aria-pressed', 'true');
    await expect(names(again)).toHaveText(['vs Cassia', 'vs Bronze Sentinel', 'Arena bout', 'Tournament bout']);
  });

  test('Everyone is today’s list one tab away, and a visitor sees only Everyone', async ({ page }, testInfo) => {
    await openCamp(page);
    const results = await myBouts(page);
    const everyone = results.getByRole('tab', { name: 'Everyone', exact: true });
    await everyone.click();
    await expect(everyone).toHaveAttribute('aria-selected', 'true');
    await expect(results.getByText('RECENT RESULTS', { exact: true })).toBeVisible();
    await expect(results.getByRole('list', { name: 'Recent results' })).toBeVisible();
    await expect(results.getByRole('button', { name: /^Replay: / }).first()).toBeVisible();
    await expect(rows(results)).toHaveCount(0);
    await expect(results.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', (await everyone.getAttribute('id'))!);
    await settled(page);
    await shot(page, testInfo, 'my-bouts-everyone');
    // ARIA tabs: the arrow keys, Home and End move between them, the focus with the selection.
    await everyone.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(myBoutsTab(results)).toBeFocused();
    await expect(myBoutsTab(results)).toHaveAttribute('aria-selected', 'true');
    await expect(rows(results)).toHaveCount(8);
    await page.keyboard.press('End');
    await expect(everyone).toBeFocused();
    await expect(everyone).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(myBoutsTab(results)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(everyone).toHaveAttribute('aria-selected', 'true');
    // Only the selected tab is in the Tab order.
    await expect(everyone).toHaveAttribute('tabindex', '0');
    await expect(myBoutsTab(results)).toHaveAttribute('tabindex', '-1');

    // A visitor: Everyone alone, with no tabs, no chips and no bouts.
    await openCamp(page, '/game/?mode=fixture&as=visitor');
    const visitor = await openMenu(page, 'Results');
    await expect(visitor.getByText('RECENT RESULTS', { exact: true })).toBeVisible();
    await expect(visitor.getByRole('list', { name: 'Recent results' })).toBeVisible();
    await expect(visitor.getByRole('tablist')).toHaveCount(0);
    await expect(visitor.getByRole('group', { name: 'Show bouts' })).toHaveCount(0);
    await expect(rows(visitor)).toHaveCount(0);
  });

  test('Watch opens the bout with ← My bouts and marks it watched on this device', async ({ page }, testInfo) => {
    await openCamp(page);
    let results = await myBouts(page);
    await results.getByRole('button', { name: 'Watch: vs Varro, Sat 10 Oct, 2:40\xA0AM', exact: true }).click();
    const scene = replayScene(page);
    await expect(scene).toBeVisible();
    const back = page.getByRole('button', { name: 'Back to My bouts', exact: true });
    await expect(back).toHaveText('← My bouts');
    expect(search(page)).toMatchObject({ view: 'replay', activity: VARRO, from: 'bouts' });
    await expect(scene.getByRole('heading', { level: 2, name: 'Aster vs Varro' })).toBeVisible({ timeout: 45_000 });
    await back.click();
    await expect(scene).toHaveCount(0);
    await expect(results).toBeVisible();
    await expect(results.getByRole('tab', { name: 'My bouts, 4 not watched', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(rowOf(results, 'vs Varro').locator('[data-unwatched-dot]')).toHaveCount(0);
    await expect(rowOf(results, 'vs Cassia').locator('[data-unwatched-dot]')).toHaveCount(1);
    await expect(results.locator('[data-unwatched-dot]')).toHaveCount(4);
    await settled(page);
    await shot(page, testInfo, 'my-bouts-after-watch');

    // After a reload, the same: the mark is on this device.
    await page.reload();
    await campReady(page);
    results = await myBouts(page);
    await expect(results.getByRole('tab', { name: 'My bouts, 4 not watched', exact: true })).toBeVisible();
    await expect(rowOf(results, 'vs Varro').locator('[data-unwatched-dot]')).toHaveCount(0);
    const marks = await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '[]') as [string, number][], KEY);
    expect(marks.map(([id]) => id)).toContain(VARRO);
    expect(marks.every(([, at]) => Number.isSafeInteger(at))).toBe(true);

    // From Lost, the address names the chip; a reload of the scene then Back opens Results on My bouts with Lost pressed.
    await chip(results, 'Lost').click();
    await expect(names(results)).toHaveCount(4);
    await results.getByRole('button', { name: /^Watch: vs Cassia, / }).click();
    await expect(scene).toBeVisible();
    expect(search(page)).toMatchObject({ activity: arenaActivityId('ownerHumanLoss'), from: 'bouts-lost' });
    await page.reload();
    await campReady(page);
    await expect(scene.getByRole('heading', { level: 2, name: 'Aster vs Cassia' })).toBeVisible({ timeout: 45_000 });
    await expect(back).toHaveText('← My bouts');
    await back.click();
    await expect(scene).toHaveCount(0);
    results = menuDialog(page, 'Results');
    await expect(results).toBeVisible();
    await expect(myBoutsTab(results)).toHaveAttribute('aria-selected', 'true');
    await expect(chip(results, 'Lost')).toHaveAttribute('aria-pressed', 'true');
    await expect(names(results)).toHaveText(['vs Cassia', 'vs Bronze Sentinel', 'Arena bout', 'Tournament bout']);
    await expect(results.getByRole('tab', { name: 'My bouts, 3 not watched', exact: true })).toBeVisible();

    // A row of Everyone still goes back to Everyone, and the browser's Back after a reload does as well.
    await results.getByRole('tab', { name: 'Everyone', exact: true }).click();
    await results.getByRole('button', { name: /^Replay: Aster won an Arena bout/ }).first().click();
    await expect(scene).toBeVisible();
    expect(search(page).from).toBe('results');
    await page.reload();
    await campReady(page);
    await expect(scene).toBeVisible();
    await page.goBack();
    await expect(scene).toHaveCount(0);
    await expect(menuDialog(page, 'Results').getByRole('tab', { name: 'Everyone', exact: true })).toHaveAttribute('aria-selected', 'true');
  });

  test('Result opens the saved outcome of a bout whose replay is gone', async ({ page }, testInfo) => {
    await openCamp(page);
    const results = await myBouts(page);
    await results.getByRole('button', { name: 'Result: Arena bout, Wed 30 Sep, 4:00\xA0AM', exact: true }).click();
    const scene = replayScene(page);
    await expect(scene).toBeVisible();
    expect(search(page)).toMatchObject({ activity: REPLAY_FIXTURES.expired.activityId, from: 'bouts' });
    await expect(scene.getByRole('heading', { level: 2, name: 'Saved outcome: Defeat' })).toBeVisible({ timeout: 45_000 });
    await expect(scene.getByText('The animation for this fight is no longer kept.', { exact: false })).toBeVisible();
    await settled(page);
    await shot(page, testInfo, 'my-bouts-result');
    await page.getByRole('button', { name: 'Back to My bouts', exact: true }).click();
    await expect(scene).toHaveCount(0);
    await expect(myBoutsTab(results)).toHaveAttribute('aria-selected', 'true');
    // A gone bout has no dot to drop: still five not watched.
    await expect(results.getByRole('tab', { name: 'My bouts, 5 not watched', exact: true })).toBeVisible();
  });

  test('keeps working when storage throws', async ({ page }) => {
    // Review Focus 1: private mode or blocked site data. The page keeps its marks in memory, so a dot that went stays gone.
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new DOMException('blocked', 'SecurityError'); };
      Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError'); };
    });
    await openCamp(page);
    const results = await myBouts(page);
    await expect(results.getByRole('tab', { name: 'My bouts, 5 not watched', exact: true })).toBeVisible();
    await results.getByRole('button', { name: 'Watch: vs Varro, Sat 10 Oct, 2:40\xA0AM', exact: true }).click();
    await expect(replayScene(page)).toBeVisible();
    await page.getByRole('button', { name: 'Back to My bouts', exact: true }).click();
    await expect(replayScene(page)).toHaveCount(0);
    await expect(rowOf(results, 'vs Varro').locator('[data-unwatched-dot]')).toHaveCount(0);
    await expect(results.getByRole('tab', { name: 'My bouts, 4 not watched', exact: true })).toBeVisible();
    // Closed and opened again (the list read again), for the page's life.
    await closeMenu(page);
    const again = await myBouts(page);
    await expect(rowOf(again, 'vs Varro').locator('[data-unwatched-dot]')).toHaveCount(0);
    await expect(again.locator('[data-unwatched-dot]')).toHaveCount(4);
    expect(errors).toEqual([]);
  });

  test('phone: tabs, chips and rows fit the sheet', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openCamp(page);
    const results = await myBouts(page);
    // The sub-lines shown leave out the leading kind word.
    const subs = results.locator('[data-sub]:visible');
    await expect(subs).toHaveCount(8);
    for (const sub of await subs.allTextContents()) expect(sub.startsWith('Arena · '), sub).toBe(false);
    await expect(rowOf(results, 'vs Varro').locator('[data-sub]:visible')).toHaveText('2:40\xA0AM · +10 renown · Rating +13');
    await settled(page);
    await shot(page, testInfo, 'my-bouts-390');

    await page.setViewportSize({ width: 360, height: 740 });
    await nextFrames(page);
    expect(await noHorizontalScroll(page)).toBe(true);
    const sheet = (await results.boundingBox())!;
    expect(sheet.x).toBeGreaterThanOrEqual(0);
    expect(sheet.x + sheet.width).toBeLessThanOrEqual(360);
    // Every row's button, chip and tab is a 44 px target, and lies inside the sheet.
    const targets = results.locator('[data-bout-row] button, [role="tab"]').or(results.getByRole('group', { name: 'Show bouts' }).getByRole('button'));
    const count = await targets.count();
    expect(count).toBe(8 + 2 + 3);
    for (let i = 0; i < count; i += 1) {
      const target = targets.nth(i);
      await target.scrollIntoViewIfNeeded();
      const box = (await target.boundingBox())!;
      const what = (await target.getAttribute('aria-label')) ?? (await target.textContent());
      expect(box.height, `${what} height`).toBeGreaterThanOrEqual(44);
      expect(box.x, `${what} left`).toBeGreaterThanOrEqual(sheet.x);
      expect(box.x + box.width, `${what} right`).toBeLessThanOrEqual(sheet.x + sheet.width + 0.5);
    }
    // A row's name and sub-line end before its button.
    const varro = rowOf(results, 'vs Varro');
    const button = (await varro.getByRole('button').boundingBox())!;
    const sub = (await varro.locator('[data-sub]:visible').boundingBox())!;
    expect(sub.x + sub.width).toBeLessThanOrEqual(button.x);
    await results.locator('[data-bout-row]').first().scrollIntoViewIfNeeded();
    await settled(page);
    await shot(page, testInfo, 'my-bouts-360');
    await rowOf(results, 'Arena bout').scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'my-bouts-360-gone');
  });
});

test.describe('My bouts for a signed-in player', () => {
  test.skip(production, 'These signed-in scenarios require the development test client and routed Data API.');
  // The live read through the routed Data API: the owner Aster's two bouts against Varro, a win one slot back and a loss two slots back.
  async function livePlayer(context: Parameters<typeof seedSession>[0]) {
    await seedSession(context);
    const now = Date.now();
    const win = liveBout(now, 1, 'victory'), loss = liveBout(now, 2, 'defeat');
    const live = await routeLiveReads(context, { world: { ...emptyWorld(now), revision: 'my-bouts-live' }, owner: ownerFixture, bouts: [win, loss] });
    return { live, win, loss };
  }

  test('keeps the chip of a scene closed while the owner still loads', async ({ page, context }) => {
    // Review fix round 1, Important 1 (AGENTS.md React async state): Back from a reloaded `from=bouts-lost` scene before the owner read
    // lands. The choice waits for the owner instead of being reset to All when the owner arrives.
    const { live, loss } = await livePlayer(context);
    const release = live.hold('owner_state');
    await page.goto(`/game/?view=replay&activity=${loss.activityId}&from=bouts-lost`);
    const scene = replayScene(page);
    await expect(scene.getByRole('status')).toHaveText('Loading the replay…', { timeout: 45_000 });
    await expect.poll(() => live.count('owner_state'), { timeout: 45_000 }).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Back to My bouts', exact: true }).click();
    await expect(scene).toHaveCount(0);
    // Results opens at once (a public menu): Everyone alone, while the viewer is not known yet.
    const results = menuDialog(page, 'Results');
    await expect(results).toBeVisible();
    await expect(results.getByRole('tablist')).toHaveCount(0);
    release();
    await expectOwnerShown(page, 'Aster');
    await expect(myBoutsTab(results)).toHaveAttribute('aria-selected', 'true', { timeout: 45_000 });
    await expect(chip(results, 'Lost')).toHaveAttribute('aria-pressed', 'true');
    await expect(names(results)).toHaveText(['vs Varro']);
    await expect(rows(results).getByText('Lost', { exact: true })).toHaveCount(1);
    expect(boutReads(live)).not.toContain('won');
  });

  test('reads the bouts once each time Results opens: the chip on screen and All', async ({ page, context }) => {
    // Review fix round 1, Minors 3 and 4: an opening reads the chip shown and All (the tab's count), once; a chip opened later reads
    // itself; the chips not shown are let go, so they are read again when shown.
    const { live } = await livePlayer(context);
    await page.goto('/game/');
    await expectOwnerShown(page, 'Aster');
    const settledReads = async (expected: string[]) => {
      await expect.poll(() => boutReads(live).sort(), { timeout: 45_000 }).toEqual([...expected].sort());
      // And no more come after them.
      await page.waitForTimeout(700);
      expect(boutReads(live).sort()).toEqual([...expected].sort());
    };
    let results = await openMenu(page, 'Results');
    await expect(names(results)).toHaveText(['vs Varro', 'vs Varro']);
    await settledReads(['all']);
    await closeMenu(page);
    results = await openMenu(page, 'Results');
    await expect(names(results)).toHaveCount(2);
    await settledReads(['all', 'all']);
    await chip(results, 'Lost').click();
    await expect(names(results)).toHaveText(['vs Varro']);
    await settledReads(['all', 'all', 'lost']);
    await closeMenu(page);
    results = await openMenu(page, 'Results');
    await expect(chip(results, 'Lost')).toHaveAttribute('aria-pressed', 'true');
    await settledReads(['all', 'all', 'lost', 'all', 'lost']);
    await chip(results, 'Won').click();
    await expect(names(results)).toHaveText(['vs Varro']);
    await settledReads(['all', 'all', 'lost', 'all', 'lost', 'won']);
    // Back to Lost: this opening read it, so a chip change reads nothing more.
    await chip(results, 'Lost').click();
    await settledReads(['all', 'all', 'lost', 'all', 'lost', 'won']);
  });

  test('leaves no bout of the last account after another signs in or the session ends, and starts on My bouts and All', async ({ page, context }) => {
    // Review fix round 1, Minor 4 (Global Constraints: a sign-out or account change drops the owner's list): a new store and a new choice.
    const { live } = await livePlayer(context);
    await page.goto('/game/');
    await expectOwnerShown(page, 'Aster');
    const results = await openMenu(page, 'Results');
    await chip(results, 'Lost').click();
    await expect(names(results)).toHaveText(['vs Varro']);
    // Brutus, with no bouts, signs in in another tab.
    const other = testUser('brutus@example.invalid');
    await seedSession(context, other);
    live.setBouts([]);
    live.setOwner({ ...structuredClone(ownerFixture), gladiatorId: randomUUID(), name: 'Brutus', wallets: { money: 7, renown: 0 } });
    await page.evaluate(user => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const token = `${btoa(JSON.stringify({ alg: 'HS256' }))}.${btoa(JSON.stringify({ sub: user.id, exp }))}.test-only`;
      const session = { access_token: token, refresh_token: `test-only:${user.id}`, token_type: 'bearer', expires_at: exp, expires_in: 3600, user };
      localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
      const channel = new BroadcastChannel('sb-127-auth-token');
      channel.postMessage({ event: 'SIGNED_IN', session });
      channel.close();
    }, other);
    await expectOwnerShown(page, 'Brutus');
    await expect(results).toBeVisible();
    await expect(myBoutsTab(results)).toHaveAttribute('aria-selected', 'true', { timeout: 45_000 });
    await expect(chip(results, 'All')).toHaveAttribute('aria-pressed', 'true');
    await expect(results.getByText('No bouts yet. Your Arena and tournament bouts show here with their replays.', { exact: true })).toBeVisible();
    await expect(rows(results)).toHaveCount(0);
    // Brutus's list was read as Brutus.
    expect(live.requests.some(r => r.table === 'activities' && r.reader === other.id && (r.query.get('select') ?? '').includes('starts_at_ms'))).toBe(true);
    // The session ends in another tab: Everyone alone, no tabs and no bouts.
    await page.evaluate(() => {
      localStorage.removeItem('sb-127-auth-token');
      const channel = new BroadcastChannel('sb-127-auth-token');
      channel.postMessage({ event: 'SIGNED_OUT', session: null });
      channel.close();
    });
    await expect(results.getByRole('tablist')).toHaveCount(0, { timeout: 45_000 });
    await expect(results.getByText('RECENT RESULTS', { exact: true })).toBeVisible();
    await expect(results.getByRole('group', { name: 'Show bouts' })).toHaveCount(0);
    await expect(rows(results)).toHaveCount(0);
  });
});
