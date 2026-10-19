/**
 * The release gate behind `npm run verify` (Task 23.6, R3). It runs every gate of docs/operations/verification-gates.md in
 * that order, one after another in this worktree, so a build never shares an output directory with a running browser suite
 * and nothing builds, browses or edits while the database tests run:
 *   1. `npm test`, `npm run typecheck`, the asset check;
 *   2. `npm run build` (which also writes `_headers`), `npm run verify:static`;
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
 * the run is repeated once on a settled runtime. System settings are never changed.
 *
 * C21 triage (2026-10-19): a browser run whose every failed test names a host network fault (tests/browser/host-faults.ts,
 * for example Chrome's net::ERR_NO_BUFFER_SPACE on a static chunk) is discarded the same way and run once more. Any other
 * failure is a failure. Each browser step keeps its own traces under --results (test-results/development, …/production).
 *
 * Options: --config <playwright config> (both browser steps), --dev-port <n>, --static-port <n> (the repository config's
 * ports; defaults 3100 and 4173), --results <dir> (test-results), --json <file> (the results as JSON), --edge-quiet <s> (30),
 * --edge-timeout <s> (300), --db-retries <n> (1, also the browser steps' reruns). It prints no credential: the database
 * tests read the local keys in memory (scripts/test-db.mjs). It never starts, stops or resets the local stack: the Edge step
 * fails (an infrastructure fault) when the worker does not answer, and says to start `supabase functions serve`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The words tests/browser/fixtures.ts adds to a failed test whose request failed in the host's network stack (host-faults.ts). */
export const HOST_FAULT_MARKER = 'Infrastructure fault, not product evidence:';

/** Failures that are known, named and owned. They make the gate exit 2 (blocked), never 0. */
export const KNOWN_BLOCKERS = Object.freeze([Object.freeze({
  id: 'database-budget',
  name: 'database budget',
  owner: 'Task 23.7 (Avi\'s decision A + C + D, 2026-10-19: trims, a 14-day idle pause, a 500 MB budget with a 400 MB warning)',
  file: 'tests/db/capacity.test.ts',
  test: /measures database growth/,
  /** Each failure of the case must be one of its database budget checks; any other failure of it is a real failure. */
  failure: /^AssertionError: database (?:at 90 days|after one year), [^:]+: expected /,
  evidence: 'docs/operations/release-evidence.md, "Lane A: capacity"',
})]);

/**
 * @typedef {{ id: string, title: string, display: string, command?: string, args?: string[], shell?: boolean,
 *   env?: Record<string, string>, unset?: string[], needs?: string[], kind?: 'edge' | 'db' | 'browser', report?: string }} Step
 */

/**
 * The gate's steps, in order. `display` is the command as docs/operations/verification-gates.md writes it.
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
    { id: 'unit', title: 'Unit, backend and asset tests', display: 'npm test', ...npm('test') },
    { id: 'typecheck', title: 'Type checks (TypeScript, Deno)', display: 'npm run typecheck', ...npm('run', 'typecheck') },
    { id: 'assets', title: 'Asset check', display: 'node assets/source/build-assets.mjs --check', ...node('assets/source/build-assets.mjs', '--check') },
    { id: 'build', title: 'Production build and headers', display: 'npm run build', ...npm('run', 'build') },
    { id: 'static', title: 'Static scan of out/', display: 'npm run verify:static', ...npm('run', 'verify:static'), needs: ['build'] },
    { id: 'edge', title: 'Edge runtime settled (C22)', display: 'pre-read supabase/functions, wait for a stable Edge container', kind: 'edge' },
    { id: 'db', title: 'Database, Auth and Edge tests with the capacity gate', display: 'CAPACITY_GATE=1 npm run test:db', kind: 'db', report: dbReport,
      ...node('scripts/test-db.mjs', '--reporter=default', '--reporter=json', `--outputFile.json=${dbReport}`), env: { CAPACITY_GATE: '1' }, needs: ['edge'] },
    { id: 'browser', title: 'Development browser suite', display: 'npx playwright test', kind: 'browser', report: report('development'),
      ...node(...playwright('development')), env: { PLAYWRIGHT_JSON_OUTPUT_NAME: report('development'),
        ...(options.devPort ? { PLAYWRIGHT_DEV_PORT: String(options.devPort) } : {}) } },
    { id: 'browser-build', title: 'Isolated production build', display: 'CLOUDIATOR_BROWSER_TEST=true NEXT_PUBLIC_FIXTURE_ENABLED=true npm run build',
      ...npm('run', 'build'), env: { CLOUDIATOR_BROWSER_TEST: 'true', NEXT_PUBLIC_FIXTURE_ENABLED: 'true' },
      // The documented gate build: no test transport (next.config.ts refuses its key) and no backend URL.
      unset: ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL'] },
    { id: 'browser-static', title: 'Static scan of .next/browser-test', display: 'npm run verify:static -- .next/browser-test',
      ...npm('run', 'verify:static', '--', '.next/browser-test'), needs: ['browser-build'] },
    { id: 'production', title: 'Production browser gate', display: 'PLAYWRIGHT_STATIC=true PLAYWRIGHT_STATIC_ROOT=.next/browser-test npx playwright test',
      kind: 'browser', report: report('production'), ...node(...playwright('production')), env: { PLAYWRIGHT_STATIC: 'true',
        PLAYWRIGHT_STATIC_ROOT: '.next/browser-test', PLAYWRIGHT_JSON_OUTPUT_NAME: report('production'),
        ...(options.staticPort ? { PLAYWRIGHT_STATIC_PORT: String(options.staticPort) } : {}) }, needs: ['browser-build'] },
    // core.safecrlf=false only silences the line-ending notices of a Windows checkout (core.autocrlf), which are no finding.
    { id: 'diff', title: 'Whitespace check', display: 'git diff --check', command: 'git', args: ['-c', 'core.safecrlf=false', 'diff', '--check'] },
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
 * The database run's verdict from vitest's JSON report: passed, blocked (its only failures are known blockers) or failed.
 * @param {any} report
 */
export function classifyDb(report, blockers = KNOWN_BLOCKERS) {
  const verdict = { status: 'failed', passed: 0, failed: 0, blocked: [], failures: [] };
  if (!report || !Array.isArray(report.testResults)) return { ...verdict, failures: [{ test: '(no report)', message: 'the database run wrote no report' }] };
  for (const file of report.testResults) {
    const path = String(file.name ?? '').replace(/\\/g, '/');
    if (file.message) verdict.failures.push({ file: path, test: '(file)', message: firstLine(file.message) });
    for (const test of file.assertionResults ?? []) {
      if (test.status === 'passed') { verdict.passed++; continue; }
      if (test.status !== 'failed') continue;
      const messages = (test.failureMessages ?? []).map(firstLine);
      const blocker = blockers.find(b => path.endsWith(b.file) && b.test.test(test.fullName) && messages.length > 0 && messages.every(m => b.failure.test(m)));
      if (blocker) verdict.blocked.push({ blocker: blocker.id, file: path, test: test.fullName, messages });
      else { verdict.failed++; verdict.failures.push({ file: path, test: test.fullName, message: messages[0] ?? '' }); }
    }
  }
  verdict.status = verdict.failures.length ? 'failed' : verdict.blocked.length ? 'blocked' : report.success === false ? 'failed' : 'passed';
  return verdict;
}
const firstLine = (text) => String(text).split('\n')[0].trim();

/**
 * A browser run's verdict from Playwright's JSON report: passed, infrastructure (every failed test names a host network
 * fault, so the run is no product evidence) or failed.
 * @param {any} report
 */
export function classifyBrowser(report) {
  const verdict = { status: 'failed', failed: 0, faults: [], failures: [] };
  if (!report || !Array.isArray(report.suites)) return { ...verdict, failures: [{ test: '(no report)', message: 'the browser run wrote no report' }] };
  for (const error of report.errors ?? []) verdict.failures.push({ test: '(run)', message: firstLine(error.message ?? error.value ?? '') });
  const walk = (suite, path) => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      if (test.status !== 'unexpected') continue;
      verdict.failed++;
      const messages = (test.results ?? []).flatMap(r => [...(r.errors ?? []), ...(r.error ? [r.error] : [])]).map(e => String(e.message ?? e.value ?? ''));
      const name = `[${test.projectName}] ${[...path, spec.title].join(' > ')}`;
      const fault = messages.find(m => m.includes(HOST_FAULT_MARKER));
      if (fault) verdict.faults.push({ test: name, message: firstLine(fault.slice(fault.indexOf(HOST_FAULT_MARKER))) });
      else verdict.failures.push({ test: name, message: firstLine(messages[0] ?? '') });
    }
    for (const child of suite.suites ?? []) walk(child, [...path, child.title]);
  };
  for (const suite of report.suites) walk(suite, [suite.title]);
  verdict.status = verdict.failures.length ? 'failed' : verdict.faults.length ? 'infrastructure' : 'passed';
  return verdict;
}

/**
 * Runs `steps` in order through `io` and returns one result per step.
 * io: exec(step) → exit code; settleEdge() → { ok, startedAt, recreated, files, waitedMs, note }; edgeStartedAt() → string|null;
 * readDbReport() → the JSON report or null; log(text).
 */
export async function runGate(steps, io, options = {}) {
  const retries = options.dbRetries ?? 1;
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
    if (step.kind === 'db') { results.push({ ...base, ...(await runDatabase(step, io, retries)), durationMs: Date.now() - started }); continue; }
    if (step.kind === 'browser') { results.push({ ...base, ...(await runBrowser(step, io, retries)), durationMs: Date.now() - started }); continue; }
    const code = await io.exec(step);
    results.push({ ...base, status: code === 0 ? 'passed' : 'failed', durationMs: Date.now() - started, note: code === 0 ? '' : `exit ${code}` });
  }
  return results;
}
function edgeNote(edge) {
  return [`container started ${edge.startedBefore && edge.startedBefore !== edge.startedAt ? `${edge.startedBefore} -> ` : ''}${edge.startedAt ?? 'never'}`,
    edge.refreshed !== undefined && `access times refreshed on ${edge.refreshed} files and folders`, `${edge.files} files pre-read`,
    `settled in ${Math.round(edge.waitedMs / 1000)} s`, `recreated while settling: ${edge.recreated ? 'yes' : 'no'}`, edge.note].filter(Boolean).join('; ');
}
/** A browser step, run once more (`retries`) when its only failures are host network faults. */
async function runBrowser(step, io, retries) {
  const discarded = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) io.log(`Host network fault in the browser run (${discarded.at(-1)}): run discarded, running the step once more.`);
    const code = await io.exec(step);
    const browser = classifyBrowser(io.readBrowserReport(step));
    const status = code === 0 ? 'passed' : browser.status === 'passed' ? 'failed' : browser.status;
    if (status === 'infrastructure') { discarded.push(browser.faults.map(f => `${f.test}: ${f.message}`).join(' | ')); continue; }
    const note = [code !== 0 && status === 'failed' && `exit ${code}`, browser.failed && `${browser.failed} failed`,
      discarded.length && `${discarded.length} run discarded (${discarded.join('; ')})`].filter(Boolean).join('; ');
    return { status, note, browser };
  }
  return { status: 'infrastructure', note: `host network faults in every run (${discarded.join('; ')}): no result` };
}
async function runDatabase(step, io, retries) {
  const discarded = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
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
    const db = classifyDb(report);
    const status = code !== 0 && db.status === 'passed' ? 'failed' : db.status;
    const names = [...new Set(db.blocked.map(b => KNOWN_BLOCKERS.find(k => k.id === b.blocker)?.name ?? b.blocker))];
    const note = [`${db.passed} passed`, db.failed && `${db.failed} failed`, names.length && `known blocker: ${names.join(', ')}`,
      code !== 0 && status === 'failed' && !db.failed && !db.failures.length && `exit ${code}`,
      `Edge container unchanged (${after})`, discarded.length && `${discarded.length} run discarded (Edge recreated: ${discarded.join('; ')})`]
      .filter(Boolean).join('; ');
    return { status, note, db };
  }
  return { status: 'infrastructure', note: `Edge recreated during every run (${discarded.join('; ')}): no result` };
}

/** The summary text and exit code. */
export function summarize(results) {
  const failed = results.filter(r => r.status === 'failed' || r.status === 'infrastructure');
  const blocked = results.filter(r => r.status === 'blocked');
  const status = failed.length ? 'failed' : blocked.length ? 'blocked' : 'passed';
  const exitCode = { passed: 0, blocked: 2, failed: 1 }[status];
  const lines = ['', 'Release gate summary (npm run verify)'];
  for (const r of results) {
    lines.push(`  ${r.status.padEnd(14)} ${r.id.padEnd(15)} ${r.display}  [${duration(r.durationMs)}]${r.note ? `  ${r.note}` : ''}`);
    for (const f of r.browser?.failures ?? []) lines.push(`      failed: ${f.test}: ${f.message}`);
    for (const f of r.db?.failures ?? []) lines.push(`      failed: ${f.file ? `${f.file.replace(/^.*?(tests\/)/, '$1')} > ` : ''}${f.test}: ${f.message}`);
  }
  const ids = new Set(blocked.flatMap(r => r.db?.blocked.map(b => b.blocker) ?? []));
  for (const blocker of KNOWN_BLOCKERS.filter(b => ids.has(b.id))) {
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
 * 2026-10-19; a folder listed at 16:10:57 recreated the container). The handle asks only for FILE_WRITE_ATTRIBUTES, which
 * sharing never blocks (the CLI watcher holds the folders open), and SetFileTime changes the access time alone. Returns the
 * number of entries, or undefined elsewhere or when PowerShell fails.
 */
export function refreshAccessTimes(directory) {
  if (process.platform !== 'win32') return undefined;
  const type = [
    'using System; using System.ComponentModel; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;',
    'public static class CloudiatorAccessTime {',
    '  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
    '  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  static extern bool SetFileTime(SafeFileHandle handle, IntPtr creation, ref long access, IntPtr write);',
    '  public static void Set(string path, long fileTime) {',
    // FILE_WRITE_ATTRIBUTES, share read/write/delete, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS (folders too).
    '    using (SafeFileHandle handle = CreateFileW(path, 0x100, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {',
    '      if (handle.IsInvalid) throw new Win32Exception();',
    '      if (!SetFileTime(handle, IntPtr.Zero, ref fileTime, IntPtr.Zero)) throw new Win32Exception();',
    '    }',
    '  }',
    '}',
  ].join(' ');
  const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition '${type}'; $now=[DateTime]::UtcNow.ToFileTimeUtc(); $n=0; `
    + `@(Get-Item -LiteralPath '${directory}' -Force) + @(Get-ChildItem -LiteralPath '${directory}' -Recurse -Force) | ForEach-Object { `
    + `$m=$_.LastWriteTimeUtc; [CloudiatorAccessTime]::Set($_.FullName, $now); `
    + `if ((Get-Item -LiteralPath $_.FullName -Force).LastWriteTimeUtc -ne $m) { throw 'modified' }; $n++ }; $n`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const count = Number(result.stdout.trim());
  return result.status === 0 && Number.isInteger(count) ? count : undefined;
}
/** Reads every file under `directory` (contents discarded) and returns how many. */
function preRead(directory) {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) count += preRead(path);
    else { readFileSync(path); count++; }
  }
  return count;
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
  const present = existsSync('supabase/functions');
  const refreshed = present ? refreshAccessTimes('supabase/functions') : undefined;
  const files = present ? preRead('supabase/functions') : 0;
  const begin = Date.now();
  let last = startedAt(container), since = Date.now(), changed = false, served = false;
  while (Date.now() - begin < timeoutMs) {
    await sleep(1_000);
    const now = startedAt(container);
    if (now !== last) { changed = true; last = now; since = Date.now(); continue; }
    if (now && Date.now() - since >= quietMs && await serves(probe)) { served = true; break; }
  }
  const serve = 'start `npx supabase functions serve --env-file .env.edge.local` in this worktree once the stack is healthy';
  return { ok: served, startedBefore, startedAt: last, recreated: changed || startedBefore !== last, refreshed, files, waitedMs: Date.now() - begin,
    note: served ? '' : last ? `the worker did not answer at ${probe} within ${Math.round(timeoutMs / 1000)} s (${serve})` : `no container ${container} (${serve})` };
}

function parseOptions(argv) {
  const options = { dbRetries: 1, quietMs: 30_000, timeoutMs: 300_000 };
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
      case '--db-retries': options.dbRetries = number(value()); break;
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
  }, options);
  rmSync(report, { force: true });
  const summary = summarize(results);
  console.log(summary.text);
  if (options.json) writeFileSync(options.json, `${JSON.stringify({ startedAt: startedAtIso, finishedAt: new Date().toISOString(), status: summary.status,
    exitCode: summary.exitCode, results: results.map(({ db, ...r }) => ({ ...r, db: db && { ...db, failures: db.failures } })) }, null, 2)}\n`);
  process.exitCode = summary.exitCode;
}
