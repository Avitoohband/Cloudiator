import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, admin, account, anonymous, resetIdentity, creation } from '../fixtures/db.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { readWorld, readProfile, readStandings, readTournament, readTimeline, readRecent } from '../../src/lib/api/reads.ts';
import { OPEN, PUBLIC_TOURNAMENT_COLUMNS } from '../fixtures/access.ts';

// Task 13.1 (M13): visitors (the `anon` role) read the sanitized public projections, and nothing else.
const commands = createDatabase(admin);
beforeEach(async () => { await resetIdentity(); await sql`update private.scheduler set enabled=false where singleton`; });
afterAll(() => sql.end());

/** Relations: tables, views, materialized views, partitioned and foreign tables. */
const RELATION_KINDS = ['r', 'v', 'm', 'p', 'f'];

/** Every public-schema relation anon may SELECT, from any column (`has_table_privilege` misses column-only grants). */
async function anonSelectable() {
  return (await sql`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind::text in ${sql(RELATION_KINDS)} and has_any_column_privilege('anon',c.oid,'SELECT')
    order by c.relname`).map(r => r.relname as string);
}
/**
 * Every public-schema relation on which anon holds any privilege besides SELECT: INSERT, UPDATE or REFERENCES (on any
 * column), DELETE, TRUNCATE, TRIGGER or MAINTAIN (Task 23.1: MAINTAIN, REFERENCES and TRIGGER were missed before).
 */
async function anonWritable() {
  return (await sql`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind::text in ${sql(RELATION_KINDS)}
      and (has_any_column_privilege('anon',c.oid,'INSERT') or has_any_column_privilege('anon',c.oid,'UPDATE')
        or has_any_column_privilege('anon',c.oid,'REFERENCES') or has_table_privilege('anon',c.oid,'DELETE')
        or has_table_privilege('anon',c.oid,'TRUNCATE') or has_table_privilege('anon',c.oid,'TRIGGER')
        or has_table_privilege('anon',c.oid,'MAINTAIN'))
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
  it('reads the public economy version and banner through the existing invoker views', async () => {
    const f = await fighter(), spectator = await account();
    for (const client of [anonymous, spectator.client, admin]) {
      const revision = await client.from('world_revision').select('rules_version,latest_patch,published_slot_index,revision,server_now_ms,slot_index').single();
      expect(revision.error).toBeNull();
      expect(revision.data?.rules_version).toMatch(/^v[0-9]+$/);
      const profile = await client.from('public_profile_reads').select('profile').eq('gladiator_id', f.gid).single();
      expect(profile.error).toBeNull();
      expect(profile.data?.profile).toMatchObject({ banner: false, build: expect.any(Object), joinedAtMs: expect.any(Number),
        arenaRecord: { wins: 0, losses: 0 } });
      expect(Object.keys(profile.data!.profile).sort()).toEqual(['actor', 'arenaRecord', 'banner', 'build', 'combatStrength', 'joinedAtMs', 'prestige', 'rating',
        'titlesEarned']);
    }
  });

  // Patch 1.7 (M28; spec "Public and owner reads"): a visitor reads the worn title's id on the world actor and the count of titles on the
  // profile, and nothing else of titles: none of the three owner-only tables.
  it("reads an actor's title and a profile's titlesEarned, and none of the title tables", async () => {
    const f = await fighter(), bare = await fighter(), spectator = await account();
    const [{ created }] = await sql`select created_at_ms::bigint as created from public.gladiators where id=${f.gid}`;
    await sql`select private.set_title_count(${f.gid}, 'trainings', 10)`;
    await sql`select private.set_title_count(${f.gid}, 'expeditions-won', 10)`;
    await sql`select private.award_titles(${f.gid}, ${Number(created) + 1000}, null, 'history', null)`;
    for (const client of [anonymous, spectator.client]) {
      const actors = await client.from('world_actor_reads').select('gladiator_id,actor').in('gladiator_id', [f.gid, bare.gid]);
      expect(actors.error).toBeNull();
      expect(Object.fromEntries(actors.data!.map(r => [r.gladiator_id, r.actor.title]))).toEqual({ [f.gid]: 'wanderer', [bare.gid]: null });
      const profiles = await client.from('public_profile_reads').select('gladiator_id,profile').in('gladiator_id', [f.gid, bare.gid]);
      expect(profiles.error).toBeNull();
      expect(Object.fromEntries(profiles.data!.map(r => [r.gladiator_id, [r.profile.titlesEarned, r.profile.actor.title]])))
        .toEqual({ [f.gid]: [2, 'wanderer'], [bare.gid]: [0, null] });
    }
    for (const table of ['gladiator_titles', 'title_counters', 'item_firsts']) {
      // A visitor is refused; a signed-in spectator reads no row of another account's.
      expect((await anonymous.from(table).select('*')).error?.code, table).toBe('42501');
      const spectated = await spectator.client.from(table).select('*');
      expect([spectated.error, spectated.data], table).toEqual([null, []]);
    }
  });

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

  it('serves a visitor the same world, profile, standings, tournament, timeline and results as a signed-in spectator', async () => {
    const f = await fighter(), spectator = await account();
    await sql`insert into private.arena_ratings(gladiator_id,league,season_index,rating,human_wins,human_losses) values(${f.gid},'bronze',1,1010,1,0)`;
    // A due public stage and completion for a rest activity, and an operator-published tournament.
    const id = await activity(f.gid, 2), stageId = randomUUID(), t = await tournament();
    const completion = { activityId: id, resolvedKind: 'rest', result: 'completed', success: true, settledAtMs: 0, replayExpiry: { state: 'expired' } };
    await sql`insert into public.recent_results(activity_id,gladiator_id,name,reveal_at_ms,summary) values(${id},${f.gid},'Visit',0,${sql.json(completion)})`;
    await sql`insert into public.activity_stages(id,activity_id,ordinal,reveal_at_ms,stage) values(${stageId},${id},0,0,
      ${sql.json({ id: stageId, kind: 'travel', revealedAtMs: 0, startedAtMs: 0, endsAtMs: 100, label: 'Travel' })})`;
    // The database clock differs between two reads, so it is left out of the comparison; everything else must match.
    const unclocked = <T extends { serverNowMs: number }>(read: T) => ({ ...read, serverNowMs: 0 });

    const world = await readWorld(anonymous);
    expect(world.actors.map(a => a.gladiatorId)).toEqual([f.gid]);
    expect(unclocked(world)).toEqual(unclocked(await readWorld(spectator.client)));
    const profile = await readProfile(anonymous, f.gid);
    expect(profile.actor.gladiatorId).toBe(f.gid);
    expect(profile).toEqual(await readProfile(spectator.client, f.gid));
    // Task 11c (M26): the profile carries the current build, the creation time and the record over all seasons, the same for both.
    expect(profile.build?.equipment.weapon?.catalogId).toMatch(/^sword:/);
    expect(profile.joinedAtMs).toEqual(expect.any(Number));
    expect(profile.arenaRecord).toEqual({ wins: 1, losses: 0 });
    const standings = await readStandings(anonymous, 'bronze');
    expect(standings.rows.map(r => r.gladiatorId)).toEqual([f.gid]);
    expect(standings).toEqual(await readStandings(spectator.client, 'bronze'));
    const view = await readTournament(anonymous, t.id);
    expect(view).toMatchObject({ id: t.id, league: 'bronze', status: 'insufficient-entrants' });
    expect(view).toEqual(await readTournament(spectator.client, t.id));
    // The visitor's timeline asks only for public objects: its stages and completion, and no owner summary.
    const timeline = await readTimeline(anonymous, id, { ownerSummary: false });
    expect(timeline).toMatchObject({ activityId: id, completion, stages: [{ id: stageId, kind: 'travel' }] });
    expect(timeline.summary).toBeUndefined();
    const clocks = <T extends { serverNowMs: number; visibleThroughMs: number }>(read: T) => ({ ...read, serverNowMs: 0, visibleThroughMs: 0 });
    expect(clocks(timeline)).toEqual(clocks(await readTimeline(spectator.client, id, { ownerSummary: true })));
    // Asking a visitor's client for the owner summary reaches the owner-only table and is refused: the gateway must not.
    await expect(readTimeline(anonymous, id, { ownerSummary: true })).rejects.toMatchObject({ code: 'unauthenticated' });
    const results = await readRecent(anonymous);
    expect(results.rows).toEqual([{ gladiatorId: f.gid, name: 'Visit', summary: completion }]);
    expect(results).toEqual(await readRecent(spectator.client));
  });
});
