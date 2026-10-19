import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_FAULT_MARKER as GATE_MARKER, KNOWN_BLOCKERS, childEnv, classifyBrowser, classifyDb, gateSteps, refreshAccessTimes, runGate, summarize } from '../../scripts/verify.mjs';
import { HOST_FAULT_MARKER } from '../browser/host-faults.ts';

// Task 23.6 (R3): `npm run verify` runs every gate of docs/operations/verification-gates.md, in its order, one after another,
// runs every step whose input is valid even after another one failed, and ends with one summary. The capacity case runs with
// CAPACITY_GATE=1; its database budget is a known blocker (Task 23.7) that is reported by name, never as a pass. A database run
// during which the Edge container was recreated is discarded as an infrastructure fault (C22). Pure tests with a fake runner.

const ORDER = ['unit', 'typecheck', 'assets', 'build', 'static', 'edge', 'db', 'browser', 'browser-build', 'browser-static', 'production', 'diff'];
type Step = ReturnType<typeof gateSteps>[number];
const byId = (steps: Step[], id: string) => steps.find(step => step.id === id)!;

/** A database report in vitest's JSON shape. */
function dbReport(tests: { file?: string; name: string; failures?: string[] }[], fileFailure?: string) {
  const files = new Map<string, typeof tests>();
  for (const test of tests) files.set(test.file ?? 'tests/db/arena.test.ts', [...(files.get(test.file ?? 'tests/db/arena.test.ts') ?? []), test]);
  return {
    success: tests.every(t => !t.failures?.length) && !fileFailure,
    numPassedTests: tests.filter(t => !t.failures?.length).length, numFailedTests: tests.filter(t => t.failures?.length).length,
    testResults: [...files].map(([file, list]) => ({ name: `C:/repo/${file}`, status: list.some(t => t.failures?.length) || fileFailure ? 'failed' : 'passed',
      message: fileFailure ?? '', assertionResults: list.map(t => ({ fullName: t.name, status: t.failures?.length ? 'failed' : 'passed',
        failureMessages: (t.failures ?? []).map(m => `AssertionError: ${m}\n    at tests/db/x.ts:1:1`) })) })),
  };
}
const CAPACITY = { file: 'tests/db/capacity.test.ts', name: 'Task 23.3: capacity against the free-tier budgets measures database growth, invocations and egress over accelerated boundaries with the real worker' };
const BUDGET_FAILURES = ['database at 90 days, mixed schedules: expected 1.781 to be less than 1', 'database after one year, new-character schedule: expected 2.274 to be less than 1'];

/** A Playwright JSON report: the failed tests and their error messages (one test per entry). */
function browserReport(failed: string[][]) {
  return { stats: { expected: 10, unexpected: failed.length }, suites: [{ title: 'x.spec.ts', specs: failed.map((errors, i) => ({ title: `case ${i}`,
    tests: [{ projectName: 'desktop', status: 'unexpected', results: [{ status: 'failed', errors: errors.map(message => ({ message })) }] }] })) }] };
}
const HOST = `${HOST_FAULT_MARKER} 1 request failed in the host's network stack (net::ERR_NO_BUFFER_SPACE for http://127.0.0.1:3200/_next/static/chunks/a.js)`;

/** A fake runner: exit codes by step id (0 when absent; a list is used up call by call), a stable Edge unless told otherwise. */
function fakeIo(options: { codes?: Record<string, number | number[]>; reports?: unknown[]; browserReports?: Record<string, unknown[]>;
  starts?: (string | null)[]; edge?: { ok: boolean; note?: string }[] } = {}) {
  const ran: string[] = [];
  const codeOf = (id: string) => { const c = options.codes?.[id]; return Array.isArray(c) ? c.shift() ?? 0 : c ?? 0; };
  const starts = [...(options.starts ?? [])];
  const reports = [...(options.reports ?? [dbReport([{ name: 'ok' }])])];
  const edges = [...(options.edge ?? [])];
  let started = '2026-10-19T14:23:38.1Z';
  return {
    ran,
    io: {
      exec: async (step: Step) => { ran.push(step.id); return codeOf(step.id); },
      settleEdge: async () => { ran.push('settle'); const e = edges.shift() ?? { ok: true }; return { ok: e.ok, startedAt: started, recreated: false, files: 40, waitedMs: 30_000, note: e.note }; },
      edgeStartedAt: () => { const next = starts.shift(); if (next !== undefined && next !== null) started = next; return started; },
      readDbReport: () => reports.shift() ?? null,
      readBrowserReport: (step: Step) => options.browserReports?.[step.id]?.shift() ?? null,
      log: () => undefined,
    },
  };
}

describe('the gate steps', () => {
  it('follow docs/operations/verification-gates.md in one worktree, one after another', () => {
    expect(gateSteps().map(step => step.id)).toEqual(ORDER);
    const doc = readFileSync('docs/operations/verification-gates.md', 'utf8');
    // The guide lists the same commands in the same order.
    const positions = gateSteps().filter(step => step.kind !== 'edge').map(step => [step.display, doc.indexOf(step.display)] as const);
    for (const [display, at] of positions) expect(at, display).toBeGreaterThanOrEqual(0);
    expect(positions.map(([, at]) => at)).toEqual([...positions.map(([, at]) => at)].sort((a, b) => a - b));
    expect(doc).toContain('npm run verify');
  });

  it('run the capacity case with its budgets enforced, beside the whole database suite', () => {
    const db = byId(gateSteps(), 'db');
    expect(db.display).toBe('CAPACITY_GATE=1 npm run test:db');
    expect(db.env).toMatchObject({ CAPACITY_GATE: '1' });
    expect(db.needs).toEqual(['edge']);
  });

  it('build the isolated production export without the test transport, then scan and browse it', () => {
    const steps = gateSteps();
    const build = byId(steps, 'browser-build');
    expect(build.env).toEqual({ CLOUDIATOR_BROWSER_TEST: 'true', NEXT_PUBLIC_FIXTURE_ENABLED: 'true' });
    expect(build.unset).toEqual(expect.arrayContaining(['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL']));
    expect(byId(steps, 'browser-static').display).toBe('npm run verify:static -- .next/browser-test');
    expect(byId(steps, 'browser-static').needs).toEqual(['browser-build']);
    expect(byId(steps, 'production').env).toMatchObject({ PLAYWRIGHT_STATIC: 'true', PLAYWRIGHT_STATIC_ROOT: '.next/browser-test' });
    expect(byId(steps, 'production').needs).toEqual(['browser-build']);
    expect(byId(steps, 'static').needs).toEqual(['build']);
  });

  it('pass a private Playwright configuration and the ports on, so the gate can run beside other worktrees', () => {
    const steps = gateSteps({ config: 'node_modules/.cache/pw-claude.config.mjs', devPort: 3200, staticPort: 3201 });
    for (const id of ['browser', 'production']) expect(byId(steps, id).args).toEqual(expect.arrayContaining(['--config', 'node_modules/.cache/pw-claude.config.mjs']));
    expect(byId(steps, 'browser').env).toMatchObject({ PLAYWRIGHT_DEV_PORT: '3200' });
    expect(byId(steps, 'production').env).toMatchObject({ PLAYWRIGHT_STATIC_PORT: '3201' });
  });

  it('keep each browser step\'s results apart, so the production run never deletes the development run\'s traces', () => {
    const steps = gateSteps({ results: 'out-results' });
    expect(byId(steps, 'browser').args).toEqual(expect.arrayContaining(['--output', 'out-results/development', '--reporter=list,json']));
    expect(byId(steps, 'production').args).toEqual(expect.arrayContaining(['--output', 'out-results/production', '--reporter=list,json']));
    expect(byId(steps, 'browser').env?.PLAYWRIGHT_JSON_OUTPUT_NAME).toMatch(/development\.json$/);
    expect(byId(steps, 'production').env?.PLAYWRIGHT_JSON_OUTPUT_NAME).toMatch(/production\.json$/);
    expect(byId(gateSteps(), 'browser').args).toEqual(expect.arrayContaining(['--output', 'test-results/development']));
  });

  it('give every child the step\'s environment, without the conflicting colour variable (C23)', () => {
    const build = byId(gateSteps(), 'browser-build');
    const env = childEnv(build, { PATH: 'x', NO_COLOR: '1', FORCE_COLOR: '1', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_browser_test_only', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' });
    expect(env).toEqual({ PATH: 'x', FORCE_COLOR: '1', CLOUDIATOR_BROWSER_TEST: 'true', NEXT_PUBLIC_FIXTURE_ENABLED: 'true' });
    expect(childEnv(byId(gateSteps(), 'unit'), { NO_COLOR: '1' })).toEqual({});
  });
});

describe('the database result', () => {
  it('passes a clean run', () => {
    expect(classifyDb(dbReport([{ name: 'a' }, { name: 'b' }]))).toMatchObject({ status: 'passed', passed: 2, failed: 0 });
  });

  it('names the database budget as the known blocker when it is the only failure', () => {
    const result = classifyDb(dbReport([{ name: 'a' }, { ...CAPACITY, failures: BUDGET_FAILURES }]));
    expect(result).toMatchObject({ status: 'blocked', passed: 1, failed: 0 });
    expect(result.blocked).toEqual([expect.objectContaining({ blocker: 'database-budget' })]);
    expect(KNOWN_BLOCKERS.find(b => b.id === 'database-budget')).toMatchObject({ name: 'database budget', owner: expect.stringContaining('Task 23.7') });
  });

  it('fails a run with any other failure, also when the blocker fails beside it', () => {
    expect(classifyDb(dbReport([{ name: 'a', failures: ['expected 1 to be 2'] }, { ...CAPACITY, failures: BUDGET_FAILURES }]))).toMatchObject({ status: 'failed', failed: 1 });
    // Another budget in the same capacity case is not the known blocker.
    expect(classifyDb(dbReport([{ ...CAPACITY, failures: [...BUDGET_FAILURES, 'raw egress, 31 days: expected 1.2 to be less than 1'] }]))).toMatchObject({ status: 'failed' });
    // A file that failed outside its tests (a hook, an import) is a failure.
    expect(classifyDb(dbReport([{ name: 'a' }], 'Error: afterAll hook timed out'))).toMatchObject({ status: 'failed' });
    expect(classifyDb(null)).toMatchObject({ status: 'failed' });
  });
});

describe('the gate run', () => {
  it('runs every step in order and passes when all pass', async () => {
    const { io, ran } = fakeIo();
    const results = await runGate(gateSteps(), io);
    expect(ran).toEqual(['unit', 'typecheck', 'assets', 'build', 'static', 'settle', 'db', 'browser', 'browser-build', 'browser-static', 'production', 'diff']);
    expect(results.map(r => r.status)).toEqual(ORDER.map(() => 'passed'));
    expect(summarize(results)).toMatchObject({ status: 'passed', exitCode: 0 });
  });

  it('keeps running after a failure and skips only the steps whose input it invalidates', async () => {
    const { io, ran } = fakeIo({ codes: { unit: 1, build: 1, 'browser-build': 2 } });
    const results = await runGate(gateSteps(), io);
    expect(ran).toEqual(['unit', 'typecheck', 'assets', 'build', 'settle', 'db', 'browser', 'browser-build', 'diff']);
    const status = Object.fromEntries(results.map(r => [r.id, r.status]));
    expect(status).toMatchObject({ unit: 'failed', build: 'failed', static: 'skipped', db: 'passed', browser: 'passed',
      'browser-build': 'failed', 'browser-static': 'skipped', production: 'skipped', diff: 'passed' });
    expect(results.find(r => r.id === 'static')!.note).toContain('build');
    const summary = summarize(results);
    expect(summary).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(summary.text).toMatch(/failed\s+unit/);
  });

  it('reports the database budget blocker by name and exits 2 when nothing else failed', async () => {
    const { io } = fakeIo({ codes: { db: 1 }, reports: [dbReport([{ name: 'a' }, { ...CAPACITY, failures: BUDGET_FAILURES }])] });
    const results = await runGate(gateSteps(), io);
    expect(results.find(r => r.id === 'db')).toMatchObject({ status: 'blocked' });
    const summary = summarize(results);
    expect(summary).toMatchObject({ status: 'blocked', exitCode: 2 });
    expect(summary.text).toContain('database budget');
    expect(summary.text).toContain('Task 23.7');
  });

  it('discards a database run during which the Edge container was recreated, then reruns once on a settled Edge', async () => {
    // The first run starts and ends on different container start times; the rerun is stable.
    const { io, ran } = fakeIo({ starts: ['2026-10-19T14:23:38.1Z', '2026-10-19T14:30:02.5Z', '2026-10-19T14:31:00.0Z', '2026-10-19T14:31:00.0Z'],
      reports: [dbReport([{ name: 'a', failures: ['connection refused'] }]), dbReport([{ name: 'a' }])] });
    const results = await runGate(gateSteps(), io);
    expect(ran.filter(id => id === 'db' || id === 'settle')).toEqual(['settle', 'db', 'settle', 'db']);
    const db = results.find(r => r.id === 'db')!;
    expect(db.status).toBe('passed');
    expect(db.note).toContain('1 run discarded');
    expect(db.note).toContain('14:30:02.5Z');
  });

  it('calls a twice-recreated Edge an infrastructure fault, never a result', async () => {
    const { io } = fakeIo({ starts: ['a', 'b', 'c', 'd'], reports: [dbReport([{ name: 'a' }]), dbReport([{ name: 'a' }])] });
    const results = await runGate(gateSteps(), io);
    expect(results.find(r => r.id === 'db')).toMatchObject({ status: 'infrastructure' });
    expect(summarize(results)).toMatchObject({ status: 'failed', exitCode: 1 });
  });

  it('skips the database tests when the Edge runtime does not settle or serve', async () => {
    const { io, ran } = fakeIo({ edge: [{ ok: false, note: 'the worker did not answer' }] });
    const results = await runGate(gateSteps(), io);
    expect(ran).not.toContain('db');
    expect(results.find(r => r.id === 'edge')).toMatchObject({ status: 'infrastructure' });
    expect(results.find(r => r.id === 'db')).toMatchObject({ status: 'skipped' });
  });
});

describe('a browser run', () => {
  it('is an infrastructure fault only when every failed test names a host network fault', () => {
    expect(GATE_MARKER).toBe(HOST_FAULT_MARKER);
    expect(classifyBrowser(browserReport([]))).toMatchObject({ status: 'passed' });
    expect(classifyBrowser(browserReport([['Error: expect(locator).toBeVisible() failed', HOST]]))).toMatchObject({ status: 'infrastructure', failed: 1 });
    expect(classifyBrowser(browserReport([[HOST], ['Error: expect(received).toBe(expected)']]))).toMatchObject({ status: 'failed', failed: 2 });
    expect(classifyBrowser(null)).toMatchObject({ status: 'failed' });
  });

  it('is run once more after a host network fault, and the discarded run is reported', async () => {
    const { io, ran } = fakeIo({ codes: { production: [1, 0] }, browserReports: { production: [browserReport([[HOST]]), browserReport([])] } });
    const results = await runGate(gateSteps(), io);
    expect(ran.filter(id => id === 'production')).toEqual(['production', 'production']);
    const production = results.find(r => r.id === 'production')!;
    expect(production.status).toBe('passed');
    expect(production.note).toContain('1 run discarded');
    expect(production.note).toContain('ERR_NO_BUFFER_SPACE');
  });

  it('is a failure, never rerun, when a test failed for any other reason', async () => {
    const { io, ran } = fakeIo({ codes: { browser: 1 }, browserReports: { browser: [browserReport([['Error: Timeout 45000ms exceeded.']])] } });
    const results = await runGate(gateSteps(), io);
    expect(ran.filter(id => id === 'browser')).toEqual(['browser']);
    expect(results.find(r => r.id === 'browser')).toMatchObject({ status: 'failed' });
  });
});

describe('the Edge access-time refresh (C22)', () => {
  it.skipIf(process.platform !== 'win32')('sets every folder and file access time to now and leaves the modification times', () => {
    const root = mkdtempSync(join(tmpdir(), 'cloudiator-atime-'));
    try {
      mkdirSync(join(root, '_shared', 'domain'), { recursive: true });
      writeFileSync(join(root, '_shared', 'domain', 'types.ts'), 'export {};');
      writeFileSync(join(root, 'deno.json'), '{}');
      const old = new Date('2026-01-01T00:00:00Z');
      const entries = [root, join(root, '_shared'), join(root, '_shared', 'domain'), join(root, '_shared', 'domain', 'types.ts'), join(root, 'deno.json')];
      for (const entry of entries) utimesSync(entry, old, old);
      const before = entries.map(entry => statSync(entry, { bigint: true }).mtimeNs);
      const started = Date.now();
      expect(refreshAccessTimes(root)).toBe(entries.length);
      for (const [i, entry] of entries.entries()) {
        const stat = statSync(entry, { bigint: true });
        expect(Number(stat.atimeNs / 1_000_000n), entry).toBeGreaterThanOrEqual(started - 2_000);
        expect(stat.mtimeNs, entry).toBe(before[i]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
