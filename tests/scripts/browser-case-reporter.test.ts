import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { childEnv, gateSteps, runGate } from '../../scripts/verify.mjs';
import BrowserCaseReporter from '../../scripts/browser-case-reporter.mjs';

// No browser fixture, webServer or app: only installed Playwright's test discovery, worker and reporter machinery.
function fixture(controls = false) {
  const cache = resolve('tests/scripts');
  const root = mkdtempSync(join(cache, 'gate-reporter-'));
  writeFileSync(join(root, 'playwright.config.mjs'), `export default ${JSON.stringify({ testDir: resolve('.'),
    testMatch: join(root, 'pure.spec.mjs').replace(/\\/g, '/'), fullyParallel: true, workers: 1,
    retries: 0, repeatEach: 1, projects: [{ name: 'desktop' }, { name: 'mobile' }] })};`);
  writeFileSync(join(root, 'pure.spec.mjs'), `import {test, expect} from '@playwright/test';
    test('first', () => expect(1).toBe(1)); test('second', () => expect(2).toBe(2));
    ${controls ? `test.skip('static skip', () => {});
      test('runtime skip', () => { test.skip(true, 'legitimate control'); });
      test('expected failure', () => { test.fail(); expect(1).toBe(2); });` : ''}`);
  return root;
}
const keys = (r: any) => r.suites.flatMap((s: any) => s.specs.flatMap((spec: any) => spec.tests.map((t: any) => JSON.stringify([spec.id, t.projectId])))).sort();
const read = (path: string) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
function cleanup(root: string) {
  const target = resolve(root);
  if (dirname(target) !== resolve('tests/scripts') || !basename(target).startsWith('gate-reporter-')) throw new Error('fixture cleanup escaped its parent');
  rmSync(target, { recursive: true, force: true });
}
async function exercise(root: string) {
  const steps = gateSteps({ config: join(root, 'playwright.config.mjs'), browserShards: 2, results: join(root, 'artifacts') }).filter(s => s.id === 'browser');
  const children: any[] = [], errors: string[] = [];
  const results = await runGate(steps, { log: () => undefined, readBrowserReport: (step: any) => read(step.report),
    exec: async (step: any) => {
      children.push(step); mkdirSync(join(step.report, '..'), { recursive: true });
      const child = spawnSync(step.command, step.args, { env: childEnv(step) as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 15_000 });
      if (child.stderr) errors.push(child.stderr);
      return child.status ?? 127;
    } });
  expect(errors).toEqual([]);
  return { results, children };
}

describe('installed Playwright identity reporting', { timeout: 30_000 }, () => {
  it('characterizes the built-in merged spec id changing when only the second project is selected by sharding', () => {
    const root = fixture();
    try {
      const invoke = (name: string, shard?: string) => {
        const output = join(root, `${name}.json`);
        const child = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', join(root, 'playwright.config.mjs'),
          '--list', '--reporter=json', ...(shard ? [`--shard=${shard}`] : [])],
        { env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: output }, encoding: 'utf8', timeout: 15_000 });
        expect(child.status).toBe(0); return read(output);
      };
      const full = invoke('full'), first = invoke('first', '1/2'), second = invoke('second', '2/2');
      expect(keys(full)).toHaveLength(4);
      expect([...keys(first), ...keys(second)].sort()).not.toEqual(keys(full));
      expect(full.suites[0].specs.every((s: any) => s.tests.length === 2)).toBe(true);
    } finally { cleanup(root); }
  });

  it('proves exact identity union using the public reporter alongside raw JSON through real gate orchestration', async () => {
    const root = fixture();
    try {
      const { results, children } = await exercise(root);
      expect(results[0].status, JSON.stringify((results[0] as any).browser.failures)).toBe('passed');
      const browser = (results[0] as any).browser;
      expect(browser.coverage).toMatchObject({ complete: true, expected: 4, observed: 4, executable: 4, skipped: 0 });
      expect(typeof browser.inventory.identityReport).toBe('string');
      const manifest = keys(read(browser.inventory.identityReport));
      const shards = browser.shards.flatMap((s: any) => keys(read(s.identityReport)));
      expect(shards.sort()).toEqual(manifest); expect(new Set(shards).size).toBe(4);
      expect(children).toHaveLength(3);
      for (const step of children) {
        expect(read(step.report)).not.toBeNull();
        expect(read(step.identityReport)).not.toBeNull();
      }
    } finally { cleanup(root); }
  });

  it('preserves real expected-failure and static/runtime skip controls in both reports', async () => {
    const root = fixture(true);
    try {
      const { results } = await exercise(root);
      expect(results[0].status, JSON.stringify((results[0] as any).browser.failures)).toBe('passed');
      expect((results[0] as any).browser.coverage).toMatchObject({ complete: true, expected: 10, observed: 10, executable: 6, skipped: 4 });
    } finally { cleanup(root); }
  });

  it('fails closed when public project names are ambiguous', () => {
    const root = mkdtempSync(join(resolve('tests/scripts'), 'gate-reporter-temp-'));
    const saved = process.env.CLOUDIATOR_BROWSER_IDENTITY_REPORT;
    try {
      const output = join(root, 'identities.json'); process.env.CLOUDIATOR_BROWSER_IDENTITY_REPORT = output;
      const reporter = new BrowserCaseReporter();
      reporter.onBegin({ workers: 1, projects: [{ name: 'same', retries: 0, repeatEach: 1 }, { name: 'same', retries: 0, repeatEach: 1 }] }, { allTests: () => [] });
      reporter.onEnd({ status: 'passed' });
      expect(read(output).errors).toEqual([{ message: 'ambiguous public project names in browser identity report' }]);
    } finally {
      if (saved === undefined) delete process.env.CLOUDIATOR_BROWSER_IDENTITY_REPORT; else process.env.CLOUDIATOR_BROWSER_IDENTITY_REPORT = saved;
      cleanup(root);
    }
  });
});
