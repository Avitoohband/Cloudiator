// Patch 1.9 Task 33: My gladiator and Inventory and shops show one named section at a time (the approved paged-menus mockup). Specs reach
// a section the way a player does, with the strip's circles under the menu's title.
import { expect, type Locator, type Page } from '@playwright/test';
import { openMenu } from './shell-helpers';

/** The section navigation under a menu's title (`SectionStrip`, the `nav` "Sections"). */
export const sectionStrip = (menu: Locator) => menu.getByRole('navigation', { name: 'Sections', exact: true });
/** The bottom bar of a section with no paged list of its own (`SectionPager`, the `nav` "Section bar"). */
export const sectionBar = (menu: Locator) => menu.getByRole('navigation', { name: 'Section bar', exact: true });
/** The name of the section shown, as the strip says it. */
export const shownSection = (menu: Locator) => sectionStrip(menu).locator('b').first();

/** Shows `menu`'s section named `name` with its circle in the strip (nothing happens when it shows already), and returns the menu. */
export async function openSection(menu: Locator, name: string): Promise<Locator> {
  // The strip comes with the owner (My gladiator says "Loading your gladiator…" before). Every menu with sections has it, so a strip that does
  // not come fails here, never a silent pass on the section already shown (final review M8).
  await expect(sectionStrip(menu)).toBeVisible({ timeout: 45_000 });
  const circle = sectionStrip(menu).getByRole('button', { name: `Go to section: ${name}`, exact: true });
  if ((await circle.getAttribute('aria-current')) !== 'step') {
    await circle.click();
    // The circle's hint bubble (a tooltip, shown under the pointer and for 1.2 s after a tap) goes before the section is read.
    const page = menu.page(), size = page.viewportSize();
    if (size) await page.mouse.move(size.width - 4, size.height - 4);
    await expect(sectionStrip(menu).getByRole('tooltip')).toHaveCount(0);
  }
  await expect(shownSection(menu)).toHaveText(name);
  return menu;
}

/** Opens the menu named `label` (`openMenu`) on its section named `name`. */
export async function openMenuSection(page: Page, label: string, name: string): Promise<Locator> {
  return openSection(await openMenu(page, label), name);
}

/**
 * Task 33 fix round 1: on a phone the Inventory's and the Shops' card shows only once a tile is chosen, over the grid. Opens the chosen
 * tile's card (a tap on it) in the section shown when it is closed; nothing on a pointer layout, where the card is always beside the grid.
 */
export async function openItemCard(scope: Locator): Promise<void> {
  const closed = scope.locator('[data-card="closed"]:visible');
  if (!(await closed.count())) return;
  await closed.first().locator('[data-page-row][aria-pressed="true"]').first().click();
  await expect(scope.locator('[data-card="open"]:visible')).toHaveCount(1);
}

/** Opens Inventory and shops on its Shops section and returns the Shops region. */
export async function openShops(page: Page): Promise<Locator> {
  const menu = await openMenuSection(page, 'Inventory and shops', 'Shops');
  return menu.getByRole('region', { name: 'Shops', exact: true });
}
