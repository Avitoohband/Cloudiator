import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '../fixtures/db.ts';
import { DEFAULT_EXECUTORS } from '../../supabase/functions/_shared/backend/jobs.ts';

// Task 23.6 (R6), the live side of tests/rule-retention.test.ts: in the migrated database, the rules version an in-progress
// boundary, snapshot, job or tournament records can never disappear underneath it, and the worker deployed with this code
// has the executors of every version the database holds, for every job kind it allows. Catalog reads only.

afterAll(async () => { await sql.end(); });

describe('retained rules in the migrated database', () => {
  it('pins private frozen versions to retained rows and classifies the approved public copies', async () => {
    const columns = await sql<{ relation: string }[]>`select table_schema||'.'||table_name as relation from information_schema.columns
      where column_name='rules_version' and table_schema in ('public','private')
        and (table_schema,table_name) in (select table_schema,table_name from information_schema.tables where table_type='BASE TABLE') order by 1`;
    const keys = await sql<{ relation: string; validated: boolean; onDelete: string; onUpdate: string }[]>`select n.nspname||'.'||r.relname as relation,
      c.convalidated as validated, c.confdeltype::text as "onDelete", c.confupdtype::text as "onUpdate"
      from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace
      join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
      where c.contype='f' and c.confrelid='private.rules_versions'::regclass and a.attname='rules_version' and cardinality(c.conkey)=1 order by 1`;
    const frozen = ['private.activity_snapshots', 'private.boundaries', 'private.jobs', 'private.tournaments'];
    expect(columns.map(c => c.relation)).toEqual([...frozen, 'public.seasons', 'public.world_revision_state']);
    // A validated key with NO ACTION (a) or RESTRICT (r): a referenced version row cannot be deleted or renamed.
    expect(keys).toEqual(frozen.map(relation => ({ relation, validated: true, onDelete: expect.stringMatching(/^[ar]$/), onUpdate: expect.stringMatching(/^[ar]$/) })));
    // Public copies deliberately allow unknown well-formed versions; season payout fails closed instead of using an FK.
    expect(await sql`select n.nspname||'.'||r.relname as relation, c.convalidated as validated,pg_get_constraintdef(c.oid) as definition
      from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace
      join pg_attribute a on a.attrelid=c.conrelid and a.attname='rules_version'
      where c.contype='c' and c.conrelid in ('public.seasons'::regclass,'public.world_revision_state'::regclass)
        and a.attnum=any(c.conkey) order by 1`).toEqual(['public.seasons', 'public.world_revision_state'].map(relation =>
      ({ relation, validated: true, definition: "CHECK ((rules_version ~ '^v[0-9]+$'::text))" })));
    // The only allowed trigger publishes a deferred copy; no deletion/rename/cascading mechanism is admitted.
    expect(await sql`select pg_get_triggerdef(oid) as definition from pg_trigger
      where tgrelid='private.rules_versions'::regclass and not tgisinternal`).toEqual([{ definition:
      'CREATE CONSTRAINT TRIGGER mirror_rules_version AFTER INSERT OR UPDATE OF active ON private.rules_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (new.active) EXECUTE FUNCTION private.mirror_rules_version()' }]);
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
