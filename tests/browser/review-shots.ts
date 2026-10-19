// Screenshots for Avi's visual review of Task 23.4's visible changes (the camp's Reload, Try again, the `?perf=1` overlay).
import { mkdirSync } from 'node:fs';
import type { Page, TestInfo } from '@playwright/test';

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
