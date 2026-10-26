import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

// Task 24.10 (review Minor 5): the SQL around scripts/restore-hosted.ps1's load, run as the local postgres role (not a
// superuser, like the hosted one). Every test runs in a transaction that always rolls back, so the local world is untouched.
const FACTS = readFileSync(new URL('../../scripts/restore-hosted-facts.sql', import.meta.url), 'utf8');
const BEFORE = readFileSync(new URL('../../scripts/restore-hosted-before.sql', import.meta.url), 'utf8');
const AFTER = readFileSync(new URL('../../scripts/restore-hosted-after.sql', import.meta.url), 'utf8');

class RolledBack extends Error {}
/** What `read` returns inside a transaction that always rolls back; a real error propagates. */
async function rolledBack<T>(read: (tx: postgres.TransactionSql) => Promise<T>) {
  const probe = postgres(process.env.LOCAL_DB_URL!, { max: 1, onnotice: () => {} });
  let seen: T | undefined;
  try {
    await probe.begin(async tx => { seen = await read(tx); throw new RolledBack(); })
      .catch(error => { if (!(error instanceof RolledBack)) throw error; });
  } finally { await probe.end(); }
  return seen as T;
}
const disabledTriggers = async (tx: postgres.TransactionSql) => Number((await tx`
  select count(*) as n from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal and n.nspname in ('public', 'private') and t.tgenabled = 'D'`)[0].n);
/** Makes the database look like a new project after `db push` (no account, identity, character or epoch; scheduler off). */
async function asNewProject(tx: postgres.TransactionSql) {
  await tx.unsafe(`alter table private.season_epoch disable trigger user;
    delete from private.season_epoch;
    alter table private.season_epoch enable trigger user;
    truncate auth.users cascade;
    update private.scheduler set enabled = false where singleton;`);
}

describe('the hosted restore SQL', () => {
  it('reads the facts of a database without writing, as one JSON object', async () => {
    const facts = await rolledBack(async tx => {
      await tx.unsafe('set transaction read only');
      const results = await tx.unsafe(FACTS) as unknown as postgres.RowList<{ jsonb_build_object: string }[]>[];
      return JSON.parse(results[results.length - 1][0].jsonb_build_object);
    });
    expect(Object.keys(facts).sort()).toEqual(['accounts', 'characters', 'epochSet', 'identities', 'migrations', 'schedulerEnabled']);
    expect(facts.migrations).toHaveLength(24);
    for (const key of ['accounts', 'identities', 'characters']) expect(Number.isSafeInteger(facts[key])).toBe(true);
  });

  it.each([
    ['the scheduler on', 'update private.scheduler set enabled = true where singleton'],
    ['a season epoch', 'insert into private.season_epoch (epoch_slot) values (1000)'],
  ])('refuses inside the transaction when a new project has %s', async (_, condition) => {
    // A new project first, so the one condition under test is the only reason to refuse.
    expect(await rolledBack(async tx => { await asNewProject(tx); await tx.unsafe(BEFORE); return 'accepted'; })).toBe('accepted');
    await expect(rolledBack(async tx => {
      await asNewProject(tx);
      await tx.unsafe(condition);
      await tx.unsafe(BEFORE);
    })).rejects.toThrow('target-not-fresh');
  });

  it('on a new project: turns the game triggers off and empties the game tables, then the end turns them on, scheduler off', async () => {
    const seen = await rolledBack(async tx => {
      await asNewProject(tx);
      const disabledBefore = await disabledTriggers(tx);
      await tx.unsafe(BEFORE);
      const during = { disabled: await disabledTriggers(tx),
        rows: Number((await tx`select (select count(*) from private.scheduler) + (select count(*) from private.coordinator)
          + (select count(*) from public.gladiators) as n`)[0].n) };
      // What the data load would restore: the singletons, with the scheduler left on by the source.
      await tx`insert into private.scheduler (singleton, enabled) values (true, true)`;
      await tx.unsafe(AFTER);
      return { disabledBefore, during, after: { disabled: await disabledTriggers(tx),
        scheduler: (await tx`select enabled from private.scheduler where singleton`)[0].enabled } };
    });
    expect(seen.disabledBefore).toBe(0);
    expect(seen.during.disabled).toBeGreaterThan(30);
    expect(seen.during.rows).toBe(0);
    expect(seen.after).toEqual({ disabled: 0, scheduler: false });
  });
});
