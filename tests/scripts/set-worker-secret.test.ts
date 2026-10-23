import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, runCli, scrub, setWorkerSecret, vaultSql } from '../../scripts/set-worker-secret.mjs';

const REF = 'uukrqribdfqovahzjsrx';
const SECRET = 'S'.repeat(43);

/** Mirrors CLI 2.120.0: `db query` prints JSON rows only with `--output-format json`; in a person's terminal it prints a table. */
function countOutput(args: string[], present: string) {
  const at = args.indexOf('--output-format');
  return at >= 0 && args[at + 1] === 'json'
    ? `[\n  {\n    "present": ${present}\n  }\n]\n`
    : `┌─────────┐\n│ present │\n├─────────┤\n│ ${present.padStart(7)} │\n└─────────┘\n`;
}

function fake(options: { linked?: string | null; fail?: string; present?: string } = {}) {
  const calls: string[][] = [];
  const lines: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'set-worker-secret-test-'));
  const io = {
    secret: SECRET, dir,
    linkedRef: () => (options.linked === undefined ? REF : options.linked),
    log: (line: string) => lines.push(line),
    run: (args: string[]) => {
      calls.push(args);
      const file = args.includes('--file') ? readFileSync(args[args.indexOf('--file') + 1], 'utf8') : '';
      const isCheck = file.includes('count(*)');
      if (options.fail === 'secrets' && args[0] === 'secrets') return { status: 1, stdout: '', stderr: `boom ${SECRET} boom` };
      if (options.fail === 'vault' && file.includes('create_secret')) return { status: 1, stdout: '', stderr: `boom ${SECRET} boom` };
      if (options.fail === 'check' && isCheck) return { status: 1, stdout: '', stderr: 'unauthorized' };
      return { status: 0, stdout: isCheck ? countOutput(args, options.present ?? '2') : '', stderr: '' };
    },
  };
  return { io, calls, lines, dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const madeFolders = () => readdirSync(tmpdir()).filter(n => n.startsWith('cloudiator-worker-secret-')).length;

describe('set-worker-secret', () => {
  it('requires a 20-letter project ref', () => {
    expect(parseArgs(['--project-ref', REF])).toEqual({ ref: REF });
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(['--project-ref', 'ABC'])).toThrow(/usage/);
  });

  it('refuses a worktree linked to another project, before writing anything', () => {
    const f = fake({ linked: 'aaaaaaaaaaaaaaaaaaaa' });
    expect(setWorkerSecret({ ref: REF }, f.io)).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.lines.join('\n')).toMatch(/refused/);
    f.done();
  });

  it('sets the Edge secret and both Vault secrets from one value, and never prints it', () => {
    const f = fake();
    expect(setWorkerSecret({ ref: REF }, f.io)).toBe(0);
    expect(f.calls.map(c => c.slice(0, 2))).toEqual([['secrets', 'set'], ['db', 'query'], ['db', 'query']]);
    expect(f.calls[0]).toEqual(expect.arrayContaining(['--project-ref', REF, '--env-file']));
    expect(readFileSync(join(f.dir, 'worker.env'), 'utf8')).toBe(`GAME_WORKER_SECRET=${SECRET}\n`);
    const sql = readFileSync(join(f.dir, 'vault.sql'), 'utf8');
    expect(sql).toContain(`'${SECRET}'`);
    expect(sql).toContain(`https://${REF}.supabase.co/functions/v1/game-worker`);
    expect(f.lines.join('\n')).not.toContain(SECRET);
    f.done();
  });

  it('names the project on every database call and keeps the secret out of all arguments', () => {
    const f = fake();
    setWorkerSecret({ ref: REF }, f.io);
    for (const call of f.calls.slice(1)) expect(call).toEqual(expect.arrayContaining(['--linked', '--project-ref', REF]));
    expect(f.calls.flat().join(' ')).not.toContain(SECRET);
    f.done();
  });

  it('reads the Vault check as JSON, so it passes in a person\'s terminal too', () => {
    const f = fake();
    expect(setWorkerSecret({ ref: REF }, f.io)).toBe(0);
    expect(f.calls[2]).toEqual(expect.arrayContaining(['--output-format', 'json']));
    expect(f.lines.at(-1)).toMatch(/^ok\s+both Vault names present/);
    f.done();
  });

  it('hides the secret in a failure message and stops', () => {
    const f = fake({ fail: 'secrets' });
    expect(setWorkerSecret({ ref: REF }, f.io)).toBe(1);
    expect(f.calls).toHaveLength(1);
    expect(f.lines.join('\n')).toMatch(/rerun this script/i);
    expect(f.lines.join('\n')).toContain('<hidden>');
    expect(f.lines.join('\n')).not.toContain(SECRET);
    f.done();
  });

  it('says to rerun when the Edge secret changed but Vault did not, and still deletes its folder', () => {
    const before = madeFolders();
    const f = fake({ fail: 'vault' });
    expect(setWorkerSecret({ ref: REF }, { ...f.io, dir: undefined })).toBe(1);
    const text = f.lines.join('\n');
    expect(text).toMatch(/rerun this script/i);
    expect(text).not.toContain(SECRET);
    expect(madeFolders()).toBe(before);
    f.done();
  });

  it('fails with the reason when the Vault check cannot run or does not list both names', () => {
    const failed = fake({ fail: 'check' });
    expect(setWorkerSecret({ ref: REF }, failed.io)).toBe(1);
    expect(failed.lines.join('\n')).toContain('unauthorized');
    failed.done();
    const partial = fake({ present: '1' });
    expect(setWorkerSecret({ ref: REF }, partial.io)).toBe(1);
    expect(partial.lines.join('\n')).toMatch(/found 1/);
    partial.done();
  });

  it('deletes its private folder when it made one', () => {
    const before = madeFolders();
    const f = fake();
    setWorkerSecret({ ref: REF }, { ...f.io, dir: undefined });
    expect(madeFolders()).toBe(before);
    f.done();
  });

  it('builds one SELECT, whose literals the statistics store as placeholders, and rejects odd values', () => {
    const sql = vaultSql(`https://${REF}.supabase.co/functions/v1/game-worker`, SECRET);
    expect(sql.trim().toLowerCase().startsWith('with')).toBe(true);
    expect(sql).not.toMatch(/\bdo\s+\$\$/i);
    expect(sql.match(/vault\.create_secret/g)).toHaveLength(1);
    expect(sql.match(/vault\.update_secret/g)).toHaveLength(1);
    expect(sql.trim().split(';').filter(s => s.trim())).toHaveLength(1);
    expect(() => vaultSql('https://evil.example/x', SECRET)).toThrow();
    expect(() => vaultSql(`https://${REF}.supabase.co/functions/v1/game-worker`, "x' ; drop table y; --")).toThrow();
    expect(scrub(`a ${SECRET} b`, SECRET)).toBe('a <hidden> b');
  });

  it('runs the installed CLI through Node without a shell, and reports a start failure', () => {
    const seen: unknown[][] = [];
    const ok = runCli(['projects', 'list'], (cmd: string, args: string[], opts: Record<string, unknown>) => {
      seen.push([cmd, args, opts]);
      return { status: 0, stdout: 'out', stderr: '' };
    });
    expect(ok).toEqual({ status: 0, stdout: 'out', stderr: '' });
    const [cmd, args, opts] = seen[0] as [string, string[], Record<string, unknown>];
    expect(cmd).toBe(process.execPath);
    expect(args[0]).toBe(join('node_modules', 'supabase', 'dist', 'supabase.js'));
    expect(existsSync(args[0])).toBe(true);
    expect(args.slice(1)).toEqual(['projects', 'list']);
    expect(opts.shell).toBeFalsy();
    const broken = runCli(['x'], () => ({ status: null, error: new Error('spawn ENOENT') }));
    expect(broken.status).toBeNull();
    expect(broken.stderr).toContain('spawn ENOENT');
  });
});
