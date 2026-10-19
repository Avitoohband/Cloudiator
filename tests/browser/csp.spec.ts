import { expect, test } from './fixtures';
import { contentSecurityPolicy } from '../../scripts/build-headers.mjs';

// Task 23.6 (plan Decision 7). The production gate serves the export with its own generated `_headers`
// (scripts/serve-static.mjs) and fails on any Content-Security-Policy violation: tests/browser/fixtures.ts listens in every
// spec. These checks run against the production export only; the development server sends no policy.
const production = process.env.PLAYWRIGHT_STATIC === 'true';

test.describe('the production Content Security Policy', () => {
  test.skip(!production, 'The policy is part of the production export (`_headers`).');

  test('is served with the security headers on every fixed route', async ({ request }) => {
    for (const path of ['/', '/game/', '/auth/callback/', '/replay/', '/expedition/']) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      const headers = response.headers();
      // The gate's export has no Supabase URL, so connect-src is the site itself.
      expect(headers['content-security-policy'], path).toBe(contentSecurityPolicy(null));
      expect(headers['x-content-type-options'], path).toBe('nosniff');
      expect(headers['referrer-policy'], path).toBe('strict-origin-when-cross-origin');
      expect(headers['permissions-policy'], path).toBeTruthy();
    }
  });

  test('loads the camp, its art and a scene without a violation', async ({ page, cspViolations }) => {
    await page.goto('/game/');
    await expect(page.locator('[data-camp-view] canvas')).toHaveCount(1, { timeout: 45_000 });
    await expect(page.getByText('Opening the camp…')).toHaveCount(0, { timeout: 45_000 });
    await page.goto('/replay/?activity=not-an-activity');
    await expect(page.getByRole('heading', { level: 1, name: 'This replay is not available' })).toBeVisible({ timeout: 45_000 });
    // The automatic check after the test fails it on any violation; this names the case.
    expect(cspViolations).toEqual([]);
  });

  // Fix round 1 (Minor): the automatic check itself. A violation with the check on must fail the test: `test.fail()` expects
  // that failure, so this case passes only while the fixture's teardown check fails it.
  test('fails a test whose page breaks the policy (the automatic check)', async ({ page, cspViolations }) => {
    test.fail();
    await page.goto('/game/');
    await expect(page.locator('main#main')).toBeVisible({ timeout: 45_000 });
    expect(await page.evaluate(() => fetch('https://csp-probe.invalid/').then(() => 'sent', () => 'refused'))).toBe('refused');
    // The body itself passes once the violation is recorded; only the teardown check can fail the test.
    await expect.poll(() => cspViolations.length).toBeGreaterThan(0);
  });

  test.describe('listener', () => {
    // This case makes a violation on purpose, so the automatic check is off for it and it checks the record instead.
    test.use({ allowCspViolations: true });

    test('records a connection the policy blocks', async ({ page, cspViolations }) => {
      await page.goto('/game/');
      await expect(page.locator('main#main')).toBeVisible({ timeout: 45_000 });
      // A reserved, never-resolving name: the browser refuses the request before any network use.
      expect(await page.evaluate(() => fetch('https://csp-probe.invalid/').then(() => 'sent', () => 'refused'))).toBe('refused');
      await expect.poll(() => cspViolations.map(v => v.directive)).toContain('connect-src');
      expect(cspViolations.find(v => v.directive === 'connect-src')).toMatchObject({ blocked: expect.stringContaining('csp-probe.invalid') });
    });
  });
});
