import { defineConfig, devices } from '@playwright/test';
import type { FixtureOptions } from './fixtures';
import { deployedOrigin, recordingFlags } from './deployed-checks';

// The deployed acceptance checks (Task 24.2, plan Decision 1): tests/browser/deployed.spec.ts against the public origin in
// CLOUDIATOR_DEPLOYED_ORIGIN, which is required (loading this config without it fails, naming the variable). No web server:
// the site is already deployed. The repository config (playwright.config.ts) ignores the spec, so the release gate never runs
// it. Traces, screenshots and videos are off: a trace would record the publishable key the anonymous probes send, and the
// evidence reporter prints only masked summary lines. A command line flag overrides `trace: 'off'`, so the config refuses the ones
// that record a trace (`--trace`, the UI mode; Task 24.2b). How to run it: docs/operations/runbook.md, "Running the deployed
// checks".
const recording = recordingFlags(process.argv);
if (recording.length) {
  throw new Error(`The deployed checks never record a trace (it would hold the apikey header the probes send): run them without ${recording.join(', ')}.`);
}
const origin = deployedOrigin(process.env);

export default defineConfig<FixtureOptions>({
  testDir: '.',
  testMatch: 'deployed.spec.ts',
  // One file, its checks in order per project; the shipped-asset crawl is shared by the checks that need it.
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  // The list reporter, then one evidence line per check after its summary (tests/browser/deployed-reporter.ts, Task 24.2b).
  reporter: [['list'], ['./deployed-reporter.ts']],
  use: {
    baseURL: origin,
    channel: 'chrome',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    // Every page of every check runs under the CSP-violation listener (tests/browser/fixtures.ts).
    listenForCsp: true,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // The phone runs the browser checks only; the origin's headers, CORS and the Data API answer the same to both.
    { name: 'mobile', use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium' }, grep: /@browser/ },
  ],
});
