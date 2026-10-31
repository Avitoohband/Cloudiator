import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page, type TestInfo } from './fixtures';
import { arenaActivityId } from '../fixtures/arena-ids';
import { REPLAY_FIXTURES } from '../fixtures/replay-ids';
import type { BattleLog, RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import { ownerFixture } from '../fixtures/domain';
import { SLOT_MS, emptyWorld, routeLiveReads, seedSession } from './live-routes';
import { noHorizontalScroll } from './a11y-helpers';
import { expectOwnerShown, menuDialog, openMenu, quietArrivals, touchLayout } from './shell-helpers';

// Arena replays Task 5 (spec 2, the approved mockup; plan Review Focus 1, 4 and 5): one replay viewer with Patch A's bar (▶/⏸, a
// track, the time, a speed this device remembers and ⚑ Result), the result card on the arena at the end with ↺ Watch again and the
// way back, keys, an eyebrow that never says the result, and a phone layout that shows who won without scrolling. The fixture owner
// Aster's bouts in Etc/GMT-3 and 12-hour form, as the plan's Fixture reference lists them.

test.use({ timezoneId: 'Etc/GMT-3', locale: 'en-US' });

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const SPEED_KEY = 'cloudiator.replay-speed.v1';
const RESULT_HINT = 'The result appears when the fight ends, or now with ⚑ Result.';
const VARRO = arenaActivityId('ownerHumanWin');
const EXPEDITION = REPLAY_FIXTURES.expedition.activityId;
const ENCOUNTERS = ['Encounter 1: Dire Wolf', 'Encounter 2: Timber Wolf', 'Encounter 3: Dire Wolf'];

type QueuePageRace = {
  armed: boolean; held: boolean; resume: (() => void) | null;
  handoff: { activity: string | null; stage: string | null; from: string | null; index: number | null } | null;
  replacements: { activity: string | null; index: number | null }[];
};
declare global { interface Window { __queuePageRace?: QueuePageRace } }

const campReady = (page: Page) => page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
async function openCamp(page: Page, url = '/game/?mode=fixture') {
  await page.goto(url);
  await campReady(page);
}
const replayScene = (page: Page) => page.getByRole('dialog', { name: 'Replay', exact: true });
const bar = (page: Page) => replayScene(page).getByRole('group', { name: 'Replay controls', exact: true });
const endCard = (page: Page) => replayScene(page).locator('[data-end-card]');
const playButton = (page: Page) => bar(page).getByRole('button', { name: /^(Play|Pause)$/ });
/** The replay's test hook: present once a bout has loaded and is playing. */
const replayReady = (page: Page) => page.waitForFunction(() => window.__cloudiatorReplay !== undefined, null, { timeout: 45_000 });
const hook = async (page: Page) => (await page.evaluate(() => window.__cloudiatorReplay?.state() ?? null))!;
const nextFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const settled = async (page: Page) => { await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished))); await nextFrames(page); };
const box = async (locator: Locator) => (await locator.boundingBox())!;

/** Settled owner bouts on distinct slots, using the authoritative fixture log, for routed live pagination. */
function pagedBout(now: number, slotsAgo: number): RevealedTimeline {
  const activityId = randomUUID();
  const settledAtMs = (Math.floor(now / SLOT_MS) - slotsAgo + 1) * SLOT_MS;
  const foughtAtMs = settledAtMs - 20 * 60_000;
  const replayExpiry = { state: 'available' as const, expiresAtMs: settledAtMs + 7 * 86_400_000 };
  return { activityId, serverNowMs: now, visibleThroughMs: now,
    stages: [{ id: `${activityId}:bout`, kind: 'bout', label: 'Bout: victory', startedAtMs: foughtAtMs, revealedAtMs: foughtAtMs,
      endsAtMs: settledAtMs, battleLog: JSON.parse(readFileSync('tests/fixtures/battles/pvp.json', 'utf8')) as BattleLog }],
    summary: { activityId, resolvedKind: 'arena', result: 'victory', success: true, settledAtMs, replayExpiry, receiptId: `page-${activityId}`,
      rewards: { money: 0, renown: 10, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 }, ratingDelta: 13 },
    completion: { activityId, resolvedKind: 'arena', result: 'victory', success: true, settledAtMs, replayExpiry } };
}

/** Results, opened on My bouts once the owner's list has loaded. */
async function myBouts(page: Page): Promise<Locator> {
  const results = await openMenu(page, 'Results');
  await expect(results.getByRole('tab', { name: /^My bouts/ })).toHaveAttribute('aria-selected', 'true', { timeout: 45_000 });
  await expect(results.locator('[data-bout-row]')).toHaveCount(8, { timeout: 45_000 });
  return results;
}
/** ▶ Watch on a My bouts row, then the replay has loaded. */
async function watch(page: Page, results: Locator, opponent: string) {
  await results.getByRole('button', { name: new RegExp(`^Watch: vs ${opponent}, `) }).click();
  await expect(replayScene(page)).toBeVisible();
  await replayReady(page);
}
/** A scene's address opened straight over the camp, then the replay has loaded. */
async function openScene(page: Page, activityId: string, from?: string) {
  await openCamp(page, `/game/?mode=fixture&view=replay&activity=${activityId}${from ? `&from=${from}` : ''}`);
  await replayReady(page);
}

/** A screenshot for Avi's review, in the test's output and in TASK_SHOTS when set (the task's shots folder). */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  // The arena is drawn once its scene has loaded (a canvas); a run without WebGL shows its fallback instead.
  await replayScene(page).locator('canvas').first().waitFor({ timeout: 20_000 }).catch(() => undefined);
  await settled(page);
  const file = `${name}-${testInfo.project.name}${production ? '-production' : ''}.png`;
  await page.screenshot({ path: testInfo.outputPath(file) });
  if (process.env.TASK_SHOTS) {
    mkdirSync(process.env.TASK_SHOTS, { recursive: true });
    await page.screenshot({ path: `${process.env.TASK_SHOTS}/${file}` });
  }
}

/**
 * The touch layout's bar in the real scene (Task 1's carry): at most `maxHeight` px, the track row above ▶ with the time beside it,
 * the tail ending at the bar's content edge, a slider at most 32 px tall with no vertical margin or padding that fills its row, and
 * 44 px buttons.
 */
async function expectPhoneBar(page: Page, maxHeight = 100) {
  const controls = bar(page);
  const whole = await box(controls);
  expect(whole.height, 'the bar').toBeLessThanOrEqual(maxHeight);
  const slider = controls.getByRole('slider', { name: 'Replay position', exact: true });
  const [s, p, t, row] = await Promise.all([box(slider), box(playButton(page)), box(controls.locator('[data-replay-time]')), box(slider.locator('xpath=../..'))]);
  expect(s.y + s.height, 'the track row ends above ▶').toBeLessThanOrEqual(p.y + 0.5);
  expect(t.x, 'the time is beside the track').toBeGreaterThanOrEqual(s.x + s.width - 0.5);
  expect(Math.abs(t.y + t.height / 2 - (s.y + s.height / 2)), 'the time is on the track row').toBeLessThanOrEqual(3);
  const content = await controls.evaluate(element => {
    const style = getComputedStyle(element);
    return element.getBoundingClientRect().right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
  });
  const result = await box(controls.getByRole('button', { name: 'Skip to the result', exact: true }));
  expect(Math.abs(result.x + result.width - content), 'the tail ends at the bar’s content edge').toBeLessThanOrEqual(1);
  const style = await slider.evaluate(element => {
    const css = getComputedStyle(element);
    return { height: parseFloat(css.height), vertical: [css.marginTop, css.marginBottom, css.paddingTop, css.paddingBottom] };
  });
  expect(style.height, 'the slider’s computed height').toBeLessThanOrEqual(32);
  expect(style.vertical, 'the slider’s vertical margin and padding').toEqual(['0px', '0px', '0px', '0px']);
  // The slider fills its row: the row's whole height, and its width up to the time.
  expect(Math.abs(s.height - row.height), 'the slider fills the row’s height').toBeLessThanOrEqual(1);
  expect(s.x - row.x, 'the slider starts the row').toBeLessThanOrEqual(1);
  const buttons = controls.getByRole('button');
  for (let i = 0; i < await buttons.count(); i += 1) {
    const button = buttons.nth(i);
    if (!await button.isVisible()) continue;
    const target = await box(button);
    expect(target.height, `${await button.getAttribute('aria-label')} height`).toBeGreaterThanOrEqual(44);
    expect.soft(target.width, `${page.viewportSize()!.width}px: ${await button.getAttribute('aria-label')} width`).toBeGreaterThanOrEqual(44);
  }
}

test.describe('the replay viewer', () => {
  test.skip(production, 'These checks use the fixture preview.');
  test.beforeEach(async ({ context }) => { await quietArrivals(context); });

  test('walks My bouts with ⏭ and Next bout, and one Back returns to the list', async ({ page }, testInfo) => {
    await openCamp(page);
    await watch(page, await myBouts(page), 'Varro');
    const touch = await touchLayout(page);
    const count = (wide: string, narrow: string) => replayScene(page).getByText(touch ? narrow : wide, { exact: true });
    await expect(count('Bout 1 of 5 in My bouts', '1 / 5')).toBeVisible();
    await expect(replayScene(page).getByText('UP NEXT', { exact: true })).toBeVisible();
    await expect(replayScene(page).getByText(touch ? 'Aster vs Cassia · Sat 1:20\xA0AM' : 'Aster vs Cassia · Arena · Sat 10 Oct, 1:20\xA0AM', { exact: true })).toBeVisible();
    const before = await page.evaluate(() => history.length);
    if (!touch) {
      const [counter, title] = await Promise.all([box(count('Bout 1 of 5 in My bouts', '1 / 5')), box(replayScene(page).getByRole('heading', { name: 'Aster vs Varro' }))]);
      expect(counter.x).toBeGreaterThanOrEqual(title.x + title.width);
      expect(Math.abs(counter.y + counter.height / 2 - title.y - title.height / 2)).toBeLessThanOrEqual(3);
    }
    await shot(page, testInfo, 'queue-first');
    await bar(page).getByRole('button', { name: 'Next bout', exact: true }).click();
    await expect(replayScene(page).getByRole('heading', { name: 'Aster vs Cassia' })).toBeVisible();
    await expect(count('Bout 2 of 5 in My bouts', '2 / 5')).toBeVisible();
    await expect(playButton(page)).toHaveAccessibleName('Pause');
    await expect(playButton(page)).toBeFocused();
    await page.keyboard.press('End');
    await endCard(page).getByRole('button', { name: touch ? 'Next · vs Iron Warden' : 'Next bout · vs Iron Warden', exact: true }).click();
    await expect(replayScene(page).getByRole('heading', { name: 'Aster vs Iron Warden' })).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(before);
    await page.getByRole('button', { name: 'Back to My bouts', exact: true }).click();
    await expect(replayScene(page)).toHaveCount(0);
    await expect(menuDialog(page, 'Results').getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await watch(page, menuDialog(page, 'Results'), 'Varro');
    await page.keyboard.press('n');
    await expect(replayScene(page).getByRole('heading', { name: 'Aster vs Cassia' })).toBeVisible();
    await page.keyboard.press('n');
    await expect(replayScene(page).getByRole('heading', { name: 'Aster vs Iron Warden' })).toBeVisible();
    await page.goBack();
    await expect(replayScene(page)).toHaveCount(0);
    await expect(menuDialog(page, 'Results')).toBeVisible();
  });

  test('follows the chip: Lost walks only the losses', async ({ page }) => {
    await openCamp(page);
    const results = await myBouts(page);
    await results.getByRole('button', { name: 'Lost', exact: true }).click();
    await watch(page, results, 'Cassia');
    const touch = await touchLayout(page);
    await expect(replayScene(page).getByText(touch ? '1 / 2' : 'Bout 1 of 2 in My bouts', { exact: true })).toBeVisible();
    await page.keyboard.press('n');
    await expect(replayScene(page).getByRole('heading', { name: 'Aster vs Bronze Sentinel' })).toBeVisible();
    await expect(bar(page).getByRole('button', { name: 'Next bout', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('End');
    await expect(endCard(page).getByRole('button', { name: 'My bouts', exact: true })).toBeVisible();
    await page.reload();
    await replayReady(page);
    await expect(replayScene(page).getByText(touch ? '2 / 2' : 'Bout 2 of 2 in My bouts', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to My bouts', exact: true }).click();
    await expect(results.getByRole('button', { name: 'Lost', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  test('someone else’s bout has no ⏮ ⏭ and no counter', async ({ page }) => {
    await openScene(page, arenaActivityId('varroSpectator'), 'bouts');
    await expect(bar(page).getByRole('button', { name: 'Next bout', exact: true })).toHaveCount(0);
    await expect(bar(page).getByRole('button', { name: 'Previous bout', exact: true })).toHaveCount(0);
    await expect(replayScene(page).locator('[data-bout-counter]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__cloudiatorReplay!.queue())).toBeNull();
  });

  test('phone: 1 / 5 and the up-next line without its button', async ({ page }, testInfo) => {
    for (const [width, height] of [[390, 844], [360, 740]]) {
      await page.setViewportSize({ width, height });
      if (width === 390) await openScene(page, VARRO, 'bouts');
      await expect(replayScene(page).getByText('1 / 5', { exact: true })).toBeVisible();
      const [counter, top] = await Promise.all([box(replayScene(page).locator('[data-bout-counter]')), box(replayScene(page).getByTestId('scene-top'))]);
      expect(counter.y).toBeGreaterThanOrEqual(top.y);
      expect(counter.y + counter.height).toBeLessThanOrEqual(top.y + top.height);
      expect(counter.x).toBeGreaterThan((await box(page.getByRole('button', { name: 'Back to My bouts', exact: true }))).x);
      const up = replayScene(page).locator('[data-up-next]');
      await expect(up).toContainText('UP NEXT');
      await expect(up).toContainText('Aster vs Cassia · Sat 1:20\xA0AM');
      await expect(up.getByRole('button')).toBeHidden();
      await expectPhoneBar(page);
      expect(await noHorizontalScroll(page)).toBe(true);
      const geometry = await replayScene(page).evaluate(root => {
        const controls = root.querySelector<HTMLElement>('[aria-label="Replay controls"]')!;
        const slider = controls.querySelector<HTMLInputElement>('input[type="range"]')!;
        const bounds = (element: Element) => { const b = element.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
        return { viewport: { width: innerWidth, height: innerHeight }, bar: bounds(controls), slider: bounds(slider), row: bounds(slider.parentElement!.parentElement!),
          buttons: [...controls.querySelectorAll('button')].filter(e => e.getBoundingClientRect().width > 0).map(e => ({ name: e.getAttribute('aria-label'), ...bounds(e) })),
          counter: bounds(root.querySelector('[data-bout-counter]')!), upNext: bounds(root.querySelector('[data-up-next]')!), overflow: root.scrollWidth - root.clientWidth };
      });
      await testInfo.attach(`queue-${width}-geometry`, { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
      if (process.env.TASK_SHOTS) {
        mkdirSync(process.env.TASK_SHOTS, { recursive: true });
        writeFileSync(`${process.env.TASK_SHOTS}/queue-${width}-${testInfo.project.name}-geometry.json`, JSON.stringify(geometry, null, 2));
      }
      await shot(page, testInfo, `queue-${width}`);
    }
  });

  test('chapter selection replaces the stage address, reloads it and leaves in one Back', async ({ page }) => {
    await openCamp(page);
    // A push from the existing camp entry, as a scene opener does.
    await page.evaluate(activityId => history.pushState({ cloudiatorScene: 1 }, '', `?mode=fixture&view=replay&activity=${activityId}&from=results`), EXPEDITION);
    await replayReady(page);
    const before = await page.evaluate(() => history.length);
    await page.keyboard.press('n');
    await page.waitForFunction(() => window.__cloudiatorReplay?.state().chapter === 1);
    const stage = new URL(page.url()).searchParams.get('stage');
    expect(stage).toBeTruthy();
    expect(new URL(page.url()).searchParams.get('from')).toBe('results');
    expect(await page.evaluate(() => history.length)).toBe(before);
    await page.reload();
    await replayReady(page);
    expect((await hook(page)).chapter).toBe(1);
    expect(new URL(page.url()).searchParams.get('stage')).toBe(stage);
    await page.goBack();
    await expect(replayScene(page)).toHaveCount(0);
    await expect(menuDialog(page, 'Results')).toBeVisible();
  });

  test('reads the next page before stepping, using its latest rows and clearing the old stage', async ({ page, context }) => {
    await seedSession(context);
    const now = Date.now(), bouts = Array.from({ length: 22 }, (_, i) => pagedBout(now, i + 1));
    const live = await routeLiveReads(context, { world: emptyWorld(now), owner: ownerFixture, bouts });
    await page.goto(`/game/?view=replay&activity=${bouts[19].activityId}&stage=${bouts[19].stages[0].id}&from=bouts`);
    await expectOwnerShown(page, 'Aster'); await replayReady(page);
    await expect.poll(() => page.evaluate(() => window.__cloudiatorReplay!.queue())).toMatchObject({ index: 19, count: 20, more: true });
    const before = await page.evaluate(() => history.length);
    await page.keyboard.press('n');
    await expect.poll(() => new URL(page.url()).searchParams.get('activity')).toBe(bouts[20].activityId);
    await expect.poll(() => page.evaluate(() => window.__cloudiatorReplay?.queue())).toMatchObject({ index: 20, count: 22, more: false });
    expect(live.requests.some(r => r.table === 'activities' && r.query.has('slot_index'))).toBe(true);
    expect(new URL(page.url()).searchParams.has('stage')).toBe(false);
    expect(new URL(page.url()).searchParams.get('from')).toBe('bouts');
    expect(await page.evaluate(() => history.length)).toBe(before);
    await expect(playButton(page)).toHaveAccessibleName('Pause');
    await expect(playButton(page)).toBeFocused();
  });

  test('a chapter replacement reuses the loaded timeline and fighter looks', async ({ page, context }) => {
    await seedSession(context);
    const now = Date.now(), timeline = pagedBout(now, 1);
    timeline.summary!.resolvedKind = 'expedition';
    timeline.stages = ENCOUNTERS.map((label, i) => ({ id: `${timeline.activityId}:${i}`, kind: 'encounter', label,
      revealedAtMs: now - (4 - i) * 60_000, startedAtMs: now - (4 - i) * 60_000, endsAtMs: now - (3 - i) * 60_000,
      battleLog: JSON.parse(readFileSync(`tests/fixtures/battles/expedition-${i + 1}.json`, 'utf8')) as BattleLog }));
    const live = await routeLiveReads(context, { world: emptyWorld(now), owner: ownerFixture, timelines: { [timeline.activityId]: timeline } });
    await page.goto(`/game/?view=replay&activity=${timeline.activityId}&from=results`);
    await expectOwnerShown(page, 'Aster'); await replayReady(page);
    const timelineReads = () => live.requests.filter(r => r.table === 'visible_events' && r.query.get('activity_id') === `eq.${timeline.activityId}`).length;
    const before = timelineReads();
    expect(before).toBeGreaterThan(0);
    const lookReads = () => live.requests.filter(r => r.table === 'world_actor_reads' && r.query.get('select')?.includes('appearance:actor')).length;
    await expect.poll(lookReads).toBeGreaterThan(0);
    const looks = lookReads();
    await page.keyboard.press('n');
    await page.waitForFunction(() => window.__cloudiatorReplay?.state().chapter === 1);
    await nextFrames(page);
    expect(timelineReads()).toBe(before);
    expect(lookReads()).toBe(looks);
  });

  test('an own current bout without a settled summary leads the queue without invented row details', async ({ page, context }) => {
    await seedSession(context);
    const now = Date.now(), current = pagedBout(now, 1), older = pagedBout(now, 2);
    delete current.summary; delete current.completion;
    const liveOwner = { ...ownerFixture, currentActivity: { id: current.activityId, kind: 'arena' as const, status: 'active' as const,
      startsAtMs: now - SLOT_MS, endsAtMs: now + 20 * 60_000, label: 'Arena' } };
    await routeLiveReads(context, { world: emptyWorld(now), owner: liveOwner, bouts: [older], timelines: { [current.activityId]: current } });
    await page.goto(`/game/?view=replay&activity=${current.activityId}&from=bouts`);
    await expectOwnerShown(page, 'Aster'); await replayReady(page);
    await expect.poll(() => page.evaluate(() => window.__cloudiatorReplay!.queue())).toMatchObject({ index: 0, count: 2, next: older.activityId });
    await page.keyboard.press('End');
    await expect(endCard(page).getByRole('list', { name: 'Rewards' })).toHaveText('Rewards are credited when the bout settles');
    await page.keyboard.press('n');
    await expect.poll(() => new URL(page.url()).searchParams.get('activity')).toBe(older.activityId);
  });

  test('a held next page cannot replace a newer replay after the list reopened', async ({ page, context }) => {
    await seedSession(context);
    const now = Date.now(), bouts = Array.from({ length: 22 }, (_, i) => pagedBout(now, i + 1));
    await routeLiveReads(context, { world: emptyWorld(now), owner: ownerFixture, bouts });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let paging = 0;
    await context.route('**/rest/v1/activities?*', async route => {
      const q = new URL(route.request().url()).searchParams;
      if (q.get('select')?.includes('starts_at_ms') && q.has('slot_index')) { paging += 1; await held; }
      await route.fallback();
    });
    await page.goto(`/game/?view=replay&activity=${bouts[19].activityId}&from=bouts`);
    await expectOwnerShown(page, 'Aster'); await replayReady(page);
    await expect.poll(() => page.evaluate(() => window.__cloudiatorReplay!.queue())).toMatchObject({ index: 19, more: true });
    await page.keyboard.press('n');
    await expect.poll(() => paging).toBe(1);
    await page.getByRole('button', { name: 'Back to My bouts', exact: true }).click();
    const results = menuDialog(page, 'Results');
    await expect(results.locator('[data-bout-row]')).toHaveCount(20);
    await expect(results.getByRole('status')).toHaveCount(0);
    await results.getByRole('button', { name: /^Watch: vs Varro,/ }).first().click();
    await replayReady(page);
    await expect.poll(() => page.evaluate(() => window.__cloudiatorReplay!.queue())).toMatchObject({ index: 0, count: 20, more: true });
    const before = await page.evaluate(() => history.length);
    const answered = page.waitForResponse(response => response.url().includes('/activities?') && new URL(response.url()).searchParams.has('slot_index'));
    release(); await answered; await nextFrames(page);
    expect(new URL(page.url()).searchParams.get('activity')).toBe(bouts[0].activityId);
    expect(await page.evaluate(() => window.__cloudiatorReplay!.queue())).toMatchObject({ index: 0, count: 20, more: true });
    expect(await page.evaluate(() => history.length)).toBe(before);
  });

  for (const changedPart of ['activity', 'stage', 'origin'] as const) test(`a held page cannot replace native ${changedPart} navigation before its React commit`, async ({ page, context }, testInfo) => {
    await seedSession(context);
    const now = Date.now(), bouts = Array.from({ length: 22 }, (_, i) => pagedBout(now, i + 1));
    await routeLiveReads(context, { world: emptyWorld(now), owner: ownerFixture, bouts });
    // Hold the fully fetched final names response at text(), preserving its real bytes and all production readers/continuations.
    await page.addInitScript(() => {
      const race: QueuePageRace = { armed: false, held: false, resume: null, handoff: null, replacements: [] };
      window.__queuePageRace = race;
      const fetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await fetch(...args);
        const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), location.href);
        if (!race.armed || !url.pathname.endsWith('/visible_events') || !url.searchParams.get('select')?.includes('p0name')) return response;
        race.armed = false;
        const body = await response.text();
        Object.defineProperty(response, 'text', { value: async () => {
          await new Promise<void>(resolve => { race.resume = resolve; race.held = true; });
          const address = new URL(location.href).searchParams;
          race.handoff = { activity: address.get('activity'), stage: address.get('stage'), from: address.get('from'), index: window.__cloudiatorReplay?.queue()?.index ?? null };
          return body;
        } });
        return response;
      };
    });
    await page.goto(`/game/?view=replay&activity=${bouts[19].activityId}&from=bouts`);
    await expectOwnerShown(page, 'Aster'); await replayReady(page);
    await expect.poll(() => page.evaluate(() => window.__cloudiatorReplay!.queue())).toMatchObject({ index: 19, count: 20, more: true });
    await page.evaluate(staleTarget => {
      window.__queuePageRace!.armed = true;
      const replace = history.replaceState.bind(history);
      history.replaceState = (state, unused, url) => {
        if (url && new URL(String(url), location.href).searchParams.get('activity') === staleTarget) {
          window.__queuePageRace!.replacements.push({ activity: new URL(location.href).searchParams.get('activity'), index: window.__cloudiatorReplay?.queue()?.index ?? null });
        }
        replace(state, unused, url);
      };
    }, bouts[20].activityId);
    await page.keyboard.press('n');
    await page.waitForFunction(() => window.__queuePageRace?.held);
    // The address changes synchronously; the held response resumes in this same page turn before React commits that address.
    const activity = changedPart === 'activity' ? bouts[0].activityId : bouts[19].activityId;
    const stage = changedPart === 'stage' ? bouts[19].stages[0].id : null;
    const from = changedPart === 'origin' ? 'bouts-won' : 'bouts';
    const destination = `/game/?view=replay&activity=${activity}&from=${from}${stage ? `&stage=${encodeURIComponent(stage)}` : ''}`;
    await page.evaluate(destination => {
      history.pushState({ cloudiatorScene: 1 }, '', destination);
      window.__queuePageRace!.resume!();
    }, destination);
    await page.waitForFunction(() => window.__queuePageRace?.handoff !== null);
    await nextFrames(page);
    const observed = await page.evaluate(() => window.__queuePageRace!);
    await testInfo.attach('native-navigation-page-handoff', { body: JSON.stringify(observed, null, 2), contentType: 'application/json' });
    expect(observed.handoff).toEqual({ activity, stage, from, index: 19 });
    expect(observed.replacements, 'the held continuation must not replace an address that has already moved').toEqual([]);
    expect(new URL(page.url()).searchParams.get('activity')).toBe(activity);
    expect(new URL(page.url()).searchParams.get('stage')).toBe(stage);
    expect(new URL(page.url()).searchParams.get('from')).toBe(from);
  });

  test('plays a bout with the replay bar, focused on Pause, and remembers the speed', async ({ page }, testInfo) => {
    await openCamp(page);
    const results = await myBouts(page);
    await watch(page, results, 'Varro');
    const scene = replayScene(page);
    const touch = await touchLayout(page);
    // The eyebrow says the kind and when it was fought (minute 60 of its slot), never its stage label.
    await expect(scene.locator('header p.eyebrow')).toHaveText(touch ? 'ARENA · SAT 2:40\xA0AM' : 'ARENA · SAT 10 OCT, 2:40\xA0AM');
    await expect(scene.getByRole('heading', { level: 2, name: 'Aster vs Varro' })).toBeVisible();
    // Opened playing, the focus moved from Back to Pause once the replay loaded.
    const controls = bar(page);
    const pause = controls.getByRole('button', { name: 'Pause', exact: true });
    await expect(pause).toBeFocused();
    await expect(pause).toHaveAttribute('aria-keyshortcuts', 'K Space');
    const speed = controls.getByRole('button', { name: /^Speed / });
    await expect(speed).toHaveAccessibleName('Speed 1×');
    await expect(speed).toHaveText('1×');
    await expect(speed).toHaveAttribute('title', 'Speed (F)');
    await expect(speed).toHaveAttribute('aria-keyshortcuts', 'F');
    const result = controls.getByRole('button', { name: 'Skip to the result', exact: true });
    await expect(result).toHaveText('⚑ Result');
    await expect(result).toHaveAttribute('title', 'Skip to the result (End)');
    await expect(result).toHaveAttribute('aria-keyshortcuts', 'End');
    await expect(controls.getByRole('slider', { name: 'Replay position', exact: true })).toBeVisible();
    await expect(controls.locator('[data-replay-time]')).toHaveText(/^0:\d\d \/ 0:\d\d$/);
    // An own bout now steps its queue; at the newest bout only Next is enabled.
    await expect(controls.getByRole('button', { name: 'Previous bout', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await expect(controls.getByRole('button', { name: 'Next bout', exact: true })).toBeEnabled();
    for (const gone of ['Fast ×4', 'Restart', 'Skip to result']) await expect(scene.getByRole('button', { name: gone, exact: true })).toHaveCount(0);
    await expect(scene.getByText(/^Keys:/)).toHaveCount(0);
    await shot(page, testInfo, 'viewer-playing');

    // 1× → 2× → 4× → 1×, each stored on this device.
    for (const [shown, stored] of [['2×', '2'], ['4×', '4'], ['1×', '1']]) {
      await speed.click();
      await expect(speed).toHaveText(shown);
      await expect(speed).toHaveAccessibleName(`Speed ${shown}`);
      expect(await page.evaluate(key => localStorage.getItem(key), SPEED_KEY)).toBe(stored);
    }
    await speed.click();
    await speed.click();
    expect((await hook(page)).speed).toBe('fast');

    // The next replay starts at the remembered 4×.
    await page.getByRole('button', { name: 'Back to My bouts', exact: true }).click();
    await expect(scene).toHaveCount(0);
    await page.waitForFunction(() => window.__cloudiatorReplay === undefined);
    await watch(page, menuDialog(page, 'Results'), 'Cassia');
    await expect(scene.getByRole('heading', { level: 2, name: 'Aster vs Cassia' })).toBeVisible();
    expect((await hook(page)).speed).toBe('fast');
    await expect(speed).toHaveText('4×');
    expect(await page.evaluate(key => localStorage.getItem(key), SPEED_KEY)).toBe('4');
  });

  test('ends on the result card over the arena, and Watch again plays it again', async ({ page }, testInfo) => {
    await openCamp(page);
    await watch(page, await myBouts(page), 'Varro');
    const scene = replayScene(page);
    const touch = await touchLayout(page);
    await expect(scene.getByRole('region', { name: 'Result' })).toContainText(RESULT_HINT);
    await expect(endCard(page)).toHaveCount(0);
    expect((await hook(page)).endCard).toBe(false);

    await bar(page).getByRole('button', { name: 'Skip to the result', exact: true }).click();
    const card = endCard(page);
    await expect(card).toBeVisible();
    expect(await hook(page)).toMatchObject({ endCard: true, playing: false });
    await expect(card.locator('p.eyebrow')).toHaveText(touch ? [] : ['RESULT']);
    await expect(card.getByText('Aster wins', { exact: true })).toBeVisible();
    await expect(card.getByText('Varro is defeated.', { exact: true })).toBeVisible();
    await expect(card.getByRole('list', { name: 'Rewards' }).getByRole('listitem')).toHaveText(['+10 renown', 'Rating +13']);
    await expect(card.getByRole('button')).toHaveText([touch ? '↺ Again' : '↺ Watch again', touch ? '▶ Next · vs Cassia' : '▶ Next bout · vs Cassia']);
    // On the arena: inside the close-up's box.
    const arena = await box(card.locator('xpath=..').getByRole('img'));
    const shown = await box(card);
    expect(shown.x).toBeGreaterThanOrEqual(arena.x);
    expect(shown.y).toBeGreaterThanOrEqual(arena.y);
    expect(shown.x + shown.width).toBeLessThanOrEqual(arena.x + arena.width);
    expect(shown.y + shown.height).toBeLessThanOrEqual(arena.y + arena.height);
    // The Result card below says who won as today.
    await expect(scene.getByRole('region', { name: 'Result' })).toContainText('Aster wins');
    await shot(page, testInfo, 'viewer-result');

    await card.getByRole('button', { name: touch ? 'Again' : 'Watch again', exact: true }).click();
    await expect(card).toHaveCount(0);
    const again = await hook(page);
    expect(again).toMatchObject({ endCard: false, playing: true });
    expect(again.positionMs).toBeLessThan(1000);
    // The card's button went with it: the focus is on Pause, not lost.
    await expect(bar(page).getByRole('button', { name: 'Pause', exact: true })).toBeFocused();
    await expect(scene.getByRole('region', { name: 'Result' })).toContainText(RESULT_HINT);

    // At the end again, the scene's way back still closes it to My bouts.
    await bar(page).getByRole('button', { name: 'Skip to the result', exact: true }).click();
    await page.getByRole('button', { name: 'Back to My bouts', exact: true }).click();
    await expect(scene).toHaveCount(0);
    await expect(menuDialog(page, 'Results').getByRole('tab', { name: /^My bouts/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('the keys', async ({ page }) => {
    await openCamp(page);
    await watch(page, await myBouts(page), 'Varro');
    const controls = bar(page);
    await expect(controls.getByRole('button', { name: 'Pause', exact: true })).toBeFocused();
    // K plays and pauses.
    await page.keyboard.press('k');
    await expect(controls.getByRole('button', { name: 'Play', exact: true })).toBeFocused();
    expect((await hook(page)).playing).toBe(false);
    await page.keyboard.press('k');
    expect((await hook(page)).playing).toBe(true);
    // ← and → move 5 s, also on the track (its own small steps are replaced).
    await page.evaluate(() => { window.__cloudiatorReplay!.pause(); window.__cloudiatorReplay!.seek(0); });
    await page.keyboard.press('ArrowRight');
    expect((await hook(page)).positionMs).toBe(5000);
    await page.keyboard.press('ArrowLeft');
    expect((await hook(page)).positionMs).toBe(0);
    await controls.getByRole('slider', { name: 'Replay position', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    expect((await hook(page)).positionMs).toBe(5000);
    await page.keyboard.press('ArrowLeft');
    expect((await hook(page)).positionMs).toBe(0);
    // F cycles the speed.
    for (const speed of ['double', 'fast', 'normal']) {
      await page.keyboard.press('f');
      expect((await hook(page)).speed).toBe(speed);
    }
    // End shows the result card; R plays from the start, the card gone.
    await page.keyboard.press('End');
    await expect(endCard(page)).toBeVisible();
    expect((await hook(page)).endCard).toBe(true);
    await page.keyboard.press('r');
    await expect(endCard(page)).toHaveCount(0);
    const restarted = await hook(page);
    expect(restarted).toMatchObject({ endCard: false, playing: true });
    expect(restarted.positionMs).toBeLessThan(1000);
    // N and P step the own-bout queue, each opening playing.
    await page.keyboard.press('n');
    await expect(replayScene(page).getByRole('heading', { level: 2, name: 'Aster vs Cassia' })).toBeVisible();
    await page.keyboard.press('p');
    await expect(replayScene(page).getByRole('heading', { level: 2, name: 'Aster vs Varro' })).toBeVisible();
    // The keys are in the buttons' titles; the old line is gone, on every width.
    await expect(page.getByText('Keys:')).toHaveCount(0);
  });

  test('never shows the result before the end', async ({ page }) => {
    // Review Focus 4: Cassia's bout, whose stage label is the server's "Bout: defeat".
    await openCamp(page);
    await watch(page, await myBouts(page), 'Cassia');
    const scene = replayScene(page);
    await expect(scene.getByRole('heading', { level: 2, name: 'Aster vs Cassia' })).toBeVisible();
    expect((await hook(page)).playing).toBe(true);
    // Pin the last pre-victory millisecond, not just the first frame after opening.
    const loss = JSON.parse(readFileSync('tests/fixtures/arena/ownerHumanLoss.json', 'utf8')) as BattleLog;
    const victoryMs = loss.events.find(event => event.kind === 'victory')!.elapsedMs;
    await page.evaluate(ms => { window.__cloudiatorReplay!.pause(); window.__cloudiatorReplay!.seek(ms); }, victoryMs - 1);
    const words = await scene.evaluate(root => [root.textContent ?? '',
      ...[...root.querySelectorAll('[title], [aria-label]')].flatMap(e => [e.getAttribute('title') ?? '', e.getAttribute('aria-label') ?? ''])].join('\n'));
    // Read while the fight was still on.
    expect((await hook(page)).finished).toBe(false);
    expect(words).not.toMatch(/victory|defeat/i);
    expect(words).not.toContain('Cassia wins');
    // The lower Result may show at victory, but the overlay waits through the outro.
    await page.evaluate(() => window.__cloudiatorReplay!.seek(window.__cloudiatorReplay!.state().endMs - 1));
    expect((await hook(page)).finished).toBe(true);
    await expect(endCard(page)).toHaveCount(0);
    await page.keyboard.press('End');
    await expect(endCard(page)).toContainText('Cassia wins');
    await expect(endCard(page)).toContainText('Aster is defeated.');
  });

  test('Space respects controls, text inputs and modified shortcuts', async ({ page }) => {
    await openScene(page, VARRO);
    const controls = bar(page);
    await playButton(page).focus();
    await page.keyboard.press('Space');
    expect((await hook(page)).playing).toBe(false);
    await page.keyboard.press('Control+k');
    expect((await hook(page)).playing).toBe(false);
    // A text field inside the player must never invoke a replay shortcut.
    await controls.evaluate(element => {
      const input = document.createElement('input'); input.setAttribute('aria-label', 'Shortcut exclusion probe');
      element.append(input); input.focus();
    });
    await page.keyboard.type('kfr');
    expect((await hook(page))).toMatchObject({ playing: false, speed: 'normal' });
    await expect(controls.getByRole('textbox')).toHaveValue('kfr');
    await controls.getByRole('textbox').evaluate(element => element.remove());
    // Non-control focus uses Space; a summary uses its own disclosure behavior.
    const title = replayScene(page).getByRole('heading', { name: 'Aster vs Varro' });
    await title.evaluate(element => { element.setAttribute('tabindex', '-1'); (element as HTMLElement).focus(); });
    await page.keyboard.press('Space');
    expect((await hook(page)).playing).toBe(true);
    await page.setViewportSize({ width: 360, height: 740 });
    const fold = replayScene(page).getByRole('group', { name: 'Combat log', exact: true });
    await fold.locator('summary').focus();
    await page.keyboard.press('Space');
    await expect(fold).toHaveAttribute('open', '');
    expect((await hook(page)).playing).toBe(true);
  });

  test('seek and Play dismiss the end card; a standalone replay only offers Again', async ({ page }) => {
    await page.goto(`/replay/?mode=fixture&activity=${VARRO}`);
    await replayReady(page);
    const result = page.getByRole('button', { name: 'Skip to the result', exact: true });
    const card = page.locator('[data-end-card]');
    await result.click();
    await expect(card.getByRole('button')).toHaveCount(1);
    await expect(card.getByRole('button')).toHaveAccessibleName(/^(Watch again|Again)$/);
    await page.evaluate(() => window.__cloudiatorReplay!.seek(window.__cloudiatorReplay!.state().endMs - 1));
    await expect(card).toHaveCount(0);
    await result.click();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(card).toHaveCount(0);
    expect((await hook(page))).toMatchObject({ playing: true, endCard: false });
  });

  test('releasing a slider drag outside restores frame updates', async ({ page }) => {
    await openScene(page, VARRO);
    const slider = bar(page).getByRole('slider');
    const bounds = await box(slider);
    await page.mouse.move(bounds.x + bounds.width / 4, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y - 80);
    await page.mouse.up();
    const before = Number(await slider.inputValue());
    await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(before + 100);
  });

  test('steps an expedition’s encounters as chapters', async ({ page }, testInfo) => {
    await openScene(page, EXPEDITION);
    const scene = replayScene(page);
    const controls = bar(page);
    const touch = await touchLayout(page);
    expect(await hook(page)).toMatchObject({ chapter: 0, chapters: 3 });
    await expect(scene.locator('header p.eyebrow')).toHaveText('Expedition · Encounter 1: Dire Wolf');
    const chapters = controls.getByRole('list', { name: 'Chapters' }).getByRole('button');
    if (touch) {
      await expect(chapters.first()).toBeHidden();
      await expect(controls.getByText('1 / 3 · Encounter 1: Dire Wolf', { exact: true })).toBeVisible();
    } else {
      await expect(chapters).toHaveText(ENCOUNTERS);
      await expect(chapters.nth(0)).toHaveAttribute('aria-current', 'step');
    }
    await expect(controls.getByRole('button', { name: 'Previous bout', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await expect(controls.getByRole('button', { name: 'Previous bout', exact: true })).toHaveAttribute('aria-keyshortcuts', 'P');
    await expect(controls.getByRole('button', { name: 'Next bout', exact: true })).toHaveAttribute('aria-keyshortcuts', 'N');
    await shot(page, testInfo, 'viewer-chapters');

    const before = await page.evaluate(() => history.length);
    const first = (await hook(page)).battleId;
    await controls.getByRole('button', { name: 'Next bout', exact: true }).click();
    await page.waitForFunction(() => window.__cloudiatorReplay?.state().chapter === 1);
    const second = await hook(page);
    expect(second.battleId).not.toBe(first);
    expect(second.playing).toBe(true);
    await expect(scene.locator('header p.eyebrow')).toHaveText('Expedition · Encounter 2: Timber Wolf');
    if (touch) await expect(controls.getByText('2 / 3 · Encounter 2: Timber Wolf', { exact: true })).toBeVisible();
    else await expect(chapters.nth(1)).toHaveAttribute('aria-current', 'step');
    // The remount put the focus on Pause, and the step added no history entry.
    await expect(controls.getByRole('button', { name: 'Pause', exact: true })).toBeFocused();
    expect(await page.evaluate(() => history.length)).toBe(before);

    // N and P step too; at the last chapter ⏭ is disabled and the end card offers the way back.
    await page.keyboard.press('p');
    await page.waitForFunction(() => window.__cloudiatorReplay?.state().chapter === 0);
    await page.keyboard.press('n');
    await page.waitForFunction(() => window.__cloudiatorReplay?.state().chapter === 1);
    await page.keyboard.press('n');
    await page.waitForFunction(() => window.__cloudiatorReplay?.state().chapter === 2);
    await expect(controls.getByRole('button', { name: 'Next bout', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('End');
    await expect(endCard(page).getByRole('button')).toHaveText([touch ? '↺ Again' : '↺ Watch again', '← Camp']);
    // At an earlier chapter the card steps on, named for the next encounter's creature.
    await controls.getByRole('button', { name: 'Previous bout', exact: true }).click();
    await page.waitForFunction(() => window.__cloudiatorReplay?.state().chapter === 1);
    await page.keyboard.press('End');
    await expect(endCard(page).getByRole('button')).toHaveText([touch ? '↺ Again' : '↺ Watch again', touch ? '▶ Next · vs Dire Wolf' : '▶ Next bout · vs Dire Wolf']);
    await endCard(page).getByRole('button', { name: /Next/ }).click();
    await page.waitForFunction(() => window.__cloudiatorReplay?.state().chapter === 2);
    expect(await page.evaluate(() => history.length)).toBe(before);
  });

  test('phone: who won without scrolling, a bar of at most 100 px, folded details', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openScene(page, VARRO, 'bouts');
    const scene = replayScene(page);
    await expect(scene.locator('header p.eyebrow')).toHaveText('ARENA · SAT 2:40\xA0AM');
    await expectPhoneBar(page);
    // Fighters and Combat log fold into closed sections.
    for (const name of ['Fighters at the start', 'Combat log']) {
      const fold = scene.getByRole('group', { name, exact: true });
      await expect(fold).toHaveCount(1);
      expect(await fold.evaluate(element => element instanceof HTMLDetailsElement && !element.open), name).toBe(true);
    }
    await expect(scene.getByRole('heading', { name: 'Fighters', exact: true })).toHaveCount(0);
    await shot(page, testInfo, 'viewer-390');

    await bar(page).getByRole('button', { name: 'Skip to the result', exact: true }).click();
    const verdict = endCard(page).getByText('Aster wins', { exact: true });
    await expect(verdict).toBeVisible();
    await expect(endCard(page).getByText('Varro is defeated.', { exact: true })).toBeVisible();
    await expect(endCard(page).getByRole('button')).toHaveText(['↺ Again', '▶ Next · vs Cassia']);
    expect(await scene.evaluate(element => element.scrollTop)).toBe(0);
    const shown = await box(verdict);
    expect(shown.y + shown.height).toBeLessThanOrEqual(844);
    for (const button of await endCard(page).getByRole('button').all()) expect((await box(button)).height).toBeGreaterThanOrEqual(44);
    await shot(page, testInfo, 'viewer-390-result');

    // A fold opens and closes like any disclosure.
    const fighters = scene.getByRole('group', { name: 'Fighters at the start', exact: true });
    await fighters.locator('summary').click();
    await expect(fighters.getByRole('table', { name: 'Fighters at the start of the fight' })).toBeVisible();
    await fighters.locator('summary').click();
    await expect(fighters.getByRole('table')).toBeHidden();

    await page.setViewportSize({ width: 360, height: 740 });
    await nextFrames(page);
    expect(await noHorizontalScroll(page)).toBe(true);
    await expectPhoneBar(page);
    await scene.evaluate(element => element.scrollTo({ top: 0 }));
    const narrow = await box(verdict);
    expect(narrow.y + narrow.height).toBeLessThanOrEqual(740);
    await shot(page, testInfo, 'viewer-360-result');
  });

  test('phone: the chapters’ name sits on a line under the buttons, 118 px', async ({ page }, testInfo) => {
    // The recorded exception to "at most 100 px" (Task 1's ruling): a bar with chapters and a track names the chapter on a line of its own.
    for (const [width, height] of [[390, 844], [360, 740]]) {
      await page.setViewportSize({ width, height });
      if (width === 390) await openScene(page, EXPEDITION);
      else await nextFrames(page);
      const controls = bar(page);
      const name = controls.getByText('1 / 3 · Encounter 1: Dire Wolf', { exact: true });
      await expect(name).toBeVisible();
      const [line, play] = await Promise.all([box(name), box(playButton(page))]);
      expect(line.y, `${width}: the name is under the buttons`).toBeGreaterThanOrEqual(play.y + play.height - 0.5);
      expect((await box(controls)).height, `${width}: the bar`).toBeLessThanOrEqual(118);
      await expectPhoneBar(page, 118);
      expect(await noHorizontalScroll(page)).toBe(true);
      await shot(page, testInfo, `viewer-chapters-${width}`);
    }
  });

  test('desktop: one row, with the chapters on a row below', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openScene(page, EXPEDITION);
    test.skip(await touchLayout(page), 'A touch screen has the phone layout at any width.');
    const controls = bar(page);
    const row = [
      controls.getByRole('button', { name: 'Previous bout', exact: true }), playButton(page), controls.getByRole('button', { name: 'Next bout', exact: true }),
      controls.getByRole('slider', { name: 'Replay position', exact: true }), controls.locator('[data-replay-time]'),
      controls.getByRole('button', { name: /^Speed / }), controls.getByRole('button', { name: 'Skip to the result', exact: true }),
    ];
    const boxes = await Promise.all(row.map(box));
    const middle = boxes[1].y + boxes[1].height / 2;
    for (const [i, b] of boxes.entries()) expect(Math.abs(b.y + b.height / 2 - middle), `item ${i} is on ▶'s row`).toBeLessThanOrEqual(3);
    for (let i = 1; i < boxes.length; i += 1) expect(boxes[i].x, `item ${i} follows item ${i - 1}`).toBeGreaterThan(boxes[i - 1].x);
    const chapters = await box(controls.getByRole('list', { name: 'Chapters' }));
    expect(chapters.y).toBeGreaterThanOrEqual(Math.max(...boxes.map(b => b.y + b.height)) - 0.5);
    const style = await controls.getByRole('slider').evaluate(element => parseFloat(getComputedStyle(element).height));
    expect(style).toBeLessThanOrEqual(32);
    await shot(page, testInfo, 'viewer-chapters-1280');
  });

  test('keeps the speed for the page when storage throws', async ({ page }) => {
    // Review Focus 1: private mode or blocked site data. The page's memory holds the speed.
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new DOMException('blocked', 'SecurityError'); };
      Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError'); };
    });
    await openCamp(page);
    await watch(page, await myBouts(page), 'Varro');
    const speed = bar(page).getByRole('button', { name: /^Speed / });
    await speed.click();
    await expect(speed).toHaveText('2×');
    expect((await hook(page)).speed).toBe('double');
    await page.getByRole('button', { name: 'Back to My bouts', exact: true }).click();
    await expect(replayScene(page)).toHaveCount(0);
    await page.waitForFunction(() => window.__cloudiatorReplay === undefined);
    await watch(page, menuDialog(page, 'Results'), 'Cassia');
    expect((await hook(page)).speed).toBe('double');
    await expect(speed).toHaveText('2×');
    expect(errors).toEqual([]);
  });
});
