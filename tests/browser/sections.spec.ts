import { expect, test, type Locator, type Page } from './fixtures';
import { noHorizontalScroll } from './a11y-helpers';
import { closeMenu, openMenu, quietArrivals } from './shell-helpers';
import { openSection, sectionBar, sectionStrip, shownSection } from './section-helpers';

// Patch 1.9 Task 33 (menus with Back and Next, the approved paged-menus mockup): My gladiator opens as five named sections and Inventory and
// shops as two; the strip under the title is the section navigation (its name, the circles, previous and next, ← and →), and a section with
// no paged list of its own also has the bottom bar "‹ Level and stamina · 3 of 5 · Worn equipment ›". The inventory grid and the shop grid
// page whole rows: 24 tiles on a desktop panel (six columns), 15 on a phone (five). The fixture preview's demo bag holds 14 tiles.
const production = process.env.PLAYWRIGHT_STATIC === 'true';
const SECTIONS = ['Overview', 'Level and stamina', 'Attributes and stats', 'Worn equipment', 'History'];

async function openCamp(page: Page) {
  await quietArrivals(page.context());
  await page.goto('/game/?mode=fixture&bag=demo');
}
const circles = (menu: Locator) => sectionStrip(menu).getByRole('button', { name: /^Go to section: / });
const pages = (menu: Locator) => menu.getByRole('navigation', { name: 'Pages', exact: true });
/** The page label ("Page 2 of 3"). */
const pageLabel = (menu: Locator) => pages(menu).locator('b').first();
/** The cells of the page shown in a grid: its tiles and its free (empty) cells. */
const gridCells = (grid: Locator) => grid.locator(':scope > *');
/** Tiles a page holds on this layout: 24 in six columns (desktop), 15 in five (the phone's sheet). */
const pageSize = (page: Page) => page.evaluate(() => (matchMedia('(hover: none), (max-width: 480px)').matches ? 15 : 24));

test.describe('named sections and paged grids (fixture preview)', () => {
  test.skip(production, 'The camp harness runs on the fixture preview only.');

  test('My gladiator opens as five sections; the strip, its circles, the bottom bar and ← → move between them, each control in its section', async ({ page }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 780 });
    await openCamp(page);
    const menu = await openMenu(page, 'My gladiator');
    const strip = sectionStrip(menu), bar = sectionBar(menu);
    await expect(shownSection(menu)).toHaveText('Overview');
    await expect(circles(menu)).toHaveCount(5);
    for (const [n, name] of SECTIONS.entries()) await expect(circles(menu).nth(n)).toHaveAccessibleName(`Go to section: ${name}`);
    await expect(circles(menu).first()).toHaveAttribute('aria-current', 'step');
    // The Overview: the name, the Title button, the class, the activity, gold and renown with the gold laurel (fix 3).
    await expect(menu.getByRole('heading', { name: 'Aster', exact: true })).toBeVisible();
    await expect(menu.getByRole('button', { name: /^Title/ })).toBeVisible();
    const renown = menu.locator('dt').filter({ hasText: 'Renown' });
    await expect(renown.locator('[data-currency-icon="renown"]')).toBeVisible();
    await expect(bar).toContainText('1 of 5');
    await expect(bar.getByRole('button', { name: 'Previous section', exact: true })).toHaveAttribute('aria-disabled', 'true');
    // The bottom bar's Next: Level and stamina (the stamina and the XP bar); the strip's status says the section.
    await bar.getByRole('button', { name: 'Next section: Level and stamina', exact: true }).click();
    await expect(shownSection(menu)).toHaveText('Level and stamina');
    await expect(strip.getByRole('status')).toHaveText('Level and stamina, section 2 of 5');
    await expect(menu.getByRole('heading', { name: 'Aster', exact: true })).toBeHidden();
    await expect(menu.getByRole('progressbar', { name: 'Stamina', exact: true })).toBeVisible();
    await expect(menu.getByRole('progressbar', { name: 'Experience', exact: true })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Stamina', exact: true })).toBeVisible();
    // The strip's next: Attributes and stats, with the attribute and stat help and ⚔ Practice fight.
    await strip.getByRole('button', { name: 'Next section: Attributes and stats', exact: true }).click();
    await expect(shownSection(menu)).toHaveText('Attributes and stats');
    await expect(bar).toContainText('3 of 5');
    await expect(menu.getByRole('region', { name: 'Attributes', exact: true })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Strength', exact: true })).toBeVisible();
    const practice = menu.getByRole('button', { name: /Practice fight/ });
    await expect(practice).toBeVisible();
    // → with the focus in the panel (not in a control that keeps the arrows) moves a section; the focus left in the hidden section goes to
    // the panel (as the shell's focus rescue does), and the strip says the section.
    await practice.focus();
    await page.keyboard.press('ArrowRight');
    await expect(shownSection(menu)).toHaveText('Worn equipment');
    await expect(menu).toBeFocused();
    await expect(strip.getByRole('status')).toHaveText('Worn equipment, section 4 of 5');
    await expect(menu.getByRole('region', { name: 'Worn equipment', exact: true })).toBeVisible();
    await expect(menu.getByRole('button', { name: /^Feet:/ })).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(shownSection(menu)).toHaveText('Attributes and stats');
    await page.keyboard.press('ArrowRight');
    await expect(shownSection(menu)).toHaveText('Worn equipment');
    // A circle: History, with the gladiator's own history and no section bar (its list pages with its own bar).
    await circles(menu).nth(4).click();
    await expect(shownSection(menu)).toHaveText('History');
    await expect(circles(menu).nth(4)).toHaveAttribute('aria-current', 'step');
    await expect(menu.getByRole('heading', { name: 'My history', exact: true })).toBeVisible();
    await expect(menu.getByRole('group', { name: 'Show history', exact: true })).toBeVisible();
    await expect(bar).toHaveCount(0);
    await expect(strip.getByRole('button', { name: 'Next section', exact: true })).toHaveAttribute('aria-disabled', 'true');
    expect(await noHorizontalScroll(page)).toBe(true);
    // The menu reopens on the last section seen in this visit; a reload starts at the Overview.
    await closeMenu(page);
    const again = await openMenu(page, 'My gladiator');
    await expect(shownSection(again)).toHaveText('History');
    await page.reload();
    const reloaded = await openMenu(page, 'My gladiator');
    await expect(shownSection(reloaded)).toHaveText('Overview');
  });

  test('My gladiator’s Renown wears the gold laurel of the shops, the cards and the corner chip (fix 3)', async ({ page }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 780 });
    await openCamp(page);
    const menu = await openMenu(page, 'My gladiator');
    const renown = menu.locator('dt').filter({ hasText: 'Renown' });
    await expect(renown).toBeVisible();
    // The same atlas frame as the corner chip's laurel, decorative: the term still reads "Renown".
    const laurel = renown.locator('[data-currency-icon="renown"]');
    await expect(laurel).toBeVisible();
    await expect(laurel).toHaveAttribute('aria-hidden', 'true');
    await expect(renown).toHaveText('Renown');
    const chipLaurel = page.getByTestId('corner-chip').locator('[data-currency-icon="renown"]').first();
    expect(await laurel.evaluate(element => getComputedStyle(element).backgroundImage)).toBe(await chipLaurel.evaluate(element => getComputedStyle(element).backgroundImage));
    // Gold keeps its word only, as before.
    await expect(menu.locator('dt').filter({ hasText: 'Gold' }).locator('[data-currency-icon]')).toHaveCount(0);
  });

  test('the arrow keys in the Worn equipment picker stay in its grid and never move the section', async ({ page }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 780 });
    await openCamp(page);
    const menu = await openSection(await openMenu(page, 'My gladiator'), 'Worn equipment');
    await menu.getByRole('button', { name: /^Feet:/ }).click();
    const dialog = menu.getByRole('dialog', { name: 'Change Feet', exact: true });
    const tiles = dialog.locator('[data-tile]');
    await expect(tiles.first()).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(tiles.first()).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(tiles.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowRight');
    await expect(tiles.last()).toBeFocused();
    await expect(shownSection(menu)).toHaveText('Worn equipment');
  });

  test('Inventory and shops opens on Inventory; the grid pages whole rows, keeps the chosen piece and goes back to page 1 on a sort', async ({ page }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 780 });
    await openCamp(page);
    const menu = await openMenu(page, 'Inventory and shops');
    await expect(shownSection(menu)).toHaveText('Inventory');
    await expect(circles(menu)).toHaveCount(2);
    await expect(sectionStrip(menu).getByRole('button', { name: 'Next section: Shops', exact: true })).toBeVisible();
    // A section with a paged grid: its bottom bar is the grid's, never the section bar.
    await expect(sectionBar(menu)).toHaveCount(0);
    const size = await pageSize(page);
    const grid = menu.getByTestId('inventory-grid');
    // 14 tiles and 41 free slots of the 60: 24 a page in six columns (3 pages), 15 in five (4 pages).
    await expect(gridCells(grid)).toHaveCount(size);
    await expect(grid.getByRole('button')).toHaveCount(14);
    const total = size === 24 ? 3 : 4;
    await expect(pageLabel(menu)).toHaveText(`Page 1 of ${total}`);
    const columns = await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(size === 24 ? 6 : 5);
    // The chosen piece stays chosen while the pages turn; its card stays.
    const second = grid.getByRole('button').nth(1);
    const name = await second.getAttribute('aria-label');
    await second.click();
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    const heading = await menu.getByRole('region', { name: 'Item details' }).getByRole('heading').first().textContent();
    await pages(menu).getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(pageLabel(menu)).toHaveText(`Page 2 of ${total}`);
    await expect(grid.getByRole('button')).toHaveCount(0);
    // A page of free slots only: the turn gives the focus to the grid itself.
    await expect(menu.getByRole('group', { name: 'Your items', exact: true })).toBeFocused();
    await expect(menu.getByRole('region', { name: 'Item details' }).getByRole('heading').first()).toHaveText(heading!);
    await pages(menu).getByRole('button', { name: `Go to page ${total}`, exact: true }).click();
    await expect(pageLabel(menu)).toHaveText(`Page ${total} of ${total}`);
    await pages(menu).getByRole('button', { name: 'Previous page', exact: true }).click();
    await expect(pageLabel(menu)).toHaveText(`Page ${total - 1} of ${total}`);
    // A sort goes back to page 1, where the chosen piece is.
    await menu.getByRole('combobox', { name: 'Sort your items' }).selectOption('level');
    await expect(pageLabel(menu)).toHaveText(`Page 1 of ${total}`);
    await expect(grid.getByRole('button', { name: name!, exact: true })).toHaveAttribute('aria-pressed', 'true');
    // A search that leaves one page has no bar; clearing it shows page 1.
    await menu.getByRole('searchbox', { name: 'Search your items' }).fill('sword');
    await expect(pages(menu)).toHaveCount(0);
    await menu.getByRole('searchbox', { name: 'Search your items' }).fill('');
    await expect(pageLabel(menu)).toHaveText(`Page 1 of ${total}`);
    // ← and → on a tile stay with the grid; on a filter chip they move the section.
    await grid.getByRole('button').first().focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await expect(shownSection(menu)).toHaveText('Inventory');
    await menu.getByRole('group', { name: 'Inventory filters', exact: true }).getByRole('button', { name: 'All', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(shownSection(menu)).toHaveText('Shops');
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test('the Shops section: the shop grid pages whole rows, a currency goes back to page 1, and the arrow keys stay in the grid', async ({ page }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 780 });
    await openCamp(page);
    const menu = await openSection(await openMenu(page, 'Inventory and shops'), 'Shops');
    const shops = menu.getByRole('region', { name: 'Shops', exact: true });
    await expect(shops).toBeVisible();
    await expect(menu.getByTestId('inventory-grid')).toBeHidden();
    const size = await pageSize(page);
    const grid = shops.getByRole('group', { name: 'Shop items', exact: true }).locator('[data-page-list] > div');
    await expect(gridCells(grid)).toHaveCount(size);
    await expect(pageLabel(menu)).toHaveText(/^Page 1 of \d+$/);
    const chosen = grid.locator('[aria-pressed="true"]');
    const chosenId = await chosen.getAttribute('data-cell-id');
    await pages(menu).getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(pageLabel(menu)).toHaveText(/^Page 2 of \d+$/);
    // The chosen offer stays chosen (its card stays) on another page; the grid's one Tab stop is on the page shown.
    await expect(shops.getByRole('region', { name: 'Offer details' })).toBeVisible();
    await expect(grid.locator(`[data-cell-id="${chosenId}"]`)).toHaveCount(0);
    const stops = grid.locator('[data-shop-cell][tabindex="0"]');
    if (await grid.locator('[data-shop-cell]').count()) {
      await expect(stops).toHaveCount(1);
      await expect(grid.locator('[data-page-row]').first()).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await expect(shownSection(menu)).toHaveText('Shops');
    }
    // A currency goes back to page 1.
    await shops.getByRole('group', { name: 'Shop currency', exact: true }).getByRole('button', { name: 'Renown', exact: true }).click();
    await expect(pages(menu).locator('b').first()).toHaveText(/^Page 1 of \d+$/);
    // The strip's previous section: the inventory, as it was left.
    await sectionStrip(menu).getByRole('button', { name: 'Previous section: Inventory', exact: true }).click();
    await expect(menu.getByTestId('inventory-grid')).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
  });
});
