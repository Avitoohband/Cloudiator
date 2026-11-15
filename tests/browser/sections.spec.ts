import { expect, test, type Locator, type Page } from './fixtures';
import { noHorizontalScroll } from './a11y-helpers';
import { closeMenu, cornerChip, openMenu, quietArrivals } from './shell-helpers';
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
    const phone = info.project.name === 'mobile';
    if (phone) await page.setViewportSize({ width: 360, height: 780 });
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
    // The strip's next: Attributes and stats, with the attribute and stat help and ⚔ Practice fight. (A phone's strip has no ‹ ›, fix round 2
    // ruling: its circle goes there.)
    if (phone) await strip.getByRole('button', { name: 'Go to section: Attributes and stats', exact: true }).click();
    else await strip.getByRole('button', { name: 'Next section: Attributes and stats', exact: true }).click();
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
    if (phone) await expect(strip.getByRole('button', { name: /^(Previous|Next) section/ })).toHaveCount(0);
    else await expect(strip.getByRole('button', { name: 'Next section', exact: true })).toHaveAttribute('aria-disabled', 'true');
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

  test('Inventory and shops opens on Inventory; one page of tiles pads its last row with free slots and has no bar; the arrow keys stay in the grid', async ({ page }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 780 });
    await openCamp(page);
    const menu = await openMenu(page, 'Inventory and shops');
    await expect(shownSection(menu)).toHaveText('Inventory');
    await expect(circles(menu)).toHaveCount(2);
    // ‹ › are the pointer layout's; a phone's strip has its circles only (fix round 2 ruling).
    if (info.project.name === 'mobile') await expect(sectionStrip(menu).getByRole('button', { name: 'Next section: Shops', exact: true })).toHaveCount(0);
    else await expect(sectionStrip(menu).getByRole('button', { name: 'Next section: Shops', exact: true })).toBeVisible();
    // A section with a paged grid: its bottom bar is the grid's, never the section bar.
    await expect(sectionBar(menu)).toHaveCount(0);
    const size = await pageSize(page);
    const grid = menu.getByTestId('inventory-grid');
    // Fix round 1: the tiles page, and only the last page is padded with free slots to whole rows. 14 tiles fit one page (24 in six columns,
    // 15 in five): no bar, and the row is filled: 14 + 4 = 18 cells in six columns, 14 + 1 = 15 in five. The slot count still says the bag.
    await expect(grid.getByRole('button')).toHaveCount(14);
    await expect(gridCells(grid)).toHaveCount(size === 24 ? 18 : 15);
    await expect(pages(menu)).toHaveCount(0);
    await expect(menu.getByText('19 / 60 slots', { exact: true })).toBeVisible();
    const columns = await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(size === 24 ? 6 : 5);
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

  test('a phone’s section strip is one line, and Attributes and stats fits above the bar on the 360 × 780 sheet', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await openCamp(page);
    const menu = await openSection(await openMenu(page, 'My gladiator'), 'Attributes and stats');
    const strip = sectionStrip(menu);
    // One row: the name and the circles; no ‹ › on a phone (fix round 2 ruling: the bottom bar has Back and Next with the neighbours' names).
    await expect(strip.getByRole('button', { name: /^(Previous|Next) section/ })).toHaveCount(0);
    await expect(sectionBar(menu).getByRole('button', { name: 'Previous section: Level and stamina', exact: true })).toBeVisible();
    await expect(sectionBar(menu).getByRole('button', { name: 'Next section: Worn equipment', exact: true })).toBeVisible();
    const middle = async (locator: Locator) => { const box = (await locator.boundingBox())!; return box.y + box.height / 2; };
    const line = await middle(shownSection(menu));
    for (const n of [0, 2, 4]) expect(Math.abs((await middle(circles(menu).nth(n))) - line)).toBeLessThan(6);
    expect((await strip.boundingBox())!.height).toBeLessThanOrEqual(52);
    // The whole section (Attributes, Stats and Practice fight) above the bottom bar, with no scroll.
    const practice = menu.getByRole('button', { name: /Practice fight/ });
    expect((await practice.boundingBox())!.y + (await practice.boundingBox())!.height).toBeLessThanOrEqual((await sectionBar(menu).boundingBox())!.y);
    expect(await menu.getByTestId('menu-body').evaluate(body => body.scrollHeight <= body.clientHeight + 1)).toBe(true);
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  // Task 33 fix round 2 (re-review I-1, the coordinator's rulings): on a phone the one-line strip is the section's name and its circles, each
  // circle a 44 px target (its dot may stay small) with its accessible name unchanged, and no ‹ ›. The name ellipsizes only when it does not
  // fit: at 360 px "Worn equipment" and "Level and stamina" show at least eight characters.
  test('on a phone the strip’s five circles are 44 px targets beside the section’s name, on one line, and the name is not cut short (360 × 780)', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await openCamp(page);
    const menu = await openSection(await openMenu(page, 'My gladiator'), 'Attributes and stats');
    const strip = sectionStrip(menu);
    await expect(circles(menu)).toHaveCount(5);
    await expect(strip.getByRole('button', { name: /^(Previous|Next) section/ })).toHaveCount(0);
    const controls = SECTIONS.map(name => strip.getByRole('button', { name: `Go to section: ${name}`, exact: true }));
    const boxes: { x: number; y: number; width: number; height: number }[] = [];
    for (const control of controls) {
      const box = (await control.boundingBox())!;
      expect(box.width, await control.getAttribute('aria-label') ?? '').toBeGreaterThanOrEqual(44);
      expect(box.height, await control.getAttribute('aria-label') ?? '').toBeGreaterThanOrEqual(44);
      boxes.push(box);
    }
    // The circles, left to right, none over another, on one line with the name before them.
    for (let n = 1; n < boxes.length; n++) expect(boxes[n].x).toBeGreaterThanOrEqual(boxes[n - 1].x + boxes[n - 1].width - 0.5);
    const middles = boxes.map(box => box.y + box.height / 2);
    expect(Math.max(...middles) - Math.min(...middles)).toBeLessThan(2);
    const name = (await shownSection(menu).boundingBox())!;
    expect(name.x + name.width).toBeLessThanOrEqual(boxes[0].x + 0.5);
    expect(Math.abs(name.y + name.height / 2 - middles[0])).toBeLessThan(6);
    expect(await shownSection(menu).evaluate(element => getComputedStyle(element).textOverflow)).toBe('ellipsis');
    expect((await strip.boundingBox())!.height).toBeLessThanOrEqual(52);
    expect(await noHorizontalScroll(page)).toBe(true);
    // The name is not cut to a letter: the box it shows the text in holds at least its first eight characters and the ellipsis, and its full
    // text stays for assistive technology.
    for (const section of ['Worn equipment', 'Level and stamina']) {
      await strip.getByRole('button', { name: `Go to section: ${section}`, exact: true }).click();
      await expect(shownSection(menu)).toHaveText(section);
      const room = await shownSection(menu).evaluate(element => {
        const style = getComputedStyle(element), context = document.createElement('canvas').getContext('2d')!;
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const text = element.textContent ?? '';
        return { shown: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), eight: context.measureText(`${text.slice(0, 8)}…`).width };
      });
      expect(room.shown, `${section}: ${JSON.stringify(room)}`).toBeGreaterThanOrEqual(room.eight);
    }
  });

  test('while a Worn equipment picker is open, ← and → leave the section alone (desktop)', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'A phone’s picker sheet hides the slots, so nothing outside the picker takes the focus.');
    await openCamp(page);
    const menu = await openSection(await openMenu(page, 'My gladiator'), 'Worn equipment');
    const feet = menu.getByRole('button', { name: /^Feet:/ });
    await feet.focus();
    await page.keyboard.press('Enter');
    const dialog = menu.getByRole('dialog', { name: 'Change Feet', exact: true });
    await expect(dialog.locator('[data-tile]').first()).toBeFocused();
    // Back to the slot behind the picker (the picker's ✕ comes first, then the slot), then the arrows: the section stays, the picker stays open.
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(feet).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await expect(shownSection(menu)).toHaveText('Worn equipment');
    await expect(dialog).toBeVisible();
  });

  // Final review I1: Notifications' "Choose a title" moves My gladiator to the Overview while a Worn equipment picker is still open in the hidden
  // Worn section. Only the Worn section's own picker locks the section navigation, so the strip, ← → and the bottom bar move the section again,
  // and the picker is still open when the player comes back to Worn equipment.
  test('a Worn equipment picker left open under "Choose a title" from Notifications does not lock the sections elsewhere', async ({ page }, info) => {
    const phone = info.project.name === 'mobile';
    if (phone) await page.setViewportSize({ width: 360, height: 780 });
    await openCamp(page);
    const menu = await openSection(await openMenu(page, 'My gladiator'), 'Worn equipment');
    await menu.getByRole('button', { name: /^Feet:/ }).click();
    const feet = menu.getByRole('dialog', { name: 'Change Feet', exact: true });
    await expect(feet).toBeVisible();
    // Notifications → "Choose a title": the shell shows the Overview and opens the title picker over it.
    await cornerChip(page).getByRole('button', { name: /^Messages(, \d+ new)?$/ }).click();
    const messages = page.getByRole('region', { name: 'Messages', exact: true });
    await messages.getByRole('tab', { name: /^Notifications/ }).click();
    await messages.getByRole('button', { name: 'Choose a title', exact: true }).click();
    const titles = page.getByRole('dialog', { name: 'Choose your title', exact: true });
    await expect(titles).toBeVisible();
    await expect(shownSection(menu)).toHaveText('Overview');
    await titles.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(titles).toBeHidden();
    // ← and → move the section from the Title button, the strip's circles move it, and so does the bottom bar.
    await expect(menu.locator('[data-title-button]')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(shownSection(menu)).toHaveText('Level and stamina');
    await circles(menu).nth(2).click();
    await expect(shownSection(menu)).toHaveText('Attributes and stats');
    await sectionBar(menu).getByRole('button', { name: 'Previous section: Level and stamina', exact: true }).click();
    await expect(shownSection(menu)).toHaveText('Level and stamina');
    // Back on Worn equipment the picker is still open, and the section navigation waits for it again.
    await circles(menu).nth(3).click();
    await expect(shownSection(menu)).toHaveText('Worn equipment');
    await expect(feet).toBeVisible();
    await expect(sectionStrip(menu).locator('xpath=..')).toHaveAttribute('inert', '');
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
    // The chosen offer stays chosen (its card stays) on another page; the grid's one Tab stop is on the page shown. (On a phone the card
    // shows only once a cell is tapped, over the grid: Task 33 fix round 1.)
    if (info.project.name === 'mobile') await expect(shops.locator('[data-card="closed"]')).toHaveCount(1);
    else await expect(shops.getByRole('region', { name: 'Offer details' })).toBeVisible();
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
    // The strip's previous section (its circle on a phone, which has no ‹ ›): the inventory, as it was left.
    if (info.project.name === 'mobile') await sectionStrip(menu).getByRole('button', { name: 'Go to section: Inventory', exact: true }).click();
    else await sectionStrip(menu).getByRole('button', { name: 'Previous section: Inventory', exact: true }).click();
    await expect(menu.getByTestId('inventory-grid')).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  // 1.9.1 (Avi's phone, 2026-11-15): the strip is the first thing in the part of the menu that scrolls, right under the title, so the hint
  // bubble of its circles shows below them. Above them the menu's top cut it off: only its lower half showed, under "My gladiator". Every
  // circle's bubble is wholly inside the visible box of the menu's body, below the title and below the circles; a tap's bubble is gone after
  // its 1.2 s flash, and a hover's when the pointer leaves.
  for (const [label, first] of [['My gladiator', 'Attributes and stats'], ['Inventory and shops', 'Inventory']] as const) {
    test(`${label}: the strip circles' hint bubble shows below them, inside the menu (360 × 780 phone, desktop panel)`, async ({ page }, info) => {
      const phone = info.project.name === 'mobile';
      if (phone) await page.setViewportSize({ width: 360, height: 780 });
      await openCamp(page);
      const menu = await openSection(await openMenu(page, label), first);
      await menu.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished)));
      const tip = sectionStrip(menu).getByRole('tooltip');
      const names = await circles(menu).evaluateAll(list => list.map(circle => circle.getAttribute('aria-label')!.replace('Go to section: ', '')));
      // The section shown first: its own circle, as Avi tapped it (the review shot), then every other circle.
      for (const name of [first, ...names.filter(other => other !== first)]) {
        const circle = sectionStrip(menu).getByRole('button', { name: `Go to section: ${name}`, exact: true });
        if (phone) await circle.tap();
        else await circle.hover();
        await expect(tip).toHaveText(name);
        if (name === first && label === 'My gladiator' && phone && process.env.TASK_SHOTS) await page.screenshot({ path: `${process.env.TASK_SHOTS}/hotfix-1.9.1-phone.png` });
        const where = await stripBubble(menu);
        const why = `${label} → ${name}: ${JSON.stringify(where)}`;
        expect(where.tip.left, why).toBeGreaterThanOrEqual(where.body.left);
        expect(where.tip.right, why).toBeLessThanOrEqual(where.body.right);
        expect(where.tip.top, why).toBeGreaterThanOrEqual(where.body.top);
        expect(where.tip.bottom, why).toBeLessThanOrEqual(where.body.bottom);
        expect(where.tip.top, why).toBeGreaterThanOrEqual(where.title);
        expect(where.tip.top, why).toBeGreaterThanOrEqual(where.row.bottom);
        if (phone) {
          await page.waitForTimeout(1_600);
          expect(await tip.count(), `${name}: a tap's bubble is gone after 1.6 s`).toBe(0);
          await expect(shownSection(menu)).toHaveText(name);
        } else {
          const size = page.viewportSize()!;
          await page.mouse.move(size.width - 4, size.height - 4);
          await expect(tip).toHaveCount(0);
        }
      }
    });
  }
});

/** A box in page pixels. */
type Box = { left: number; top: number; right: number; bottom: number };
/**
 * The strip's shown hint bubble, the visible box of the menu's body (its client box: under the title, not scrolled out of sight), the bottom
 * of the menu's title and the circles' row.
 */
const stripBubble = (menu: Locator) => sectionStrip(menu).getByRole('tooltip').evaluate(tip => {
  const box = (rect: DOMRect): Box => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  const body = tip.closest<HTMLElement>('[data-testid="menu-body"]')!, outer = body.getBoundingClientRect();
  const left = outer.left + body.clientLeft, top = outer.top + body.clientTop;
  const title = tip.closest('[data-menu-surface]')!.querySelector('[data-testid="menu-title"]')!.getBoundingClientRect().bottom;
  return { tip: box(tip.getBoundingClientRect()), body: { left, top, right: left + body.clientWidth, bottom: top + body.clientHeight }, title,
    row: box(tip.closest('[data-page-dots]')!.getBoundingClientRect()) };
});
