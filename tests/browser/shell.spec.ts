import { expect, test } from '@playwright/test';

const production = process.env.PLAYWRIGHT_STATIC === 'true';

test('management shell labels local fixture data and exposes an accessible schedule', async ({ page }, testInfo) => {
  test.skip(production, 'Fixture data is deliberately unavailable in production.');
  await page.goto('/game/?mode=fixture');
  await expect(page.getByText('Fixture mode — progress is not saved online')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Schedule', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Repeating schedule' })).toBeVisible();
  await expect(page.getByText('Woodland Path', { exact: true })).toBeVisible();
  await expect(page.getByText('This preview cannot save schedule changes.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('fixture-shell.png'), fullPage: true });
});

test('normal entry exposes Google sign-in with an explicit configuration state', async ({ page }, testInfo) => {
  await page.goto('/game/');
  await expect(page.getByRole('heading', { name: 'Your story starts here' })).toBeVisible();
  if (production) {
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeDisabled();
    await expect(page.getByText('Google sign-in is unavailable until the project is configured.')).toBeVisible();
  } else {
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  }
  await expect(page.getByText('Fixture mode — progress is not saved online')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('normal-shell.png'), fullPage: true });
});

test('production refuses fixture mode even when requested in the URL', async ({ page }) => {
  test.skip(!production, 'Run against the normal static production export.');
  await page.goto('/game/?mode=fixture');
  await expect(page.getByText('Fixture preview is unavailable in this build.')).toBeVisible();
  await expect(page.getByText('Fixture mode — progress is not saved online')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your story starts here' })).toBeVisible();
});

test('static callback safely handles a canceled OAuth return without an application server', async ({ page }) => {
  test.skip(!production, 'Checks the exported fixed callback route.');
  await page.goto('/auth/callback/?error=access_denied&error_description=Untrusted%20text&next=https://example.invalid/');
  await expect(page.locator('p[role=alert]')).toContainText('was canceled');
  await expect(page.getByText('Untrusted text')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Return to the camp' })).toHaveAttribute('href', '/game/');
  await expect(page).toHaveURL(/\/auth\/callback\/$/);
});
