import { expect, test, type Locator, type Page } from '@playwright/test';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { MENUS } from '../../src/features/shell/menus';
import { emptyWorld, routeLiveReads, seedSession } from './live-routes';
import { cornerChip, expectOwnerShown, menuDialog, openMenu, railMenus, revealRail, touchLayout } from './shell-helpers';

// Task 13.5: the full-screen camp shell. The camp fills the window; a hidden rail on the left edge (a ☰ button and
// bottom sheets on touch) opens one floating menu at a time; the corner chip sits top right.

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const LABELS = MENUS.map(m => m.label);
type Box = { x: number; y: number; width: number; height: number };
const boxOf = async (locator: Locator): Promise<Box> => (await locator.boundingBox())!;
const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const rail = (page: Page) => page.getByTestId('menu-rail');
const railRight = async (page: Page) => { const b = await boxOf(rail(page)); return b.x + b.width; };
const openSurfaces = (page: Page) => page.locator('[data-menu-surface]:visible');
const camera = (page: Page) => page.evaluate(() => {
  const c = window.__cloudiatorCamp!.state()!.camera;
  return { zoom: c.zoom, x: c.centerX, y: c.centerY };
});
/** Waits for a panel's opening slide (or a sheet's rise) to end, so its box is where it stays. */
const settled = async (locator: Locator) => { await locator.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished))); return locator; };
const nextFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/** The fixture camp, ready, with the fixture owner loaded (the corner chip names it). */
async function openCamp(page: Page, url = '/game/?mode=fixture') {
  await page.goto(url);
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
  await expectOwnerShown(page, 'Aster');
}
const noWebGL = () => {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
    return /webgl/.test(type) ? null : (original as (...a: unknown[]) => RenderingContext | null).call(this, type, ...args);
  } as typeof original;
};

test.describe('the camp shell with a pointer', () => {
  test.skip(production, 'The shell checks use the fixture preview.');
  test.beforeEach(({}, testInfo) => { test.skip(testInfo.project.name !== 'desktop', 'The hover rail is the desktop layout.'); });

  test('shows only the grip and the corner chip at rest', async ({ page }) => {
    await openCamp(page);
    // The camp fills the window: no page header, footer or side column.
    const canvas = await boxOf(page.locator('canvas'));
    expect(canvas).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    await expect(page.locator('header:visible, footer:visible, aside:visible')).toHaveCount(0);
    expect(await railRight(page)).toBeLessThanOrEqual(0);
    const grip = await boxOf(page.getByTestId('menu-grip'));
    expect([grip.x, grip.width]).toEqual([0, 5]);
    expect(Math.abs(grip.y + grip.height / 2 - 360)).toBeLessThanOrEqual(1);
    await expect(openSurfaces(page)).toHaveCount(0);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    // The player chip: name, stamina, money, renown and the slot countdown.
    const chip = cornerChip(page);
    await expect(chip).toBeVisible();
    await expect(chip.getByTestId('chip-stamina')).toHaveText(/104 \/ 104/);
    await expect(chip.getByTestId('chip-money')).toBeVisible();
    await expect(chip.getByTestId('chip-renown')).toBeVisible();
    await expect(chip.getByTestId('chip-countdown')).toHaveText(/^\d{1,2}:\d\d$/);
    const c = await boxOf(chip);
    expect(c.x + c.width).toBeGreaterThan(1280 - 20);
    expect(c.y).toBeLessThan(20);
  });

  test('reveals the rail within 12 px of the left edge and hides it after the pointer leaves', async ({ page }) => {
    await openCamp(page);
    await page.mouse.move(640, 360);
    await page.mouse.move(13, 200);
    await page.waitForTimeout(400);
    expect(await railRight(page), 'not revealed 13 px from the edge').toBeLessThanOrEqual(0);
    await page.mouse.move(11, 200);
    await expect(rail(page)).toHaveAttribute('data-revealed', 'true');
    await expect.poll(async () => (await boxOf(rail(page))).x).toBeGreaterThanOrEqual(0);
    // It slides away 300 ms after the pointer leaves.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="menu-rail"]')!;
      (window as unknown as { hidAt: number | null }).hidAt = null;
      new MutationObserver(() => {
        const w = window as unknown as { hidAt: number | null };
        if (el.getAttribute('data-revealed') === 'false' && w.hidAt === null) w.hidAt = performance.now();
      }).observe(el, { attributes: true });
    });
    const left = await page.evaluate(() => performance.now());
    await page.mouse.move(640, 360);
    await expect.poll(() => page.evaluate(() => (window as unknown as { hidAt: number | null }).hidAt)).not.toBeNull();
    const hidAt = await page.evaluate(() => (window as unknown as { hidAt: number }).hidAt);
    expect(hidAt - left).toBeGreaterThanOrEqual(290);
    expect(hidAt - left).toBeLessThan(1500);
    await expect.poll(() => railRight(page)).toBeLessThanOrEqual(0);
    // The grip reveals it too.
    const grip = await boxOf(page.getByTestId('menu-grip'));
    await page.mouse.move(grip.x + 2, grip.y + grip.height / 2);
    await expect(rail(page)).toHaveAttribute('data-revealed', 'true');
  });

  test('names each rail icon on hover', async ({ page }) => {
    await openCamp(page);
    await revealRail(page);
    const icons = railMenus(page).getByRole('button');
    expect(await icons.evaluateAll(els => els.map(e => e.getAttribute('aria-label')))).toEqual(LABELS);
    for (const [i, label] of LABELS.entries()) {
      await icons.nth(i).hover();
      const tip = page.getByRole('tooltip');
      await expect(tip).toHaveText(label);
      // Beside its icon, never over it.
      const [t, b] = [await boxOf(tip), await boxOf(icons.nth(i))];
      expect(t.x).toBeGreaterThanOrEqual(b.x + b.width);
      expect(Math.abs((t.y + t.height / 2) - (b.y + b.height / 2))).toBeLessThan(b.height / 2);
    }
  });

  test('reveals the rail on the first Tab and returns focus to the icon on Escape', async ({ page }) => {
    await openCamp(page);
    await page.keyboard.press('Tab');
    const icons = railMenus(page).getByRole('button');
    await expect(icons.first()).toBeFocused();
    await expect(rail(page)).toHaveAttribute('data-revealed', 'true');
    // Tab order: the rail icons (the menus, then the zoom buttons at its bottom), then the corner chip.
    const focused = () => page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el?.closest('[data-testid="corner-chip"]') ? 'corner chip' : el?.getAttribute('aria-label') ?? el?.tagName ?? null;
    });
    const order = [await focused()];
    for (let i = 0; i < 10; i++) { await page.keyboard.press('Tab'); order.push(await focused()); }
    expect(order).toEqual([...LABELS, 'Zoom in', 'Zoom out', 'Reset zoom', 'corner chip']);
    // Back to Schedule: Enter opens its panel and moves the focus into it; Escape closes it and returns the focus.
    await icons.nth(1).focus();
    await page.keyboard.press('Enter');
    const panel = menuDialog(page, 'Schedule');
    await expect(panel).toBeVisible();
    expect(await panel.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(icons.nth(1)).toBeFocused();
    await expect(rail(page)).toHaveAttribute('data-revealed', 'true');
  });

  test('opens one panel at a time; the camp, Escape or the same icon closes it', async ({ page }) => {
    await openCamp(page);
    const schedule = await openMenu(page, 'Schedule');
    await expect(schedule.getByRole('heading', { name: 'Repeating schedule' })).toBeVisible();
    const inventoryIcon = railMenus(page).getByRole('button', { name: 'Inventory and shops', exact: true });
    await inventoryIcon.click();
    await expect(menuDialog(page, 'Inventory and shops')).toBeVisible();
    await expect(openSurfaces(page)).toHaveCount(1);
    await expect(inventoryIcon).toHaveAttribute('aria-expanded', 'true');
    // Panels sit beside the rail, below the chip row, and scroll internally.
    const panel = await boxOf(await settled(menuDialog(page, 'Inventory and shops')));
    expect([panel.x, panel.y, panel.width]).toEqual([66, 64, 380]);
    expect(panel.y + panel.height).toBeLessThanOrEqual(720);
    // The same icon closes it.
    await inventoryIcon.click();
    await expect(openSurfaces(page)).toHaveCount(0);
    await expect(inventoryIcon).toHaveAttribute('aria-expanded', 'false');
    // The rail stays while a panel is open, even after the pointer leaves.
    await openMenu(page, 'Results');
    await page.mouse.move(700, 300);
    await page.waitForTimeout(600);
    await expect(rail(page)).toHaveAttribute('data-revealed', 'true');
    // A click on the camp closes it and hides the rail.
    await page.evaluate(() => window.__cloudiatorCamp!.centerOn(2, 2, 1));
    await nextFrames(page);
    await page.mouse.click(1100, 600);
    await expect(openSurfaces(page)).toHaveCount(0);
    await expect.poll(() => railRight(page)).toBeLessThanOrEqual(0);
    // Escape closes it.
    await openMenu(page, 'Gladiators');
    await page.keyboard.press('Escape');
    await expect(openSurfaces(page)).toHaveCount(0);
  });

  test('never lets a panel cover the corner chip', async ({ page }) => {
    for (const size of [{ width: 1280, height: 720 }, { width: 1024, height: 640 }]) {
      await page.setViewportSize(size);
      await openCamp(page);
      const chip = await boxOf(cornerChip(page));
      for (const label of LABELS) {
        const panel = await boxOf(await settled(await openMenu(page, label)));
        expect(intersects(panel, chip), `${label} at ${size.width}×${size.height}`).toBe(false);
        expect(panel.y + panel.height, label).toBeLessThanOrEqual(size.height);
      }
    }
  });
});

test.describe('the camp shell on any device', () => {
  test.skip(production, 'The shell checks use the fixture preview.');

  test('typing in a menu field never moves the camera', async ({ page }) => {
    await openCamp(page);
    const before = await camera(page);
    const roster = await openMenu(page, 'Gladiators');
    const filter = roster.getByRole('searchbox', { name: 'Filter by name' });
    await filter.focus();
    await page.keyboard.type('+0');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('-=_');
    await expect(filter).toHaveValue('+0-=_');
    await nextFrames(page);
    expect(await camera(page)).toEqual(before);
    // The same keys on the camp itself do move it.
    await page.getByRole('application').focus();
    await page.keyboard.press('+');
    await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(before.zoom);
  });

  test('keeps the menus usable when the camp scene is unavailable', async ({ page }) => {
    await page.addInitScript(noWebGL);
    await page.goto('/game/?mode=fixture');
    const notice = page.getByText(/needs WebGL/);
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expectOwnerShown(page, 'Aster');
    const roster = await openMenu(page, 'Gladiators');
    const find = roster.getByRole('button', { name: 'Find my gladiator' });
    await expect(find).toBeDisabled();
    await expect(find).toHaveAccessibleDescription(/camp view is unavailable/);
    await expect(roster.getByRole('button', { name: 'Follow my gladiator' })).toBeDisabled();
    const rowFinds = roster.getByRole('listitem').getByRole('button', { name: /^Find / });
    expect(await rowFinds.count()).toBeGreaterThan(5);
    for (const button of await rowFinds.all()) await expect(button).toBeDisabled();
    // The camp's own notice (its text) stays in view beside the open menu.
    expect(await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('[data-camp-fallback]')!);
      const r = range.getBoundingClientRect();
      return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('[data-camp-fallback]');
    })).toBe(true);
    const schedule = await openMenu(page, 'Schedule');
    await expect(schedule.getByRole('heading', { name: 'Repeating schedule' })).toBeVisible();
    await revealRail(page);
    await expect(page.getByRole('button', { name: 'Zoom in' })).toHaveCount(0);
  });

  test('never passes a click on a menu through to the camp below it', async ({ page }) => {
    await openCamp(page);
    const panel = await settled(await openMenu(page, 'Results'));
    // The owner, moved under the panel's title.
    const title = await boxOf(panel.getByTestId('menu-title'));
    const target = { x: title.x + title.width / 2, y: title.y + title.height / 2 };
    const ownerId = await page.evaluate(() => window.__cloudiatorCamp!.world()!.actors[0].gladiatorId);
    await page.evaluate(({ id, target }) => {
      const hook = window.__cloudiatorCamp!;
      const { camera } = hook.state()!;
      const at = hook.screenOf(id)!;
      // Shift the camera centre (world pixels) so the owner's body lands on the target, then back to tile coordinates.
      const cx = camera.centerX + (at.x - target.x) / camera.zoom, cy = camera.centerY + (at.y - target.y) / camera.zoom;
      hook.centerOn(cx / 64 + cy / 32, cy / 32 - cx / 64);
    }, { id: ownerId, target });
    await nextFrames(page);
    const at = (await page.evaluate(id => window.__cloudiatorCamp!.screenOf(id), ownerId))!;
    expect(Math.hypot(at.x - target.x, at.y - target.y), 'the owner is under the title').toBeLessThan(6);
    await page.evaluate(() => window.__cloudiatorCamp!.emit('find-character', { gladiatorId: 'npc:smith' }));
    await page.mouse.click(target.x, target.y);
    await nextFrames(page);
    expect((await page.evaluate(() => window.__cloudiatorCamp!.state()!)).selected).toBe('npc:smith');
    await expect(panel).toBeVisible();
    await expect(openSurfaces(page)).toHaveCount(1);
  });

  test('closes a menu without an error where checkVisibility is missing (Safari 16.4 to 17.3)', async ({ page }) => {
    // Review I1: the project's browser floor is Safari 16.4; Element.checkVisibility arrived in Safari 17.4.
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { delete (Element.prototype as { checkVisibility?: unknown }).checkVisibility; });
    await openCamp(page);
    expect(await page.evaluate(() => 'checkVisibility' in Element.prototype)).toBe(false);
    const touch = await touchLayout(page);
    const menu = await openMenu(page, 'Results');
    await menu.locator('[data-menu-close]').click();
    await expect(menu).toBeHidden();
    await nextFrames(page);
    // The focus goes back to the menu's icon, and the camp and the menu control stay: no error page replaced them.
    await expect(railMenus(page).getByRole('button', { name: 'Results', exact: true })).toBeFocused();
    await expect(page.getByRole('application')).toBeVisible();
    if (touch) await expect(page.getByRole('button', { name: 'Menus', exact: true })).toBeVisible();
    else await expect(rail(page)).toHaveAttribute('data-revealed', 'true');
    // Escape and the first Tab use the same visibility check.
    await openMenu(page, 'Gladiators');
    await page.keyboard.press('Escape');
    await expect(railMenus(page).getByRole('button', { name: 'Gladiators', exact: true })).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('shows the rail and panels without sliding when reduced motion is preferred', async ({ page }, testInfo) => {
    await openCamp(page);
    await revealRail(page);
    // The pointer layout slides the rail in (the touch row simply appears).
    if (testInfo.project.name === 'desktop') expect(await rail(page).evaluate(el => getComputedStyle(el).transitionDuration)).not.toBe('0s');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const panel = await openMenu(page, 'Arena');
    expect(await rail(page).evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s');
    expect(await panel.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(await panel.evaluate(el => getComputedStyle(el).animationName)).not.toBe('none');
  });
});

test.describe('the camp shell on touch', () => {
  test.skip(production, 'The shell checks use the fixture preview.');
  test.beforeEach(({}, testInfo) => { test.skip(testInfo.project.name !== 'mobile', 'Touch layout runs on the phone project.'); });

  test('opens menus from the ☰ button as bottom sheets and closes them by swipe or ×', async ({ page }) => {
    await openCamp(page);
    await expect(railMenus(page)).toBeHidden();
    const burger = page.getByRole('button', { name: 'Menus', exact: true });
    await expect(burger).toHaveAttribute('aria-expanded', 'false');
    await burger.click();
    await expect(burger).toHaveAttribute('aria-expanded', 'true');
    await expect(railMenus(page).getByRole('button')).toHaveCount(LABELS.length);
    const view = page.viewportSize()!;
    const sheet = await settled(await openMenu(page, 'Arena'));
    const b = await boxOf(sheet);
    expect([b.x, b.width]).toEqual([0, view.width]);
    expect(Math.abs(b.y + b.height - view.height)).toBeLessThanOrEqual(1);
    expect(b.y).toBeGreaterThan(view.height * 0.2);
    // Swiping the sheet's handle down closes it.
    const handle = await boxOf(sheet.getByTestId('sheet-handle'));
    const cdp = await page.context().newCDPSession(page);
    const point = (y: number) => [{ x: handle.x + handle.width / 2, y, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(handle.y + handle.height / 2) });
    for (let dy = 20; dy <= 140; dy += 20) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(handle.y + handle.height / 2 + dy) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(sheet).toBeHidden();
    // So does its × button.
    const results = await openMenu(page, 'Results');
    await results.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(results).toBeHidden();
  });

  test('shows the menu icons as one row that scrolls sideways when it does not fit, without zoom buttons', async ({ page }) => {
    // Spec "Phones and touch": tapping ☰ shows the icons as a row. Touch zooms by pinching, so the row has no zoom buttons.
    await page.setViewportSize({ width: 360, height: 640 });
    await openCamp(page);
    await revealRail(page);
    const icons = railMenus(page).getByRole('button');
    await expect(icons).toHaveCount(LABELS.length);
    const tops = await icons.evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(tops).size, `icon tops ${tops.join(', ')}`).toBe(1);
    await expect(page.getByRole('button', { name: 'Zoom in' })).toHaveCount(0);
    // At 360 px the row scrolls inside its own box; the page never scrolls sideways.
    const row = rail(page);
    const [scrollWidth, clientWidth] = await row.evaluate(el => [el.scrollWidth, el.clientWidth]);
    expect(scrollWidth).toBeGreaterThan(clientWidth);
    const box = await boxOf(row);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await row.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    await expect.poll(() => row.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    const last = await boxOf(icons.last());
    expect(last.x + last.width).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await icons.last().click();
    await expect(menuDialog(page, LABELS.at(-1)!)).toBeVisible();
  });

  test('shrinks the player chip to the name and countdown on touch', async ({ page }) => {
    await openCamp(page);
    const chip = cornerChip(page);
    await expect(chip.getByTestId('chip-name')).toBeVisible();
    await expect(chip.getByTestId('chip-countdown')).toHaveText(/^\d{1,2}:\d\d$/);
    for (const id of ['chip-stamina', 'chip-money', 'chip-renown']) await expect(chip.getByTestId(id), id).toBeHidden();
  });

  test('scrolling inside a sheet never pans the camp', async ({ page }) => {
    await openCamp(page);
    const before = await camera(page);
    const sheet = await settled(await openMenu(page, 'Arena'));
    await expect(sheet.getByRole('table', { name: 'Bronze league standings' }).locator('tbody tr')).toHaveCount(50, { timeout: 15_000 });
    const body = sheet.getByTestId('menu-body');
    const b = await boxOf(body);
    // A finger drag up inside the sheet (real touch events, which the camp's window listeners also hear).
    const cdp = await page.context().newCDPSession(page);
    const x = b.x + b.width / 2, from = b.y + b.height * 0.85;
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', y = 0) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    await touch('touchStart', from);
    for (let dy = 20; dy <= 300; dy += 20) await touch('touchMove', from - dy);
    await touch('touchEnd');
    await expect.poll(() => body.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
    await nextFrames(page);
    expect(await camera(page)).toEqual(before);
  });

  test('fits sheets at 360×640 with no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await openCamp(page);
    for (const label of LABELS) {
      const sheet = await settled(await openMenu(page, label));
      const b = await boxOf(sheet);
      expect(b.x, label).toBeGreaterThanOrEqual(0);
      expect(b.y, label).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, label).toBeLessThanOrEqual(360);
      expect(b.y + b.height, label).toBeLessThanOrEqual(640.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), label).toBe(true);
      expect(await sheet.getByTestId('menu-body').evaluate(el => el.scrollWidth <= el.clientWidth), label).toBe(true);
    }
  });
});

test('opens the same camp at / and /game/', async ({ page, context }) => {
  if (!production) await routeLiveReads(context, { world: { ...worldFixture, revision: 'live-1' } });
  for (const path of ['/', '/game/']) {
    await page.goto(path);
    await expect(page.getByRole('application').or(page.getByLabel('Camp view unavailable'))).toBeVisible({ timeout: 45_000 });
    await expect(rail(page)).toBeAttached();
    await expect(cornerChip(page)).toBeVisible();
    await expect(page.locator('header:visible, footer:visible')).toHaveCount(0);
  }
  if (production) return;
  for (const path of ['/?mode=fixture', '/game/?mode=fixture']) {
    await openCamp(page, path);
    await expect(page.getByText('Fixture mode — progress is not saved online')).toBeVisible();
  }
});

test.describe('live failures in the shell', () => {
  test.skip(production, 'Live mode uses development-only intercepted Supabase transport.');

  test('says when the connection is lost and keeps the last known camp', async ({ page, context }) => {
    const world = { ...worldFixture, revision: 'live-1' };
    const live = await routeLiveReads(context, { world });
    await page.clock.install();
    await page.goto('/game/');
    await page.waitForFunction(n => window.__cloudiatorCamp?.state()?.ready === true && window.__cloudiatorCamp.world()?.actors.length === n, world.actors.length, { timeout: 45_000 });
    const lost = page.getByRole('status').filter({ hasText: 'Connection lost — showing the last known camp' });
    await expect(lost).toHaveCount(0);
    live.fail('world_revision');
    await page.clock.fastForward(30_000);
    await expect(lost).toBeVisible();
    expect(await page.evaluate(() => window.__cloudiatorCamp!.world()!.actors.length)).toBe(world.actors.length);
    // Below the chip, never over it.
    expect(intersects(await boxOf(lost), await boxOf(cornerChip(page)))).toBe(false);
    live.fail('world_revision', false);
    await page.clock.fastForward(30_000);
    await expect(lost).toHaveCount(0);
  });

  test('tells a player when their gladiator could not be refreshed and keeps the last one shown', async ({ page, context }) => {
    await seedSession(context);
    const live = await routeLiveReads(context, { world: emptyWorld(), owner: ownerFixture });
    await page.goto('/game/');
    await expectOwnerShown(page, 'Aster');
    const panel = await openMenu(page, 'My gladiator');
    await expect(panel.getByRole('heading', { name: 'Aster', exact: true })).toBeVisible();
    const stale = panel.getByRole('status').filter({ hasText: 'could not be refreshed' });
    await expect(stale).toHaveCount(0);
    live.fail('owner_state');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(stale).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Aster', exact: true })).toBeVisible();
    live.fail('owner_state', false);
    await panel.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(stale).toHaveCount(0);
  });
});
