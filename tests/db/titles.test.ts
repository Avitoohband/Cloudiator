import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, admin, account, anonymous, resetIdentity, creation } from '../fixtures/db.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { STORED_COUNTERS, TITLES_V1 } from '../../supabase/functions/_shared/domain/titles.ts';

// Patch 1.7, wearable titles (spec docs/superpowers/specs/2026-10-30-titles-1-7-design.md, "Server: M28 from
// supabase/sql/22-titles.sql"; source supabase/sql/22-titles.sql). Task 2: the tables, the rules restated from TITLES_V1, the
// measures, awarding (the first title ever earned is worn at once; a player who chose No title keeps none) and Founder at
// creation, whose cutoff is the end of public.seasons row season_index 0, read from the table.
const commands = createDatabase(admin);
beforeEach(async () => { await resetIdentity(); await sql`update private.scheduler set enabled=false where singleton`; });
afterAll(() => sql.end());

const DAY = 86_400_000;
const SEASON_MS = 2_419_200_000;
/** Season 1 (season_index 0) as production holds it: the launch slot (epoch 373525) for 504 slots of 80 minutes. */
const SEASON_1 = { startsAtMs: 1_792_920_000_000, endsAtMs: 1_795_339_200_000 };

async function fighter() {
  const owner = await account();
  const created = await commands.createGladiator({ userId: owner.id }, creation('Titles ' + randomUUID().slice(0, 8)));
  if (!created.ok) throw Error('creation failed');
  return { ...owner, gid: created.value.gladiatorId };
}
/** The database's own clock (the container's may differ from this host's). */
const dbNow = async () => Number((await sql`select floor(extract(epoch from clock_timestamp())*1000)::bigint as ms`)[0].ms);
/** Season 0 ending at `endsAtMs`, by default production's Season 1 (its bounds are always 28 days apart). */
const openSeason = (endsAtMs = SEASON_1.endsAtMs) =>
  sql`insert into public.seasons(season_index,starts_at_ms,ends_at_ms) values(0,${endsAtMs - SEASON_MS},${endsAtMs})`;
/** Season rows are immutable (guard_season); the test reset's truncate removes them. */
const dropSeasons = () => sql`truncate public.seasons, public.season_standings, private.season_awards`;
const createdAt = async (gid: string) =>
  Number((await sql`select created_at_ms::bigint as at from public.gladiators where id=${gid}`)[0].at);
const award = async (gid: string, atMs: number, source = 'result') =>
  (await sql`select private.award_titles(${gid}, ${atMs}, null, ${source}, null) as granted`)[0].granted as number;
const setCount = async (gid: string, counter: string, value: number) =>
  Number((await sql`select private.set_title_count(${gid}, ${counter}, ${value}) as value`)[0].value);
const addCount = async (gid: string, counter: string, delta: number) =>
  Number((await sql`select private.add_title_count(${gid}, ${counter}, ${delta}) as value`)[0].value);
const titlesOf = async (gid: string) => (await sql`select title_id, earned_at_ms::bigint as at, activity_id, source, detail
  from public.gladiator_titles where gladiator_id=${gid} order by earned_at_ms, title_id`)
  .map(r => ({ id: r.title_id as string, at: Number(r.at), activity: r.activity_id as string | null, source: r.source as string,
    detail: r.detail as unknown }));
const idsOf = async (gid: string) => (await titlesOf(gid)).map(t => t.id).sort();
const wornOf = async (gid: string) => (await sql`select worn_title from public.gladiators where id=${gid}`)[0].worn_title as string | null;
const measuresOf = async (gid: string, atMs: number) =>
  (await sql`select private.title_measures(${gid}, ${atMs}) as measures`)[0].measures as Record<string, number>;
/** The error a statement or transaction raised (its SQLSTATE and message), or null when it succeeded. */
async function failure(run: () => Promise<unknown>) {
  try { await run(); return null; } catch (error) { return { code: (error as { code?: string }).code, message: (error as Error).message }; }
}

describe('the titles catalog and awarding', () => {
  it('restates the catalog rules', async () => {
    const [{ rules, volatility, definer, config }] = await sql`select private.title_rules() as rules, p.provolatile as volatility,
      p.prosecdef as definer, p.proconfig as config from pg_proc p where p.oid='private.title_rules()'::regprocedure`;
    expect(rules).toEqual(TITLES_V1.map(({ id, measure, threshold, tier }) => ({ id, measure, threshold, tier })));
    expect(rules).toHaveLength(31);
    expect({ volatility, definer, config }).toEqual({ volatility: 'i', definer: false, config: ['search_path=""'] });
  });

  it("draws the founders' line at the end of season 0", async () => {
    const f = await fighter(), created = await createdAt(f.gid);
    // No season row: nobody is a founder, and the cutoff is unknown.
    expect(await titlesOf(f.gid)).toEqual([]);
    expect(await wornOf(f.gid)).toBeNull();
    expect((await sql`select private.founder_cutoff_ms() as cutoff`)[0].cutoff).toBeNull();
    // Season 0 ends exactly when the gladiator was made: made after Season 1, not in it.
    await openSeason(created);
    expect(await award(f.gid, created, 'joined')).toBe(0);
    expect(await titlesOf(f.gid)).toEqual([]);
    expect((await measuresOf(f.gid, created)).founder).toBe(0);
    // Ending 1 ms later: made in Season 1.
    await dropSeasons();
    await openSeason(created + 1);
    expect(Number((await sql`select private.founder_cutoff_ms() as cutoff`)[0].cutoff)).toBe(created + 1);
    expect((await measuresOf(f.gid, created)).founder).toBe(1);
    expect(await award(f.gid, created, 'joined')).toBe(1);
    expect(await titlesOf(f.gid)).toEqual([{ id: 'founder', at: created, activity: null, source: 'joined', detail: null }]);
    expect(await wornOf(f.gid)).toBe('founder');
  });

  it('grants Founder at creation before the cutoff', async () => {
    const now = await dbNow();
    await openSeason(now + DAY);
    const founder = await fighter(), created = await createdAt(founder.gid);
    expect(await titlesOf(founder.gid)).toEqual([{ id: 'founder', at: created, activity: null, source: 'joined', detail: null }]);
    expect(await wornOf(founder.gid)).toBe('founder');
    await dropSeasons();
    await openSeason(now - 3_600_000);
    const late = await fighter();
    expect(await titlesOf(late.gid)).toEqual([]);
    expect(await wornOf(late.gid)).toBeNull();
  });

  it('wears the first title only', async () => {
    const f = await fighter(), created = await createdAt(f.gid);
    expect(await setCount(f.gid, 'trainings', 10)).toBe(10);
    expect(await award(f.gid, created + 1000)).toBe(1);
    expect(await titlesOf(f.gid)).toEqual([{ id: 'tiro', at: created + 1000, activity: null, source: 'result', detail: null }]);
    expect(await wornOf(f.gid)).toBe('tiro');
    // The player chose No title. A title earned later is held, never put on.
    await sql`update public.gladiators set worn_title=null where id=${f.gid}`;
    expect(await addCount(f.gid, 'expeditions-won', 10)).toBe(10);
    expect(await award(f.gid, created + 2000)).toBe(1);
    expect(await idsOf(f.gid)).toEqual(['tiro', 'wanderer']);
    expect(await wornOf(f.gid)).toBeNull();
  });

  it('picks Founder, then the highest tier, when several arrive together', async () => {
    const f = await fighter(), created = await createdAt(f.gid);
    await setCount(f.gid, 'expeditions-won', 200);
    await setCount(f.gid, 'trainings', 10);
    expect(await award(f.gid, created + 1000)).toBe(4);
    expect(await idsOf(f.gid)).toEqual(['pathfinder', 'tiro', 'trailblazer', 'wanderer']);
    expect(await wornOf(f.gid)).toBe('trailblazer');
    // The same counters for a gladiator made in Season 1 (production's bounds): Founder comes first.
    const g = await fighter();
    await setCount(g.gid, 'expeditions-won', 200);
    await setCount(g.gid, 'trainings', 10);
    await openSeason();
    expect(Number((await sql`select starts_at_ms::bigint as starts from public.seasons where season_index=0`)[0].starts))
      .toBe(SEASON_1.startsAtMs);
    const made = SEASON_1.startsAtMs + 4_800_000;
    await sql`update public.gladiators set created_at_ms=${made} where id=${g.gid}`;
    expect(await award(g.gid, made + DAY)).toBe(5);
    expect(await idsOf(g.gid)).toEqual(['founder', 'pathfinder', 'tiro', 'trailblazer', 'wanderer']);
    expect(await wornOf(g.gid)).toBe('founder');
  });

  it('never grants twice and never takes back', async () => {
    const f = await fighter(), created = await createdAt(f.gid);
    await setCount(f.gid, 'trainings', 10);
    expect(await award(f.gid, created + 1000)).toBe(1);
    expect(await award(f.gid, created + 2000)).toBe(0);
    await setCount(f.gid, 'trainings', 400);
    expect(await award(f.gid, created + 3000)).toBe(2);
    expect(await award(f.gid, created + 4000)).toBe(0);
    expect((await titlesOf(f.gid)).map(t => [t.id, t.at])).toEqual([['tiro', created + 1000], ['disciplined', created + 3000],
      ['doctore', created + 3000]]);
    expect(await failure(() => sql`update public.gladiator_titles set source='shop' where gladiator_id=${f.gid}`))
      .toMatchObject({ message: 'immutable gladiator_titles' });
    expect(await failure(() => sql`delete from public.gladiator_titles where gladiator_id=${f.gid}`))
      .toMatchObject({ message: 'immutable gladiator_titles' });
    await sql`insert into public.item_firsts(gladiator_id,catalog_id,first_at_ms) values(${f.gid},'sword:1:common',${created})
      on conflict do nothing`;
    expect(await failure(() => sql`update public.item_firsts set first_at_ms=0 where gladiator_id=${f.gid}`))
      .toMatchObject({ message: 'immutable item_firsts' });
    expect(await failure(() => sql`delete from public.item_firsts where gladiator_id=${f.gid}`))
      .toMatchObject({ message: 'immutable item_firsts' });
    expect(await idsOf(f.gid)).toEqual(['disciplined', 'doctore', 'tiro']);
    expect(await sql`select source from public.gladiator_titles where gladiator_id=${f.gid} and source<>'result'`).toEqual([]);
    expect((await sql`select count(*)::int as n from public.item_firsts where gladiator_id=${f.gid}`)[0].n).toBeGreaterThan(0);
  });

  it('wears only an earned title', async () => {
    const f = await fighter(), created = await createdAt(f.gid);
    // The foreign key is deferred: the update itself succeeds, and the commit refuses it.
    let updated = 0;
    expect(await failure(() => sql.begin(async tx => {
      updated = (await tx`update public.gladiators set worn_title='croesus' where id=${f.gid} returning id`).length;
    }))).toMatchObject({ code: '23503' });
    expect(updated).toBe(1);
    expect(await wornOf(f.gid)).toBeNull();
    // An earned title can be put back on after No title.
    await setCount(f.gid, 'trainings', 10);
    await award(f.gid, created + 1000);
    await sql`update public.gladiators set worn_title=null where id=${f.gid}`;
    await sql`update public.gladiators set worn_title='tiro' where id=${f.gid}`;
    expect(await wornOf(f.gid)).toBe('tiro');
  });

  it('counts the measures', async () => {
    const f = await fighter(), created = await createdAt(f.gid);
    await setCount(f.gid, 'gold-v1', 3);
    await setCount(f.gid, 'gold-v2', 10);
    await sql`insert into public.owned_cosmetics(gladiator_id,catalog_id,catalog_version,binding) values(${f.gid},'banner','v1','bound')`;
    const at = created + 100 * DAY + 1;
    expect(await measuresOf(f.gid, at)).toEqual({ ...Object.fromEntries(STORED_COUNTERS.map(c => [c, 0])), 'gold-v1': 3, 'gold-v2': 10,
      'gold-earned': 10, 'days-in-camp': 100, founder: 0, banner: 1 });
    expect((await measuresOf(f.gid, at - 2))['days-in-camp']).toBe(99);
    // One floor of the whole v1 sum: 7 v1 gold count 1, and 8 count 2.
    await addCount(f.gid, 'gold-v1', 4);
    expect((await measuresOf(f.gid, at))['gold-earned']).toBe(11);
    await addCount(f.gid, 'gold-v1', 1);
    expect((await measuresOf(f.gid, at))['gold-earned']).toBe(12);
    const fresh = await fighter();
    expect((await measuresOf(fresh.gid, await createdAt(fresh.gid))).banner).toBe(0);
  });

  it('keeps the tables owner-only', async () => {
    const holder = async () => {
      const f = await fighter(), created = await createdAt(f.gid);
      await setCount(f.gid, 'trainings', 10);
      await award(f.gid, created + 1000);
      await sql`insert into public.item_firsts(gladiator_id,catalog_id,first_at_ms) values(${f.gid},'sword:1:common',${created})
        on conflict do nothing`;
      return f;
    };
    const owner = await holder(), other = await holder();
    for (const table of ['gladiator_titles', 'title_counters', 'item_firsts']) {
      const mine = await owner.client.from(table).select('gladiator_id');
      expect(mine.error, table).toBeNull();
      expect(mine.data!.length, table).toBeGreaterThan(0);
      expect(new Set(mine.data!.map(r => r.gladiator_id)), table).toEqual(new Set([owner.gid]));
      const theirs = await other.client.from(table).select('gladiator_id');
      expect(theirs.error, table).toBeNull();
      expect(new Set(theirs.data!.map(r => r.gladiator_id)), table).toEqual(new Set([other.gid]));
      const visitor = await anonymous.from(table).select('gladiator_id');
      expect(visitor.error?.code, table).toBe('42501');
    }
    // A signed-in player writes none of them.
    const forged = await owner.client.from('gladiator_titles').insert({ gladiator_id: owner.gid, title_id: 'croesus', earned_at_ms: 0,
      source: 'shop' });
    expect(forged.error?.code).toBe('42501');
  });
});
