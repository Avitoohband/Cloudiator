import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql, account, admin, creation } from '../fixtures/db.ts';
import { prepareCreation } from '../../supabase/functions/_shared/backend/database.ts';
import { benchCharacters, benchSeedSql } from '../../scripts/bench-seed.mjs';

// Task 24.2b (plan Decision 4): the bench seed (scripts/bench-seed.mjs) applied to the local stack exactly as written, on an
// empty project before activation. The local database is never empty (other suites leave their accounts), so each case runs
// in one transaction on a connection of its own that first empties it — TRUNCATE auth.users CASCADE (which also empties every
// table that references an account: the characters and everything of theirs), TRUNCATE private.season_epoch (its guard is a
// row trigger) and the scheduler off — and always rolls back. No function stand-in is installed. Sequences that a creation
// advances (as every database test does) are the only thing a rollback does not restore. The last case checks the local
// database is otherwise as it was.

const SLOT = 4_800_000;
const COUNT = 50;
const SEED = benchSeedSql({ count: COUNT, seed: 'bench' });
const CHARACTERS = benchCharacters({ count: COUNT, seed: 'bench' });
const WOODLAND = { kind: 'expedition', expeditionId: 'woodland' };

class RolledBack extends Error {}
/** Runs `work` on an emptied, not yet activated project, then rolls everything back. */
async function onEmptyProject<T>(work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const probe = postgres(process.env.LOCAL_DB_URL!, { max: 1, onnotice: () => {} });
  let seen: T | undefined;
  try {
    await probe.begin(async tx => {
      await tx`set local lock_timeout = '15s'`;
      await tx`truncate auth.users cascade`;
      await tx`truncate private.season_epoch`;
      await tx`update private.scheduler set enabled=false where singleton`;
      seen = await work(tx);
      throw new RolledBack();
    }).catch(error => { if (!(error instanceof RolledBack)) throw error; });
  } finally { await probe.end(); }
  return seen as T;
}
/** The seed file as the SQL editor runs it: every statement in one request. Returns the final SELECT's rows. */
async function applySeed(tx: postgres.TransactionSql | postgres.Sql): Promise<postgres.Row[]> {
  const results: unknown[] = await tx.unsafe(SEED).simple();
  // A request of several statements answers one result per statement (the DO block's is empty); the last is the SELECT.
  const statements = results.length > 0 && results.every(Array.isArray) ? results as postgres.Row[][] : [results as postgres.Row[]];
  return [...statements[statements.length - 1]];
}
/** The seed's refusal (or other failure) inside a savepoint, so the transaction goes on; null when it succeeded. */
async function refusal(tx: postgres.TransactionSql) {
  try { await tx.savepoint(sp => applySeed(sp)); return null; } catch (error) { return error as postgres.PostgresError; }
}
async function counts(db: postgres.Sql | postgres.TransactionSql) {
  const [row] = await db`select (select count(*)::int from auth.users) as accounts, (select count(*)::int from public.gladiators) as characters,
    (select count(*)::int from public.operation_receipts) as receipts, (select count(*)::int from private.owner_signals) as signals,
    (select coalesce(json_agg(epoch_slot), '[]') from private.season_epoch) as epoch, (select enabled from private.scheduler where singleton) as scheduler`;
  return row;
}
/** Each column's shape (null, empty string, or JSON type), never its value. */
async function shapeOf(db: postgres.Sql | postgres.TransactionSql, userId: string) {
  const rows = await db`select key, case when value='null'::jsonb then 'null' when value='""'::jsonb then 'empty' else jsonb_typeof(value) end as shape
    from auth.users u, jsonb_each(to_jsonb(u)) where u.id=${userId} order by key`;
  return Object.fromEntries(rows.map(r => [r.key, r.shape]));
}
/** An account of its own and, optionally, a character, made inside the transaction the way GoTrue and the game would. */
async function ownAccount(tx: postgres.TransactionSql, withCharacter: boolean) {
  const id = randomUUID();
  await tx`insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,
    email_change_token_new,email_change,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    values('00000000-0000-0000-0000-000000000000',${id},'authenticated','authenticated',${id + '@example.test'},'',now(),'','','','',
      ${tx.json({ provider: 'google', providers: ['google'] })},${tx.json({})},now(),now())`;
  if (withCharacter) {
    const command = creation('Own ' + id.slice(0, 8));
    const [{ result }] = await tx`select public.create_gladiator(${id}, ${command.operationId}, ${tx.json(prepareCreation(command) as never)}) as result`;
    expect(result.ok, JSON.stringify(result)).toBe(true);
  }
}

describe('the bench seed', () => {
  let before: postgres.Row;
  let goTrueShape: Record<string, string>;

  beforeAll(async () => {
    before = await counts(sql);
    // The shape of an account the Auth admin API creates (tests/fixtures/db.ts), deleted again at once.
    const reference = await account();
    try { goTrueShape = await shapeOf(sql, reference.id); } finally { await admin.auth.admin.deleteUser(reference.id); }
    // Creation and the schedule edits must fall in one slot (an edit answers `processing` across a boundary).
    const remaining = SLOT - (Date.now() % SLOT);
    if (remaining < 60_000) await new Promise(resolve => setTimeout(resolve, remaining + 1_000));
  }, 61_000 + 30_000);
  afterAll(() => sql.end());

  it('seeds 50 characters with 50 synthetic owners on an empty project, all-expedition and not activated', async () => {
    await onEmptyProject(async tx => {
      const [summary] = await applySeed(tx);
      expect(summary).toMatchObject({ bench_accounts: 50, accounts: 50, characters: 50, all_expedition_schedules: 50, epoch_set: false, scheduler_enabled: false });
      const [{ slot }] = await tx`select (floor(extract(epoch from clock_timestamp())*1000)::bigint / ${SLOT})::int as slot`;
      expect(Number(summary.all_expedition_from_slot)).toBeGreaterThan(slot);
      expect(Number(summary.all_expedition_from_slot)).toBeLessThanOrEqual(slot + 3);

      const users = await tx`select u.id::text, u.email, u.encrypted_password = '' as no_password, u.raw_app_meta_data as app, i.id::text as identity,
        i.provider, i.provider_id, i.identity_data from auth.users u join auth.identities i on i.user_id=u.id order by u.email`;
      expect(users.map(u => [u.id, u.identity, u.email])).toEqual(CHARACTERS.map(c => [c.userId, c.identityId, c.email]));
      for (const u of users) {
        expect(u).toMatchObject({ no_password: true, app: { provider: 'google', providers: ['google'] }, provider: 'google', provider_id: u.id,
          identity_data: { sub: u.id, email: u.email } });
      }
      // The same columns null or empty as an account the Auth admin API makes, except that no password is set at all.
      const { encrypted_password: seeded, ...rest } = await shapeOf(tx, CHARACTERS[0].userId);
      const { encrypted_password: _, ...reference } = goTrueShape;
      expect(rest).toEqual(reference);
      expect(seeded).toBe('empty');

      const characters = await tx`select g.name, g.owner_id::text as owner, g.level, s.version, s.schedule, w.money,
          (select count(*)::int from public.item_instances i where i.gladiator_id=g.id) as items,
          (select count(*)::int from public.operation_receipts r where r.owner_id=g.owner_id and r.result->>'ok'='true') as receipts,
          (select count(*)::int from private.owner_signals o where o.owner_id=g.owner_id) as signals
        from public.gladiators g join public.schedules s on s.gladiator_id=g.id join public.wallets w on w.gladiator_id=g.id order by g.name`;
      expect(characters.map(c => [c.name, c.owner])).toEqual(CHARACTERS.map(c => [c.name, c.userId]));
      expect(new Set(characters.map(c => c.owner)).size).toBe(COUNT);
      for (const c of characters) {
        // One creation and two schedule edits, each with its receipt; the rate check recorded the owner's signal.
        expect(c).toMatchObject({ level: '1', version: '3', schedule: { morning: WOODLAND, afternoon: WOODLAND, evening: WOODLAND }, money: '100',
          items: 2, receipts: 3, signals: 1 });
      }
      expect(await counts(tx)).toMatchObject({ accounts: COUNT, characters: COUNT, receipts: 3 * COUNT, signals: COUNT, epoch: [], scheduler: false });

      // A second run refuses, names why, and changes nothing.
      const again = await refusal(tx);
      expect(again?.message).toMatch(/^bench seed refused: /);
      expect(again?.message).toContain('bench seed accounts (already seeded): 50');
      expect(again?.message).toContain('characters: 50');
      expect(again?.message).not.toContain('not bench seed accounts');
      expect(await counts(tx)).toMatchObject({ accounts: COUNT, characters: COUNT, receipts: 3 * COUNT, signals: COUNT });
    });
  });

  it('refuses a project with an account of its own, with or without a character, and changes nothing', async () => {
    await onEmptyProject(async tx => {
      await ownAccount(tx, false);
      const accountOnly = await refusal(tx);
      expect(accountOnly?.message).toBe('bench seed refused: accounts that are not bench seed accounts: 1');
      await ownAccount(tx, true);
      const withCharacter = await refusal(tx);
      expect(withCharacter?.message).toBe('bench seed refused: accounts that are not bench seed accounts: 2; characters: 1');
      expect(withCharacter?.hint).toMatch(/only on the new, empty bench project/);
      expect(await counts(tx)).toMatchObject({ accounts: 2, characters: 1, receipts: 1 });
      expect(await tx`select count(*)::int as n from auth.users where email like '%@bench.invalid'`).toEqual([{ n: 0 }]);
    });
  });

  it('refuses after activation: the season epoch set, or the scheduler on', async () => {
    await onEmptyProject(async tx => {
      await tx`update private.scheduler set enabled=true where singleton`;
      expect((await refusal(tx))?.message).toBe('bench seed refused: the scheduler is enabled (activation comes after seeding)');
      await tx`update private.scheduler set enabled=false where singleton`;
      await tx`insert into private.season_epoch(singleton,epoch_slot) values(true,0)`;
      expect((await refusal(tx))?.message).toBe('bench seed refused: the season epoch is set (activation comes after seeding)');
      expect(await counts(tx)).toMatchObject({ accounts: 0, characters: 0, receipts: 0, signals: 0 });
    });
  });

  it('leaves the local database as it was', async () => {
    expect(await counts(sql)).toEqual(before);
  });
});
