import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BENCH_DOMAIN, DEFAULT_OUT, benchCharacters, benchSeedSql, parseArgs } from '../../scripts/bench-seed.mjs';
import { parseCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import { prepareCreation } from '../../supabase/functions/_shared/backend/database.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';

// Task 24.2b (plan Decision 4): the bench seed generator. The SQL it writes is applied to the local stack by
// tests/db/bench-seed.test.ts; here are its options, its determinism and the guards' presence and order. Nothing here touches
// a database or the network.

const WOODLAND = { kind: 'expedition', expeditionId: 'woodland' };
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const run = (args: string[]) => spawnSync(process.execPath, [resolve('scripts/bench-seed.mjs'), ...args], { encoding: 'utf8' });

describe('the options', () => {
  it('default to 50 characters, the seed "bench" and the git-ignored bench-seed.sql in the repository root', () => {
    expect(parseArgs([])).toEqual({ count: 50, seed: 'bench', out: DEFAULT_OUT });
    expect(DEFAULT_OUT).toBe(resolve('bench-seed.sql'));
    expect(readFileSync('.gitignore', 'utf8').split(/\r?\n/)).toContain('/bench-seed.sql');
  });

  it('take a count, a seed and an output path', () => {
    expect(parseArgs(['--count', '3', '--seed', 'rehearsal-2', '--out', 'x/seed.sql'])).toEqual({ count: 3, seed: 'rehearsal-2', out: resolve('x/seed.sql') });
    expect(parseArgs(['--count', '200']).count).toBe(200);
  });

  it.each([
    [['--count', '0']], [['--count', '201']], [['--count', '2.5']], [['--count', '1e1']], [['--count']], [['--seed', '']],
    [['--seed', 'has space']], [['--seed', "it's"]], [['--seed', 'a'.repeat(65)]], [['--out', '']], [['--verbose']], [['50']],
  ])('refuse %j', (args) => {
    expect(() => parseArgs(args)).toThrow(/usage/);
  });
});

describe('the characters', () => {
  const characters = benchCharacters({ count: 50, seed: 'bench' });

  it('are 50, each with its own synthetic account on the reserved .invalid domain', () => {
    expect(characters).toHaveLength(50);
    expect(BENCH_DOMAIN).toBe('bench.invalid');
    expect(characters.map(c => c.email)).toEqual(Array.from({ length: 50 }, (_, i) => `bench-${String(i + 1).padStart(3, '0')}@bench.invalid`));
    expect(characters.map(c => c.name)).toEqual(Array.from({ length: 50 }, (_, i) => `Bench ${String(i + 1).padStart(3, '0')}`));
    const ids = characters.flatMap(c => [c.userId, c.identityId, c.creation.command.operationId, ...c.edits.map(e => e.operationId)]);
    expect(new Set(ids).size).toBe(ids.length);
    // RFC 9562 version 8 (custom: derived from the seed), lowercase, as SQL prints them.
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('are created, and get their schedules, with the commands the HTTP parser accepts and the input the Edge function prepares', () => {
    for (const c of characters) {
      expect(parseCommand(c.creation.command), c.name).toEqual(c.creation.command);
      expect(c.creation).toEqual(prepareCreation(c.creation.command));
      for (const edit of c.edits) expect(parseCommand(edit), `${c.name} ${edit.phase}`).toEqual(edit);
    }
  });

  it('end with every phase on the Woodland expedition, from the creation schedule (Training / Woodland / Rest)', () => {
    const creationSchedule = { morning: { kind: 'training' }, afternoon: WOODLAND, evening: { kind: 'rest' } };
    for (const c of characters) {
      const schedule: Record<string, unknown> = structuredClone(creationSchedule);
      let version = 1;
      for (const edit of c.edits) {
        expect(edit.expectedVersion, c.name).toBe(version++);
        schedule[edit.phase] = edit.choice;
      }
      expect(schedule).toEqual({ morning: WOODLAND, afternoon: WOODLAND, evening: WOODLAND });
    }
  });

  it('vary their class and allocation, but all afford the same expeditions, so their rests stay in step', () => {
    expect(new Set(characters.map(c => c.creation.command.classId))).toEqual(new Set(['berserker', 'guardian', 'duelist']));
    expect(new Set(characters.map(c => JSON.stringify(c.creation.command.allocation))).size).toBeGreaterThan(10);
    const affordable = new Set(characters.map(c => Math.floor(c.creation.staminaMaximum / RULES_V1.activityStamina.expedition)));
    expect([...affordable]).toEqual([3]);
  });
});

describe('the SQL', () => {
  const text = benchSeedSql({ count: 50, seed: 'bench' });

  it('is the same for the same count and seed, and differs for another', () => {
    expect(benchSeedSql({ count: 50, seed: 'bench' })).toBe(text);
    expect(benchSeedSql({ count: 50, seed: 'other' })).not.toBe(text);
    expect(benchSeedSql({ count: 49, seed: 'bench' })).not.toBe(text);
    expect(text).toContain('--count 50 --seed bench');
  });

  it('is LF text ending in a newline, one DO block and one read-only SELECT', () => {
    expect(text).not.toContain('\r');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.match(/^do \$bench_seed\$$/gm)).toHaveLength(1);
    expect(text.match(/^\$bench_seed\$;$/gm)).toHaveLength(1);
    expect(text.trimEnd().split('$bench_seed$;')[1]).toMatch(/^\s*(--[^\n]*\n\s*)*select\b/);
  });

  it('checks every refusal under the seed lock before it writes anything', () => {
    const body = text.slice(text.indexOf('do $bench_seed$'));
    const firstWrite = body.search(/\binsert into\b|\bpublic\.(consume_command_rate|create_gladiator|edit_schedule)\(/);
    const guards = [
      "perform pg_advisory_xact_lock(hashtextextended('cloudiator-bench-seed', 0));",
      'from auth.users', 'from public.gladiators', 'from private.season_epoch', 'from private.scheduler', 'raise exception',
    ];
    for (const guard of guards) {
      expect(body.indexOf(guard), guard).toBeGreaterThan(0);
      expect(body.indexOf(guard), guard).toBeLessThan(firstWrite);
    }
    for (const reason of ['that are not bench seed accounts', 'already seeded', 'characters', 'the season epoch is set', 'the scheduler is enabled']) {
      expect(body.slice(0, firstWrite), reason).toContain(reason);
    }
  });

  it('creates and schedules through the game\'s own functions, and inserts only the two Auth rows directly', () => {
    expect(text).toContain('public.consume_command_rate(actor, false)');
    expect(text).toContain('public.consume_command_rate(actor, true)');
    expect(text).toContain('public.create_gladiator(actor,');
    expect(text).toContain('public.edit_schedule(actor,');
    expect([...text.matchAll(/\binsert into ([\w.]+)/g)].map(m => m[1])).toEqual(['auth.users', 'auth.identities']);
    expect(text).not.toMatch(/\b(update|delete from|truncate)\s+(public|private|auth)\./);
  });

  it('holds no password, key or real address: an empty password and the reserved domain only', () => {
    expect(text).toMatch(/encrypted_password[^;]*''/s);
    expect(text).not.toMatch(/crypt\(|gen_salt|sb_secret_|sb_publishable_|service_role|eyJ[A-Za-z0-9_-]{10,}/);
    const addresses = [...text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map(m => m[0]);
    expect(addresses.length).toBeGreaterThanOrEqual(50);
    for (const address of addresses) expect(address).toMatch(/^bench-(\d{3}|%)@bench\.invalid$/);
  });
});

describe('the command line', () => {
  it('writes the file deterministically and prints its size and hash only', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloudiator-bench-seed-'));
    directories.push(directory);
    const out = join(directory, 'bench-seed.sql');
    const first = run(['--count', '3', '--seed', 'unit', '--out', out]);
    expect(first.status, first.stderr).toBe(0);
    const written = readFileSync(out, 'utf8');
    expect(written).toBe(benchSeedSql({ count: 3, seed: 'unit' }));
    const sha256 = createHash('sha256').update(written).digest('hex');
    expect(first.stdout).toContain(`3 characters, seed unit, sha256 ${sha256}`);
    expect(first.stdout).not.toContain('@bench.invalid');
    const second = run(['--count', '3', '--seed', 'unit', '--out', out]);
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(written);
  });

  it('exits 2 on a usage error and writes nothing', () => {
    const result = run(['--count', 'many']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: node scripts\/bench-seed\.mjs/);
    expect(result.stdout).toBe('');
  });
});
