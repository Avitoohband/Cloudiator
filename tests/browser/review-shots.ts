// Screenshots for Avi's visual review of Task 23.4's visible changes (the camp's Reload, Try again, the `?perf=1` overlay).
import { mkdirSync } from 'node:fs';
import type { Locator, Page, TestInfo } from '@playwright/test';

/**
 * Saves `<kind>-<project>-<rest>[-production].png` for a `name` of `<kind>-<rest>` (`perf-…` or `reload-…`) in the test's
 * output folder, and also in PERF_SHOTS when that is set (Playwright clears its output folder on every run).
 */
export async function reviewShot(page: Page, testInfo: TestInfo, name: string) {
  const [kind, ...rest] = name.split('-');
  const production = process.env.PLAYWRIGHT_STATIC === 'true';
  const file = `${kind}-${testInfo.project.name}-${rest.join('-')}${production ? '-production' : ''}.png`;
  await page.screenshot({ path: testInfo.outputPath(file) });
  if (process.env.PERF_SHOTS) {
    mkdirSync(process.env.PERF_SHOTS, { recursive: true });
    await page.screenshot({ path: `${process.env.PERF_SHOTS}/${file}` });
  }
}

/**
 * The same review screenshot in a 360x740 viewport (`<name>-360`), then the test's own viewport again. `show` is scrolled
 * into view once the page has laid itself out at that width.
 */
export async function reviewShot360(page: Page, testInfo: TestInfo, name: string, show?: Locator) {
  const size = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 740 });
  await page.waitForTimeout(500);
  await show?.scrollIntoViewIfNeeded();
  await reviewShot(page, testInfo, `${name}-360`);
  if (size) {
    await page.setViewportSize(size);
    await page.waitForTimeout(300);
  }
}
