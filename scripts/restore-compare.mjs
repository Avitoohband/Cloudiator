import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Task 22.4: the export manifest and the restore comparison behind scripts/export-db.ps1 and scripts/restore-check.ps1
// (plan 2026-10-18-task-22-retention-operations, Decision 9). Everything this module prints is counts, booleans, hex
// checksums, table names and short codes: never a connection string, key, password or raw error text.

/** Invariant names scripts/restore-invariants.sql reports. A missing one fails the comparison (fail closed). */
export const INVARIANTS = Object.freeze(['settledSlotsUnique', 'completedActivitiesGuarded', 'ledgerReceiptsUnique', 'walletReconciliation',
  'itemsSingleOwner', 'inventoryCap', 'seasonAwardsUnique', 'foreignKeys', 'guardsIntact']);

/**
 * Table data the export leaves out (pg_dump --exclude-table-data), recorded in every manifest:
 * - vault.secrets: Vault ciphertext is bound to the source server's root key and would not decrypt elsewhere. The two
 *   secrets are re-created by name after a restore (docs/operations/runbook.md, "Secret rotation").
 * - auth sessions, refresh tokens and short-lived sign-in flow tokens: bearer material with no game state. After a restore
 *   players sign in again. The tables are closed under their foreign keys (mfa_amr_claims and refresh_tokens reference
 *   sessions; saml_relay_states references flow_state).
 */
export const EXPORT_DATA_EXCLUSIONS = Object.freeze(['vault.secrets', 'auth.sessions', 'auth.refresh_tokens', 'auth.mfa_amr_claims',
  'auth.one_time_tokens', 'auth.flow_state', 'auth.saml_relay_states']);

/**
 * Objects the restore check leaves out, and only these (docs/operations/runbook.md, "Restore check"). pg_cron can be
 * created only in the database named by cron.database_name (`postgres`): CREATE EXTENSION pg_cron fails in
 * cloudiator_restore_check with "can only create extension in database postgres", and with it every object inside its
 * `cron` schema (function and table ACLs, default privileges, the cron.job schedule and cron.job_run_details data, sequence
 * values). The two schedules stay in the backup; a restore into a real `postgres` database restores them.
 * pg_net, supabase_vault, pgcrypto, uuid-ossp and pg_stat_statements restore normally and are not excluded.
 */
export const RESTORE_EXCLUSIONS = Object.freeze([
  { type: 'EXTENSION', schema: '-', name: 'pg_cron' },
  { type: 'COMMENT', schema: '-', name: 'EXTENSION pg_cron' },
  { type: 'SCHEMA', schema: '-', name: 'cron' },
  { type: 'ACL', schema: '-', name: 'SCHEMA cron' },
  { type: 'COMMENT', schema: '-', name: 'SCHEMA cron' },
  { type: '*', schema: 'cron', name: '*' },
]);

/**
 * The behavioural guard probes of scripts/restore-resume.sql and the refusal each must observe (Task 22.4 review,
 * Important 1). The structural replay (advance_boundary on a published slot) returns before any grant table is touched, so
 * these probes are what show that a second grant cannot happen in the restored copy.
 */
export const PROBES = Object.freeze({ secondSettlement: 'primary-key', deleteSettledSlot: 'guard', deleteReceipt: 'guard' });

const fail = message => { throw new TypeError(`invalid manifest: ${message}`); };
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const SHA256 = /^[0-9a-f]{64}$/i;

/**
 * Compares a restore with its export manifest.
 *   manifest: {tables: {"schema.table": rows}, files: {"name": sha256}}
 *   observed: {counts: {"schema.table": rows}, checksums: {"name": sha256 | null}, invariants: {name: {ok, violations}},
 *              resume?: {replayCheck, status, slot, probes: {name: {expected, observed}}, duplicateGrants, lostItems,
 *                        countsUnchanged}}
 * Returns {ok, mismatches: [{table, expected, actual}], checksums: {file: ok}, invariants, resume?}. A table on only one side
 * is a mismatch with null on the other; a missing invariant fails; a resume must be 'replayed' (structurally) with every
 * guard probe refused as PROBES expects, no new grant, no lost item and unchanged counts. A malformed manifest throws
 * instead of passing.
 */
export function compareRestore(manifest, observed) {
  const tables = manifest?.tables, files = manifest?.files;
  if (!tables || typeof tables !== 'object' || Object.keys(tables).length === 0) fail('no tables');
  if (!files || typeof files !== 'object' || Object.keys(files).length === 0) fail('no files');
  for (const [table, rows] of Object.entries(tables)) if (!isCount(rows)) fail(`count of ${table}`);
  for (const [file, sha] of Object.entries(files)) if (typeof sha !== 'string' || !SHA256.test(sha)) fail(`checksum of ${file}`);
  const counts = observed?.counts ?? {};
  const mismatches = [...new Set([...Object.keys(tables), ...Object.keys(counts)])].sort().flatMap(table => {
    const expected = Object.hasOwn(tables, table) ? tables[table] : null;
    const actual = Object.hasOwn(counts, table) && isCount(counts[table]) ? counts[table] : null;
    return expected === actual ? [] : [{ table, expected, actual }];
  });
  const sums = observed?.checksums ?? {};
  const checksums = Object.fromEntries(Object.keys(files).sort().map(file =>
    [file, typeof sums[file] === 'string' && sums[file].toLowerCase() === files[file].toLowerCase()]));
  const reported = observed?.invariants ?? {};
  const invariants = Object.fromEntries([...new Set([...INVARIANTS, ...Object.keys(reported)])].map(name => {
    const value = reported[name];
    const violations = isCount(value?.violations) ? value.violations : null;
    return [name, { ok: value?.ok === true && violations === 0, violations }];
  }));
  const result = { ok: false, mismatches, checksums, invariants };
  let resumed = true;
  if (observed && 'resume' in observed) {
    const resume = observed.resume ?? {};
    const reportedProbes = resume.probes ?? {};
    // Each probe is judged against its expectation here, not against what the SQL reported as expected.
    const probes = Object.fromEntries(Object.entries(PROBES).map(([name, expected]) => {
      const observedValue = typeof reportedProbes[name]?.observed === 'string' ? reportedProbes[name].observed : null;
      return [name, { expected, observed: observedValue, ok: observedValue === expected && reportedProbes[name]?.expected === expected }];
    }));
    const ok = resume.status === 'replayed' && resume.duplicateGrants === 0 && resume.lostItems === 0 && resume.countsUnchanged === true
      && Object.values(probes).every(probe => probe.ok);
    result.resume = { ...resume, probes, ok };
    resumed = ok;
  }
  result.ok = mismatches.length === 0 && Object.values(checksums).every(Boolean) && Object.values(invariants).every(i => i.ok) && resumed;
  return result;
}

// pg_restore -l lines: "<id>; <tableoid> <oid> <TYPE> <schema or -> <name> <owner>", the owner empty (a trailing space) for
// objects without one. TYPE is one or more upper-case words (TABLE DATA, DEFAULT ACL, SEQUENCE SET, EVENT TRIGGER, ...).
const ENTRY = /^(\d+); \d+ \d+ ([A-Z][A-Z ]*[A-Z]) (\S+) (.*)$/;
const excludedBy = (entry, rule) => (rule.type === '*' || rule.type === entry.type) && rule.schema === entry.schema
  && (rule.name === '*' || rule.name === entry.name);

/** One pg_restore -l entry as {id, type, schema, name}, or null for a comment or blank line. */
function listEntry(line) {
  const match = ENTRY.exec(line.replace(/\r$/, ''));
  if (!match) return null;
  const [, id, type, schema, rest] = match;
  const owner = rest.endsWith(' ') ? '' : rest.slice(rest.lastIndexOf(' ') + 1);
  const name = owner ? rest.slice(0, rest.length - owner.length - 1) : rest.trimEnd();
  return { id: Number(id), type, schema, name };
}

/** Removes the RESTORE_EXCLUSIONS entries from a pg_restore -l listing. Returns the listing to restore and what was left out. */
export function filterRestoreList(listing) {
  const excluded = [];
  const kept = listing.split('\n').filter(line => {
    const entry = listEntry(line);
    if (!entry || !RESTORE_EXCLUSIONS.some(rule => excludedBy(entry, rule))) return true;
    excluded.push(entry);
    return false;
  });
  return { list: kept.join('\n'), excluded };
}

/**
 * The data a hosted restore (Task 24.10, scripts/restore-hosted.ps1) loads into a new project after `db push`: the game's
 * tables and sequences, and the accounts with their Google identities, so a player's next Google sign-in lands on the same
 * account and character. The new project already holds its migration history, its platform tables and the two cron
 * schedules (the migrations create them), and nothing else of the backup is game state: the other sign-in tables (audit log,
 * MFA, OAuth and SSO, auth's own migration history) are left out and reported, and players sign in again.
 */
export const HOSTED_RESTORE_DATA = Object.freeze({ schemas: Object.freeze(['public', 'private']),
  tables: Object.freeze(['auth.users', 'auth.identities']) });

const hostedKeeps = entry => (entry.type === 'TABLE DATA' || entry.type === 'SEQUENCE SET')
  && (HOSTED_RESTORE_DATA.schemas.includes(entry.schema)
    || (entry.type === 'TABLE DATA' && HOSTED_RESTORE_DATA.tables.includes(`${entry.schema}.${entry.name}`)));

/**
 * Keeps only HOSTED_RESTORE_DATA's entries of a data dump's pg_restore -l listing, in the listing's own order (pg_dump sorts
 * a data-only dump's tables by their foreign keys). Returns the listing to restore, what it keeps and what it leaves out.
 */
export function filterHostedList(listing) {
  const kept = [], leftOut = [];
  const list = listing.split('\n').filter(line => {
    const entry = listEntry(line);
    if (!entry) return true;
    (hostedKeeps(entry) ? kept : leftOut).push(entry);
    return hostedKeeps(entry);
  });
  return { list: list.join('\n'), kept, leftOut };
}

/**
 * Whether a hosted project may receive a backup (Task 24.10): a new project, exactly at the backup's migrations, with no
 * account, no character, no season epoch and the scheduler off. Anything else could be a live database, so it is refused.
 *   facts: {migrations: [{version, name}], accounts, characters, epochSet, schedulerEnabled} (scripts/restore-hosted.ps1)
 */
export function checkHostedTarget(manifest, facts) {
  const versions = list => Array.isArray(list) && list.every(m => typeof m?.version === 'string') ? list.map(m => m.version) : null;
  const expected = versions(manifest?.migrations);
  if (!expected || expected.length === 0) return { ok: false, code: 'manifest-invalid' };
  const actual = versions(facts?.migrations);
  if (!actual || !isCount(facts.accounts) || !isCount(facts.characters) || typeof facts.epochSet !== 'boolean'
    || typeof facts.schedulerEnabled !== 'boolean') return { ok: false, code: 'target-facts-invalid' };
  if (facts.accounts > 0 || facts.characters > 0 || facts.epochSet || facts.schedulerEnabled) return { ok: false, code: 'target-not-fresh' };
  if (actual.join(',') !== expected.join(',')) return { ok: false, code: 'migrations-mismatch' };
  return { ok: true, migrations: expected.length };
}

/** Counts data rows per COPY block in pg_restore's SQL output, line by line. A block without its terminator throws. */
export function copyRowCounter() {
  const counts = {};
  let table = null;
  return {
    line(raw) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (table === null) {
        const copy = /^COPY (\S+) .*FROM stdin;$/.exec(line);
        if (copy) { table = copy[1].replaceAll('"', ''); counts[table] = 0; }
      } else if (line === '\\.') table = null;
      else counts[table] += 1;
    },
    result() {
      if (table !== null) throw new Error(`truncated data dump: ${table}`);
      return counts;
    },
  };
}
export function countCopyRows(text) {
  const counter = copyRowCounter();
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) counter.line(line);
  return counter.result();
}

/** The manifest's tables: every public and private table plus auth.users, sorted by name. */
export function manifestCounts(counts) {
  return Object.fromEntries(Object.entries(counts).filter(([table]) => /^(public|private)\./.test(table) || table === 'auth.users')
    .sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------------------------------------------------
// CLI used by the two PowerShell scripts. Container paths and file names are validated; outputs are JSON on stdout, and a
// failure prints only a short code.

const CONTAINER = 'supabase_db_Cloudiator';
const CONTAINER_DUMP = /^\/tmp\/cloudiator-(export|restore)-\d{8}T\d{6}Z\/[a-z]+\.dump$/;
const DUMPS = ['data.dump', 'schema.dump'];

const sha256 = path => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(path).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
});

/** Row counts of a custom-format data dump inside the local container (pg_restore -f - | count the COPY rows). */
function dumpCounts(dumpPath) {
  if (!CONTAINER_DUMP.test(dumpPath)) throw new Error('usage');
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', CONTAINER, 'pg_restore', '-f', '-', dumpPath], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const counter = copyRowCounter();
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => counter.line(line));
    child.on('error', reject);
    child.on('close', status => {
      if (status !== 0) return reject(new Error('count-failed'));
      try { resolve(counter.result()); } catch (error) { reject(error); }
    });
  });
}

/** The repository this script belongs to: git runs there, whichever directory the operator runs the script from. */
const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
function git(args) {
  const result = spawnSync('git', args, { cwd: REPOSITORY, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}
/** The manifest's `commit` and `dirty`: the repository's HEAD and whether its tracked files differ from it (null without git). */
export function repositoryCommit() {
  const commit = git(['rev-parse', 'HEAD']);
  return { commit, dirty: commit === null ? null : git(['status', '--porcelain', '--untracked-files=no']) !== '' };
}
/** JSON from a file written by psql, node or PowerShell (a UTF-8 byte order mark is ignored). */
function readJson(path) {
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}
/** The manifest of a backup directory. It must list exactly the two dumps restore-check.ps1 restores, so none goes unverified. */
function readManifest(dir) {
  const manifest = readJson(join(dir, 'manifest.json'));
  if (Object.keys(manifest?.files ?? {}).sort().join(',') !== DUMPS.join(',')) throw new TypeError('invalid manifest: files');
  return manifest;
}
async function fileChecksums(dir, manifest) {
  const sums = {};
  for (const file of Object.keys(manifest.files ?? {})) sums[file] = existsSync(join(dir, file)) ? await sha256(join(dir, file)) : null;
  return sums;
}
const total = counts => Object.values(counts).reduce((a, b) => a + b, 0);

const commands = {
  /** dump-args: the pg_dump --exclude-table-data arguments, one per line. */
  async 'dump-args'() {
    process.stdout.write(EXPORT_DATA_EXCLUSIONS.map(table => `--exclude-table-data=${table}`).join('\n') + '\n');
    return 0;
  },
  /**
   * manifest <backupDir> <facts.json> <local|remote> <containerDataDump>: writes <backupDir>/manifest.json from the two dump
   * files there, the data dump's COPY row counts and the database facts (server version, applied migrations).
   */
  async manifest(dir, factsPath, source, dataDump) {
    if (!['local', 'remote'].includes(source)) throw new Error('usage');
    const facts = readJson(factsPath);
    const counts = manifestCounts(await dumpCounts(dataDump));
    const files = {};
    for (const file of DUMPS) files[file] = await sha256(join(dir, file));
    const { commit, dirty } = repositoryCommit();
    const manifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      source,
      commit,
      dirty,
      serverVersion: facts.serverVersion,
      migrations: facts.migrations,
      excludedData: EXPORT_DATA_EXCLUSIONS,
      tables: counts,
      files,
    };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ ok: true, backup: basename(dir), source, commit, tables: Object.keys(counts).length,
      rows: total(counts), migrations: facts.migrations?.length ?? 0, files }, null, 2) + '\n');
    return 0;
  },
  /** exclude <workDir> <schema|data>: filters <kind>.toc into <kind>.list and writes <kind>-excluded.json. */
  async exclude(work, kind) {
    if (!['schema', 'data'].includes(kind)) throw new Error('usage');
    const { list, excluded } = filterRestoreList(readFileSync(join(work, `${kind}.toc`), 'utf8'));
    writeFileSync(join(work, `${kind}.list`), list.endsWith('\n') ? list : list + '\n');
    writeFileSync(join(work, `${kind}-excluded.json`), JSON.stringify(excluded) + '\n');
    process.stdout.write(JSON.stringify({ ok: true, kind, excluded: excluded.length }) + '\n');
    return 0;
  },
  /** hosted-target <backupDir> <facts.json>: whether the hosted project may receive this backup (checkHostedTarget). */
  async 'hosted-target'(dir, factsPath) {
    const verdict = checkHostedTarget(readManifest(dir), readJson(factsPath));
    process.stdout.write(JSON.stringify(verdict) + '\n');
    return verdict.ok ? 0 : 1;
  },
  /** hosted-list <workDir>: filters data.toc into data.list (filterHostedList) and writes data-left-out.json. */
  async 'hosted-list'(work) {
    const { list, kept, leftOut } = filterHostedList(readFileSync(join(work, 'data.toc'), 'utf8'));
    writeFileSync(join(work, 'data.list'), list.endsWith('\n') ? list : list + '\n');
    writeFileSync(join(work, 'data-left-out.json'), JSON.stringify(leftOut) + '\n');
    process.stdout.write(JSON.stringify({ ok: true, kept: kept.length, leftOut: leftOut.length }) + '\n');
    return 0;
  },
  /**
   * hosted-compare <backupDir> <workDir>: the hosted restore's report from <workDir>/invariants.json (scripts/restore-invariants.sql
   * on the project) and data-left-out.json. The load leaves the scheduler off; the next step is the Vault secrets (runbook).
   */
  async 'hosted-compare'(dir, work) {
    const manifest = readManifest(dir);
    const restored = readJson(join(work, 'invariants.json'));
    const leftOut = readJson(join(work, 'data-left-out.json'));
    const result = compareRestore(manifest, { counts: restored.counts, checksums: await fileChecksums(dir, manifest),
      invariants: restored.invariants });
    const report = {
      ok: result.ok,
      backup: { name: basename(dir), createdAt: manifest.createdAt, source: manifest.source, commit: manifest.commit,
        migrations: manifest.migrations?.length ?? 0 },
      counts: { tables: Object.keys(manifest.tables).length, rows: total(manifest.tables),
        restoredTables: Object.keys(restored.counts ?? {}).length, restoredRows: total(restored.counts ?? {}), mismatched: result.mismatches.length },
      mismatches: result.mismatches,
      checksums: result.checksums,
      invariants: result.invariants,
      leftOut: { entries: leftOut.length, tables: leftOut.filter(e => e.type === 'TABLE DATA').map(e => `${e.schema}.${e.name}`) },
      scheduler: 'off',
      next: 'vault-secrets',
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return result.ok ? 0 : 1;
  },
  /** verify <backupDir>: the files' checksums against the manifest, before anything is restored. */
  async verify(dir) {
    const manifest = readManifest(dir);
    const sums = await fileChecksums(dir, manifest);
    const checksums = Object.fromEntries(Object.keys(manifest.files).sort().map(file =>
      [file, typeof sums[file] === 'string' && sums[file] === String(manifest.files[file]).toLowerCase()]));
    const ok = Object.values(checksums).every(Boolean);
    process.stdout.write(JSON.stringify({ ok, ...(ok ? {} : { code: 'checksum-mismatch' }), checksums }) + '\n');
    return ok ? 0 : 1;
  },
  /**
   * compare <backupDir> <workDir> <dropped|kept>: the restore check's report from <workDir>/invariants.json, resume.json and
   * the two *-excluded.json files.
   */
  async compare(dir, work, database) {
    if (!['dropped', 'kept'].includes(database)) throw new Error('usage');
    const manifest = readManifest(dir);
    const restored = readJson(join(work, 'invariants.json'));
    const resume = readJson(join(work, 'resume.json'));
    const excluded = { schema: readJson(join(work, 'schema-excluded.json')), data: readJson(join(work, 'data-excluded.json')) };
    const result = compareRestore(manifest, { counts: restored.counts, checksums: await fileChecksums(dir, manifest),
      invariants: restored.invariants, resume });
    const report = {
      ok: result.ok,
      backup: { name: basename(dir), createdAt: manifest.createdAt, source: manifest.source, commit: manifest.commit,
        migrations: manifest.migrations?.length ?? 0 },
      counts: { tables: Object.keys(manifest.tables).length, rows: total(manifest.tables),
        restoredTables: Object.keys(restored.counts ?? {}).length, restoredRows: total(restored.counts ?? {}), mismatched: result.mismatches.length },
      mismatches: result.mismatches,
      checksums: result.checksums,
      invariants: result.invariants,
      resume: result.resume,
      duplicateGrants: resume?.duplicateGrants ?? null,
      lostItems: resume?.lostItems ?? null,
      excluded: { schema: excluded.schema.length, data: excluded.data.length, entries: [...excluded.schema, ...excluded.data] },
      database: { name: 'cloudiator_restore_check', state: database },
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return result.ok ? 0 : 1;
  },
};

async function main([verb, ...args]) {
  const command = Object.hasOwn(commands, verb) ? commands[verb] : null;
  if (!command || args.length !== command.length) {
    process.stdout.write(JSON.stringify({ ok: false, code: 'usage' }) + '\n');
    return 2;
  }
  try {
    return await command(...args);
  } catch (error) {
    // Short codes only: a path, a file's content or a tool's message never reaches the output.
    const code = error?.message === 'usage' ? 'usage'
      : error instanceof TypeError && /^invalid manifest/.test(error.message) ? 'manifest-invalid'
        : error instanceof SyntaxError ? 'json-invalid' : error?.code === 'ENOENT' ? 'file-missing' : `${verb}-failed`;
    process.stdout.write(JSON.stringify({ ok: false, code }) + '\n');
    return 2;
  }
}

const invokedDirectly = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (invokedDirectly()) main(process.argv.slice(2)).then(code => { process.exitCode = code; });
