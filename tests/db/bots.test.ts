import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { account, admin, anonymous, creation, request, resetIdentity, sql, tokenFor } from '../fixtures/db.ts';
import { BOT_CATALOG_ORACLE, BOT_ITEM_SLOTS, BOT_KEYS, BOT_KITS, BOT_ROUTINE_ORACLE } from '../fixtures/bots.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';

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
      expect(actor?.actor).toMatchObject({ gladiatorId: gid, name: 'Tullia', botTeam: 'ludus-nimbus', appearance: null });
      expect(Object.keys(actor?.actor).sort()).toEqual([
        'activityId', 'activityStatus', 'appearance', 'botTeam', 'classId', 'endsAtMs', 'equipmentSilhouettes', 'gladiatorId',
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
