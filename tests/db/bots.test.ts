import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { account, admin, anonymous, creation, request, resetIdentity, sql, tokenFor } from '../fixtures/db.ts';
import { BOT_CATALOG_ORACLE, BOT_ITEM_SLOTS, BOT_KEYS, BOT_KITS, BOT_ROUTINE_ORACLE } from '../fixtures/bots.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import { createDatabase, createWorkerDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import { advance, claim, completePreparations, coordinatorLease, fighter, resetWorld, rpc, runBoundary, settleDue, SLOT } from '../fixtures/boundary.ts';
import { DEFAULT_EXECUTORS, prepareActivity } from '../../supabase/functions/_shared/backend/jobs.ts';
import type { DungeonGroupingInput, DungeonGroupingResult } from '../../supabase/functions/_shared/domain/dungeon-grouping.ts';
import { RULES_V2 } from '../../supabase/functions/_shared/domain/rules-v2.ts';
import type { JobLease, PreparationInput } from '../../supabase/functions/_shared/domain/types.ts';
import type { DungeonId } from '../../supabase/functions/_shared/contracts/commands.ts';
import { planDungeonRun, type DungeonRunInput, type DungeonRunPlan } from '../../supabase/functions/_shared/domain/dungeon.ts';
import type { TransactionSql } from 'postgres';

const commands = createDatabase(admin);
const systemIds = new Set<string>();
const allowedOrigins = ['http://127.0.0.1:3000'];
const emailOf = (key: string) => `${key}@ludus-nimbus.invalid`;

async function cleanSystemFixtures() {
  if (systemIds.size) await sql`delete from auth.users where id in ${sql([...systemIds])}`;
  systemIds.clear();
}
beforeEach(async () => {
  await resetIdentity();
  await sql`update private.scheduler set enabled=false where singleton`;
  await cleanSystemFixtures();
});
afterAll(async () => {
  try {
    await resetIdentity();
    await cleanSystemFixtures();
  } finally {
    await sql.end();
  }
});

async function systemAccount(key: string, banned = true) {
  const id = randomUUID();
  await sql`insert into auth.users(id,instance_id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,
      created_at,updated_at,banned_until,confirmation_token,recovery_token,email_change,email_change_token_new)
    values(${id},'00000000-0000-0000-0000-000000000000','authenticated','authenticated',${emailOf(key)},'',
      ${sql.json({ provider: 'cloudiator-bot', providers: [], bot_key: key })},'{}',now(),now(),
      case when ${banned} then now()+interval '100 years' end,'','','','')`;
  systemIds.add(id);
  return id;
}
async function registered(key: string, id: string) {
  const [{ result }] = await sql`select private.create_bot(${key},${id}::uuid) as result`;
  return result;
}
async function bench(key: string) {
  const [{ result }] = await sql`select private.bench_bot(${key}) as result`;
  return result;
}
async function botGladiator(key: string) {
  const [{ gladiator_id }] = await sql`select gladiator_id from private.bots where member_key=${key}`;
  return gladiator_id as string;
}
async function rowCount() {
  const [row] = await sql`select (select count(*)::int from private.bots) as bots,
    (select count(*)::int from public.gladiators) as gladiators,
    (select count(*)::int from public.item_instances) as items,
    (select count(*)::int from public.operation_receipts) as receipts,
    (select count(*)::int from public.wallet_ledger) as ledger`;
  return row;
}

describe('fixed catalog and registry', () => {
  it('matches the five SQL kits and 630 preseeded choices, without preseeded identities', async () => {
    const [{ catalog }] = await sql`select private.bot_catalog() as catalog`;
    expect(catalog).toEqual(BOT_CATALOG_ORACLE);
    const rows = await sql`select member_key,week_index,directive from private.bot_routines order by member_key,week_index`;
    expect(rows).toHaveLength(630);
    for (const key of BOT_KEYS) {
      const cells = rows.filter(row => row.member_key === key);
      expect(cells.map(row => row.week_index)).toEqual(Array.from({ length: 126 }, (_, index) => index));
      expect(cells.map(row => row.directive)).toEqual(BOT_ROUTINE_ORACLE[key]);
    }
    expect(await rowCount()).toEqual({ bots: 0, gladiators: 0, items: 0, receipts: 0, ledger: 0 });
  });

  it('registers all exact persisted kits with zero wallet, XP, receipt and ledger credit', async () => {
    for (const [key, name, level, classId, stance, role, , earnedPoints, , gear, peakStrength, , staminaMaximum, league] of BOT_KITS) {
      const id = await systemAccount(key);
      expect(await registered(key, id)).toEqual({ created: true, active: false });
      const gid = await botGladiator(key);
      const [row] = await sql`select r.team,r.role,r.active,g.name,g.level::int,g.earned_points::int,g.unspent_points::int,
        g.xp::int,g.peak_strength::float8,g.league,g.stamina_current::int,g.stamina_maximum::int,g.tournament_opt_in,
        b.current_build,w.money::int,w.renown::int from private.bots r
        join public.gladiators g on g.id=r.gladiator_id join public.builds b on b.gladiator_id=g.id
        join public.wallets w on w.gladiator_id=g.id where g.id=${gid}`;
      expect(row).toMatchObject({ team: 'ludus-nimbus', role, active: false, name, level, earned_points: earnedPoints,
        unspent_points: 0, xp: 0, peak_strength: peakStrength, league, stamina_current: staminaMaximum,
        stamina_maximum: staminaMaximum, tournament_opt_in: false, money: 0, renown: 0,
        current_build: { version: 1, classId, stance, allocations: BOT_CATALOG_ORACLE[key].allocation } });
      const items = await sql`select id,item from public.item_instances where gladiator_id=${gid}`;
      expect(items).toHaveLength(gear.filter(Boolean).length);
      expect(Object.keys(row.current_build.equipment).sort()).toEqual([...BOT_ITEM_SLOTS].sort());
      for (const [index, slot] of BOT_ITEM_SLOTS.entries()) {
        const catalogId = gear[index];
        const instance = row.current_build.equipment[slot];
        if (catalogId === null) expect(instance).toBeNull();
        else {
          const entry = CATALOG_V1.items[catalogId];
          expect(items.find(item => item.id === instance)?.item).toMatchObject({ catalogId, catalogVersion: 'v1', tier: entry.tier,
            rarity: entry.rarity, stats: entry.stats, quantity: 1, binding: 'bound', reservation: { kind: 'equipment', referenceId: gid } });
        }
      }
      expect(await registered(key, id)).toEqual({ created: false, active: false });
    }
    expect(await rowCount()).toEqual({ bots: 5, gladiators: 5, items: 22, receipts: 0, ledger: 0 });
  });

  it('serializes overlapping registration and returns the canonical result on retry', async () => {
    const id = await systemAccount('grit');
    const holder = await sql.reserve(), contender = await sql.reserve();
    const [{ pid: blocker }] = await holder`select pg_backend_pid() as pid`;
    const [{ pid: waiter }] = await contender`select pg_backend_pid() as pid`;
    let second: Promise<unknown> | undefined;
    try {
      await holder`begin`;
      expect((await holder`select private.create_bot('grit',${id}::uuid) as result`)[0].result)
        .toEqual({ created: true, active: false });
      second = contender`select private.create_bot('grit',${id}::uuid) as result`.execute().then(
        rows => rows[0].result, error => ({ error: (error as { code?: string }).code }));
      await expect.poll(async () => (await sql`select pg_blocking_pids(${waiter}) as blockers`)[0].blockers)
        .toContain(blocker);
      await holder`commit`;
      expect(await second).toEqual({ created: false, active: false });
    } finally {
      await holder`rollback`;
      await second;
      holder.release();
      contender.release();
    }
    expect(await rowCount()).toEqual({ bots: 1, gladiators: 1, items: 4, receipts: 0, ledger: 0 });
  });

  it('rejects a wrong account, key, unbanned identity or human name conflict without partial writes', async () => {
    const id = await systemAccount('tullia');
    expect(await registered('tullia', id)).toEqual({ created: true, active: false });
    const human = await account();
    const unbanned = await systemAccount('pip', false);
    await expect(registered('tullia', human.id)).rejects.toMatchObject({ code: '23505' });
    await expect(registered('grit', id)).rejects.toMatchObject({ code: '23514' });
    await expect(registered('ash', human.id)).rejects.toMatchObject({ code: '23514' });
    await expect(registered('pip', unbanned)).rejects.toMatchObject({ code: '23514' });
    await expect(registered('unknown', id)).rejects.toMatchObject({ code: '23514' });
    expect(await rowCount()).toEqual({ bots: 1, gladiators: 1, items: 5, receipts: 0, ledger: 0 });
    expect(await commands.createGladiator({ userId: human.id }, creation('Rufus'))).toMatchObject({ ok: true });
    const rufus = await systemAccount('rufus');
    await expect(registered('rufus', rufus)).rejects.toMatchObject({ code: '23505' });
    expect(await rowCount()).toEqual({ bots: 1, gladiators: 2, items: 7, receipts: 1, ledger: 1 });
  });

  it('benches an existing bot idempotently and an earlier create replay preserves the bench', async () => {
    const id = await systemAccount('tullia');
    await registered('tullia', id);
    const gid = await botGladiator('tullia');
    // Task 6C owns activation. As owner, arrange the precondition for the real bench action.
    await sql`update private.bots set active=true where member_key='tullia'`;
    expect(await registered('tullia', id)).toEqual({ created: false, active: true });
    expect(await bench('tullia')).toEqual({ changed: true, active: false });
    expect(await bench('tullia')).toEqual({ changed: false, active: false });
    expect(await registered('tullia', id)).toEqual({ created: false, active: false });
    expect(await botGladiator('tullia')).toBe(gid);
    expect(await rowCount()).toEqual({ bots: 1, gladiators: 1, items: 5, receipts: 0, ledger: 0 });
  });

  it('runs the operator implementation locally twice and safely refuses a conflicting Auth row', async () => {
    const operatorScript = '../../scripts/create-bots.mjs';
    const { provisionBots } = await import(operatorScript);
    const addresses = BOT_KEYS.map(emailOf);
    expect(await sql`select count(*)::int as n from auth.users where email in ${sql(addresses)}`).toEqual([{ n: 0 }]);
    try {
      await systemAccount('pip', false);
      await expect(provisionBots(sql)).rejects.toMatchObject({ message: 'Bot provisioning failed for pip.' });
      expect(await rowCount()).toEqual({ bots: 0, gladiators: 0, items: 0, receipts: 0, ledger: 0 });
      expect(await sql`select count(*)::int as n from auth.users where email in ${sql(addresses)}`).toEqual([{ n: 1 }]);
      await cleanSystemFixtures();
      expect(await provisionBots(sql)).toEqual({ created: 5, existing: 0, active: 0 });
      expect(await provisionBots(sql)).toEqual({ created: 0, existing: 5, active: 0 });
      expect(await sql`select count(*)::int as n from auth.users u where email in ${sql(addresses)}
        and banned_until>clock_timestamp() and coalesce(encrypted_password,'')='' and email_confirmed_at is null
        and not exists(select from auth.identities i where i.user_id=u.id)`).toEqual([{ n: 5 }]);
      await sql`update auth.users set banned_until=null where email=${emailOf('pip')}`;
      await expect(provisionBots(sql)).rejects.toMatchObject({ message: 'Bot provisioning failed for pip.' });
      expect(await rowCount()).toEqual({ bots: 5, gladiators: 5, items: 22, receipts: 0, ledger: 0 });
      expect(await sql`select count(*)::int as n from auth.users where email=${emailOf('pip')} and banned_until is null`)
        .toEqual([{ n: 1 }]);
    } finally {
      for (const { id } of await sql`select id from auth.users where email in ${sql(addresses)}`) systemIds.add(id);
    }
  });
});

describe('trusted identity and public disclosure', () => {
  it('has no real Auth sign-in and rejects a locally signed bearer for the banned bot', async () => {
    const id = await systemAccount('grit');
    await registered('grit', id);
    const denied = await anonymous.auth.signInWithPassword({ email: emailOf('grit'), password: 'unused-local-password' });
    expect(denied.data.session === null).toBe(true);
    expect(denied.error?.code).toBe('email_provider_disabled');
    const identity = await admin.auth.admin.getUserById(id);
    expect(identity.error).toBeNull();
    expect(identity.data.user?.identities?.length).toBe(0);
    const bearer = await anonymous.auth.getUser(tokenFor(id));
    expect(bearer.data.user === null).toBe(true);
    expect(bearer.error?.code).toBe('user_banned');
    const human = await account();
    expect((await anonymous.auth.getUser(human.token)).error).toBeNull();
  });

  it('denies commands at the trusted account seam for active and benched bots', async () => {
    const id = await systemAccount('grit');
    await registered('grit', id);
    const human = await account();
    const send = (userId: string, body: unknown) => handleCommand(request('verified-by-fixture', body), {
      verifyActor: async () => ({ userId }), database: commands, allowedOrigins,
    });
    const presence = { kind: 'presence', operationId: randomUUID() };
    for (const active of [true, false]) {
      await sql`update private.bots set active=${active} where member_key='grit'`;
      for (const command of [presence, creation('Wrong Grit')]) {
        const response = await send(id, command);
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ ok: false, code: 'unauthenticated' });
      }
      expect(await commands.createGladiator({ userId: id }, creation('Wrong Grit')))
        .toEqual({ ok: false, code: 'unauthenticated' });
    }
    const humanResponse = await send(human.id, presence);
    expect(humanResponse.status).toBe(200);
    expect(await humanResponse.json()).toEqual({ ok: true });
    expect(await sql`select count(*)::int as count from private.owner_signals where owner_id=${id}`).toEqual([{ count: 0 }]);
    expect(await sql`select count(*)::int as count from private.command_attempts where actor_id=${id}`).toEqual([{ count: 0 }]);
  });

  it('excludes bot Founder before initial awarding and on a later award while preserving human fields', async () => {
    const [{ cutoff }] = await sql`select floor(extract(epoch from clock_timestamp())*1000)::bigint+86400000 as cutoff`;
    await sql`insert into public.seasons(season_index,starts_at_ms,ends_at_ms) values(0,${Number(cutoff) - 2_419_200_000},${cutoff})`;
    const human = await account();
    const created = await commands.createGladiator({ userId: human.id }, creation('Human Founder'));
    if (!created.ok) throw new Error('Human creation control failed');
    const humanId = created.value.gladiatorId;
    const id = await systemAccount('tullia');
    await registered('tullia', id);
    const gid = await botGladiator('tullia');
    await registered('tullia', id);
    expect(await sql`select private.title_measures(${gid},${cutoff}) -> 'founder' as founder`).toEqual([{ founder: 0 }]);
    await sql`select private.award_titles(${gid},${cutoff},null,'joined',null)`;
    expect(await sql`select gladiator_id,source from public.gladiator_titles where title_id='founder'`)
      .toEqual([{ gladiator_id: humanId, source: 'joined' }]);
    await sql`select private.give_title(${humanId},'game-master')`;

    for (const client of [anonymous, human.client]) {
      const { data: actor, error: actorError } = await client.from('world_actor_reads').select('actor').eq('gladiator_id', gid).single();
      expect(actorError).toBeNull();
      expect(actor?.actor).toMatchObject({ gladiatorId: gid, name: 'Tullia', botTeam: 'ludus-nimbus', appearance: null,
        botDuty: 'off-duty', botReturnsAtMs: null });
      expect(Object.keys(actor?.actor).sort()).toEqual([
        'activityId', 'activityStatus', 'appearance', 'botDuty', 'botReturnsAtMs', 'botTeam', 'classId', 'endsAtMs', 'equipmentSilhouettes', 'gladiatorId',
        'league', 'level', 'location', 'name', 'phase', 'resting', 'startsAtMs', 'title', 'visibleStage',
      ]);
      const { data: bot, error: botError } = await client.from('public_profile_reads').select('profile').eq('gladiator_id', gid).single();
      expect(botError).toBeNull();
      expect(bot?.profile.actor).toEqual(actor?.actor);
      expect(JSON.stringify(bot?.profile)).not.toContain(id);
      const { data: profile, error: profileError } = await client.from('public_profile_reads').select('profile').eq('gladiator_id', humanId).single();
      expect(profileError).toBeNull();
      expect(profile?.profile).toMatchObject({ actor: { title: 'game-master', appearance: null },
        build: { stance: 'balanced' }, arenaRecord: { wins: 0, losses: 0 }, banner: false, titlesEarned: 2 });
      expect(profile?.profile.actor).not.toHaveProperty('botTeam');
    }
  });
});

const MONDAY = Date.UTC(2026, 0, 5) / SLOT;
const rest = { kind: 'rest' } as const;
const restDay = { morning: rest, afternoon: rest, evening: rest };

async function resetV2(slot: number) {
  await resetWorld(slot - 1);
  await sql.begin(async tx => {
    await tx`update private.rules_versions set active=false where active`;
    await tx`update private.rules_versions set active=true where version='v2'`;
  });
}

async function oldBot(key: string, slot: number, stamina = 100, active = true) {
  await registered(key, await systemAccount(key));
  const gid = await botGladiator(key);
  await sql`update public.gladiators set created_at_ms=${(slot - 30 * 18) * SLOT},orientation_end_ms=${slot * SLOT},
    processed_slot_index=${slot - 1},stamina_current=${stamina} where id=${gid}`;
  if (active) expect(await activate(key)).toEqual({ changed: true, active: true });
  return gid;
}

async function activate(key: string) {
  return (await sql`select private.activate_bot(${key}) as result`)[0].result;
}

async function actor(gid: string) {
  const { data, error } = await anonymous.from('world_actor_reads').select('actor').eq('gladiator_id', gid).single();
  expect(error).toBeNull();
  return data!.actor;
}

async function activity(gid: string, slot: number) {
  return (await sql`select id,resolved_kind as kind,stamina_debit::int as debit,fallback
    from public.activities where gladiator_id=${gid} and slot_index=${slot}`)[0];
}

const complete = (job: JobLease, result: unknown) => rpc('complete_job', { job_id: job.id, lease_token: job.token, result });
const propose = async (job: JobLease) => await DEFAULT_EXECUTORS.v2.pair!(job) as DungeonGroupingResult;
const settle = createWorkerDatabase(admin).settle;

async function botProgression(ids: string[]) {
  return sql`select g.id,g.xp::int,g.level::int,g.earned_points::int,g.unspent_points::int,
    to_jsonb(w) as wallet,(select count(*)::int from public.wallet_ledger where gladiator_id=g.id) as ledger,
    (select jsonb_agg(i.item order by i.id) from public.item_instances i where gladiator_id=g.id) as items,
    (select count(*)::int from public.operation_receipts where owner_id=g.owner_id) as receipts,
    (select count(*)::int from public.title_counters where gladiator_id=g.id) as counters
    from public.gladiators g join public.wallets w on w.gladiator_id=g.id where g.id in ${sql(ids)} order by g.id`;
}

const clockAt = (tx: TransactionSql, ms: number) => tx.unsafe(`create or replace function private.planning_now_ms() returns bigint
  language sql volatile security invoker set search_path='' as 'select ${ms}::bigint'`);

describe('frozen bot duty and dungeon seats', () => {
  afterAll(async () => {
    await sql.begin(async tx => {
      await tx`update private.rules_versions set active=false where active`;
      await tx`update private.rules_versions set active=true where version='v1'`;
    });
  });

  it('activates and benches only for the database owner and keeps a recently registered bench out of the human cohort', async () => {
    const target = MONDAY + 7;
    await resetV2(target);
    const gid = await oldBot('pip', target, 39, false);
    await sql`update public.gladiators set created_at_ms=${(target - 1) * SLOT + 1} where id=${gid}`;
    expect(await activate('pip')).toEqual({ changed: true, active: true });
    expect(await activate('pip')).toEqual({ changed: false, active: true });
    expect(await bench('pip')).toEqual({ changed: true, active: false });
    for (const role of ['service_role', 'authenticated', 'anon']) {
      expect(await sql`select has_function_privilege(${role},'private.activate_bot(text)','EXECUTE') as activate,
        has_function_privilege(${role},'private.bench_bot(text)','EXECUTE') as bench`).toEqual([{ activate: false, bench: false }]);
    }
    expect(await runBoundary(target)).toMatchObject({ status: 'complete' });
    expect(await sql`select 1 from private.boundary_members where gladiator_id=${gid}`).toEqual([]);
    expect(await sql`select 1 from public.character_rests where gladiator_id=${gid}`).toEqual([]);
    expect(await actor(gid)).toMatchObject({ botDuty: 'off-duty', botReturnsAtMs: null, activityId: null });
  });

  it.each([0, 5])('uses scheduled UTC duty after a late boundary at offset %i and advances to 08:00', async offset => {
    const target = MONDAY + offset;
    await resetV2(target);
    const gid = await oldBot('pip', target, 39);
    expect(await runBoundary(target)).toMatchObject({ status: 'complete' });
    expect(await actor(gid)).toMatchObject({ botDuty: 'off-duty', botReturnsAtMs: (MONDAY + 6) * SLOT,
      location: 'camp', activityId: null, activityStatus: 'idle', startsAtMs: null, endsAtMs: null });
    expect(await activity(gid, target)).toBeUndefined();
    expect(await sql`select 1 from private.jobs where gladiator_id=${gid} and slot_index=${target}`).toEqual([]);
    expect(await sql`select processed_slot_index::int as slot,stamina_current::int as stamina from public.gladiators where id=${gid}`)
      .toEqual([{ slot: target, stamina: 39 }]);
    expect(await sql`select 1 from public.character_rests where gladiator_id=${gid}`).toEqual([]);
    if (offset === 5) {
      expect(await runBoundary(target + 1)).toMatchObject({ status: 'complete' });
      expect(await activity(gid, target + 1)).toMatchObject({ kind: 'rest', debit: 0 });
      expect(await actor(gid)).toMatchObject({ botDuty: 'on-duty', botReturnsAtMs: null });
    }
  });

  it.each([44, 45])('freezes duty after %i qualifying humans and leaves their schedules intact', async count => {
    const target = MONDAY + 7;
    await resetV2(target);
    const bots = [];
    for (const key of BOT_KEYS) bots.push(await oldBot(key, target));
    for (let i = 0; i < count; i++) await fighter({ firstSlot: target, schedule: restDay });
    const idle = await fighter({ firstSlot: target, schedule: restDay });
    await sql`update public.gladiators set created_at_ms=${(target - 252) * SLOT} where id=${idle.gid}`;
    const revisions = () => sql`select gladiator_id,phase,choice,version from public.schedule_revisions order by gladiator_id,phase,version`;
    const before = await revisions();
    const prior = await actor(bots[0]);
    const token = await coordinatorLease();
    expect(await advance(target, token)).toMatchObject({ phase: 4, wait: 'preparation' });
    expect(await actor(bots[0])).toEqual(prior);
    expect(await sql`select count(*)::int as count from private.boundary_members where slot_index=${target}`)
      .toEqual([{ count: count === 44 ? 49 : 45 }]);
    await sql`update private.bots set active=false where active`;
    await sql`insert into private.owner_signals(owner_id,last_signal_ms) values(${idle.id},${target * SLOT})`;
    for (let pass = 0; pass < 3; pass++) await completePreparations();
    expect(await advance(target, token)).toMatchObject({ status: 'complete' });
    expect(await advance(target, token)).toMatchObject({ status: 'complete' });
    expect(await revisions()).toEqual(before);
    expect(await activity(idle.gid, target)).toBeUndefined();
    for (const gid of bots) {
      if (count === 44) {
        expect(await activity(gid, target)).toMatchObject({ kind: 'training', debit: 20 });
      } else {
        expect(await activity(gid, target)).toBeUndefined();
        expect(await actor(gid)).toMatchObject({ botDuty: 'off-duty', botReturnsAtMs: null });
      }
    }
    expect(await sql`select 1 from private.jobs where slot_index=${target} and kind='pair'`).toEqual([]);
    expect(await sql`select 1 from private.dungeon_runs where slot_index=${target}`).toEqual([]);
    expect(await sql`select 1 from public.arena_standings where gladiator_id in ${sql(bots)}`).toEqual([]);
  }, 45_000);

  it('freezes disjoint affordable pools and rejects forged and omitted seats before accepting either run', async () => {
    const target = MONDAY + 7;
    await resetV2(target);
    const tullia = await oldBot('tullia', target, 40);
    const rufus = await oldBot('rufus', target, 40);
    const grit = await oldBot('grit', target, 39);
    const entrant = async (dungeonId: DungeonId, stamina: number) => {
      const owner = await fighter({ firstSlot: target, stamina, schedule: { ...restDay, afternoon: { kind: 'dungeon', dungeonId } } });
      await sql`update public.gladiators set level=${dungeonId === 'troll-hall' ? 12 : 3} where id=${owner.gid}`;
      return owner.gid;
    };
    const trollHuman = await entrant('troll-hall', 40);
    const wolfHuman = await entrant('wolf-den', 40);
    const poor = await entrant('wolf-den', 39);
    const legacy = await entrant('wolf-den', 100);
    const token = await coordinatorLease();
    expect(await advance(target, token)).toMatchObject({ phase: 4, wait: 'preparation' });
    for (const job of await claim('prepare')) {
      const prep = prepareActivity(job.snapshot as PreparationInput, RULES_V2);
      const { dungeon: _dungeon, ...costs } = prep.costs;
      expect(await complete(job, job.gladiatorId === legacy ? { ...prep, costs } : prep)).toMatchObject({ ok: true });
    }
    expect(await advance(target, token)).toMatchObject({ phase: 7, wait: 'pairing' });
    const jobs = await claim('pair');
    expect(jobs).toHaveLength(2);
    const snapshot = (job: JobLease) => job.snapshot as DungeonGroupingInput;
    const troll = jobs.find(job => snapshot(job).dungeonId === 'troll-hall')!;
    const wolf = jobs.find(job => snapshot(job).dungeonId === 'wolf-den')!;
    expect(snapshot(troll).entrants.map(member => member.gladiatorId)).toEqual([trollHuman]);
    expect(snapshot(wolf).entrants.map(member => member.gladiatorId)).toEqual([wolfHuman]);
    expect(snapshot(troll).bots?.map(member => member.gladiatorId)).toEqual([tullia]);
    expect(snapshot(wolf).bots?.map(member => member.gladiatorId)).toEqual([rufus]);
    for (const gid of [poor, legacy]) expect(await activity(gid, target)).toMatchObject({ kind: 'rest', debit: 0 });
    const wolfPlan = await propose(wolf);
    const trollPlan = await propose(troll);
    const [human, bot, hire] = wolfPlan.runs[0].seats;
    expect(wolfPlan.runs[0].seats.map(seat => seat.kind)).toEqual(['human', 'bot', 'hireling']);
    for (const seats of [[human, { ...bot, gladiatorId: tullia }, hire], [human, { ...bot, role: 'striker' }, hire],
      [human, bot, { ...bot, seat: 2 }], [human, { kind: 'hireling', seat: 1, role: 'guard' }, hire],
      [{ ...bot, seat: 0 }, bot, hire]]) {
      expect(await complete(wolf, { runs: [{ ...wolfPlan.runs[0], seats }] })).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(await sql`select 1 from private.dungeon_runs where slot_index=${target}`).toEqual([]);
    expect(await activity(rufus, target)).toMatchObject({ kind: 'training', debit: 20 });
    await bench('tullia');
    await sql`update public.gladiators set stamina_current=40 where id=${grit}`;
    const wolfResult = await complete(wolf, wolfPlan);
    expect(wolfResult).toMatchObject({ ok: true });
    expect(await complete(wolf, wolfPlan)).toEqual({ ...wolfResult, replayed: true });
    let current = troll;
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await rpc('fail_job', { job_id: current.id, lease_token: current.token, failure_code: 'execution-failed' }))
        .toMatchObject({ ok: true, status: attempt === 3 ? 'operator' : 'pending' });
      if (attempt < 3) {
        expect(await advance(target, token)).toMatchObject({ phase: 7, wait: 'pairing' });
        [current] = await claim('pair');
      }
    }
    expect(await advance(target, token)).toMatchObject({ phase: 7, wait: 'operator' });
    await sql`select private.resume_operator_job(${troll.id})`;
    expect(await advance(target, token)).toMatchObject({ phase: 7, wait: 'pairing' });
    const [resumed] = await claim('pair');
    expect(resumed).toMatchObject({ id: troll.id, snapshot: troll.snapshot, seed: troll.seed, attempt: 4 });
    expect(await complete(troll, trollPlan)).toMatchObject({ ok: false, code: 'conflict' });
    const trollResult = await complete(resumed, trollPlan);
    expect(trollResult).toMatchObject({ ok: true });
    expect(await complete(resumed, trollPlan)).toEqual({ ...trollResult, replayed: true });
    expect(await advance(target, token)).toMatchObject({ status: 'complete' });
    for (const gid of [rufus, tullia]) expect(await activity(gid, target)).toMatchObject({ kind: 'dungeon', debit: 40, fallback: false });
    expect(await activity(grit, target)).toMatchObject({ kind: 'training', debit: 20 });
    expect((await sql`select a.gladiator_id from private.dungeon_run_members m join public.activities a on a.id=m.activity_id
      where a.slot_index=${target} order by a.gladiator_id`).map(row => row.gladiator_id))
      .toEqual([trollHuman, wolfHuman].sort());
    expect((await sql`select s->>'gladiatorId' as id from private.dungeon_runs r
      cross join lateral jsonb_array_elements(r.assignment->'seats') s where r.slot_index=${target} and s->>'kind'='bot'
      order by id`).map(row => row.id)).toEqual([rufus, tullia].sort());
  });

  it('uses ordinary Training debits and fallback but never grants a bot progression or public results', async () => {
    const target = MONDAY + 7;
    await resetV2(target);
    const pip = await oldBot('pip', target);
    const poor = await oldBot('grit', target, 19);
    const before = await botProgression([pip, poor]);
    const token = await coordinatorLease();
    expect(await runBoundary(target, token)).toMatchObject({ status: 'complete' });
    expect(await activity(pip, target)).toMatchObject({ kind: 'training', debit: 20, fallback: false });
    expect(await activity(poor, target)).toMatchObject({ kind: 'rest', debit: 0, fallback: true });
    await settleDue(target, token);
    expect(await runBoundary(target + 1, token)).toMatchObject({ status: 'complete' });
    expect(await activity(pip, target + 1)).toMatchObject({ kind: 'training', debit: 20, fallback: false });
    await settleDue(target + 1, token);
    expect(await botProgression([pip, poor])).toEqual(before);
    expect(await sql`select stamina_current::int as stamina from public.gladiators where id=${pip}`).toEqual([{ stamina: 60 }]);
    expect(await sql`select 1 from public.activities where gladiator_id in (${pip},${poor}) and (summary is not null or receipt_id is not null)`).toEqual([]);
  });

  it('counts actual Training toward the v2 limit and keeps an exhausted bot on ordinary Rest', async () => {
    const target = MONDAY + 7;
    await resetV2(target);
    const pip = await oldBot('pip', target);
    await sql`insert into private.settled_slots(gladiator_id,slot_index,activity_id,receipt_id,resolved_kind,settled_at_ms)
      values(${pip},${target - 1},${randomUUID()},${randomUUID()},'training',${target * SLOT})`;
    const token = await coordinatorLease();
    expect(await runBoundary(target, token)).toMatchObject({ status: 'complete' });
    expect(await activity(pip, target)).toMatchObject({ kind: 'training', debit: 20 });
    await settleDue(target, token);
    expect(await runBoundary(target + 1, token)).toMatchObject({ status: 'complete' });
    expect(await activity(pip, target + 1)).toMatchObject({ kind: 'rest', debit: 0, fallback: false });
    await settleDue(target + 1, token);
    expect(await sql`select resolved_kind as kind from private.settled_slots where gladiator_id=${pip} order by slot_index`)
      .toEqual([{ kind: 'training' }, { kind: 'training' }, { kind: 'rest' }]);
    expect(await sql`select stamina_current=stamina_maximum as recovered from public.gladiators where id=${pip}`)
      .toEqual([{ recovered: true }]);
  });

  it('fences the bot terminal with the human reveal and settles it once without rewards or a public result', async () => {
    const target = MONDAY + 7;
    await resetV2(target);
    const tullia = await oldBot('tullia', target);
    const human = await fighter({ firstSlot: target, schedule: { ...restDay, afternoon: { kind: 'dungeon', dungeonId: 'wolf-den' } } });
    await sql`update public.gladiators set level=3 where id=${human.gid}`;
    const token = await coordinatorLease();
    expect(await advance(target, token)).toMatchObject({ phase: 4, wait: 'preparation' });
    await completePreparations();
    expect(await advance(target, token)).toMatchObject({ phase: 7, wait: 'pairing' });
    const [pair] = await claim('pair');
    expect(await complete(pair, await propose(pair))).toMatchObject({ ok: true });
    expect(await advance(target, token)).toMatchObject({ status: 'complete' });
    const botActivity = (await activity(tullia, target)).id;
    expect(await actor(tullia)).toMatchObject({ location: 'dungeon:wolf-den', activityId: botActivity, botDuty: 'on-duty' });
    const [simulation] = await claim('simulation');
    const plan = await DEFAULT_EXECUTORS.v2.simulation!(simulation) as DungeonRunPlan;
    const input = simulation.snapshot as DungeonRunInput;
    const control = planDungeonRun({ ...input, seats: input.seats.map(seat => seat.kind === 'bot'
      ? { seat: seat.seat, kind: 'hireling', role: seat.role } : seat) }, simulation.seed!, RULES_V2);
    expect(plan.outcomes).toEqual(control.outcomes);
    expect(plan.outcomes.map(member => member.gladiatorId)).toEqual([human.gid]);
    const [first, ...later] = plan.fights;
    const forged = { ...first, log: { ...first.log, participants: first.log.participants.map(p =>
      p.role === 'bot' ? { ...p, name: 'Impostor' } : p) } };
    expect(await complete(simulation, { ...plan, fights: [forged, ...later] })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await complete(simulation, plan)).toMatchObject({ ok: true });
    for (let n = 0; n < plan.stages.length - 1; n++) {
      const [reveal] = await claim('reveal');
      expect(await complete(reveal, {})).toMatchObject({ ok: true });
    }
    const end = (target + 1) * SLOT;
    const rollback = new Error('rollback-only fixture');
    await sql.begin(async tx => {
      const leases = async (): Promise<JobLease[]> => (await tx`select public.claim_jobs(${randomUUID()},'settlement',20) as jobs`)[0].jobs;
      await clockAt(tx, end - 1);
      expect(await leases()).toEqual([]);
      await clockAt(tx, end);
      const [final, ...terminals] = await leases();
      expect(final.kind).toBe('reveal');
      expect(terminals.map(job => job.gladiatorId).sort()).toEqual([human.gid, tullia].sort());
      for (const job of terminals) {
        const [{ result }] = await tx`select public.settle_activity(${job.activityId},${job.token}) as result`;
        expect(result).toEqual({ ok: false, code: 'processing' });
      }
      throw rollback;
    }).catch(error => { if (error !== rollback) throw error; });
    const before = await botProgression([tullia]);
    const [final, ...terminals] = await claim('settlement');
    expect(await complete(final, {})).toMatchObject({ ok: true });
    const bot = terminals.find(job => job.gladiatorId === tullia)!;
    const member = terminals.find(job => job.gladiatorId === human.gid)!;
    const expected = plan.outcomes[0].rewards;
    expect(await settle(member.activityId!, member.token)).toMatchObject({ ok: true, newGrants: 1,
      summary: { rewards: { xp: expected.xp, money: expected.money } } });
    expect(await settle(bot.activityId!, bot.token)).toEqual({ ok: true, activityId: botActivity, newGrants: 0 });
    expect(await settle(bot.activityId!, bot.token)).toEqual({ ok: true, activityId: botActivity, newGrants: 0, replayed: true });
    expect(await botProgression([tullia])).toEqual(before);
    expect(await sql`select status,summary,receipt_id from public.activities where id=${botActivity}`)
      .toEqual([{ status: 'completed', summary: null, receipt_id: null }]);
    expect(await sql`select 1 from public.recent_results where gladiator_id=${tullia}`).toEqual([]);
    const { data, error } = await anonymous.from('dungeon_fights').select('log').eq('run_id', plan.runId).eq('ordinal', 1).single();
    expect(error).toBeNull();
    expect(data?.log.participants).toContainEqual(expect.objectContaining({ id: tullia, gladiatorId: tullia, role: 'bot', name: 'Tullia' }));
  });
});
