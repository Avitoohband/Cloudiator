import { expect, test, type BrowserContext, type Page } from './fixtures';
import { DUNGEON_FIXTURES, type DungeonFixtureKey } from '../fixtures/dungeons';
import { ownerFixture } from '../fixtures/domain';
import { dungeonLiveData, routeLiveReads, seedSession } from './live-routes';
import { expectNamedControls, noHorizontalScroll } from './a11y-helpers';
import { openMenu, quietArrivals } from './shell-helpers';
import { reviewShot } from './review-shots';

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const MINUTE = 60_000;
const dungeonUrl = (key: DungeonFixtureKey, trip = false) => `/dungeon/?activity=${DUNGEON_FIXTURES[key].activityId}${trip ? '&play=trip' : ''}`;
const partyUrl = (key: DungeonFixtureKey, ordinal: number) => `/replay/?run=${encodeURIComponent(DUNGEON_FIXTURES[key].runId)}&fight=${ordinal}`;
const runDialog = (page: Page) => page.getByRole('dialog', { name: 'Dungeon', exact: true });
const partyDialog = (page: Page) => page.getByRole('dialog', { name: 'Dungeon fight replay', exact: true });

async function routeDungeon(context: BrowserContext, key: DungeonFixtureKey, options: { minute?: number; owner?: boolean; expired?: boolean } = {}) {
  const user = options.owner ? await seedSession(context) : null;
  await quietArrivals(context);
  return routeLiveReads(context, dungeonLiveData(key, {
    nowMs: options.minute === undefined ? undefined : DUNGEON_FIXTURES[key].startsAtMs + options.minute * MINUTE,
    expired: options.expired, owner: options.owner ? ownerFixture : null, ownerAccountId: user?.id,
  }));
}

test('the fixed dungeon and replay addresses handle invalid links on direct load and reload', async ({ page }) => {
  await page.goto('/dungeon/?activity=unknown');
  await expect(page.getByRole('heading', { name: 'Dungeon not available' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dungeon not available' })).toBeVisible();
  await page.goto('/replay/?run=dungeon%3A373237%3Awolf-den%3A1&fight=04');
  await expect(page.getByRole('heading', { name: /replay is not available/i })).toBeVisible();
});

test.describe('the routed dungeon player flow', () => {
  test.beforeEach(() => { test.skip(production, 'Routed dungeons use development-only fixture transport.'); });

  test('opens a running dungeon from camp and plays only due chapters', async ({ page, context }, testInfo) => {
    await routeDungeon(context, 'full-victory', { minute: 33, owner: true });
    await page.goto('/game/');
    const watch = page.getByTestId('away-button').locator('[data-away-main]');
    await expect(watch).toContainText('Wolf Den');
    await watch.click();
    const run = runDialog(page);
    await expect(run.getByRole('heading', { name: 'Wolf Den' })).toBeVisible();
    await expect(run.getByText('● LIVE')).toBeVisible();
    await expect(run.getByRole('progressbar', { name: 'Dungeon progress' })).toBeVisible();
    await expect(run.getByRole('application', { name: 'Wolf Den dungeon map' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__cloudiatorDungeonScene?.debug()?.party.length ?? 0)).toBe(3);
    await expect(run.getByRole('link', { name: 'Watch Room 1' })).toBeVisible();
    await expect(run.getByRole('link', { name: 'Watch Alpha of the Den' })).toHaveCount(0);
    const marks = run.getByRole('list', { name: 'Trip marks' });
    const overlaps = await marks.locator('li').evaluateAll(items => {
      const boxes = items.map(item => item.getBoundingClientRect());
      return boxes.slice(0, -1).map((box, i) => {
        const next = boxes[i + 1];
        // Allow subpixel rounding while rejecting intersecting labels in the same row.
        return box.right - next.left > 0.5 && next.right - box.left > 0.5
          && box.bottom - next.top > 0.5 && next.bottom - box.top > 0.5 ? i : -1;
      }).filter(index => index >= 0);
    });
    expect(overlaps, 'Adjacent live trip labels are legible').toEqual([]);
    await expectNamedControls(run, 'dungeon run');
    expect(await noHorizontalScroll(page)).toBe(true);
    await reviewShot(page, testInfo, 'dungeon-live');
    await run.getByRole('button', { name: 'Watch the whole trip' }).click();
    const controls = run.getByRole('group', { name: 'Replay controls' });
    await expect(controls.locator('button').filter({ hasText: 'Alpha of the Den' })).toBeDisabled();
    await controls.getByRole('button', { name: 'Next chapter' }).click();
    await controls.getByRole('button', { name: 'Next chapter' }).click();
    await controls.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(controls.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await controls.getByRole('button', { name: 'Back to live' }).click();
    await run.getByRole('button', { name: 'Back to Camp', exact: false }).first().click();
    await expect(run).not.toBeVisible();
    await expect(watch).toBeFocused();
  });

  test('keeps a lost room watchable, skips the major, and returns focus from its close-up', async ({ page, context }, testInfo) => {
    const transport = await routeDungeon(context, 'room-lost', { minute: 78 });
    await page.setViewportSize(testInfo.project.name === 'desktop' ? { width: 1440, height: 900 } : { width: 360, height: 740 });
    await page.goto(dungeonUrl('room-lost'));
    await expect(page.getByTestId('dungeon-phase')).toHaveText('Safe point · Back at minute 80');
    await expect(page.getByRole('application', { name: 'Troll Hall dungeon map' })).toBeVisible();
    const opener = page.getByRole('link', { name: 'Watch Room 3' });
    await expect(opener).toBeVisible();
    await expect(page.getByRole('link', { name: 'Watch Troll King' })).toHaveCount(0);
    await opener.click();
    const fight = partyDialog(page);
    const controls = fight.getByRole('group', { name: 'Party replay controls' });
    await expect(controls.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    if (testInfo.project.name === 'mobile') {
      // Three tall troll sprites at 2× need this vertical room. The 296px field overlapped their silhouettes.
      await expect.poll(async () => (await fight.locator('canvas').boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(344);
    }
    await controls.getByRole('button', { name: 'Play', exact: true }).click();
    await controls.getByRole('button', { name: 'Pause', exact: true }).click();
    await controls.getByRole('button', { name: 'Speed 1×' }).click();
    await expect(controls.getByRole('button', { name: 'Speed 2×' })).toBeVisible();
    await controls.getByRole('button', { name: 'Skip to the result' }).click();
    await expect(fight.getByText('Party defeat', { exact: true })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    await reviewShot(page, testInfo, 'dungeon-room-loss-replay');
    await controls.getByRole('button', { name: 'Restart', exact: true }).click();
    await expect(fight.getByText('Party defeat', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(fight).not.toBeVisible();
    await expect(opener).toBeFocused();
    await opener.click();
    await fight.getByRole('button', { name: 'Back to run' }).click();
    await expect(opener).toBeFocused();
    expect(transport.requests.filter(row => row.table === 'dungeon_fights').map(row => row.query.get('ordinal'))).not.toContain('eq.4');
  });

  test('loads only the exact public party fight on a deep link and rejects mixed keys', async ({ page, context }) => {
    const transport = await routeDungeon(context, 'member-fell-party-cleared');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(partyUrl('member-fell-party-cleared', 4));
    await expect(page.getByRole('heading', { name: 'Alpha of the Den' })).toBeVisible();
    await expect(page.getByText('BOT', { exact: true }).first()).toBeVisible();
    const reads = transport.requests.filter(row => row.table === 'dungeon_fights');
    expect(reads).toHaveLength(1);
    expect(reads[0].query.get('ordinal')).toBe('eq.4');
    expect(reads[0].query.get('run_id')).toBe(`eq.${DUNGEON_FIXTURES['member-fell-party-cleared'].runId}`);
    expect(transport.count('visible_events')).toBe(0);
    await page.goto(`${partyUrl('member-fell-party-cleared', 4)}&activity=${DUNGEON_FIXTURES['full-victory'].activityId}`);
    await expect(page.getByRole('heading', { name: /replay is not available/i })).toBeVisible();
    expect(transport.count('dungeon_fights')).toBe(1);
    expect(transport.count('visible_events')).toBe(0);
  });

  test('keeps credited room pay in Your rewards and out of Everyone after replay expiry', async ({ page, context }) => {
    await routeDungeon(context, 'member-fell-party-cleared', { owner: true, expired: true });
    await page.goto('/game/');
    const results = await openMenu(page, 'Results');
    await results.getByRole('tab', { name: 'Everyone' }).click();
    const outcome = 'Wolf Den: Aster fell before the party cleared the dungeon';
    await expect(results.getByText(new RegExp(outcome))).toBeVisible();
    await expect(results.getByText('+2 gold')).toHaveCount(0);
    await results.getByRole('tab', { name: 'Your rewards' }).click();
    await expect(results.getByText('Wolf Den: you fell before the party cleared the dungeon')).toBeVisible();
    await expect(results.getByText('+2 gold', { exact: true })).toBeVisible();
    await expect(results.getByText('+12 XP', { exact: true })).toBeVisible();
    await expect(results.getByRole('button', { name: /^Replay:/ })).toHaveCount(0);
  });
});
