import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, account, resetIdentity, admin, anonymous, creation, request, tokenFor, directEdge } from '../fixtures/db.ts';
import { makeVerifier } from '../../supabase/functions/_shared/backend/auth.ts';
import { createDatabase, prepareCreation } from '../../supabase/functions/_shared/backend/database.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';

const database = createDatabase(admin);
const deps = { database, verifyActor: makeVerifier(anonymous), allowedOrigins: ['http://127.0.0.1:3000'] };
const send = async (token: string, body: unknown) => (await handleCommand(request(token, body), deps)).json();

describe('persistent identity', () => {
  beforeAll(resetIdentity);
  afterAll(() => sql.end());
  it('starts with an empty durable owner state for a verified account', async () => {
    const owner = await account();
    const { data, error } = await owner.client.from('owner_state').select('state').maybeSingle();
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it('races creation atomically, replays the same receipt, and grants exactly two immutable starter items', async () => {
    const owner = await account();
    const command = creation();
    const results = await Promise.all(Array.from({ length: 4 }, () => send(owner.token, command)));
    expect(results.every(result => result.ok)).toBe(true);
    expect(new Set(results.map(result => result.receiptId)).size).toBe(1);
    const { data, error } = await owner.client.from('owner_state').select('state').single();
    expect(error).toBeNull();
    const state = data!.state as OwnerState;
    expect(state).toMatchObject({ name: 'Avi Fighter', wallets: { money: 100, renown: 0 }, reservedFees: { money: 0, renown: 0 },
      currentBuild: { version: 1, classId: 'guardian', stance: 'balanced', allocations: command.allocation }, pendingBuild: null,
      schedule: { morning: { kind: 'training' }, afternoon: { kind: 'expedition', expeditionId: 'woodland' }, evening: { kind: 'rest' } },
      scheduleVersion: 1, progression: { level: 1, xp: 0, earnedAttributePoints: 10, unspentAttributePoints: 0, league: 'bronze', rating: 1000 },
      stamina: { current: 104, maximum: 104 }, inventoryCapacity: 60, tournamentOptIn: false, currentActivity: { kind: 'orientation', status: 'active' } });
    expect(state.inventory).toHaveLength(2);
    expect(state.inventory.map(item => item.catalogId).sort()).toEqual(['light-armor:1:common', 'sword:1:common']);
    const sword = state.inventory.find(item => item.catalogId === 'sword:1:common')!;
    expect(sword).toMatchObject({ ownerId: state.gladiatorId, origin: 'starter', binding: 'tradable', quantity: 1,
      stats: { damage: 6, weight: 4, intervalMs: 1000 }, reservation: { kind: 'equipment', referenceId: state.gladiatorId } });
    expect(state.currentActivity!.endsAtMs % 4_800_000).toBe(0);
    expect(state.currentActivity!.endsAtMs).toBeGreaterThan(state.currentActivity!.startsAtMs);
    expect(state.processedSlotIndex).toBe(Math.floor(state.currentActivity!.startsAtMs / 4_800_000));
    expect(await sql`select count(*)::int as n from public.wallet_ledger where gladiator_id=${state.gladiatorId}`).toMatchObject([{ n: 1 }]);
    const other = await account();
    expect(await send(other.token, creation('AVI FIGHTER'))).toMatchObject({ ok: false, code: 'conflict' });
    expect(await send(owner.token, { ...command, name: 'Changed Name' })).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('serializes different operation IDs and globally unique normalized names across accounts', async () => {
    const owner = await account();
    const results = await Promise.all([send(owner.token, creation('Same Account One')), send(owner.token, creation('Same Account Two'))]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => result.code === 'conflict')).toHaveLength(1);
    const a = await account(), b = await account();
    const names = await Promise.all([send(a.token, creation('Race Name')), send(b.token, creation('RACE NAME'))]);
    expect(names.filter(result => result.ok)).toHaveLength(1);
    expect(names.filter(result => result.code === 'conflict')).toHaveLength(1);
    const c = await account(), d = await account(), operationId = crypto.randomUUID();
    expect(await send(c.token, creation('Scoped Receipt One', operationId))).toMatchObject({ ok: true });
    expect(await send(d.token, creation('Scoped Receipt Two', operationId))).toMatchObject({ ok: true });
  });

  it('denies other-owner reads, all anonymous reads, direct writes and direct mutation RPCs', async () => {
    const owner = await account(), other = await account();
    const created = await send(owner.token, creation('Private Owner'));
    const id = created.value.gladiatorId;
    for (const table of ['gladiators', 'builds', 'schedules', 'wallets', 'item_instances', 'reservations', 'wallet_ledger', 'operation_receipts']) {
      const foreign = await other.client.from(table).select('*');
      expect(foreign.error, table).toBeNull();
      expect(foreign.data, table).toEqual([]);
      expect((await anonymous.from(table).select('*')).error, table).not.toBeNull();
      expect((await owner.client.from(table).delete().eq(table === 'gladiators' ? 'id' : 'gladiator_id', id)).error, table).not.toBeNull();
    }
    expect((await other.client.from('owner_state').select('state')).data).toEqual([]);
    expect((await anonymous.from('owner_state').select('state')).error).not.toBeNull();
    expect((await owner.client.from('wallets').update({ money: 999 }).eq('gladiator_id', id)).error).not.toBeNull();
    expect((await owner.client.rpc('create_gladiator', { actor_id: owner.id, operation_id: crypto.randomUUID(), input: {} })).error).not.toBeNull();
    expect((await anonymous.rpc('consume_command_rate', { actor_id: owner.id, is_creation: false })).error).not.toBeNull();
    const privileges = await sql`select has_schema_privilege('authenticated', 'private', 'USAGE') as access,
      has_function_privilege('authenticated','public.create_gladiator(uuid,uuid,jsonb)','EXECUTE') as execute`;
    expect(privileges).toMatchObject([{ access: false, execute: false }]);
    const mutations = await sql`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and (not c.relrowsecurity
        or has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')
        or has_table_privilege('anon',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE'))`;
    expect(mutations).toEqual([]);
    expect(await sql`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and proname in ('create_gladiator','consume_command_rate') and prosecdef`).toEqual([]);
    expect((await database.loadOwnedInventory({ userId: other.id })).length).toBe(0);
    expect((await database.loadOwnedInventory({ userId: owner.id })).length).toBe(2);
  });

  it('verifies real Auth users, refuses expired tokens and ignores spoofed user metadata and owner IDs', async () => {
    const owner = await account(), email = await account('email');
    await sql`update auth.users set raw_user_meta_data=${sql.json({ provider: 'google', userId: owner.id, ownerId: owner.id })} where id=${email.id}`;
    expect(await send(email.token, creation('Fake Google'))).toMatchObject({ code: 'unauthenticated' });
    expect(await send(tokenFor(owner.id, true), creation('Expired'))).toMatchObject({ code: 'unauthenticated' });
    expect(await send('invalid', creation('Invalid'))).toMatchObject({ code: 'unauthenticated' });
    expect(await send('', creation('Missing'))).toMatchObject({ code: 'unauthenticated' });
    expect(await send(owner.token + 'x', creation('Bad Signature'))).toMatchObject({ code: 'unauthenticated' });
    expect(await send(owner.token, { ...creation('Spoof'), ownerId: email.id })).toMatchObject({ code: 'invalid' });
    expect(await send(owner.token, { ...creation('Fraction'), allocation: { strength: 2.5, agility: 1.5, vitality: 2, endurance: 2, precision: 2 } })).toMatchObject({ code: 'invalid' });
    expect((await email.client.from('owner_state').select('state')).data).toEqual([]);
  });

  it('enforces durable rolling per-account limits under concurrency', async () => {
    const owner = await account();
    const attempts = await Promise.all(Array.from({ length: 8 }, () => database.consumeRateLimit({ userId: owner.id }, true)));
    expect(attempts.filter(value => value === null)).toHaveLength(5);
    expect(attempts.filter(value => typeof value === 'number' && value > 0 && value <= 60000)).toHaveLength(3);
    const second = await account();
    const commands = await Promise.all(Array.from({ length: 65 }, () => database.consumeRateLimit({ userId: second.id }, false)));
    expect(commands.filter(value => value === null)).toHaveLength(60);
    await sql`update private.command_attempts set attempted_at=clock_timestamp()-interval '61 seconds' where actor_id=${second.id}`;
    expect(await database.consumeRateLimit({ userId: second.id }, false)).toBeNull();
  });

  it('rejects invalid SQL creation inputs without partial state', async () => {
    const owner = await account();
    const command = creation('SQL Validation');
    const prepared = prepareCreation(command);
    const inputs = [
      { ...prepared, command: { ...command, classId: null } },
      { ...prepared, command: { ...command, allocation: { ...command.allocation, strength: 2.5, agility: 1.5 } } },
      { ...prepared, command: { ...command, name: 'bad<>name' } },
      { ...prepared, command: { ...command, ownerId: owner.id } },
      { ...prepared, staminaMaximum: null },
      { ...prepared, starterItems: [{}, {}] },
    ];
    for (const input of inputs) {
      const { data, error } = await admin.rpc('create_gladiator', { actor_id: owner.id, operation_id: command.operationId, input });
      expect(error).toBeNull();
      expect(data).toEqual({ ok: false, code: 'invalid' });
    }
    expect((await owner.client.from('owner_state').select('state')).data).toEqual([]);
    expect(await sql`select count(*)::int as n from public.operation_receipts where owner_id=${owner.id}`).toMatchObject([{ n: 0 }]);
  });

  it('rolls back every creation write when a later inventory insertion fails', async () => {
    const owner = await account();
    await sql.unsafe(`create function private.test_reject_item() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'injected local failure'; end $$;
      create trigger test_reject_item before insert on public.item_instances for each row execute function private.test_reject_item();`);
    try {
      expect(await send(owner.token, creation('Atomic Failure'))).toEqual({ ok: false, code: 'unavailable' });
      expect(await sql`select count(*)::int as n from public.gladiators where owner_id=${owner.id}`).toMatchObject([{ n: 0 }]);
      expect(await sql`select count(*)::int as n from public.operation_receipts where owner_id=${owner.id}`).toMatchObject([{ n: 0 }]);
    } finally {
      await sql.unsafe('drop trigger test_reject_item on public.item_instances; drop function private.test_reject_item();');
    }
    expect(await send(owner.token, creation('Atomic Recovery'))).toMatchObject({ ok: true });
  });

  it('serves creation through the real local Edge runtime and authenticated Data API', async () => {
    const owner = await account();
    const direct = directEdge(owner.token, creation('Direct Runtime'));
    expect(direct.status).toBe(200);
    expect(direct.origin).toBe('http://127.0.0.1:3000');
    expect(direct.body).toMatchObject({ ok: true });
    const denied = directEdge(owner.token, creation('Forbidden Direct'), 'https://evil.example');
    expect(denied.status).toBe(403);
    expect(denied.origin).toBeUndefined();
    const gatewayOwner = await account();
    const response = await fetch(`${process.env.LOCAL_API_URL}/functions/v1/game-command`, {
      method: 'POST', headers: { Authorization: `Bearer ${gatewayOwner.token}`, apikey: process.env.LOCAL_ANON_KEY!,
        'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3000' }, body: JSON.stringify(creation('Edge Runtime')),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    // CLI 2.120.0 Kong 2.8.1 rewrites this header. Hosted exact-origin parity remains a Task24 release gate.
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await response.json()).toMatchObject({ ok: true });
    expect((await gatewayOwner.client.from('owner_state').select('state').single()).data?.state.name).toBe('Edge Runtime');
    const outsider = await account();
    const blocked = await fetch(`${process.env.LOCAL_API_URL}/functions/v1/game-command`, {
      method: 'POST', headers: { Authorization: `Bearer ${outsider.token}`, apikey: process.env.LOCAL_ANON_KEY!,
        'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify(creation('Forbidden Gateway')),
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ ok: false, code: 'invalid' });
    expect((await outsider.client.from('owner_state').select('state')).data).toEqual([]);
  });

  it('loads the entire verified inventory despite the Data API 50-row page cap', async () => {
    const owner = await account();
    const result = await send(owner.token, creation('Full Inventory'));
    const id = result.value.gladiatorId;
    const [template] = await sql`select item from public.item_instances where gladiator_id=${id} limit 1`;
    for (let i = 0; i < 58; i++) {
      const itemId = crypto.randomUUID();
      await sql`insert into public.item_instances(id,gladiator_id,item) values(${itemId},${id},${sql.json({ ...template.item, id: itemId, reservation: null })})`;
    }
    expect(await database.loadOwnedInventory({ userId: owner.id })).toHaveLength(60);
  });
});
