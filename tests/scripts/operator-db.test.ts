import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describeFailure, Failure, libpqEnvironment, operatorTarget, parseDatabaseUrl, postgresOptions } from '../../scripts/operator-db.mjs';

// Task 22.4 carried fixes M1 and M2 (Task 22.3 review): the operator connection parser shared by scripts/health.mjs and
// scripts/export-db.ps1, and the failure classification. Pure functions: no network, no database.

/** The failure code a call throws, or 'none'. The thrown message must never carry the input. */
function failureOf(run: () => unknown, input?: string): string {
  try {
    run();
    return 'none';
  } catch (error) {
    if (input) expect(String((error as Error).message) + String((error as Error).stack)).not.toContain(input);
    return error instanceof Failure ? error.failure : 'not-a-failure';
  }
}

describe('parseDatabaseUrl', () => {
  it('parses an operator URL into discrete fields, decoding the credential', () => {
    expect(parseDatabaseUrl('postgresql://operator:p%40ss%3Aw0rd@db.example.com:6543/postgres?sslmode=verify-full')).toEqual({
      host: 'db.example.com', port: 6543, user: 'operator', password: 'p@ss:w0rd', database: 'postgres', sslmode: 'verify-full' });
    expect(parseDatabaseUrl('postgres://postgres:postgres@127.0.0.1:54322/postgres')).toEqual({
      host: '127.0.0.1', port: 54322, user: 'postgres', password: 'postgres', database: 'postgres', sslmode: null });
  });

  it('defaults the port and database and unwraps an IPv6 literal', () => {
    expect(parseDatabaseUrl('postgres://u@db.example.com')).toEqual({ host: 'db.example.com', port: 5432, user: 'u', password: '',
      database: 'postgres', sslmode: null });
    expect(parseDatabaseUrl('postgres://u:p@[::1]:54322/postgres').host).toBe('::1');
  });

  it('refuses an authority the guard and the driver would read differently (review M1)', () => {
    // WHATWG reads the host after the last @ (127.0.0.1); postgres.js after the first @, as a host list (evil.example first).
    const evil = 'postgres://u@evil.example,x@127.0.0.1/db';
    expect(failureOf(() => parseDatabaseUrl(evil), evil)).toBe('invalid-url');
    expect(failureOf(() => parseDatabaseUrl('postgres://u@evil.example,127.0.0.1/db'))).toBe('invalid-url');
    expect(failureOf(() => parseDatabaseUrl('postgres://a@b@127.0.0.1/db'))).toBe('invalid-url');
    expect(failureOf(() => parseDatabaseUrl('postgres://u:p%40@127.0.0.1:5432,evil.example:5432/db'))).toBe('invalid-url');
  });

  it('refuses socket paths, encoded hosts, other schemes, fragments and unknown parameters', () => {
    for (const raw of ['postgres:///postgres', 'postgres://u@%2Ftmp/postgres', 'mysql://u@127.0.0.1/db', 'postgres://u@127.0.0.1/db#x',
      'postgres://u@127.0.0.1/db?host=evil.example', 'postgres://u@127.0.0.1/db?options=-c%20role%3Dx', 'postgres://u@127.0.0.1/db?sslmode=verify-ca',
      'postgres://u@127.0.0.1:0/db', 'postgres://u@127.0.0.1:70000/db', 'postgres://u@127.0.0.1/a/b', 'postgres://@127.0.0.1/db', ' postgres://u@127.0.0.1/db',
      'not a url', '']) {
      expect(failureOf(() => parseDatabaseUrl(raw), raw || undefined), raw).toBe('invalid-url');
    }
  });
});

describe('operatorTarget', () => {
  it('allows loopback hosts without --remote and requires --remote for anything else', () => {
    expect(operatorTarget('postgres://u:p@localhost:54322/postgres', { remote: false })).toMatchObject({ host: 'localhost', local: true });
    expect(operatorTarget('postgres://u:p@[::1]:54322/postgres', { remote: false })).toMatchObject({ local: true });
    expect(failureOf(() => operatorTarget('postgres://u:p@db.example.com/postgres', { remote: false }))).toBe('remote-not-allowed');
    expect(operatorTarget('postgres://u:p@db.example.com/postgres', { remote: true })).toMatchObject({ host: 'db.example.com', local: false });
    // A name that merely starts with a loopback address is not loopback.
    expect(failureOf(() => operatorTarget('postgres://u:p@127.0.0.1.example.com/postgres', { remote: false }))).toBe('remote-not-allowed');
  });
});

describe('postgresOptions and libpqEnvironment', () => {
  it('hands the driver the parsed fields, never the string, with TLS required for a remote host', () => {
    const local = operatorTarget('postgres://postgres:secret@127.0.0.1:54322/postgres', { remote: false });
    expect(postgresOptions(local)).toEqual({ host: ['127.0.0.1'], port: [54322], user: 'postgres', pass: 'secret', database: 'postgres', ssl: false });
    const remote = operatorTarget('postgres://operator:secret@db.example.com:5432/postgres', { remote: true });
    expect(postgresOptions(remote)).toMatchObject({ host: ['db.example.com'], port: [5432], ssl: 'require' });
    const verified = operatorTarget('postgres://operator:secret@db.example.com/postgres?sslmode=verify-full', { remote: true });
    expect(postgresOptions(verified).ssl).toBe('verify-full');
    const ipv6 = operatorTarget('postgres://postgres:secret@[::1]:54322/postgres', { remote: false });
    expect(postgresOptions(ipv6).host).toEqual(['::1']);
  });

  it('gives libpq the same fields as PG* variables', () => {
    const remote = operatorTarget('postgres://operator:s%20cret@db.example.com:6543/app', { remote: true });
    expect(libpqEnvironment(remote)).toEqual({ PGHOST: 'db.example.com', PGPORT: '6543', PGUSER: 'operator', PGPASSWORD: 's cret',
      PGDATABASE: 'app', PGSSLMODE: 'require' });
    const local = operatorTarget('postgres://postgres:p@127.0.0.1:54322/postgres', { remote: false });
    expect(libpqEnvironment(local).PGSSLMODE).toBe('disable');
  });
});

describe('describeFailure', () => {
  it('classifies network errors before SQLSTATEs, so EPIPE is a connection failure (review M2)', () => {
    for (const code of ['EPIPE', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EBADF', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED']) {
      expect(describeFailure(Object.assign(new Error('raw text'), { code })), code).toEqual({ ok: false, code: 'connection-failed' });
    }
  });

  it('maps SQLSTATEs to short codes and keeps the SQLSTATE', () => {
    const state = (code: string) => describeFailure(Object.assign(new Error('raw text with a password'), { code }));
    expect(state('42501')).toEqual({ ok: false, code: 'permission-denied', sqlstate: '42501' });
    expect(state('3D000')).toEqual({ ok: false, code: 'database-missing', sqlstate: '3D000' });
    expect(state('28P01')).toEqual({ ok: false, code: 'auth-failed', sqlstate: '28P01' });
    expect(state('42883')).toEqual({ ok: false, code: 'report-missing', sqlstate: '42883' });
    expect(state('57014')).toEqual({ ok: false, code: 'timeout', sqlstate: '57014' });
    expect(state('XX000')).toEqual({ ok: false, code: 'query-failed', sqlstate: 'XX000' });
  });

  it('passes a Failure through and reduces anything else to report-failed', () => {
    expect(describeFailure(new Failure('discovery-not-local'))).toEqual({ ok: false, code: 'discovery-not-local' });
    expect(describeFailure(new Failure('query-failed', '40001'))).toEqual({ ok: false, code: 'query-failed', sqlstate: '40001' });
    expect(describeFailure(new Error('postgres://u:secret@db.example.com'))).toEqual({ ok: false, code: 'report-failed' });
    expect(describeFailure(Object.assign(new Error('x'), { code: 'lowercase' }))).toEqual({ ok: false, code: 'report-failed' });
  });
});

describe('operator-db.mjs CLI (scripts/export-db.ps1 -Remote)', () => {
  const run = (args: string[], url: string | undefined) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CLOUDIATOR_EXPORT_DB_URL: url };
    if (url === undefined) delete env.CLOUDIATOR_EXPORT_DB_URL;
    return spawnSync(process.execPath, [resolve('scripts/operator-db.mjs'), ...args], { encoding: 'utf8', env });
  };

  it('checks the URL from the environment without echoing it', () => {
    const marker = randomUUID();
    const valid = run(['check', 'CLOUDIATOR_EXPORT_DB_URL'], `postgresql://operator:pw-${marker}@db.example.com:5432/postgres`);
    expect({ status: valid.status, out: JSON.parse(valid.stdout) }).toEqual({ status: 0, out: { ok: true, local: false } });
    const evil = run(['check', 'CLOUDIATOR_EXPORT_DB_URL'], `postgres://u:pw-${marker}@evil.example,x@127.0.0.1/db`);
    expect({ status: evil.status, out: JSON.parse(evil.stdout) }).toEqual({ status: 2, out: { ok: false, code: 'invalid-url' } });
    const missing = run(['check', 'CLOUDIATOR_EXPORT_DB_URL'], undefined);
    expect(JSON.parse(missing.stdout)).toEqual({ ok: false, code: 'remote-needs-url' });
    for (const out of [valid, evil, missing]) expect(out.stdout + out.stderr).not.toContain(marker);
  });

  it('runs a command with the parsed PG* variables only, without the URL variable', () => {
    const marker = randomUUID();
    const probe = 'const e=process.env;process.stdout.write(JSON.stringify({host:e.PGHOST,port:e.PGPORT,user:e.PGUSER,db:e.PGDATABASE,'
      + "ssl:e.PGSSLMODE,password:e.PGPASSWORD==='pw '+" + JSON.stringify(marker) + ',url:"CLOUDIATOR_EXPORT_DB_URL" in e}))';
    const ran = run(['exec', 'CLOUDIATOR_EXPORT_DB_URL', process.execPath, '-e', probe], `postgresql://operator:pw%20${marker}@db.example.com:6543/app`);
    expect(ran.status).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({ host: 'db.example.com', port: '6543', user: 'operator', db: 'app', ssl: 'require', password: true, url: false });
    const refused = run(['exec', 'CLOUDIATOR_EXPORT_DB_URL', process.execPath, '-e', 'process.exit(0)'], `postgres://a@b@127.0.0.1/${marker}`);
    expect(refused.status).toBe(2);
    expect(JSON.parse(refused.stderr)).toEqual({ ok: false, code: 'invalid-url' });
    expect(refused.stdout + refused.stderr).not.toContain(marker);
  });
});
