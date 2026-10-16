import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, admin, account, anonymous, resetIdentity, creation } from '../fixtures/db.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';

// Task 13.1 (M13): visitors (the `anon` role) read the sanitized public projections, and nothing else.
const commands = createDatabase(admin);
beforeEach(async () => { await resetIdentity(); await sql`update private.scheduler set enabled=false where singleton`; });
afterAll(() => sql.end());

/** The public projections a visitor may SELECT: eight base tables, the five invoker views over them, and tournament_views. */
const OPEN = ['world_revision_state', 'world_actors', 'public_profiles', 'recent_results', 'activity_stages', 'arena_standings',
  'tournament_bout_results', 'tournament_placements', 'visible_events', 'world_revision', 'world_actor_reads', 'public_profile_reads',
  'arena_standing_reads', 'tournament_views'];
/** tournament_views is granted column by column: never its pairing job or publication time (Task 19 review M1). */
const PUBLIC_TOURNAMENT_COLUMNS = 'id,slot_index,league,starts_at_ms,ends_at_ms,status,entrants,bracket,bouts,reveal_at_ms';
/** Relations: tables, views, materialized views, partitioned and foreign tables. */
const RELATION_KINDS = ['r', 'v', 'm', 'p', 'f'];

/** Every public-schema relation anon may SELECT, from any column (`has_table_privilege` misses column-only grants). */
async function anonSelectable() {
  return (await sql`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind::text in ${sql(RELATION_KINDS)} and has_any_column_privilege('anon',c.oid,'SELECT')
    order by c.relname`).map(r => r.relname as string);
}
/** Every public-schema relation anon may INSERT into, UPDATE (any column), DELETE from or TRUNCATE. */
async function anonWritable() {
  return (await sql`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind::text in ${sql(RELATION_KINDS)}
      and (has_any_column_privilege('anon',c.oid,'INSERT') or has_any_column_privilege('anon',c.oid,'UPDATE')
        or has_table_privilege('anon',c.oid,'DELETE') or has_table_privilege('anon',c.oid,'TRUNCATE'))
    order by c.relname`).map(r => r.relname as string);
}
/** Every public or private function anon may EXECUTE. */
async function anonExecutable() {
  return (await sql`select p.oid::regprocedure::text as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and has_function_privilege('anon',p.oid,'EXECUTE') order by 1`).map(r => r.name as string);
}
/** One object read as a visitor through the Data API, filtered by one column; a refused read throws. */
async function anonRows(object: string, filter: Record<string, string>, columns = '*') {
  const [[column, value]] = Object.entries(filter);
  const { data, error } = await anonymous.from(object).select(columns).eq(column, value);
  if (error) throw Error(`${object}: ${error.message}`);
  return data;
}

async function fighter() {
  const owner = await account();
  const created = await commands.createGladiator({ userId: owner.id }, creation('Visit ' + randomUUID().slice(0, 8)));
  if (!created.ok) throw Error('creation failed');
  return { owner, gid: created.value.gladiatorId };
}
async function activity(gid: string, back: number) {
  const id = randomUUID(), slot = Math.floor(Date.now() / 4_800_000) - back;
  await sql`insert into public.activities(id,gladiator_id,slot_index,starts_at_ms,ends_at_ms,requested,resolved_kind,status,published_at_ms)
    values(${id},${gid},${slot},${slot * 4_800_000},${(slot + 1) * 4_800_000},'{"kind":"rest"}','rest','active',${slot * 4_800_000})`;
  return id;
}
/** An operator-written public tournament row (its pairing job is a completed private job), as phase 8 would publish it. */
async function tournament() {
  const slot = 3000 + Math.floor(Math.random() * 1000), id = `tournament:${slot}:bronze`;
  const [{ job }] = await sql`insert into private.jobs(kind,dedupe_key,slot_index,input,rules_version,due_at_ms,status)
    values('pair',${'visitor-pair:' + randomUUID()},${slot},'{}','v1',0,'completed') returning id as job`;
  await sql`insert into public.tournament_views(id,pairing_job_id,slot_index,league,starts_at_ms,ends_at_ms,status,entrants,bracket,bouts,reveal_at_ms,published_at_ms)
    values(${id},${job},${slot},'bronze',${slot * 4_800_000},${slot * 4_800_000 + 4_800_000},'insufficient-entrants','[]',null,'[]','[]',0)`;
  return { id, job: job as string };
}

describe('visitor read access', () => {
  it('lets visitors select exactly the public projections, read-only', async () => {
    expect(await anonSelectable()).toEqual([...OPEN].sort());
    expect(await anonWritable()).toEqual([]);
    expect(await anonExecutable()).toEqual([]);
    // Through the Data API too: every opened object refuses a visitor's write.
    for (const object of OPEN) expect((await anonymous.from(object).insert({}).select()).error, object).not.toBeNull();
  });

  it('never exposes the tournament pairing job to any client', async () => {
    const other = await account();
    const t = await tournament();
    for (const c of [anonymous, other.client]) {
      expect((await c.from('tournament_views').select('pairing_job_id')).error).not.toBeNull();
      expect((await c.from('tournament_views').select('published_at_ms')).error).not.toBeNull();
      expect((await c.from('tournament_views').select('*')).error).not.toBeNull();
      const read = await c.from('tournament_views').select(PUBLIC_TOURNAMENT_COLUMNS).eq('id', t.id);
      expect(read.error).toBeNull();
      expect(read.data).toHaveLength(1);
      expect(JSON.stringify(read.data)).not.toContain(t.job);
    }
  });

  it('hides future-dated rows from visitors even by guessed id', async () => {
    const f = await fighter();
    const [{ now }] = await sql`select floor(extract(epoch from clock_timestamp())*1000)::bigint as now`;
    const future = Number(now) + 3_600_000;
    const [dueActivity, futureActivity] = [await activity(f.gid, 2), await activity(f.gid, 1)];
    const summary = (id: string) => ({ activityId: id, resolvedKind: 'rest', result: 'completed', success: true, settledAtMs: 0, replayExpiry: { state: 'expired' } });
    for (const [id, at] of [[dueActivity, 0], [futureActivity, future]] as const) {
      await sql`insert into public.recent_results(activity_id,gladiator_id,name,reveal_at_ms,summary) values(${id},${f.gid},'Visit',${at},${sql.json(summary(id))})`;
    }
    const [dueStage, futureStage] = [randomUUID(), randomUUID()];
    for (const [id, ordinal, at] of [[dueStage, 0, 0], [futureStage, 1, future]] as const) {
      await sql`insert into public.activity_stages(id,activity_id,ordinal,reveal_at_ms,stage) values(${id},${dueActivity},${ordinal},${at},
        ${sql.json({ id, kind: 'travel', revealedAtMs: at, startedAtMs: at, endsAtMs: at + 100, label: 'Travel' })})`;
    }
    const t = await tournament();
    const [dueBout, futureBout] = [`${t.id}:1:0`, `${t.id}:1:1`];
    for (const [id, position, at] of [[dueBout, 0, 0], [futureBout, 1, future]] as const) {
      await sql`insert into public.tournament_bout_results(bout_id,tournament_id,ordinal,round,position,reveal_at_ms,result)
        values(${id},${t.id},${position},1,${position},${at},${sql.json({ participants: [], winnerId: f.gid, bye: true })})`;
    }
    // A due row is readable (a grant without a policy would silently return none of these).
    expect(await anonRows('recent_results', { activity_id: dueActivity }, 'activity_id')).toEqual([{ activity_id: dueActivity }]);
    expect(await anonRows('visible_events', { id: dueStage }, 'id')).toEqual([{ id: dueStage }]);
    expect(await anonRows('activity_stages', { id: dueStage }, 'id')).toEqual([{ id: dueStage }]);
    expect(await anonRows('tournament_bout_results', { bout_id: dueBout }, 'bout_id')).toEqual([{ bout_id: dueBout }]);
    // The future row is not, even by its id.
    expect(await anonRows('recent_results', { activity_id: futureActivity })).toEqual([]);
    expect(await anonRows('visible_events', { id: futureStage })).toEqual([]);
    expect(await anonRows('activity_stages', { id: futureStage })).toEqual([]);
    expect(await anonRows('tournament_bout_results', { bout_id: futureBout })).toEqual([]);
  });

  it('keeps owner management and private schemas denied to visitors', async () => {
    await fighter();
    for (const t of ['owner_state', 'activities']) expect((await anonymous.from(t).select('*')).error, t).not.toBeNull();
    for (const t of ['jobs', 'activity_snapshots', 'tournament_results']) {
      expect((await anonymous.schema('private').from(t).select('*')).error, t).not.toBeNull();
    }
    expect(await sql`select has_schema_privilege('anon','private','USAGE') as private`).toEqual([{ private: false }]);
  });
});
