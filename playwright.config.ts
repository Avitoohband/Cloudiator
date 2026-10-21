import { defineConfig, devices } from '@playwright/test';
import { renderExclusion } from './scripts/ci-render.mjs';

const production = process.env.PLAYWRIGHT_STATIC === 'true';
// The documented ports (docs/operations/environment.md). `npm run verify -- --dev-port <n> --static-port <n>` moves them, so
// the gate can run beside another worktree's servers.
const devPort = Number(process.env.PLAYWRIGHT_DEV_PORT ?? 3100);
const staticPort = Number(process.env.PLAYWRIGHT_STATIC_PORT ?? 4173);
// The controller's CI exception (Task 24.0c; scripts/ci-render.mjs): with CLOUDIATOR_CI_RENDER=exclude, which only
// .github/workflows/checks.yml sets (its runner has no GPU), the development projects leave out the tests tagged @render.
// Unset, nothing is left out (every local run and `npm run verify`, the gate of record); the production gate never is.
const grepInvert = renderExclusion(process.env, { production });
const ciRender = grepInvert ? { grepInvert } : {};
export default defineConfig({
  testDir: './tests/browser',
  // The deployed acceptance checks run only with their own config, against a public origin (Task 24.2); never in the gate.
  testIgnore: '**/deployed.spec.ts',
  fullyParallel: true,
  use: {
    baseURL: production ? `http://127.0.0.1:${staticPort}` : `http://127.0.0.1:${devPort}`,
    trace: 'retain-on-failure',
    channel: 'chrome',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, ...ciRender },
    { name: 'mobile', use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium' }, ...ciRender },
  ],
  webServer: production ? {
    command: 'node scripts/serve-static.mjs',
    url: `http://127.0.0.1:${staticPort}`,
    reuseExistingServer: false,
    env: { CLOUDIATOR_STATIC_ROOT: process.env.PLAYWRIGHT_STATIC_ROOT ?? 'out', CLOUDIATOR_STATIC_PORT: String(staticPort) },
  } : {
    command: `npm run dev -- --port ${devPort}`,
    url: `http://127.0.0.1:${devPort}`,
    reuseExistingServer: false,
    env: { CLOUDIATOR_BROWSER_TEST: 'true', NEXT_PUBLIC_FIXTURE_ENABLED: 'true', NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_browser_test_only' },
  },
});
