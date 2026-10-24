import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkHostedTarget, filterHostedList, HOSTED_RESTORE_DATA } from '../../scripts/restore-compare.mjs';

// Task 24.10: the comparison module's hosted-restore part behind scripts/restore-hosted.ps1, tested with no Docker.

const migrations = [
  { version: '20261012050952', name: 'identity' },
  { version: '20261020075858', name: 'idle_rest' },
];
const manifest = {
  format: 1,
  migrations,
  tables: { 'auth.users': 4, 'private.settled_slots': 40, 'public.gladiators': 4 },
  files: { 'schema.dump': 'a'.repeat(64), 'data.dump': 'b'.repeat(64) },
};
/** The facts scripts/restore-hosted.ps1 reads from a new project right after `db push`. */
const fresh = { migrations, accounts: 0, identities: 0, characters: 0, epochSet: false, schedulerEnabled: false };

describe('filterHostedList', () => {
  // A pg_restore -l listing of a data dump in the format of the PostgreSQL 17 dumps (id; tableoid oid type schema name owner).
  const listing = [
    ';',
    '; Archive created at 2026-10-24 00:24:00 UTC',
    ';',
    '4799; 0 0 SEQUENCE SET auth refresh_tokens_id_seq supabase_auth_admin',
    '4800; 0 0 SEQUENCE SET cron jobid_seq supabase_admin',
    '4802; 0 0 SEQUENCE SET private dispatch_log_id_seq postgres',
    '4810; 0 17000 TABLE DATA auth audit_log_entries supabase_auth_admin',
    '4811; 0 17001 TABLE DATA auth identities supabase_auth_admin',
    '4812; 0 17002 TABLE DATA auth instances supabase_auth_admin',
    '4813; 0 17003 TABLE DATA auth mfa_factors supabase_auth_admin',
    '4814; 0 17004 TABLE DATA auth schema_migrations supabase_auth_admin',
    '4815; 0 17005 TABLE DATA auth users supabase_auth_admin',
    '4820; 0 17100 TABLE DATA cron job supabase_admin',
    '4821; 0 17101 TABLE DATA supabase_functions hooks supabase_functions_admin',
    '4822; 0 17102 TABLE DATA supabase_migrations schema_migrations postgres',
    '4830; 0 17200 TABLE DATA private coordinator postgres',
    '4831; 0 17201 TABLE DATA public gladiators postgres',
    '4832; 0 17202 TABLE DATA private settled_slots postgres',
    '',
  ].join('\n');

  it('keeps only the game tables, the accounts with their identities, and the game sequences, in the listing order', () => {
    const { list, kept } = filterHostedList(listing);
    expect(kept).toEqual([
      { id: 4802, type: 'SEQUENCE SET', schema: 'private', name: 'dispatch_log_id_seq' },
      { id: 4811, type: 'TABLE DATA', schema: 'auth', name: 'identities' },
      { id: 4815, type: 'TABLE DATA', schema: 'auth', name: 'users' },
      { id: 4830, type: 'TABLE DATA', schema: 'private', name: 'coordinator' },
      { id: 4831, type: 'TABLE DATA', schema: 'public', name: 'gladiators' },
      { id: 4832, type: 'TABLE DATA', schema: 'private', name: 'settled_slots' },
    ]);
    // The header stays; every other entry is gone, and the order of the kept ones is the dump's own (foreign-key) order.
    expect(list.split('\n')).toEqual(listing.split('\n').filter(line => !/^\d+;/.test(line) || /^(4802|4811|4815|4830|4831|4832);/.test(line)));
  });

  it('reports every entry it leaves out: platform, migration history, schedules and the other sign-in tables', () => {
    expect(filterHostedList(listing).leftOut).toEqual([
      { id: 4799, type: 'SEQUENCE SET', schema: 'auth', name: 'refresh_tokens_id_seq' },
      { id: 4800, type: 'SEQUENCE SET', schema: 'cron', name: 'jobid_seq' },
      { id: 4810, type: 'TABLE DATA', schema: 'auth', name: 'audit_log_entries' },
      { id: 4812, type: 'TABLE DATA', schema: 'auth', name: 'instances' },
      { id: 4813, type: 'TABLE DATA', schema: 'auth', name: 'mfa_factors' },
      { id: 4814, type: 'TABLE DATA', schema: 'auth', name: 'schema_migrations' },
      { id: 4820, type: 'TABLE DATA', schema: 'cron', name: 'job' },
      { id: 4821, type: 'TABLE DATA', schema: 'supabase_functions', name: 'hooks' },
      { id: 4822, type: 'TABLE DATA', schema: 'supabase_migrations', name: 'schema_migrations' },
    ]);
  });

  it('refuses an entry line it cannot read instead of passing it to pg_restore (an allow-list fails closed)', () => {
    expect(() => filterHostedList(['; header', '4822;0 1 TABLE DATA net _http_response x', ''].join('\n'))).toThrow('unreadable listing line');
    expect(filterHostedList(['; header', '', ';', ''].join('\n')).kept).toEqual([]);
  });

  it('restores exactly the tables the manifest counts, plus the identities', () => {
    expect(HOSTED_RESTORE_DATA).toEqual({ schemas: ['public', 'private'], tables: ['auth.users', 'auth.identities'] });
  });
});

describe('checkHostedTarget', () => {
  it('accepts a new project with the backup migrations and nothing else', () => {
    expect(checkHostedTarget(manifest, fresh)).toEqual({ ok: true, migrations: 2 });
  });

  it.each([
    ['an account', { accounts: 1 }],
    ['an identity', { identities: 1 }],
    ['a character', { characters: 1 }],
    ['a season epoch', { epochSet: true }],
    ['the scheduler on', { schedulerEnabled: true }],
  ])('refuses a target with %s: it is not a new project', (_, over) => {
    expect(checkHostedTarget(manifest, { ...fresh, ...over })).toEqual({ ok: false, code: 'target-not-fresh' });
  });

  it.each([
    ['one missing', migrations.slice(0, 1)],
    ['one extra', [...migrations, { version: '20261101000000', name: 'later' }]],
    ['another version', [migrations[0], { version: '20261020075859', name: 'idle_rest' }]],
  ])('refuses migrations that differ from the backup (%s)', (_, list) => {
    expect(checkHostedTarget(manifest, { ...fresh, migrations: list })).toEqual({ ok: false, code: 'migrations-mismatch' });
  });

  it('refuses facts it cannot read instead of passing', () => {
    expect(checkHostedTarget(manifest, { ...fresh, accounts: null })).toEqual({ ok: false, code: 'target-facts-invalid' });
    expect(checkHostedTarget(manifest, { ...fresh, identities: undefined })).toEqual({ ok: false, code: 'target-facts-invalid' });
    expect(checkHostedTarget(manifest, { migrations })).toEqual({ ok: false, code: 'target-facts-invalid' });
    expect(checkHostedTarget({ ...manifest, migrations: undefined }, fresh)).toEqual({ ok: false, code: 'manifest-invalid' });
  });
});

describe('restore-compare.mjs hosted commands', () => {
  let directory = '';
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = ''; });
  const run = (...args: string[]) => spawnSync(process.execPath, [resolve('scripts/restore-compare.mjs'), ...args], { encoding: 'utf8' });

  it('hosted-target prints the verdict and exits 1 on a refused target', () => {
    directory = mkdtempSync(join(tmpdir(), 'cloudiator-hosted-'));
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(directory, 'facts.json'), '﻿' + JSON.stringify({ ...fresh, accounts: 3 }));
    const refused = run('hosted-target', directory, join(directory, 'facts.json'));
    expect([refused.status, JSON.parse(refused.stdout)]).toEqual([1, { ok: false, code: 'target-not-fresh' }]);
    writeFileSync(join(directory, 'facts.json'), JSON.stringify(fresh));
    const accepted = run('hosted-target', directory, join(directory, 'facts.json'));
    expect([accepted.status, JSON.parse(accepted.stdout)]).toEqual([0, { ok: true, migrations: 2 }]);
  });

  it('hosted-compare reports counts, invariants and what was left out, and exits 1 on a mismatch', () => {
    directory = mkdtempSync(join(tmpdir(), 'cloudiator-hosted-'));
    const backup = join(directory, 'backup'), work = join(directory, 'work');
    for (const dir of [backup, work]) mkdirSync(dir);
    writeFileSync(join(backup, 'schema.dump'), 'schema');
    writeFileSync(join(backup, 'data.dump'), 'data');
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    writeFileSync(join(backup, 'manifest.json'), JSON.stringify({ ...manifest, createdAt: '2026-10-24T00:24:00Z', source: 'remote', commit: 'c'.repeat(40),
      files: { 'schema.dump': sha('schema'), 'data.dump': sha('data') } }));
    const invariants = Object.fromEntries(['settledSlotsUnique', 'completedActivitiesGuarded', 'ledgerReceiptsUnique', 'walletReconciliation',
      'itemsSingleOwner', 'inventoryCap', 'seasonAwardsUnique', 'foreignKeys', 'guardsIntact'].map(name => [name, { ok: true, violations: 0 }]));
    writeFileSync(join(work, 'invariants.json'), JSON.stringify({ counts: manifest.tables, invariants }));
    writeFileSync(join(work, 'data-left-out.json'), JSON.stringify([{ id: 4820, type: 'TABLE DATA', schema: 'cron', name: 'job' }]));
    // The data dump's own COPY counts (auth.identities is not in the manifest) and the project's facts after the load.
    writeFileSync(join(work, 'dump-counts.json'), JSON.stringify({ ...manifest.tables, 'auth.identities': 8, 'cron.job': 2 }));
    const after = { ...fresh, accounts: 4, identities: 8, characters: 4, epochSet: true };
    writeFileSync(join(work, 'facts-after.json'), JSON.stringify(after));
    const passed = run('hosted-compare', backup, work);
    const report = JSON.parse(passed.stdout);
    expect(passed.status).toBe(0);
    expect(report).toMatchObject({ ok: true, backup: { name: 'backup', source: 'remote', migrations: 2 },
      counts: { tables: 3, rows: 48, restoredTables: 3, restoredRows: 48, mismatched: 0 }, mismatches: [],
      checksums: { 'data.dump': true, 'schema.dump': true }, identities: { expected: 8, actual: 8 },
      leftOut: { entries: 1, tables: ['cron.job'] }, scheduler: 'off', next: 'vault-secrets' });
    expect(Object.values(report.invariants).every(value => (value as { ok: boolean }).ok)).toBe(true);
    writeFileSync(join(work, 'invariants.json'), JSON.stringify({ counts: { ...manifest.tables, 'public.gladiators': 3 }, invariants }));
    const failed = run('hosted-compare', backup, work);
    expect([failed.status, JSON.parse(failed.stdout).mismatches]).toEqual([1, [{ table: 'public.gladiators', expected: 4, actual: 3 }]]);
    writeFileSync(join(work, 'invariants.json'), JSON.stringify({ counts: manifest.tables, invariants }));
    writeFileSync(join(work, 'facts-after.json'), JSON.stringify({ ...after, identities: 7 }));
    const lost = run('hosted-compare', backup, work);
    expect([lost.status, JSON.parse(lost.stdout).mismatches]).toEqual([1, [{ table: 'auth.identities', expected: 8, actual: 7 }]]);
    writeFileSync(join(work, 'facts-after.json'), JSON.stringify({ ...after, schedulerEnabled: true }));
    const running = run('hosted-compare', backup, work);
    expect([running.status, JSON.parse(running.stdout).scheduler]).toEqual([1, 'on']);
  });

  it('hosted-list writes the list and the left-out entries next to the listing', () => {
    directory = mkdtempSync(join(tmpdir(), 'cloudiator-hosted-'));
    writeFileSync(join(directory, 'data.toc'), '; header\n4815; 0 17005 TABLE DATA auth users supabase_auth_admin\n4820; 0 17100 TABLE DATA cron job supabase_admin\n');
    const listed = run('hosted-list', directory);
    expect([listed.status, JSON.parse(listed.stdout)]).toEqual([0, { ok: true, kept: 1, leftOut: 1 }]);
    expect(readFileSync(join(directory, 'data.list'), 'utf8')).toBe('; header\n4815; 0 17005 TABLE DATA auth users supabase_auth_admin\n');
    expect(JSON.parse(readFileSync(join(directory, 'data-left-out.json'), 'utf8'))).toEqual([
      { id: 4820, type: 'TABLE DATA', schema: 'cron', name: 'job' },
    ]);
  });
});
