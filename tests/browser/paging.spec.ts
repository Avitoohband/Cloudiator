// Patch 1.9 Task 30 (Avi, 2026-11-13: "Menus next and backwards instead of scrolling"; approved mockup
// `.superpowers/design/2026-11-13-paged-menus/`): the Gladiators list, the first one converted, shows 7 rows a page with "‹ Back ·
// Page 2 of 8 · Next ›" pinned to the panel's bottom edge, circles that jump (a hint bubble on hover, a tap, and press-hold-slide on a
// phone), a Show choice kept on this device, PageDown and PageUp, and a tall phone sheet. The fixture preview's world has 50 rows.
import { expect, test, type Locator, type Page } from './fixtures';
import { MENU_PREFS_KEY } from '../../src/features/shell/menu-prefs';
import { PAGE_SIZE_KEY } from '../../src/features/paging/page-size-prefs';
import { contrastIssues, noHorizontalScroll } from './a11y-helpers';
import { createDemoWorld } from '../../src/game/demo-world';
import { openMenu, quietArrivals, touchLayout } from './shell-helpers';
import { routeLiveReads } from './live-routes';
import { worldFixture } from '../fixtures/domain';

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const SHOTS = '.superpowers/sdd/2026-11-12-1.9-additions';

async function openCamp(page: Page) {
  // The arrival banner (Task 30 fix round 3) shortens the phone's tall sheet while it shows: these cases measure the sheet without it.
  await quietArrivals(page.context());
  await page.goto('/game/?mode=fixture');
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
}
const pager = (menu: Locator) => menu.getByRole('navigation', { name: 'Pages' });
const rows = (menu: Locator) => menu.locator('[data-page-row]');
const status = (menu: Locator) => pager(menu).getByRole('status');
const label = (menu: Locator) => pager(menu).locator('b').first();
async function gladiators(page: Page) {
  const menu = await openMenu(page, 'Gladiators');
  await expect(rows(menu)).toHaveCount(7);
  // The panel slides in: measure it once it has settled.
  await menu.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished)));
  return menu;
}
/** Fix round 1 (I6): a full page of the list fits the panel: the menu's body does not scroll. */
const fits = (menu: Locator) => menu.getByTestId('menu-body').evaluate(el => el.scrollHeight <= el.clientHeight + 1);
/** The centre of an element, in page pixels. */
const centre = async (locator: Locator) => {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test.describe('menus with Back and Next: the Gladiators list', () => {
  test.skip(production, 'The camp harness runs on the fixture preview only.');

  test('shows 7 rows a page, turns with Back, Next, a circle and the page keys', async ({ page }) => {
    await openCamp(page);
    const menu = await gladiators(page);
    const bar = pager(menu);
    await expect(label(menu)).toHaveText('Page 1 of 8');
    const back = bar.getByRole('button', { name: 'Previous page', exact: true });
    const next = bar.getByRole('button', { name: 'Next page', exact: true });
    await expect(back).toHaveAttribute('aria-disabled', 'true');
    // A dimmed end stays in place and does nothing (Playwright will not click an aria-disabled button, so the click is dispatched).
    await back.dispatchEvent('click');
    await expect(label(menu)).toHaveText('Page 1 of 8');
    const first = await rows(menu).first().textContent();
    expect(await fits(menu), 'page 1 fits without a scroll').toBe(true);

    await next.click();
    await expect(label(menu)).toHaveText('Page 2 of 8');
    await expect(status(menu)).toHaveText('Page 2 of 8');
    await expect(rows(menu).first()).toBeFocused();
    expect(await rows(menu).first().textContent()).not.toBe(first);
    await expect(back).toHaveAttribute('aria-disabled', 'false');
    expect(await fits(menu), 'page 2 fits without a scroll').toBe(true);
    // One line each: the class and place line is cut, not wrapped, and keeps its whole text in its title.
    const line = rows(menu).first().locator('span[title]').first();
    expect(await line.evaluate(el => el.getBoundingClientRect().height < 24 && getComputedStyle(el).whiteSpace === 'nowrap')).toBe(true);
    expect(await line.getAttribute('title')).toBe(await line.textContent());

    await bar.getByRole('button', { name: 'Go to page 5', exact: true }).click();
    await expect(label(menu)).toHaveText('Page 5 of 8');
    await expect(bar.getByRole('button', { name: 'Go to page 5', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(rows(menu).first()).toBeFocused();

    // The focus is in the panel (on the first row): PageDown and PageUp turn.
    await page.keyboard.press('PageDown');
    await expect(label(menu)).toHaveText('Page 6 of 8');
    await page.keyboard.press('PageUp');
    await page.keyboard.press('PageUp');
    await expect(label(menu)).toHaveText('Page 4 of 8');
    // In the filter the keys are the field's own.
    await menu.getByRole('searchbox', { name: 'Filter by name' }).focus();
    await page.keyboard.press('PageDown');
    await expect(label(menu)).toHaveText('Page 4 of 8');

    await bar.getByRole('button', { name: 'Go to page 8', exact: true }).click();
    await expect(next).toHaveAttribute('aria-disabled', 'true');
    expect(await rows(menu).count()).toBeLessThanOrEqual(7);
    // Closing the menu forgets the page.
    await menu.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(label(await gladiators(page))).toHaveText('Page 1 of 8');
  });

  test('shows a hint bubble on hover and keyboard focus', async ({ page }) => {
    test.skip(await touchLayout(page), 'A phone has no hover; the tap case covers it.');
    await openCamp(page);
    const menu = await gladiators(page);
    const bar = pager(menu);
    await bar.getByRole('button', { name: 'Go to page 3', exact: true }).hover();
    const tip = bar.getByRole('tooltip');
    await expect(tip).toHaveText('Page 3 of 8');
    await expect(tip).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/task-30-dots-hint-desktop.png` });
    await page.mouse.move(600, 400);
    await expect(tip).toHaveCount(0);
    // A click's focus shows no bubble of its own (only hover and keyboard focus do).
    await bar.getByRole('button', { name: 'Go to page 3', exact: true }).click();
    await expect(label(menu)).toHaveText('Page 3 of 8');
    await page.mouse.move(600, 400);
    await expect(tip).toHaveCount(0);
    await bar.getByRole('button', { name: 'Go to page 1', exact: true }).click();
    // Keyboard: Tab onto a circle shows its bubble, and the focus stays where it is.
    await bar.getByRole('button', { name: 'Go to page 1', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(bar.getByRole('button', { name: 'Go to page 2', exact: true })).toBeFocused();
    await expect(tip).toHaveText('Page 2 of 8');
    await page.keyboard.press('Enter');
    await expect(label(menu)).toHaveText('Page 2 of 8');
  });

  test('a tap on a circle jumps and shows its bubble for a moment (phone)', async ({ page }) => {
    test.skip(!(await touchLayout(page)), 'The touch layout only.');
    await openCamp(page);
    const menu = await gladiators(page);
    const bar = pager(menu);
    await bar.getByRole('button', { name: 'Go to page 4', exact: true }).tap();
    await expect(label(menu)).toHaveText('Page 4 of 8');
    const tip = bar.getByRole('tooltip');
    await expect(tip).toHaveText('Page 4 of 8');
    await expect(tip).toHaveCount(0, { timeout: 3_000 });
  });

  test('press, hold and slide across the circles; a quick swipe does nothing (phone)', async ({ page }) => {
    test.skip(!(await touchLayout(page)), 'The touch layout only.');
    await openCamp(page);
    const menu = await gladiators(page);
    const bar = pager(menu);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) => cdp.send('Input.dispatchTouchEvent',
      { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const dot = (n: number) => centre(bar.getByRole('button', { name: `Go to page ${n}`, exact: true }));

    // A quick swipe along the row (no hold) is not a slide and not a tap.
    const [a, d] = [await dot(1), await dot(4)];
    await touch('touchStart', a.x, a.y);
    for (let i = 1; i <= 4; i++) await touch('touchMove', a.x + ((d.x - a.x) * i) / 4, a.y);
    await touch('touchEnd', d.x, d.y);
    await page.waitForTimeout(500);
    await expect(label(menu)).toHaveText('Page 1 of 8');

    // Hold 0.3 s on circle 1, then slide to circle 3: the bubble rides above the finger and says each page; lifting stays.
    const c = await dot(3);
    await touch('touchStart', a.x, a.y);
    await page.waitForTimeout(450);
    await touch('touchMove', a.x + 2, a.y);
    const tip = bar.getByRole('tooltip');
    await expect(tip).toHaveText('Page 1 of 8');
    const mid = await dot(2);
    await touch('touchMove', mid.x, mid.y);
    await expect(label(menu)).toHaveText('Page 2 of 8');
    await touch('touchMove', c.x, c.y);
    await expect(label(menu)).toHaveText('Page 3 of 8');
    await expect(tip).toHaveText('Page 3 of 8');
    const tipBox = (await tip.boundingBox())!;
    expect(tipBox.y + tipBox.height).toBeLessThan(c.y - 12);
    await touch('touchEnd', c.x, c.y);
    await expect(tip).toHaveCount(0);
    await page.waitForTimeout(500);
    await expect(label(menu)).toHaveText('Page 3 of 8');
  });

  test('the filter goes back to page 1 and keeps the focus; 3 rows show no bar', async ({ page }) => {
    await openCamp(page);
    const menu = await gladiators(page);
    await pager(menu).getByRole('button', { name: 'Go to page 3', exact: true }).click();
    const names = await page.evaluate(() => window.__cloudiatorCamp!.world()!.actors.map(actor => actor.name.toLowerCase()));
    const filter = menu.getByRole('searchbox', { name: 'Filter by name' });
    await filter.click();
    await page.keyboard.type('a');
    await expect(filter).toBeFocused();
    await expect(filter).toHaveValue('a');
    const many = names.filter(name => name.includes('a')).length;
    await expect(label(menu)).toHaveText(`Page 1 of ${Math.ceil(many / 7)}`);
    // A filter that leaves 3 rows: no bar.
    const three = [...new Set(names.flatMap(name => [...name].map((_, i) => name.slice(i, i + 2))))]
      .find(part => part.length === 2 && names.filter(name => name.includes(part)).length === 3)!;
    expect(three).toBeTruthy();
    await filter.fill(three);
    await expect(rows(menu)).toHaveCount(3);
    await expect(pager(menu)).toHaveCount(0);
  });

  test('Show 25 scrolls the page under a pinned bar, survives a reload, and Fit gives 7 again', async ({ page }) => {
    await openCamp(page);
    let menu = await gladiators(page);
    const show = pager(menu).getByRole('combobox', { name: 'Rows per page' });
    await expect(show.locator('option')).toHaveText(['Fit (7)', '10', '25', '50']);
    await pager(menu).getByRole('button', { name: 'Go to page 2', exact: true }).click();
    const firstShown = await rows(menu).first().textContent();
    await show.selectOption('25');
    await expect(rows(menu)).toHaveCount(25);
    await expect(label(menu)).toHaveText('Page 1 of 2');
    // The row that was first on screen (row 8) is on this page.
    await expect(rows(menu).filter({ hasText: firstShown! }).first()).toBeVisible();
    const body = menu.getByTestId('menu-body');
    expect(await body.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const [bar, panel] = [(await pager(menu).boundingBox())!, (await menu.boundingBox())!];
    expect(Math.abs(bar.y + bar.height - (panel.y + panel.height))).toBeLessThanOrEqual(2);
    if (!(await touchLayout(page))) await page.screenshot({ path: `${SHOTS}/task-30-show-25-desktop.png` });
    expect(await page.evaluate(key => localStorage.getItem(key), PAGE_SIZE_KEY)).toBe('{"gladiators":25}');

    await page.reload();
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    menu = await openMenu(page, 'Gladiators');
    await expect(rows(menu)).toHaveCount(25);
    await expect(label(menu)).toHaveText('Page 1 of 2');
    await pager(menu).getByRole('combobox', { name: 'Rows per page' }).selectOption({ label: 'Fit (7)' });
    await expect(rows(menu)).toHaveCount(7);
    await expect(label(menu)).toHaveText('Page 1 of 8');
  });

  for (const place of ['left', 'right', 'bottom'] as const) {
    test(`the bar is the panel's bottom edge with the menu pinned ${place}`, async ({ page }) => {
      test.skip(await touchLayout(page), 'The menu edge is a pointer-layout setting.');
      await page.addInitScript(({ key, place }) => localStorage.setItem(key, JSON.stringify({ pinned: true, place })), { key: MENU_PREFS_KEY, place });
      await openCamp(page);
      const menu = await gladiators(page);
      const [bar, panel, rail] = [(await pager(menu).boundingBox())!, (await menu.boundingBox())!, (await page.getByTestId('menu-rail').boundingBox())!];
      expect(Math.abs(bar.y + bar.height - (panel.y + panel.height))).toBeLessThanOrEqual(2);
      expect(bar.x).toBeGreaterThanOrEqual(panel.x - 1);
      expect(bar.x + bar.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
      // Never under the icons.
      const overlaps = bar.x < rail.x + rail.width && rail.x < bar.x + bar.width && bar.y < rail.y + rail.height && rail.y < bar.y + bar.height;
      expect(overlaps).toBe(false);
      for (const name of ['Previous page', 'Next page']) {
        expect((await pager(menu).getByRole('button', { name, exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(35.5);
      }
      if (place === 'left') await page.screenshot({ path: `${SHOTS}/task-30-gladiators-desktop.png` });
      if (place === 'bottom') await page.screenshot({ path: `${SHOTS}/task-30-pinned-bottom-desktop.png` });
    });
  }

  test('on a 360 px phone the sheet is tall, the buttons 44 px, and nothing scrolls sideways; 320 px keeps the circles inside', async ({ page }) => {
    test.skip(!(await touchLayout(page)), 'The touch layout only.');
    await page.setViewportSize({ width: 360, height: 780 });
    await openCamp(page);
    const menu = await gladiators(page);
    const panel = (await menu.boundingBox())!;
    expect(panel.height).toBeGreaterThan(780 * 0.8);
    expect(await fits(menu), 'a full page fits the tall sheet').toBe(true);
    await pager(menu).getByRole('button', { name: 'Next page', exact: true }).click();
    expect(await fits(menu), 'page 2 fits the tall sheet').toBe(true);
    await pager(menu).getByRole('button', { name: 'Go to page 1', exact: true }).click();
    for (const name of ['Previous page', 'Next page']) {
      expect((await pager(menu).getByRole('button', { name, exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    }
    const dots = pager(menu).locator('[data-page-dots]');
    const [dotsBox, buttonsTop] = [(await dots.boundingBox())!, (await pager(menu).getByRole('button', { name: 'Next page' }).boundingBox())!.y];
    expect(dotsBox.height).toBeGreaterThanOrEqual(43.5);
    expect(dotsBox.y + dotsBox.height).toBeLessThanOrEqual(buttonsTop + 1);
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.screenshot({ path: `${SHOTS}/task-30-gladiators-phone.png` });

    await page.setViewportSize({ width: 320, height: 700 });
    await expect(pager(menu).locator('[data-dot]')).toHaveCount(6);
    const row = (await dots.boundingBox())!;
    expect(row.x).toBeGreaterThanOrEqual(0);
    expect(row.x + row.width).toBeLessThanOrEqual(320);
    expect(await dots.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const circle of await pager(menu).locator('[data-dot]').all()) {
      const box = (await circle.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(320);
    }
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('a held circle on a windowed row selects that circle, and a slide moves on from it', async ({ page }, testInfo) => {
    // 320 px: the touch layout's 7-circle cap windows the list's 8 pages (1 2 3 4 5 … 8).
    await page.setViewportSize({ width: 320, height: 700 });
    await openCamp(page);
    const menu = await gladiators(page);
    const bar = pager(menu);
    await expect(bar.locator('[data-page-dots] [aria-hidden="true"]', { hasText: '…' })).toHaveCount(1);
    const touch = testInfo.project.name === 'mobile' ? await page.context().newCDPSession(page) : null;
    const down = async (x: number, y: number) => {
      if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      else { await page.mouse.move(x, y); await page.mouse.down(); }
    };
    const move = async (x: number, y: number) => {
      if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      else await page.mouse.move(x, y);
    };
    const up = async (x: number, y: number) => {
      if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      else { await page.mouse.move(x, y); await page.mouse.up(); }
    };
    // A long, still press on circle 4 selects page 4, not a page far away.
    const four = await centre(bar.getByRole('button', { name: 'Go to page 4', exact: true }));
    await down(four.x, four.y);
    await page.waitForTimeout(600);
    await up(four.x, four.y);
    await expect(label(menu)).toHaveText('Page 4 of 8');
    await page.waitForTimeout(500);
    await expect(label(menu)).toHaveText('Page 4 of 8');
    // Hold the current circle, then slide right about two pages' worth of the row: two pages on.
    const circles = bar.locator('[data-dot]:not([data-dot="more"])');
    const [firstBox, lastBox] = [(await circles.first().boundingBox())!, (await circles.last().boundingBox())!];
    const step = (lastBox.x + lastBox.width - firstBox.x) / 7;
    const at = await centre(bar.getByRole('button', { name: 'Go to page 4', exact: true }));
    await down(at.x, at.y);
    await page.waitForTimeout(450);
    await move(at.x + 1, at.y);
    await expect(label(menu)).toHaveText('Page 4 of 8');
    await move(at.x + step * 2, at.y);
    await expect(label(menu)).toHaveText('Page 6 of 8');
    await up(at.x + step * 2, at.y);
    await page.waitForTimeout(500);
    await expect(label(menu)).toHaveText('Page 6 of 8');
  });

  test('a phone list of 10 pages keeps the circles on their own row above Back and Next (fix round 2)', async ({ page, context }) => {
    test.skip(!(await touchLayout(page)), 'The touch layout only.');
    // 70 gladiators (live mode, a visitor): 10 pages of 7, more than the desktop's 8 circles between the buttons.
    await quietArrivals(context);
    await routeLiveReads(context, { world: createDemoWorld(worldFixture.serverNowMs, 70, 0) });
    await page.goto('/game/');
    const menu = await openMenu(page, 'Gladiators');
    await expect(rows(menu)).toHaveCount(7, { timeout: 45_000 });
    await expect(label(menu)).toHaveText('Page 1 of 10');
    const [dots, next, back] = [(await pager(menu).locator('[data-page-dots]').boundingBox())!,
      (await pager(menu).getByRole('button', { name: 'Next page', exact: true }).boundingBox())!,
      (await pager(menu).getByRole('button', { name: 'Previous page', exact: true }).boundingBox())!];
    expect(dots.height).toBeGreaterThanOrEqual(43.5);
    expect(dots.y + dots.height).toBeLessThanOrEqual(Math.min(next.y, back.y) + 1);
  });

  test('Find my gladiator still finds the owner in the camp, from any page', async ({ page }) => {
    await openCamp(page);
    const menu = await gladiators(page);
    await pager(menu).getByRole('button', { name: 'Go to page 6', exact: true }).click();
    const ownerId = await page.evaluate(() => window.__cloudiatorCamp!.world()!.actors[0].gladiatorId);
    await menu.getByRole('button', { name: 'Find my gladiator', exact: true }).click();
    await expect(menu).toHaveCount(0);
    expect(await page.evaluate(() => window.__cloudiatorCamp!.state()!.selected)).toBe(ownerId);
    // Closing the menu forgot the page: it opens again on page 1, which holds the owner's row (Aster, near the top).
    const again = await gladiators(page);
    await expect(label(again)).toHaveText('Page 1 of 8');
    await expect(again.locator('[data-page-row]').filter({ hasText: '(you)' })).toBeVisible();
  });
});

// Patch 1.9 Task 31 (found while filming): the BOT badge in the Gladiators list was a wide pale bar (the list's `.who span` rule made it a block)
// with pale text. It is a compact badge sized to its text, with text contrast of at least 4.5:1, as the NEW pill is.
test.describe('the BOT badge in the Gladiators list', () => {
  test.skip(production, 'Live mode uses the development-only intercepted Supabase transport.');
  test('is compact, sized to its text, readable, and 7 rows still fit a page', async ({ page, context }) => {
    await quietArrivals(context);
    const world = createDemoWorld(worldFixture.serverNowMs, 10, 0);
    world.actors = world.actors.map((actor, i) => (i >= 7 ? { ...actor, botTeam: 'ludus-nimbus' as const, botDuty: 'off-duty' as const, location: 'orientation' as const, activityId: null } : actor));
    await routeLiveReads(context, { world });
    await page.goto('/game/');
    const menu = await openMenu(page, 'Gladiators');
    await expect(rows(menu).first()).toBeVisible({ timeout: 45_000 });
    await expect(rows(menu)).toHaveCount(7);
    await pager(menu).getByRole('button', { name: 'Next page', exact: true }).click();
    const team = menu.getByRole('list', { name: 'Ludus Nimbus' });
    const badge = team.getByLabel('Bot', { exact: true }).first();
    await expect(badge).toBeVisible();
    const box = await badge.evaluate(el => {
      const row = el.closest('li')!.getBoundingClientRect(), tag = el.getBoundingClientRect(), style = getComputedStyle(el);
      return { tag: tag.width, row: row.width, display: style.display };
    });
    expect(box.display).toBe('inline-block');
    expect(box.tag, 'the badge is as wide as "BOT", not the row').toBeLessThan(60);
    expect(box.tag).toBeLessThan(box.row / 4);
    expect(await contrastIssues(team)).toEqual([]);
    expect(await fits(menu), 'the page with the bots still fits').toBe(true);
  });
});
