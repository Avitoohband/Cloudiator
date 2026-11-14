import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from './fixtures';
import type { ResultRow } from '../../supabase/functions/_shared/contracts/reads';
import { ownerFixture } from '../fixtures/domain';
import { dungeonLiveData, emptyWorld, routeLiveReads, seedSession, type LiveTransport } from './live-routes';
import { expectOwnerShown, menuDialog, openMenu, quietArrivals } from './shell-helpers';

// Patch 1.9 Task 32 (menus with Back and Next): the Results menu's three tabs each page their own list, eight a page. Everyone reads 50 results
// at a time: Next past the fifty read reads the next fifty ("Page 7" with "more to see" until the last is read), a failed read keeps the page and
// says so, a second Next during a read does nothing, a tab switch goes back to page 1, and Back from a replay lands on the page and row it was
// opened from. Your rewards (the dungeon rewards of the 20 latest notifications) are all read: "Page 1 of 3". My bouts is in my-bouts.spec.ts.

const production = process.env.PLAYWRIGHT_STATIC === 'true';
test.skip(production, 'These checks use the routed transport.');

const MIN = 60_000, DAY = 86_400_000;

/** `count` public results, newest first, each with a kept replay (a bout of Aster's) and a name of its own. */
function results(nowMs: number, count: number): ResultRow[] {
  return Array.from({ length: count }, (_, i) => {
    const activityId = randomUUID(), settledAtMs = nowMs - (i + 5) * MIN;
    return { gladiatorId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, name: `Walker ${i + 1}`,
      summary: { activityId, resolvedKind: 'arena', result: 'victory', success: true, settledAtMs, replayExpiry: { state: 'available', expiresAtMs: settledAtMs + 7 * DAY } } };
  });
}

const tab = (menu: Locator, name: string) => menu.getByRole('tab', { name: new RegExp(`^${name}`) });
const list = (menu: Locator, name: string) => menu.getByRole('list', { name });
const bar = (menu: Locator) => menu.getByRole('navigation', { name: 'Pages' });
const label = (menu: Locator) => bar(menu).locator('b').first();

async function openResults(page: Page, context: Parameters<typeof quietArrivals>[0], extra: Partial<Parameters<typeof routeLiveReads>[1]> = {}, count = 120) {
  await quietArrivals(context);
  await seedSession(context);
  const now = Date.now();
  const live: LiveTransport = await routeLiveReads(context, { world: emptyWorld(now), owner: ownerFixture, recent: results(now, count), ...extra });
  await page.goto('/game/');
  await expectOwnerShown(page, 'Aster');
  const menu = await openMenu(page, 'Results');
  await expect(tab(menu, 'My bouts')).toBeVisible({ timeout: 45_000 });
  return { live, menu };
}

async function everyone(menu: Locator) {
  await tab(menu, 'Everyone').click();
  await expect(tab(menu, 'Everyone')).toHaveAttribute('aria-selected', 'true');
  await expect(list(menu, 'Recent results').getByRole('listitem')).toHaveCount(8, { timeout: 45_000 });
}

test.describe('Results in pages', () => {
  test('Everyone: eight a page; Next past the fifty read reads the next fifty, once, and the tab goes back to page 1', async ({ page, context }) => {
    const { live, menu } = await openResults(page, context);
    await everyone(menu);
    await expect(label(menu)).toHaveText('Page 1');
    await expect(bar(menu)).toContainText('more to see');
    await expect(menu.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);
    const next = bar(menu).getByRole('button', { name: 'Next page', exact: true });
    await next.click();
    await expect(label(menu)).toHaveText('Page 2');
    await expect(list(menu, 'Recent results').getByRole('listitem').first()).toBeFocused();
    // Fifty results are six full pages (the last two of the fifty wait for the read of the rest).
    await bar(menu).getByRole('button', { name: 'Go to page 6', exact: true }).click();
    await expect(label(menu)).toHaveText('Page 6');
    const before = live.count('recent_results');
    live.delay('recent_results', 800);
    await next.click();
    await next.dispatchEvent('click');
    await expect(label(menu)).toHaveText('Page 7', { timeout: 15_000 });
    expect(live.count('recent_results') - before).toBe(1);
    await expect(list(menu, 'Recent results').getByRole('listitem')).toHaveCount(8);
    // Another tab and back: page 1 again.
    await tab(menu, 'My bouts').click();
    await expect(bar(menu)).toHaveCount(0);
    await tab(menu, 'Everyone').click();
    await expect(list(menu, 'Recent results').getByRole('listitem')).toHaveCount(8);
    await expect(label(menu)).toHaveText('Page 1');
  });

  test('a page of eight fits the menu on page 1 and page 2, without a scroll', async ({ page, context }) => {
    const { menu } = await openResults(page, context);
    await everyone(menu);
    await menu.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished)));
    const fits = () => menu.getByTestId('menu-body').evaluate(el => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    let measured = await fits();
    expect(measured.scroll, 'page 1').toBeLessThanOrEqual(measured.client + 1);
    await bar(menu).getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(label(menu)).toHaveText('Page 2');
    measured = await fits();
    expect(measured.scroll, 'page 2').toBeLessThanOrEqual(measured.client + 1);
  });

  test('Everyone: the last server page ends the list and the label knows it; a failed read says so and keeps the page', async ({ page, context }) => {
    const { live, menu } = await openResults(page, context, {}, 60);
    await everyone(menu);
    const next = bar(menu).getByRole('button', { name: 'Next page', exact: true });
    await bar(menu).getByRole('button', { name: 'Go to page 6', exact: true }).click();
    live.fail('recent_results');
    await next.click();
    await expect(bar(menu)).toContainText('Could not load more. Try Next again.');
    await expect(label(menu)).toHaveText('Page 6');
    await expect(list(menu, 'Recent results').getByRole('listitem')).toHaveCount(8);
    live.fail('recent_results', false);
    await next.click();
    // Sixty results: eight pages, the last of four.
    await expect(label(menu)).toHaveText('Page 7 of 8');
    await bar(menu).getByRole('button', { name: 'Go to page 8', exact: true }).click();
    await expect(list(menu, 'Recent results').getByRole('listitem')).toHaveCount(4);
    await expect(next).toHaveAttribute('aria-disabled', 'true');
  });

  test('Back from a replay lands on the page and the row it was opened from', async ({ page, context }) => {
    const { menu } = await openResults(page, context);
    await everyone(menu);
    const next = bar(menu).getByRole('button', { name: 'Next page', exact: true });
    await next.click();
    await next.click();
    await expect(label(menu)).toHaveText('Page 3');
    const opener = list(menu, 'Recent results').getByRole('listitem').nth(3).getByRole('button', { name: /^Replay:/ });
    const name = (await opener.getAttribute('aria-label'))!;
    await opener.click();
    const replay = page.getByRole('dialog', { name: 'Replay', exact: true });
    await expect(replay).toBeVisible();
    await page.getByRole('button', { name: /^Back to Results/ }).click();
    await expect(replay).toHaveCount(0);
    await expect(menuDialog(page, 'Results')).toBeVisible();
    await expect(label(menu)).toHaveText('Page 3');
    await expect(menu.getByRole('button', { name, exact: true })).toBeVisible();
  });

  test('Your rewards: the dungeon rewards of the notifications, eight a page, "Page 1 of 3", and a tab goes back to page 1', async ({ page, context }) => {
    const data = dungeonLiveData('full-victory', { owner: ownerFixture });
    const note = data.notifications![0];
    const notifications = Array.from({ length: 20 }, (_, i) => ({ ...note, summary: { ...note.summary, activityId: randomUUID(), settledAtMs: note.summary.settledAtMs - i * MIN } }));
    await quietArrivals(context);
    await seedSession(context);
    await routeLiveReads(context, { ...data, owner: ownerFixture, notifications, world: { ...data.world, actors: [] } });
    await page.goto('/game/');
    await expectOwnerShown(page, 'Aster');
    const menu = await openMenu(page, 'Results');
    await tab(menu, 'Your rewards').click();
    const rewards = list(menu, 'Dungeon rewards');
    await expect(rewards.locator('> li')).toHaveCount(8, { timeout: 45_000 });
    await expect(label(menu)).toHaveText('Page 1 of 3');
    await bar(menu).getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(label(menu)).toHaveText('Page 2 of 3');
    await bar(menu).getByRole('button', { name: 'Go to page 3', exact: true }).click();
    await expect(rewards.locator('> li')).toHaveCount(4);
    await tab(menu, 'Everyone').click();
    await tab(menu, 'Your rewards').click();
    await expect(rewards.locator('> li')).toHaveCount(8);
    await expect(label(menu)).toHaveText('Page 1 of 3');
  });
});
