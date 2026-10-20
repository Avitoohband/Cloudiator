/**
 * The release gate behind `npm run verify` (Task 23.6, R3). It runs every gate of docs/operations/verification-gates.md in
 * that order, one after another in this worktree, so a build never shares an output directory with a running browser suite
 * and nothing builds, browses or edits while the database tests run:
 *   1. `npm test`, `npm run typecheck`, the asset check;
 *   2. `npm run build` (which also writes `_headers`) for the local stack's API origin, `npm run verify:static` requiring it;
 *   3. the Edge runtime settled (C22, below), then `CAPACITY_GATE=1 npm run test:db`;
 *   4. the development browser suite;
 *   5. the isolated production build, its static scan, the production browser gate (CSP violations fail it);
 *   6. `git diff --check`.
 * Every step whose input is valid runs, even after another failed; a step is skipped only when a step it needs did not pass
 * (the scan of a failed build, the browser gate of a failed production build, the database tests on an Edge runtime that
 * does not serve). One summary ends the run. Exit 0: every step passed. Exit 2: the only failures are known blockers, named
 * in the summary (never a pass). Exit 1: anything else.
 *
 * C22 (observed 2026-10-19): NTFS last-access updates are enabled on the development host. Reading Edge source that was not
 * read within about an hour updates its access time, `supabase functions serve` reports a change and recreates the Edge
 * container, and a database run in progress loses requests. Before the database tests this script sets the last-access time
 * of supabase/functions and every folder and file under it to now (Windows; a read alone leaves entries read within the hour
 * unrefreshed), reads every file, waits until the container's start time has been stable for a quiet period and the worker answers again,
 * and compares the start time before and after the run: a changed start time discards the run (an infrastructure fault) and
 * the run is repeated exactly once on a settled runtime. A refresh that fails (Windows) fails the Edge step as an
 * infrastructure fault, with its reason. Links (junctions, symbolic links) are skipped and never followed. System settings
 * are never changed. Task 24.0 (observed 2026-10-20): a modification time that changes under supabase/functions/node_modules
 * (Deno's dependency cache, `nodeModulesDir: "auto"`; the writer was not identified) is tolerated and reported in the Edge
 * step note; the access times there are still refreshed, and the check is unchanged everywhere else. Task 24.1: a cache entry
 * that vanishes or cannot be opened during the refresh or the pre-read is tolerated and reported the same way; anywhere else
 * it fails the Edge step, naming the entry.
 *
 * The database verdict comes from scripts/vitest-gate-reporter.mjs: `blocked` only when every failed test is a named known
 * blocker, every failed suite encloses one and has no error of its own, and the run had no module or unhandled error.
 *
 * C21 triage (2026-10-19): a failed browser test whose context saw a request fail in the host's network stack
 * (tests/browser/host-faults.ts, for example Chrome's net::ERR_NO_BUFFER_SPACE on a static chunk) is labelled a probable
 * host fault in the summary, beside its own first error. It is never rerun, and it fails the gate. Each browser step keeps
 * its own traces under --results (test-results/development, …/production).
 *
 * Options: --config <playwright config> (both browser steps), --dev-port <n>, --static-port <n> (the repository config's
 * ports; defaults 3100 and 4173), --results <dir> (test-results), --json <file> (the results as JSON), --edge-quiet <s> (30),
 * --edge-timeout <s> (300). It prints no credential: the database tests read the local keys in memory (scripts/test-db.mjs).
 * It never starts, stops or resets the local stack: the Edge step fails (an infrastructure fault) when the worker does not
 * answer, and says to start `supabase functions serve`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The words tests/browser/fixtures.ts adds to a failed test whose request failed in the host's network stack (host-faults.ts). */
export const HOST_FAULT_MARKER = 'Probable host fault:';
/** The local stack's API origin (supabase/config.toml `[api] port`, as playwright.config.ts uses): the gate's `out/` build URL. */
export const LOCAL_API_ORIGIN = 'http://127.0.0.1:54321';

/**
 * Failures that are known, named and owned. They make the gate exit 2 (blocked), never 0. Each entry is
 * `{ id, name, owner, file, test: RegExp (the test's full name), matches(firstLineOfError): boolean, evidence }`.
 * Empty: the database budget (owner Task 23.7) was the only one; Task 23.7 cleared it (M21, the 500 MB budget), and Task 23.8
 * retired it, so a capacity budget failure is an ordinary failure (exit 1).
 * @type {readonly { id: string, name: string, owner: string, file: string, test: RegExp, matches: (message: string) => boolean, evidence: string }[]}
 */
export const KNOWN_BLOCKERS = Object.freeze([]);

/**
 * @typedef {{ id: string, title: string, display: string, guide?: string, command?: string, args?: string[], shell?: boolean,
 *   env?: Record<string, string>, unset?: string[], needs?: string[], kind?: 'edge' | 'db' | 'browser', report?: string }} Step
 */

/**
 * The gate's steps, in order. `guide` is the step as the approved docs/operations/verification-gates.md writes it in its
 * "Safe order in one worktree" (the Edge settle and the database tests follow its database rule instead).
 * @param {{ config?: string, devPort?: number, staticPort?: number, dbReport?: string, results?: string }} options
 * @returns {Step[]}
 */
export function gateSteps(options = {}) {
  const config = options.config ? ['--config', options.config] : [];
  const results = options.results ?? 'test-results';
  // Each browser step keeps its own results (traces of failed tests), and writes a JSON report next to its usual output.
  const playwright = (name) => ['node_modules/@playwright/test/cli.js', 'test', ...config, '--output', `${results}/${name}`, '--reporter=list,json'];
  const report = (name) => join(tmpdir(), `cloudiator-verify-${process.pid}-${name}.json`);
  const dbReport = options.dbReport ?? report('db');
  return [
    { id: 'unit', title: 'Unit, backend and asset tests', display: 'npm test', guide: 'npm test', ...npm('test') },
    { id: 'typecheck', title: 'Type checks (TypeScript, Deno)', display: 'npm run typecheck', guide: 'npm run typecheck', ...npm('run', 'typecheck') },
    { id: 'assets', title: 'Asset check', display: 'node assets/source/build-assets.mjs --check', guide: 'node assets/source/build-assets.mjs --check',
      ...node('assets/source/build-assets.mjs', '--check') },
    // Task 24.1 (plan Decision 12): a production export needs its Supabase URL; the gate builds `out/` for the local stack's API
    // origin, and the scan requires exactly that origin in connect-src.
    { id: 'build', title: 'Production build and headers', display: `NEXT_PUBLIC_SUPABASE_URL=${LOCAL_API_ORIGIN} npm run build`,
      guide: `NEXT_PUBLIC_SUPABASE_URL=${LOCAL_API_ORIGIN} npm run build`, ...npm('run', 'build'), env: { NEXT_PUBLIC_SUPABASE_URL: LOCAL_API_ORIGIN } },
    { id: 'static', title: 'Static scan of out/', display: `npm run verify:static -- --origin ${LOCAL_API_ORIGIN}`,
      guide: `npm run verify:static -- --origin ${LOCAL_API_ORIGIN}`, ...npm('run', 'verify:static', '--', '--origin', LOCAL_API_ORIGIN), needs: ['build'] },
    { id: 'edge', title: 'Edge runtime settled (C22)', display: 'pre-read supabase/functions, wait for a stable Edge container', kind: 'edge' },
    { id: 'db', title: 'Database, Auth and Edge tests with the capacity gate', display: 'CAPACITY_GATE=1 npm run test:db', kind: 'db', report: dbReport,
      ...node('scripts/test-db.mjs', '--reporter=default', `--reporter=${resolve('scripts/vitest-gate-reporter.mjs')}`),
      env: { CAPACITY_GATE: '1', CLOUDIATOR_GATE_REPORT: dbReport }, needs: ['edge'] },
    { id: 'browser', title: 'Development browser suite', display: 'npx playwright test', guide: 'npx playwright test', kind: 'browser', report: report('development'),
      ...node(...playwright('development')), env: { PLAYWRIGHT_JSON_OUTPUT_NAME: report('development'),
        ...(options.devPort ? { PLAYWRIGHT_DEV_PORT: String(options.devPort) } : {}) } },
    { id: 'browser-build', title: 'Isolated production build', display: 'CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build',
      guide: 'CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true',
      ...npm('run', 'build'), env: { CLOUDIATOR_BROWSER_TEST: 'true', NEXT_PUBLIC_FIXTURE_ENABLED: 'true' },
      // The documented gate build: no test transport (next.config.ts refuses its key) and no backend URL.
      unset: ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL'] },
    { id: 'browser-static', title: 'Static scan of .next/browser-test', display: 'npm run verify:static -- .next/browser-test',
      guide: 'npm run verify:static -- .next/browser-test',
      ...npm('run', 'verify:static', '--', '.next/browser-test'), needs: ['browser-build'] },
    { id: 'production', title: 'Production browser gate', display: 'PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test',
      guide: 'PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test',
      kind: 'browser', report: report('production'), ...node(...playwright('production')), env: { PLAYWRIGHT_STATIC: 'true',
        PLAYWRIGHT_STATIC_ROOT: '.next/browser-test', PLAYWRIGHT_JSON_OUTPUT_NAME: report('production'),
        ...(options.staticPort ? { PLAYWRIGHT_STATIC_PORT: String(options.staticPort) } : {}) }, needs: ['browser-build'] },
    // core.safecrlf=false only silences the line-ending notices of a Windows checkout (core.autocrlf), which are no finding.
    { id: 'diff', title: 'Whitespace check', display: 'git diff --check', guide: 'git diff --check', command: 'git', args: ['-c', 'core.safecrlf=false', 'diff', '--check'] },
  ];
}
function node(...args) { return { command: process.execPath, args }; }
/** npm through its own CLI script when known (`npm run verify` sets npm_execpath), so no shell is needed on Windows. */
function npm(...args) {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const cli = candidates.find(file => file && /npm-cli\.js$/.test(file) && existsSync(file));
  return cli ? { command: process.execPath, args: [cli, ...args] } : { command: 'npm', args, shell: process.platform === 'win32' };
}

/**
 * A step's child environment: the caller's, without NO_COLOR (Playwright forces FORCE_COLOR=1 on its workers and web
 * server, and Node warns when both are set: C23), without the step's `unset` names, plus the step's `env`.
 * @param {Step} step
 * @param {Record<string, string | undefined>} [base]
 * @returns {Record<string, string | undefined>}
 */
export function childEnv(step, base = process.env) {
  const env = { ...base };
  delete env.NO_COLOR;
  for (const name of step.unset ?? []) delete env[name];
  return { ...env, ...(step.env ?? {}) };
}

/**
 * The database run's verdict from scripts/vitest-gate-reporter.mjs's report: passed, blocked or failed. `blocked` needs all of:
 * every failed test is a named known blocker (each of its errors one that the blocker `matches`); every failed suite encloses
 * a blocked test and has no error of its own (a failed describe-level hook skips its tests, and is a failure); no module error;
 * no unhandled error; a run that ended normally.
 * @param {any} report
 */
export function classifyDb(report, blockers = KNOWN_BLOCKERS) {
  const verdict = { status: 'failed', passed: 0, failed: 0, blocked: [], failures: [] };
  if (!report || !Array.isArray(report.modules)) return { ...verdict, failures: [{ test: '(no report)', message: 'the database run wrote no report' }] };
  verdict.passed = Number(report.passed) || 0;
  for (const message of report.unhandledErrors ?? []) verdict.failures.push({ test: '(unhandled error)', message });
  if (report.reason && report.reason !== 'passed' && report.reason !== 'failed') verdict.failures.push({ test: '(run)', message: `the run ended: ${report.reason}` });
  for (const module of report.modules) {
    const file = String(module.file ?? '').replace(/\\/g, '/');
    for (const message of module.errors ?? []) verdict.failures.push({ file, test: '(module)', message });
    const enclosing = new Set();
    for (const test of module.tests ?? []) {
      const errors = test.errors ?? [];
      const blocker = blockers.find(b => file.endsWith(b.file) && b.test.test(test.fullName) && errors.length > 0 && errors.every(m => b.matches(m)));
      if (blocker) {
        verdict.blocked.push({ blocker: blocker.id, file, test: test.fullName, messages: errors });
        for (const suite of test.suites ?? []) enclosing.add(suite);
      } else { verdict.failed++; verdict.failures.push({ file, test: test.fullName, message: errors[0] ?? '' }); }
    }
    for (const suite of module.suites ?? []) {
      if (suite.errors?.length) verdict.failures.push({ file, test: suite.fullName, message: suite.errors[0] });
      else if (!enclosing.has(suite.fullName) && !(module.tests ?? []).some(t => (t.suites ?? []).includes(suite.fullName))) {
        verdict.failures.push({ file, test: suite.fullName, message: 'the suite failed with no failed test inside it' });
      }
    }
  }
  verdict.status = verdict.failures.length ? 'failed' : verdict.blocked.length ? 'blocked' : 'passed';
  return verdict;
}
const firstLine = (text) => String(text).split('\n')[0].trim();

/**
 * A browser run's verdict from Playwright's JSON report: passed or failed. A failed test whose context saw a host network
 * fault (tests/browser/fixtures.ts adds HOST_FAULT_MARKER) keeps its own first error and is labelled with the fault, as a
 * probable host fault; it is still a failure.
 * @param {any} report
 */
export function classifyBrowser(report) {
  const verdict = { status: 'failed', failed: 0, failures: [] };
  if (!report || !Array.isArray(report.suites)) return { ...verdict, failures: [{ test: '(no report)', message: 'the browser run wrote no report' }] };
  for (const error of report.errors ?? []) verdict.failures.push({ test: '(run)', message: firstLine(error.message ?? error.value ?? '') });
  const walk = (suite, path) => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      if (test.status !== 'unexpected') continue;
      verdict.failed++;
      const messages = (test.results ?? []).flatMap(r => [...(r.errors ?? []), ...(r.error ? [r.error] : [])]).map(e => String(e.message ?? e.value ?? ''));
      const fault = messages.find(m => m.includes(HOST_FAULT_MARKER));
      const own = messages.find(m => !m.includes(HOST_FAULT_MARKER)) ?? '';
      verdict.failures.push({ test: `[${test.projectName}] ${[...path, spec.title].join(' > ')}`, message: firstLine(own),
        ...(fault ? { hostFault: firstLine(fault.slice(fault.indexOf(HOST_FAULT_MARKER) + HOST_FAULT_MARKER.length)) } : {}) });
    }
    for (const child of suite.suites ?? []) walk(child, [...path, child.title]);
  };
  for (const suite of report.suites) walk(suite, [suite.title]);
  verdict.status = verdict.failures.length ? 'failed' : 'passed';
  return verdict;
}

/**
 * Runs `steps` in order through `io` and returns one result per step.
 * io: exec(step) → exit code; settleEdge() → { ok, startedAt, recreated, files, waitedMs, note }; edgeStartedAt() → string|null;
 * readDbReport() → the gate reporter's report or null; readBrowserReport(step) → Playwright's JSON report or null; log(text).
 */
export async function runGate(steps, io, blockers = KNOWN_BLOCKERS) {
  const results = [];
  const statusOf = (id) => results.find(r => r.id === id)?.status;
  for (const [index, step] of steps.entries()) {
    const base = { id: step.id, title: step.title, display: step.display };
    const missing = (step.needs ?? []).find(id => statusOf(id) !== 'passed');
    if (missing) { results.push({ ...base, status: 'skipped', durationMs: 0, note: `not run: ${missing} did not pass` }); continue; }
    io.log(`\n=== [${index + 1}/${steps.length}] ${step.title}: ${step.display}`);
    const started = Date.now();
    if (step.kind === 'edge') {
      const edge = await io.settleEdge();
      results.push({ ...base, status: edge.ok ? 'passed' : 'infrastructure', durationMs: Date.now() - started, note: edgeNote(edge), edge });
      continue;
    }
    if (step.kind === 'db') { results.push({ ...base, ...(await runDatabase(step, io, blockers)), durationMs: Date.now() - started }); continue; }
    if (step.kind === 'browser') { results.push({ ...base, ...(await runBrowser(step, io)), durationMs: Date.now() - started }); continue; }
    const code = await io.exec(step);
    results.push({ ...base, status: code === 0 ? 'passed' : 'failed', durationMs: Date.now() - started, note: code === 0 ? '' : `exit ${code}` });
  }
  return results;
}
/** `N entries: a, b, …` (an ellipsis when there are more entries than examples). */
const entries = ({ count, examples }) => `${count} ${count === 1 ? 'entry' : 'entries'}: ${examples.join(', ')}${count > examples.length ? ', …' : ''}`;
function edgeNote(edge) {
  // A preparation that failed (the access-time refresh) never settled: its reason is the note.
  if (!edge.ok && !edge.waitedMs) return [`container started ${edge.startedAt ?? 'never'}`, edge.note].filter(Boolean).join('; ');
  return [`container started ${edge.startedBefore && edge.startedBefore !== edge.startedAt ? `${edge.startedBefore} -> ` : ''}${edge.startedAt ?? 'never'}`,
    edge.refreshed !== undefined && `access times refreshed on ${edge.refreshed} files and folders (${edge.skipped} links skipped)`,
    // Task 24.0: dependency cache entries that changed during the walk (the writer was not identified) are no fault (Decision
    // 10), but they are said; Task 24.1: so are cache entries that vanished or could not be opened.
    edge.tolerated && `modification time changed under the dependency cache (tolerated) on ${entries(edge.tolerated)}`,
    edge.unavailable && `dependency cache entries gone or unreadable during the walk (tolerated) on ${entries(edge.unavailable)}`,
    `${edge.files} files pre-read`,
    `settled in ${Math.round(edge.waitedMs / 1000)} s`, `recreated while settling: ${edge.recreated ? 'yes' : 'no'}`, edge.note].filter(Boolean).join('; ');
}
/** A browser step: one run, never repeated (fix round 1, Important 3). */
async function runBrowser(step, io) {
  const code = await io.exec(step);
  const browser = classifyBrowser(io.readBrowserReport(step));
  const status = code === 0 ? 'passed' : 'failed';
  const faults = browser.failures.filter(f => f.hostFault).length;
  const note = [code !== 0 && `exit ${code}`, browser.failed && `${browser.failed} failed`,
    faults && `${faults} beside a probable host fault`].filter(Boolean).join('; ');
  return { status, note, browser };
}
/** The approved database rerun (verification-gates.md): exactly once, after the Edge container changed during a run. */
const DB_RERUNS = 1;
async function runDatabase(step, io, blockers) {
  const discarded = [];
  for (let attempt = 0; attempt <= DB_RERUNS; attempt++) {
    if (attempt > 0) {
      io.log(`Edge container recreated during the database run (${discarded.at(-1)}): run discarded, settling the runtime again.`);
      const edge = await io.settleEdge();
      if (!edge.ok) return { status: 'infrastructure', note: `run discarded (Edge recreated: ${discarded.join('; ')}); the runtime did not settle again: ${edgeNote(edge)}` };
    }
    const before = io.edgeStartedAt();
    const code = await io.exec(step);
    const after = io.edgeStartedAt();
    const report = io.readDbReport();
    if (before !== after) { discarded.push(`${before} -> ${after}`); continue; }
    const db = classifyDb(report, blockers);
    const status = code !== 0 && db.status === 'passed' ? 'failed' : db.status;
    const names = [...new Set(db.blocked.map(b => blockers.find(k => k.id === b.blocker)?.name ?? b.blocker))];
    const note = [`${db.passed} passed`, db.failed && `${db.failed} failed`, names.length && `known blocker: ${names.join(', ')}`,
      code !== 0 && status === 'failed' && !db.failed && !db.failures.length && `exit ${code}`,
      `Edge container unchanged (${after})`, discarded.length && `${discarded.length} run discarded (Edge recreated: ${discarded.join('; ')})`]
      .filter(Boolean).join('; ');
    return { status, note, db };
  }
  return { status: 'infrastructure', note: `Edge recreated during every run (${discarded.join('; ')}): no result` };
}

/** The summary text and exit code. */
export function summarize(results, blockers = KNOWN_BLOCKERS) {
  const failed = results.filter(r => r.status === 'failed' || r.status === 'infrastructure');
  const blocked = results.filter(r => r.status === 'blocked');
  const status = failed.length ? 'failed' : blocked.length ? 'blocked' : 'passed';
  const exitCode = { passed: 0, blocked: 2, failed: 1 }[status];
  const lines = ['', 'Release gate summary (npm run verify)'];
  for (const r of results) {
    lines.push(`  ${r.status.padEnd(14)} ${r.id.padEnd(15)} ${r.display}  [${duration(r.durationMs)}]${r.note ? `  ${r.note}` : ''}`);
    for (const f of r.browser?.failures ?? []) {
      lines.push(`      failed: ${f.test}: ${f.hostFault ? `probable host fault (${f.hostFault.replace(/^.*?\((.*)\)\.?$/, '$1')}); ` : ''}${f.message}`);
    }
    for (const f of r.db?.failures ?? []) lines.push(`      failed: ${f.file ? `${f.file.replace(/^.*?(tests\/)/, '$1')} > ` : ''}${f.test}: ${f.message}`);
  }
  const ids = new Set(blocked.flatMap(r => r.db?.blocked.map(b => b.blocker) ?? []));
  for (const blocker of blockers.filter(b => ids.has(b.id))) {
    lines.push(`Known blocker (not a pass): ${blocker.name} (${blocker.file}). Owner: ${blocker.owner}. Evidence: ${blocker.evidence}.`);
  }
  lines.push(`Result: ${status.toUpperCase()}${failed.length ? ` (${failed.length} step${failed.length === 1 ? '' : 's'} failed)` : ''}`
    + `${blocked.length ? `; ${ids.size} known blocker${ids.size === 1 ? '' : 's'}` : ''}; exit ${exitCode}`);
  return { status, exitCode, text: lines.join('\n') };
}
function duration(ms) {
  const s = Math.round((ms ?? 0) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
}

// ---- The real runner: child processes, Docker and the local Edge runtime. ----

const sleep = (ms) => new Promise(done => setTimeout(done, ms));
function exec(step) {
  return new Promise(done => {
    const child = spawn(step.command, step.args, { stdio: 'inherit', env: childEnv(step), shell: step.shell ?? false });
    child.on('error', () => done(127));
    child.on('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}
/** The Supabase project id and the API gateway port, from supabase/config.toml. */
function localStack() {
  const toml = readFileSync('supabase/config.toml', 'utf8');
  const project = /^project_id\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? 'Cloudiator';
  const apiPort = /^\[api\][^[]*?^port\s*=\s*(\d+)/ms.exec(toml)?.[1] ?? '54321';
  return { container: `supabase_edge_runtime_${project}`, probe: `http://127.0.0.1:${apiPort}/functions/v1/game-worker` };
}
function startedAt(container) {
  const result = spawnSync('docker', ['inspect', '-f', '{{.State.StartedAt}}', container], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout.trim() || null : null;
}
/**
 * Sets the last-access time of `directory`, every folder and every file under it to now, leaving every other timestamp as it
 * is (Windows only). NTFS keeps a read's (or a folder listing's) access-time update when the stored time is over an hour old,
 * so reads alone leave entries read within the hour unrefreshed, and they can change during the database run (C22, tested
 * 2026-10-19; a folder listed at 16:10:57 recreated the container).
 * - The handle asks only for FILE_WRITE_ATTRIBUTES, which sharing never blocks (the CLI watcher holds the folders open), with
 *   FILE_FLAG_OPEN_REPARSE_POINT, so it never acts on what a link points to; SetFileTime changes the access time alone.
 * - A link (any reparse point: junction, symbolic link) is skipped and never descended into; every entry must lie under the
 *   resolved root; every entry's modification time is checked unchanged.
 * - The one exception (Task 24.0, Decision 10): the folder `node_modules` directly under the root and everything below it is a
 *   dependency cache whose entries can change during the walk (observed 2026-10-20; the writer was not identified). Its access
 *   times are refreshed like the rest, but a changed modification time there is counted and reported (`tolerated`), not a
 *   failure; and (Task 24.1) so is a cache entry that vanishes or cannot be opened, read back or listed while the walk passes
 *   (`unavailable`; it is not descended into). A nested `node_modules` anywhere else is not the cache, and a link named
 *   `node_modules` is skipped like any link. Elsewhere such an entry fails the refresh, naming it (`cannot open: <path>: …`).
 * Returns { ok: true, count (entries refreshed), skipped, tolerated?: { count, examples }, unavailable?: { count, examples } }
 * (examples: the first five, relative to `directory`), { ok: false, reason } when anything fails, or undefined off Windows.
 * Test seams (the gate passes none), each a path relative to `directory`: `options.concurrentWrite`, whose modification time
 * the walk changes right after setting its access time, and `options.concurrentRemove`, which the walk removes (a folder with
 * everything in it) right before opening it, as a concurrent writer would.
 * @param {string} directory
 * @param {{ concurrentWrite?: string, concurrentRemove?: string }} [options]
 */
export function refreshAccessTimes(directory, options = {}) {
  if (process.platform !== 'win32') return undefined;
  const type = [
    'using System; using System.ComponentModel; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;',
    'public static class CloudiatorAccessTime {',
    '  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
    '  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  static extern bool SetFileTime(SafeFileHandle handle, IntPtr creation, ref long access, IntPtr write);',
    '  public static void Set(string path, long fileTime) {',
    // FILE_WRITE_ATTRIBUTES; share read/write/delete; OPEN_EXISTING; FILE_FLAG_BACKUP_SEMANTICS (folders) | FILE_FLAG_OPEN_REPARSE_POINT.
    '    using (SafeFileHandle handle = CreateFileW(path, 0x100, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {',
    '      if (handle.IsInvalid) throw new Win32Exception();',
    '      if (!SetFileTime(handle, IntPtr.Zero, ref fileTime, IntPtr.Zero)) throw new Win32Exception();',
    '    }',
    '  }',
    '}',
  ].join(' ');
  const literal = directory.replace(/'/g, "''");
  // Test seams (the gate passes none), paths relative to `directory`: the walk changes the first entry's modification time
  // right after setting its access time, and removes the second right before opening it, as a concurrent writer would.
  const quote = (path) => (path ? `'${path.replace(/\//g, '\\').replace(/'/g, "''")}'` : '$null');
  const script = [
    "$ErrorActionPreference='Stop'",
    'try {',
    `  Add-Type -TypeDefinition '${type}'`,
    `  $top = Get-Item -LiteralPath '${literal}' -Force`,
    "  if ($top.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'the folder itself is a link' }",
    "  $root = $top.FullName.TrimEnd('\\')",
    '  $now = [DateTime]::UtcNow.ToFileTimeUtc(); $script:n = 0; $script:skipped = 0; $script:tolerated = @(); $script:unavailable = @()',
    `  $simulate = ${quote(options.concurrentWrite)}`,
    `  $simulateRemove = ${quote(options.concurrentRemove)}`,
    '  function Visit($item) {',
    "    if (-not ($item.FullName -eq $root -or $item.FullName.StartsWith($root + '\\', [StringComparison]::OrdinalIgnoreCase))) { throw ('outside the folder: ' + $item.FullName) }",
    '    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $script:skipped++; return }',
    "    $rel = if ($item.FullName -eq $root) { '' } else { $item.FullName.Substring($root.Length + 1) }",
    // The dependency cache (Deno, nodeModulesDir "auto"): the folder node_modules directly under the root and everything below.
    "    $cache = $rel -eq 'node_modules' -or $rel.StartsWith('node_modules\\', [StringComparison]::OrdinalIgnoreCase)",
    '    $m = $item.LastWriteTimeUtc',
    '    if ($simulateRemove -and $rel -eq $simulateRemove) { Remove-Item -LiteralPath $item.FullName -Recurse -Force }',
    '    try {',
    '      [CloudiatorAccessTime]::Set($item.FullName, $now)',
    '      if ($simulate -and $rel -eq $simulate) { (Get-Item -LiteralPath $item.FullName -Force).LastWriteTimeUtc = $m.AddSeconds(7) }',
    '      $after = (Get-Item -LiteralPath $item.FullName -Force).LastWriteTimeUtc',
    '      $children = if ($item.PSIsContainer) { @(Get-ChildItem -LiteralPath $item.FullName -Force) } else { @() }',
    '    } catch {',
    // A cache entry that vanished or cannot be opened, read back or listed is reported, not a failure (Task 24.1).
    '      if ($cache) { $script:unavailable += $rel; return }',
    "      throw ('cannot open: ' + $item.FullName + ': ' + $_.Exception.GetBaseException().Message)",
    '    }',
    // A changed modification time in the cache is reported, not a failure; everywhere else it stops the refresh.
    '    if ($after -ne $m) {',
    "      if ($cache) { $script:tolerated += $rel } else { throw ('modification time changed: ' + $item.FullName) }",
    '    }',
    '    $script:n++',
    '    foreach ($child in $children) { Visit $child }',
    '  }',
    '  Visit $top',
    '  foreach ($e in @($script:tolerated | Select-Object -First 5)) { "tolerated $e" }',
    '  foreach ($e in @($script:unavailable | Select-Object -First 5)) { "unavailable $e" }',
    '  "ok $($script:n) $($script:skipped) $($script:tolerated.Count) $($script:unavailable.Count)"',
    '} catch { "error $($_.Exception.Message)"; exit 3 }',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = String(result.stdout ?? '').trim().split(/\r?\n/);
  const out = lines.at(-1) ?? '';
  const ok = /^ok (\d+) (\d+) (\d+) (\d+)$/.exec(out);
  if (result.status === 0 && ok) {
    const listed = (kind) => lines.filter(line => line.startsWith(`${kind} `)).map(line => line.slice(kind.length + 1).replace(/\\/g, '/'));
    return { ok: true, count: Number(ok[1]), skipped: Number(ok[2]),
      ...(Number(ok[3]) ? { tolerated: { count: Number(ok[3]), examples: listed('tolerated') } } : {}),
      ...(Number(ok[4]) ? { unavailable: { count: Number(ok[4]), examples: listed('unavailable') } } : {}) };
  }
  const reason = /^error (.*)$/.exec(out)?.[1] ?? (firstLine(result.stderr ?? '') || (result.error ? String(result.error.message) : `PowerShell exited ${result.status}`));
  return { ok: false, reason };
}
/**
 * Prepares the Edge source for a database run: refreshes the access times (Windows) and reads every file. A failed refresh
 * or read makes the preparation fail with its reason. Cache entries that vanished or could not be opened during either walk
 * (Task 24.1) are reported together as `unavailable`.
 * @param {string} directory
 * @param {{ concurrentWrite?: string, concurrentRemove?: string, read?: (path: string) => unknown }} [options] test seams: the
 *   refresh's (refreshAccessTimes) and the reader the pre-read uses (default readFileSync)
 */
export function prepareEdge(directory, options = {}) {
  if (!existsSync(directory)) {
    const refresh = refreshAccessTimes(directory);
    return { ok: false, files: 0, reason: `access-time refresh failed: ${refresh && !refresh.ok ? refresh.reason : `no folder ${directory}`}` };
  }
  const { read: reader = readFileSync, ...refreshOptions } = options;
  const refresh = refreshAccessTimes(directory, refreshOptions);
  if (refresh && !refresh.ok) return { ok: false, files: 0, reason: `access-time refresh failed: ${refresh.reason}` };
  let read;
  try { read = preRead(directory, reader); } catch (error) { return { ok: false, files: 0, reason: `pre-read failed: ${error instanceof Error ? error.message : error}` }; }
  const gone = [...(refresh?.unavailable?.examples ?? []), ...read.unavailable];
  const unavailable = (refresh?.unavailable?.count ?? 0) + read.unavailable.length;
  return { ok: true, files: read.files, ...(refresh ? { refreshed: refresh.count, skipped: refresh.skipped,
    ...(refresh.tolerated ? { tolerated: refresh.tolerated } : {}) } : {}),
    ...(unavailable ? { unavailable: { count: unavailable, examples: gone.slice(0, 5) } } : {}) };
}
/** The dependency cache: `node_modules` directly under the Edge folder and everything below it (`rel` uses `/`). */
const inCache = (rel) => /^node_modules(?:\/|$)/i.test(rel);
/**
 * Reads every file under `directory` (contents discarded; links skipped). A cache file or folder that vanishes or cannot be
 * read during the walk is listed as unavailable (Task 24.1); anywhere else that throws, naming the entry and its error code.
 * @param {string} directory
 * @param {(path: string) => unknown} read
 * @returns {{ files: number, unavailable: string[] }}
 */
function preRead(directory, read) {
  const unavailable = [];
  let files = 0;
  const failed = (rel, error) => {
    if (inCache(rel)) { unavailable.push(rel); return; }
    throw new Error(`${rel}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`);
  };
  const walk = (folder, rel) => {
    let entries;
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch (error) { failed(rel, error); return; }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(join(folder, entry.name), child); continue; }
      try { read(join(folder, entry.name)); files++; } catch (error) { failed(child, error); }
    }
  };
  walk(directory, '');
  return { files, unavailable };
}
/** The worker answers an unauthenticated request with its own refusal (no work, no secret involved). */
async function serves(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const body = await response.json().catch(() => null);
    return response.status === 401 && body?.code === 'unauthenticated';
  } catch { return false; }
}
async function settleEdge({ container, probe }, { quietMs, timeoutMs }) {
  const startedBefore = startedAt(container);
  const prepared = prepareEdge('supabase/functions');
  if (!prepared.ok) return { ok: false, startedBefore, startedAt: startedBefore, recreated: false, files: 0, waitedMs: 0, note: prepared.reason };
  const { refreshed, skipped, files, tolerated, unavailable } = prepared;
  const begin = Date.now();
  let last = startedAt(container), since = Date.now(), changed = false, served = false;
  while (Date.now() - begin < timeoutMs) {
    await sleep(1_000);
    const now = startedAt(container);
    if (now !== last) { changed = true; last = now; since = Date.now(); continue; }
    if (now && Date.now() - since >= quietMs && await serves(probe)) { served = true; break; }
  }
  const serve = 'start `npx supabase functions serve --env-file .env.edge.local` in this worktree once the stack is healthy';
  return { ok: served, startedBefore, startedAt: last, recreated: changed || startedBefore !== last, refreshed, skipped, ...(tolerated ? { tolerated } : {}),
    ...(unavailable ? { unavailable } : {}), files,
    waitedMs: Date.now() - begin,
    note: served ? '' : last ? `the worker did not answer at ${probe} within ${Math.round(timeoutMs / 1000)} s (${serve})` : `no container ${container} (${serve})` };
}

/** The command line options (see the header). There is no rerun option: the database rerun is the approved single one. */
export function parseOptions(argv) {
  const options = { quietMs: 30_000, timeoutMs: 300_000 };
  for (let i = 0; i < argv.length; i++) {
    const value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${argv[i - 1]} needs a value`); return v; };
    const number = (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`Not a number: ${v}`); return n; };
    switch (argv[i]) {
      case '--config': options.config = value(); break;
      case '--dev-port': options.devPort = number(value()); break;
      case '--static-port': options.staticPort = number(value()); break;
      case '--json': options.json = value(); break;
      case '--results': options.results = value(); break;
      case '--edge-quiet': options.quietMs = number(value()) * 1_000; break;
      case '--edge-timeout': options.timeoutMs = number(value()) * 1_000; break;
      default: throw new Error(`Unknown option ${argv[i]}`);
    }
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let options;
  try { options = parseOptions(process.argv.slice(2)); } catch (error) { console.error(String(error instanceof Error ? error.message : error)); process.exit(1); }
  const stack = localStack();
  const steps = gateSteps(options);
  const report = steps.find(step => step.kind === 'db').report;
  const startedAtIso = new Date().toISOString();
  const results = await runGate(steps, {
    exec: (step) => { if (step.report) rmSync(step.report, { force: true }); return exec(step); },
    settleEdge: () => settleEdge(stack, options),
    edgeStartedAt: () => startedAt(stack.container),
    readDbReport: () => { try { return JSON.parse(readFileSync(report, 'utf8')); } catch { return null; } },
    readBrowserReport: (step) => { try { return JSON.parse(readFileSync(step.report, 'utf8')); } catch { return null; } },
    log: (text) => console.log(text),
  });
  rmSync(report, { force: true });
  const summary = summarize(results);
  console.log(summary.text);
  if (options.json) writeFileSync(options.json, `${JSON.stringify({ startedAt: startedAtIso, finishedAt: new Date().toISOString(), status: summary.status,
    exitCode: summary.exitCode, results }, null, 2)}\n`);
  process.exitCode = summary.exitCode;
}
