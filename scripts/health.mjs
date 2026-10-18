import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

// Owner-operated health report (Task 22.3, Decision 8): prints private.health_report(private.planning_now_ms()) as JSON.
//   node scripts/health.mjs            the local Cloudiator stack, discovered in memory (as scripts/test-db.mjs)
//   CLOUDIATOR_DB_URL=… node scripts/health.mjs [--remote]
//                                      an operator connection (the database owner); a non-loopback host needs --remote
// Exit codes: 0 healthy, 1 alerts, 2 failure ({"ok":false,"code":…} on stdout). The connection string, its credential and
// raw error text are never printed: every failure is mapped to a short code (and a SQLSTATE when the database gave one).
const root = fileURLToPath(new URL('..', import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

class Failure extends Error {
  constructor(code, sqlstate) {
    super(code);
    this.failure = code;
    this.sqlstate = sqlstate;
  }
}

/** The database to report on, never echoed. */
function target(remote) {
  const explicit = process.env.CLOUDIATOR_DB_URL;
  if (explicit) {
    let url;
    try {
      url = new URL(explicit);
    } catch {
      throw new Failure('invalid-url');
    }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Failure('invalid-url');
    const local = LOOPBACK.has(url.hostname);
    if (!local && !remote) throw new Failure('remote-not-allowed');
    return { url: explicit, local, ssl: url.searchParams.has('sslmode') ? undefined : local ? false : 'require' };
  }
  if (remote) throw new Failure('remote-needs-url');
  // Discover only this checkout's local stack. Do not include CLI output in anything thrown: status contains local credentials.
  let status;
  try {
    const cli = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url));
    status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '-o', 'json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch {
    throw new Failure('discovery-failed');
  }
  let url;
  try {
    url = new URL(status.DB_URL);
  } catch {
    throw new Failure('discovery-failed');
  }
  if (!LOOPBACK.has(url.hostname)) throw new Failure('discovery-not-local');
  return { url: status.DB_URL, local: true, ssl: false };
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
const CODES = { '28P01': 'auth-failed', '28000': 'auth-failed', '3D000': 'database-missing', '42883': 'report-missing',
  '3F000': 'report-missing', '42501': 'permission-denied', '57014': 'timeout', '55P03': 'lock-timeout' };
const NETWORK = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED']);
/** A short, secret-free description of a failure: a code from a fixed list, plus a SQLSTATE when there is one. */
function describe(error) {
  if (error instanceof Failure) return { ok: false, code: error.failure, ...(error.sqlstate ? { sqlstate: error.sqlstate } : {}) };
  const code = typeof error?.code === 'string' ? error.code : '';
  if (SQLSTATE.test(code)) return { ok: false, code: CODES[code] ?? 'query-failed', sqlstate: code };
  if (NETWORK.has(code) || /^E[A-Z]+$/.test(code) || /^CONNECTION_/.test(code)) return { ok: false, code: 'connection-failed' };
  return { ok: false, code: 'report-failed' };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--remote')) throw new Failure('usage');
  const { url, ssl } = target(args.includes('--remote'));
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 10, idle_timeout: 1,
    connection: { application_name: 'cloudiator-health' }, ...(ssl === undefined ? {} : { ssl }) });
  try {
    // One read-only transaction with bounded waits: the report never writes and never holds anything for long.
    const report = await sql.begin('read only', async tx => {
      await tx`set local statement_timeout = '30s'`;
      await tx`set local lock_timeout = '5s'`;
      return (await tx`select private.health_report(private.planning_now_ms()) as report`)[0].report;
    });
    if (!report || !Array.isArray(report.alerts)) throw new Failure('report-invalid');
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.alerts.length > 0 ? 1 : 0;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

main().then(code => { process.exitCode = code; }, error => {
  process.stdout.write(JSON.stringify(describe(error)) + '\n');
  process.exitCode = 2;
});
