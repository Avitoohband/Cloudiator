import { expect, test, type Locator, type Page } from './fixtures';
import { MENU_PREFS_KEY } from '../../src/features/shell/menu-prefs';
import { cornerChip, expectOwnerShown, menuDialog, railMenus, touchLayout } from './shell-helpers';

// Patch 1.9, Task 5: the menu can be pinned and moved to the left, right or bottom edge (device preference).

type Box = { x: number; y: number; width: number; height: number };
const boxOf = async (locator: Locator): Promise<Box> => (await locator.boundingBox())!;
const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const rail = (page: Page) => page.getByTestId('menu-rail');
const settings = (page: Page) => menuDialog(page, 'Settings');
const pinSwitch = (page: Page) => settings(page).getByRole('switch', { name: 'Keep the menu open' });
const positions = (page: Page) => settings(page).getByRole('radiogroup', { name: 'Menu position' });
const placeRadio = (page: Page, place: 'Left' | 'Right' | 'Bottom') => positions(page).getByRole('radio', { name: place, exact: true });
const banner = (page: Page) => page.getByTestId('arrival-banner');
const notices = (page: Page) => page.locator('[data-notices]');
const settled = async (locator: Locator) => { await locator.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished))); return locator; };
const shotDir = process.env.MENU_PIN_SHOT_DIR;

// Production builds always refuse the fixture preview (next.config.ts), so these cases run in the development suite only.
test.beforeEach(() => { test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'The camp harness runs on the fixture preview only.'); });

async function openCamp(page: Page, saved?: string, query = '') {
  if (saved !== undefined) await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MENU_PREFS_KEY, saved]);
  await page.goto(`/game/?mode=fixture${query}`);
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
  await expectOwnerShown(page, 'Aster');
}
/** Opens the menu named `label` from the (pinned) rail wherever it is, and returns its panel. */
async function openMenuAt(page: Page, label: string) {
  await expect(rail(page)).toHaveAttribute('data-revealed', 'true');
  await rail(page).getByRole('button', { name: label, exact: true }).click();
  const dialog = menuDialog(page, label);
  await expect(dialog).toBeVisible();
  return dialog;
}
/** Opens Settings from the rail (wherever it is) and returns its panel. */
async function openSettings(page: Page) {
  const rail_ = rail(page);
  if ((await rail_.getAttribute('data-revealed')) !== 'true') {
    const place = (await rail_.getAttribute('data-place')) ?? 'left';
    const size = page.viewportSize()!;
    await page.mouse.move(...(place === 'right' ? [size.width - 3, 500] : place === 'bottom' ? [size.width / 2, size.height - 3] : [2, 400]) as [number, number]);
    await expect(rail_).toHaveAttribute('data-revealed', 'true');
  }
  if (!(await settings(page).isVisible())) await rail(page).getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings(page)).toBeVisible();
}
async function choose(page: Page, place: 'left' | 'right' | 'bottom') {
  await openSettings(page);
  await placeRadio(page, (place[0].toUpperCase() + place.slice(1)) as 'Left').check();
  await expect(rail(page)).toHaveAttribute('data-place', place);
}

test.describe('the menu pin and position (pointer layout)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test.beforeEach(({}, testInfo) => { test.skip(testInfo.project.name !== 'desktop', 'The pin and the position are the pointer layout.'); });

  test('has no pin or position buttons on the rail; Settings holds a Menu section with a switch and Left, Right, Bottom', async ({ page }) => {
    await openCamp(page);
    await openSettings(page);
    await expect(rail(page).getByRole('button', { name: /^(Pin|Unpin) menu$|^Menu position$/ })).toHaveCount(0);
    // The gear is the last rail entry, below the zoom buttons.
    const gear = await boxOf(rail(page).getByRole('button', { name: 'Settings', exact: true }));
    const reset = await boxOf(rail(page).getByRole('button', { name: 'Reset zoom', exact: true }));
    expect(gear.y).toBeGreaterThan(reset.y);
    // Ordered by where the menu goes: Left, Bottom, Right.
    expect(await positions(page).getByRole('radio').evaluateAll(els => els.map(e => (e as HTMLInputElement).value))).toEqual(['left', 'bottom', 'right']);
    await expect(settings(page).getByText('Off: it slides away when you move off it.')).toBeVisible();
    await expect(settings(page).getByText('Saved in this browser. Changes apply at once.')).toBeVisible();
    await expect(settings(page).getByRole('heading', { name: 'Menu', exact: true })).toBeVisible();
    await expect(pinSwitch(page)).not.toBeChecked();
    await expect(positions(page).getByRole('radio')).toHaveCount(3);
    // Task 11: the Names and Titles choices follow in their own section.
    await expect(settings(page).getByRole('radio')).toHaveCount(3 + 6);
    await expect(placeRadio(page, 'Left')).toBeChecked();
  });

  test('keeps the rail shown while pinned, and slides it away again once unpinned', async ({ page }) => {
    await openCamp(page);
    await openSettings(page);
    if (!(await pinSwitch(page).isChecked())) await pinSwitch(page).click();
    await settings(page).getByRole('button', { name: 'Close' }).click();
    await page.mouse.move(640, 360);
    await page.waitForTimeout(700);
    await expect(rail(page)).toHaveAttribute('data-revealed', 'true');
    expect((await boxOf(rail(page))).x).toBeGreaterThanOrEqual(0);
    await expect(page.getByTestId('menu-grip')).toHaveCSS('opacity', '0');
    await rail(page).getByRole('button', { name: 'Settings', exact: true }).click();
    await pinSwitch(page).click();
    await settings(page).getByRole('button', { name: 'Close' }).click();
    // The pointer comes onto the rail and leaves it: the usual 300 ms hide.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(30, 400);
    await page.mouse.move(640, 360);
    await expect(rail(page)).toHaveAttribute('data-revealed', 'false');
  });

  test('Right: a rail and panel clear of the chip, the banner and a second notice, with the panel to the rail\'s left', async ({ page }) => {
    await openCamp(page, undefined, '&signin=cancelled');
    await expect(banner(page)).toBeVisible();
    await openSettings(page);
    if (!(await pinSwitch(page).isChecked())) await pinSwitch(page).click();
    await choose(page, 'right');
    await rail(page).getByRole('button', { name: 'Inventory and shops', exact: true }).click();
    const panel = await settled(menuDialog(page, 'Inventory and shops'));
    await expect(panel).toBeVisible();
    const r = await boxOf(rail(page));
    const p = await boxOf(panel);
    const chip = await boxOf(cornerChip(page));
    const arrival = await boxOf(banner(page));
    const column = await boxOf(notices(page));
    // Two things stack under the chip: the banner and the sign-in notice, so the column is taller than the banner alone.
    expect(column.height).toBeGreaterThan(arrival.height + 20);
    expect(r.x + r.width).toBeLessThanOrEqual(1280 - 8 + 1);
    expect(r.x + r.width).toBeGreaterThan(1280 - 70);
    for (const above of [chip.y + chip.height, arrival.y + arrival.height, column.y + column.height]) {
      expect(r.y).toBeGreaterThanOrEqual(above + 8);
      expect(p.y).toBeGreaterThanOrEqual(above);
    }
    expect(p.x + p.width).toBeLessThanOrEqual(r.x);
    expect(intersects(p, r)).toBe(false);
    for (const other of [chip, arrival, column]) expect(intersects(p, other)).toBe(false);
    if (shotDir) await page.screenshot({ path: `${shotDir}/task-5-right.png` });
  });

  test('Bottom: a centred bar with tooltips above, and the panel above it', async ({ page }) => {
    await openCamp(page);
    await openSettings(page);
    if (!(await pinSwitch(page).isChecked())) await pinSwitch(page).click();
    await choose(page, 'bottom');
    await settings(page).getByRole('button', { name: 'Close' }).click();
    await expect.poll(async () => { const b = await boxOf(rail(page)); return Math.abs(b.x + b.width / 2 - 640) <= 2; }).toBe(true);
    const r = await boxOf(rail(page));
    expect(r.width).toBeGreaterThan(r.height);
    expect(Math.abs(r.x + r.width / 2 - 640)).toBeLessThanOrEqual(2);
    expect(Math.abs(r.y + r.height - (800 - 8))).toBeLessThanOrEqual(2);
    await rail(page).getByRole('button', { name: 'Schedule', exact: true }).hover();
    const tip = page.getByRole('tooltip');
    await expect(tip).toHaveText('Schedule');
    const t = await boxOf(tip);
    expect(t.y + t.height).toBeLessThanOrEqual(r.y);
    await rail(page).getByRole('button', { name: 'Inventory and shops', exact: true }).click();
    const panel = await settled(menuDialog(page, 'Inventory and shops'));
    const p = await boxOf(panel);
    expect(p.y + p.height).toBeLessThanOrEqual(r.y);
    expect(intersects(p, await boxOf(cornerChip(page)))).toBe(false);
    expect(Math.abs(p.x + p.width / 2 - 640)).toBeLessThanOrEqual(2);
    if (shotDir) await page.screenshot({ path: `${shotDir}/task-5-bottom.png` });
  });

  test('Unpinned on the right: the 12 px reveal zone and the grip move to that edge', async ({ page }) => {
    await openCamp(page);
    await choose(page, 'right');
    await settings(page).getByRole('button', { name: 'Close' }).click();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(1260, 480);
    await page.mouse.move(640, 360);
    await expect(rail(page)).toHaveAttribute('data-revealed', 'false');
    // It has finished sliding off the right edge.
    await expect.poll(async () => (await boxOf(rail(page))).x).toBeGreaterThanOrEqual(1280);
    const grip = await boxOf(page.getByTestId('menu-grip'));
    expect([grip.x + grip.width, grip.width]).toEqual([1280, 5]);
    await page.mouse.move(1280 - 13, 500);
    await page.waitForTimeout(400);
    await expect(rail(page)).toHaveAttribute('data-revealed', 'false');
    await page.mouse.move(1280 - 3, 500);
    await expect(rail(page)).toHaveAttribute('data-revealed', 'true');
    await page.mouse.move(640, 360);
    await expect(rail(page)).toHaveAttribute('data-revealed', 'false');
    // The left edge no longer reveals it.
    await page.mouse.move(2, 400);
    await page.waitForTimeout(400);
    await expect(rail(page)).toHaveAttribute('data-revealed', 'false');
  });

  test('remembers the choice on this browser', async ({ page }) => {
    await openCamp(page);
    await openSettings(page);
    if (!(await pinSwitch(page).isChecked())) await pinSwitch(page).click();
    await choose(page, 'bottom');
    await page.reload();
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    await expect(rail(page)).toHaveAttribute('data-place', 'bottom');
    await expect(rail(page)).toHaveAttribute('data-revealed', 'true');
    await rail(page).getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(pinSwitch(page)).toBeChecked();
    await expect(placeRadio(page, 'Bottom')).toBeChecked();
  });

  test('a bad saved value starts on the left, unpinned', async ({ page }) => {
    await openCamp(page, '{"pinned":"maybe","place":"up"}');
    await expect(rail(page)).toHaveAttribute('data-place', 'left');
    await expect(rail(page)).toHaveAttribute('data-revealed', 'false');
  });
});

test.describe('the phone layout', () => {
  test('keeps the ☰ menu, without the pin and the position, whatever was saved', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'The phone layout is the mobile project.');
    await openCamp(page, '{"pinned":true,"place":"right"}');
    expect(await touchLayout(page)).toBe(true);
    const burger = page.getByRole('button', { name: 'Menus', exact: true });
    await expect(burger).toHaveAttribute('aria-expanded', 'false');
    await expect(rail(page)).toBeHidden();
    await burger.click();
    await expect(rail(page)).toHaveAttribute('data-revealed', 'true');
    await expect(railMenus(page)).toBeVisible();
    const r = await boxOf(rail(page));
    expect(r.x).toBeLessThan(200);
    expect(r.y).toBeGreaterThan(600);
    await expect(rail(page).getByRole('button', { name: /^(Pin|Unpin) menu$|^Menu position$/ })).toHaveCount(0);
    await rail(page).getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(settings(page).getByText('Menu options are available with a mouse or trackpad.')).toBeVisible();
    await expect(settings(page).getByRole('switch')).toHaveCount(0);
    await expect(positions(page)).toHaveCount(0);
    // Task 11: Names and titles work on phones too.
    await expect(settings(page).getByRole('radiogroup', { name: 'Names', exact: true }).getByRole('radio')).toHaveCount(3);
  });
});

for (const place of ['left', 'right', 'bottom'] as const) {
  test.describe(`a short window (1280×640), menu on the ${place}`, () => {
    test.use({ viewport: { width: 1280, height: 640 } });
    test.beforeEach(({}, testInfo) => { test.skip(testInfo.project.name !== 'desktop', 'The pointer layout.'); });

    test('keeps the whole rail in view, the gear fully visible and clickable', async ({ page }) => {
      await openCamp(page, JSON.stringify({ pinned: true, place }), '&signin=cancelled');
      await expect(banner(page)).toBeVisible();
      await expect(rail(page)).toHaveAttribute('data-revealed', 'true');
      await expect.poll(async () => { const b = await boxOf(rail(page)); return b.y >= 0 && b.y + b.height <= 640; }).toBe(true);
      const r = await boxOf(rail(page));
      const gearButton = rail(page).getByRole('button', { name: 'Settings', exact: true });
      await expect.poll(async () => { const g = await boxOf(gearButton); return g.y >= 0 && g.y + g.height <= 640 && g.x >= 0 && g.x + g.width <= 1280; }).toBe(true);
      expect(r.y + r.height).toBeLessThanOrEqual(640 - 4);
      if (place === 'right') expect(r.y).toBeGreaterThanOrEqual((await boxOf(notices(page))).y + (await boxOf(notices(page))).height);
      // Every button keeps a usable size, and the gear opens Settings.
      expect((await boxOf(gearButton)).width).toBeGreaterThanOrEqual(24);
      await gearButton.click();
      await expect(settings(page)).toBeVisible();
    });
  });
}

for (const place of ['right', 'bottom'] as const) {
  test.describe(`a profile card opened from a list, menu on the ${place}`, () => {
    test.beforeEach(({}, testInfo) => { test.skip(testInfo.project.name !== 'desktop', 'The pointer layout.'); });

    test('sits beside the open panel, never over it or the rail', async ({ page }) => {
      await openCamp(page, JSON.stringify({ pinned: true, place }));
      const list = await openMenuAt(page, 'Gladiators');
      await settled(list);
      const row = list.getByRole('button', { name: /^Profile: / }).first();
      await row.click();
      const card = page.getByRole('dialog', { name: /^Profile: / });
      await expect(card).toBeVisible();
      const panelBox = await boxOf(list);
      await expect.poll(async () => !intersects(await boxOf(card), panelBox)).toBe(true);
      const c = await boxOf(card);
      expect(intersects(c, await boxOf(rail(page)))).toBe(false);
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x + c.width).toBeLessThanOrEqual(1280);
      expect(c.y + c.height).toBeLessThanOrEqual(page.viewportSize()!.height);
      if (place === 'right') expect(c.x + c.width).toBeLessThanOrEqual(panelBox.x);
    });
  });
}
