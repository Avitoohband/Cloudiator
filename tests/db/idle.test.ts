import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { TransactionSql } from 'postgres';
import { sql, account, resetIdentity, admin, anonymous, creation, request, directEdge } from '../fixtures/db.ts';
import { makeVerifier } from '../../supabase/functions/_shared/backend/auth.ts';
import { createDatabase, createWorkerDatabase, prepareBuild } from '../../supabase/functions/_shared/backend/database.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import { DEFAULT_EXECUTORS, prepareActivityV1 } from '../../supabase/functions/_shared/backend/jobs.ts';
import type { JobLease, PreparationInput } from '../../supabase/functions/_shared/domain/types.ts';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands.ts';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { readProfile, readTournament, readWorld } from '../../src/lib/api/reads.ts';

// Task 23.8 (database budget design C; Avi's decision, 2026-10-19): a character whose owner has sent no activity signal for
// 14 days rests at home. At each boundary it rests when the boundary's scheduled start minus the owner's last signal (or the
// character's creation, when later) is at least RULES_V1.idle.afterMs. A resting character has no member row, preparation
// job, snapshot, activity, settled slot, pairing or bracket entry, or season rating row, but its processed slot advances
// with the cohort's at phase 8. Every boundary here is a historical slot (1970) processed decades after its scheduled start,
// so the wall clock never decides anything; the operator places each character and its owner's last signal by SQL.

const SLOT = 4_800_000;
/** RULES_V1.idle.afterMs: 14 days, 252 slots. */
const IDLE = 1_209_600_000;
/** A historical slot (1970-01-17 06:40 UTC, a morning). */
const S = 300;
/** Slot 302 starts on Saturday 1970-01-17 at 18:40 UTC, an evening and a v1 tournament slot (tests/db/tournaments.test.ts). */
const T = 302;
type Outcome = { ok: boolean; code?: string; [key: string]: unknown };

const commands = createDatabase(admin);
const worker = createWorkerDatabase(admin);
const deps = { database: commands, verifyActor: makeVerifier(anonymous), allowedOrigins: ['http://127.0.0.1:3000'] };
const send = async (token: string, body: GameCommand) => (await handleCommand(request(token, body), deps)).json();
const presence = (): GameCommand => ({ kind: 'presence', operationId: randomUUID() });
async function rpc<R = Outcome>(name: string, args: Record<string, unknown> = {}): Promise<R> {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as R;
}
const ROLLBACK = new Error('rollback-only');
/** Runs `run` in one transaction that is always rolled back; returns what `run` returned. */
async function rollback<R>(run: (tx: TransactionSql) => Promise<R>): Promise<R> {
  let value: R | undefined;
  try {
    await sql.begin(async tx => { value = await run(tx); throw ROLLBACK; });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return value as R;
}
/** A transaction-local stand-in for the database clock (never a player input). */
const clock = (ms: number) => `create or replace function private.planning_now_ms() returns bigint language sql volatile security invoker
  set search_path='' as 'select ${ms}::bigint'`;
const definitionOf = async (signature: string): Promise<string> =>
  (await sql`select pg_get_functiondef(${signature}::regprocedure) as definition`)[0].definition;

// Operator-only world controls for the isolated local test database; no player API exposes them.
async function resetWorld(published: number | null) {
  await resetIdentity();
  await sql`truncate private.boundaries, private.boundary_work, private.dispatch_log`;
  await sql`update private.coordinator set published_slot=${published}, lease_token=null, lease_until_ms=0, last_error=null,
    last_failed_slot=null where singleton`;
  await sql`update private.rules_versions set active=false where version<>'v1'`;
  await sql`delete from private.rules_versions where version<>'v1'`;
  await sql`update private.rules_versions set active=true where version='v1'`;
  await sql`update private.scheduler set enabled=false where singleton`;
}
beforeEach(() => resetWorld(null));
afterAll(async () => { await resetWorld(null); await sql.end(); });

type Choices = { morning: unknown; afternoon: unknown; evening: unknown };
const TRAINING: Choices = { morning: { kind: 'training' }, afternoon: { kind: 'training' }, evening: { kind: 'training' } };
const ARENA: Choices = { morning: { kind: 'arena' }, afternoon: { kind: 'arena' }, evening: { kind: 'arena' } };
/**
 * Real creation; the operator then places the character at a historical first slot. It was created at `createdAt`
 * (default: 1970-01-01, so its creation never counts as a recent signal), and its owner's last activity signal is `signal`
 * (default: none).
 */
async function fighter(options: { firstSlot?: number; schedule?: Choices; signal?: number; createdAt?: number; optIn?: boolean; money?: number } = {}) {
  const firstSlot = options.firstSlot ?? S, schedule = options.schedule ?? TRAINING, createdAt = options.createdAt ?? 1;
  const owner = await account();
  const created = await commands.createGladiator({ userId: owner.id }, creation('Idle ' + randomUUID().slice(0, 8)));
  if (!created.ok) throw new Error('creation failed');
  const gid = created.value.gladiatorId;
  await sql`update public.gladiators set created_at_ms=${createdAt},orientation_end_ms=${firstSlot * SLOT},processed_slot_index=${firstSlot - 1},
    tournament_opt_in=${options.optIn ?? false} where id=${gid}`;
  await sql`update public.schedules set schedule=${sql.json(schedule as never)} where gladiator_id=${gid}`;
  for (const phase of ['morning', 'afternoon', 'evening'] as const) {
    await sql`update public.schedule_revisions set received_at_ms=${createdAt},effective_slot_index=${firstSlot},choice=${sql.json(schedule[phase] as never)}
      where gladiator_id=${gid} and phase=${phase}`;
  }
  if (options.money !== undefined) await sql`update public.wallets set money=${options.money} where gladiator_id=${gid}`;
  if (options.signal !== undefined) await sql`insert into private.owner_signals(owner_id,last_signal_ms) values(${owner.id},${options.signal})`;
  const state = async (): Promise<OwnerState> => {
    const { data, error } = await owner.client.from('owner_state').select('state').single();
    if (error) throw new Error(error.message);
    return data!.state;
  };
  return { ...owner, gid, state };
}
type Fighter = Awaited<ReturnType<typeof fighter>>;
async function coordinatorLease() {
  const token = randomUUID();
  await sql`update private.coordinator set lease_token=${token},lease_until_ms=9007199254740991 where singleton`;
  return token;
}
const advance = (target: number, token: string) => rpc('advance_boundary', { target_slot: target, coordinator_token: token });
const claim = (kind: string, limit = 20) => rpc<JobLease[]>('claim_jobs', { worker_id: randomUUID(), kind, batch_limit: limit });
const complete = (job: JobLease, result: unknown) => rpc('complete_job', { job_id: job.id, lease_token: job.token, result });
async function completePreparations() {
  for (let jobs = await claim('prepare'); jobs.length; jobs = await claim('prepare')) {
    for (const job of jobs) expect(await complete(job, prepareActivityV1(job.snapshot as PreparationInput))).toMatchObject({ ok: true });
  }
}
/** Runs boundary `target` to its end with canonical preparation and pairing; returns the last report. */
async function runBoundary(target: number, token: string) {
  let report = await advance(target, token);
  if (report.wait === 'preparation') {
    await completePreparations();
    report = await advance(target, token);
  }
  if (report.wait === 'pairing') {
    for (const job of await claim('pair')) expect(await complete(job, DEFAULT_EXECUTORS.v1.pair!(job))).toMatchObject({ ok: true });
    report = await advance(target, token);
  }
  return report;
}
/** Claims every due settlement and settles each activity through the real worker RPC adapter. */
async function settleAll() {
  const settled: Outcome[] = [];
  for (let jobs = await claim('settlement'); jobs.length; jobs = await claim('settlement')) {
    for (const job of jobs) settled.push(await worker.settle(job.activityId!, job.token) as Outcome);
  }
  return settled;
}
const members = async (slot: number) =>
  (await sql`select gladiator_id::text as gid from private.boundary_members where slot_index=${slot} order by 1`).map(r => r.gid as string);
const slotsOf = async (f: Fighter) =>
  (await sql`select slot_index::int as slot from public.activities where gladiator_id=${f.gid} order by 1`).map(r => r.slot as number);
const processedOf = async (f: Fighter) => (await sql`select processed_slot_index::int as p from public.gladiators where id=${f.gid}`)[0].p as number;
const restOf = async (f: Fighter) => (await sql`select since_slot::int as since, through_slot::int as through, signalled_at_ms::float8 as signalled
  from public.character_rests where gladiator_id=${f.gid}`).map(r => ({ ...r }))[0];
const signalOf = async (f: Fighter) =>
  (await sql`select last_signal_ms::float8 as at from private.owner_signals where owner_id=${f.id}`).map(r => r.at as number)[0];
/** Every boundary-written row of the character, by table. */
async function rowsOf(f: Fighter) {
  const [row] = await sql`select
    (select count(*)::int from private.boundary_members where gladiator_id=${f.gid}) as members,
    (select count(*)::int from private.jobs where gladiator_id=${f.gid}) as jobs,
    (select count(*)::int from public.activities where gladiator_id=${f.gid}) as activities,
    (select count(*)::int from private.activity_snapshots s join public.activities a on a.id=s.activity_id where a.gladiator_id=${f.gid}) as snapshots,
    (select count(*)::int from private.settled_slots where gladiator_id=${f.gid}) as settled,
    (select count(*)::int from private.arena_ratings where gladiator_id=${f.gid}) as ratings`;
  return { ...row };
}
/** Everything a slot can grant or debit. */
async function progressOf(f: Fighter) {
  const [row] = await sql`select w.money::text as money, w.renown::text as renown, g.xp::text as xp, g.level::int as level,
    g.earned_points::int as earned, g.unspent_points::int as unspent, g.stamina_current::int as stamina, g.stamina_maximum::int as maximum,
    (select count(*)::int from public.wallet_ledger l where l.gladiator_id=g.id) as ledger,
    (select count(*)::int from private.settled_slots x where x.gladiator_id=g.id) as settled
    from public.gladiators g join public.wallets w on w.gladiator_id=g.id where g.id=${f.gid}`;
  return { ...row };
}
/** The deploy-time signal backfill exactly as 15-release.sql writes it (it runs once, when the source or M22 is applied). */
function backfillStatement(): string {
  const source = readFileSync(new URL('../../supabase/sql/15-release.sql', import.meta.url), 'utf8');
  const match = /-- Deploy day \(Task 23\.8\)[^\n]*\n(?:--[^\n]*\n)*(insert into private\.owner_signals[\s\S]*?on conflict \(owner_id\) do nothing;)/.exec(source);
  if (!match) throw new Error('The deploy-time signal backfill is missing from 15-release.sql');
  return match[1];
}

describe('Task 23.8: idle characters rest at home', () => {
  it('restates RULES_V1.idle in private.idle_rules', async () => {
    expect(RULES_V1.idle).toEqual({ afterMs: IDLE });
    const [{ rules, volatility }] = await sql`select private.idle_rules() as rules, p.provolatile as volatility
      from pg_proc p where p.oid='private.idle_rules()'::regprocedure`;
    expect(rules).toEqual({ afterMs: RULES_V1.idle.afterMs });
    expect(volatility).toBe('i');
  });

  it('keeps a character playing at 14 days minus 1 ms without a signal and rests it at 14 days', async () => {
    const start = S * SLOT;
    const playing = await fighter({ signal: start - IDLE + 1 });
    const resting = await fighter({ signal: start - IDLE });
    // Creation counts like a signal: created 14 days minus 1 ms before the start, with no signal, it plays.
    const created = await fighter({ createdAt: start - IDLE + 1 });
    const token = await coordinatorLease();
    expect(await runBoundary(S, token)).toMatchObject({ status: 'complete' });
    expect(await members(S)).toEqual([playing.gid, created.gid].sort());
    expect(await slotsOf(playing)).toEqual([S]);
    expect(await slotsOf(created)).toEqual([S]);
    expect(await slotsOf(resting)).toEqual([]);
    expect(await restOf(resting)).toEqual({ since: S, through: S, signalled: null });
    expect(await restOf(playing)).toBeUndefined();
    expect(await restOf(created)).toBeUndefined();
  });

  it('classifies a late-processed boundary by its scheduled start, not the wall clock', async () => {
    const start = S * SLOT;
    const inside = await fighter({ signal: start - IDLE + 1 });
    const idle = await fighter({ signal: start - IDLE });
    // A signal recorded after the scheduled start but before the late boundary is processed counts for it.
    const late = await fighter({ signal: start + 30 * 60_000 });
    const cohortAt = (now: number) => rollback(async tx => {
      await tx.unsafe(clock(now));
      const token = randomUUID();
      await tx`update private.coordinator set lease_token=${token},lease_until_ms=9007199254740991 where singleton`;
      expect((await tx`select public.advance_boundary(${S},${token}) as r`)[0].r).toMatchObject({ phase: 4, wait: 'preparation' });
      return (await tx`select gladiator_id::text as gid from private.boundary_members where slot_index=${S} order by 1`).map(r => r.gid as string);
    });
    const expected = [inside.gid, late.gid].sort();
    // On time (10 ms into the slot) and 20 days late, at database time; then decades late, at the real clock.
    expect(await cohortAt(start + 10)).toEqual(expected);
    expect(await cohortAt(start + 20 * 86_400_000)).toEqual(expected);
    const token = await coordinatorLease();
    expect(await runBoundary(S, token)).toMatchObject({ status: 'complete' });
    expect(await members(S)).toEqual(expected);
    expect(await slotsOf(idle)).toEqual([]);
  });

  // Final review Minor 5: one catch-up runs several boundaries in a row under one coordinator lease, all decades after their
  // scheduled starts. A character whose 14-day line falls among them plays each boundary before the line and rests from it
  // on, judged by each boundary's own scheduled start; its processed slot advances with the cohort at every step.
  it("crosses a character's 14-day line within one catch-up of several boundaries", async () => {
    // The line is boundary S + 2's start: S and S + 1 start 2 and 1 slots inside 14 days; S + 2 is exactly 14 days.
    const crossing = await fighter({ signal: (S + 2) * SLOT - IDLE });
    const steady = await fighter({ signal: (S + 10) * SLOT });
    const both = [crossing.gid, steady.gid].sort();
    const token = await coordinatorLease();
    const steps: { slot: number; members: string[]; processed: number[] }[] = [];
    for (let slot = S; slot <= S + 3; slot++) {
      expect(await runBoundary(slot, token), `boundary ${slot}`).toMatchObject({ status: 'complete' });
      steps.push({ slot, members: await members(slot), processed: [await processedOf(crossing), await processedOf(steady)] });
      // The catch-up's worker settles the slot's activities before the next boundary.
      await settleAll();
    }
    expect(steps).toEqual([
      { slot: S, members: both, processed: [S, S] },
      { slot: S + 1, members: both, processed: [S + 1, S + 1] },
      { slot: S + 2, members: [steady.gid], processed: [S + 2, S + 2] },
      { slot: S + 3, members: [steady.gid], processed: [S + 3, S + 3] },
    ]);
    expect(await slotsOf(crossing)).toEqual([S, S + 1]);
    expect(await slotsOf(steady)).toEqual([S, S + 1, S + 2, S + 3]);
    // One rest, from the line on, with no signal since it began.
    expect(await restOf(crossing)).toEqual({ since: S + 2, through: S + 3, signalled: null });
    expect(await restOf(steady)).toBeUndefined();
  });

  it("advances a resting character's processed slot with the cohort and writes no rows for it", async () => {
    const active = await fighter({ signal: (S + 10) * SLOT });
    const resting = await fighter();
    const token = await coordinatorLease();
    expect(await runBoundary(S, token)).toMatchObject({ status: 'complete' });
    expect([await processedOf(active), await processedOf(resting)]).toEqual([S, S]);
    expect(await settleAll()).toEqual([expect.objectContaining({ ok: true })]);
    // No straggler wait: the next boundary runs whole, and the resting character advances with it again.
    expect(await runBoundary(S + 1, token)).toMatchObject({ status: 'complete' });
    expect([await processedOf(active), await processedOf(resting)]).toEqual([S + 1, S + 1]);
    expect(await rowsOf(resting)).toEqual({ members: 0, jobs: 0, activities: 0, snapshots: 0, settled: 0, ratings: 0 });
    expect(await rowsOf(active)).toMatchObject({ members: 2, activities: 2, snapshots: 2, settled: 1, ratings: 1 });
    expect(await restOf(resting)).toEqual({ since: S, through: S + 1, signalled: null });
    // The cleanup checkpoint, least(published, min(processed)), moves with the cohort.
    const [{ result }] = await sql`select private.cleanup_history(private.planning_now_ms()) as result`;
    expect(result).toMatchObject({ ok: true, publishedSlot: S + 1, checkpointSlot: S + 1 });
    // Commands answer exactly as for the active character: accepted inside slot S + 1, processing inside S + 2.
    for (const [now, ok] of [[(S + 1) * SLOT + 10, true], [(S + 2) * SLOT + 10, false]] as const) {
      for (const f of [active, resting]) {
        const answer = await rollback(async tx => {
          await tx.unsafe(clock(now));
          const command = { kind: 'set-tournament-opt-in', operationId: randomUUID(), enabled: true };
          return (await tx`select public.set_tournament_opt_in(${f.id},${command.operationId},${tx.json({ command })}) as r`)[0].r as Outcome;
        });
        expect(answer, `${now} ${f.gid}`).toMatchObject(ok ? { ok: true } : { ok: false, code: 'processing' });
      }
    }
  });

  it('leaves a resting character out of Arena pairing and tournament brackets, keeping its opt-in', async () => {
    const recent = (T + 10) * SLOT;
    // Tournament slot T: two active opted-in entrants and a resting one; two active regular Arena entrants and a resting one.
    const [a, b] = [await fighter({ firstSlot: T, schedule: ARENA, optIn: true, signal: recent }), await fighter({ firstSlot: T, schedule: ARENA, optIn: true, signal: recent })];
    const c = await fighter({ firstSlot: T, schedule: ARENA, optIn: true });
    const [f, g] = [await fighter({ firstSlot: T, schedule: ARENA, signal: recent }), await fighter({ firstSlot: T, schedule: ARENA, signal: recent })];
    const h = await fighter({ firstSlot: T, schedule: ARENA });
    const token = await coordinatorLease();
    expect(await runBoundary(T, token)).toMatchObject({ status: 'complete' });
    const inputs = JSON.stringify((await sql`select input from private.jobs where kind='pair'`).map(r => r.input));
    for (const resting of [c, h]) {
      expect(inputs).not.toContain(resting.gid);
      expect(await rowsOf(resting)).toMatchObject({ jobs: 0, activities: 0 });
    }
    expect((await sql`select e.gladiator_id::text as gid from private.tournament_entries e order by 1`).map(r => r.gid)).toEqual([a.gid, b.gid].sort());
    expect((await sql`select a.gladiator_id::text as gid from private.arena_assignment_sides s join public.activities a on a.id=s.activity_id order by 1`)
      .map(r => r.gid)).toEqual([f.gid, g.gid].sort());
    // The opt-in is the owner's choice, kept for the first tournament after the owner returns.
    expect((await sql`select tournament_opt_in as "optIn" from public.gladiators where id=${c.gid}`)[0].optIn).toBe(true);

    // A bracket that falls below the minimum takes the existing insufficient-entrants path.
    await resetWorld(null);
    const only = await fighter({ firstSlot: T, schedule: ARENA, optIn: true, signal: recent });
    const away = await fighter({ firstSlot: T, schedule: ARENA, optIn: true });
    const regular = await fighter({ firstSlot: T, schedule: ARENA, signal: recent });
    expect(await runBoundary(T, await coordinatorLease())).toMatchObject({ status: 'complete' });
    expect(await sql`select count(*)::int as n from private.tournaments`).toEqual([{ n: 0 }]);
    const view = await readTournament(regular.client, `tournament:${T}:bronze`);
    expect(view).toMatchObject({ status: 'insufficient-entrants', bracket: null });
    expect(view.entrants.map(e => e.gladiatorId)).toEqual([only.gid]);
    expect((await sql`select tournament_opt_in as "optIn" from public.gladiators where id=${away.gid}`)[0].optIn).toBe(true);
  }, 60_000);

  it('returns a character to its schedule at the first boundary after a presence or any command', async () => {
    const viaPresence = await fighter(), viaCommand = await fighter(), stillIdle = await fighter();
    const token = await coordinatorLease();
    expect(await runBoundary(S, token)).toMatchObject({ status: 'complete' });
    for (const f of [viaPresence, viaCommand, stillIdle]) expect(await slotsOf(f)).toEqual([]);
    expect(await send(viaPresence.token, presence())).toEqual({ ok: true });
    // Any command signals, even one refused: this opt-in answers processing (slot S is long past) and changes nothing.
    expect(await send(viaCommand.token, { kind: 'set-tournament-opt-in', operationId: randomUUID(), enabled: true }))
      .toMatchObject({ ok: false, code: 'processing' });
    expect(await runBoundary(S + 1, token)).toMatchObject({ status: 'complete' });
    // Back on the schedule from the next boundary; the resting slot is never back-filled.
    expect(await slotsOf(viaPresence)).toEqual([S + 1]);
    expect(await slotsOf(viaCommand)).toEqual([S + 1]);
    expect(await slotsOf(stillIdle)).toEqual([]);
    expect(await restOf(viaPresence)).toEqual({ since: S, through: S, signalled: expect.any(Number) });
    expect(await restOf(stillIdle)).toEqual({ since: S, through: S + 1, signalled: null });
  });

  it('applies changes queued while resting at that first boundary and grants nothing for resting slots', async () => {
    const f = await fighter({ money: 300 });
    const token = await coordinatorLease();
    const before = await progressOf(f);
    expect(await runBoundary(S, token)).toMatchObject({ status: 'complete' });
    expect(await progressOf(f)).toEqual(before);
    // The owner returns inside slot S: the signal every command records, a schedule change for slot S + 1's phase and a
    // build change, through the real command functions at database time 10 ms into slot S (a committed operator
    // transaction whose clock stand-in is restored before it commits).
    const state = await f.state();
    const definition = await definitionOf('private.planning_now_ms()');
    const build = { kind: 'queue-build', operationId: randomUUID(), expectedVersion: state.buildVersion, classId: 'berserker', stance: 'offensive',
      allocation: { strength: 3, agility: 1, vitality: 2, endurance: 2, precision: 2 }, equipment: state.currentBuild.equipment } as const;
    await sql.begin(async tx => {
      await tx.unsafe(clock(S * SLOT + 10));
      expect((await tx`select public.consume_command_rate(${f.id},false) as r`)[0].r).toBeNull();
      const schedule = { kind: 'edit-schedule', operationId: randomUUID(), expectedVersion: state.scheduleVersion, phase: 'afternoon', choice: { kind: 'rest' } };
      expect((await tx`select public.edit_schedule(${f.id},${schedule.operationId},${tx.json({ command: schedule, prepared: null })}) as r`)[0].r)
        .toMatchObject({ ok: true, value: { effectiveSlotIndex: S + 1 } });
      expect((await tx`select public.queue_build(${f.id},${build.operationId},${tx.json({ command: build, prepared: prepareBuild(build, state) } as never)}) as r`)[0].r)
        .toMatchObject({ ok: true, value: { effectiveSlotIndex: S + 1, reservedMoney: 200 } });
      await tx.unsafe(definition);
    });
    expect(await definitionOf('private.planning_now_ms()')).toBe(definition);
    expect(await f.state()).toMatchObject({ processedSlotIndex: S, restingUntilSlot: S + 1, currentActivity: null,
      pendingBuild: { effectiveSlotIndex: S + 1 } });
    // The first boundary back applies both: the new build before the snapshot, and the afternoon choice.
    expect(await runBoundary(S + 1, token)).toMatchObject({ status: 'complete' });
    const [activity] = await sql`select a.slot_index::int as slot, a.requested, a.schedule_version::int as version, s.snapshot->'build'->>'classId' as "classId"
      from public.activities a join private.activity_snapshots s on s.activity_id=a.id where a.gladiator_id=${f.gid}`;
    expect({ ...activity }).toEqual({ slot: S + 1, requested: { kind: 'rest' }, version: 2, classId: 'berserker' });
    expect(await sql`select current_build->>'classId' as "classId", pending_build from public.builds where gladiator_id=${f.gid}`)
      .toEqual([{ classId: 'berserker', pending_build: null }]);
    // Only the build fee moved money; the resting slot S has no settled slot, ledger row or grant.
    const after = await progressOf(f);
    expect(after).toMatchObject({ money: '100', renown: before.renown, xp: before.xp, earned: before.earned, settled: 0, ledger: before.ledger + 1 });
    expect(await sql`select reason, money_delta::int as delta from public.wallet_ledger where gladiator_id=${f.gid} and reason='build'`)
      .toEqual([{ reason: 'build', delta: -200 }]);
  });

  it('backfills the deploy time for existing owners, so nobody rests on the first boundary after M22', async () => {
    const existing = await fighter();
    const recorded = await fighter({ signal: 42 });
    const deploy = S * SLOT - 60_000;
    const boundaryAfter = (backfill: boolean) => rollback(async tx => {
      await tx.unsafe(clock(deploy));
      if (backfill) await tx.unsafe(backfillStatement());
      const signals = Object.fromEntries((await tx`select owner_id::text as id, last_signal_ms::float8 as at from private.owner_signals`).map(r => [r.id, r.at]));
      await tx.unsafe(clock(S * SLOT + 10));
      const token = randomUUID();
      await tx`update private.coordinator set lease_token=${token},lease_until_ms=9007199254740991 where singleton`;
      // Phase 4 waits for the members' preparation; with nobody in the cohort the boundary completes.
      expect((await tx`select public.advance_boundary(${S},${token}) as r`)[0].r).toMatchObject({ ok: true, phase: backfill ? 4 : 9 });
      const cohort = (await tx`select gladiator_id::text as gid from private.boundary_members where slot_index=${S}`).map(r => r.gid);
      return { signals, cohort };
    });
    // Without the backfill an owner with no signal yet would rest from the first boundary.
    expect(await boundaryAfter(false)).toEqual({ signals: { [recorded.id]: 42 }, cohort: [] });
    // With it, every owner without a signal gets the deploy time; a recorded signal is kept.
    expect(await boundaryAfter(true)).toEqual({ signals: { [existing.id]: deploy, [recorded.id]: 42 }, cohort: [existing.gid] });
  });

  it('ships the deploy-time backfill in M22 after its table exists', () => {
    const dir = new URL('../../supabase/migrations/', import.meta.url);
    const files = readdirSync(dir).filter(name => name.endsWith('_idle_rest.sql'));
    expect(files).toHaveLength(1);
    const m22 = readFileSync(new URL(files[0], dir), 'utf8').replace(/\r\n/g, '\n');
    const statement = backfillStatement().replace(/\r\n/g, '\n');
    const at = m22.indexOf(statement);
    expect(at).toBeGreaterThan(0);
    expect(m22.indexOf(statement, at + 1)).toBe(-1);
    const created = m22.search(/create table "?private"?\."?owner_signals"?/i);
    expect(created).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(created);
  });

  it('shows restingUntilSlot to the owner and resting to everyone', async () => {
    const resting = await fighter(), late = await fighter(), active = await fighter({ signal: (S + 10) * SLOT });
    const token = await coordinatorLease();
    expect(await runBoundary(S, token)).toMatchObject({ status: 'complete' });
    // The owner: no activity while resting, and no return slot until a signal arrives.
    expect(await resting.state()).toMatchObject({ processedSlotIndex: S, currentActivity: null, restingUntilSlot: null });
    expect(await active.state()).toMatchObject({ processedSlotIndex: S, currentActivity: { kind: 'training' }, restingUntilSlot: null });
    // Everyone, a visitor included: the public actor says it rests, with no activity.
    const actors = new Map((await readWorld(anonymous)).actors.map(x => [x.gladiatorId, x]));
    expect(actors.get(resting.gid)).toMatchObject({ resting: true, location: 'camp', activityId: null, activityStatus: 'idle', startsAtMs: null,
      endsAtMs: null, visibleStage: null });
    expect(actors.get(active.gid)).toMatchObject({ resting: false, location: 'training' });
    expect((await readProfile(anonymous, resting.gid)).actor).toMatchObject({ resting: true });
    // A signal: the next boundary returns it.
    expect(await send(resting.token, presence())).toEqual({ ok: true });
    expect(await resting.state()).toMatchObject({ processedSlotIndex: S, currentActivity: null, restingUntilSlot: S + 1 });
    // Another account sees no rest row of it; a visitor cannot read the table at all.
    expect((await resting.client.from('character_rests').select('gladiator_id')).data).toEqual([{ gladiator_id: resting.gid }]);
    expect((await active.client.from('character_rests').select('gladiator_id')).data).toEqual([]);
    expect((await anonymous.from('character_rests').select('gladiator_id')).error).not.toBeNull();
    // A signal that arrives after the next boundary froze its cohort counts for the boundary after it.
    expect(await settleAll()).toEqual([expect.objectContaining({ ok: true })]);
    expect(await advance(S + 1, token)).toMatchObject({ phase: 4, wait: 'preparation' });
    expect(await send(late.token, presence())).toEqual({ ok: true });
    expect(await late.state()).toMatchObject({ processedSlotIndex: S, restingUntilSlot: S + 2 });
    await completePreparations();
    expect(await advance(S + 1, token)).toMatchObject({ status: 'complete' });
    expect(await late.state()).toMatchObject({ processedSlotIndex: S + 1, currentActivity: null, restingUntilSlot: S + 2 });
    expect(await resting.state()).toMatchObject({ processedSlotIndex: S + 1, currentActivity: { kind: 'training', startsAtMs: (S + 1) * SLOT },
      restingUntilSlot: null });
    const after = new Map((await readWorld(anonymous)).actors.map(x => [x.gladiatorId, x]));
    expect(after.get(resting.gid)).toMatchObject({ resting: false, location: 'training' });
    expect(after.get(late.gid)).toMatchObject({ resting: true, activityId: null });
  });

  it('answers a presence command with ok and writes no operation receipt', async () => {
    const f = await fighter();
    const receipts = async () => (await sql`select count(*)::int as n from public.operation_receipts where owner_id=${f.id}`)[0].n as number;
    const created = await receipts();
    expect(created).toBe(1);
    const before = Date.now();
    const answer = await handleCommand(request(f.token, presence()), deps);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ok: true });
    // The served Edge function answers the same.
    expect(directEdge(f.token, presence())).toMatchObject({ status: 200, body: { ok: true } });
    // Only the creation's receipt.
    expect(await receipts()).toBe(created);
    // Both were charged against the command rate, and the first recorded the owner's signal at database time.
    expect(await sql`select count(*)::int as n from private.command_attempts where actor_id=${f.id}`).toEqual([{ n: 2 }]);
    const signal = await signalOf(f);
    expect(signal).toBeGreaterThanOrEqual(before - 5_000);
    expect(signal).toBeLessThanOrEqual(Date.now() + 5_000);
    // A malformed presence is invalid; its attempt still counts.
    const extra = await handleCommand(request(f.token, { ...presence(), payload: 1 }), deps);
    expect(extra.status).toBe(400);
    expect(await extra.json()).toEqual({ ok: false, code: 'invalid' });
  });

  it('records the signal at most once an hour per owner, at database time sampled after the rate lock', async () => {
    const f = await fighter();
    const NOW = S * SLOT;
    const stored = (from: number | null) => rollback(async tx => {
      await tx.unsafe(clock(NOW));
      if (from !== null) await tx`insert into private.owner_signals(owner_id,last_signal_ms) values(${f.id},${from})`;
      expect((await tx`select public.consume_command_rate(${f.id},false) as r`)[0].r).toBeNull();
      return Number((await tx`select last_signal_ms::text as at from private.owner_signals where owner_id=${f.id}`)[0].at);
    });
    expect(await stored(null)).toBe(NOW);
    expect(await stored(NOW - 3_600_000 + 1)).toBe(NOW - 3_600_000 + 1);
    expect(await stored(NOW - 3_600_000)).toBe(NOW);
    // A rate-limited attempt is the owner's activity too.
    expect(await rollback(async tx => {
      await tx.unsafe(clock(NOW));
      for (let i = 0; i < 60; i++) await tx`insert into private.command_attempts(actor_id,is_creation) values(${f.id},false)`;
      expect((await tx`select public.consume_command_rate(${f.id},false) as r`)[0].r).toBeGreaterThan(0);
      return Number((await tx`select last_signal_ms::text as at from private.owner_signals where owner_id=${f.id}`)[0].at);
    })).toBe(NOW);
    // The time is sampled after the account's rate lock: a call that waited behind it records a time after the wait.
    let call: Promise<unknown> | undefined;
    let released = 0;
    await sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${f.id},1))`;
      call = rpc('consume_command_rate', { actor_id: f.id, is_creation: false });
      let waiting = false;
      for (const deadline = Date.now() + 3000; Date.now() < deadline && !waiting;) {
        waiting = (await sql`select count(*)::int as n from pg_locks where locktype='advisory' and not granted`)[0].n > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 1_000));
      released = Number((await tx`select floor(extract(epoch from clock_timestamp())*1000)::text as at`)[0].at);
    });
    expect(await call).toBeNull();
    expect(await signalOf(f)).toBeGreaterThanOrEqual(released);
  });

  it('counts a signal committed while the boundary waits for the owner\'s signal lock', async () => {
    const f = await fighter();
    const token = await coordinatorLease();
    let boundary: Promise<Outcome> | undefined;
    await sql.begin(async tx => {
      // As consume_command_rate holds it while it records a signal.
      await tx`select pg_advisory_xact_lock(hashtextextended(${f.id},1))`;
      boundary = advance(S, token);
      const running = Promise.resolve(boundary); boundary = running;
      let waiting = false;
      for (const deadline = Date.now() + 3000; Date.now() < deadline && !waiting;) {
        waiting = (await sql`select count(*)::int as n from pg_locks where locktype='advisory' and not granted`)[0].n > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      // Idle by its stale state when the boundary looked; the signal commits while the boundary waits.
      await tx`insert into private.owner_signals(owner_id,last_signal_ms) values(${f.id},${S * SLOT})`;
    });
    expect(await boundary).toMatchObject({ phase: 4, wait: 'preparation' });
    expect(await members(S)).toEqual([f.gid]);
    expect(await restOf(f)).toBeUndefined();
  });
});
