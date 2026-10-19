import { defineConfig, devices } from '@playwright/test';

// Task 23.4 (plan Decision 9): the FPS harness, apart from the development and production gates (their testDir is
// tests/browser, so this suite never runs in them). Headed Chrome on the development fixture build, so the camp test hook
// exists and the frame rate is the real GPU's (headless Chrome renders with a software rasterizer). The Pixel 7 project
// adds 4x CPU throttling through CDP and is indicative only: a physical phone is measured with `?perf=1` (Task 24).
//
//   npx playwright test --config tests/performance/playwright.perf.config.ts
//
// PLAYWRIGHT_PERF_PORT picks the development server's port (default 3100; a parallel worktree uses its own); the numbers
// are printed, attached to the report and written to PERF_RESULTS (a JSON file) when that is set.
const port = Number(process.env.PLAYWRIGHT_PERF_PORT ?? 3100);
export default defineConfig({
  testDir: '.',
  testMatch: 'fps.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 15 * 60_000,
  outputDir: '../../test-results/performance',
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, channel: 'chrome', headless: false, trace: 'off' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], headless: false } },
    { name: 'pixel-7-cpu-4x', use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium', headless: false } },
  ],
  webServer: {
    command: `npm run dev -- --port ${port}`,
    cwd: '../..',
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 180_000,
    // The same test-only values as playwright.config.ts (no real keys).
    env: { CLOUDIATOR_BROWSER_TEST: 'true', NEXT_PUBLIC_FIXTURE_ENABLED: 'true', NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_browser_test_only' },
  },
});
