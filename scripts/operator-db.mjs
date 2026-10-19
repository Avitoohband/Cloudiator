import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Operator database connections (Task 22.3 health, Task 22.4 export), shared so every script parses a connection string the
// same way and classifies failures the same way. The string itself is never printed, thrown or handed to a driver: it is
// parsed once into discrete fields, and the drivers (postgres.js, libpq through PG* variables) receive only those fields.
//
// Why discrete fields (Task 22.3 review M1): WHATWG `new URL()` reads the host after the LAST '@', postgres.js after the
// FIRST '@' and as a comma-separated host list, and libpq has its own rules. 'postgres://u@evil.example,x@127.0.0.1/db'
// looked like loopback to the old guard while the driver connected to evil.example. An authority with a ',' or more than one
// '@' is refused, the host must be a plain name or address, and the parsed host is the one every driver uses.

export class Failure extends Error {
  /** A short code from a fixed list, plus a SQLSTATE when the database gave one. Never raw text. */
  constructor(code, sqlstate) {
    super(code);
    this.failure = code;
    this.sqlstate = sqlstate;
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
export const isLoopback = host => LOOPBACK.has(host);

/** libpq sslmode values both drivers support. verify-ca has no postgres.js equivalent. */
const SSLMODES = new Set(['disable', 'allow', 'prefer', 'require', 'verify-full']);
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6 = /^\[([0-9A-Fa-f:.]+)\]$/;

/**
 * Parses a postgres:// or postgresql:// URL into {host, port, user, password, database, sslmode}. Anything ambiguous or
 * unexpected throws Failure('invalid-url') without the input: whitespace or control characters, a fragment, a missing user,
 * a socket path, an authority with ',' or more than one '@', a percent-encoded or otherwise unusual host, a nested database
 * path, a port outside 1-65535, or a query parameter other than sslmode.
 */
export function parseDatabaseUrl(raw) {
  const invalid = () => new Failure('invalid-url');
  if (typeof raw !== 'string' || raw === '' || /[\s\x00-\x1f\x7f\\]/.test(raw)) throw invalid();
  const scheme = /^(postgres|postgresql):\/\//i.exec(raw);
  if (!scheme) throw invalid();
  // The authority as every parser must agree on it: from '://' to the first '/', '?' or '#'.
  const rest = raw.slice(scheme[0].length);
  const authority = rest.split(/[/?#]/, 1)[0];
  if (authority.includes(',') || authority.split('@').length > 2 || raw.includes('#')) throw invalid();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalid();
  }
  const hostPort = authority.includes('@') ? authority.slice(authority.indexOf('@') + 1) : authority;
  // WHATWG must see the same host and port as the authority above (no normalisation surprises).
  if (url.host.toLowerCase() !== hostPort.toLowerCase()) throw invalid();
  let host = url.hostname;
  const literal = IPV6.exec(host);
  if (literal) host = literal[1];
  else if (!HOSTNAME.test(host)) throw invalid();
  const port = url.port === '' ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid();
  let user, password, database;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    throw invalid();
  }
  if (!user || database.includes('/')) throw invalid();
  let sslmode = null;
  for (const [key, value] of url.searchParams) {
    if (key !== 'sslmode' || sslmode !== null || !SSLMODES.has(value)) throw invalid();
    sslmode = value;
  }
  return { host, port, user, password, database: database || 'postgres', sslmode };
}

/** The parsed target, refusing a non-loopback host unless the operator explicitly asked for a remote connection. */
export function operatorTarget(raw, { remote }) {
  const target = parseDatabaseUrl(raw);
  const local = isLoopback(target.host);
  if (!local && !remote) throw new Failure('remote-not-allowed');
  return { ...target, local };
}

/**
 * TLS when the URL does not choose: off for loopback, 'require' for a remote host. 'require' encrypts but does not verify the
 * server certificate; an operator adds sslmode=verify-full and the hosted CA (docs/operations/runbook.md, "Connections").
 */
const sslmodeOf = target => target.sslmode ?? (target.local ? 'disable' : 'require');

/** postgres.js options built from the parsed fields; host and port are arrays so the driver never re-parses a string. */
export function postgresOptions(target) {
  const mode = sslmodeOf(target);
  return { host: [target.host], port: [target.port], user: target.user, pass: target.password, database: target.database,
    ssl: mode === 'disable' ? false : mode };
}

/** The same fields for libpq tools (pg_dump, psql), as PG* environment variables. */
export function libpqEnvironment(target) {
  return { PGHOST: target.host, PGPORT: String(target.port), PGUSER: target.user, PGPASSWORD: target.password,
    PGDATABASE: target.database, PGSSLMODE: sslmodeOf(target) };
}

// Failure classification (Task 22.3 review M2): network codes are tested first, and a SQLSTATE must contain a digit (every
// SQLSTATE class does), so a five-letter errno such as EPIPE is a connection failure, not a SQLSTATE.
const SQLSTATE = /^(?=[0-9A-Z]*[0-9])[0-9A-Z]{5}$/;
const CODES = { '28P01': 'auth-failed', '28000': 'auth-failed', '3D000': 'database-missing', '42883': 'report-missing',
  '3F000': 'report-missing', '42501': 'permission-denied', '57014': 'timeout', '55P03': 'lock-timeout' };
const NETWORK = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED']);

/** A short, secret-free description of a failure: a code from a fixed list, plus a SQLSTATE when there is one. */
export function describeFailure(error) {
  if (error instanceof Failure) return { ok: false, code: error.failure, ...(error.sqlstate ? { sqlstate: error.sqlstate } : {}) };
  const code = typeof error?.code === 'string' ? error.code : '';
  if (NETWORK.has(code) || /^E[A-Z]+$/.test(code) || /^CONNECTION_/.test(code)) return { ok: false, code: 'connection-failed' };
  if (SQLSTATE.test(code)) return { ok: false, code: CODES[code] ?? 'query-failed', sqlstate: code };
  return { ok: false, code: 'report-failed' };
}

/**
 * CLI for scripts/export-db.ps1 -Remote:
 *   node scripts/operator-db.mjs exec <ENV_NAME> <command> [args...]
 * Parses the connection string in the environment variable <ENV_NAME> (never an argument), then runs <command> with the
 * parsed fields as PG* variables and without <ENV_NAME>. The command's standard output passes through; its standard error is
 * discarded, because libpq errors name the host and user. Exits with the command's status, or 2 with a short code on stderr.
 */
function main(argv) {
  const [verb, name, command, ...args] = argv;
  if (verb !== 'exec' || !/^[A-Z][A-Z0-9_]*$/.test(name ?? '') || !command) {
    process.stderr.write(JSON.stringify({ ok: false, code: 'usage' }) + '\n');
    return 2;
  }
  const raw = process.env[name];
  if (!raw) {
    process.stderr.write(JSON.stringify({ ok: false, code: 'remote-needs-url' }) + '\n');
    return 2;
  }
  let target;
  try {
    target = operatorTarget(raw, { remote: true });
  } catch (error) {
    process.stderr.write(JSON.stringify(describeFailure(error)) + '\n');
    return 2;
  }
  const env = { ...process.env, ...libpqEnvironment(target) };
  delete env[name];
  const result = spawnSync(command, args, { env, stdio: ['ignore', 'inherit', 'ignore'], windowsHide: true });
  if (result.error || result.status === null) {
    process.stderr.write(JSON.stringify({ ok: false, code: 'command-failed' }) + '\n');
    return 2;
  }
  return result.status;
}

const invokedDirectly = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
