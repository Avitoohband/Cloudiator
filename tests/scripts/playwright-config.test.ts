import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CI_RENDER_ENV, RENDER_PATTERN, RENDER_TAG, renderExclusion } from '../../scripts/ci-render.mjs';

// Task 24.0c (the controller's CI exception, 2026-10-20): the first GitHub Actions run (39452911203) failed only in the
// development browser step, almost all 30 s timeouts while a WebGL page rendered, because the runner has no GPU. With
// CLOUDIATOR_CI_RENDER=exclude (set only by .github/workflows/checks.yml) the development projects leave out the tests tagged
// @render. Without it (every local run, and `npm run verify`, the gate of record) nothing is left out, and the production
// gate never leaves anything out. The config is loaded as Playwright loads it, once per environment.

const NAMES = [CI_RENDER_ENV, 'PLAYWRIGHT_STATIC'] as const;
type Env = Partial<Record<(typeof NAMES)[number], string>>;
const saved = Object.fromEntries(NAMES.map(name => [name, process.env[name]])) as Env;
afterEach(() => {
  for (const name of NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  vi.resetModules();
});
/** playwright.config.ts evaluated afresh with exactly `env` for the two names (CI itself sets CLOUDIATOR_CI_RENDER). */
async function load(env: Env) {
  for (const name of NAMES) { if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name]; }
  vi.resetModules();
  return (await import('../../playwright.config.ts')).default;
}
/** The string Playwright 1.64 matches `grep`/`grepInvert` against: project, file, describe and test titles, then the tags. */
const grepTitle = (title: string, tags: string[] = []) => ['desktop', 'arena.spec.ts', 'arena staging and sparring rings in the camp', title, ...tags].join(' ');

describe('the CI render exclusion in playwright.config.ts', () => {
  it('leaves nothing out without CLOUDIATOR_CI_RENDER: every local run and the gate of record run every test', async () => {
    for (const value of [undefined, '']) {
      const config = await load({ [CI_RENDER_ENV]: value });
      expect(config.grepInvert, String(value)).toBeUndefined();
      expect(config.projects?.map(p => p.name)).toEqual(['desktop', 'mobile']);
      for (const project of config.projects ?? []) expect(project.grepInvert, `${project.name} ${String(value)}`).toBeUndefined();
    }
  });

  it('leaves the tests tagged @render out of both development projects with CLOUDIATOR_CI_RENDER=exclude', async () => {
    const config = await load({ [CI_RENDER_ENV]: 'exclude' });
    expect(config.grepInvert).toBeUndefined();
    for (const project of config.projects ?? []) {
      const invert = project.grepInvert as RegExp;
      // The config was evaluated afresh, with its own copy of scripts/ci-render.mjs: the same pattern, not the same object.
      expect(invert, project.name).toBeInstanceOf(RegExp);
      expect(invert.source, project.name).toBe(RENDER_PATTERN.source);
      expect(invert.test(grepTitle('walks each revealed pair into its own ring', [RENDER_TAG])), project.name).toBe(true);
      expect(invert.test(grepTitle('flags only requests that leave the test origin')), project.name).toBe(false);
      // Only the tag itself: not a longer tag, and not the word in a title.
      expect(invert.test(grepTitle('a title', ['@rendering'])), project.name).toBe(false);
      expect(invert.test(grepTitle('renders the camp')), project.name).toBe(false);
    }
  });

  it('never leaves anything out of the production gate', async () => {
    const config = await load({ [CI_RENDER_ENV]: 'exclude', PLAYWRIGHT_STATIC: 'true' });
    expect(config.grepInvert).toBeUndefined();
    for (const project of config.projects ?? []) expect(project.grepInvert, project.name).toBeUndefined();
    expect(config.use?.baseURL).toMatch(/:4173$/);
  });

  it('refuses any other value rather than running a gate whose scope nobody chose', async () => {
    await expect(load({ [CI_RENDER_ENV]: 'yes' })).rejects.toThrow(/CLOUDIATOR_CI_RENDER must be unset or "exclude"/);
    expect(() => renderExclusion({ [CI_RENDER_ENV]: 'include' })).toThrow(/not "include"/);
    expect(renderExclusion({}, { production: false })).toBeUndefined();
    expect(renderExclusion({ [CI_RENDER_ENV]: 'exclude' }, { production: true })).toBeUndefined();
    expect(renderExclusion({ [CI_RENDER_ENV]: 'exclude' })).toBe(RENDER_PATTERN);
  });

  // Playwright itself, not only the config object: its listing (no web server is started) with and without the variable.
  it('is applied by Playwright: the listing loses exactly the tagged tests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloudiator-render-list-'));
    try {
      const list = (value: string | undefined) => {
        const file = join(dir, `${value ?? 'all'}.json`);
        const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: file };
        delete env[CI_RENDER_ENV];
        delete env.PLAYWRIGHT_STATIC;
        if (value) env[CI_RENDER_ENV] = value;
        const run = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--list', '--reporter=json'], { env, encoding: 'utf8' });
        expect(run.status, run.stderr).toBe(0);
        const report = JSON.parse(readFileSync(file, 'utf8'));
        const walk = (suite: any): { tags: string[] }[] => [...(suite.specs ?? []).flatMap((spec: any) => spec.tests.map(() => ({ tags: spec.tags as string[] }))),
          ...(suite.suites ?? []).flatMap(walk)];
        return report.suites.flatMap(walk) as { tags: string[] }[];
      };
      const all = list(undefined);
      const tagged = all.filter(t => t.tags.includes(RENDER_TAG.slice(1))).length;
      expect(tagged).toBeGreaterThan(0);
      const ci = list('exclude');
      expect(ci.length).toBe(all.length - tagged);
      expect(ci.some(t => t.tags.includes(RENDER_TAG.slice(1)))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
