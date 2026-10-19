import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '../fixtures/db.ts';
import { DEFAULT_EXECUTORS } from '../../supabase/functions/_shared/backend/jobs.ts';

// Task 23.6 (R6), the live side of tests/rule-retention.test.ts: in the migrated database, the rules version an in-progress
// boundary, snapshot, job or tournament records can never disappear underneath it, and the worker deployed with this code
// has the executors of every version the database holds, for every job kind it allows. Catalog reads only.

afterAll(async () => { await sql.end(); });

describe('retained rules in the migrated database', () => {
  it('pins every stored rules version to a retained version row', async () => {
    const columns = await sql<{ relation: string }[]>`select table_schema||'.'||table_name as relation from information_schema.columns
      where column_name='rules_version' and table_schema in ('public','private') order by 1`;
    const keys = await sql<{ relation: string; validated: boolean; onDelete: string; onUpdate: string }[]>`select c.conrelid::regclass::text as relation,
      c.convalidated as validated, c.confdeltype::text as "onDelete", c.confupdtype::text as "onUpdate"
      from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
      where c.contype='f' and c.confrelid='private.rules_versions'::regclass and a.attname='rules_version' and cardinality(c.conkey)=1 order by 1`;
    expect(columns.map(c => c.relation)).toEqual(['private.activity_snapshots', 'private.boundaries', 'private.jobs', 'private.tournaments']);
    // A validated key with NO ACTION (a) or RESTRICT (r): a referenced version row cannot be deleted or renamed.
    expect(keys).toEqual(columns.map(c => ({ relation: c.relation, validated: true, onDelete: expect.stringMatching(/^[ar]$/), onUpdate: expect.stringMatching(/^[ar]$/) })));
    // Nothing deletes a version row on its own: no trigger, rule or cascading key acts on the table.
    expect(await sql`select tgname from pg_trigger where tgrelid='private.rules_versions'::regclass and not tgisinternal`).toEqual([]);
    expect(await sql`select rulename from pg_rules where schemaname='private' and tablename='rules_versions'`).toEqual([]);
  });

  it('has the worker executors of every version the database holds, for every job kind', async () => {
    const versions = (await sql<{ version: string }[]>`select version from private.rules_versions order by version`).map(r => r.version);
    expect(versions.length).toBeGreaterThan(0);
    const [{ definition }] = await sql<{ definition: string }[]>`select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid='private.jobs'::regclass and contype='c' and pg_get_constraintdef(oid) like '%kind = ANY%'`;
    const kinds = [...definition.matchAll(/'(\w+)'::text/g)].map(m => m[1]).sort();
    expect(kinds).toEqual(['pair', 'prepare', 'reveal', 'settlement', 'simulation']);
    for (const version of versions) {
      expect(Object.keys(DEFAULT_EXECUTORS), version).toContain(version);
      // Settlements run in SQL (settle_activity); the worker runs every other kind with the job's own version.
      expect(Object.keys(DEFAULT_EXECUTORS[version]).sort(), version).toEqual(kinds.filter(kind => kind !== 'settlement'));
    }
  });
});
