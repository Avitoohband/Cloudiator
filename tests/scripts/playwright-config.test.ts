import { afterEach, describe, expect, it, vi } from 'vitest';

// Task 24.0d (the controller's CI exception, 2026-10-21): the GitHub runner does not run the development browser suite at all
// (scripts/verify.mjs reports the step as `not run on CI`; tests/scripts/verify.test.ts), and playwright.config.ts never leaves
// a test out of a run that happens. Task 24.0c's exclusion of the tests tagged @render, which this file used to test, is gone:
// the tags remain as documentation and as a manual filter (`--grep @render`, `--grep-invert @render`). The config is loaded as
// Playwright loads it, once per environment.

const NAMES = ['PLAYWRIGHT_STATIC', 'CLOUDIATOR_CI', 'CLOUDIATOR_CI_RENDER'] as const;
type Env = Partial<Record<(typeof NAMES)[number], string>>;
const saved = Object.fromEntries(NAMES.map(name => [name, process.env[name]])) as Env;
afterEach(() => {
  for (const name of NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  vi.resetModules();
});
/** playwright.config.ts evaluated afresh with exactly `env` for the names (CI itself sets CLOUDIATOR_CI). */
async function load(env: Env) {
  for (const name of NAMES) { if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name]; }
  vi.resetModules();
  return (await import('../../playwright.config.ts')).default;
}

describe('playwright.config.ts', () => {
  const environments: [string, Env][] = [['a local run', {}], ['the production gate', { PLAYWRIGHT_STATIC: 'true' }],
    ['the GitHub runner (CLOUDIATOR_CI=github)', { CLOUDIATOR_CI: 'github' }], ['the retired Task 24.0c variable', { CLOUDIATOR_CI_RENDER: 'exclude' }]];

  it.each(environments)('leaves no test out of %s: no grep or grepInvert, in the config or either project', async (_name, env) => {
    const config = await load(env);
    expect(config.grep).toBeUndefined();
    expect(config.grepInvert).toBeUndefined();
    expect(config.projects?.map(p => p.name)).toEqual(['desktop', 'mobile']);
    for (const project of config.projects ?? []) {
      expect(project.grep, project.name).toBeUndefined();
      expect(project.grepInvert, project.name).toBeUndefined();
    }
    // The only file it never runs is the deployed acceptance check, which has its own config (Task 24.2).
    expect(config.testIgnore).toBe('**/deployed.spec.ts');
  });
});
