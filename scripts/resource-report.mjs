import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFailure, Failure, isLoopback, parseDatabaseUrl } from './operator-db.mjs';

// Task 23.3 capacity report (plan 2026-10-19-task-23-release-readiness, Task 23.3; docs/operations/release-evidence.md,
// "Lane A: capacity"):
//   node scripts/resource-report.mjs [--players 50] [--viewers 50] [--slots K]
// Local only. It discovers this checkout's Supabase stack in memory, as scripts/test-db.mjs and scripts/health.mjs do: the
// status output, keys and connection strings are never printed, the database URL is parsed by scripts/operator-db.mjs, and
// anything that is not loopback is refused. It then runs the two measurement suites with these parameters and prints one
// JSON report on stdout:
//   - tests/performance/simulation.test.ts (pure code): the worker's heaviest jobs against cpuMs less 25 %;
//   - tests/db/capacity.test.ts (the local database, as `npm run test:db` runs it): a measurement world of --players
//     characters through a warm-up and K (--slots) measured accelerated boundaries with pg_cron's tick and the real Edge
//     worker, a second world on the new-character schedule, the read sizes, the season close and the standings reads.
//     That suite resets the world before each case and at its end, so no measurement row outlives the run.
// --viewers sets the visitor count of the egress model only. The suites' own output goes to stderr. The capacity suite checks
// its budgets only with CAPACITY_GATE=1 in the environment (Task 23.6's release gate sets it); the verdicts and the exit code
// of this report do not depend on it.
// Exit codes: 0 every budget below 100 %, 1 a budget at or over 100 % or a failed suite (the report still prints what was
// measured), 2 a usage or discovery failure ({"ok":false,"code":…} on stdout).
// Follow docs/operations/verification-gates.md: nothing else may build, browse or edit in the worktree that serves Edge while
// this runs, and the Edge container's start time must be the same before and after.
const root = fileURLToPath(new URL('..', import.meta.url));
const LIMITS = { players: [3, 200], viewers: [0, 10_000], slots: [3, 12] };

function parseArgs(argv) {
  const options = { players: 50, viewers: 50, slots: 4 };
  for (let i = 0; i < argv.length; i += 2) {
    const name = /^--(players|viewers|slots)$/.exec(argv[i] ?? '')?.[1];
    const raw = argv[i + 1] ?? '';
    const value = Number(raw);
    if (!name || !/^\d{1,6}$/.test(raw) || value < LIMITS[name][0] || value > LIMITS[name][1]) throw new Failure('usage');
    options[name] = value;
  }
  return options;
}

/** The local stack's test environment, in memory. Only loopback hosts are accepted; nothing here is printed. */
function localEnvironment() {
  let status;
  try {
    const cli = join(root, 'node_modules/supabase/dist/supabase.js');
    status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '-o', 'json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch {
    throw new Failure('discovery-failed');
  }
  let database, api;
  try {
    database = parseDatabaseUrl(status.DB_URL);
    api = new URL(status.API_URL);
  } catch {
    throw new Failure('discovery-failed');
  }
  if (!isLoopback(database.host) || !isLoopback(api.hostname.replace(/^\[(.*)\]$/, '$1')) || api.protocol !== 'http:') throw new Failure('discovery-not-local');
  for (const key of ['ANON_KEY', 'SERVICE_ROLE_KEY', 'JWT_SECRET']) if (typeof status[key] !== 'string' || !status[key]) throw new Failure('discovery-failed');
  // The local Edge runtime reads its private worker secret from this ignored file (scripts/test-db.mjs).
  const edge = join(root, '.env.edge.local');
  const workerSecret = existsSync(edge) ? (/^GAME_WORKER_SECRET=(.*)$/m.exec(readFileSync(edge, 'utf8'))?.[1].trim() ?? '') : '';
  if (workerSecret.length < 32) throw new Failure('worker-secret-missing');
  return { LOCAL_DB_TEST: 'Cloudiator', LOCAL_API_URL: status.API_URL, LOCAL_DB_URL: status.DB_URL, LOCAL_ANON_KEY: status.ANON_KEY,
    LOCAL_SERVICE_KEY: status.SERVICE_ROLE_KEY, LOCAL_JWT_SECRET: status.JWT_SECRET, LOCAL_WORKER_SECRET: workerSecret };
}

/** Runs one vitest suite with its output on stderr; true when it passed. */
function suite(config, file, env) {
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, file], {
    cwd: root, env, stdio: ['ignore', 2, 2], windowsHide: true });
  return result.status === 0;
}
const section = (dir, name) => {
  const path = join(dir, `${name}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
};
const percent = share => Math.round(share * 1_000) / 10;
const verdict = share => (share >= 1 ? 'blocker' : share > 0.8 ? 'risk' : 'ok');
const months = list => Object.fromEntries(list.map(m => [`${m.days}d`, { raw: Math.round(m.raw), gzip: Math.round(m.gzip), brotli: Math.round(m.brotli) }]));

/** The report: the sections the suites wrote, and every budget's use with its verdict (ok, risk above 80 %, blocker at 100 %). */
function report(options, dir, passed) {
  const worker = section(dir, 'worker'), capacity = section(dir, 'capacity'), seasonClose = section(dir, 'seasonClose'), standings = section(dir, 'standings');
  const budgets = [];
  const add = (name, used, budget) => budgets.push({ name, used: Math.round(used * 10) / 10, budget, percent: percent(used / budget), status: verdict(used / budget) });
  let database = null, invocations = null, egress = null, boundary = null;
  if (capacity) {
    const db = d => ({ bytesPerSlot: Math.round(d.bytesPerSlot), steadyStateBytes: Math.round(d.steadyStateBytes), atOneYearBytes: Math.round(d.atOneYear.bytes),
      permanentBytesPerMonth: d.permanentBytesPerMonth, seasonBytesPerMonth: d.seasonBytesPerMonth, monthsToBudget: d.monthsToBudget,
      byClassAt90Days: d.at90Days.byClass, byClassAtOneYear: d.atOneYear.byClass, budgetBytes: d.budgetBytes });
    database = { ...db(capacity.database), defaultSchedule: db(capacity.databaseDefault), commandSensitivity: capacity.sensitivity };
    for (const [label, d] of [['mixed schedules', capacity.database], ['new-character schedule', capacity.databaseDefault]]) {
      add(`database at 90 days, ${label}`, d.steadyStateBytes, d.budgetBytes);
      add(`database after one year, ${label}`, d.atOneYear.bytes, d.budgetBytes);
    }
    const inv = i => ({ perSlot: i.perSlot, perMonth: Object.fromEntries(i.months.map(m => [`${m.days}d`, { worker: m.worker, commands: m.commands, total: m.total,
      ceiling: m.ceiling }])), budget: i.budget });
    invocations = { ...inv(capacity.invocations), defaultSchedule: inv(capacity.invocationsDefault) };
    for (const m of capacity.invocations.months) add(`invocations, ${m.days}-day month`, m.total, capacity.invocations.budget);
    for (const m of capacity.invocations.months) add(`invocations at the dispatch ceiling, ${m.days}-day month`, m.ceiling, capacity.invocations.budget);
    const e = capacity.egress;
    egress = { perRead: e.perRead, inputs: e.inputs, perMonthPlayers: months(e.players.months), perMonthViewers: months(e.viewers.months),
      perMonthViewersAlwaysOn: months(e.viewersAlwaysOn.months), perMonthBackend: e.worker ? months(e.worker) : null,
      alwaysOnViewersWithinBudget: e.alwaysOnViewersWithinBudget, budget: e.budget };
    for (const m of e.combined.months) add(`egress raw, players and viewers, ${m.days}-day month`, m.raw, e.budget);
    for (const m of e.combined.months) add(`egress gzip, players and viewers, ${m.days}-day month`, m.gzip, e.budget);
    if (e.combinedWithWorker) for (const m of e.combinedWithWorker.months) add(`egress raw with backend traffic, ${m.days}-day month`, m.raw, e.budget);
    const published = [...capacity.measured.windows, ...capacity.measured.defaultSchedule.windows].map(w => w.publishedMs);
    boundary = { targetMs: 120_000, publishedMs: { mixed: capacity.measured.windows.map(w => [w.slot, w.publishedMs]),
      defaultSchedule: capacity.measured.defaultSchedule.windows.map(w => [w.slot, w.publishedMs]) } };
    add('boundary publication at 50 characters (worst window)', Math.max(...published), 120_000);
  }
  if (worker) {
    for (const [name, ms] of [['worker worst 120 s fight', worker.worstCombatMs], ['worker batch of 5', worker.batch5Ms],
      ['worker 50-entrant bracket', worker.bracket50Ms], ['worker tournament bout batch', worker.tournamentBatch5Ms]]) add(name, ms, worker.cpuMs);
  }
  if (seasonClose && capacity) {
    add('season close, 4 leagues x 50', seasonClose.ms50.ms, capacity.budgets.seasonCloseMs);
    add('season close, 4 leagues x 500', seasonClose.ms500.ms, capacity.budgets.seasonCloseMs);
  }
  if (standings && capacity) {
    add('standings page at 1,000 rows (Data API)', standings.pageMs, capacity.budgets.standingsReadMs);
    add('one standing row at 1,000 rows (Data API)', standings.oneRowMs, capacity.budgets.standingsReadMs);
  }
  return { ok: passed && budgets.every(b => b.status !== 'blocker'), target: 'local', options, database, invocations, egress, boundary,
    worker: worker && { worstCombatMs: worker.worstCombatMs, batch5Ms: worker.batch5Ms, bracket50Ms: worker.bracket50Ms, tournamentBatch5Ms: worker.tournamentBatch5Ms,
      expeditionBatch5Ms: worker.expeditionBatch5Ms, budgetMs: worker.budgetMs, machine: worker.machine },
    seasonClose: seasonClose && { ms50: seasonClose.ms50.ms, ms500: seasonClose.ms500.ms },
    standings: standings && { pageMs: standings.pageMs, oneRowMs: standings.oneRowMs, plans: standings.plans },
    budgets, measured: capacity?.measured ?? null };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const local = localEnvironment();
  const dir = mkdtempSync(join(tmpdir(), 'cloudiator-capacity-'));
  try {
    // Never an operator connection string: the suites reach only the discovered local stack.
    const base = { ...process.env, CAPACITY_REPORT_DIR: dir, CAPACITY_PLAYERS: String(options.players), CAPACITY_VIEWERS: String(options.viewers),
      CAPACITY_SLOTS: String(options.slots) };
    delete base.CLOUDIATOR_DB_URL;
    const unit = suite('vitest.config.ts', 'tests/performance/simulation.test.ts', base);
    const db = suite('vitest.db.config.ts', 'tests/db/capacity.test.ts', { ...base, ...local });
    const result = report(options, dir, unit && db);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.ok ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  process.exitCode = main();
} catch (error) {
  process.stdout.write(JSON.stringify(describeFailure(error)) + '\n');
  process.exitCode = 2;
}
