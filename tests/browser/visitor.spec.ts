import { expect, test, type Locator, type Page } from '@playwright/test';
import type { OwnerState, WorldSnapshot } from '../../supabase/functions/_shared/contracts/reads';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { createDemoWorld } from '../../src/game/demo-world';
import { emptyWorld, routeLiveReads, seedSession } from './live-routes';
import {
  cornerChip, creationDialog, expectOwnerShown, joinButton, menuDialog, openMenu, railMenus, revealRail, signOutFromChip, touchLayout,
} from './shell-helpers';

// Task 13.6: a visitor watches the live camp and opens every public menu without an account or a command, and joins by
// signing in with Google (the test-only consent page of live-routes.ts) and creating a gladiator in a dialog over the
// running camp. A cancelled sign-in comes back to the visitor view with a short message (plan Decision 6), and a
// session that ends closes any private menu and leaves no private value on screen (Review Focus 2).

const PUBLIC_MENUS = ['My gladiator', 'Arena', 'Tournaments', 'Results', 'Gladiators'];
const VISITOR_PROMPT = 'Sign in with Google to create your gladiator';

/** A live camp from fixture DTOs: the owner fixture's actor and a training and resting crowd (no Arena or tournament entrants). */
function liveWorld(): WorldSnapshot {
  const crowd = createDemoWorld(worldFixture.serverNowMs, 14, 2).actors.filter(a => a.location !== 'arena' && a.location !== 'tournament');
  return { ...worldFixture, revision: 'live-1', actors: [...worldFixture.actors, ...crowd] };
}
/** Waits for the scene to be ready with a world of `actors` actors. */
async function waitForCamp(page: Page, actors: number) {
  await page.waitForFunction(n => window.__cloudiatorCamp?.state()?.ready === true && window.__cloudiatorCamp.world()?.actors.length === n,
    actors, { timeout: 45_000 });
}
const camera = (page: Page) => page.evaluate(() => {
  const c = window.__cloudiatorCamp!.state()!.camera;
  return { zoom: c.zoom, x: c.centerX, y: c.centerY };
});
const nextFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
type Box = { x: number; y: number; width: number; height: number };
const boxOf = async (locator: Locator): Promise<Box> => (await locator.boundingBox())!;
const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** Every request the page sends to an Edge Function (the game's commands). */
function watchCommands(page: Page) {
  const sent: string[] = [];
  page.on('request', request => { if (request.url().includes('/functions/v1/')) sent.push(request.url()); });
  return sent;
}
const railLabels = (page: Page) => railMenus(page).getByRole('button').evaluateAll(buttons => buttons.map(b => b.getAttribute('aria-label')));

test.beforeEach(() => { test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Live mode uses development-only intercepted Supabase transport.'); });

test('lets a visitor watch the camp and open every public menu without sending a command', async ({ page, context }, testInfo) => {
  const world = liveWorld();
  const live = await routeLiveReads(context, { world });
  const commands = watchCommands(page);
  await page.goto('/game/');
  await waitForCamp(page, world.actors.length);
  // At rest: the living camp, with one sign-in chip and no menu open.
  await expect(joinButton(page)).toBeVisible();
  await expect(page.locator('[data-menu-surface]:visible')).toHaveCount(0);
  await nextFrames(page);
  await page.screenshot({ path: testInfo.outputPath('visitor-at-rest.png') });
  await revealRail(page);
  expect(await railLabels(page)).toEqual(PUBLIC_MENUS);
  for (const label of PUBLIC_MENUS) {
    const menu = await openMenu(page, label);
    if (label === 'My gladiator') {
      await expect(menu.getByRole('button', { name: VISITOR_PROMPT })).toBeEnabled();
      await expect(menu.getByRole('button', { name: 'Create gladiator' })).toHaveCount(0);
      await expect(menu.getByLabel('Gladiator name')).toHaveCount(0);
      await menu.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
      await page.screenshot({ path: testInfo.outputPath('visitor-my-gladiator.png') });
    }
    if (label === 'Tournaments') {
      // The Visitor column: countdown and brackets only, no Registration (13.4 review M5).
      await expect(menu.getByRole('heading', { name: 'Brackets', exact: true })).toBeVisible();
      await expect(menu.getByRole('region', { name: 'Registration' })).toHaveCount(0);
      await expect(menu.getByLabel('Automatically enter tournaments')).toHaveCount(0);
    }
    if (label === 'Gladiators') {
      await expect(menu.getByRole('button', { name: `Find ${world.actors[0].name}`, exact: true }).first()).toBeVisible();
      await expect(menu.getByRole('button', { name: 'Find my gladiator' })).toHaveCount(0);
    }
  }
  // Read-only: public reads as a visitor only, never the owner state, and no command.
  expect(commands).toEqual([]);
  expect(live.requests.length).toBeGreaterThan(0);
  expect(live.requests.every(r => r.reader === null)).toBe(true);
  expect(live.count('owner_state')).toBe(0);
});

test('starts Google sign-in from the corner chip', async ({ page, context }) => {
  const live = await routeLiveReads(context, { world: emptyWorld() });
  await page.goto('/game/');
  const join = joinButton(page);
  // The chip carries the Google "G" mark; on touch it shortens to "Sign in to join" (13.5 review, the mockup).
  await expect(join).toHaveAccessibleName((await touchLayout(page)) ? 'Sign in to join' : 'Sign in with Google to join');
  const mark = join.getByTestId('google-mark');
  await expect(mark).toBeVisible();
  await expect(mark).toHaveText('G');
  expect(await mark.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
  await join.click();
  await expect(page.getByRole('link', { name: 'Approve test Google' })).toBeVisible();
  const authorize = live.authRequests.filter(r => r.path === '/auth/v1/authorize');
  expect(authorize).toHaveLength(1);
  expect(authorize[0].query.get('provider')).toBe('google');
  expect(new URL(authorize[0].query.get('redirect_to')!).pathname).toBe('/auth/callback/');
  // Back from Google without signing in (a reload here: Playwright's Chrome has no back-forward cache), the chip offers
  // sign-in again.
  await page.goBack();
  await expect(page).toHaveURL(/\/game\/$/);
  await expect(joinButton(page)).toBeEnabled();
  await expect(joinButton(page)).toHaveAccessibleName((await touchLayout(page)) ? 'Sign in to join' : 'Sign in with Google to join');
});

test('opens the create dialog over the running camp after sign-in without a gladiator', async ({ page, context }, testInfo) => {
  const world = liveWorld();
  const live = await routeLiveReads(context, { world, owner: null });
  const commands = watchCommands(page);
  await page.goto('/game/');
  await waitForCamp(page, world.actors.length);
  await joinButton(page).click();
  await page.getByRole('link', { name: 'Approve test Google' }).click();
  await expect(page).toHaveURL(/\/game\/$/);
  const dialog = creationDialog(page);
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  // The camp is ready and running behind the dialog, read by the signed-in account.
  await waitForCamp(page, world.actors.length);
  await expect(page.getByRole('application')).toBeAttached();
  expect(live.requests.some(r => r.table === 'owner_state' && r.reader === live.googleUser.id)).toBe(true);
  await expect(dialog.getByRole('heading', { name: 'Create your gladiator', exact: true })).toBeVisible();
  // Typing the name never moves the camera behind the dialog (Review Focus 1).
  await nextFrames(page);
  const before = await camera(page);
  const name = dialog.getByLabel('Gladiator name');
  await name.click();
  await page.keyboard.type('+0-');
  await page.keyboard.press('ArrowLeft');
  await expect(name).toHaveValue('+0-');
  await nextFrames(page);
  expect(await camera(page)).toEqual(before);
  await name.fill('Marcus');
  await page.screenshot({ path: testInfo.outputPath('join-create-dialog.png') });
  // "Not now" closes it; the chip, then My gladiator, offer it again.
  await dialog.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(dialog).toBeHidden();
  const chipCreate = cornerChip(page).getByRole('button', { name: 'Create your gladiator', exact: true });
  await expect(chipCreate).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('join-not-now-chip.png') });
  await chipCreate.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Gladiator name')).toHaveValue('Marcus');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const mine = await openMenu(page, 'My gladiator');
  await expect(mine.getByRole('button', { name: VISITOR_PROMPT })).toHaveCount(0);
  await mine.getByRole('button', { name: 'Create your gladiator', exact: true }).click();
  await expect(dialog).toBeVisible();
  // Nothing is sent until the gladiator is confirmed.
  expect(commands).toEqual([]);
});

test('returns a cancelled sign-in to the visitor view with a short message', async ({ page, context }, testInfo) => {
  const world = liveWorld();
  await routeLiveReads(context, { world });
  await page.goto('/game/');
  await joinButton(page).click();
  await page.getByRole('link', { name: 'Cancel test Google' }).click();
  // Back on the camp, the parameter removed (plan Decision 6), with the visitor chip and the short message.
  await expect(page).toHaveURL(/\/game\/$/);
  const message = page.getByRole('status').filter({ hasText: 'Google sign-in was canceled.' });
  await expect(message).toBeVisible();
  await expect(page.getByText('Untrusted provider text')).toHaveCount(0);
  await expect(joinButton(page)).toBeVisible();
  await waitForCamp(page, world.actors.length);
  // Below the chip, never over it.
  expect(intersects(await boxOf(message), await boxOf(cornerChip(page)))).toBe(false);
  await nextFrames(page);
  await page.screenshot({ path: testInfo.outputPath('visitor-signin-cancelled.png') });
  await message.getByRole('button', { name: 'Dismiss' }).click();
  await expect(message).toHaveCount(0);
  // A sign-in that fails comes back the same way.
  await page.goto('/auth/callback/?code=unknown-code');
  await expect(page).toHaveURL(/\/game\/$/);
  await expect(page.getByRole('status').filter({ hasText: 'Google sign-in could not be completed.' })).toBeVisible();
  await expect(joinButton(page)).toBeVisible();
});

test('closes a private menu and shows no private value when the session ends', async ({ page, context }) => {
  await seedSession(context);
  const owner: OwnerState = { ...structuredClone(ownerFixture), name: 'Private Tester', wallets: { money: 4321, renown: 87 } };
  await routeLiveReads(context, { world: emptyWorld(), owner });
  await page.goto('/game/');
  await expectOwnerShown(page, owner.name);
  const inventory = await openMenu(page, 'Inventory and shops');
  await expect(inventory).toBeVisible();
  await signOutFromChip(page);
  // The chip flips to the visitor's, the private menu is gone, and no private value is left on screen.
  await expect(joinButton(page)).toBeVisible();
  await expect(menuDialog(page, 'Inventory and shops')).toHaveCount(0);
  await expect(page.locator('[data-menu-surface]:visible')).toHaveCount(0);
  for (const value of [owner.name, '4321']) await expect(page.locator('body')).not.toContainText(value);
  await expect(page.getByText('Connection lost — showing the last known camp')).toHaveCount(0);
  // The rail is not left on the lost menu (13.5 review): it hides again, with the visitor's icons.
  const rail = page.getByTestId('menu-rail');
  if (await touchLayout(page)) {
    const burger = page.getByRole('button', { name: 'Menus', exact: true });
    if ((await burger.getAttribute('aria-expanded')) === 'true') await burger.click();
    await expect(rail).toHaveAttribute('data-revealed', 'false');
    await expect(railMenus(page)).toBeHidden();
  } else {
    await page.mouse.move(2, 360);
    await expect(rail).toHaveAttribute('data-revealed', 'true');
    await page.mouse.move(640, 360);
    await expect(rail).toHaveAttribute('data-revealed', 'false');
    await expect(page.getByTestId('menu-grip')).toHaveCSS('opacity', '1');
  }
  await revealRail(page);
  expect(await railLabels(page)).toEqual(PUBLIC_MENUS);
  const mine = await openMenu(page, 'My gladiator');
  await expect(mine.getByRole('button', { name: VISITOR_PROMPT })).toBeVisible();
  for (const value of [owner.name, '4321']) await expect(page.locator('body')).not.toContainText(value);
});
