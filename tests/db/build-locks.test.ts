import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, account, resetIdentity, admin, anonymous, creation, request, directEdge } from '../fixtures/db.ts';
import { makeVerifier } from '../../supabase/functions/_shared/backend/auth.ts';
import { createDatabase, prepareBuild } from '../../supabase/functions/_shared/backend/database.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';

// Fixed class and points (spec "Added 2026-10-28"; messages plan, Task 1). A saved build keeps its class and every added point:
// a class change and a lower attribute are `invalid`, every allowed change is free, and the floor is the CURRENT build, so a
// pending build can still be revised down to the current values (not below) or cancelled.
type Queue = Extract<GameCommand, { kind: 'queue-build' }>;
const database = createDatabase(admin);
const deps = { database, verifyActor: makeVerifier(anonymous), allowedOrigins: ['http://127.0.0.1:3000'] };
const send = async (token: string, body: GameCommand) => (await handleCommand(request(token, body), deps)).json();

async function fighter(options: { earned?: number } = {}) {
  const owner = await account();
  const result = await send(owner.token, creation('Lock ' + randomUUID().slice(0, 8)));
  expect(result.ok).toBe(true);
  const state = async (): Promise<OwnerState> => {
    const { data, error } = await owner.client.from('owner_state').select('state').single();
    expect(error).toBeNull();
    return data!.state;
  };
  const gid = result.value.gladiatorId as string;
  await sql`update public.wallets set money=300 where gladiator_id=${gid}`;
  // Points earned and banked beyond the ten spent at creation: room to add points.
  if (options.earned) await sql`update public.gladiators set earned_points=${options.earned},unspent_points=${options.earned - 10} where id=${gid}`;
  return { ...owner, state, gid };
}
type Fighter = Awaited<ReturnType<typeof fighter>>;
/** A queue-build command over the current build, with `patch` on top; `allocation` takes the attributes to add to the current ones. */
function queue(state: OwnerState, patch: Partial<Queue> = {}, add: Partial<Record<keyof Queue['allocation'], number>> = {}): Queue {
  const current = state.currentBuild.allocations;
  const allocation = Object.fromEntries(Object.entries(current).map(([key, value]) => [key, value + (add[key as keyof typeof add] ?? 0)])) as Queue['allocation'];
  return { kind: 'queue-build', operationId: randomUUID(), expectedVersion: state.buildVersion, classId: state.currentBuild.classId,
    stance: state.currentBuild.stance, allocation, equipment: state.currentBuild.equipment, ...patch };
}
const receiptCount = async (operationId: string) => (await sql`select count(*)::int as n from public.operation_receipts where operation_id=${operationId}`)[0].n as number;
/** Everything a refused build must leave alone. */
const footprint = async (owner: Fighter) => ({
  build: (await sql`select version::int, current_build, pending_build from public.builds where gladiator_id=${owner.gid}`)[0],
  reservations: (await sql`select operation_id::text, money::int, status from public.reservations where gladiator_id=${owner.gid} order by operation_id`).map(row => ({ ...row })),
  preparations: (await sql`select operation_id::text from private.pending_build_preparations where gladiator_id=${owner.gid}`).map(row => ({ ...row })),
  items: (await sql`select item->'reservation' as reservation from public.item_instances where gladiator_id=${owner.gid} order by id`).map(row => ({ ...row })),
  money: (await sql`select money::int from public.wallets where gladiator_id=${owner.gid}`)[0].money as number,
});

describe('fixed class and points', () => {
  beforeAll(resetIdentity);
  afterAll(() => sql.end());

  it('refuses a class change as invalid with no reservation and no new build version', async () => {
    const owner = await fighter();
    const state = await owner.state();
    const before = await footprint(owner);
    for (const classId of ['berserker', 'duelist'] as const) {
      const command = queue(state, { classId });
      expect(await send(owner.token, command), classId).toEqual({ ok: false, code: 'invalid' });
      // The refusal is stored like every other `invalid`, so a retry of the same operation answers the same.
      expect(await receiptCount(command.operationId)).toBe(1);
      expect(await send(owner.token, command), classId).toEqual({ ok: false, code: 'invalid' });
    }
    // The class change is refused together with otherwise allowed changes too.
    expect(await send(owner.token, queue(state, { classId: 'duelist', stance: 'offensive' }))).toMatchObject({ ok: false, code: 'invalid' });
    expect(await footprint(owner)).toEqual(before);
    expect(await owner.state()).toMatchObject({ buildVersion: state.buildVersion, pendingBuild: null, reservedFees: { money: 0 }, wallets: { money: 300 } });
  });

  it('refuses taking any point back as invalid with no reservation and no new build version', async () => {
    const owner = await fighter({ earned: 14 });
    const state = await owner.state();
    const before = await footprint(owner);
    for (const key of ['strength', 'agility', 'vitality', 'endurance', 'precision'] as const) {
      // One lower, and one lower with the point spent on another attribute (a respec), both leave the total within earned points.
      expect(await send(owner.token, queue(state, {}, { [key]: -1 })), `${key} one lower`).toEqual({ ok: false, code: 'invalid' });
      const other = key === 'strength' ? 'agility' : 'strength';
      expect(await send(owner.token, queue(state, {}, { [key]: -1, [other]: 1 })), `${key} moved to ${other}`).toEqual({ ok: false, code: 'invalid' });
    }
    expect(await send(owner.token, queue(state, { classId: 'duelist' }, { strength: -2 }))).toMatchObject({ ok: false, code: 'invalid' });
    expect(await footprint(owner)).toEqual(before);
    expect(await owner.state()).toMatchObject({ buildVersion: state.buildVersion, pendingBuild: null, reservedFees: { money: 0 } });
  });

  it('refuses a class change or a decrease in SQL even when the preparation allows it', async () => {
    const owner = await fighter({ earned: 12 });
    const state = await owner.state();
    const before = await footprint(owner);
    // A preparation made for an allowed build carries the right baseline and a fee of 0: SQL must still compare the command to the
    // current build itself, because the preparation is the Edge function's work, not the database's guarantee.
    const prepared = prepareBuild(queue(state, { stance: 'offensive' }), state)!;
    expect(prepared).toMatchObject({ fee: 0 });
    const rpc = async (command: Queue, input: unknown = { command, prepared }) => {
      const { data, error } = await admin.rpc('queue_build', { actor_id: owner.id, operation_id: command.operationId, input });
      expect(error).toBeNull();
      return data;
    };
    expect(await rpc(queue(state, { classId: 'duelist' }))).toEqual({ ok: false, code: 'invalid' });
    expect(await rpc(queue(state, {}, { strength: -1, agility: 1 }))).toEqual({ ok: false, code: 'invalid' });
    expect(await rpc(queue(state, {}, { precision: -2 }))).toEqual({ ok: false, code: 'invalid' });
    // A paid preparation is refused, whatever the command: no fee is charged any more (100 and 200 were the old fees).
    for (const fee of [1, 100, 200]) {
      const command = queue(state, { stance: 'offensive' });
      expect(await rpc(command, { command, prepared: { ...prepared, fee } }), `fee ${fee}`).toEqual({ ok: false, code: 'invalid' });
    }
    expect(await footprint(owner)).toEqual(before);
    // The same preparation for the allowed command is accepted, with nothing reserved.
    const allowed = queue(state, { stance: 'offensive' });
    expect(await rpc(allowed, { command: allowed, prepared })).toMatchObject({ ok: true, value: { reservedMoney: 0 } });
  });

  it('accepts a stance change plus one point as free, reserving nothing', async () => {
    const owner = await fighter({ earned: 11 });
    const state = await owner.state();
    expect(state.progression).toMatchObject({ earnedAttributePoints: 11, unspentAttributePoints: 1 });
    const command = queue(state, { stance: 'offensive' }, { endurance: 1 });
    const result = await send(owner.token, command);
    expect(result).toMatchObject({ ok: true, value: { reservedMoney: 0, build: { classId: 'guardian', stance: 'offensive', allocations: { endurance: 3 } } } });
    expect(await send(owner.token, command)).toEqual(result);
    expect(await owner.state()).toMatchObject({ pendingBuild: { reservedMoney: 0 }, wallets: { money: 300 }, reservedFees: { money: 0 }, buildVersion: state.buildVersion + 1 });
    expect(await sql`select money::int, status from public.reservations where gladiator_id=${owner.gid}`).toEqual([{ money: 0, status: 'held' }]);
    // Free even with an empty wallet: no fee needs funds.
    await sql`update public.wallets set money=0 where gladiator_id=${owner.gid}`;
    const next = await owner.state();
    expect(await send(owner.token, queue(next, { stance: 'defensive' }, { agility: 1 }))).toMatchObject({ ok: true, value: { reservedMoney: 0 } });
  });

  it('allows a stance change and an equipment change alone, both free', async () => {
    const owner = await fighter();
    const state = await owner.state();
    expect(await send(owner.token, queue(state, { stance: 'defensive' }))).toMatchObject({ ok: true, value: { reservedMoney: 0 } });
    // A second owned weapon, equipped in place of the starter sword.
    const id = randomUUID(), entry = CATALOG_V1.items['axe:1:common'];
    const item = { id, ownerId: owner.gid, catalogId: entry.id, catalogVersion: 'v1', tier: entry.tier, rarity: entry.rarity, stats: entry.stats,
      quantity: 1, origin: 'shop', binding: 'tradable', reservation: null };
    await sql`insert into public.item_instances values(${id},${owner.gid},${sql.json(item)})`;
    const swapped = queue(await owner.state(), { equipment: { ...state.currentBuild.equipment, weapon: id } });
    expect(await send(owner.token, swapped)).toMatchObject({ ok: true, value: { reservedMoney: 0, reservedItemIds: expect.arrayContaining([id]) } });
    expect(await owner.state()).toMatchObject({ reservedFees: { money: 0 }, wallets: { money: 300 } });
  });

  it('keeps the current build as the floor: a pending build may be revised down to it, not below, and still be cancelled', async () => {
    const owner = await fighter({ earned: 14 });
    const state = await owner.state();
    const current = state.currentBuild.allocations;
    // Pending: strength +3, stance offensive.
    const first = await send(owner.token, queue(state, { stance: 'offensive' }, { strength: 3 }));
    expect(first).toMatchObject({ ok: true, value: { reservedMoney: 0, build: { allocations: { strength: current.strength + 3 } } } });
    let pending = await owner.state();
    expect(pending.currentBuild).toEqual(state.currentBuild);
    // Revised down by one point, still above the current build: allowed.
    expect(await send(owner.token, queue(pending, { stance: 'offensive' }, { strength: 2 }))).toMatchObject({ ok: true, value: { build: { allocations: { strength: current.strength + 2 } } } });
    pending = await owner.state();
    // Below the current build is refused, and the pending build, its version and its reservation stay as they were.
    const standing = await footprint(owner);
    expect(await send(owner.token, queue(pending, {}, { strength: -1 }))).toEqual({ ok: false, code: 'invalid' });
    expect(await send(owner.token, queue(pending, { classId: 'duelist' }))).toEqual({ ok: false, code: 'invalid' });
    expect(await footprint(owner)).toEqual(standing);
    // Revised down to exactly the current build's values, with the current stance: allowed, a pending build equal to the current one.
    const same = queue(pending, {});
    expect(same).toMatchObject({ classId: state.currentBuild.classId, stance: state.currentBuild.stance, allocation: current });
    expect(await send(owner.token, same)).toMatchObject({ ok: true, value: { reservedMoney: 0, build: { allocations: current } } });
    pending = await owner.state();
    expect(pending.pendingBuild).toMatchObject({ operationId: same.operationId, build: { classId: 'guardian', allocations: current } });
    // And it can still be cancelled; the current build never moved.
    const cancel: GameCommand = { kind: 'cancel-build', operationId: randomUUID(), expectedVersion: pending.buildVersion };
    expect(await send(owner.token, cancel)).toMatchObject({ ok: true });
    expect(await owner.state()).toMatchObject({ pendingBuild: null, currentBuild: state.currentBuild, reservedFees: { money: 0 }, wallets: { money: 300 } });
    expect(await sql`select status, count(*)::int as n from public.reservations where gladiator_id=${owner.gid} group by status`).toEqual([{ status: 'refunded', n: 3 }]);
  });

  it('applies an added point at the boundary and then makes it permanent', async () => {
    const owner = await fighter({ earned: 12 });
    const state = await owner.state();
    expect(await send(owner.token, queue(state, {}, { vitality: 2 }))).toMatchObject({ ok: true, value: { reservedMoney: 0 } });
    const queued = await owner.state();
    await sql`select private.apply_pending_build(${owner.gid},${queued.pendingBuild!.effectiveSlotIndex})`;
    const applied = await owner.state();
    expect(applied).toMatchObject({ pendingBuild: null, currentBuild: { allocations: { vitality: 4 } }, wallets: { money: 300 }, reservedFees: { money: 0 } });
    // The applied point is now the floor: it cannot be taken back, a new class is still refused, and the same total stays free.
    expect(await send(owner.token, queue(applied, {}, { vitality: -1 }))).toEqual({ ok: false, code: 'invalid' });
    expect(await send(owner.token, queue(applied, { classId: 'berserker' }))).toEqual({ ok: false, code: 'invalid' });
    expect(await send(owner.token, queue(applied, { stance: 'offensive' }))).toMatchObject({ ok: true, value: { reservedMoney: 0 } });
  });

  it('answers the same through the real authenticated Edge runtime', async () => {
    const owner = await fighter({ earned: 11 });
    const state = await owner.state();
    const refused = directEdge(owner.token, queue(state, { classId: 'duelist' }));
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ ok: false, code: 'invalid' });
    const lowered = directEdge(owner.token, queue(state, {}, { strength: -1 }));
    expect(lowered.body).toEqual({ ok: false, code: 'invalid' });
    const allowed = directEdge(owner.token, queue(state, { stance: 'offensive' }, { precision: 1 }));
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ ok: true, value: { reservedMoney: 0 } });
  });
});
