import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { describeFailure, Failure, operatorTarget, parseDatabaseUrl, isLoopback, postgresOptions } from './operator-db.mjs';

// Owner-operated health report (Task 22.3, Decision 8): prints private.health_report(private.planning_now_ms()) as JSON.
//   node scripts/health.mjs            the local Cloudiator stack, discovered in memory (as scripts/test-db.mjs)
//   node scripts/health.mjs [--remote] with CLOUDIATOR_DB_URL set in the shell as docs/operations/runbook.md ("Entering a
//                                      connection string") says, never on a command line: an operator connection (the
//                                      database owner); a non-loopback host needs --remote
// Exit codes: 0 healthy, 1 alerts, 2 failure ({"ok":false,"code":…} on stdout). The connection string, its credential and
// raw error text are never printed: every failure is mapped to a short code (and a SQLSTATE when the database gave one).
// The string is parsed once (scripts/operator-db.mjs) and the driver receives only the parsed fields (Task 22.4, review M1).
// The failure codes and what to do about each are in docs/operations/runbook.md ("Health check").
const root = fileURLToPath(new URL('..', import.meta.url));

/** The database to report on, never echoed. */
function target(remote) {
  const explicit = process.env.CLOUDIATOR_DB_URL;
  if (explicit) return operatorTarget(explicit, { remote });
  if (remote) throw new Failure('remote-needs-url');
  // Discover only this checkout's local stack. Do not include CLI output in anything thrown: status contains local credentials.
  let status;
  try {
    const cli = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url));
    status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '-o', 'json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch {
    throw new Failure('discovery-failed');
  }
  let discovered;
  try {
    discovered = parseDatabaseUrl(status.DB_URL);
  } catch {
    throw new Failure('discovery-failed');
  }
  if (!isLoopback(discovered.host)) throw new Failure('discovery-not-local');
  return { ...discovered, local: true };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--remote')) throw new Failure('usage');
  const sql = postgres({ ...postgresOptions(target(args.includes('--remote'))), max: 1, prepare: false, onnotice: () => {},
    connect_timeout: 10, idle_timeout: 1, connection: { application_name: 'cloudiator-health' } });
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
  process.stdout.write(JSON.stringify(describeFailure(error)) + '\n');
  process.exitCode = 2;
});
