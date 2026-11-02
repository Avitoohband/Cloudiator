import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { defineConfig } from '@playwright/test';

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

/** Use a variable path so the RED phase can assert absence before importing a not-yet-created module. */
async function loadFull(env: Env) {
  expect(existsSync('playwright.full-gate.config.ts'), 'the opt-in config must exist').toBe(true);
  for (const name of NAMES) { if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name]; }
  vi.resetModules();
  const modulePath = '../../playwright.full-gate.config.ts';
  return (await import(modulePath)).default as Awaited<ReturnType<typeof load>>;
}

describe('playwright.full-gate.config.ts', () => {
  const environments: [string, Env][] = [
    ['development', {}],
    ['static', { PLAYWRIGHT_STATIC: 'true' }],
    ['an inherited CI marker', { CLOUDIATOR_CI: 'github' }],
    ['the retired render-filter marker', { CLOUDIATOR_CI_RENDER: 'exclude' }],
  ];

  it.each(environments)('uses strict native-profile execution and preserves every other root-config key in %s', async (_name, env) => {
    const rootConfig = await load(env);
    // The public merge normalizes expect/build/webServer even with empty overrides. Compare the same normalized shape.
    const base = defineConfig(rootConfig, {});
    const full = await loadFull(env);
    expect(full.workers, 'workers').toBe(1);
    expect(full.retries, 'retries').toBe(0);
    expect(full.repeatEach, 'repeatEach').toBe(1);
    expect(full.timeout, 'timeout').toBe(90_000);
    const overridden = new Set(['workers', 'retries', 'repeatEach', 'timeout']);
    const baseKeys = Object.keys(base).filter(key => !overridden.has(key)).sort();
    const fullKeys = Object.keys(full).filter(key => !overridden.has(key)).sort();
    expect(fullKeys).toEqual(baseKeys);
    for (const key of baseKeys) {
      // Never give assertion formatting a nested config/env value: a failure may otherwise print fixture credentials.
      expect(isDeepStrictEqual((full as Record<string, unknown>)[key], (base as Record<string, unknown>)[key]), key).toBe(true);
    }
    expect(isDeepStrictEqual(full.projects, rootConfig.projects), 'projects preserve root Chrome/Pixel 7 settings').toBe(true);
    expect(isDeepStrictEqual(full.use, rootConfig.use), 'use preserves root rendering settings').toBe(true);
    expect(full.projects?.map(project => project.name)).toEqual(['desktop', 'mobile']);
    expect(full.use?.channel).toBe('chrome');
    expect(full.grep).toBeUndefined();
    expect(full.grepInvert).toBeUndefined();
    expect(full.testIgnore).toBe('**/deployed.spec.ts');
    for (const project of full.projects ?? []) {
      expect(project.grep, project.name).toBeUndefined();
      expect(project.grepInvert, project.name).toBeUndefined();
    }
  });
});
