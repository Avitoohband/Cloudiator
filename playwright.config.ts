import { defineConfig, devices } from '@playwright/test';

const production = process.env.PLAYWRIGHT_STATIC === 'true';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  use: {
    baseURL: production ? 'http://127.0.0.1:4173' : 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    channel: 'chrome',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium' } },
  ],
  webServer: production ? {
    command: 'node scripts/serve-static.mjs',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    env: { CLOUDIATOR_STATIC_ROOT: process.env.PLAYWRIGHT_STATIC_ROOT ?? 'out' },
  } : {
    command: 'npm run dev -- --port 3100',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: false,
    env: { CLOUDIATOR_BROWSER_TEST: 'true', NEXT_PUBLIC_FIXTURE_ENABLED: 'true', NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_browser_test_only' },
  },
});
