// Patch A item 5: on a phone the chip shows only the name and the slot countdown, and tapping the name opens the PC bar under it
// (the account popover made fuller): stamina, gold, renown and the countdown in one row, the stamina line over a stamina bar, the
// Clock switch (item 7) and Sign out. On a PC the bar is always visible, so the menu gains only the Clock row. The touch layout is
// the shell's `(hover: none), (max-width: 480px)`: the phone project is always in it, and the desktop project is in it when the
// window is narrow, so these cases set the window to 390 × 844 and run in both. Live mode uses the development-only intercepted
// Supabase transport (the owner below: stamina 74 / 104, gold 240, renown 35).
import { expect, test, type Locator, type Page } from './fixtures';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { contrastIssues, expectNamedControls, noHorizontalScroll } from './a11y-helpers';
import { routeLiveReads, seedSession } from './live-routes';
import { reviewShot, reviewShot360 } from './review-shots';
import { chipToggle, cornerChip, expectOwnerShown, openChipMenu } from './shell-helpers';

const production = process.env.PLAYWRIGHT_STATIC === 'true';

type Box = { x: number; y: number; width: number; height: number };
const boxOf = async (locator: Locator): Promise<Box> => (await locator.boundingBox())!;
const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** A signed-in owner (Aster, stamina 74 of 104, 240 gold, 35 renown) on the live camp, loaded and drawn. */
async function openLive(page: Page) {
  const context = page.context();
  await seedSession(context);
  const owner = structuredClone(ownerFixture);
  owner.stamina = { current: 74, maximum: 104 };
  owner.wallets = { money: 240, renown: 35 };
  await routeLiveReads(context, { world: { ...worldFixture, revision: 'live-1' }, owner });
  await page.goto('/game/');
  await expectOwnerShown(page, 'Aster');
  // The camp behind the chip is drawn, so a screenshot shows the chip over the real scene.
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
}
const account = (page: Page) => cornerChip(page).getByRole('group', { name: 'Account', exact: true });
const burger = (page: Page) => page.getByRole('button', { name: 'Menus', exact: true });
const STAMINA_LINE = 'Stamina 74 of 104 · a Rest refills it';

test.describe('the bar behind the name', () => {
  test.skip(production, 'Live mode uses the development-only intercepted Supabase transport.');

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('tapping the name opens the PC bar, the stamina bar, the clock and Sign out', async ({ page }, testInfo) => {
      await openLive(page);
      const chip = cornerChip(page);
      // Closed: the chip button shows the name and a countdown only.
      const toggle = chipToggle(page);
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      for (const id of ['chip-stamina', 'chip-money', 'chip-renown']) await expect(chip.getByTestId(id), id).toBeHidden();
      await expect(toggle.getByTestId('chip-name')).toHaveText('Aster');
      await expect(toggle.getByTestId('chip-countdown')).toHaveText(/^\d{1,2}:\d{2}$/);
      await expect(account(page)).toHaveCount(0);
      await reviewShot(page, testInfo, 'phonebar-closed');

      // The tap area of the name is 44 px tall, though the chip keeps its look (about 32 px): points just above and below it are the name's.
      const target = await boxOf(toggle);
      expect(Math.round(target.height)).toBeLessThan(40);
      const x = target.x + target.width / 2;
      for (const y of [target.y - 6, target.y + target.height + 6]) {
        expect(await page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.closest('button')?.getAttribute('aria-controls') ?? null, [x, y]), `the point ${y}`).not.toBeNull();
      }
      await toggle.click();
      const menu = account(page);
      await expect(menu).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');

      // The PC bar's items in its order, then the stamina line over its bar, the clock and Sign out.
      const stamina = menu.getByTestId('bar-stamina'), gold = menu.getByTestId('bar-money'), renown = menu.getByTestId('bar-renown'), slot = menu.getByTestId('bar-countdown');
      const line = menu.getByText(STAMINA_LINE, { exact: true });
      const bar = menu.getByRole('progressbar');
      const clock = menu.getByRole('group', { name: 'Clock', exact: true });
      const signOut = menu.getByRole('button', { name: 'Sign out', exact: true });
      await expect(stamina).toHaveText(/^⚡\s*(Stamina\s*)?74 \/ 104$/);
      await expect(gold).toHaveText(/^💰\s*(Gold\s*)?240$/);
      await expect(renown).toHaveText(/^★\s*(Renown\s*)?35$/);
      await expect(slot).toHaveText(/⏱ \d+:\d{2}/);
      await expect(line).toBeVisible();
      await expect(bar).toBeVisible();
      await expect(bar).toHaveJSProperty('value', 74);
      await expect(bar).toHaveJSProperty('max', 104);
      await expect(clock.getByRole('button', { name: '12-hour', exact: true })).toBeVisible();
      await expect(clock.getByRole('button', { name: '24-hour', exact: true })).toBeVisible();
      await expect(signOut).toBeVisible();
      const handles = await Promise.all([stamina, gold, renown, slot, line, bar, clock, signOut].map(item => item.elementHandle()));
      expect(await page.evaluate(els => els.every((el, i) => i === 0 || !!(els[i - 1]!.compareDocumentPosition(el!) & Node.DOCUMENT_POSITION_FOLLOWING)), handles),
        'the items are in the DOM in the PC bar\'s order').toBe(true);
      // One row for the four bar items, then the stamina line above its bar.
      const [s, g, r, c, l, b] = await Promise.all([stamina, gold, renown, slot, line, bar].map(boxOf));
      expect(new Set([s, g, r, c].map(box => Math.round(box.y))).size, 'the bar items share a row').toBe(1);
      expect(s.x).toBeLessThan(g.x);
      expect(g.x).toBeLessThan(r.x);
      expect(r.x).toBeLessThan(c.x);
      expect(l.y + l.height).toBeLessThanOrEqual(b.y + 1);

      // The popover lies inside the screen and below the chip, never over it or the ☰ button.
      const popover = await boxOf(menu), chipBox = await boxOf(toggle), size = page.viewportSize()!;
      expect(popover.x).toBeGreaterThanOrEqual(0);
      expect(popover.x + popover.width).toBeLessThanOrEqual(size.width);
      expect(popover.y).toBeGreaterThanOrEqual(chipBox.y + chipBox.height);
      expect(popover.y + popover.height).toBeLessThanOrEqual(size.height);
      expect(Math.round(popover.width), 'about 318 px wide at 390 px').toBeGreaterThanOrEqual(300);
      expect(Math.round(popover.width)).toBeLessThanOrEqual(330);
      expect(intersects(popover, await boxOf(burger(page)))).toBe(false);
      expect(await noHorizontalScroll(page)).toBe(true);
      await reviewShot(page, testInfo, 'phonebar-open');
      await reviewShot360(page, testInfo, 'phonebar-open');
    });

    test('closes on a second tap, Escape and a press elsewhere', async ({ page }) => {
      await openLive(page);
      const toggle = chipToggle(page);
      const menu = account(page);
      // The name again.
      await toggle.click();
      await expect(menu).toBeVisible();
      await toggle.click();
      await expect(menu).toBeHidden();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      // Escape, which gives the focus back to the name.
      await toggle.click();
      await expect(menu).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(toggle).toBeFocused();
      // A press elsewhere (the camp, low on the screen between the ☰ button and the right edge).
      await toggle.click();
      await expect(menu).toBeVisible();
      const size = page.viewportSize()!;
      await page.mouse.click(Math.floor(size.width / 2), Math.floor(size.height * 0.6));
      await expect(menu).toBeHidden();
      // A press inside the popover (its stamina line) keeps it open.
      await toggle.click();
      await expect(menu).toBeVisible();
      await menu.getByText(STAMINA_LINE, { exact: true }).click();
      await expect(menu).toBeVisible();
    });

    test('every control is named, the text and the stamina bar meet contrast, and the keyboard reaches the clock and Sign out', async ({ page }) => {
      await openLive(page);
      const toggle = chipToggle(page);
      await toggle.click();
      const menu = account(page);
      await expect(menu).toBeVisible();
      await expectNamedControls(menu, 'the bar behind the name');
      await expect(menu.getByRole('progressbar')).toHaveAccessibleName(STAMINA_LINE);
      // Tab from the name: the 12-hour and 24-hour buttons, Patch history (the patch row, Task 11b), then Sign out (the order of the menu).
      await toggle.focus();
      await page.keyboard.press('Tab');
      await expect(menu.getByRole('button', { name: '12-hour', exact: true })).toBeFocused();
      expect(await contrastIssues(menu, { focusRing: true }), 'the bar behind the name, with a focus ring on the clock').toEqual([]);
      await page.keyboard.press('Tab');
      await expect(menu.getByRole('button', { name: '24-hour', exact: true })).toBeFocused();
      await page.keyboard.press('Space');
      await expect(menu.getByRole('button', { name: '24-hour', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('Tab');
      await expect(menu.getByRole('button', { name: /^Patch history/ })).toBeFocused();
      expect(await contrastIssues(menu, { focusRing: true }), 'the bar behind the name, with a focus ring on Patch history').toEqual([]);
      await page.keyboard.press('Tab');
      await expect(menu.getByRole('button', { name: 'Sign out', exact: true })).toBeFocused();
      expect(await contrastIssues(menu, { focusRing: true }), 'the bar behind the name, with a focus ring on Sign out').toEqual([]);
    });

    test('fits 360 × 740', async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 360, height: 740 });
      await openLive(page);
      const toggle = chipToggle(page);
      await toggle.click();
      const menu = account(page);
      await expect(menu).toBeVisible();
      expect(await noHorizontalScroll(page)).toBe(true);
      const popover = await boxOf(menu), chipBox = await boxOf(toggle);
      expect(popover.x).toBeGreaterThanOrEqual(0);
      expect(popover.x + popover.width, 'its right edge keeps the 12 px gutter').toBeLessThanOrEqual(348);
      expect(popover.y).toBeGreaterThanOrEqual(chipBox.y + chipBox.height);
      expect(popover.y + popover.height).toBeLessThanOrEqual(740);
      expect(intersects(popover, await boxOf(burger(page)))).toBe(false);
      // Nothing inside spills out of the popover sideways, and every control is a 44 px target.
      expect(await menu.evaluate(el => [...el.querySelectorAll('*')].filter(child => {
        const r = child.getBoundingClientRect(), box = el.getBoundingClientRect();
        return r.width > 0 && (r.left < box.left - 0.5 || r.right > box.right + 0.5);
      }).map(child => child.tagName))).toEqual([]);
      const small = await menu.locator('button').evaluateAll(buttons => buttons.map(b => ({ text: b.textContent, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height }))
        .filter(b => b.w < 44 || b.h < 44));
      expect(small).toEqual([]);
      await reviewShot(page, testInfo, 'phonebar-fits');
    });
  });

  test('the desktop menu gains only the clock', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'A phone is always in the touch layout.');
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLive(page);
    const toggle = chipToggle(page);
    // The bar is always visible on a PC, and it opens the same account menu.
    for (const id of ['chip-stamina', 'chip-money', 'chip-renown']) await expect(cornerChip(page).getByTestId(id), id).toBeVisible();
    const menu = await openChipMenu(page);
    await expect(menu.getByTestId('bar-stamina')).toBeHidden();
    await expect(menu.getByTestId('bar-money')).toBeHidden();
    await expect(menu.getByTestId('bar-renown')).toBeHidden();
    await expect(menu.getByTestId('bar-countdown')).toBeHidden();
    await expect(menu.getByText(STAMINA_LINE, { exact: true })).toBeHidden();
    await expect(menu.getByRole('progressbar')).toBeHidden();
    await expect(menu.getByRole('group', { name: 'Clock', exact: true })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    // The bar on the chip itself is unchanged.
    await expect(toggle.getByTestId('chip-stamina')).toHaveText(/74 \/ 104/);
    await reviewShot(page, testInfo, 'phonebar-desktop');
  });
});

test.describe('the fixture preview', () => {
  test.skip(production, 'The fixture preview is development-only.');

  test('shows the Clock switch in its account menu too', async ({ page }) => {
    await page.goto('/game/?mode=fixture');
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    await expectOwnerShown(page, 'Aster');
    const menu = await openChipMenu(page);
    await expect(menu.getByText('Local preview: no account is signed in.')).toBeVisible();
    const clock = menu.getByRole('group', { name: 'Clock', exact: true });
    await expect(clock).toBeVisible();
    await clock.getByRole('button', { name: '24-hour', exact: true }).click();
    await expect(clock.getByRole('button', { name: '24-hour', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(clock.getByRole('button', { name: '12-hour', exact: true })).toHaveAttribute('aria-pressed', 'false');
  });
});
