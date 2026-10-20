import { expect, test } from './fixtures';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { emptyWorld, routeLiveReads } from './live-routes';
import { reviewShot360 } from './review-shots';
import { expectOwnerShown, joinButton, openMenu, railMenus, revealRail } from './shell-helpers';
import { expectTimeOnOneLine, slotTime } from './slot-time';

const production = process.env.PLAYWRIGHT_STATIC === 'true';
/** A visitor's My gladiator panel and its sign-in button (Task 13.6). */
const VISITOR_PROMPT = 'Sign in with Google to create your gladiator';

test('management shell labels local fixture data and exposes an accessible schedule', async ({ page }, testInfo) => {
  test.skip(production, 'Fixture data is deliberately unavailable in production.');
  await page.goto('/game/?mode=fixture');
  await expect(page.getByText('Fixture mode — progress is not saved online')).toBeVisible();
  // The Schedule rail icon (Task 13.5); opening it shows the sample plan.
  await revealRail(page);
  await expect(railMenus(page).getByRole('button', { name: 'Schedule', exact: true })).toBeVisible();
  const schedule = await openMenu(page, 'Schedule');
  await expect(schedule.getByRole('heading', { name: 'Repeating schedule' })).toBeVisible();
  await expect(page.getByText('Woodland Path', { exact: true })).toBeVisible();
  await expect(page.getByText('This preview cannot save schedule changes.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('fixture-shell.png'), fullPage: true });
});

// Task 24.0b (Avi, 2026-10-20): the activity's end is a short local time, as every slot time is (Task 23.10), never the fixed
// two-digit form (`04:20 AM`), and it stays on one line in a 360 px viewport.
test('My gladiator ends its activity line with a short end time, on one line at 360 px', async ({ page }, testInfo) => {
  test.skip(production, 'Fixture data is deliberately unavailable in production.');
  await page.goto('/game/?mode=fixture');
  await expectOwnerShown(page, 'Aster');
  // The fixture's time: 40 minutes into the owner's training, which ends at the next boundary.
  await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), worldFixture.serverNowMs);
  const mine = await openMenu(page, 'My gladiator');
  const line = mine.locator('p[role="status"]').filter({ hasText: /^In progress/ });
  await expect(line).toHaveText(`In progress · ends ${await slotTime(page, ownerFixture.currentActivity!.endsAtMs, worldFixture.serverNowMs)}`);
  await expectTimeOnOneLine(page, line, 'the activity end');
  await reviewShot360(page, testInfo, 'ends-my-gladiator', line);
});

test('normal entry exposes Google sign-in with an explicit configuration state', async ({ page, context }, testInfo) => {
  // The live camp reads the public world; in development it is answered here, never by the local Supabase stack.
  if (!production) await routeLiveReads(context, { world: emptyWorld() });
  await page.goto('/game/');
  // The visitor's chip offers sign-in; My gladiator says how to join, and whether sign-in is configured.
  await expect(joinButton(page)).toBeVisible();
  const mine = await openMenu(page, 'My gladiator');
  await expect(mine.getByText('You’re watching as a visitor.')).toBeVisible();
  if (production) {
    await expect(mine.getByRole('button', { name: VISITOR_PROMPT })).toBeDisabled();
    await expect(page.getByText('Google sign-in is unavailable until the project is configured.')).toBeVisible();
  } else {
    await expect(mine.getByRole('button', { name: VISITOR_PROMPT })).toBeEnabled();
  }
  await expect(page.getByText('Fixture mode — progress is not saved online')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('normal-shell.png'), fullPage: true });
});

test('production refuses fixture mode even when requested in the URL', async ({ page }) => {
  test.skip(!production, 'Run against the normal static production export.');
  await page.goto('/game/?mode=fixture');
  await expect(page.getByText('Fixture preview is unavailable in this build.')).toBeVisible();
  await expect(page.getByText('Fixture mode — progress is not saved online')).toHaveCount(0);
  const mine = await openMenu(page, 'My gladiator');
  await expect(mine.getByRole('button', { name: VISITOR_PROMPT })).toBeVisible();
});

test('static callback safely handles a canceled OAuth return without an application server', async ({ page }) => {
  test.skip(!production, 'Checks the exported fixed callback route.');
  await page.goto('/auth/callback/?error=access_denied&error_description=Untrusted%20text&next=https://example.invalid/');
  // Back to the fixed camp route with a short message (plan Decision 6), never to `next`, and never with provider text.
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\/game\/$/);
  await expect(page.getByRole('status').filter({ hasText: 'Google sign-in was canceled.' })).toBeVisible();
  await expect(page.getByText('Untrusted text')).toHaveCount(0);
});
