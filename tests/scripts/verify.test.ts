import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_FAULT_MARKER as GATE_MARKER, KNOWN_BLOCKERS, childEnv, classifyBrowser, classifyDb, countExcluded, countListed, gateSteps, parseOptions, prepareEdge,
  refreshAccessTimes, runGate, summarize } from '../../scripts/verify.mjs';
import { CI_RENDER_ENV, RENDER_PATTERN, RENDER_TAG } from '../../scripts/ci-render.mjs';
import { HOST_FAULT_MARKER } from '../browser/host-faults.ts';

// Task 23.6 (R3): `npm run verify` runs every gate of the approved docs/operations/verification-gates.md, in its order, one
// after another, runs every step whose input is valid even after another one failed, and ends with one summary. The capacity
// case runs with CAPACITY_GATE=1. A known blocker is reported by name, never as a pass, and only when nothing else failed (fix
// round 1, Important 1); the database budget was one until Task 23.7 cleared it, and Task 23.8 retired it, so the list is empty
// and the mechanism's tests use their own fixture list. A database run during which the Edge container was recreated is
// discarded and run exactly once more (C22). A browser failure beside a host network fault is labelled, never rerun (fix round
// 1, Important 3). Pure tests with a fake runner, plus the Edge refresh on a scratch folder (Windows).

const ORDER = ['unit', 'typecheck', 'assets', 'build', 'static', 'edge', 'db', 'browser', 'browser-build', 'browser-static', 'production', 'diff'];
type Step = ReturnType<typeof gateSteps>[number];
const byId = (steps: Step[], id: string) => steps.find(step => step.id === id)!;

type Test = { file?: string; name: string; suites?: string[]; errors?: string[] };
/** A database report as scripts/vitest-gate-reporter.mjs writes it. */
function dbReport(tests: Test[], extra: { suiteErrors?: Record<string, string[]>; moduleErrors?: string[]; unhandled?: string[]; passed?: number } = {}) {
  const files = new Map<string, Test[]>();
  for (const test of tests) files.set(test.file ?? 'tests/db/arena.test.ts', [...(files.get(test.file ?? 'tests/db/arena.test.ts') ?? []), test]);
  if (extra.suiteErrors && !files.has('tests/db/recovery.test.ts')) files.set('tests/db/recovery.test.ts', []);
  return {
    reason: 'failed', unhandledErrors: extra.unhandled ?? [], passed: extra.passed ?? tests.filter(t => !t.errors?.length).length,
    modules: [...files].map(([file, list], index) => {
      const failed = list.filter(t => t.errors?.length);
      const suites = new Map<string, string[]>();
      for (const t of failed) for (const s of t.suites ?? []) suites.set(s, []);
      if (file === 'tests/db/recovery.test.ts') for (const [name, errors] of Object.entries(extra.suiteErrors ?? {})) suites.set(name, errors);
      return { file, state: failed.length || suites.size || (index === 0 && extra.moduleErrors) ? 'failed' : 'passed', errors: index === 0 ? extra.moduleErrors ?? [] : [],
        suites: [...suites].map(([fullName, errors]) => ({ fullName, errors })),
        tests: failed.map(t => ({ fullName: [...(t.suites ?? []), t.name].join(' > '), suites: t.suites ?? [], errors: t.errors! })) };
    }),
  };
}
const SUITE = 'Task 23.3: capacity against the free-tier budgets';
const CAPACITY = { file: 'tests/db/capacity.test.ts', name: 'measures database growth, invocations and egress over accelerated boundaries with the real worker', suites: [SUITE] };
const BUDGET_FAILURES = ['database at 90 days, mixed schedules: expected 1.781 to be less than 1', 'database after one year, new-character schedule: expected 2.274 to be less than 1'];
/**
 * A fixture known-blocker list (Task 23.8): the mechanism keeps its tests now that the gate's own list is empty. It has the shape
 * the retired database-budget blocker had: a named budget check of the capacity case, with a finite measured share of at least 1.
 */
const FIXTURE_BLOCKERS = [{
  id: 'fixture-budget',
  name: 'fixture budget',
  owner: 'Task F (a fixture owner)',
  file: 'tests/db/capacity.test.ts',
  test: /measures database growth/,
  matches(message: string) {
    const share = /^(?:AssertionError: )?database (?:at 90 days|after one year), [^:]+: expected (\S+) to be less than 1$/.exec(message)?.[1];
    const value = share === undefined ? NaN : Number(share);
    return Number.isFinite(value) && value >= 1;
  },
  evidence: 'a fixture evidence section',
}];

/** A Playwright JSON report: the failed tests and their error messages (one test per entry). */
function browserReport(failed: string[][]) {
  return { stats: { expected: 10, unexpected: failed.length }, suites: [{ title: 'x.spec.ts', specs: failed.map((errors, i) => ({ title: `case ${i}`,
    tests: [{ projectName: 'desktop', status: 'unexpected', results: [{ status: 'failed', errors: errors.map(message => ({ message })) }] }] })) }] };
}
const HOST = `${HOST_FAULT_MARKER} 1 request failed in the host's network stack (net::ERR_NO_BUFFER_SPACE for http://127.0.0.1:3200/_next/static/chunks/a.js).`;

/** A fake runner: exit codes by step id (0 when absent; a list is used up call by call), a stable Edge unless told otherwise. */
function fakeIo(options: { codes?: Record<string, number | number[]>; reports?: unknown[]; browserReports?: Record<string, unknown[]>;
  starts?: (string | null)[]; edge?: { ok: boolean; note?: string; tolerated?: { count: number; examples: string[] };
    unavailable?: { count: number; examples: string[] } }[]; excluded?: number | null } = {}) {
  const ran: string[] = [];
  const counted: string[] = [];
  const codeOf = (id: string) => { const c = options.codes?.[id]; return Array.isArray(c) ? c.shift() ?? 0 : c ?? 0; };
  const starts = [...(options.starts ?? [])];
  const reports = [...(options.reports ?? [dbReport([{ name: 'ok' }])])];
  const edges = [...(options.edge ?? [])];
  let started = '2026-10-19T14:23:38.1Z';
  return {
    ran,
    counted,
    io: {
      exec: async (step: Step) => { ran.push(step.id); return codeOf(step.id); },
      countExcluded: async (step: Step) => { counted.push(step.id); return options.excluded === undefined ? 150 : options.excluded; },
      settleEdge: async () => { ran.push('settle'); const e = edges.shift() ?? { ok: true };
        return { ok: e.ok, startedAt: started, recreated: false, files: 40, waitedMs: 30_000, note: e.note, ...(e.tolerated ? { tolerated: e.tolerated } : {}),
          ...(e.unavailable ? { unavailable: e.unavailable } : {}) }; },
      edgeStartedAt: () => { const next = starts.shift(); if (next !== undefined && next !== null) started = next; return started; },
      readDbReport: () => reports.shift() ?? null,
      readBrowserReport: (step: Step) => options.browserReports?.[step.id]?.shift() ?? null,
      log: () => undefined,
    },
  };
}

describe('the gate steps', () => {
  it('follow the approved safe order of docs/operations/verification-gates.md, one after another', () => {
    expect(gateSteps().map(step => step.id)).toEqual(ORDER);
    const doc = readFileSync('docs/operations/verification-gates.md', 'utf8').replace(/\r\n/g, '\n');
    // The approved guide (Avi, 2026-10-14) numbers the steps under "Safe order in one worktree"; each gate step is written
    // there as `guide`, in the same order.
    const order = /## Safe order in one worktree\n([\s\S]*?)\n## /.exec(doc)?.[1] ?? '';
    expect(order).toMatch(/^1\. /m);
    const positions = gateSteps().filter(step => step.guide).map(step => [step.guide!, order.indexOf(step.guide!)] as const);
    expect(positions.map(([guide]) => guide)).toEqual(['npm test', 'npm run typecheck', 'node assets/source/build-assets.mjs --check',
      'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 npm run build', 'npm run verify:static -- --origin http://127.0.0.1:54321',
      'npx playwright test', 'CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true',
      'npm run verify:static -- .next/browser-test', 'PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test', 'git diff --check']);
    for (const [guide, at] of positions) expect(at, guide).toBeGreaterThanOrEqual(0);
    expect(positions.map(([, at]) => at)).toEqual([...positions.map(([, at]) => at)].sort((a, b) => a - b));
    // The database tests follow the guide's own rule: alone (after the builds and scans, before any browser step), with the
    // Edge container's start time compared before and after.
    const rules = /## Database tests and the local Edge runtime\n([\s\S]*?)\n## /.exec(doc)?.[1] ?? '';
    expect(rules).toContain('Run `npm run test:db` only while nothing else builds, runs a browser suite or edits files');
    expect(rules).toContain("docker inspect -f '{{.State.StartedAt}}' supabase_edge_runtime_Cloudiator");
    expect(ORDER.indexOf('db')).toBe(ORDER.indexOf('static') + 2);
    // Avi's 2026-10-19 extension of that section describes this gate's Edge step and its single database rerun.
    expect(rules).toContain("Extended with Avi's approval on 2026-10-19 (Task 23.6): the last-access refresh before the database tests.");
    expect(rules).toMatch(/`npm run verify` \(`scripts\/verify\.mjs`\)/);
    for (const phrase of ['FILE_FLAG_OPEN_REPARSE_POINT', 'skipped and never descended into', 'must lie under the resolved `supabase/functions`',
      'fails the Edge step as an infrastructure fault', 'repeated at most once', 'no browser step is']) expect(rules, phrase).toContain(phrase);
    // Task 24.0: the dependency cache's modification times are tolerated and reported; the check holds everywhere else.
    for (const phrase of ['Observed 2026-10-20 (Task 24.0)', 'a modification-time change under `supabase/functions/node_modules` (Deno\'s dependency cache) is tolerated',
      'reported in the Edge step note', 'everywhere else it still fails the step']) expect(rules, phrase).toContain(phrase);
    // Task 24.1 fix round 1 (Minor 3): the history stays; the Task 24.0 limit is marked superseded, then the 24.1 result follows.
    const superseded = 'A cache entry that disappears or cannot be opened during the walk is not covered by this change and still fails the '
      + 'step. *(Superseded by Task 24.1, below: such a cache entry is now tolerated.)*';
    expect(rules).toContain(superseded);
    expect(rules.indexOf(superseded)).toBeLessThan(rules.indexOf('**Tested (Task 24.1, 2026-10-20; scratch folders).**'));
  });

  it('run the capacity case with its budgets enforced, beside the whole database suite', () => {
    const db = byId(gateSteps(), 'db');
    expect(db.display).toBe('CAPACITY_GATE=1 npm run test:db');
    expect(db.env).toMatchObject({ CAPACITY_GATE: '1' });
    expect(db.env?.CLOUDIATOR_GATE_REPORT).toMatch(/db\.json$/);
    expect(db.args).toEqual(expect.arrayContaining(['--reporter=default', expect.stringMatching(/--reporter=.*vitest-gate-reporter\.mjs$/)]));
    expect(db.needs).toEqual(['edge']);
  });

  // Task 24.1 (plan Decision 12): a production export without NEXT_PUBLIC_SUPABASE_URL now fails, so the gate builds `out/`
  // for the local stack's API origin (supabase/config.toml's port, as the Playwright config uses) and its scan requires
  // exactly that origin in connect-src.
  it('build the production export for the local stack\'s origin, and require that origin in its scan', () => {
    const steps = gateSteps();
    expect(byId(steps, 'build')).toMatchObject({ display: 'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 npm run build',
      env: { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' } });
    expect(byId(steps, 'static').display).toBe('npm run verify:static -- --origin http://127.0.0.1:54321');
    expect(byId(steps, 'static').args?.slice(-3)).toEqual(['--', '--origin', 'http://127.0.0.1:54321']);
    expect(readFileSync('supabase/config.toml', 'utf8')).toMatch(/^\[api\][^[]*?^port = 54321$/ms);
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

  it('take no rerun option: the database rerun is the approved single one, and browser runs are never rerun', () => {
    expect(() => parseOptions(['--db-retries', '3'])).toThrow(/Unknown option --db-retries/);
    expect(parseOptions(['--config', 'x.mjs', '--dev-port', '3200'])).toMatchObject({ config: 'x.mjs', devPort: 3200 });
  });
});

describe('the database result', () => {
  it('passes a clean run', () => {
    expect(classifyDb(dbReport([{ name: 'a' }, { name: 'b' }]))).toMatchObject({ status: 'passed', passed: 2, failed: 0 });
  });

  it('fails a database budget failure: Task 23.7 cleared the budget, so it is no longer a known blocker (Task 23.8)', () => {
    expect(KNOWN_BLOCKERS).toEqual([]);
    for (const errors of [BUDGET_FAILURES, ['database at 90 days, mixed schedules: expected 1 to be less than 1']]) {
      const result = classifyDb(dbReport([{ name: 'a' }, { ...CAPACITY, errors }]));
      expect(result, errors[0]).toMatchObject({ status: 'failed', passed: 1, failed: 1, blocked: [] });
      expect(result.failures).toEqual([expect.objectContaining({ test: expect.stringContaining('measures database growth'), message: errors[0] })]);
    }
  });

  it('names a known blocker when it is the only failure', () => {
    const result = classifyDb(dbReport([{ name: 'a' }, { ...CAPACITY, errors: BUDGET_FAILURES }]), FIXTURE_BLOCKERS);
    expect(result).toMatchObject({ status: 'blocked', passed: 1, failed: 0 });
    expect(result.blocked).toEqual([expect.objectContaining({ blocker: 'fixture-budget' })]);
  });

  it('fails a run with any other failure, also when the blocker fails beside it', () => {
    expect(classifyDb(dbReport([{ name: 'a', errors: ['expected 1 to be 2'] }, { ...CAPACITY, errors: BUDGET_FAILURES }]), FIXTURE_BLOCKERS)).toMatchObject({ status: 'failed', failed: 1 });
    // Another budget in the same capacity case is not the known blocker.
    expect(classifyDb(dbReport([{ ...CAPACITY, errors: [...BUDGET_FAILURES, 'raw egress, 31 days: expected 1.2 to be less than 1'] }]), FIXTURE_BLOCKERS)).toMatchObject({ status: 'failed' });
    // A module that failed outside its tests (an import, a top-level hook) is a failure.
    expect(classifyDb(dbReport([{ ...CAPACITY, errors: BUDGET_FAILURES }], { moduleErrors: ['afterAll hook timed out'] }), FIXTURE_BLOCKERS)).toMatchObject({ status: 'failed' });
    expect(classifyDb(null, FIXTURE_BLOCKERS)).toMatchObject({ status: 'failed' });
  });

  it('fails a describe-level hook failure beside the blocker (its tests are skipped, not failed)', () => {
    const result = classifyDb(dbReport([{ ...CAPACITY, errors: BUDGET_FAILURES }], { suiteErrors: { 'Task 22.2: recovery': ['beforeAll: connection refused'] } }), FIXTURE_BLOCKERS);
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.failures).toEqual([expect.objectContaining({ test: 'Task 22.2: recovery', message: 'beforeAll: connection refused' })]);
    // A failed suite that encloses no blocked test is a failure even without its own errors.
    expect(classifyDb(dbReport([{ ...CAPACITY, errors: BUDGET_FAILURES }], { suiteErrors: { 'an unrelated suite': [] } }), FIXTURE_BLOCKERS)).toMatchObject({ status: 'failed' });
  });

  it('fails an unhandled error beside the blocker', () => {
    const result = classifyDb(dbReport([{ ...CAPACITY, errors: BUDGET_FAILURES }], { unhandled: ['late unhandled failure'] }), FIXTURE_BLOCKERS);
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.failures).toEqual([expect.objectContaining({ test: '(unhandled error)', message: 'late unhandled failure' })]);
  });

  it('counts a failure as the blocker only when the blocker matches every error', () => {
    for (const value of ['NaN', 'Infinity', '0.5', 'undefined']) {
      expect(classifyDb(dbReport([{ ...CAPACITY, errors: [`database at 90 days, mixed schedules: expected ${value} to be less than 1`] }]), FIXTURE_BLOCKERS), value).toMatchObject({ status: 'failed' });
    }
    expect(classifyDb(dbReport([{ ...CAPACITY, errors: ['database at 90 days, mixed schedules: expected 1 to be less than 1'] }]), FIXTURE_BLOCKERS)).toMatchObject({ status: 'blocked' });
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

  it('fails a database budget failure with exit 1, naming the failed check (Task 23.8)', async () => {
    const { io } = fakeIo({ codes: { db: 1 }, reports: [dbReport([{ name: 'a' }, { ...CAPACITY, errors: BUDGET_FAILURES }])] });
    const results = await runGate(gateSteps(), io);
    expect(results.find(r => r.id === 'db')).toMatchObject({ status: 'failed' });
    const summary = summarize(results);
    expect(summary).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(summary.text).toContain('database at 90 days, mixed schedules: expected 1.781 to be less than 1');
    expect(summary.text).not.toContain('Known blocker');
  });

  it('reports a known blocker by name and exits 2 when nothing else failed', async () => {
    const { io } = fakeIo({ codes: { db: 1 }, reports: [dbReport([{ name: 'a' }, { ...CAPACITY, errors: BUDGET_FAILURES }])] });
    const results = await runGate(gateSteps(), io, FIXTURE_BLOCKERS);
    expect(results.find(r => r.id === 'db')).toMatchObject({ status: 'blocked' });
    expect(results.find(r => r.id === 'db')!.note).toContain('known blocker: fixture budget');
    const summary = summarize(results, FIXTURE_BLOCKERS);
    expect(summary).toMatchObject({ status: 'blocked', exitCode: 2 });
    expect(summary.text).toContain('Known blocker (not a pass): fixture budget');
    expect(summary.text).toContain('Task F (a fixture owner)');
  });

  it('exits 1 for a describe-hook failure or an unhandled error beside the blocker', async () => {
    for (const extra of [{ suiteErrors: { 'Task 22.2: recovery': ['beforeAll: connection refused'] } }, { unhandled: ['late unhandled failure'] }]) {
      const { io } = fakeIo({ codes: { db: 1 }, reports: [dbReport([{ ...CAPACITY, errors: BUDGET_FAILURES }], extra)] });
      const results = await runGate(gateSteps(), io, FIXTURE_BLOCKERS);
      expect(results.find(r => r.id === 'db'), JSON.stringify(extra)).toMatchObject({ status: 'failed' });
      expect(summarize(results, FIXTURE_BLOCKERS)).toMatchObject({ status: 'failed', exitCode: 1 });
    }
  });

  it('discards a database run during which the Edge container was recreated, then reruns once on a settled Edge', async () => {
    // The first run starts and ends on different container start times; the rerun is stable.
    const { io, ran } = fakeIo({ starts: ['2026-10-19T14:23:38.1Z', '2026-10-19T14:30:02.5Z', '2026-10-19T14:31:00.0Z', '2026-10-19T14:31:00.0Z'],
      reports: [dbReport([{ name: 'a', errors: ['connection refused'] }]), dbReport([{ name: 'a' }])] });
    const results = await runGate(gateSteps(), io);
    expect(ran.filter(id => id === 'db' || id === 'settle')).toEqual(['settle', 'db', 'settle', 'db']);
    const db = results.find(r => r.id === 'db')!;
    expect(db.status).toBe('passed');
    expect(db.note).toContain('1 run discarded');
    expect(db.note).toContain('14:30:02.5Z');
  });

  it('reruns the database tests exactly once, and calls a twice-recreated Edge an infrastructure fault', async () => {
    const { io, ran } = fakeIo({ starts: ['a', 'b', 'c', 'd', 'e', 'f'], reports: [dbReport([{ name: 'a' }]), dbReport([{ name: 'a' }]), dbReport([{ name: 'a' }])] });
    const results = await runGate(gateSteps(), io);
    expect(ran.filter(id => id === 'db')).toEqual(['db', 'db']);
    expect(results.find(r => r.id === 'db')).toMatchObject({ status: 'infrastructure' });
    expect(summarize(results)).toMatchObject({ status: 'failed', exitCode: 1 });
  });

  it('passes the Edge step when only the dependency cache changed during the refresh, and reports it in the step note (Task 24.0)', async () => {
    const tolerated = { count: 7, examples: ['node_modules/.deno', 'node_modules/.deno/@supabase'] };
    const { io, ran } = fakeIo({ edge: [{ ok: true, tolerated }] });
    const results = await runGate(gateSteps(), io);
    expect(ran).toContain('db');
    const edge = results.find(r => r.id === 'edge')!;
    expect(edge.status).toBe('passed');
    expect(edge.note).toContain('modification time changed under the dependency cache (tolerated) on 7 entries: node_modules/.deno, node_modules/.deno/@supabase, …');
    expect(summarize(results)).toMatchObject({ status: 'passed', exitCode: 0 });
    // All entries listed: no ellipsis.
    const all = await runGate(gateSteps(), fakeIo({ edge: [{ ok: true, tolerated: { count: 1, examples: ['node_modules/.deno'] } }] }).io);
    expect(all.find(r => r.id === 'edge')!.note).toContain('on 1 entry: node_modules/.deno;');
    expect(all.find(r => r.id === 'edge')!.note).not.toContain('…');
  });

  it('passes the Edge step when cache entries vanished or could not be opened, and says which (Task 24.1)', async () => {
    const unavailable = { count: 2, examples: ['node_modules/.deno/a', 'node_modules/.deno/b'] };
    const results = await runGate(gateSteps(), fakeIo({ edge: [{ ok: true, unavailable }] }).io);
    const edge = results.find(r => r.id === 'edge')!;
    expect(edge.status).toBe('passed');
    expect(edge.note).toContain('dependency cache entries gone or unreadable during the walk (tolerated) on 2 entries: node_modules/.deno/a, node_modules/.deno/b;');
    expect(edge.note).not.toContain('modification time changed');
    expect(summarize(results)).toMatchObject({ status: 'passed', exitCode: 0 });
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
  it('fails on any failed test, and labels one beside a host network fault with its own first error', () => {
    expect(GATE_MARKER).toBe(HOST_FAULT_MARKER);
    expect(classifyBrowser(browserReport([]))).toMatchObject({ status: 'passed' });
    const labelled = classifyBrowser(browserReport([['Error: expect(locator).toBeVisible() failed', HOST]]));
    expect(labelled).toMatchObject({ status: 'failed', failed: 1 });
    expect(labelled.failures).toEqual([expect.objectContaining({ message: 'Error: expect(locator).toBeVisible() failed',
      hostFault: expect.stringContaining('net::ERR_NO_BUFFER_SPACE') })]);
    expect(classifyBrowser(browserReport([[HOST], ['Error: expect(received).toBe(expected)']]))).toMatchObject({ status: 'failed', failed: 2 });
    expect(classifyBrowser(null)).toMatchObject({ status: 'failed' });
  });

  it('is never rerun: a probable host fault still fails the gate, named in the summary with the original error', async () => {
    const { io, ran } = fakeIo({ codes: { production: [1, 0] }, browserReports: { production: [browserReport([['Error: expect(locator).toBeVisible() failed', HOST]]), browserReport([])] } });
    const results = await runGate(gateSteps(), io);
    expect(ran.filter(id => id === 'production')).toEqual(['production']);
    expect(results.find(r => r.id === 'production')).toMatchObject({ status: 'failed' });
    const summary = summarize(results);
    expect(summary).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(summary.text).toMatch(/probable host fault \(net::ERR_NO_BUFFER_SPACE[^)]*\).*expect\(locator\)\.toBeVisible\(\) failed/);
  });

  it('is a failure, never rerun, when a test failed for any other reason', async () => {
    const { io, ran } = fakeIo({ codes: { browser: 1 }, browserReports: { browser: [browserReport([['Error: Timeout 45000ms exceeded.']])] } });
    const results = await runGate(gateSteps(), io);
    expect(ran.filter(id => id === 'browser')).toEqual(['browser']);
    expect(results.find(r => r.id === 'browser')).toMatchObject({ status: 'failed' });
  });
});

// Task 24.0c, the controller's CI exception (2026-10-20): on the GPU-less GitHub runner (checks.yml sets CLOUDIATOR_CI_RENDER
// =exclude) the development suite leaves out the tests tagged @render (playwright.config.ts). The gate never does this
// silently: the browser step's summary line says how many it left out. Locally nothing is left out, and the production gate
// never leaves anything out.
describe('the CI render exclusion', () => {
  it('runs the development suite with the exclusion only when asked, and the production gate never', () => {
    const plain = gateSteps();
    expect(byId(plain, 'browser').env?.[CI_RENDER_ENV]).toBeUndefined();
    expect(byId(plain, 'browser').unset).toContain(CI_RENDER_ENV);
    expect(byId(plain, 'browser').exclude).toBeUndefined();
    const ci = gateSteps({ excludeRender: true, config: 'node_modules/.cache/pw-x.config.mjs' });
    expect(byId(ci, 'browser').env).toMatchObject({ [CI_RENDER_ENV]: 'exclude' });
    expect(byId(ci, 'browser').unset ?? []).not.toContain(CI_RENDER_ENV);
    // The count lists the tagged tests of the same configuration, without running them (no web server).
    expect(byId(ci, 'browser').exclude).toEqual({ tag: RENDER_TAG, listArgs: ['node_modules/@playwright/test/cli.js', 'test', '--config',
      'node_modules/.cache/pw-x.config.mjs', '--list', '--reporter=json', '--grep', RENDER_PATTERN.source] });
    for (const steps of [plain, ci]) {
      expect(byId(steps, 'production').exclude).toBeUndefined();
      expect(byId(steps, 'production').unset).toContain(CI_RENDER_ENV);
      expect(childEnv(byId(steps, 'production'), { [CI_RENDER_ENV]: 'exclude' })[CI_RENDER_ENV]).toBeUndefined();
    }
    expect(childEnv(byId(plain, 'browser'), { [CI_RENDER_ENV]: 'exclude' })[CI_RENDER_ENV]).toBeUndefined();
    expect(childEnv(byId(ci, 'browser'), {})[CI_RENDER_ENV]).toBe('exclude');
  });

  it("names how many render-bound tests it left out on the browser step's summary line", async () => {
    const { io, ran, counted } = fakeIo({ excluded: 150 });
    const results = await runGate(gateSteps({ excludeRender: true }), io);
    expect(ran).toEqual(['unit', 'typecheck', 'assets', 'build', 'static', 'settle', 'db', 'browser', 'browser-build', 'browser-static', 'production', 'diff']);
    expect(counted).toEqual(['browser']);
    const browser = results.find(r => r.id === 'browser')!;
    expect(browser).toMatchObject({ status: 'passed', note: 'excluded 150 render-bound tests (CI, no GPU)', excluded: { tag: RENDER_TAG, count: 150 } });
    const summary = summarize(results);
    expect(summary).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(summary.text.split('\n').find(line => /^\s+passed\s+browser\s/.test(line))).toMatch(/npx playwright test {2}\[\d+ s\] {2}excluded 150 render-bound tests \(CI, no GPU\)$/);
    expect(results.find(r => r.id === 'production')).toMatchObject({ note: '' });
    expect(results.find(r => r.id === 'production')).not.toHaveProperty('excluded');
  });

  it('still names the exclusion beside a failure, and when the count is not known', async () => {
    const failed = fakeIo({ excluded: 1, codes: { browser: 1 }, browserReports: { browser: [browserReport([['Error: expect(received).toBe(expected)']])] } });
    const results = await runGate(gateSteps({ excludeRender: true }), failed.io);
    expect(results.find(r => r.id === 'browser')).toMatchObject({ status: 'failed', note: 'exit 1; 1 failed; excluded 1 render-bound test (CI, no GPU)' });
    const unknown = fakeIo({ excluded: null });
    const counted = await runGate(gateSteps({ excludeRender: true }), unknown.io);
    expect(counted.find(r => r.id === 'browser')).toMatchObject({ status: 'passed', note: 'excluded the render-bound tests (CI, no GPU; count unavailable)',
      excluded: { tag: RENDER_TAG, count: null } });
  });

  it('leaves the gate as it was without the exclusion: nothing counted, nothing said', async () => {
    const { io, counted } = fakeIo();
    const results = await runGate(gateSteps(), io);
    expect(counted).toEqual([]);
    expect(results.find(r => r.id === 'browser')).toMatchObject({ status: 'passed', note: '' });
    expect(results.find(r => r.id === 'browser')).not.toHaveProperty('excluded');
    expect(summarize(results).text).not.toContain('render-bound');
  });

  // The real count: Playwright lists the repository's tagged tests (no test runs, no web server), with the step's environment
  // but never the exclusion itself, so it counts what the run leaves out. CI sets CLOUDIATOR_CI_RENDER for this very run.
  it('counts the tagged tests the development suite leaves out, with the repository configuration', () => {
    const count = countExcluded(byId(gateSteps({ excludeRender: true }), 'browser'));
    expect(count).toBeGreaterThan(0);
    expect(count! % 2, 'each tagged test in both projects').toBe(0);
    expect(countExcluded(byId(gateSteps(), 'browser'))).toBeNull();
  }, 60_000);

  it("counts the tests of a Playwright listing, in every project and nested suite", () => {
    const spec = (title: string, projects: string[]) => ({ title, tags: ['render'], tests: projects.map(projectName => ({ projectName, results: [] })) });
    expect(countListed({ suites: [{ title: 'a.spec.ts', specs: [spec('one', ['desktop', 'mobile'])],
      suites: [{ title: 'a describe', specs: [spec('two', ['desktop', 'mobile']), spec('three', ['desktop'])] }] }, { title: 'b.spec.ts', specs: [] }] })).toBe(5);
    expect(countListed({ suites: [] })).toBe(0);
    expect(countListed(null)).toBeNull();
    expect(countListed({ errors: [{ message: 'x' }] })).toBeNull();
  });
});

// Each refresh is a PowerShell process (about 0.4 s alone); the cases with up to seven walks took 2.7 s alone and exceeded the
// default 5 s once under the full unit suite's load (observed 2026-10-21, Task 24.1 fix round 1), so the block allows 30 s.
describe('the Edge access-time refresh (C22)', { timeout: 30_000 }, () => {
  const windows = process.platform === 'win32';
  /** A scratch tree under the test temp folder: root/{deno.json, _shared/domain/types.ts} and `outside/` beside it. */
  function scratch() {
    const base = mkdtempSync(join(tmpdir(), 'cloudiator-atime-'));
    const root = join(base, 'functions'), outside = join(base, 'outside');
    mkdirSync(join(root, '_shared', 'domain'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, '_shared', 'domain', 'types.ts'), 'export {};');
    writeFileSync(join(root, 'deno.json'), '{}');
    writeFileSync(join(outside, 'target.ts'), 'export {};');
    const old = new Date('2026-01-01T00:00:00Z');
    const inside = [root, join(root, '_shared'), join(root, '_shared', 'domain'), join(root, '_shared', 'domain', 'types.ts'), join(root, 'deno.json')];
    for (const entry of [...inside, outside, join(outside, 'target.ts')]) utimesSync(entry, old, old);
    return { base, root, outside, inside };
  }

  it.skipIf(!windows)('sets every folder and file access time to now and leaves the modification times', () => {
    const { base, inside } = scratch();
    try {
      const before = inside.map(entry => statSync(entry, { bigint: true }).mtimeNs);
      const started = Date.now();
      expect(refreshAccessTimes(inside[0])).toEqual({ ok: true, count: inside.length, skipped: 0 });
      for (const [i, entry] of inside.entries()) {
        const stat = statSync(entry, { bigint: true });
        expect(Number(stat.atimeNs / 1_000_000n), entry).toBeGreaterThanOrEqual(started - 2_000);
        expect(stat.mtimeNs, entry).toBe(before[i]);
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it.skipIf(!windows)('skips a junction and never touches what it points to', () => {
    const { base, root, outside, inside } = scratch();
    try {
      symlinkSync(outside, join(root, 'linked'), 'junction');
      const target = statSync(join(outside, 'target.ts'), { bigint: true });
      const folder = statSync(outside, { bigint: true });
      expect(refreshAccessTimes(root)).toEqual({ ok: true, count: inside.length, skipped: 1 });
      expect(statSync(join(outside, 'target.ts'), { bigint: true }).atimeNs).toBe(target.atimeNs);
      expect(statSync(outside, { bigint: true }).atimeNs).toBe(folder.atimeNs);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it.skipIf(!windows)('reports a failed refresh with its reason, and the Edge preparation fails with it', () => {
    const missing = join(tmpdir(), 'cloudiator-atime-missing-folder');
    const refresh = refreshAccessTimes(missing);
    expect(refresh).toMatchObject({ ok: false, reason: expect.stringMatching(/\S/) });
    expect(prepareEdge(missing)).toMatchObject({ ok: false, reason: expect.stringContaining('access-time refresh failed') });
  });

  it('prepares an Edge folder: refreshed (on Windows) and read', () => {
    const { base, root, inside } = scratch();
    try {
      expect(prepareEdge(root)).toMatchObject({ ok: true, files: 2, ...(windows ? { refreshed: inside.length, skipped: 0 } : {}) });
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // Task 24.0 (Decision 10). Observed 2026-10-20: a gate run failed its Edge step because the modification time of
  // `supabase/functions/node_modules/.deno` (Deno's dependency cache, `nodeModulesDir: "auto"`) changed during the walk, a
  // concurrent write by a writer that was never identified. `concurrentWrite` is the refresh's test seam: the walk changes that
  // entry's modification time right after setting its access time, as a concurrent writer would.
  /** The scratch tree plus a dependency cache like Deno's: root/node_modules/.deno/pkg/index.js. */
  function withCache() {
    const tree = scratch();
    const cache = [join(tree.root, 'node_modules'), join(tree.root, 'node_modules', '.deno'), join(tree.root, 'node_modules', '.deno', 'pkg'),
      join(tree.root, 'node_modules', '.deno', 'pkg', 'index.js')];
    mkdirSync(cache[2], { recursive: true });
    writeFileSync(cache[3], 'export {};');
    const old = new Date('2026-01-01T00:00:00Z');
    for (const entry of [...cache, tree.root]) utimesSync(entry, old, old);
    return { ...tree, cache, entries: [...tree.inside, ...cache], old };
  }

  it.skipIf(!windows)('tolerates a mid-walk modification-time change under node_modules/.deno, refreshes its access times and reports it', () => {
    const { base, root, entries, cache, old } = withCache();
    try {
      const started = Date.now();
      const refresh = refreshAccessTimes(root, { concurrentWrite: 'node_modules/.deno' });
      expect(refresh).toEqual({ ok: true, count: entries.length, skipped: 0, tolerated: { count: 1, examples: ['node_modules/.deno'] } });
      // The change did happen; the access time of the changed folder and of everything below it was still refreshed.
      expect(statSync(cache[1], { bigint: true }).mtimeMs).toBeGreaterThan(BigInt(old.getTime()));
      for (const entry of cache) expect(Number(statSync(entry, { bigint: true }).atimeNs / 1_000_000n), entry).toBeGreaterThanOrEqual(started - 2_000);
      // The Edge preparation passes (it reads every file) and carries the report.
      expect(prepareEdge(root, { concurrentWrite: 'node_modules/.deno' })).toMatchObject({ ok: true, files: 3, refreshed: entries.length, skipped: 0,
        tolerated: { count: 1, examples: ['node_modules/.deno'] } });
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it.skipIf(!windows)('tolerates a change to the cache folder itself and to a file inside it', () => {
    const { base, root, entries } = withCache();
    try {
      for (const entry of ['node_modules', 'node_modules/.deno/pkg/index.js']) {
        expect(refreshAccessTimes(root, { concurrentWrite: entry }), entry).toEqual({ ok: true, count: entries.length, skipped: 0, tolerated: { count: 1, examples: [entry] } });
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it.skipIf(!windows)('still fails a mid-walk modification-time change anywhere else, naming the entry', () => {
    const { base, root } = withCache();
    try {
      // Look-alikes of the cache: a nested node_modules, and a sibling whose name only starts like it.
      mkdirSync(join(root, '_shared', 'node_modules'));
      mkdirSync(join(root, 'node_modules_old'));
      const old = new Date('2026-01-01T00:00:00Z');
      for (const entry of [join(root, '_shared', 'node_modules'), join(root, 'node_modules_old'), join(root, '_shared'), root]) utimesSync(entry, old, old);
      for (const entry of ['_shared', '_shared/domain', '_shared/domain/types.ts', 'deno.json', '_shared/node_modules', 'node_modules_old']) {
        // The temp folder may be spelled with its 8.3 short name; compare the entry's own tail.
        const refresh = refreshAccessTimes(root, { concurrentWrite: entry });
        expect(refresh, entry).toMatchObject({ ok: false, reason: expect.stringMatching(/^modification time changed: /) });
        expect((refresh as { reason: string }).reason.endsWith(`\\${entry.replace(/\//g, '\\')}`), entry).toBe(true);
      }
      expect(prepareEdge(root, { concurrentWrite: '_shared/domain' })).toMatchObject({ ok: false, files: 0,
        reason: expect.stringContaining('access-time refresh failed: modification time changed: ') });
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it.skipIf(!windows)('reports no tolerated change when nothing changed during the walk', () => {
    const { base, root, entries } = withCache();
    try {
      expect(refreshAccessTimes(root)).toEqual({ ok: true, count: entries.length, skipped: 0 });
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // Task 24.1 (24.0 review M1): the cache exception is about a folder named node_modules, never about what a link of that
  // name points to. A junction named node_modules directly under the root is skipped like any link, and its target is
  // untouched, also when the test seam would change it.
  it.skipIf(!windows)('still skips a junction named node_modules under the root, tolerating nothing and leaving its target untouched', () => {
    const { base, root, outside, inside } = scratch();
    try {
      symlinkSync(outside, join(root, 'node_modules'), 'junction');
      const target = statSync(join(outside, 'target.ts'), { bigint: true });
      const folder = statSync(outside, { bigint: true });
      for (const options of [{}, { concurrentWrite: 'node_modules' }, { concurrentWrite: 'node_modules/target.ts' }, { concurrentRemove: 'node_modules' }]) {
        expect(refreshAccessTimes(root, options), JSON.stringify(options)).toEqual({ ok: true, count: inside.length, skipped: 1 });
      }
      for (const [entry, before] of [[join(outside, 'target.ts'), target], [outside, folder]] as const) {
        const after = statSync(entry, { bigint: true });
        expect(after.atimeNs, entry).toBe(before.atimeNs);
        expect(after.mtimeNs, entry).toBe(before.mtimeNs);
      }
      expect(prepareEdge(root)).toMatchObject({ ok: true, files: 2, refreshed: inside.length, skipped: 1 });
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // Task 24.1 (24.0 review M6): a cache entry can also disappear (or fail to open) while the walk passes, as when Deno
  // replaces a package. Under node_modules that is tolerated and reported; anywhere else it fails the refresh, naming the
  // entry. `concurrentRemove` is the test seam: the walk removes that entry (a folder with everything in it) right before
  // opening it, as a concurrent writer would. An entry that exists but cannot be opened takes the same path (any failure to
  // open it, read it back or list it); it is not simulated separately.
  it.skipIf(!windows)('tolerates a cache entry that vanishes mid-walk, and reports it', () => {
    for (const [entry, gone] of [['node_modules/.deno/pkg/index.js', 1], ['node_modules/.deno', 3], ['node_modules', 4]] as const) {
      const { base, root, entries } = withCache();
      try {
        expect(refreshAccessTimes(root, { concurrentRemove: entry }), entry).toEqual({ ok: true, count: entries.length - gone, skipped: 0,
          unavailable: { count: 1, examples: [entry] } });
      } finally { rmSync(base, { recursive: true, force: true }); }
    }
    const { base, root, entries } = withCache();
    try {
      expect(prepareEdge(root, { concurrentRemove: 'node_modules/.deno/pkg/index.js' })).toMatchObject({ ok: true, files: 2,
        refreshed: entries.length - 1, skipped: 0, unavailable: { count: 1, examples: ['node_modules/.deno/pkg/index.js'] } });
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // The pre-read is the preparation's second walk: the same rule holds there. `read` is its test seam (default readFileSync).
  it('tolerates a cache file that vanishes or cannot be read during the pre-read, and fails any other, naming it', () => {
    const { base, root } = withCache();
    try {
      const failing = (tail: string, code: string) => (path: string) => {
        if (path.replace(/\\/g, '/').endsWith(tail)) throw Object.assign(new Error(`${code}: simulated`), { code });
        return readFileSync(path);
      };
      expect(prepareEdge(root, { read: failing('node_modules/.deno/pkg/index.js', 'ENOENT') })).toMatchObject({ ok: true, files: 2,
        unavailable: { count: 1, examples: ['node_modules/.deno/pkg/index.js'] } });
      expect(prepareEdge(root, { read: failing('_shared/domain/types.ts', 'EBUSY') })).toEqual({ ok: false, files: 0,
        reason: 'pre-read failed: _shared/domain/types.ts: EBUSY' });
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it.skipIf(!windows)('still fails an entry that vanishes mid-walk anywhere else, naming it', () => {
    for (const entry of ['_shared', '_shared/domain', '_shared/domain/types.ts', 'deno.json', '_shared/node_modules', 'node_modules_old']) {
      const { base, root, old } = withCache();
      try {
        mkdirSync(join(root, '_shared', 'node_modules'));
        mkdirSync(join(root, 'node_modules_old'));
        for (const folder of [join(root, '_shared', 'node_modules'), join(root, 'node_modules_old'), join(root, '_shared'), root]) utimesSync(folder, old, old);
        const refresh = refreshAccessTimes(root, { concurrentRemove: entry }) as { ok: boolean; reason: string };
        expect(refresh, entry).toMatchObject({ ok: false, reason: expect.stringMatching(/^cannot open: /) });
        // The temp folder may be spelled with its 8.3 short name; compare the entry's own tail.
        expect(refresh.reason.includes(`\\${entry.replace(/\//g, '\\')}: `), refresh.reason).toBe(true);
      } finally { rmSync(base, { recursive: true, force: true }); }
    }
    const { base, root } = withCache();
    try {
      expect(prepareEdge(root, { concurrentRemove: 'deno.json' })).toMatchObject({ ok: false, files: 0,
        reason: expect.stringContaining('access-time refresh failed: cannot open: ') });
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
