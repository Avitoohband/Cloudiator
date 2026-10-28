import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, account, resetIdentity, admin, anonymous, creation, request, directEdge, makeLegacyPending } from '../fixtures/db.ts';
import { makeVerifier } from '../../supabase/functions/_shared/backend/auth.ts';
import { createDatabase, prepareBuild } from '../../supabase/functions/_shared/backend/database.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';
import type { DayScheduleValue, GameCommand, Phase, Schedule } from '../../supabase/functions/_shared/contracts/commands.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';

const database = createDatabase(admin);
const deps = { database, verifyActor: makeVerifier(anonymous), allowedOrigins: ['http://127.0.0.1:3000'] };
const send = async (token: string, body: GameCommand) => (await handleCommand(request(token, body), deps)).json();
const SLOT = 4_800_000;
const PHASES: readonly Phase[] = ['morning', 'afternoon', 'evening'];
/** `private.schedule_effective_slot` restated: the next slot of `phase` strictly after the slot `nowMs` falls in. */
const nextSlotOf = (phase: Phase, nowMs: number) => {
  const slot = Math.floor(nowMs / SLOT), offset = (PHASES.indexOf(phase) - (slot % 3) + 3) % 3;
  return slot + (offset || 3);
};
/** Creation's day (01-identity.sql): training, the woodland expedition, rest. */
const CREATED: Schedule = { morning: { kind: 'training' }, afternoon: { kind: 'expedition', expeditionId: 'woodland' }, evening: { kind: 'rest' } };
const dayCommand = (expectedVersion: number, day: Schedule): Extract<GameCommand, { kind: 'edit-day-schedule' }> =>
  ({ kind: 'edit-day-schedule', operationId: randomUUID(), expectedVersion, day });
/** The day command as the backend sends it, past the Edge parser: SQL alone must refuse what the parser would. */
async function dayRpc(actor: string, command: Record<string, unknown>) {
  const { data, error } = await admin.rpc('edit_day_schedule', { actor_id: actor, operation_id: command.operationId, input: { command, prepared: null } });
  if (error) throw new Error(`edit_day_schedule: ${error.message}`);
  return data;
}
async function scheduleRpc(actor: string, command: Record<string, unknown>) {
  const { data, error } = await admin.rpc('edit_schedule', { actor_id: actor, operation_id: command.operationId, input: { command, prepared: null } });
  if (error) throw new Error(`edit_schedule: ${error.message}`);
  return data;
}
/** Every revision after creation's (version 1), in version then phase order. */
const revisionsAfterCreation = async (gid: string) => (await sql`select phase, version::int as version, choice, received_at_ms::float8 as received,
  effective_slot_index::float8 as effective from public.schedule_revisions where gladiator_id=${gid} and version>1 order by version, phase`).map(row => ({ ...row }));
const receiptCount = async (operationId: string) => (await sql`select count(*)::int as n from public.operation_receipts where operation_id=${operationId}`)[0].n as number;
async function fighter() {
  const owner = await account();
  const result = await send(owner.token, creation('Plan ' + randomUUID().slice(0, 8)));
  expect(result.ok).toBe(true);
  const state = async (): Promise<OwnerState> => {
    const { data, error } = await owner.client.from('owner_state').select('state').single();
    expect(error).toBeNull();
    return data!.state;
  };
  await sql`update public.wallets set money=300 where gladiator_id=${result.value.gladiatorId}`;
  return { ...owner, state, gid: result.value.gladiatorId as string };
}
/**
 * A build change the server allows: the current class and points (fixed since the release of 2026-10-28; tests/db/build-locks.test.ts
 * covers the refusals) with another stance, so it is free. A fee is only reachable through `makeLegacyPending`.
 */
function build(state: OwnerState): Extract<GameCommand, { kind: 'queue-build' }> {
  return { kind: 'queue-build', operationId: randomUUID(), expectedVersion: state.buildVersion,
    classId: state.currentBuild.classId, stance: 'offensive', allocation: state.currentBuild.allocations,
    equipment: state.currentBuild.equipment };
}

describe('schedule revisions and pending reservations', () => {
  beforeAll(resetIdentity);
  afterAll(() => sql.end());
  it('exposes backend-only schedule/build/cancel RPCs', async () => {
    const rows = await sql`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and proname in ('edit_schedule','edit_day_schedule','queue_build','cancel_build')`;
    expect(rows.map(row => row.proname).sort()).toEqual(['cancel_build', 'edit_day_schedule', 'edit_schedule', 'queue_build']);
  });
  it('reserves nothing for a free build without replacing the active build, and refunds a fee held from before the release once on cancellation', async () => {
    const owner = await fighter();
    const initial = await owner.state();
    const command = build(initial);
    const result = await send(owner.token, command);
    expect(result).toMatchObject({ ok: true, value: { reservedMoney: 0 } });
    expect(await send(owner.token, command)).toEqual(result);
    const free = await owner.state();
    expect(free.currentBuild.classId).toBe('guardian');
    expect(free.currentBuild).toEqual(initial.currentBuild);
    expect(free.pendingBuild).toMatchObject({ reservedMoney: 0, build: { classId: 'guardian', stance: 'offensive' } });
    expect(free.wallets.money).toBe(300);
    expect(free.reservedFees.money).toBe(0);
    // A build queued before the release holds a fee (200 here); it is still refunded exactly once when the build is cancelled.
    await makeLegacyPending(sql, owner.gid, command.operationId, { fee: 200 });
    const pending = await owner.state();
    expect(pending.pendingBuild).toMatchObject({ reservedMoney: 200 });
    expect(pending.wallets.money).toBe(300);
    expect(pending.reservedFees.money).toBe(200);
    const cancel: GameCommand = { kind: 'cancel-build', operationId: randomUUID(), expectedVersion: pending.buildVersion };
    const canceled = await send(owner.token, cancel);
    expect(canceled.ok).toBe(true);
    expect(await send(owner.token, cancel)).toEqual(canceled);
    expect(await owner.state()).toMatchObject({ pendingBuild: null, wallets: { money: 300 }, reservedFees: { money: 0 } });
    expect(await send(owner.token, command)).toEqual(result);
  });

  it('uses strict future phase cutoffs and retains received/effective history', async () => {
    const owner = await fighter();
    // Operator DDL/time is visible only in this rollback-only transaction, never through player APIs.
    await sql.begin(async tx => {
      await tx`update public.gladiators set processed_slot_index=300 where id=${owner.gid}`;
      for (const [nowMs, effective] of [[1_440_000_000, 303], [1_440_000_001, 303], [1_439_999_999, 300]]) {
        await tx.unsafe(`create or replace function private.planning_now_ms() returns bigint language sql volatile security invoker set search_path='' as 'select ${nowMs}::bigint'`);
        const [{ version }] = await tx`select version from public.schedules where gladiator_id=${owner.gid}`;
        const command = { kind: 'edit-schedule', operationId: randomUUID(), expectedVersion: Number(version), phase: 'morning', choice: { kind: 'rest' } };
        const [{ result }] = await tx`select public.edit_schedule(${owner.id},${command.operationId},${tx.json({ command, prepared: null })}) as result`;
        expect(result).toMatchObject({ ok: true, value: { receivedAtMs: nowMs, effectiveSlotIndex: effective, effectiveAtMs: effective * 4_800_000 } });
      }
      const rows = await tx`select received_at_ms::float8 as received,effective_slot_index::int as effective from public.schedule_revisions where gladiator_id=${owner.gid} and phase='morning' and version>1 order by version`;
      expect(rows).toEqual([{ received: 1_440_000_000, effective: 303 }, { received: 1_440_000_001, effective: 303 }, { received: 1_439_999_999, effective: 300 }]);
      await tx`rollback`;
    });
    const [{ now }] = await sql`select private.planning_now_ms()::float8 as now`;
    expect(Math.abs(now - Date.now())).toBeLessThan(5000);
  });

  it('serializes schedule versions and checks expedition unlocks', async () => {
    const owner = await fighter();
    const command: Extract<GameCommand, { kind: 'edit-schedule' }> = { kind: 'edit-schedule', operationId: randomUUID(), expectedVersion: 1, phase: 'afternoon', choice: { kind: 'rest' } };
    // Arena is evening-only (launch feedback): the contending edit keeps its Arena choice in the evening, so both still race for version 1.
    const results = await Promise.all([send(owner.token, command), send(owner.token, { ...command, operationId: randomUUID(), phase: 'evening', choice: { kind: 'arena' } })]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => r.code === 'conflict')).toHaveLength(1);
    expect(await send(owner.token, { ...command, operationId: randomUUID(), expectedVersion: 2, choice: { kind: 'expedition', expeditionId: 'mountain' } })).toMatchObject({ ok: false, code: 'invalid' });
    expect((await owner.state()).scheduleVersion).toBe(2);
  });

  // Launch feedback (2026-10-25): one save for the whole day, applied all at once or not at all, and Arena only in the evening.
  it('edit-day-schedule saves three parts in one version', async () => {
    const owner = await fighter();
    expect(await owner.state()).toMatchObject({ schedule: CREATED, scheduleVersion: 1 });
    const day: Schedule = { morning: { kind: 'rest' }, afternoon: { kind: 'training' }, evening: { kind: 'arena' } };
    const saved = await send(owner.token, dayCommand(1, day));
    expect(saved).toMatchObject({ ok: true, receiptId: expect.any(String) });
    const value = saved.value as DayScheduleValue;
    // Each changed part starts at its own next occurrence after the slot the save was received in.
    const effective = (phase: Phase) => nextSlotOf(phase, value.receivedAtMs);
    expect(value).toEqual({ version: 2, receivedAtMs: expect.any(Number),
      parts: Object.fromEntries(PHASES.map(phase => [phase, { effectiveSlotIndex: effective(phase), effectiveAtMs: effective(phase) * SLOT }])) });
    expect(Math.abs(value.receivedAtMs - Date.now())).toBeLessThan(5000);
    expect(await owner.state()).toMatchObject({ schedule: day, scheduleVersion: 2 });
    // One version for the day: one revision per changed part, all at version 2.
    expect(await revisionsAfterCreation(owner.gid)).toEqual((['afternoon', 'evening', 'morning'] as const).map(phase =>
      ({ phase, version: 2, choice: day[phase], received: value.receivedAtMs, effective: effective(phase) })));

    // Only the evening changes: one revision at version 3, and the unchanged parts answer null.
    const evening: Schedule = { ...day, evening: { kind: 'expedition', expeditionId: 'woodland' } };
    const next = await send(owner.token, dayCommand(2, evening));
    expect(next).toMatchObject({ ok: true });
    const nextValue = next.value as DayScheduleValue;
    expect(nextValue).toEqual({ version: 3, receivedAtMs: expect.any(Number), parts: { morning: null, afternoon: null,
      evening: { effectiveSlotIndex: nextSlotOf('evening', nextValue.receivedAtMs), effectiveAtMs: nextSlotOf('evening', nextValue.receivedAtMs) * SLOT } } });
    expect(await owner.state()).toMatchObject({ schedule: evening, scheduleVersion: 3 });
    expect((await revisionsAfterCreation(owner.gid)).filter(row => row.version === 3)).toEqual([{ phase: 'evening', version: 3,
      choice: evening.evening, received: nextValue.receivedAtMs, effective: nextSlotOf('evening', nextValue.receivedAtMs) }]);
  });

  it('edit-day-schedule saves through the real authenticated Edge runtime', async () => {
    const owner = await fighter();
    const day: Schedule = { ...CREATED, evening: { kind: 'arena' } };
    const response = directEdge(owner.token, dayCommand(1, day));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, value: { version: 2, parts: { morning: null, afternoon: null, evening: { effectiveSlotIndex: expect.any(Number) } } } });
    expect(await owner.state()).toMatchObject({ schedule: day, scheduleVersion: 2 });
  });

  it('edit-day-schedule refuses a stale version and writes nothing', async () => {
    const owner = await fighter();
    // Two tabs save different days against version 1 at once: exactly one wins, the other is a conflict, nothing is half saved.
    const first = dayCommand(1, { ...CREATED, morning: { kind: 'rest' } });
    const second = dayCommand(1, { ...CREATED, afternoon: { kind: 'training' }, evening: { kind: 'arena' } });
    const results = await Promise.all([send(owner.token, first), send(owner.token, second)]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => r.code === 'conflict')).toHaveLength(1);
    const won = results[0].ok ? first : second;
    expect(await owner.state()).toMatchObject({ schedule: won.day, scheduleVersion: 2 });
    const saved = await revisionsAfterCreation(owner.gid);
    expect(saved.map(row => row.version)).toEqual(won === first ? [2] : [2, 2]);
    // A stale version again: a conflict, and the schedule, its version and its revisions stay as they were.
    const stale = dayCommand(1, { morning: { kind: 'rest' }, afternoon: { kind: 'rest' }, evening: { kind: 'rest' } });
    expect(await send(owner.token, stale)).toEqual({ ok: false, code: 'conflict' });
    expect(await send(owner.token, { ...stale, operationId: randomUUID(), expectedVersion: 3 })).toEqual({ ok: false, code: 'conflict' });
    expect(await owner.state()).toMatchObject({ schedule: won.day, scheduleVersion: 2 });
    expect(await revisionsAfterCreation(owner.gid)).toEqual(saved);
  });

  it('edit-day-schedule replays its receipt', async () => {
    const owner = await fighter();
    const command = dayCommand(1, { morning: { kind: 'rest' }, afternoon: { kind: 'training' }, evening: { kind: 'arena' } });
    const first = await send(owner.token, command);
    expect(first).toMatchObject({ ok: true, value: { version: 2 } });
    // A lost reply sent again, twice at once: the stored result, never a second version bump.
    expect(await Promise.all([send(owner.token, command), send(owner.token, command)])).toEqual([first, first]);
    expect(await receiptCount(command.operationId)).toBe(1);
    expect((await owner.state()).scheduleVersion).toBe(2);
    expect(await revisionsAfterCreation(owner.gid)).toHaveLength(3);
    // The same operation with another day is a conflict and writes nothing.
    expect(await send(owner.token, { ...command, day: { ...command.day, evening: { kind: 'rest' } } })).toEqual({ ok: false, code: 'conflict' });
    // While the character is behind, the receipt still replays first; a new save answers processing, which is not stored.
    await sql`update public.gladiators set processed_slot_index=processed_slot_index-1 where id=${owner.gid}`;
    expect(await send(owner.token, command)).toEqual(first);
    const later = dayCommand(2, { ...command.day, morning: { kind: 'training' } });
    expect(await send(owner.token, later)).toMatchObject({ ok: false, code: 'processing' });
    expect(await receiptCount(later.operationId)).toBe(0);
    await sql`update public.gladiators set processed_slot_index=floor(extract(epoch from clock_timestamp())*1000/4800000) where id=${owner.gid}`;
    expect(await send(owner.token, later)).toMatchObject({ ok: true, value: { version: 3, parts: { morning: expect.any(Object), afternoon: null, evening: null } } });
    expect((await owner.state()).scheduleVersion).toBe(3);
  });

  it('edit-day-schedule refuses afternoon Arena', async () => {
    const owner = await fighter();
    // The Edge parser refuses these first (tests/backend/commands.test.ts); SQL refuses them on its own.
    for (const day of [{ ...CREATED, afternoon: { kind: 'arena' } }, { ...CREATED, morning: { kind: 'arena' } },
      { morning: { kind: 'arena' }, afternoon: { kind: 'arena' }, evening: { kind: 'arena' } }] as Schedule[]) {
      const command = dayCommand(1, day);
      expect(await dayRpc(owner.id, command), JSON.stringify(day)).toEqual({ ok: false, code: 'invalid' });
    }
    expect(await owner.state()).toMatchObject({ schedule: CREATED, scheduleVersion: 1 });
    expect(await revisionsAfterCreation(owner.gid)).toEqual([]);
    // The same day with Arena in the evening is saved.
    expect(await dayRpc(owner.id, dayCommand(1, { ...CREATED, evening: { kind: 'arena' } }))).toMatchObject({ ok: true, value: { version: 2 } });
  });

  it('edit-schedule refuses morning Arena', async () => {
    const owner = await fighter();
    for (const phase of ['morning', 'afternoon'] as const) {
      const command = { kind: 'edit-schedule', operationId: randomUUID(), expectedVersion: 1, phase, choice: { kind: 'arena' } };
      expect(await scheduleRpc(owner.id, command), phase).toEqual({ ok: false, code: 'invalid' });
    }
    expect(await owner.state()).toMatchObject({ schedule: CREATED, scheduleVersion: 1 });
    expect(await revisionsAfterCreation(owner.gid)).toEqual([]);
    const evening = { kind: 'edit-schedule', operationId: randomUUID(), expectedVersion: 1, phase: 'evening', choice: { kind: 'arena' } };
    expect(await scheduleRpc(owner.id, evening)).toMatchObject({ ok: true, value: { version: 2 } });
    expect(await owner.state()).toMatchObject({ schedule: { ...CREATED, evening: { kind: 'arena' } }, scheduleVersion: 2 });
  });

  it('a day with no change is invalid', async () => {
    const owner = await fighter();
    expect(await send(owner.token, dayCommand(1, CREATED))).toEqual({ ok: false, code: 'invalid' });
    // Values are compared, not their key order.
    const reordered = { evening: { kind: 'rest' }, afternoon: { expeditionId: 'woodland', kind: 'expedition' }, morning: { kind: 'training' } } as Schedule;
    expect(await send(owner.token, dayCommand(1, reordered))).toEqual({ ok: false, code: 'invalid' });
    expect(await owner.state()).toMatchObject({ schedule: CREATED, scheduleVersion: 1 });
    expect(await revisionsAfterCreation(owner.gid)).toEqual([]);
  });

  it('edit-day-schedule checks every part and the command shape like edit-schedule', async () => {
    const owner = await fighter();
    const base = dayCommand(1, { ...CREATED, evening: { kind: 'arena' } });
    // Refused after the character lock (stored, as edit-schedule's refusals are): a locked expedition, a malformed part, a
    // missing or extra part, and an extra command key.
    for (const command of [
      { ...base, day: { ...base.day, morning: { kind: 'expedition', expeditionId: 'mountain' } } },
      { ...base, day: { ...base.day, afternoon: { kind: 'expedition', expeditionId: 'outpost' } } },
      { ...base, day: { ...base.day, morning: { kind: 'expedition', expeditionId: 'nowhere' } } },
      { ...base, day: { ...base.day, morning: { kind: 'rest', extra: 1 } } },
      { ...base, day: { ...base.day, morning: { kind: 'sleep' } } },
      { ...base, day: { ...base.day, morning: 'rest' } },
      { ...base, day: { morning: base.day.morning, afternoon: base.day.afternoon } },
      { ...base, day: { ...base.day, night: { kind: 'rest' } } },
      { ...base, day: [base.day.morning, base.day.afternoon, base.day.evening] },
      { ...base, phase: 'morning' },
    ]) {
      const sent = { ...command, operationId: randomUUID() };
      expect(await dayRpc(owner.id, sent), JSON.stringify(command)).toEqual({ ok: false, code: 'invalid' });
      expect(await receiptCount(sent.operationId)).toBe(1);
    }
    // Refused before the character lock, with no receipt: a wrong kind or a malformed expected version.
    for (const command of [{ ...base, kind: 'edit-schedule' }, { ...base, expectedVersion: 1.5 }, { ...base, expectedVersion: '1' }, { ...base, expectedVersion: 0 }]) {
      const sent = { ...command, operationId: randomUUID() };
      expect(await dayRpc(owner.id, sent), JSON.stringify(command)).toEqual({ ok: false, code: 'invalid' });
      expect(await receiptCount(sent.operationId)).toBe(0);
    }
    expect(await owner.state()).toMatchObject({ schedule: CREATED, scheduleVersion: 1 });
    expect(await revisionsAfterCreation(owner.gid)).toEqual([]);
    // A level-10 character may plan the mountain in any part.
    await sql`update public.gladiators set level=10 where id=${owner.gid}`;
    expect(await dayRpc(owner.id, { ...base, operationId: randomUUID(), day: { ...base.day, morning: { kind: 'expedition', expeditionId: 'mountain' } } }))
      .toMatchObject({ ok: true, value: { version: 2, parts: { afternoon: null } } });
  });

  it('queues against the active build, replaces a held fee, and allocates newly earned points once', async () => {
    const owner = await fighter();
    let state = await owner.state();
    const original = build(state);
    expect(await send(owner.token, original)).toMatchObject({ ok: true, value: { reservedMoney: 0 } });
    // A build queued before the release holds a fee; the next build replaces it and the hold is refunded.
    await makeLegacyPending(sql, owner.gid, original.operationId, { fee: 200 });
    state = await owner.state();
    expect(state.reservedFees.money).toBe(200);
    const replacement = { ...build(state), stance: 'defensive' as const };
    expect(await send(owner.token, replacement)).toMatchObject({ ok: true, value: { reservedMoney: 0 } });
    state = await owner.state();
    expect(state.reservedFees.money).toBe(0);
    expect(await sql`select status, money::int from public.reservations where gladiator_id=${owner.gid} and operation_id=${original.operationId}`)
      .toEqual([{ status: 'refunded', money: 200 }]);
    await sql`update public.gladiators set earned_points=11,unspent_points=1,stamina_current=20 where id=${owner.gid}`;
    const free = { ...build(state), classId: state.currentBuild.classId, allocation: { ...state.currentBuild.allocations, endurance: 3 } };
    const result = await send(owner.token, free);
    expect(result).toMatchObject({ ok: true, value: { reservedMoney: 0 } });
    expect(await send(owner.token, free)).toEqual(result);
    state = await owner.state();
    expect(state.progression.unspentAttributePoints).toBe(1);
    expect(state.stamina).toEqual({ current: 20, maximum: 104 });
    const boundary = state.pendingBuild!.effectiveSlotIndex;
    expect(await sql`select private.apply_pending_build(${owner.gid},${boundary - 1}) as applied`).toMatchObject([{ applied: false }]);
    expect(await sql`select private.apply_pending_build(${owner.gid},${boundary}) as applied`).toMatchObject([{ applied: true }]);
    expect(await sql`select private.apply_pending_build(${owner.gid},${boundary}) as applied`).toMatchObject([{ applied: false }]);
    state = await owner.state();
    expect(state).toMatchObject({ wallets: { money: 300 }, reservedFees: { money: 0 }, progression: { earnedAttributePoints: 11, unspentAttributePoints: 0 }, stamina: { current: 20, maximum: 106 } });
    expect(Object.values(state.currentBuild.allocations).reduce((a, b) => a + b, 0)).toBe(11);
    // The replaced build's receipt still answers its own operation, whatever has happened since.
    expect(await send(owner.token, original)).toMatchObject({ ok: true, value: { reservedMoney: 0 } });
    expect((await owner.state()).pendingBuild).toBeNull();
  });

  it('consumes the fee of a build queued before the release exactly once and clamps reduced stamina without minting resources', async () => {
    const owner = await fighter();
    const initial = await owner.state();
    // The server queues no fee, class change or decrease any more, but a build already pending at deploy keeps them and applies as
    // queued: a class change plus a respec (200), then a respec (100). makeLegacyPending rewrites a free build to what the earlier
    // queue_build wrote, with the stamina maximum prepared for it.
    const first = build(initial);
    expect(await send(owner.token, first)).toMatchObject({ ok: true });
    await makeLegacyPending(sql, owner.gid, first.operationId, { fee: 200, classId: 'berserker',
      allocations: { strength: 3, agility: 1, vitality: 2, endurance: 2, precision: 2 }, staminaMaximum: 104 });
    const queued = await owner.state();
    expect(queued).toMatchObject({ reservedFees: { money: 200 }, pendingBuild: { reservedMoney: 200, build: { classId: 'berserker' } } });
    await expect(sql`select private.apply_pending_build(${owner.gid},null)`).rejects.toMatchObject({ message: 'invalid boundary' });
    await sql`select private.apply_pending_build(${owner.gid},${queued.pendingBuild!.effectiveSlotIndex})`;
    await sql`select private.apply_pending_build(${owner.gid},${queued.pendingBuild!.effectiveSlotIndex})`;
    const state = await owner.state();
    expect(state).toMatchObject({ currentBuild: { classId: 'berserker' }, pendingBuild: null, wallets: { money: 100 }, reservedFees: { money: 0 }, stamina: { current: 104, maximum: 104 } });
    const lower = build(state);
    expect(await send(owner.token, lower)).toMatchObject({ ok: true, value: { reservedMoney: 0 } });
    await makeLegacyPending(sql, owner.gid, lower.operationId, { fee: 100,
      allocations: { strength: 5, agility: 1, vitality: 2, endurance: 0, precision: 2 }, staminaMaximum: 100 });
    await sql`select private.apply_pending_build(${owner.gid},${(await owner.state()).pendingBuild!.effectiveSlotIndex})`;
    expect(await owner.state()).toMatchObject({ wallets: { money: 0 }, stamina: { current: 100, maximum: 100 } });
    expect(await sql`select count(*)::int as n from public.wallet_ledger where gladiator_id=${owner.gid} and reason='build'`).toEqual([{ n: 2 }]);
    expect(await sql`select money_delta::int as delta from public.wallet_ledger where gladiator_id=${owner.gid} and reason='build' order by money_delta`).toEqual([{ delta: -200 }, { delta: -100 }]);
  });

  it('reserves new pending equipment against sale or deletion and frees replaced equipment', async () => {
    const owner = await fighter();
    const state = await owner.state();
    const id = randomUUID();
    const entry = CATALOG_V1.items['axe:1:common'];
    const item = { id, ownerId: owner.gid, catalogId: entry.id, catalogVersion: 'v1', tier: entry.tier, rarity: entry.rarity,
      stats: entry.stats, quantity: 1, origin: 'shop', binding: 'tradable', reservation: null };
    await sql`insert into public.item_instances values(${id},${owner.gid},${sql.json(item)})`;
    const command = { ...build(state), equipment: { ...state.currentBuild.equipment, weapon: id } };
    const original = await send(owner.token, command);
    expect(original).toMatchObject({ ok: true, value: { reservedItemIds: expect.arrayContaining([id]) } });
    expect((await owner.state()).inventory.find(i => i.id === id)?.reservation?.kind).toBe('pending-build');
    await expect(sql`delete from public.item_instances where id=${id}`).rejects.toMatchObject({ message: 'reserved item' });
    // Task 8's immutable equipment-quantity guard runs before the reservation guard.
    await expect(sql`update public.item_instances set item=jsonb_set(item,'{quantity}','2') where id=${id}`).rejects.toMatchObject({ message: 'immutable item' });
    const next = await owner.state();
    expect(await send(owner.token, { ...build(next), equipment: state.currentBuild.equipment })).toMatchObject({ ok: true });
    expect((await owner.state()).inventory.find(i => i.id === id)?.reservation).toBeNull();
    await sql`delete from public.item_instances where id=${id}`;
    // Canonical preparation now fails because this item is gone; committed receipt replay must still win.
    expect(await send(owner.token, command)).toEqual(original);
    expect((await owner.state()).pendingBuild!.reservedItemIds).not.toContain(id);
  });

  it('rejects stale preparation after earned points or inventory change under the authoritative lock', async () => {
    const owner = await fighter();
    const state = await owner.state();
    const command = build(state), prepared = prepareBuild(command, state);
    await sql`update public.gladiators set earned_points=11,unspent_points=1 where id=${owner.gid}`;
    const { data, error } = await admin.rpc('queue_build', { actor_id: owner.id, operation_id: command.operationId, input: { command, prepared } });
    expect(error).toBeNull(); expect(data).toMatchObject({ ok: false, code: 'conflict' });
    expect((await owner.state()).reservedFees.money).toBe(0);
  });

  it('retries processing after catch-up and replays committed receipts even while behind', async () => {
    const owner = await fighter();
    const state = await owner.state();
    const command = build(state);
    await sql`update public.gladiators set processed_slot_index=processed_slot_index-1 where id=${owner.gid}`;
    expect(await send(owner.token, command)).toMatchObject({ ok: false, code: 'processing' });
    await sql`update public.gladiators set processed_slot_index=floor(extract(epoch from clock_timestamp())*1000/4800000) where id=${owner.gid}`;
    const result = await send(owner.token, command);
    expect(result.ok).toBe(true);
    await sql`update public.gladiators set processed_slot_index=processed_slot_index-1 where id=${owner.gid}`;
    expect(await send(owner.token, command)).toEqual(result);
    expect(await send(owner.token, { kind: 'cancel-build', operationId: randomUUID(), expectedVersion: 2 })).toMatchObject({ ok: false, code: 'processing' });
  });

  it('serializes concurrent queue requests and rejects changed reuse of an operation ID', async () => {
    const owner = await fighter(), state = await owner.state();
    const command = build(state);
    const other = { ...command, operationId: randomUUID() };
    const results = await Promise.all([send(owner.token, command), send(owner.token, command), send(owner.token, other)]);
    expect(results[0]).toEqual(results[1]);
    // Two identical conflicts alone would also satisfy equality: each operation must own exactly one durable receipt.
    const receipts = await sql`select operation_id::text as id, count(*)::int as n from public.operation_receipts
      where operation_id in (${command.operationId}, ${other.operationId}) group by operation_id`;
    expect(Object.fromEntries(receipts.map(r => [r.id, r.n]))).toEqual({ [command.operationId]: 1, [other.operationId]: 1 });
    // Either operation may take the account lock first: exactly one of the two distinct operations commits, and both
    // copies of the first operation share its single receipt (two conflicts when the other operation won first).
    expect([results[0].ok, results[2].ok].sort()).toEqual([false, true]);
    expect(results.filter(r => r.code === 'conflict').length).toBe(results[0].ok ? 1 : 2);
    expect((await owner.state()).reservedFees.money).toBe(0);
    expect(await send(owner.token, { ...command, stance: 'defensive' })).toMatchObject({ ok: false, code: 'conflict' });
    expect(await sql`select count(*)::int as n from public.reservations where gladiator_id=${owner.gid} and status='held'`).toEqual([{ n: 1 }]);
  });

  it('reads clock and checkpoint after waiting for a simultaneous boundary transaction', async () => {
    const owner = await fighter();
    let response: Promise<unknown> | undefined;
    await sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${owner.id},0))`;
      await tx`select id from public.gladiators where id=${owner.gid} for update`;
      // A valid edit (Arena only in the evening, launch feedback), so the post-wait processing gate is the only refusal.
      const command: GameCommand = { kind: 'edit-schedule', operationId: randomUUID(), expectedVersion: 1, phase: 'evening', choice: { kind: 'arena' } };
      // Call SQL from a separate connection: this request must block behind the boundary's account lock.
      response = sql`select public.edit_schedule(${owner.id},${command.operationId},${sql.json({ command, prepared: null })}) as result`;
      const running = Promise.resolve(response); response = running;
      const deadline = Date.now() + 3000;
      let waiting = false;
      while (Date.now() < deadline) {
        const [{ count }] = await sql`select count(*)::int from pg_locks where locktype='advisory' and not granted`;
        if (count > 0) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      // Simulate the trusted worker leaving this character behind while holding the common lock.
      await tx`update public.gladiators set processed_slot_index=processed_slot_index-1 where id=${owner.gid}`;
    });
    expect(await response).toMatchObject([{ result: { ok: false, code: 'processing' } }]);
    expect((await owner.state()).scheduleVersion).toBe(1);
  });

  it('rejects foreign, listed, level-ineligible, wrong-slot and overspent build requests, and needs no funds for a valid one', async () => {
    const owner = await fighter();
    const state = await owner.state();
    const command = build(state);
    for (const bad of [
      { ...command, equipment: { ...command.equipment, weapon: randomUUID() } },
      { ...command, equipment: { ...command.equipment, head: command.equipment.weapon, weapon: null } },
      { ...command, allocation: { ...command.allocation, strength: 4 } },
    ]) expect(await send(owner.token, { ...bad, operationId: randomUUID() })).toMatchObject({ ok: false, code: 'invalid' });
    for (const catalogId of ['axe:5:common', 'axe:1:common', 'spear:1:common']) {
      const entry = CATALOG_V1.items[catalogId], id = randomUUID();
      const item = { id, ownerId: owner.gid, catalogId, catalogVersion: 'v1', tier: entry.tier, rarity: entry.rarity, stats: entry.stats,
        quantity: 1, origin: 'shop', binding: 'tradable', reservation: catalogId === 'axe:1:common' ? { kind: 'listing', referenceId: randomUUID() } : null };
      await sql`insert into public.item_instances values(${id},${owner.gid},${sql.json(item)})`;
      let offHand: string | null = null;
      if (catalogId === 'spear:1:common') {
        const shield = CATALOG_V1.items['round-shield:1:common']; offHand = randomUUID();
        await sql`insert into public.item_instances values(${offHand},${owner.gid},${sql.json({ ...item, id: offHand, catalogId: shield.id, tier: shield.tier, stats: shield.stats })})`;
      }
      expect(await send(owner.token, { ...command, operationId: randomUUID(), equipment: { ...command.equipment, weapon: id, offHand } })).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(await owner.state()).toMatchObject({ pendingBuild: null, reservedFees: { money: 0 } });
    // No build costs gold any more, so an empty wallet still queues one (the fee rule used to answer insufficient-funds here).
    await sql`update public.wallets set money=0 where gladiator_id=${owner.gid}`;
    expect(await send(owner.token, command)).toMatchObject({ ok: true, value: { reservedMoney: 0 } });
    expect(await owner.state()).toMatchObject({ pendingBuild: { reservedMoney: 0 }, reservedFees: { money: 0 }, wallets: { money: 0 } });
  });

  it('rejects an ownership race and rolls back an injected late reservation failure atomically', async () => {
    const owner = await fighter();
    const state = await owner.state(), command = build(state);
    const prepared = prepareBuild(command, state);
    // Baseline inventory changed after preparation, despite unchanged build version.
    const item = state.inventory[0];
    await sql`update public.item_instances set item=jsonb_set(item,'{reservation}',${sql.json({ kind: 'listing', referenceId: randomUUID() })}) where id=${item.id}`;
    const race = await admin.rpc('queue_build', { actor_id: owner.id, operation_id: command.operationId, input: { command, prepared } });
    expect(race.error).toBeNull(); expect(race.data).toMatchObject({ ok: false, code: 'conflict' });
    await sql`update public.item_instances set item=${sql.json(item)} where id=${item.id}`;
    const next = build(await owner.state());
    await sql.begin(async tx => {
      await tx.unsafe(`create function private.task6_fail_reservation() returns trigger language plpgsql as $$ begin raise exception 'injected late failure'; end $$`);
      await tx.unsafe(`create trigger task6_fail_reservation before insert on private.pending_build_preparations for each row execute function private.task6_fail_reservation()`);
      await expect(tx.savepoint(async sp => {
        await sp`select public.queue_build(${owner.id},${next.operationId},${sp.json({ command: next, prepared: prepareBuild(next, await owner.state()) })})`;
      })).rejects.toMatchObject({ message: 'injected late failure' });
      expect(await tx`select count(*)::int as n from public.reservations where gladiator_id=${owner.gid}`).toEqual([{ n: 0 }]);
      expect(await tx`select version::int,pending_build from public.builds where gladiator_id=${owner.gid}`).toEqual([{ version: 1, pending_build: null }]);
      expect(await tx`select count(*)::int as n from public.pending_build_items where gladiator_id=${owner.gid}`).toEqual([{ n: 0 }]);
      await tx`rollback`;
    });
  });

  it('executes planning through the real authenticated Edge runtime with exact origin enforcement', async () => {
    const owner = await fighter();
    const command = build(await owner.state());
    const response = directEdge(owner.token, command);
    expect(response.status).toBe(200);
    expect(response.origin).toBe('http://127.0.0.1:3000');
    expect(response.body).toMatchObject({ ok: true, value: { reservedMoney: 0 } });
    expect(directEdge(owner.token, { kind: 'cancel-build', operationId: randomUUID(), expectedVersion: 2 }, 'https://evil.example').status).toBe(403);
    expect((await owner.state()).pendingBuild).not.toBeNull();
  });

  it('denies anonymous/cross-owner history and direct RPCs and conceals private preparation', async () => {
    const owner = await fighter(), other = await account();
    expect(await send(owner.token, build(await owner.state()))).toMatchObject({ ok: true });
    for (const table of ['schedule_revisions', 'pending_build_items']) {
      expect((await other.client.from(table).select('*')).data).toEqual([]);
      expect((await anonymous.from(table).select('*')).error).not.toBeNull();
      expect((await owner.client.from(table).delete().eq('gladiator_id', owner.gid)).error).not.toBeNull();
    }
    for (const name of ['edit_schedule','edit_day_schedule','queue_build','cancel_build']) {
      expect((await owner.client.rpc(name, { actor_id: owner.id, operation_id: randomUUID(), input: {} })).error).not.toBeNull();
    }
    expect(await sql`select has_table_privilege('authenticated','private.pending_build_preparations','select') as allowed`).toEqual([{ allowed: false }]);
    const { data } = await owner.client.from('builds').select('*').single();
    expect(JSON.stringify(data)).not.toContain('snapshot');
    expect(JSON.stringify(data)).not.toContain('staminaMaximum');
  });
});
