#!/usr/bin/env node
/**
 * Installs the worker secret on a hosted project without ever displaying it (Task 24.5). The operator (Avi) runs it with
 * their own Supabase CLI login, in the worktree linked to that project:
 *
 *   node scripts/set-worker-secret.mjs --project-ref <ref>
 *
 * It generates a fresh random value and sets the same value in both places that must agree:
 * - the Edge function secret `GAME_WORKER_SECRET` (`supabase secrets set --env-file`), and
 * - the Vault secret `game_worker_secret`, together with `game_worker_url` (the worker endpoint), read by
 *   `private.dispatch_workers` (`supabase db query --linked`; created when absent, updated when present).
 * The value lives only in a private temporary folder for the duration of the run and is deleted afterwards; no output line
 * carries it (a line that would is replaced). It refuses to run unless the worktree is linked to exactly `--project-ref`, so
 * it cannot write one project's Vault while setting another project's Edge secret. Run it with the scheduler off (before
 * activation, or paused for a rotation): a dispatch between the two writes would be refused by the worker and retried.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REF = /^[a-z]{20}$/;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const at = argv.indexOf('--project-ref');
  const ref = at >= 0 ? argv[at + 1] : undefined;
  if (!ref || !REF.test(ref)) throw new Error('usage: node scripts/set-worker-secret.mjs --project-ref <20-letter project ref>');
  return { ref };
}

/**
 * The Vault statement: one SELECT, so the CLI sends a single statement and `pg_stat_statements` stores its literals as
 * placeholders (a DO block would be stored word for word, secret included). Each name is updated when present at the
 * start of the statement and created otherwise. Both values are plain base64url / URL text.
 */
export function vaultSql(url, secret) {
  if (!/^[A-Za-z0-9_-]{32,}$/.test(secret)) throw new Error('unexpected secret shape');
  if (!/^https:\/\/[a-z]{20}\.supabase\.co\/functions\/v1\/game-worker$/.test(url)) throw new Error('unexpected worker url');
  return `with wanted(name, value) as (
  values ('game_worker_url', '${url}'), ('game_worker_secret', '${secret}')
),
updated as (
  select vault.update_secret(s.id, w.value) from wanted w join vault.secrets s on s.name = w.name
),
created as (
  select vault.create_secret(w.value, w.name) from wanted w
  where not exists (select 1 from vault.secrets s where s.name = w.name)
)
select (select count(*) from updated) as updated, (select count(*) from created) as created;
`;
}

/**
 * Runs the installed Supabase CLI through Node, without a shell, so no argument needs quoting.
 * @param {string[]} args
 * @param {(command: string, args: string[], options: { encoding: 'utf8' }) =>
 *   { status: number | null, stdout?: string, stderr?: string, error?: Error }} [spawn]
 */
export function runCli(args, spawn = spawnSync) {
  const result = spawn(process.execPath, [join('node_modules', 'supabase', 'dist', 'supabase.js'), ...args], { encoding: 'utf8' });
  return {
    status: result.status ?? null,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${result.error ? `${result.error.message}\n` : ''}`,
  };
}

/** Replaces any occurrence of the secret in a text before it is printed. */
export function scrub(text, secret) {
  return secret ? String(text).split(secret).join('<hidden>') : String(text);
}

/**
 * @param {{ ref: string }} options
 * @param {{ run: (args: string[]) => { status: number | null, stdout: string, stderr: string }, linkedRef: () => string | null,
 *   log: (line: string) => void, secret?: string, dir?: string }} io
 */
export function setWorkerSecret({ ref }, io) {
  const linked = io.linkedRef();
  if (linked !== ref) {
    io.log(`refused: this worktree is linked to ${linked ?? 'no project'}, not ${ref}; run supabase link --project-ref ${ref} first`);
    return 1;
  }
  const secret = io.secret ?? randomBytes(32).toString('base64url');
  const dir = io.dir ?? mkdtempSync(join(tmpdir(), 'cloudiator-worker-secret-'));
  const detail = result => {
    for (const line of scrub(`${result.stderr}\n${result.stdout}`, secret).split('\n').filter(Boolean).slice(-6)) io.log(`       ${line}`);
  };
  const step = (label, args) => {
    const result = io.run(args);
    const ok = result.status === 0;
    io.log(`${ok ? 'ok    ' : 'failed'} ${label}`);
    if (!ok) detail(result);
    return ok;
  };
  const database = ['db', 'query', '--linked', '--project-ref', ref];
  try {
    const envFile = join(dir, 'worker.env');
    writeFileSync(envFile, `GAME_WORKER_SECRET=${secret}\n`, { mode: 0o600, flag: 'wx' });
    if (!step('Edge secret GAME_WORKER_SECRET', ['secrets', 'set', '--env-file', envFile, '--project-ref', ref])) {
      io.log('       Vault did not change, but the Edge secret may have: keep the scheduler off and rerun this script.');
      return 1;
    }
    const sqlFile = join(dir, 'vault.sql');
    writeFileSync(sqlFile, vaultSql(`https://${ref}.supabase.co/functions/v1/game-worker`, secret), { mode: 0o600, flag: 'wx' });
    if (!step('Vault secrets game_worker_url and game_worker_secret', [...database, '--file', sqlFile])) {
      io.log('       The Edge secret changed but Vault did not, so the worker refuses dispatches: keep the scheduler off and rerun this script.');
      return 1;
    }
    const checkFile = join(dir, 'check.sql');
    writeFileSync(checkFile, "select count(*) as present from vault.secrets where name in ('game_worker_url', 'game_worker_secret');\n",
      { mode: 0o600, flag: 'wx' });
    const check = io.run([...database, '--output-format', 'json', '--file', checkFile]);
    const present = check.status === 0 ? /"present":\s*"?(\d+)/.exec(check.stdout)?.[1] : undefined;
    if (present === '2') {
      io.log('ok     both Vault names present');
      return 0;
    }
    io.log(`failed both Vault names present (found ${present ?? 'none'})`);
    detail(check);
    return 1;
  } finally {
    if (!io.dir) rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv) {
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  const linkedRef = () => {
    const file = join('supabase', '.temp', 'project-ref');
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
  };
  // Ctrl+C stops the running CLI call, which then fails its step; staying alive lets `finally` delete the private folder.
  process.on('SIGINT', () => {});
  return setWorkerSecret(options, { run: args => runCli(args), linkedRef, log: line => console.log(line) });
}

const invokedDirectly = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
};
if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
