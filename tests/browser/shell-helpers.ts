// Drives the full-screen camp shell (Task 13.5) the way a player does: the hidden rail on desktop, the ☰ button and
// bottom sheets on touch. Specs open menus through these helpers instead of relying on any page layout.
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { ARRIVALS_KEY } from '../../src/features/arrivals/arrivals';
import { COMPACT_QUERY } from '../../src/features/shell/rail-reveal';
import { isNewcomer } from '../../src/game/actors';
import { createDemoWorld } from '../../src/game/demo-world';
import { worldFixture } from '../fixtures/domain';

/** The shell's touch layout: no hover (plan Decision 3, the Playwright mobile project) or a window under 481 px. */
export const touchLayout = (page: Page) => page.evaluate(query => matchMedia(query).matches, COMPACT_QUERY);

/** The menu panel (desktop) or sheet (touch) named `label`. */
export const menuDialog = (page: Page, label: string) => page.getByRole('dialog', { name: label, exact: true });
/** The rail's menu icons (the touch dock shows the same buttons). */
export const railMenus = (page: Page) => page.getByRole('navigation', { name: 'Game menus' });
/** The corner chip, top right. */
export const cornerChip = (page: Page) => page.getByTestId('corner-chip');
/** A visitor's corner chip button: "Sign in with Google to join", or "Sign in to join" in the touch layout (Task 13.6). */
export const joinButton = (page: Page) => cornerChip(page).getByRole('button', { name: /^Sign in (with Google )?to join$/ });
/** The "Create your gladiator" dialog over the camp (signed in without a gladiator, Task 13.6). */
export const creationDialog = (page: Page) => page.getByRole('dialog', { name: 'Create your gladiator', exact: true });
/**
 * Spends all ten points in the creation dialog with "Suggested for {class}" (the points start at 0, launch feedback), so
 * Create is enabled. The suggestion follows the class picked now.
 */
export const spendSuggestedPoints = (page: Page) => creationDialog(page).getByRole('button', { name: /^Suggested for / }).click();

/** Shows the rail: the pointer at the left edge on desktop, the ☰ button on touch (an open sheet hides it, so it closes). */
export async function revealRail(page: Page) {
  if (await touchLayout(page)) {
    await closeMenu(page);
    const burger = page.getByRole('button', { name: 'Menus', exact: true });
    if ((await burger.getAttribute('aria-expanded')) !== 'true') await burger.click();
  } else {
    await page.mouse.move(2, page.viewportSize()!.height / 2);
  }
  // A translated-offscreen rail still satisfies toBeVisible. Wait for the shell's actual reveal state before clicking an icon.
  await expect(page.getByTestId('menu-rail')).toHaveAttribute('data-revealed', 'true');
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

/**
 * Opens Results on Everyone (today's list of everyone's results) for a player, whose Results opens on My bouts (Arena replays Task 4),
 * and returns the menu. It waits for the player's tabs, so it is for a signed-in player's (or the fixture owner's) camp; a visitor's
 * Results has no tabs and shows Everyone as it opens.
 */
export async function everyoneResults(page: Page): Promise<Locator> {
  const results = await openMenu(page, 'Results');
  const everyone = results.getByRole('tab', { name: 'Everyone', exact: true });
  await expect(everyone).toBeVisible({ timeout: 45_000 });
  if ((await everyone.getAttribute('aria-selected')) !== 'true') await everyone.click();
  await expect(everyone).toHaveAttribute('aria-selected', 'true');
  await expect(results.getByText('RECENT RESULTS', { exact: true })).toBeVisible();
  return results;
}

/** Closes the open menu panel or sheet, if any, with its × button. */
export async function closeMenu(page: Page) {
  const open = page.locator('[data-menu-surface]:visible');
  if (await open.count()) {
    await open.locator('[data-menu-close]').click();
    await expect(open).toHaveCount(0);
  }
}

/** The signed-in corner chip's account button, which opens its small menu (a viewer without a gladiator also has "Create your gladiator"). */
export const chipToggle = (page: Page) => cornerChip(page).locator('button[aria-expanded]:not([data-messages-button])');

/** Opens the corner chip's small menu (Sign out) and returns it. */
export async function openChipMenu(page: Page): Promise<Locator> {
  const chip = cornerChip(page);
  const toggle = chipToggle(page);
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

/**
 * Marks the fixture preview's newcomers (the demo crowd's gladiators in orientation) as already announced on this device, before
 * every page load of `context`, so the arrival banner (Patch A item 2) does not cover what a fixture-mode test clicks, types into or
 * screenshots. A test about the banner itself does not call it. The crowd's ids come from its first hundred gladiators (the preview
 * uses the first forty or so), a superset that costs nothing: the fixture gateway itself cannot be loaded by the runner, which cannot
 * import the JSON the fixtures hold.
 */
export async function quietArrivals(context: BrowserContext): Promise<void> {
  const crowd = createDemoWorld(worldFixture.serverNowMs, 100, 0).actors;
  const ids = [...worldFixture.actors, ...crowd].filter(isNewcomer).map(actor => actor.gladiatorId);
  await context.addInitScript(({ key, ids }) => {
    try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* No storage: nothing is remembered, and nothing to quiet. */ }
  }, { key: ARRIVALS_KEY, ids });
}
