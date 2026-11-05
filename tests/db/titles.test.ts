import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { TransactionSql } from 'postgres';
import { sql, admin, account, anonymous, resetIdentity, creation } from '../fixtures/db.ts';
import { SLOT, TRAINING, resetWorld, fighter as placedFighter, coordinatorLease, runBoundary, settleDue, claim }
  from '../fixtures/boundary.ts';
import type { Choices } from '../fixtures/boundary.ts';
import { createDatabase, createWorkerDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import type { WorkerDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { prepareActivityV1, runWorker } from '../../supabase/functions/_shared/backend/jobs.ts';
import { STORED_COUNTERS, TITLES_V1 } from '../../supabase/functions/_shared/domain/titles.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { planExpedition } from '../../supabase/functions/_shared/domain/expedition.ts';
import type { ExpeditionPlan } from '../../supabase/functions/_shared/domain/expedition.ts';
import { seasonAt } from '../../supabase/functions/_shared/domain/season.ts';
import type { ActivitySnapshot } from '../../supabase/functions/_shared/domain/types.ts';
import type { ItemInstance, OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';

// Patch 1.7, wearable titles (spec docs/superpowers/specs/2026-10-30-titles-1-7-design.md, "Server: M28 from
// supabase/sql/22-titles.sql"; source supabase/sql/22-titles.sql). Task 2: the tables, the rules restated from TITLES_V1, the
// measures, awarding (the first title ever earned is worn at once; a player who chose No title keeps none) and Founder at
// creation, whose cutoff is the end of public.seasons row season_index 0, read from the table. Task 3: the counting triggers,
// each in its writer's own transaction (describe 'counting').
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

  // Task 2 review: the auto-wear tie-breaks (regression pins of Task 2's award_titles).
  it('wears a tiered title before an untiered one', async () => {
    const f = await fighter(), created = await createdAt(f.gid);
    await setCount(f.gid, 'trainings', 10);
    // Bannerman (untiered) and Tiro (tier I) arrive in one award: the banner's own (titles_on_banner), or the call below.
    await sql`insert into public.owned_cosmetics(gladiator_id,catalog_id,catalog_version,binding) values(${f.gid},'banner','v1','bound')`;
    await award(f.gid, created + 1000);
    expect(await idsOf(f.gid)).toEqual(['bannerman', 'tiro']);
    expect(await wornOf(f.gid)).toBe('tiro');
  });

  it('wears the first in catalog order within a tier', async () => {
    const f = await fighter(), created = await createdAt(f.gid);
    await setCount(f.gid, 'expeditions-won', 10);
    await setCount(f.gid, 'trainings', 10);
    expect(await award(f.gid, created + 1000)).toBe(2);
    expect(await idsOf(f.gid)).toEqual(['tiro', 'wanderer']);
    expect(await wornOf(f.gid)).toBe('wanderer');
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
    // The two starter items (sword:1:common, light-armor:1:common) are the first rows of the ownership history (Task 3).
    expect(await measuresOf(f.gid, at)).toEqual({ ...Object.fromEntries(STORED_COUNTERS.map(c => [c, 0])), 'gold-v1': 3, 'gold-v2': 10,
      'items-owned': 2, 'tiers-of-one': 1, 'rarities-of-one': 1, 'gold-earned': 10, 'days-in-camp': 100, founder: 0, banner: 1 });
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

// ---------------------------------------------------------------------------------------------------------------------------
// Task 3: counting, in each writer's own transaction (spec "Triggers", "What each measure counts", "Gold", "Lock order", "Time").
// Unless a case is named end to end, an activity row is inserted and then completed by the trusted local operator with
// `update public.activities set status='completed', summary=…, settled_at_ms=…`, as private.settle_activity_core completes it.
type Fighter = Awaited<ReturnType<typeof fighter>>;
const LOOK = { body: 'female', hair: 'ponytail', skin: 3, hairColor: 5, cloth: 11 };
const STRONG = { strength: 150, agility: 5, vitality: 30, endurance: 5, precision: 5 };
const WOODLAND: Choices = { morning: { kind: 'expedition', expeditionId: 'woodland' }, afternoon: { kind: 'expedition', expeditionId: 'woodland' },
  evening: { kind: 'expedition', expeditionId: 'woodland' } };
/** Seven tier-1 items of templates the starters are not: with the two starters, nine distinct catalog ids. */
const NINE = ['axe', 'spear', 'bow', 'round-shield', 'leather-hood', 'iron-helmet', 'light-boots'].map(id => `${id}:1:common`);

const countersOf = async (gid: string) => Object.fromEntries((await sql`select counter, value::bigint as value from public.title_counters
  where gladiator_id=${gid}`).map(r => [r.counter as string, Number(r.value)])) as Record<string, number>;
const firstsOf = async (gid: string) =>
  (await sql`select catalog_id from public.item_firsts where gladiator_id=${gid} order by catalog_id`).map(r => r.catalog_id as string);
const ROLLBACK = new Error('rollback-only');
/** Runs `run` in a transaction that is always rolled back, returning its value. */
async function rolledBack<T>(run: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let value: T | undefined;
  try {
    await sql.begin(async tx => { value = await run(tx); throw ROLLBACK; });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return value as T;
}
async function activate(version: 'v1' | 'v2') {
  await sql.begin(async tx => {
    await tx`update private.rules_versions set active=false where active`;
    expect(await tx`update private.rules_versions set active=true where version=${version} returning version`).toHaveLength(1);
  });
}
/** Commands are refused as `processing` while a gladiator's slot is behind the clock; keep the accounts current. */
const current = (...gids: string[]) => sql`update public.gladiators
  set processed_slot_index=floor(extract(epoch from clock_timestamp())*1000/4800000) where id in ${sql(gids)}`;
let nextSlot = 1000;
/** An active activity of `kind` (the operator completes it below). */
async function activity(gid: string, kind: string, requested: Record<string, unknown> = { kind }) {
  const id = randomUUID(), slot = nextSlot++;
  await sql`insert into public.activities(id,gladiator_id,slot_index,starts_at_ms,ends_at_ms,requested,resolved_kind,status)
    values(${id},${gid},${slot},${slot * SLOT},${(slot + 1) * SLOT},${sql.json(requested as never)},${kind},'active')`;
  return id;
}
const complete = (id: string, summary: Record<string, unknown>, settledAtMs: number) =>
  sql`update public.activities set status='completed',summary=${sql.json(summary as never)},settled_at_ms=${settledAtMs} where id=${id}`;
const result = (success: boolean, rewards: Record<string, unknown> = {}) => ({ result: success ? 'victory' : 'defeat', success, rewards });
const trained = { result: 'completed', success: true, rewards: { attributePoints: 1 } };
/** A wallet ledger row with its own receipt, as each writer records one; `atMs` dates a history row (Task 5). */
async function credit(f: Fighter, reason: string, money: number, request: Record<string, unknown> = { kind: reason }, atMs?: number) {
  const receipt = randomUUID();
  await sql`insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
    values(${f.id},${randomUUID()},${receipt},${f.gid},${sql.json(request as never)},sha256(convert_to(${receipt},'UTF8')),'{"ok":true}')`;
  await sql`insert into public.wallet_ledger(gladiator_id,receipt_id,money_delta,renown_delta,reason${atMs === undefined ? sql`` : sql`,created_at`})
    values(${f.gid},${receipt},${money},0,${reason}${atMs === undefined ? sql`` : sql`,to_timestamp(${atMs}::float8/1000)`})`;
}
/** An item placed by the operator; `origin` 'expedition' is a find. */
async function giveItem(gid: string, catalogId: string, origin: ItemInstance['origin'] = 'expedition', quantity = 1) {
  const entry = catalogId === 'salvage' ? CATALOG_V1.salvage : CATALOG_V1.items[catalogId], id = randomUUID();
  const item = { id, ownerId: gid, catalogId, catalogVersion: CATALOG_V1.version, tier: entry.tier, rarity: entry.rarity, stats: entry.stats,
    quantity, origin, binding: entry.binding, reservation: null };
  await sql`insert into public.item_instances(id,gladiator_id,item) values(${id},${gid},${sql.json(item as never)})`;
  return id;
}
type Outcome = { ok: boolean; code?: string; value?: Record<string, unknown> };
// The backend's commands as the Edge function calls them: service_role, with the backend's own preparation.
const buy = async (f: Fighter, catalogId: string) => await commands.inventory({ userId: f.id },
  { kind: 'buy-shop', operationId: randomUUID(), catalogId, catalogVersion: CATALOG_V1.version, quantity: 1 }) as Outcome;
const sell = async (f: Fighter, itemId: string, quantity = 1) => await commands.inventory({ userId: f.id },
  { kind: 'sell-item', operationId: randomUUID(), itemId, quantity }) as Outcome;
const discard = async (f: Fighter, itemId: string) => await commands.inventory({ userId: f.id },
  { kind: 'discard-item', operationId: randomUUID(), itemId, quantity: 1 }) as Outcome;
const list = async (f: Fighter, itemId: string, price: number) => await commands.market({ userId: f.id },
  { kind: 'create-listing', operationId: randomUUID(), itemId, price }) as Outcome;
const buyListing = async (f: Fighter, listingId: string) => await commands.market({ userId: f.id },
  { kind: 'buy-listing', operationId: randomUUID(), listingId }) as Outcome;
async function ownerState(f: Pick<Fighter, 'client'>): Promise<OwnerState> {
  const { data, error } = await f.client.from('owner_state').select('state').single();
  if (error) throw new Error(error.message);
  return data!.state;
}

/**
 * Ruling (Task 2 review): private.award_titles relies on its caller holding the gladiator's account lock. While this test-only
 * probe is installed, a title inserted by a transaction that does not hold its owner's account advisory lock
 * (hashtextextended(owner_id::text,0); pg_locks shows its high half in classid and its low half in objid) fails that whole
 * transaction. The probe is dropped afterwards, whatever happens.
 */
async function withLockProbe<T>(run: () => Promise<T>): Promise<T> {
  await sql.unsafe(`create or replace function private.test_titles_lock_probe() returns trigger language plpgsql set search_path='' as $$
    begin
      if not exists(select 1 from public.gladiators g join pg_catalog.pg_locks l on l.pid=pg_catalog.pg_backend_pid()
          and l.locktype='advisory' and l.granted and l.objsubid=1
          and ((l.classid::bigint<<32)|l.objid::bigint)=pg_catalog.hashtextextended(g.owner_id::text,0)
        where g.id=new.gladiator_id) then
        raise exception 'title % earned outside the account lock',new.title_id;
      end if;
      return null;
    end $$`);
  await sql`drop trigger if exists test_titles_lock_probe on public.gladiator_titles`;
  await sql`create trigger test_titles_lock_probe after insert on public.gladiator_titles for each row
    execute function private.test_titles_lock_probe()`;
  try {
    return await run();
  } finally {
    await sql`drop trigger if exists test_titles_lock_probe on public.gladiator_titles`;
    await sql`drop function if exists private.test_titles_lock_probe()`;
  }
}

/**
 * A v1 expedition at `slot`, frozen as boundary phase 5 freezes one (tests/db/expeditions.test.ts's fixture), with the first
 * seed whose plan `pick` accepts: a boundary draws a random seed, and this case needs one exact trip. Its simulation, reveals
 * and settlement are the real jobs, run below by the real worker.
 */
async function frozenTrip(f: Fighter, slot: number, expeditionId: 'woodland' | 'outpost', pick: (plan: ExpeditionPlan) => boolean) {
  const aid = randomUUID(), state = await ownerState(f);
  const prepared = prepareActivityV1({ gladiatorId: f.gid, slotIndex: slot, rulesVersion: 'v1', level: state.progression.level,
    earnedPoints: 300, build: { ...state.currentBuild, allocations: STRONG }, items: state.inventory });
  const snapshot = { activityId: aid, gladiatorId: f.gid, slotIndex: slot, cutoffMs: slot * SLOT, choice: { kind: 'expedition', expeditionId },
    scheduleVersion: 1, ...prepared, build: prepared.snapshot, starting: { stamina: state.stamina, level: state.progression.level,
      xp: state.progression.xp, earnedPoints: 300, unspentPoints: 105, league: 'bronze', rating: 1000,
      peakStrength: state.progression.peakStrength, tournamentOptIn: false } } as unknown as ActivitySnapshot;
  const seed = Array.from({ length: 2000 }, (_, n) => `titles-trip-${n}`).find(s => pick(planExpedition(snapshot, s, RULES_V1)));
  if (!seed) throw new Error('no seed gives the trip this case needs');
  await sql`insert into public.activities(id,gladiator_id,slot_index,starts_at_ms,ends_at_ms,requested,resolved_kind,status,debited)
    values(${aid},${f.gid},${slot},${slot * SLOT},${(slot + 1) * SLOT},${sql.json(snapshot.choice as never)},'expedition','active',true)`;
  await sql`insert into private.activity_snapshots(activity_id,snapshot,seed,rules_version) values(${aid},${sql.json(snapshot as never)},${seed},'v1')`;
  await sql`select private.prepare_activity_jobs(${aid})`;
  return { aid, plan: planExpedition(snapshot, seed, RULES_V1) };
}
const settled = async (gid: string, slot: number) =>
  (await sql`select count(*)::int as n from private.settled_slots where gladiator_id=${gid} and slot_index=${slot}`)[0].n === 1;
type Session = { q: Awaited<ReturnType<typeof sql.reserve>>; pid: number };
/** Two reserved sessions, each in an open transaction; both are rolled back (if still open) and released afterwards. */
async function withSessions<T>(run: (a: Session, b: Session) => Promise<T>): Promise<T> {
  const sessions: Session[] = [];
  try {
    for (let n = 0; n < 2; n++) {
      const q = await sql.reserve();
      sessions.push({ q, pid: 0 });
      await q.unsafe('begin');
      await q`set local lock_timeout='15s'`;
      sessions[n].pid = (await q`select pg_backend_pid() as pid`)[0].pid as number;
    }
    return await run(sessions[0], sessions[1]);
  } finally {
    for (const s of sessions) {
      try { await s.q`rollback`; } catch { /* already ended */ } finally { s.q.release(); }
    }
  }
}
/** Database evidence (never elapsed time) that `contender` waits on `holder`. */
async function blockedBy(contender: Session, holder: Session) {
  for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
    const [{ blocked }] = await sql`select ${holder.pid}::int=any(pg_blocking_pids(${contender.pid})) as blocked`;
    if (blocked) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`backend ${contender.pid} did not wait on ${holder.pid}`);
}

describe('counting', () => {
  afterEach(async () => {
    await sql`update private.rules_versions set active=false where version<>'v1'`;
    await sql`update private.rules_versions set active=true where version='v1'`;
  });

  it('counts Trainings, with or without a point', async () => {
    const f = await fighter(), created = await createdAt(f.gid);
    // Ten won expeditions are already counted, so the next award grants Wanderer: a Rest is not one.
    await setCount(f.gid, 'expeditions-won', 10);
    const before = await countersOf(f.gid), rest = await activity(f.gid, 'rest');
    await complete(rest, { result: 'completed', success: true, rewards: { attributePoints: 0 } }, created + 1000);
    expect(await countersOf(f.gid)).toEqual(before);
    expect(await titlesOf(f.gid)).toEqual([]);
    const first = await activity(f.gid, 'training'), second = await activity(f.gid, 'training');
    await complete(first, trained, created + 2000);
    await complete(second, { result: 'completed', success: true, rewards: { attributePoints: 0 } }, created + 3000);
    expect(await countersOf(f.gid)).toEqual({ ...before, trainings: 2 });
    expect(await titlesOf(f.gid)).toEqual([{ id: 'wanderer', at: created + 2000, activity: first, source: 'result', detail: null }]);
  });

  it('counts won expeditions by trip', async () => {
    const f = await fighter(), created = await createdAt(f.gid);
    const trips = [['woodland', true], ['woodland', true], ['outpost', true], ['mountain', false]] as const;
    for (const [n, [expeditionId, won]] of trips.entries()) {
      await complete(await activity(f.gid, 'expedition', { kind: 'expedition', expeditionId }), result(won), created + n * 1000);
    }
    const counted = await countersOf(f.gid);
    expect(counted).toMatchObject({ 'expeditions-won': 3, 'woodland-won': 2, 'outpost-won': 1 });
    expect(counted).not.toHaveProperty('mountain-won');
    // A trip the server does not know counts toward expeditions-won only.
    await complete(await activity(f.gid, 'expedition', { kind: 'expedition', expeditionId: 'swamp' }), result(true), created + 9000);
    expect(await countersOf(f.gid)).toEqual({ ...counted, 'expeditions-won': 4 });
  });

  it('counts Arena wins and the best run', async () => {
    const f = await fighter(), created = await createdAt(f.gid);
    const bouts: string[] = [];
    for (const [n, won] of [true, true, false, true, true, true].entries()) {
      bouts.push(await activity(f.gid, 'arena'));
      await complete(bouts[n], result(won), created + n * 1000);
    }
    expect(await countersOf(f.gid)).toMatchObject({ 'arena-wins': 5, 'arena-streak': 3, 'arena-best-streak': 3 });
    expect(await titlesOf(f.gid)).toEqual([{ id: 'bloodied', at: created, activity: bouts[0], source: 'result', detail: null }]);
    for (const n of [6, 7]) {
      bouts.push(await activity(f.gid, 'arena'));
      await complete(bouts[n], result(true), created + n * 1000);
    }
    expect(await countersOf(f.gid)).toMatchObject({ 'arena-wins': 7, 'arena-streak': 5, 'arena-best-streak': 5 });
    expect((await titlesOf(f.gid)).find(t => t.id === 'invictus'))
      .toEqual({ id: 'invictus', at: created + 7000, activity: bouts[7], source: 'result', detail: null });
  });

  it('counts finals and wins from the placement', async () => {
    const f = await fighter(), created = await createdAt(f.gid);
    // Each placement sits in its own operator-written tournament (its pairing job a completed private job), as phase 8 writes one.
    const placed = async (place: number) => {
      const id = await activity(f.gid, 'tournament'), slot = 3000 + place, tournament = `tournament:${slot}:bronze`;
      const [{ job }] = await sql`insert into private.jobs(kind,dedupe_key,slot_index,input,rules_version,due_at_ms,status)
        values('pair',${'titles-pair:' + randomUUID()},${slot},'{}','v1',0,'completed') returning id as job`;
      await sql`insert into public.tournament_views(id,pairing_job_id,slot_index,league,starts_at_ms,ends_at_ms,status,entrants,bracket,
        bouts,reveal_at_ms,published_at_ms) values(${tournament},${job},${slot},'bronze',${slot * SLOT},${(slot + 1) * SLOT},
        'insufficient-entrants','[]',null,'[]','[]',0)`;
      await sql`insert into public.tournament_placements(tournament_id,gladiator_id,activity_id,place) values(${tournament},${f.gid},${id},${place})`;
      return id;
    };
    const second = await placed(2), first = await placed(1), third = await placed(3);
    await complete(second, result(true), created + 1000);
    await complete(first, result(true), created + 2000);
    await complete(third, result(true), created + 3000);
    expect(await countersOf(f.gid)).toMatchObject({ 'tournament-finals': 2, 'tournament-wins': 1 });
    expect(await titlesOf(f.gid)).toEqual([
      { id: 'finalist', at: created + 1000, activity: second, source: 'result', detail: null },
      { id: 'victor', at: created + 2000, activity: first, source: 'result', detail: null }]);
  });

  it('counts season places and keeps the award', async () => {
    // Real closes (private.close_season) of two finished seasons; season 0 ended in 1970, so nobody here is a founder.
    for (const index of [0, 1]) {
      const season = seasonAt(index * RULES_V1.seasons.durationSlots, 0);
      await sql`insert into public.seasons(season_index,starts_at_ms,ends_at_ms) values(${season.index},${season.startsAtMs},${season.endsAtMs})`;
    }
    const top = await fighter(), next = await fighter(), third = await fighter();
    for (const [f, rating] of [[top, 1300], [next, 1200], [third, 1100]] as const) {
      await sql`insert into private.arena_ratings(gladiator_id,league,season_index,rating,human_wins,human_losses)
        values(${f.gid},'bronze',0,${rating},3,2)`;
    }
    const closed = await dbNow();
    await withLockProbe(async () => expect((await sql`select private.close_season(0,${closed}) as awards`)[0].awards).toBe(3));
    expect(await titlesOf(third.gid)).toEqual([{ id: 'medalist', at: closed, activity: null, source: 'season',
      detail: { seasonIndex: 0, league: 'bronze', place: 3 } }]);
    expect(await idsOf(top.gid)).toEqual(['champion', 'medalist']);
    expect(await wornOf(third.gid)).toBe('medalist');
    await sql`insert into private.arena_ratings(gladiator_id,league,season_index,rating,human_wins,human_losses)
      values(${third.gid},'bronze',1,1100,3,2)`;
    await withLockProbe(async () => expect((await sql`select private.close_season(1,${closed + 1000}) as awards`)[0].awards).toBe(1));
    expect(await titlesOf(third.gid)).toEqual([
      { id: 'medalist', at: closed, activity: null, source: 'season', detail: { seasonIndex: 0, league: 'bronze', place: 3 } },
      { id: 'champion', at: closed + 1000, activity: null, source: 'season', detail: { seasonIndex: 1, league: 'bronze', place: 1 } }]);
    expect(await wornOf(third.gid)).toBe('medalist');
    // The season prizes are gold from play (v1: 200 for third place, 500 for first).
    expect(await countersOf(third.gid)).toMatchObject({ 'season-top-three': 2, 'season-firsts': 1, 'gold-v1': 700 });
  });

  it('counts gold from play only', async () => {
    const f = await fighter(), created = await createdAt(f.gid);
    await current(f.gid);
    await activate('v2');
    // The starting 100 (reason creation) is already in the ledger and counts nothing.
    expect(await countersOf(f.gid)).not.toHaveProperty('gold-v2');
    await credit(f, 'expedition', 10);
    await credit(f, 'arena', 0);
    await credit(f, 'tournament', 24);
    await credit(f, 'season', 300);
    const salvage = await giveItem(f.gid, 'salvage', 'expedition', 2);
    expect(await sell(f, salvage)).toMatchObject({ ok: true, value: { moneyCredit: 4 } });
    expect(await countersOf(f.gid)).toMatchObject({ 'gold-v2': 338 });
    for (const [reason, money] of [['market-sale', 50], ['creation', 100], ['economy-cut', -75], ['shop-purchase', -40]] as const) {
      await credit(f, reason, money);
    }
    // An NPC sale of an item this gladiator bought in a shop itself never counts.
    const bought = await buy(f, 'sword:1:common');
    expect(bought).toMatchObject({ ok: true });
    expect(await sell(f, (bought.value!.itemIds as string[])[0])).toMatchObject({ ok: true, value: { moneyCredit: 10 } });
    const counted = await countersOf(f.gid);
    expect(counted['gold-v2']).toBe(338);
    expect(counted).not.toHaveProperty('gold-v1');
    expect(await titlesOf(f.gid)).toEqual([]);
    // A sale that lifts gold earned from 996 to 1,000 grants Moneyed at once, with no activity.
    await setCount(f.gid, 'gold-v2', 996);
    const before = await dbNow();
    await withLockProbe(async () => expect(await sell(f, salvage)).toMatchObject({ ok: true, value: { moneyCredit: 4 } }));
    const after = await dbNow();
    const [moneyed, ...others] = await titlesOf(f.gid);
    expect(others).toEqual([]);
    expect(moneyed).toMatchObject({ id: 'moneyed', activity: null, source: 'sale', detail: null });
    expect(moneyed.at).toBeGreaterThanOrEqual(before);
    expect(moneyed.at).toBeLessThanOrEqual(after);
    // A settlement's gold that crosses a threshold is awarded with its result, when its activity completes.
    await setCount(f.gid, 'gold-v2', 3990);
    const trip = await activity(f.gid, 'expedition', { kind: 'expedition', expeditionId: 'woodland' });
    await credit(f, 'expedition', 20, { kind: 'activity-settlement', activityId: trip });
    expect(await countersOf(f.gid)).toMatchObject({ 'gold-v2': 4010 });
    expect(await idsOf(f.gid)).toEqual(['moneyed']);
    await complete(trip, result(true, { money: 20 }), created + 5000);
    expect((await titlesOf(f.gid)).find(t => t.id === 'patrician'))
      .toEqual({ id: 'patrician', at: created + 5000, activity: trip, source: 'result', detail: null });
  });

  it('counts v1 gold at a quarter of the sum', async () => {
    // Ruling S1: a credit is bucketed by the rules version active when it is written (the switch flips it in its own commit).
    const f = await fighter(), created = await createdAt(f.gid);
    for (let n = 0; n < 4; n++) await credit(f, 'expedition', 1);
    await activate('v2');
    await credit(f, 'expedition', 10);
    expect(await countersOf(f.gid)).toMatchObject({ 'gold-v1': 4, 'gold-v2': 10 });
    // One floor of the whole v1 sum: four credits of 1 count 1, not 0.
    expect((await measuresOf(f.gid, created))['gold-earned']).toBe(11);
    // While v1 is active (no switch yet), every credit goes to gold-v1.
    await activate('v1');
    const g = await fighter();
    for (const money of [3, 5, 7]) await credit(g, 'arena', money);
    const counted = await countersOf(g.gid);
    expect(counted['gold-v1']).toBe(15);
    expect(counted).not.toHaveProperty('gold-v2');
    expect((await measuresOf(g.gid, created))['gold-earned']).toBe(3);
    // Only the pre-1.6 economy (v1) counts at a quarter: a later rules version (a third row, active only inside this
    // rolled-back transaction, so neither the row nor the world revision's mirror survives) counts unscaled, as v2 does.
    const later = await rolledBack(async tx => {
      await tx`insert into private.rules_versions(version,active) values('v9',false)`;
      await tx`update private.rules_versions set active=false where active`;
      await tx`update private.rules_versions set active=true where version='v9'`;
      const receipt = randomUUID();
      await tx`insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
        values(${g.id},${randomUUID()},${receipt},${g.gid},'{"kind":"arena"}',sha256(convert_to(${receipt},'UTF8')),'{"ok":true}')`;
      await tx`insert into public.wallet_ledger(gladiator_id,receipt_id,money_delta,renown_delta,reason) values(${g.gid},${receipt},6,0,'arena')`;
      return {
        counters: Object.fromEntries((await tx`select counter, value::bigint as value from public.title_counters where gladiator_id=${g.gid}
          and counter like 'gold-%'`).map(r => [r.counter as string, Number(r.value)])),
        earned: Number((await tx`select private.title_measures(${g.gid},${created})->>'gold-earned' as earned`)[0].earned),
      };
    });
    expect(later).toEqual({ counters: { 'gold-v1': 15, 'gold-v2': 6 }, earned: 9 });
    expect(await sql`select version from private.rules_versions where version='v9'`).toEqual([]);
  });

  it('buckets a credit written as service_role by the active rules version (ruling S1)', async () => {
    // 1.6 revoked every API role (service_role included) from private.economy_switches; the backend may read the active version.
    expect((await sql`select has_function_privilege('service_role','private.active_rules_version()','EXECUTE') as run,
      has_table_privilege('service_role','private.economy_switches','SELECT') as read`)[0]).toEqual({ run: true, read: false });
    const f = await fighter();
    await current(f.gid);
    const salvage = await giveItem(f.gid, 'salvage', 'expedition', 2);
    expect(await sell(f, salvage)).toMatchObject({ ok: true, value: { moneyCredit: 10 } });
    expect(await countersOf(f.gid)).toMatchObject({ 'gold-v1': 10 });
    await activate('v2');
    expect(await sell(f, salvage)).toMatchObject({ ok: true, value: { moneyCredit: 4 } });
    expect(await countersOf(f.gid)).toMatchObject({ 'gold-v1': 10, 'gold-v2': 4 });
  });

  it('keeps the ownership history', async () => {
    const f = await fighter(), seller = await fighter();
    await sql`update public.gladiators set level=10 where id=${f.gid}`;
    await sql`update public.wallets set money=1000,renown=100000 where gladiator_id=${f.gid}`;
    await current(f.gid, seller.gid);
    // A find is counted at once and awarded with its result (none here).
    const found = await giveItem(f.gid, 'sword:5:rare');
    expect(await countersOf(f.gid)).toMatchObject({ 'items-owned': 3, 'rare-items': 1, 'tiers-of-one': 2 });
    expect(await titlesOf(f.gid)).toEqual([]);
    // A starter already holds sword:1:common: still one row.
    const bought = await buy(f, 'sword:1:common');
    expect(bought).toMatchObject({ ok: true });
    expect(await firstsOf(f.gid)).toEqual(['light-armor:1:common', 'sword:1:common', 'sword:5:rare']);
    const before = await dbNow();
    await withLockProbe(async () => expect(await buy(f, 'sword:10:renown')).toMatchObject({ ok: true }));
    const shop = await titlesOf(f.gid);
    expect(shop.map(t => [t.id, t.activity, t.source])).toEqual([['rare-find', null, 'shop'], ['tempered', null, 'shop']]);
    expect(shop[0].at).toBeGreaterThanOrEqual(before);
    expect(await wornOf(f.gid)).toBe('tempered');
    const salvage = await giveItem(f.gid, 'salvage', 'expedition', 12);
    const axe = await giveItem(seller.gid, 'axe:5:uncommon');
    const listing = await list(seller, axe, 50);
    expect(listing).toMatchObject({ ok: true });
    await withLockProbe(async () => expect(await buyListing(f, listing.value!.listingId as string)).toMatchObject({ ok: true }));
    const history = ['axe:5:uncommon', 'light-armor:1:common', 'sword:1:common', 'sword:10:renown', 'sword:5:rare'];
    expect(await firstsOf(f.gid)).toEqual(history);
    expect(await countersOf(f.gid)).toMatchObject({ 'items-owned': 5, 'rare-items': 1, 'tiers-of-one': 3, 'rarities-of-one': 1 });
    // Parting with every item it may sell (and the renown sword, which it may only discard) removes no row.
    for (const id of [found, (bought.value!.itemIds as string[])[0], axe]) expect(await sell(f, id)).toMatchObject({ ok: true });
    expect(await sell(f, salvage, 12)).toMatchObject({ ok: true });
    const [{ renown }] = await sql`select id::text as renown from public.item_instances
      where gladiator_id=${f.gid} and item->>'catalogId'='sword:10:renown'`;
    expect(await discard(f, renown)).toMatchObject({ ok: true });
    expect(await firstsOf(f.gid)).toEqual(history);
    expect(await countersOf(f.gid)).toMatchObject({ 'items-owned': 5, 'rare-items': 1, 'tiers-of-one': 3, 'rarities-of-one': 1 });
    // A market purchase that makes a gladiator's tenth distinct item grants Collector, with source market.
    const buyer = await fighter();
    for (const catalogId of NINE) await giveItem(buyer.gid, catalogId, 'shop');
    expect(await countersOf(buyer.gid)).toMatchObject({ 'items-owned': 9 });
    expect(await titlesOf(buyer.gid)).toEqual([]);
    const armor = await giveItem(seller.gid, 'heavy-armor:5:uncommon');
    const offer = await list(seller, armor, 50);
    expect(offer).toMatchObject({ ok: true });
    await current(buyer.gid, seller.gid);
    await withLockProbe(async () => expect(await buyListing(buyer, offer.value!.listingId as string)).toMatchObject({ ok: true }));
    expect((await titlesOf(buyer.gid)).map(t => [t.id, t.activity, t.source])).toEqual([['collector', null, 'market']]);
    expect(await wornOf(buyer.gid)).toBe('collector');
    // The seller's two real market sales credited gold (reason market-sale): it is not earned from play.
    expect(await sql`select count(*)::int as n from public.wallet_ledger where gladiator_id=${seller.gid} and reason='market-sale'
      and money_delta>0`).toEqual([{ n: 2 }]);
    expect(Object.keys(await countersOf(seller.gid)).filter(c => c.startsWith('gold'))).toEqual([]);
    expect(await titlesOf(seller.gid)).toEqual([]);
  });

  it('awards a find with its result', async () => {
    // End to end: the real simulation executor, reveals and settlement (settle_expedition -> settle_activity_core), run by the
    // real worker (runWorker over the real worker adapter, its coordination pinned to the published slot).
    await resetWorld(300);
    const f = await fighter();
    await sql`update public.gladiators set level=5,earned_points=300,unspent_points=105 where id=${f.gid}`;
    for (const catalogId of NINE) await giveItem(f.gid, catalogId, 'shop');
    await setCount(f.gid, 'expeditions-won', 9);
    const owned = await firstsOf(f.gid);
    expect(owned).toHaveLength(9);
    expect(await titlesOf(f.gid)).toEqual([]);
    // A won Outpost trip (the tenth win) that finds a new item (the tenth distinct; not Rare, so exactly two titles are due).
    const { aid, plan } = await frozenTrip(f, 300, 'outpost', p => p.success
      && p.rewards.loot.some(l => l.catalogId !== 'salvage' && !owned.includes(l.catalogId) && !l.catalogId.endsWith(':rare')));
    const port: WorkerDatabase = { ...createWorkerDatabase(admin), coordinate: async () => ({ ok: true, publishedSlot: 300 }) };
    await withLockProbe(async () => {
      for (let round = 0; round < 14 && !await settled(f.gid, 300); round++) await runWorker({ database: port, workerId: randomUUID() });
    });
    expect(await settled(f.gid, 300)).toBe(true);
    const [{ at }] = await sql`select settled_at_ms::bigint as at from public.activities where id=${aid}`;
    // Both arrive with the result; the find's own insert granted nothing (no 'shop' title).
    expect(await titlesOf(f.gid)).toEqual([
      { id: 'collector', at: Number(at), activity: aid, source: 'result', detail: null },
      { id: 'wanderer', at: Number(at), activity: aid, source: 'result', detail: null }]);
    expect(await wornOf(f.gid)).toBe('wanderer');
    const find = plan.rewards.loot.find(l => l.catalogId !== 'salvage')!.catalogId;
    expect(await firstsOf(f.gid)).toEqual([...owned, find].sort());
    expect(await countersOf(f.gid)).toMatchObject({ 'expeditions-won': 10, 'outpost-won': 1, 'items-owned': 10,
      'gold-v1': plan.rewards.money });
  }, 60_000);

  it('awards Old Guard with the first result after day 100', async () => {
    const made = (await dbNow()) - 200 * DAY;
    for (const [days, expected] of [[100 * DAY, ['old-guard']], [100 * DAY - 1, []]] as const) {
      const f = await fighter();
      await sql`update public.gladiators set created_at_ms=${made} where id=${f.gid}`;
      const training = await activity(f.gid, 'training');
      await complete(training, trained, made + days);
      expect(await titlesOf(f.gid)).toEqual(expected.map(id => ({ id, at: made + days, activity: training, source: 'result', detail: null })));
    }
  });

  it('awards a result an operator completes without a settlement time at the database time', async () => {
    // settle_activity_core always sets settled_at_ms; an operator stand-in (tests/db/tournaments.test.ts) may not.
    const f = await fighter();
    await setCount(f.gid, 'trainings', 9);
    const training = await activity(f.gid, 'training'), before = await dbNow();
    await sql`update public.activities set status='completed' where id=${training}`;
    const [tiro, ...others] = await titlesOf(f.gid);
    expect(others).toEqual([]);
    expect(tiro).toMatchObject({ id: 'tiro', activity: training, source: 'result', detail: null });
    expect(tiro.at).toBeGreaterThanOrEqual(before);
    expect(tiro.at).toBeLessThanOrEqual(await dbNow());
  });

  it('awards Bannerman when the banner is bought', async () => {
    const f = await fighter();
    await sql`update public.wallets set renown=${RULES_V1.shops.bannerRenownPrice} where gladiator_id=${f.gid}`;
    await current(f.gid);
    const before = await dbNow();
    await withLockProbe(async () => expect(await buy(f, 'banner')).toMatchObject({ ok: true, value: { cosmeticId: 'banner' } }));
    const [bannerman, ...others] = await titlesOf(f.gid);
    expect(others).toEqual([]);
    expect(bannerman).toMatchObject({ id: 'bannerman', activity: null, source: 'shop', detail: null });
    expect(bannerman.at).toBeGreaterThanOrEqual(before);
    expect(await wornOf(f.gid)).toBe('bannerman');
  });

  it("counts inside the writer's locks", async () => {
    await resetWorld(299);
    const trainee = await placedFighter({ schedule: TRAINING }), traveler = await placedFighter({ schedule: WOODLAND });
    await sql`update public.gladiators set earned_points=300,unspent_points=105 where id=${traveler.gid}`;
    await sql`update public.builds set current_build=jsonb_set(current_build,'{allocations}',${sql.json(STRONG)}) where gladiator_id=${traveler.gid}`;
    // The probe itself: an award outside the account lock fails, and nothing is granted.
    await setCount(trainee.gid, 'trainings', 10);
    expect(await withLockProbe(() => failure(() => award(trainee.gid, 300 * SLOT))))
      .toMatchObject({ message: 'title tiro earned outside the account lock' });
    expect(await titlesOf(trainee.gid)).toEqual([]);
    await setCount(trainee.gid, 'trainings', 9);
    await setCount(traveler.gid, 'expeditions-won', 9);
    const token = await coordinatorLease();
    await withLockProbe(async () => {
      expect(await runBoundary(300, token)).toMatchObject({ status: 'complete' });
      const [{ id: training }] = await sql`select id from public.activities where gladiator_id=${trainee.gid} and slot_index=300`;
      const leases = await claim('settlement');
      expect(leases.map(l => l.activityId)).toEqual([training]);
      // The expedition: the real worker settles it (settle_expedition -> settle_activity_core) while the Training's lease is held.
      for (let round = 0; round < 14 && !await settled(traveler.gid, 300); round++) await settleDue(300, token);
      expect(await settled(traveler.gid, 300)).toBe(true);
      const [{ id: trip, summary }] = await sql`select id, summary from public.activities where gladiator_id=${traveler.gid} and slot_index=300`;
      expect(summary).toMatchObject({ success: true });
      expect((await titlesOf(traveler.gid)).find(t => t.id === 'wanderer')).toMatchObject({ activity: trip, source: 'result' });
      // The Training: the worker's settlement RPC in one open transaction, a change of look on the same account in another.
      await withSessions(async (a, b) => {
        const [{ outcome }] = await a.q`select public.settle_activity(${training},${leases[0].token}) as outcome`;
        expect(outcome).toMatchObject({ ok: true, newGrants: 1 });
        // Counted and awarded inside the settlement's own transaction: visible to it, to nobody else yet.
        expect((await a.q`select title_id from public.gladiator_titles where gladiator_id=${trainee.gid}`).map(r => r.title_id))
          .toContain('tiro');
        expect(await titlesOf(trainee.gid)).toEqual([]);
        const operationId = randomUUID();
        const look = b.q`select public.change_appearance(${trainee.id},${operationId},
          ${b.q.json({ command: { kind: 'change-appearance', operationId, appearance: LOOK } } as never)}) as changed`.execute();
        await blockedBy(b, a);
        await a.q`commit`;
        expect((await look)[0].changed).toMatchObject({ ok: true });
        await b.q`commit`;
      });
    });
    // Both committed, in order: the Training's titles, then the new look. The boundary opened season 0 (slots 0-503), in which
    // this gladiator was placed (1970), and its creation date is far behind: the Training's award also grants Founder and Old
    // Guard, and Founder is worn as its first title.
    const [{ id: training, at }] = await sql`select id, settled_at_ms::bigint as at from public.activities
      where gladiator_id=${trainee.gid} and slot_index=300`;
    expect(await titlesOf(trainee.gid)).toEqual(['founder', 'old-guard', 'tiro']
      .map(id => ({ id, at: Number(at), activity: training, source: 'result', detail: null })));
    expect(await countersOf(trainee.gid)).toMatchObject({ trainings: 10 });
    expect(await wornOf(trainee.gid)).toBe('founder');
    expect((await sql`select appearance from public.gladiators where id=${trainee.gid}`)[0].appearance).toEqual(LOOK);
  }, 90_000);

  it('keeps No title when a real settlement earns another (Review Focus 2)', async () => {
    await resetWorld(299);
    const f = await placedFighter({ schedule: TRAINING });
    await setCount(f.gid, 'expeditions-won', 10);
    expect(await award(f.gid, await createdAt(f.gid) + 1000)).toBe(1);
    expect(await wornOf(f.gid)).toBe('wanderer');
    // The player chose No title; its tenth Training, settled by the real worker, earns Tiro.
    await sql`update public.gladiators set worn_title=null where id=${f.gid}`;
    await setCount(f.gid, 'trainings', 9);
    const token = await coordinatorLease();
    expect(await runBoundary(300, token)).toMatchObject({ status: 'complete' });
    for (let round = 0; round < 6 && !await settled(f.gid, 300); round++) await settleDue(300, token);
    expect(await settled(f.gid, 300)).toBe(true);
    const [{ id }] = await sql`select id from public.activities where gladiator_id=${f.gid} and slot_index=300`;
    expect((await titlesOf(f.gid)).find(t => t.id === 'tiro')).toMatchObject({ activity: id, source: 'result' });
    expect(await wornOf(f.gid)).toBeNull();
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------------------
// Task 4: the command wear-title (spec "The command wear-title"), the public reads (the world actor's `title`, the profile's
// `titlesEarned`) and the owner read's titles (spec "Public and owner reads"). public.wear_title is shaped like
// public.change_appearance (tests/db/change-appearance.test.ts): the account lock, the receipt replay and conflict, the exact keys,
// the caller's own gladiator `for update`, the update only when it differs, a receipt; no receipt for a refusal.
type WearCommand = { kind: 'wear-title'; operationId: string; titleId: unknown };
const wear = (titleId: unknown, operationId: string = randomUUID()): WearCommand => ({ kind: 'wear-title', operationId, titleId });
/** public.wear_title as the backend calls it (service_role). */
const wearRpc = async (actor: string | null, operationId: string | null, command: unknown) => {
  const { data, error } = await admin.rpc('wear_title', { actor_id: actor, operation_id: operationId, input: { command } });
  expect(error).toBeNull();
  return data;
};
const wearReceipts = async (ownerId: string) => (await sql`select count(*)::int as n from public.operation_receipts
  where owner_id=${ownerId} and request->>'kind'='wear-title'`)[0].n as number;
const worldRevision = async () => (await sql`select revision::int as revision from public.world_revision_state where singleton`)[0].revision as number;
/** The row's transaction id: any UPDATE of it, even one that changes nothing, gives it a new one. */
const rowVersion = async (gid: string) => (await sql`select xmin::text as xmin from public.gladiators where id=${gid}`)[0].xmin as string;
/** A gladiator holding Tiro (worn: its first title) and Wanderer. */
async function holder() {
  const f = await fighter(), created = await createdAt(f.gid);
  await setCount(f.gid, 'trainings', 10);
  await award(f.gid, created + 1000);
  await setCount(f.gid, 'expeditions-won', 10);
  await award(f.gid, created + 2000);
  expect([await idsOf(f.gid), await wornOf(f.gid)]).toEqual([['tiro', 'wanderer'], 'tiro']);
  return f;
}
/** A visitor's raw reads of one gladiator: its world actor and its public profile. */
async function visitorReads(gid: string) {
  const actor = await anonymous.from('world_actor_reads').select('actor').eq('gladiator_id', gid).single();
  const profile = await anonymous.from('public_profile_reads').select('profile').eq('gladiator_id', gid).single();
  expect([actor.error, profile.error]).toEqual([null, null]);
  return { actor: actor.data!.actor as Record<string, unknown>, profile: profile.data!.profile as Record<string, unknown> };
}

describe('wear-title', () => {
  it('wears a held title or none, answering with a receipt, and writes nothing for the title already worn', async () => {
    const f = await holder(), command = wear('wanderer'), sentAt = await dbNow();
    const saved = await wearRpc(f.id, command.operationId, command);
    const answeredAt = await dbNow();
    expect(saved).toEqual({ ok: true, receiptId: expect.any(String), value: { titleId: 'wanderer', receivedAtMs: expect.any(Number) } });
    expect(saved.value.receivedAtMs).toBeGreaterThanOrEqual(sentAt);
    expect(saved.value.receivedAtMs).toBeLessThanOrEqual(answeredAt);
    expect(await wornOf(f.gid)).toBe('wanderer');
    // The receipt keeps the whole command and the answer, and is the account's own.
    expect(await sql`select gladiator_id, receipt_id, request, result from public.operation_receipts
      where owner_id=${f.id} and operation_id=${command.operationId}`)
      .toEqual([{ gladiator_id: f.gid, receipt_id: saved.receiptId, request: command, result: saved }]);
    // No title.
    const none = wear(null), bare = await wearRpc(f.id, none.operationId, none);
    expect(bare).toEqual({ ok: true, receiptId: expect.any(String), value: { titleId: null, receivedAtMs: expect.any(Number) } });
    expect(await wornOf(f.gid)).toBeNull();
    // No title again: answered with its own receipt, the row is not updated and the world revision does not move.
    const [version, before] = [await rowVersion(f.gid), await worldRevision()];
    const again = wear(null);
    expect(await wearRpc(f.id, again.operationId, again)).toMatchObject({ ok: true, value: { titleId: null } });
    expect([await rowVersion(f.gid), await worldRevision(), await wearReceipts(f.id)]).toEqual([version, before, 3]);
    // And back to a held title.
    const back = wear('tiro');
    expect(await wearRpc(f.id, back.operationId, back)).toMatchObject({ ok: true, value: { titleId: 'tiro' } });
    expect(await wornOf(f.gid)).toBe('tiro');
  });

  it('replays the stored answer for the same operation and refuses another title under it, writing nothing', async () => {
    const f = await holder(), operationId = randomUUID(), command = wear('wanderer', operationId);
    const saved = await wearRpc(f.id, operationId, command);
    expect(saved).toMatchObject({ ok: true, value: { titleId: 'wanderer' } });
    const later = wear('tiro');
    expect(await wearRpc(f.id, later.operationId, later)).toMatchObject({ ok: true });
    const [version, before] = [await rowVersion(f.gid), await worldRevision()];
    // The replay answers the stored result and never puts the old title back.
    expect(await wearRpc(f.id, operationId, command)).toEqual(saved);
    expect(await wornOf(f.gid)).toBe('tiro');
    // Another body under the used operation is a conflict, checked before any shape.
    for (const other of [wear('tiro', operationId), wear(null, operationId), wear('Founder', operationId), { ...command, extra: 1 }]) {
      expect(await wearRpc(f.id, operationId, other), JSON.stringify(other)).toEqual({ ok: false, code: 'conflict' });
    }
    expect(await wornOf(f.gid)).toBe('tiro');
    expect([await rowVersion(f.gid), await worldRevision(), await wearReceipts(f.id)]).toEqual([version, before, 2]);
  });

  it('refuses an unheld, unknown or malformed title and a wrong shape as invalid, with no receipt', async () => {
    const f = await holder(), operationId = randomUUID();
    const [version, before] = [await rowVersion(f.gid), await worldRevision()];
    // Croesus is a catalog title it does not hold; den-breaker is no title at all; the rest are not ids.
    for (const titleId of ['croesus', 'den-breaker', 'Founder', 7, '', 'a', 'tiro ', true, [], {}, ['tiro'], { id: 'tiro' }]) {
      expect(await wearRpc(f.id, operationId, wear(titleId, operationId)), JSON.stringify(titleId)).toEqual({ ok: false, code: 'invalid' });
    }
    const valid = wear('wanderer', operationId), { titleId: _titleId, ...withoutTitle } = valid;
    for (const command of [withoutTitle, { ...valid, extra: 1 }, { ...valid, gladiatorId: f.gid }, { ...valid, ownerId: f.id },
      { ...valid, kind: 'change-appearance' }, { kind: valid.kind, titleId: 'wanderer' }, { ...valid, operationId: randomUUID() },
      { ...valid, operationId: 'x' }, null, 'wear-title', [valid], {}]) {
      expect(await wearRpc(f.id, operationId, command), JSON.stringify(command)).toEqual({ ok: false, code: 'invalid' });
    }
    // A missing envelope or operation id, and no actor.
    const { data, error } = await admin.rpc('wear_title', { actor_id: f.id, operation_id: operationId, input: {} });
    expect([error, data]).toEqual([null, { ok: false, code: 'invalid' }]);
    expect(await wearRpc(f.id, null, valid)).toEqual({ ok: false, code: 'invalid' });
    expect(await wearRpc(null, operationId, valid)).toEqual({ ok: false, code: 'unauthenticated' });
    expect(await wornOf(f.gid)).toBe('tiro');
    expect([await rowVersion(f.gid), await worldRevision(), await wearReceipts(f.id)]).toEqual([version, before, 0]);
    // Nothing was stored, so the same operation still applies with a held title.
    expect(await wearRpc(f.id, operationId, valid)).toMatchObject({ ok: true, value: { titleId: 'wanderer' } });
    expect(await wearReceipts(f.id)).toBe(1);
  });

  it('gives an account without a gladiator not-found, and writes nothing', async () => {
    const stranger = await account();
    for (const titleId of [null, 'tiro']) {
      const command = wear(titleId);
      expect(await wearRpc(stranger.id, command.operationId, command)).toEqual({ ok: false, code: 'not-found' });
    }
    expect(await sql`select count(*)::int as n from public.operation_receipts where owner_id=${stranger.id}`).toEqual([{ n: 0 }]);
  });

  it("never changes another gladiator's title", async () => {
    const owner = await holder(), victim = await holder();
    // Bloodied is the victim's alone.
    await setCount(victim.gid, 'arena-wins', 1);
    await award(victim.gid, (await createdAt(victim.gid)) + 3000);
    const [version, before] = [await rowVersion(victim.gid), await worldRevision()];
    for (const authority of [{ gladiatorId: victim.gid }, { ownerId: victim.id }, { actorId: victim.id }]) {
      const command = { ...wear('wanderer'), ...authority };
      expect(await wearRpc(owner.id, command.operationId, command), JSON.stringify(authority)).toEqual({ ok: false, code: 'invalid' });
    }
    const theirs = wear('bloodied');
    expect(await wearRpc(owner.id, theirs.operationId, theirs)).toEqual({ ok: false, code: 'invalid' });
    const mine = wear('wanderer');
    expect(await wearRpc(owner.id, mine.operationId, mine)).toMatchObject({ ok: true });
    expect([await wornOf(owner.gid), await wornOf(victim.gid)]).toEqual(['wanderer', 'tiro']);
    expect([await rowVersion(victim.gid), await wearReceipts(victim.id)]).toEqual([version, 0]);
    expect(await worldRevision()).toBeGreaterThan(before);
  });

  it('is a backend-only security-invoker function: no client role can run it', async () => {
    expect(await sql`select p.prosecdef as definer, p.proconfig as config, p.proacl::text as acl, l.lanname as language,
      has_function_privilege('anon',p.oid,'EXECUTE') as anon, has_function_privilege('authenticated',p.oid,'EXECUTE') as player,
      has_function_privilege('service_role',p.oid,'EXECUTE') as backend
      from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=to_regprocedure('public.wear_title(uuid,uuid,jsonb)')`)
      .toEqual([{ definer: false, config: ['search_path=""'], acl: '{postgres=X/postgres,service_role=X/postgres}', language: 'plpgsql',
        anon: false, player: false, backend: true }]);
    const f = await holder();
    for (const [who, client] of [['player', f.client], ['visitor', anonymous]] as const) {
      const command = wear('wanderer');
      const { error } = await client.rpc('wear_title', { actor_id: f.id, operation_id: command.operationId, input: { command } });
      expect(error?.code, who).toBe('42501');
    }
    expect([await wornOf(f.gid), await wearReceipts(f.id)]).toEqual(['tiro', 0]);
  });

  it('publishes the worn title and the count', async () => {
    const f = await holder(), bare = await fighter();
    const titles = await titlesOf(f.gid);
    expect((await visitorReads(f.gid)).actor.title).toBe('tiro');
    const before = await worldRevision(), command = wear('wanderer');
    // Committed when the backend's call returns: a visitor's next read carries it, and the world revision rose.
    expect(await wearRpc(f.id, command.operationId, command)).toMatchObject({ ok: true });
    expect(await worldRevision()).toBeGreaterThan(before);
    const reads = await visitorReads(f.gid);
    expect(reads.actor.title).toBe('wanderer');
    expect((reads.profile.actor as Record<string, unknown>).title).toBe('wanderer');
    expect(reads.profile.titlesEarned).toBe(2);
    // A gladiator with no title: the key is there, null, and the count is 0.
    const none = await visitorReads(bare.gid);
    expect(none.actor).toHaveProperty('title', null);
    expect(none.profile.titlesEarned).toBe(0);
    // Only the worn id and a count are public: no counter, no source, no time of a title.
    for (const read of [reads.actor, reads.profile]) {
      const text = JSON.stringify(read);
      for (const secret of ['trainings', 'expeditions-won', 'titleProgress', 'earnedAtMs', '"titles"', 'history', 'source',
        ...titles.map(t => String(t.at))]) expect(text, secret).not.toContain(secret);
    }
    expect(Object.keys(reads.profile).sort()).toEqual(['actor', 'arenaRecord', 'banner', 'build', 'combatStrength', 'joinedAtMs',
      'prestige', 'rating', 'titlesEarned']);
    // A newly earned title republishes the count.
    await setCount(f.gid, 'arena-wins', 1);
    await award(f.gid, (await createdAt(f.gid)) + 3000);
    expect((await visitorReads(f.gid)).profile.titlesEarned).toBe(3);
  });

  it("reads the owner's titles and progress", async () => {
    const f = await fighter(), other = await holder();
    // Made five days and an hour ago: five whole days in camp.
    const made = (await dbNow()) - 5 * DAY - 3_600_000;
    await sql`update public.gladiators set created_at_ms=${made} where id=${f.gid}`;
    const result = randomUUID(), detail = { seasonIndex: 0, league: 'bronze', place: 3 };
    await setCount(f.gid, 'trainings', 10);
    await sql`select private.award_titles(${f.gid}, ${made + 3000}, ${result}, 'result', null)`;
    await setCount(f.gid, 'expeditions-won', 10);
    await sql`select private.award_titles(${f.gid}, ${made + 1000}, null, 'history', null)`;
    await setCount(f.gid, 'season-top-three', 1);
    await sql`select private.award_titles(${f.gid}, ${made + 2000}, null, 'season', ${sql.json(detail)})`;
    await setCount(f.gid, 'gold-v1', 7);
    await setCount(f.gid, 'gold-v2', 10);
    const state = await ownerState(f) as OwnerState & Record<string, unknown>;
    expect(state.wornTitle).toBe('tiro');
    // By earnedAtMs, then id.
    expect(state.titles).toEqual([
      { id: 'wanderer', earnedAtMs: made + 1000, activityId: null, source: 'history', detail: null },
      { id: 'medalist', earnedAtMs: made + 2000, activityId: null, source: 'season', detail },
      { id: 'tiro', earnedAtMs: made + 3000, activityId: result, source: 'result', detail: null }]);
    // Every stored counter (the starter items' four too), plus gold-earned (10 + floor(7/4)) and days-in-camp (now).
    const stored = await countersOf(f.gid);
    expect(stored).toMatchObject({ trainings: 10, 'expeditions-won': 10, 'season-top-three': 1, 'items-owned': 2 });
    expect(state.titleProgress).toEqual({ ...stored, 'gold-earned': 11, 'days-in-camp': 5 });
    // The owner's alone: another account reads its own, never these.
    const theirs = await ownerState(other) as OwnerState & Record<string, unknown>;
    expect([theirs.wornTitle, (theirs.titles as { id: string }[]).map(t => t.id)]).toEqual(['tiro', ['tiro', 'wanderer']]);
    // A new gladiator: no title, an empty list and its starter items' counters.
    const fresh = await fighter();
    const empty = await ownerState(fresh) as OwnerState & Record<string, unknown>;
    expect([empty.wornTitle, empty.titles]).toEqual([null, []]);
    expect(empty.titleProgress).toEqual({ ...(await countersOf(fresh.gid)), 'gold-earned': 0, 'days-in-camp': 0 });
  });

  it("states gold-earned and days-in-camp as private.title_measures does (ruling R3's accepted restatement)", async () => {
    // owner_state is an invoker view and the owner may not execute private.title_measures, so the view restates its two derived
    // measures. In one statement (one statement_timestamp) both must agree, at every v1 remainder and at ages of 0 to 400 days.
    // Each age keeps an hour or more from a day's edge, so the expected days below hold however late the statement runs.
    const f = await fighter(), now = await dbNow(), HOUR = 3_600_000;
    const compare = async () => {
      const [{ progress, measures }] = await sql`select o.state->'titleProgress' as progress,
        private.title_measures(g.id, floor(extract(epoch from statement_timestamp())*1000)::bigint) as measures
        from public.owner_state o join public.gladiators g on g.owner_id=o.owner_id where g.id=${f.gid}`;
      expect(progress).not.toBeNull();
      for (const key of Object.keys(progress)) expect(progress[key], key).toBe(measures[key]);
      return progress as Record<string, number>;
    };
    const seen: [number, number][] = [];
    for (const [v1, v2, age] of [[0, 0, 0], [1, 0, DAY - 2 * HOUR], [3, 5, DAY + HOUR], [4, 5, 2 * DAY - HOUR],
      [7, 0, 99 * DAY + HOUR], [8, 2, 100 * DAY + HOUR], [15, 9, 400 * DAY + HOUR]] as const) {
      await setCount(f.gid, 'gold-v1', v1);
      await setCount(f.gid, 'gold-v2', v2);
      await sql`update public.gladiators set created_at_ms=${now - age} where id=${f.gid}`;
      const progress = await compare();
      seen.push([progress['gold-earned'], progress['days-in-camp']]);
    }
    // Not vacuous: the values move as the measures say (the statement's clock is at or after `now`).
    expect(seen.map(([gold]) => gold)).toEqual([0, 0, 5, 6, 1, 4, 12]);
    expect(seen.map(([, days]) => days)).toEqual([0, 0, 1, 1, 99, 100, 400]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Task 5: the release back-fill (spec "The back-fill" and the "Back-fill" column of "What each measure counts"; Review
// Focus 4). History is seeded as rows while the seven title triggers are disabled, so it is history no trigger counted (as
// production holds it before M28: no title, no counter and no ownership-history row); they are enabled again before the
// back-fill runs, and after each case in any case.
const TITLE_TRIGGERS = [['public.gladiators', 'titles_on_gladiator'], ['public.activities', 'titles_on_activity'],
  ['public.wallet_ledger', 'titles_on_ledger'], ['public.item_instances', 'titles_on_item'], ['public.item_instances', 'titles_on_item_move'],
  ['private.season_awards', 'titles_on_season_award'], ['public.owned_cosmetics', 'titles_on_banner']] as const;
const titleTriggers = (state: 'enable' | 'disable') => sql.begin(async tx => {
  for (const [table, trigger] of TITLE_TRIGGERS) await tx.unsafe(`alter table ${table} ${state} trigger ${trigger}`);
});
/** Runs `seed` with the seven title triggers disabled: what it writes is history the triggers never counted. */
async function history<T>(seed: () => Promise<T>): Promise<T> {
  await titleTriggers('disable');
  try {
    return await seed();
  } finally {
    await titleTriggers('enable');
  }
}
/** The source's own statements for the seven counting triggers (titles_on_gladiator and section 3), as M28 runs them. */
const TRIGGER_STATEMENTS = readFileSync(new URL('../../supabase/sql/22-titles.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  .match(/^(?:drop trigger if exists titles_on_\w+ on [\w.]+;|create trigger titles_on_\w+[^;]*;)$/gm) ?? [];
type Backfill = { ok: boolean; ranAtMs: number; gladiators: number; titles: number; founders: number; worn: number; replayed: boolean };
const backfill = async () => (await sql`select private.backfill_titles() as result`)[0].result as Backfill;
const HOUR = 3_600_000;
/** No title worn and no title, counter or ownership-history row left: the world as M28 finds it (the gladiators stay). */
async function wipeTitles() {
  await sql.begin(async tx => {
    await tx`update public.gladiators set worn_title=null where worn_title is not null`;
    await tx`alter table public.gladiator_titles disable trigger guard_frozen`;
    await tx`alter table public.item_firsts disable trigger guard_frozen`;
    await tx`delete from public.gladiator_titles`;
    await tx`delete from public.item_firsts`;
    await tx`delete from public.title_counters`;
    // The deferred republication and worn-title check run now: a table with pending trigger events cannot be altered.
    await tx`set constraints all immediate`;
    await tx`alter table public.gladiator_titles enable trigger guard_frozen`;
    await tx`alter table public.item_firsts enable trigger guard_frozen`;
  });
}
/** An entry of a settlement summary's rewards.items, as private.expedition_rewards records one. */
const loot = (catalogId: string, quantity = 1) => {
  const entry = catalogId === 'salvage' ? CATALOG_V1.salvage : CATALOG_V1.items[catalogId];
  return { catalogId, catalogVersion: CATALOG_V1.version, tier: entry.tier, rarity: entry.rarity, quantity };
};
/** A placement in its own operator-written tournament (its pairing job a completed private job), as phase 8 writes one. */
async function placement(gid: string, activityId: string, place: number) {
  const slot = nextSlot++, tournament = `tournament:${slot}:bronze`;
  const [{ job }] = await sql`insert into private.jobs(kind,dedupe_key,slot_index,input,rules_version,due_at_ms,status)
    values('pair',${'titles-pair:' + randomUUID()},${slot},'{}','v1',0,'completed') returning id as job`;
  await sql`insert into public.tournament_views(id,pairing_job_id,slot_index,league,starts_at_ms,ends_at_ms,status,entrants,bracket,
    bouts,reveal_at_ms,published_at_ms) values(${tournament},${job},${slot},'bronze',${slot * SLOT},${(slot + 1) * SLOT},
    'insufficient-entrants','[]',null,'[]','[]',0)`;
  await sql`insert into public.tournament_placements(tournament_id,gladiator_id,activity_id,place) values(${tournament},${gid},${activityId},${place})`;
}
/** A season award with its receipt, as private.close_season records one. */
async function seasonAward(f: Fighter, seasonIndex: number, place: 1 | 2 | 3) {
  const receipt = randomUUID();
  await sql`insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
    values(${f.id},${randomUUID()},${receipt},${f.gid},${sql.json({ kind: 'season-award', seasonIndex } as never)},
      sha256(convert_to(${receipt},'UTF8')),'{"ok":true}')`;
  await sql`insert into private.season_awards(season_index,gladiator_id,league,place,money,renown,title,badge,receipt_id,awarded_at_ms)
    values(${seasonIndex},${f.gid},'bronze',${place},0,0,${place === 1 ? 'champion' : null},${['gold', 'silver', 'bronze'][place - 1]},
      ${receipt},${await dbNow()})`;
}
/** A successful buy-shop receipt of `f` that made `itemIds` of `catalogId` (the items may be gone since). */
async function shopReceipt(f: Fighter, catalogId: string, itemIds: string[]) {
  const operationId = randomUUID(), receipt = randomUUID();
  const request = { kind: 'buy-shop', operationId, catalogId, catalogVersion: CATALOG_V1.version, quantity: itemIds.length };
  await sql`insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
    values(${f.id},${operationId},${receipt},${f.gid},${sql.json(request as never)},sha256(convert_to(${receipt},'UTF8')),
      ${sql.json({ ok: true, receiptId: receipt, value: { itemIds, catalogId, catalogVersion: CATALOG_V1.version, quantity: itemIds.length } } as never)})`;
}
/** A listing of `itemId` by `seller`: sold to `buyer` (with the buyer's receipt), or cancelled when no buyer is given. */
async function listing(seller: Fighter, itemId: string, buyer?: Fighter) {
  const receipt = randomUUID(), id = randomUUID(), listedAt = (await dbNow()) - 3 * DAY, by = buyer ?? seller;
  await sql`insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
    values(${by.id},${randomUUID()},${receipt},${by.gid},${sql.json({ kind: buyer ? 'buy-listing' : 'cancel-listing', listingId: id } as never)},
      sha256(convert_to(${receipt},'UTF8')),'{"ok":true}')`;
  await sql`insert into private.market_listings(id,seller_gladiator_id,item_id,price,listed_at_ms,expires_at_ms,status,terminal_receipt_id,
    buyer_gladiator_id) values(${id},${seller.gid},${itemId},40,${listedAt},${listedAt + 7 * DAY},${buyer ? 'sold' : 'cancelled'},${receipt},
    ${buyer?.gid ?? null})`;
}
/** The advisory key a gate session holds to pause the back-fill at its first counter write, after its history reads. */
const PAUSE = 7_317_005;
/**
 * With `pause`, a test-only trigger holds every insert into public.title_counters until the gate session it passes to `run`
 * releases PAUSE; the trigger and its function are dropped afterwards, whatever happens. Without it, `run` gets no gate.
 */
async function withPause<T>(pause: boolean, run: (gate: Session | null) => Promise<T>): Promise<T> {
  if (!pause) return run(null);
  const q = await sql.reserve();
  try {
    const pid = (await q`select pg_backend_pid() as pid`)[0].pid as number;
    await q`select pg_advisory_lock(${PAUSE})`;
    await sql.unsafe(`create or replace function private.test_titles_pause() returns trigger language plpgsql set search_path='' as $$
      begin perform pg_catalog.pg_advisory_xact_lock_shared(${PAUSE}); return new; end $$`);
    await sql`drop trigger if exists test_titles_pause on public.title_counters`;
    await sql`create trigger test_titles_pause before insert on public.title_counters for each row
      execute function private.test_titles_pause()`;
    return await run({ q, pid });
  } finally {
    await sql`drop trigger if exists test_titles_pause on public.title_counters`;
    await sql`drop function if exists private.test_titles_pause()`;
    try {
      await q`select pg_advisory_unlock_all()`;
    } finally {
      q.release();
    }
  }
}
const firstsAt = async (gid: string) => (await sql`select catalog_id, first_at_ms::bigint as at from public.item_firsts
  where gladiator_id=${gid} order by catalog_id`).map(r => ({ id: r.catalog_id as string, at: Number(r.at) }));
/** Absent and 0 read alike (private.title_measures, owner_state's titleProgress). */
const nonzero = (counters: Record<string, number>) => Object.fromEntries(Object.entries(counters).filter(([, value]) => value !== 0));
const historyTitles = (ids: string[], at: number) => ids.map(id => ({ id, at, activity: null, source: 'history', detail: null }));

describe('the history back-fill', () => {
  afterEach(async () => {
    await titleTriggers('enable');
    await sql`delete from private.title_backfills`;
    await sql`delete from private.economy_switches`;
    await sql`update private.rules_versions set active=false where version<>'v1'`;
    await sql`update private.rules_versions set active=true where version='v1'`;
  });

  it('counts every measure from history', async () => {
    const f = await history(() => fighter());
    // 1.6's switch, as private.economy_switches records it: credits before it are v1 gold, credits from it v2 gold.
    const switchedAt = (await dbNow()) - DAY;
    await sql`insert into private.economy_switches(version,switched_at_ms,wallets_scanned,wallets_cut,money_before,money_after,result)
      values('v2',${switchedAt},1,0,100,100,'{}')`;
    await history(async () => {
      let at = await createdAt(f.gid);
      const done = async (kind: string, summary: Record<string, unknown>, requested: Record<string, unknown> = { kind }) => {
        const id = await activity(f.gid, kind, requested);
        await complete(id, summary, at += 1000);
        return id;
      };
      for (const expeditionId of [...Array(7).fill('woodland'), ...Array(5).fill('outpost')]) {
        await done('expedition', result(true), { kind: 'expedition', expeditionId });
      }
      await done('expedition', result(false), { kind: 'expedition', expeditionId: 'mountain' });
      for (let n = 0; n < 3; n++) await done('training', trained);
      // Ten points from Training (earned_points 20): more than the three Trainings still in the activities.
      await sql`update public.gladiators set earned_points=20,unspent_points=10 where id=${f.gid}`;
      for (const won of [true, false, true, true]) await done('arena', result(won));
      for (const place of [2, 1]) {
        const id = await activity(f.gid, 'tournament');
        await placement(f.gid, id, place);
        await complete(id, result(true), at += 1000);
      }
      await seasonAward(f, 0, 1);
      await credit(f, 'expedition', 40, { kind: 'activity-settlement' }, switchedAt - HOUR);
      await credit(f, 'npc-sale', 8, { kind: 'sell-item', itemId: randomUUID() }, switchedAt - HOUR);
      await credit(f, 'expedition', 10, { kind: 'activity-settlement' }, switchedAt + HOUR);
      await credit(f, 'market-sale', 30, { kind: 'market-sale' }, switchedAt + HOUR);
      await sql`insert into public.owned_cosmetics(gladiator_id,catalog_id,catalog_version,binding) values(${f.gid},'banner','v1','bound')`;
    });
    expect([await titlesOf(f.gid), await countersOf(f.gid), await firstsOf(f.gid)]).toEqual([[], {}, []]);
    const before = await dbNow();
    const outcome = await backfill();
    const after = await dbNow(), at = outcome.ranAtMs;
    expect(outcome).toEqual({ ok: true, ranAtMs: at, gladiators: 1, titles: 8, founders: 0, worn: 1, replayed: false });
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    // No mountain-won (the one Mountain trip was lost: absent when 0); the starter pair's four ownership measures.
    expect(await countersOf(f.gid)).toEqual({ 'expeditions-won': 12, 'woodland-won': 7, 'outpost-won': 5, trainings: 10, 'arena-wins': 3,
      'arena-streak': 2, 'arena-best-streak': 2, 'tournament-finals': 2, 'tournament-wins': 1, 'season-top-three': 1, 'season-firsts': 1,
      'gold-v1': 48, 'gold-v2': 10, 'items-owned': 2, 'rare-items': 0, 'tiers-of-one': 1, 'rarities-of-one': 1 });
    expect(await titlesOf(f.gid)).toEqual(historyTitles(['bannerman', 'bloodied', 'champion', 'finalist', 'medalist', 'tiro', 'victor',
      'wanderer'], at));
    // No season 0 row, so no Founder; the first tier-I title in catalog order is worn.
    expect(await wornOf(f.gid)).toBe('wanderer');
    // 10 + floor(48 / 4): no wealth title.
    expect((await measuresOf(f.gid, at))['gold-earned']).toBe(22);
  });

  it('rebuilds the ownership history from five sources', async () => {
    const [f, seller, holder] = await history(async () => [await fighter(), await fighter(), await fighter()]);
    await history(async () => {
      // The starter pair, parted with since (equipment released, then gone): every gladiator was given them.
      await sql`update public.item_instances set item=jsonb_set(item,'{reservation}','null') where gladiator_id=${f.gid}`;
      await sql`delete from public.item_instances where gladiator_id=${f.gid}`;
      // Held now.
      await giveItem(f.gid, 'axe:5:uncommon');
      // Found (sold since): only its expedition's summary names it; the salvage beside it never counts.
      await complete(await activity(f.gid, 'expedition', { kind: 'expedition', expeditionId: 'outpost' }),
        result(true, { money: 60, items: [loot('spear:5:rare'), loot('salvage', 2)] }), (await createdAt(f.gid)) + 1000);
      // Bought in a shop (discarded since): its own receipt.
      await shopReceipt(f, 'iron-helmet:1:common', [randomUUID()]);
      // Bought on the market: the item, held by another gladiator now.
      await listing(seller, await giveItem(holder.gid, 'bow:1:common'), f);
      // Not identifiable: a market-bought find gone since (no item, no shop receipt). Not its own: a listing sold to another
      // gladiator, and a cancelled one.
      await listing(seller, randomUUID(), f);
      await listing(seller, await giveItem(seller.gid, 'heavy-boots:5:rare'), holder);
      await listing(holder, await giveItem(holder.gid, 'round-shield:10:uncommon'));
    });
    const { ranAtMs: at } = await backfill();
    expect(await firstsAt(f.gid)).toEqual(['axe:5:uncommon', 'bow:1:common', 'iron-helmet:1:common', 'light-armor:1:common', 'spear:5:rare',
      'sword:1:common'].map(id => ({ id, at })));
    expect(await countersOf(f.gid)).toMatchObject({ 'items-owned': 6, 'rare-items': 1 });
    // The boots sold to another gladiator are that buyer's (the listing names it, though the seller holds the row in this seed).
    expect(await firstsOf(holder.gid)).toEqual(['bow:1:common', 'heavy-boots:5:rare', 'light-armor:1:common', 'round-shield:10:uncommon',
      'sword:1:common']);
  });

  it('makes Season 1 gladiators Founders and wears Founder', async () => {
    const now = await dbNow();
    const [first, second, late] = await history(async () => [await fighter(), await fighter(), await fighter()]);
    // Season 1 (season 0's row) ended a day ago; two were made before it ended, the third after.
    await openSeason(now - DAY);
    await history(async () => {
      await sql`update public.gladiators set created_at_ms=${now - 2 * DAY} where id in ${sql([first.gid, second.gid])}`;
      await sql`update public.gladiators set earned_points=20,unspent_points=10 where id=${first.gid}`;
      await sql`update public.gladiators set earned_points=110 where id=${late.gid}`;
    });
    const outcome = await backfill(), at = outcome.ranAtMs;
    expect(outcome).toEqual({ ok: true, ranAtMs: at, gladiators: 3, titles: 5, founders: 2, worn: 3, replayed: false });
    expect(await titlesOf(first.gid)).toEqual(historyTitles(['founder', 'tiro'], at));
    expect(await titlesOf(second.gid)).toEqual(historyTitles(['founder'], at));
    expect(await titlesOf(late.gid)).toEqual(historyTitles(['disciplined', 'tiro'], at));
    // Founder before any tier; the third wears its highest tier.
    expect([await wornOf(first.gid), await wornOf(second.gid), await wornOf(late.gid)]).toEqual(['founder', 'founder', 'disciplined']);
  });

  it('runs once', async () => {
    const f = await history(() => fighter());
    await history(() => sql`update public.gladiators set earned_points=20,unspent_points=10 where id=${f.gid}`);
    // Two calls at once: the second waits for the first's commit, then answers its record.
    const [first, waited] = await withSessions(async (a, b) => {
      const [{ result: ran }] = await a.q`select private.backfill_titles() as result`;
      const again = b.q`select private.backfill_titles() as result`.execute();
      await blockedBy(b, a);
      await a.q`commit`;
      const [{ result: replay }] = await again;
      await b.q`commit`;
      return [ran, replay] as Backfill[];
    });
    expect(first).toEqual({ ok: true, ranAtMs: first.ranAtMs, gladiators: 1, titles: 1, founders: 0, worn: 1, replayed: false });
    expect(waited).toEqual({ ...first, replayed: true });
    const state = async () => ({ counters: await countersOf(f.gid), firsts: await firstsAt(f.gid), titles: await titlesOf(f.gid),
      worn: await wornOf(f.gid) });
    const counted = await state();
    expect([counted.counters.trainings, counted.titles, counted.worn]).toEqual([10, historyTitles(['tiro'], first.ranAtMs), 'tiro']);
    // More history afterwards (none of it counted by a trigger): a later call replays the record and counts none of it.
    await history(async () => {
      await sql`update public.gladiators set earned_points=110 where id=${f.gid}`;
      await giveItem(f.gid, 'axe:5:uncommon');
      await complete(await activity(f.gid, 'expedition', { kind: 'expedition', expeditionId: 'woodland' }), result(true),
        (await createdAt(f.gid)) + 1000);
      await credit(f, 'expedition', 40, { kind: 'activity-settlement' });
    });
    expect(await backfill()).toEqual({ ...first, replayed: true });
    expect(await state()).toEqual(counted);
    expect((await sql`select ran_at_ms::bigint as at, result from private.title_backfills`).map(r => ({ at: Number(r.at), result: r.result })))
      .toEqual([{ at: first.ranAtMs, result: first }]);
  });

  it.each(["the source's trigger statements, then the back-fill", 'the back-fill alone, paused after its reads'] as const)(
    'never counts a waiting write twice (%s)', async variant => {
      expect(TRIGGER_STATEMENTS.filter(s => s.startsWith('create trigger'))).toHaveLength(7);
      const paused = variant.startsWith('the back-fill alone');
      await resetWorld(299);
      const trainee = await placedFighter({ schedule: TRAINING });
      // Its history before 1.7: nine points from Training (earned_points 19).
      await sql`update public.gladiators set earned_points=19,unspent_points=9 where id=${trainee.gid}`;
      const token = await coordinatorLease();
      expect(await runBoundary(300, token)).toMatchObject({ status: 'complete' });
      const [{ id: training }] = await sql`select id from public.activities where gladiator_id=${trainee.gid} and slot_index=300`;
      const leases = await claim('settlement');
      expect(leases.map(l => l.activityId)).toEqual([training]);
      // The world as M28 finds it: no title, counter or ownership-history row.
      await wipeTitles();
      const { counted, inside } = await withPause(paused, gate => withSessions(async (a, b) => {
        // M28's transaction: the seven triggers, then the back-fill, not yet committed. In the second variant only the
        // back-fill, its own locks alone, held at its first counter (its history already read) while the write arrives.
        if (!paused) await a.q.unsafe(TRIGGER_STATEMENTS.join('\n'));
        const running = a.q`select private.backfill_titles() as result`.execute();
        if (gate) await blockedBy(a, gate);
        // The worker's settlement of the Training, on another connection, waits for the back-fill's commit.
        const settling = b.q`select public.settle_activity(${training},${leases[0].token}) as outcome`.execute();
        await blockedBy(b, a);
        if (gate) await gate.q`select pg_advisory_unlock(${PAUSE})`;
        const [{ result: ran }] = await running;
        const seen = Object.fromEntries((await a.q`select counter, value::bigint as value from public.title_counters
          where gladiator_id=${trainee.gid}`).map(r => [r.counter as string, Number(r.value)]));
        await a.q`commit`;
        expect((await settling)[0].outcome).toMatchObject({ ok: true });
        await b.q`commit`;
        return { counted: ran as Backfill, inside: seen };
      }));
      // Placed in 1970 within season 0 (the boundary's): a Founder and an Old Guard from history, and nine Trainings.
      expect(counted).toEqual({ ok: true, ranAtMs: counted.ranAtMs, gladiators: 1, titles: 2, founders: 1, worn: 1, replayed: false });
      expect(inside).toEqual({ trainings: 9, 'items-owned': 2, 'rare-items': 0, 'tiers-of-one': 1, 'rarities-of-one': 1 });
      // The settlement counted once, by the trigger, after the commit: exactly its own Training, and its title with its result.
      expect(await countersOf(trainee.gid)).toEqual({ ...inside, trainings: 10 });
      const [{ at }] = await sql`select settled_at_ms::bigint as at from public.activities where id=${training}`;
      expect(await titlesOf(trainee.gid)).toEqual([...historyTitles(['founder', 'old-guard'], counted.ranAtMs),
        { id: 'tiro', at: Number(at), activity: training, source: 'result', detail: null }]);
      expect(await wornOf(trainee.gid)).toBe('founder');
    }, 90_000);

  it('leaves one history notice per gladiator', async () => {
    const [champion, bannerman, quiet] = await history(async () => [await fighter(), await fighter(), await fighter()]);
    await history(async () => {
      await seasonAward(champion, 0, 1);
      await sql`insert into public.owned_cosmetics(gladiator_id,catalog_id,catalog_version,binding) values(${bannerman.gid},'banner','v1','bound')`;
    });
    const notices = async () => Promise.all([champion, bannerman, quiet].map(async f => (await ownerState(f)).inbox.newNotifications));
    expect(await notices()).toEqual([0, 0, 0]);
    await backfill();
    // Medalist and Champion arrive together: one notice. A gladiator with no history title has none.
    expect(await idsOf(champion.gid)).toEqual(['champion', 'medalist']);
    expect(await notices()).toEqual([1, 1, 0]);
  });

  it('counts the same events as the live triggers (ruling R2)', async () => {
    // A finished season 0 (1970) for a real close; nobody made now is a founder.
    const season = seasonAt(0, 0);
    await sql`insert into public.seasons(season_index,starts_at_ms,ends_at_ms) values(${season.index},${season.startsAtMs},${season.endsAtMs})`;
    const f = await fighter(), seller = await fighter();
    await sql`update public.wallets set money=1000,renown=${RULES_V1.shops.bannerRenownPrice} where gladiator_id in ${sql([f.gid, seller.gid])}`;
    await current(f.gid, seller.gid);
    let at = await createdAt(f.gid);
    const done = async (kind: string, summary: Record<string, unknown>, requested: Record<string, unknown> = { kind }) => {
      const id = await activity(f.gid, kind, requested);
      await complete(id, summary, at += 1000);
      return id;
    };
    const trip = (expeditionId: string) => ({ kind: 'expedition', expeditionId });
    // Live, under v1, every trigger on: results by trip, an Arena run that ends in a loss, three placements, two Trainings.
    for (const id of ['woodland', 'woodland', 'woodland', 'woodland', 'woodland', 'woodland', 'outpost', 'outpost', 'outpost', 'mountain']) {
      await done('expedition', result(true), trip(id));
    }
    await done('expedition', result(false), trip('woodland'));
    // A won trip that found a Rare spear and salvage: the settlement credits its gold and inserts its items before it completes.
    const spear = await giveItem(f.gid, 'spear:5:rare'), scrap = await giveItem(f.gid, 'salvage', 'expedition', 3);
    await credit(f, 'expedition', 12, { kind: 'activity-settlement' });
    await done('expedition', result(true, { money: 12, items: [loot('spear:5:rare'), loot('salvage', 3)] }), trip('outpost'));
    for (const won of [true, true, false, true, true, true, false]) await done('arena', result(won));
    for (const place of [2, 1, 3]) {
      const id = await activity(f.gid, 'tournament');
      await placement(f.gid, id, place);
      await complete(id, result(true), at += 1000);
    }
    for (let n = 0; n < 2; n++) await done('training', trained);
    // Real commands: the find sold to a merchant (counts), a shop sword sold back (never counts), the banner; a market sale
    // credit (never counts); the seller's shop bow bought on the market and sold on to a merchant (counts: not the buyer's own
    // shop item; identified by the seller's shop receipt, the item being gone).
    expect(await sell(f, spear)).toMatchObject({ ok: true });
    const sword = await buy(f, 'sword:1:common');
    expect(await sell(f, (sword.value!.itemIds as string[])[0])).toMatchObject({ ok: true });
    expect(await buy(f, 'banner')).toMatchObject({ ok: true });
    await credit(f, 'market-sale', 30);
    const bow = await buy(seller, 'bow:1:common'), bowId = (bow.value!.itemIds as string[])[0];
    const offer = await list(seller, bowId, 40);
    expect(await buyListing(f, offer.value!.listingId as string)).toMatchObject({ ok: true });
    expect(await sell(f, bowId)).toMatchObject({ ok: true });
    // The switch to v2, recorded as 1.6 records it, then v2 gold: a result, salvage sold, a season first place (a real close).
    const switchedAt = await dbNow();
    await sql`insert into private.economy_switches(version,switched_at_ms,wallets_scanned,wallets_cut,money_before,money_after,result)
      values('v2',${switchedAt},2,0,0,0,'{}')`;
    await activate('v2');
    await current(f.gid, seller.gid);
    await credit(f, 'expedition', 10, { kind: 'activity-settlement' });
    expect(await sell(f, scrap, 3)).toMatchObject({ ok: true, value: { moneyCredit: 12 } });
    await sql`insert into private.arena_ratings(gladiator_id,league,season_index,rating,human_wins,human_losses) values(${f.gid},'bronze',0,1100,3,2)`;
    expect((await sql`select private.close_season(0,${await dbNow()}) as awards`)[0].awards).toBe(1);
    // A last result awards what the credits and the purchases added since the one before.
    await done('training', trained);
    const live = { f: await countersOf(f.gid), seller: await countersOf(seller.gid) };
    const liveTitles = { f: await idsOf(f.gid), seller: await idsOf(seller.gid) };
    const liveFirsts = { f: await firstsOf(f.gid), seller: await firstsOf(seller.gid) };
    // Not vacuous: every measure moved, the Arena run ended in a loss (a stored 0), and both gold buckets hold gold.
    expect(live.f).toMatchObject({ 'expeditions-won': 11, 'woodland-won': 6, 'outpost-won': 4, 'mountain-won': 1, trainings: 3,
      'arena-wins': 5, 'arena-streak': 0, 'arena-best-streak': 3, 'tournament-finals': 2, 'tournament-wins': 1, 'season-top-three': 1,
      'season-firsts': 1, 'items-owned': 4, 'rare-items': 1, 'tiers-of-one': 1, 'rarities-of-one': 1 });
    expect(live.f['gold-v1']).toBeGreaterThan(12);
    expect(live.f['gold-v2']).toBeGreaterThan(22);
    expect(liveFirsts.f).toEqual(['bow:1:common', 'light-armor:1:common', 'spear:5:rare', 'sword:1:common']);
    expect(liveTitles.f).toEqual(['bannerman', 'bloodied', 'champion', 'finalist', 'medalist', 'rare-find', 'victor', 'wanderer']);
    expect([live.seller['items-owned'], liveTitles.seller]).toEqual([3, []]);
    // The same events, counted from history alone.
    await wipeTitles();
    expect(await sql`select (select count(*) from public.title_counters)::int as counters,
      (select count(*) from public.gladiator_titles)::int as titles, (select count(*) from public.item_firsts)::int as firsts`)
      .toEqual([{ counters: 0, titles: 0, firsts: 0 }]);
    expect(await backfill()).toMatchObject({ ok: true, gladiators: 2, replayed: false });
    expect(nonzero(await countersOf(f.gid))).toEqual(nonzero(live.f));
    expect(nonzero(await countersOf(seller.gid))).toEqual(nonzero(live.seller));
    expect({ f: await firstsOf(f.gid), seller: await firstsOf(seller.gid) }).toEqual(liveFirsts);
    expect({ f: await idsOf(f.gid), seller: await idsOf(seller.gid) }).toEqual(liveTitles);
  });
});
