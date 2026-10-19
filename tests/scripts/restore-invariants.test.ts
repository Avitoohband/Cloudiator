import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { compareRestore, countCopyRows, filterRestoreList, INVARIANTS, manifestCounts } from '../../scripts/restore-compare.mjs';

// Task 22.4: the restore comparison module behind scripts/restore-check.ps1, tested on fixture manifests with no Docker.

const SHA_SCHEMA = 'a'.repeat(64);
const SHA_DATA = 'b'.repeat(64);
const manifest = {
  format: 1,
  tables: { 'auth.users': 4, 'private.settled_slots': 40, 'public.gladiators': 4, 'public.wallet_ledger': 12 },
  files: { 'schema.dump': SHA_SCHEMA, 'data.dump': SHA_DATA },
};
const passing = () => Object.fromEntries(INVARIANTS.map(name => [name, { ok: true, violations: 0 }]));
type Observed = Parameters<typeof compareRestore>[1];
const observed = (over: Partial<Observed> = {}): Observed => ({
  counts: { ...manifest.tables }, checksums: { ...manifest.files }, invariants: passing(), ...over,
});
/** The guard probes of scripts/restore-resume.sql as a passing restore reports them (Task 22.4 review, Important 1). */
const probes = () => ({
  secondSettlement: { expected: 'primary-key', observed: 'primary-key' },
  deleteSettledSlot: { expected: 'guard', observed: 'guard' },
  deleteReceipt: { expected: 'guard', observed: 'guard' },
});
const replayed = { replayCheck: 'structural', status: 'replayed', slot: 1009, probes: probes(), duplicateGrants: 0, lostItems: 0,
  countsUnchanged: true };

describe('compareRestore', () => {
  it('passes when every count, checksum and invariant matches', () => {
    const result = compareRestore(manifest, observed());
    expect(result).toEqual({ ok: true, mismatches: [], checksums: { 'data.dump': true, 'schema.dump': true }, invariants: passing() });
  });

  it('reports a table missing from the restore', () => {
    const counts: Record<string, number> = { ...manifest.tables };
    delete counts['public.wallet_ledger'];
    const result = compareRestore(manifest, observed({ counts }));
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([{ table: 'public.wallet_ledger', expected: 12, actual: null }]);
  });

  it('reports a table the manifest does not list', () => {
    const result = compareRestore(manifest, observed({ counts: { ...manifest.tables, 'private.extra': 0 } }));
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([{ table: 'private.extra', expected: null, actual: 0 }]);
  });

  it('reports a changed count', () => {
    const result = compareRestore(manifest, observed({ counts: { ...manifest.tables, 'private.settled_slots': 39 } }));
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([{ table: 'private.settled_slots', expected: 40, actual: 39 }]);
  });

  it('reports a bad or missing checksum per file', () => {
    const bad = compareRestore(manifest, observed({ checksums: { 'schema.dump': SHA_SCHEMA, 'data.dump': 'c'.repeat(64) } }));
    expect(bad.ok).toBe(false);
    expect(bad.checksums).toEqual({ 'data.dump': false, 'schema.dump': true });
    const missing = compareRestore(manifest, observed({ checksums: { 'schema.dump': SHA_SCHEMA, 'data.dump': null } }));
    expect(missing.ok).toBe(false);
    expect(missing.checksums).toEqual({ 'data.dump': false, 'schema.dump': true });
    // Hex case does not matter (Get-FileHash prints upper case).
    expect(compareRestore(manifest, observed({ checksums: { 'schema.dump': SHA_SCHEMA.toUpperCase(), 'data.dump': SHA_DATA } })).ok).toBe(true);
  });

  it('reports a failed invariant', () => {
    const invariants = { ...passing(), walletReconciliation: { ok: false, violations: 1 } };
    const result = compareRestore(manifest, observed({ invariants }));
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([]);
    expect(result.invariants.walletReconciliation).toEqual({ ok: false, violations: 1 });
    expect(Object.entries(result.invariants).filter(([, value]) => !value.ok).map(([name]) => name)).toEqual(['walletReconciliation']);
  });

  it('fails closed on a missing or self-contradicting invariant', () => {
    const invariants: Record<string, { ok: boolean; violations: number }> = passing();
    delete invariants.seasonAwardsUnique;
    const missing = compareRestore(manifest, observed({ invariants }));
    expect(missing.ok).toBe(false);
    expect(missing.invariants.seasonAwardsUnique).toEqual({ ok: false, violations: null });
    const contradicting = compareRestore(manifest, observed({ invariants: { ...passing(), inventoryCap: { ok: true, violations: 2 } } }));
    expect(contradicting.ok).toBe(false);
    expect(contradicting.invariants.inventoryCap).toEqual({ ok: false, violations: 2 });
  });

  it('requires a replayed resume with no duplicate grant and no lost item when a resume is given', () => {
    expect(compareRestore(manifest, observed({ resume: replayed }))).toMatchObject({ ok: true, resume: { ...replayed, ok: true,
      probes: { secondSettlement: { ok: true }, deleteSettledSlot: { ok: true }, deleteReceipt: { ok: true } } } });
    expect(compareRestore(manifest, observed({ resume: { ...replayed, duplicateGrants: 1 } }))).toMatchObject({ ok: false, resume: { ok: false } });
    expect(compareRestore(manifest, observed({ resume: { ...replayed, lostItems: 2 } }))).toMatchObject({ ok: false, resume: { ok: false } });
    expect(compareRestore(manifest, observed({ resume: { ...replayed, countsUnchanged: false } }))).toMatchObject({ ok: false, resume: { ok: false } });
    expect(compareRestore(manifest, observed({ resume: { ...replayed, status: 'lease-held', slot: null } })))
      .toMatchObject({ ok: false, resume: { ok: false, status: 'lease-held' } });
  });

  it('fails the resume when a guard probe was not refused as expected, or is missing', () => {
    // A second settlement that went through: the settled-slot primary key is gone.
    const accepted = { ...replayed, probes: { ...probes(), secondSettlement: { expected: 'primary-key', observed: 'accepted' } } };
    expect(compareRestore(manifest, observed({ resume: accepted }))).toMatchObject({ ok: false,
      resume: { ok: false, probes: { secondSettlement: { observed: 'accepted', ok: false }, deleteReceipt: { ok: true } } } });
    // Refused, but by something other than the guard (here a foreign key): the guard itself is missing.
    const foreignKey = { ...replayed, probes: { ...probes(), deleteReceipt: { expected: 'guard', observed: '23503' } } };
    expect(compareRestore(manifest, observed({ resume: foreignKey }))).toMatchObject({ ok: false, resume: { probes: { deleteReceipt: { ok: false } } } });
    // Nothing to probe, a missing probe, or a probe that reports its own (wrong) expectation.
    const empty = { ...replayed, probes: { ...probes(), deleteSettledSlot: { expected: 'guard', observed: 'no-row' } } };
    expect(compareRestore(manifest, observed({ resume: empty })).ok).toBe(false);
    const { deleteReceipt: _dropped, ...two } = probes();
    expect(compareRestore(manifest, observed({ resume: { ...replayed, probes: two } }))).toMatchObject({ ok: false,
      resume: { probes: { deleteReceipt: { expected: 'guard', observed: null, ok: false } } } });
    const relabelled = { ...replayed, probes: { ...probes(), deleteSettledSlot: { expected: 'accepted', observed: 'accepted' } } };
    expect(compareRestore(manifest, observed({ resume: relabelled })).ok).toBe(false);
    expect(compareRestore(manifest, observed({ resume: { ...replayed, probes: undefined } })).ok).toBe(false);
  });

  it('refuses a malformed manifest instead of passing it', () => {
    expect(() => compareRestore({ format: 1, tables: {}, files: manifest.files }, observed())).toThrow('manifest');
    expect(() => compareRestore({ format: 1, tables: manifest.tables, files: {} }, observed())).toThrow('manifest');
    expect(() => compareRestore({ format: 1, tables: { 'public.gladiators': -1 }, files: manifest.files }, observed())).toThrow('manifest');
  });
});

describe('filterRestoreList', () => {
  // A pg_restore -l listing in the format of the local PostgreSQL 17 dumps (id; tableoid oid type schema name owner).
  const listing = [
    ';',
    '; Archive created at 2026-10-19 05:15:00 UTC',
    ';     dbname: postgres',
    ';',
    '7; 3079 17595 EXTENSION - pg_cron ',
    '5033; 0 0 COMMENT - EXTENSION pg_cron ',
    '6; 3079 17550 EXTENSION - pg_net ',
    '5034; 0 0 ACL - SCHEMA cron supabase_admin',
    '5037; 0 0 ACL - SCHEMA net supabase_admin',
    '5055; 0 0 ACL cron FUNCTION alter_job(job_id bigint, schedule text, command text, database text, username text, active boolean) supabase_admin',
    '2699; 826 17645 DEFAULT ACL cron DEFAULT PRIVILEGES FOR SEQUENCES supabase_admin',
    '367; 1255 17867 FUNCTION private cron_tick() postgres',
    '5149; 0 0 ACL private FUNCTION cron_tick() postgres',
    '534; 1255 16510 FUNCTION extensions grant_pg_cron_access() supabase_admin',
    '3917; 3466 16650 EVENT TRIGGER - issue_pg_cron_access supabase_admin',
    '6000; 0 17700 TABLE DATA cron job supabase_admin',
    '6001; 0 0 SEQUENCE SET cron jobid_seq supabase_admin',
    '6002; 0 17800 TABLE DATA public gladiators postgres',
    '',
  ].join('\n');

  it("excludes exactly pg_cron's extension, its comment, its schema ACL and every object inside the cron schema", () => {
    const { list, excluded } = filterRestoreList(listing);
    expect(excluded).toEqual([
      { id: 7, type: 'EXTENSION', schema: '-', name: 'pg_cron' },
      { id: 5033, type: 'COMMENT', schema: '-', name: 'EXTENSION pg_cron' },
      { id: 5034, type: 'ACL', schema: '-', name: 'SCHEMA cron' },
      { id: 5055, type: 'ACL', schema: 'cron', name: 'FUNCTION alter_job(job_id bigint, schedule text, command text, database text, username text, active boolean)' },
      { id: 2699, type: 'DEFAULT ACL', schema: 'cron', name: 'DEFAULT PRIVILEGES FOR SEQUENCES' },
      { id: 6000, type: 'TABLE DATA', schema: 'cron', name: 'job' },
      { id: 6001, type: 'SEQUENCE SET', schema: 'cron', name: 'jobid_seq' },
    ]);
    // Everything else stays, in order, including the header and objects whose names merely mention cron.
    expect(list.split('\n')).toEqual(listing.split('\n').filter(line => !/^(7|5033|5034|5055|2699|6000|6001);/.test(line)));
  });

  it('keeps a listing without pg_cron unchanged', () => {
    const plain = '; header\n6; 3079 17550 EXTENSION - pg_net \n6002; 0 17800 TABLE DATA public gladiators postgres\n';
    expect(filterRestoreList(plain)).toEqual({ list: plain, excluded: [] });
  });
});

describe('countCopyRows and manifestCounts', () => {
  const restored = [
    'SET statement_timeout = 0;',
    'COPY auth.users (instance_id, id) FROM stdin;',
    '00000000-0000-0000-0000-000000000000\tuser-a',
    '00000000-0000-0000-0000-000000000000\tuser-b',
    '\\.',
    'COPY public.gladiators (id, name) FROM stdin;',
    '\\.',
    'COPY "private"."settled_slots" (gladiator_id) FROM stdin;',
    'COPY looks like a statement but is data',
    '\\\\.',
    '\\.',
    'COPY auth.identities (id) FROM stdin;',
    'identity-a',
    '\\.',
    'COPY supabase_migrations.schema_migrations (version) FROM stdin;',
    '20261018191110',
    '\\.',
    "SELECT pg_catalog.setval('private.dispatch_log_id_seq', 1, false);",
    '',
  ].join('\n');

  it('counts the data rows of every COPY block, empty tables included', () => {
    expect(countCopyRows(restored)).toEqual({ 'auth.users': 2, 'public.gladiators': 0, 'private.settled_slots': 2, 'auth.identities': 1,
      'supabase_migrations.schema_migrations': 1 });
  });

  it('refuses a truncated data dump', () => {
    expect(() => countCopyRows('COPY public.gladiators (id) FROM stdin;\nrow\n')).toThrow('truncated');
  });

  it('keeps every public and private table plus auth.users for the manifest', () => {
    expect(manifestCounts(countCopyRows(restored))).toEqual({ 'auth.users': 2, 'private.settled_slots': 2, 'public.gladiators': 0 });
  });
});

describe('restore-compare.mjs verify (the checksum gate before anything is restored)', () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); });
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  function backup(files: Record<string, string>, listed: Record<string, string>) {
    const directory = mkdtempSync(join(tmpdir(), 'cloudiator-backup-'));
    directories.push(directory);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ format: 1, tables: { 'public.gladiators': 1 }, files: listed }));
    return directory;
  }
  const verify = (directory: string) => {
    const run = spawnSync(process.execPath, [resolve('scripts/restore-compare.mjs'), 'verify', directory], { encoding: 'utf8' });
    return { status: run.status, output: JSON.parse(run.stdout) };
  };

  it('passes intact dumps, fails a changed or missing one with exit 1, and refuses a manifest that skips a dump', () => {
    const files = { 'schema.dump': 'schema', 'data.dump': 'data' };
    const listed = { 'schema.dump': sha('schema'), 'data.dump': sha('data') };
    expect(verify(backup(files, listed))).toEqual({ status: 0, output: { ok: true, checksums: { 'data.dump': true, 'schema.dump': true } } });
    expect(verify(backup({ ...files, 'data.dump': 'data!' }, listed))).toEqual({ status: 1,
      output: { ok: false, code: 'checksum-mismatch', checksums: { 'data.dump': false, 'schema.dump': true } } });
    expect(verify(backup({ 'schema.dump': 'schema' }, listed))).toMatchObject({ status: 1, output: { checksums: { 'data.dump': false } } });
    // A manifest listing only one dump would let restore-check.ps1 restore the other unverified.
    expect(verify(backup(files, { 'schema.dump': sha('schema') }))).toEqual({ status: 2, output: { ok: false, code: 'manifest-invalid' } });
  });
});

describe('restore-compare.mjs manifest commit', () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); });

  it("records this repository's commit wherever the operator runs the script from (final review, Minor 2)", () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: resolve('.'), encoding: 'utf8' }).stdout.trim();
    const elsewhere = mkdtempSync(join(tmpdir(), 'cloudiator-cwd-'));
    directories.push(elsewhere);
    const module = JSON.stringify(pathToFileURL(resolve('scripts/restore-compare.mjs')).href);
    const run = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { repositoryCommit } from ${module}; process.stdout.write(JSON.stringify(repositoryCommit()));`], { cwd: elsewhere, encoding: 'utf8' });
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(JSON.parse(run.stdout)).toEqual({ commit: head, dirty: expect.any(Boolean) });
  });
});
