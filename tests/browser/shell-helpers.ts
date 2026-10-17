// Drives the full-screen camp shell (Task 13.5) the way a player does: the hidden rail on desktop, the ☰ button and
// bottom sheets on touch. Specs open menus through these helpers instead of relying on any page layout.
import { expect, type Locator, type Page } from '@playwright/test';
import { COMPACT_QUERY } from '../../src/features/shell/rail-reveal';

/** The shell's touch layout: no hover (plan Decision 3, the Playwright mobile project) or a window under 481 px. */
export const touchLayout = (page: Page) => page.evaluate(query => matchMedia(query).matches, COMPACT_QUERY);

/** The menu panel (desktop) or sheet (touch) named `label`. */
export const menuDialog = (page: Page, label: string) => page.getByRole('dialog', { name: label, exact: true });
/** The rail's menu icons (the touch dock shows the same buttons). */
export const railMenus = (page: Page) => page.getByRole('navigation', { name: 'Game menus' });
/** The corner chip, top right. */
export const cornerChip = (page: Page) => page.getByTestId('corner-chip');

/** Shows the rail: the pointer at the left edge on desktop, the ☰ button on touch (an open sheet hides it, so it closes). */
export async function revealRail(page: Page) {
  if (await touchLayout(page)) {
    await closeMenu(page);
    const burger = page.getByRole('button', { name: 'Menus', exact: true });
    if ((await burger.getAttribute('aria-expanded')) !== 'true') await burger.click();
  } else {
    await page.mouse.move(2, page.viewportSize()!.height / 2);
  }
  await expect(railMenus(page)).toBeVisible();
}

/**
 * Opens the menu named `label` and returns its dialog. Desktop: the pointer to x = 2, then the rail icon. Touch: ☰,
 * then the icon in the row (an open sheet is closed first, as it hides the row). A menu already open is returned as is.
 */
export async function openMenu(page: Page, label: string): Promise<Locator> {
  const dialog = menuDialog(page, label);
  if (await dialog.isVisible()) return dialog;
  await revealRail(page);
  await railMenus(page).getByRole('button', { name: label, exact: true }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Closes the open menu panel or sheet, if any, with its × button. */
export async function closeMenu(page: Page) {
  const open = page.locator('[data-menu-surface]:visible');
  if (await open.count()) {
    await open.locator('[data-menu-close]').click();
    await expect(open).toHaveCount(0);
  }
}

/** Opens the corner chip's small menu (Sign out) and returns it. */
export async function openChipMenu(page: Page): Promise<Locator> {
  const chip = cornerChip(page);
  const toggle = chip.getByRole('button').first();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const menu = chip.getByRole('group', { name: 'Account' });
  await expect(menu).toBeVisible();
  return menu;
}

/** Signs out from the corner chip's menu. */
export async function signOutFromChip(page: Page) {
  await (await openChipMenu(page)).getByRole('button', { name: 'Sign out', exact: true }).click();
}

/** Waits until the corner chip shows the signed-in owner `name` (the shell's sign that the owner has loaded). */
export async function expectOwnerShown(page: Page, name: string, timeout = 45_000) {
  await expect(cornerChip(page).getByTestId('chip-name')).toHaveText(name, { timeout });
}
