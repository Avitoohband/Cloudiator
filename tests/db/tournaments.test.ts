import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { sql, account, resetIdentity, admin, anonymous, creation, directEdge } from '../fixtures/db.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import type { TournamentBoutRead } from '../../supabase/functions/_shared/backend/database.ts';
import { DEFAULT_EXECUTORS, prepareActivityV1, simulateTournamentBoutV1 } from '../../supabase/functions/_shared/backend/jobs.ts';
import type { PairingInput, PairingResult, TournamentBoutInput } from '../../supabase/functions/_shared/backend/jobs.ts';
import { buildBracket, isTournamentSlot, readyBouts, recordBout, runBout } from '../../supabase/functions/_shared/domain/tournament.ts';
import type { TournamentGraph } from '../../supabase/functions/_shared/domain/tournament.ts';
import { slotAt } from '../../supabase/functions/_shared/domain/clock.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import type { JobLease, PreparationInput, PreparationResult } from '../../supabase/functions/_shared/domain/types.ts';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';
import { readProfile, readTimeline } from '../../src/lib/api/reads.ts';

const SLOT = 4_800_000;
const MINUTE = 60_000;
/** Slot 301 starts on Saturday 1970-01-17 at 17:20 UTC, a v1 tournament slot. Its cutoff is 301 × 4 800 000 ms. */
const T = 301;
const CUTOFF = T * SLOT;
const commands = createDatabase(admin);
type Outcome = { ok: boolean; code?: string; [key: string]: unknown };
async function rpc<T = Outcome>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}
const nowSlot = () => Math.floor(Date.now() / SLOT);
/** Avoid starting a real-clock boundary in the final seconds before the next one. */
async function stableRealSlot(marginMs: number) {
  const remaining = SLOT - (Date.now() % SLOT);
  if (remaining < marginMs) await new Promise(resolve => setTimeout(resolve, remaining + 1_000));
  return nowSlot();
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

// Operator-only world controls for the isolated local test database; no player API exposes them.
async function resetWorld(published: number | null) {
  await resetIdentity();
  await sql`truncate private.boundaries, private.boundary_work, private.dispatch_log`;
  await sql`update private.coordinator set published_slot=${published}, lease_token=null, lease_until_ms=0, last_error=null where singleton`;
  await sql`update private.rules_versions set active=false where version<>'v1'`;
  await sql`delete from private.rules_versions where version<>'v1'`;
  await sql`update private.rules_versions set active=true where version='v1'`;
  await sql`update private.scheduler set enabled=false where singleton`;
}
type Choices = { morning: unknown; afternoon: unknown; evening: unknown };
const ARENA: Choices = { morning: { kind: 'arena' }, afternoon: { kind: 'arena' }, evening: { kind: 'arena' } };
const TRAINING: Choices = { morning: { kind: 'training' }, afternoon: { kind: 'training' }, evening: { kind: 'training' } };
/** Trusted progression inputs that place a starter build in each league (spec §8.1 index 2 × level + earned / 5 + gear / 10). */
const PLACEMENT = { bronze: { earned: 10, level: 1, peak: 0 }, silver: { earned: 105, level: 1, peak: 0 },
  gold: { earned: 10, level: 1, peak: 560 }, champion: { earned: 10, level: 60, peak: 0 } } as const;
type League = keyof typeof PLACEMENT;

/**
 * Real creation, then the operator places the character at a historical first slot (default: the tournament slot T)
 * with a league placement, its automatic-entry flag and optionally its current stamina. Boundary preparation validates
 * the build again.
 */
async function fighter(options: { firstSlot?: number; schedule?: Choices; optIn?: boolean; league?: League; stamina?: number } = {}) {
  const firstSlot = options.firstSlot ?? T, schedule = options.schedule ?? ARENA;
  const owner = await account();
  const name = 'Tourney ' + randomUUID().slice(0, 8);
  const created = await commands.createGladiator({ userId: owner.id }, creation(name));
  if (!created.ok) throw new Error('creation failed');
  const gid = created.value.gladiatorId;
  const createdAt = (firstSlot - 1) * SLOT + 1;
  const place = PLACEMENT[options.league ?? 'bronze'];
  await sql`update public.gladiators set created_at_ms=${createdAt},orientation_end_ms=${firstSlot * SLOT},processed_slot_index=${firstSlot - 1},
    earned_points=${place.earned},unspent_points=${place.earned - 10},level=${place.level},peak_strength=greatest(peak_strength,${place.peak}),
    tournament_opt_in=${options.optIn ?? false} ${options.stamina === undefined ? sql`` : sql`,stamina_current=${options.stamina}`} where id=${gid}`;
  await sql`update public.schedules set schedule=${sql.json(schedule as never)} where gladiator_id=${gid}`;
  for (const phase of ['morning', 'afternoon', 'evening'] as const) {
    await sql`update public.schedule_revisions set received_at_ms=${createdAt},effective_slot_index=${firstSlot},choice=${sql.json(schedule[phase] as never)}
      where gladiator_id=${gid} and phase=${phase}`;
  }
  const state = async (): Promise<OwnerState> => {
    const { data, error } = await owner.client.from('owner_state').select('state').single();
    if (error) throw new Error(error.message);
    return data!.state;
  };
  const row = async () => (await sql`select league, stamina_current::int as stamina, processed_slot_index::int as processed,
    tournament_opt_in as "optIn" from public.gladiators where id=${gid}`)[0];
  return { ...owner, gid, name, state, row };
}
type Fighter = Awaited<ReturnType<typeof fighter>>;
const many = async (n: number, options: Parameters<typeof fighter>[0] = {}) => {
  const all: Fighter[] = [];
  for (let start = 0; start < n; start += 10) all.push(...await Promise.all(Array.from({ length: Math.min(10, n - start) }, () => fighter(options))));
  return all;
};
async function coordinatorLease() {
  const token = randomUUID();
  await sql`update private.coordinator set lease_token=${token},lease_until_ms=9007199254740991 where singleton`;
  return token;
}
const advance = (target: number, token: string) => rpc('advance_boundary', { target_slot: target, coordinator_token: token });
const claim = (kind: string, limit = 20) => rpc<JobLease[]>('claim_jobs', { worker_id: randomUUID(), kind, batch_limit: limit });
const complete = (job: JobLease, result: unknown) => rpc('complete_job', { job_id: job.id, lease_token: job.token, result });
type Adjust = (gladiatorId: string, result: PreparationResult) => PreparationResult;
/** Completes every due preparation through the canonical v1 executor; `adjust` lets a test freeze other (valid) costs. */
async function completePreparations(adjust: Adjust = (_, result) => result) {
  for (let jobs = await claim('prepare'); jobs.length; jobs = await claim('prepare')) {
    for (const job of jobs) {
      expect(await complete(job, adjust(job.gladiatorId!, prepareActivityV1(job.snapshot as PreparationInput)))).toMatchObject({ ok: true });
    }
  }
}
/** Phases 1–6 with canonical preparation, stopping where phase 7 waits for its fenced pairing jobs. */
async function toPairing(target: number, token: string, adjust?: Adjust) {
  expect(await advance(target, token)).toMatchObject({ phase: 4, status: 'waiting', wait: 'preparation' });
  await completePreparations(adjust);
  expect(await advance(target, token)).toMatchObject({ phase: 7, status: 'waiting', wait: 'pairing' });
}
const pairResult = (job: JobLease) => DEFAULT_EXECUTORS.v1.pair!(job) as PairingResult;
async function completePairings() {
  const jobs = await claim('pair');
  for (const job of jobs) expect(await complete(job, pairResult(job))).toMatchObject({ ok: true });
  return jobs;
}
/** Phases 1–8: canonical preparation and partitioned pairing, then publication with the slot's bout jobs. */
async function toPublished(target = T, adjust?: Adjust) {
  const token = await coordinatorLease();
  await toPairing(target, token, adjust);
  const jobs = await completePairings();
  expect(await advance(target, token)).toMatchObject({ phase: 9, status: 'complete' });
  return { token, jobs };
}

type TournamentRow = { id: string; pairing_job_id: string; slot: number; league: string; season: number; size: number; rounds: number;
  starts: number; settles: number; reveal: number[] };
const tournaments = async () => (await sql`select id, pairing_job_id, slot_index::int as slot, league, season_index::int as season, size, rounds,
  starts_at_ms::float8 as starts, settles_at_ms::float8 as settles, reveal_at_ms as reveal from private.tournaments
  order by slot_index, array_position(array['bronze','silver','gold','champion'], league)`) as unknown as TournamentRow[];
type EntryRow = { gladiator_id: string; activity_id: string; rank: number; rating: number; fighter: unknown; name: string };
const entriesOf = async (tid: string) => (await sql`select gladiator_id, activity_id, rank, rating::int as rating, fighter, name
  from private.tournament_entries where tournament_id=${tid} order by rank`) as unknown as EntryRow[];
type BoutRow = { id: string; round: number; position: number; parents: string[]; placed: (string | null)[] | null; bye: boolean;
  reveal: number; seed: string | null; result: { winnerId: string; loserId: string | null; log: unknown } | null };
const boutsOf = async (tid: string) => (await sql`select id, round, position, parent_bout_ids as parents, placed, bye,
  reveal_at_ms::float8 as reveal, seed, result from private.tournament_bouts where tournament_id=${tid} order by round, position`) as unknown as BoutRow[];
/** The stored private graph exactly as the fenced bout read returns it. */
const graphOf = async (tid: string): Promise<TournamentGraph> => (await sql`select private.tournament_graph(${tid}) as graph`)[0].graph;
type BoutJobRow = { id: string; key: string; gladiator_id: string; activity_id: string; slot: number; input: TournamentBoutInput; seed: string;
  due: number; status: string; rules: string };
const boutJobs = async () => (await sql`select id, dedupe_key as key, gladiator_id, activity_id, slot_index::int as slot, input, seed,
  due_at_ms::float8 as due, status, rules_version as rules from private.jobs where dedupe_key like 'tournament-bout:%' order by dedupe_key`) as unknown as BoutJobRow[];
const assignments = async () => (await sql`select battle_id, kind, league, assignment from private.arena_assignments order by battle_id`) as unknown as
  { battle_id: string; kind: string; league: string; assignment: { sides: { gladiatorId: string }[] } }[];
const activityOf = async (gid: string, slot = T) => (await sql`select id, resolved_kind as kind, stamina_debit::int as debit, debited, fallback, status
  from public.activities where gladiator_id=${gid} and slot_index=${slot}`)[0];
const boutRead = (job: JobLease) => rpc<TournamentBoutRead>('tournament_bout_input', { job_id: job.id, lease_token: job.token });
const optIn = (actor: string, command: Record<string, unknown>) => rpc('set_tournament_opt_in', { actor_id: actor, operation_id: command.operationId, input: { command } });
const receipts = async (owner: string) => (await sql`select count(*)::int as n from public.operation_receipts
  where owner_id=${owner} and request->>'kind'='set-tournament-opt-in'`)[0].n as number;
const definitionOf = async (signature: string): Promise<string> =>
  (await sql`select pg_get_functiondef(${signature}::regprocedure) as definition`)[0].definition;

describe('Task 19 phase 2a: tournament entry, brackets inside the pairing job, seeds and bout jobs', () => {
  beforeEach(() => resetWorld(T - 1));
  afterAll(() => sql.end());

  describe('automatic entry: the opt-in command', () => {
    it('saves the flag through the real command path with an account-scoped receipt, replays it and refuses a changed payload', async () => {
      // A character that is caught up with real database time (the command answers processing while the world is behind).
      const current = await stableRealSlot(60_000);
      await resetWorld(current);
      const owner = await fighter({ firstSlot: current + 1 });
      const command = { kind: 'set-tournament-opt-in' as const, operationId: randomUUID(), enabled: true };
      const saved = await commands.setTournamentOptIn({ userId: owner.id }, command);
      expect(saved).toMatchObject({ ok: true, value: { enabled: true } });
      if (!saved.ok) throw new Error('opt-in failed');
      expect(saved.value.receivedAtMs).toBeGreaterThanOrEqual(current * SLOT);
      expect((await owner.state()).tournamentOptIn).toBe(true);
      // A lost response replays the committed receipt; the same operation with another payload is a conflict.
      expect(await commands.setTournamentOptIn({ userId: owner.id }, command)).toEqual(saved);
      expect(await commands.setTournamentOptIn({ userId: owner.id }, { ...command, enabled: false })).toEqual({ ok: false, code: 'conflict' });
      expect(await owner.row()).toMatchObject({ optIn: true });
      expect(await receipts(owner.id)).toBe(1);
      const off = await commands.setTournamentOptIn({ userId: owner.id }, { ...command, operationId: randomUUID(), enabled: false });
      expect(off).toMatchObject({ ok: true, value: { enabled: false } });
      expect((await owner.state()).tournamentOptIn).toBe(false);
      // The real Edge command endpoint routes the canonical command to the same transaction.
      const http = directEdge(owner.token, { kind: 'set-tournament-opt-in', operationId: randomUUID(), enabled: true });
      expect(http).toMatchObject({ status: 200, body: { ok: true, value: { enabled: true } } });
      expect(await owner.row()).toMatchObject({ optIn: true });
      expect(await receipts(owner.id)).toBe(3);
      // Malformed server envelopes are invalid and leave no receipt; an account without a character has none to change.
      const operationId = randomUUID();
      for (const bad of [{ kind: 'set-tournament-opt-in', operationId }, { kind: 'set-tournament-opt-in', operationId, enabled: 'true' },
        { kind: 'set-tournament-opt-in', operationId, enabled: true, gladiatorId: owner.gid }, { kind: 'edit-schedule', operationId, enabled: true },
        { kind: 'set-tournament-opt-in', operationId: randomUUID(), enabled: true }]) {
        expect(await rpc('set_tournament_opt_in', { actor_id: owner.id, operation_id: operationId, input: { command: bad } }), JSON.stringify(bad))
          .toEqual({ ok: false, code: 'invalid' });
      }
      expect(await receipts(owner.id)).toBe(3);
      const stranger = await account();
      expect(await optIn(stranger.id, { kind: 'set-tournament-opt-in', operationId: randomUUID(), enabled: true })).toEqual({ ok: false, code: 'not-found' });
      expect(await rpc('set_tournament_opt_in', { actor_id: null, operation_id: randomUUID(), input: { command: {} } })).toEqual({ ok: false, code: 'unauthenticated' });
    });

    it('freezes the flag at the cutoff: a toggle 1 ms before counts, at or after the cutoff it answers processing until the slot is published', async () => {
      const [a, b] = await many(2, { optIn: true });
      const neverIn = await fighter(), earlyOut = await fighter({ optIn: true }), atCutoff = await fighter(), afterCutoff = await fighter({ optIn: true });
      const earlyIn = await fighter();
      const rollback = new Error('rollback-only');
      await expect(sql.begin(async tx => {
        // Rollback-only operator transaction: the database clock is set to chosen instants around the cutoff.
        const clock = (ms: number) => tx.unsafe(`create or replace function private.planning_now_ms() returns bigint language sql volatile
          security invoker set search_path='' as 'select ${ms}::bigint'`);
        const toggle = async (owner: Fighter, enabled: boolean, operationId = randomUUID()) => (await tx`select public.set_tournament_opt_in(
          ${owner.id},${operationId},${tx.json({ command: { kind: 'set-tournament-opt-in', operationId, enabled } } as never)}) as r`)[0].r;
        await clock(CUTOFF - 1);
        expect(await toggle(earlyIn, true)).toMatchObject({ ok: true, value: { enabled: true, receivedAtMs: CUTOFF - 1 } });
        expect(await toggle(earlyOut, false)).toMatchObject({ ok: true, value: { enabled: false, receivedAtMs: CUTOFF - 1 } });
        await clock(CUTOFF);
        const exactly = randomUUID();
        expect(await toggle(atCutoff, true, exactly)).toEqual({ ok: false, code: 'processing', retryAfterMs: 1000 });
        await clock(CUTOFF + 1);
        const later = randomUUID();
        expect(await toggle(afterCutoff, false, later)).toEqual({ ok: false, code: 'processing', retryAfterMs: 1000 });
        // A transient processing answer is never retained.
        expect((await tx`select count(*)::int as n from public.operation_receipts where operation_id in (${exactly},${later})`)[0].n).toBe(0);
        await clock(CUTOFF + 1_000);
        const token = randomUUID();
        await tx`update private.coordinator set lease_token=${token},lease_until_ms=9007199254740991 where singleton`;
        const advanceTx = async () => (await tx`select public.advance_boundary(${T},${token}) as r`)[0].r;
        expect(await advanceTx()).toMatchObject({ phase: 4, wait: 'preparation' });
        for (const job of (await tx`select public.claim_jobs(${randomUUID()},'prepare',20) as jobs`)[0].jobs as JobLease[]) {
          expect((await tx`select public.complete_job(${job.id},${job.token},${tx.json(prepareActivityV1(job.snapshot as PreparationInput) as never)}) as r`)[0].r)
            .toMatchObject({ ok: true });
        }
        expect(await advanceTx()).toMatchObject({ phase: 7, wait: 'pairing' });
        const [job] = (await tx`select public.claim_jobs(${randomUUID()},'pair',20) as jobs`)[0].jobs as JobLease[];
        // The partition receives the value frozen under the locks at phase 5 as one revision received at cutoff − 1 ms.
        const input = job.snapshot as PairingInput;
        const frozen = Object.fromEntries(input.tournament!.candidates.map(c => [c.gladiatorId, c.optIn]));
        const expected = (enabled: boolean) => [{ enabled, receivedAtMs: CUTOFF - 1 }];
        expect(frozen).toEqual({ [a.gid]: expected(true), [b.gid]: expected(true), [earlyIn.gid]: expected(true), [afterCutoff.gid]: expected(true),
          [earlyOut.gid]: expected(false), [atCutoff.gid]: expected(false), [neverIn.gid]: expected(false) });
        const result = pairResult(job);
        expect((await tx`select public.complete_job(${job.id},${job.token},${tx.json(result as never)}) as r`)[0].r).toMatchObject({ ok: true });
        expect(await advanceTx()).toMatchObject({ phase: 9, status: 'complete' });
        const [tournament] = await tx`select id from private.tournaments`;
        const entrants = (await tx`select gladiator_id from private.tournament_entries where tournament_id=${tournament.id}`).map(r => r.gladiator_id).sort();
        expect(entrants).toEqual([a.gid, b.gid, earlyIn.gid, afterCutoff.gid].sort());
        const regular = (await tx`select assignment from private.arena_assignments`).flatMap(r => r.assignment.sides.map((s: { gladiatorId: string }) => s.gladiatorId)).sort();
        expect(regular).toEqual([earlyOut.gid, atCutoff.gid, neverIn.gid].sort());
        // Once the slot is published the same operations commit, and only later tournaments see them.
        expect(await toggle(atCutoff, true, exactly)).toMatchObject({ ok: true, value: { enabled: true, receivedAtMs: CUTOFF + 1_000 } });
        expect(await toggle(afterCutoff, false, later)).toMatchObject({ ok: true, value: { enabled: false } });
        expect((await tx`select count(*)::int as n from private.tournament_entries`)[0].n).toBe(4);
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await sql`select count(*)::int as n from public.activities`).toEqual([{ n: 0 }]);
    });

    it('resolves a toggle committing at the cutoff by locking: the boundary waits for it and freezes what it committed', async () => {
      const entrant = await fighter({ optIn: true }), toggler = await fighter();
      const definition = await definitionOf('private.planning_now_ms()');
      const contender = await sql.reserve();
      let release!: () => void, locked!: () => void;
      const hold = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { locked = resolve; });
      let toggled: unknown;
      let committing: Promise<unknown> = Promise.resolve();
      try {
        // Test-only stand-in, restored and verified below: each session may pin its own database time.
        await sql.unsafe(`create or replace function private.planning_now_ms() returns bigint language sql volatile security invoker set search_path=''
          as $clock$ select coalesce(nullif(current_setting('cloudiator.test_now_ms', true),'')::bigint, floor(extract(epoch from clock_timestamp())*1000)::bigint) $clock$`);
        committing = sql.begin(async tx => {
          // The toggle takes the account and character locks and samples the clock 1 ms before the cutoff, then commits late.
          await tx.unsafe(`set local cloudiator.test_now_ms = '${CUTOFF - 1}'`);
          const operationId = randomUUID();
          toggled = (await tx`select public.set_tournament_opt_in(${toggler.id},${operationId},
            ${tx.json({ command: { kind: 'set-tournament-opt-in', operationId, enabled: true } } as never)}) as r`)[0].r;
          locked(); await hold;
        });
        // A toggle transaction that fails rejects here instead of leaving the test waiting.
        await Promise.race([ready, committing]);
        expect(toggled).toMatchObject({ ok: true, value: { enabled: true, receivedAtMs: CUTOFF - 1 } });
        const token = await coordinatorLease();
        const [{ pid }] = await contender`select pg_backend_pid() as pid`;
        await contender.unsafe(`set cloudiator.test_now_ms = '${CUTOFF + 1_000}'`);
        const boundary = contender`select public.advance_boundary(${T},${token}) as r`.execute();
        let blocked = false;
        for (let n = 0; n < 200 && !blocked; n++) {
          blocked = (await sql`select cardinality(pg_blocking_pids(${pid}))>0 as blocked`)[0].blocked;
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
        }
        // The boundary, already past the cutoff, cannot read the character while the toggle holds its locks.
        expect(blocked).toBe(true);
        release(); await committing;
        expect((await boundary)[0].r).toMatchObject({ phase: 4, wait: 'preparation' });
        await contender.unsafe('reset cloudiator.test_now_ms');
        await completePreparations();
        expect(await advance(T, token)).toMatchObject({ phase: 7, wait: 'pairing' });
        const [{ starting }] = await sql`select s.snapshot->'starting' as starting from private.activity_snapshots s
          join public.activities a on a.id=s.activity_id where a.gladiator_id=${toggler.gid}`;
        expect(starting.tournamentOptIn).toBe(true);
        await completePairings();
        expect(await advance(T, token)).toMatchObject({ phase: 9, status: 'complete' });
        const [tournament] = await tournaments();
        expect((await entriesOf(tournament.id)).map(e => e.gladiator_id).sort()).toEqual([entrant.gid, toggler.gid].sort());
      } finally {
        release(); await committing.catch(() => undefined);
        await contender.unsafe('reset cloudiator.test_now_ms').catch(() => undefined);
        contender.release();
        await sql.unsafe(definition);
      }
      expect(await definitionOf('private.planning_now_ms()')).toBe(definition);
    }, 60_000);
  });

  describe('the partition inside the per-league pairing job', () => {
    it('brackets each league with at least two eligible entrants and sends the rest to regular Arena exactly once, with one stamina charge', async () => {
      expect(isTournamentSlot(slotAt(CUTOFF))).toBe(true);
      // 5 Bronze, 3 Silver, 2 Gold and 1 Champion entrant, all opted in, plus an opted-out Bronze entrant, a Bronze Arena
      // request without the stamina for it, and a Bronze Training schedule.
      const bronze = await many(5, { optIn: true }), silver = await many(3, { optIn: true, league: 'silver' });
      const gold = await many(2, { optIn: true, league: 'gold' }), [champion] = await many(1, { optIn: true, league: 'champion' });
      const optedOut = await fighter(), tired = await fighter({ optIn: true, stamina: 10 }), trainer = await fighter({ optIn: true, schedule: TRAINING });
      const { jobs } = await toPublished();
      expect(jobs.map(j => (j.snapshot as PairingInput).league).sort()).toEqual(['bronze', 'champion', 'gold', 'silver']);
      const rows = await tournaments();
      expect(rows.map(t => [t.id, t.league, t.size, t.rounds])).toEqual([[`tournament:${T}:bronze`, 'bronze', 8, 3], [`tournament:${T}:silver`, 'silver', 4, 2],
        [`tournament:${T}:gold`, 'gold', 2, 1]]);
      const counts: Record<string, Fighter[]> = { bronze, silver, gold };
      for (const t of rows) {
        const n = counts[t.league].length;
        const entries = await entriesOf(t.id), bouts = await boutsOf(t.id);
        expect(entries.map(e => e.gladiator_id).sort()).toEqual(counts[t.league].map(f => f.gid).sort());
        expect(entries.map(e => e.rank)).toEqual([...Array(n).keys()].map(i => i + 1));
        // n − 1 fought bouts, size − n byes resolved at once, and no NPC.
        expect(bouts).toHaveLength(t.size - 1);
        expect(bouts.filter(b => !b.bye)).toHaveLength(n - 1);
        expect(bouts.filter(b => b.bye)).toHaveLength(t.size - n);
        for (const bout of bouts.filter(b => b.bye)) expect(bout.result).toEqual({ winnerId: bout.placed!.find(id => id !== null), loserId: null, log: null });
        for (const bout of bouts.filter(b => !b.bye)) expect(bout.result).toBeNull();
        expect(t).toMatchObject({ slot: T, season: 0, starts: CUTOFF, settles: CUTOFF + 80 * MINUTE });
      }
      // One bout job per fought bout: 4 + 2 + 1.
      expect(await boutJobs()).toHaveLength(7);
      // Every bracket entrant has one tournament activity charged once at the tournament cost; nobody is charged twice.
      for (const f of [...bronze, ...silver, ...gold]) {
        expect(await activityOf(f.gid)).toMatchObject({ kind: 'tournament', debit: 25, debited: true, status: 'active' });
        expect(await f.row()).toMatchObject({ stamina: 79, processed: T });
      }
      // The lone Champion and the opted-out entrant run regular Arena exactly once; Rest and Training are untouched.
      const regular = await assignments();
      expect(regular.flatMap(a => a.assignment.sides.map(s => s.gladiatorId)).sort()).toEqual([champion.gid, optedOut.gid].sort());
      for (const f of [champion, optedOut]) {
        expect(await activityOf(f.gid)).toMatchObject({ kind: 'arena', debit: 25, debited: true });
        expect(await f.row()).toMatchObject({ stamina: 79 });
      }
      expect(await activityOf(tired.gid)).toMatchObject({ kind: 'rest', debit: 0, fallback: true });
      expect(await tired.row()).toMatchObject({ stamina: 10 });
      expect(await activityOf(trainer.gid)).toMatchObject({ kind: 'training', debit: 20 });
      // The completed job result routes every Arena request of its league once; the Rest route is exactly step 6's fallback.
      const [{ result }] = await sql`select result from private.jobs where dedupe_key=${`pair:${T}:bronze`}`;
      const routes = Object.fromEntries((result as PairingResult).tournament!.routes.map(r => [r.gladiatorId, [r.route, r.reason, r.staminaDebit]]));
      expect(routes).toEqual({ ...Object.fromEntries(bronze.map(f => [f.gid, ['tournament', 'bracket', 25]])),
        [optedOut.gid]: ['arena', 'opted-out', 25], [tired.gid]: ['rest', 'insufficient-stamina', 0] });
      const [{ champ }] = await sql`select result as champ from private.jobs where dedupe_key=${`pair:${T}:champion`}`;
      expect((champ as PairingResult).tournament).toMatchObject({ bracket: null, routes: [{ gladiatorId: champion.gid, route: 'arena', reason: 'too-few-entrants' }] });
    });

    it('routes by the frozen costs: no Arena stamina is Rest even when the tournament is cheaper; Arena but not tournament stamina is regular Arena', async () => {
      const [a, b, c] = await many(3, { optIn: true });
      // Hypothetical valid costs frozen by preparation (v1 charges 25 for both): Arena 30 and tournament 25 with 27 stamina,
      // Arena 25 and tournament 30 with 27 stamina, and Arena 20 and tournament 25 with full stamina.
      const cheaper = await fighter({ optIn: true, stamina: 27 }), dearer = await fighter({ optIn: true, stamina: 27 }), pricier = await fighter({ optIn: true });
      const costs: Record<string, { arena: number; tournament: number }> = { [cheaper.gid]: { arena: 30, tournament: 25 },
        [dearer.gid]: { arena: 25, tournament: 30 }, [pricier.gid]: { arena: 20, tournament: 25 } };
      await toPublished(T, (gid, result) => costs[gid] ? { ...result, costs: { ...result.costs, ...costs[gid] } } : result);
      const [t] = await tournaments();
      expect((await entriesOf(t.id)).map(e => e.gladiator_id).sort()).toEqual([a.gid, b.gid, c.gid, pricier.gid].sort());
      // A bracket entrant is charged once, at its frozen tournament cost.
      expect(await activityOf(pricier.gid)).toMatchObject({ kind: 'tournament', debit: 25 });
      expect(await pricier.row()).toMatchObject({ stamina: 79 });
      expect(await activityOf(cheaper.gid)).toMatchObject({ kind: 'rest', debit: 0, fallback: true });
      expect(await cheaper.row()).toMatchObject({ stamina: 27 });
      expect(await activityOf(dearer.gid)).toMatchObject({ kind: 'arena', debit: 25 });
      expect(await dearer.row()).toMatchObject({ stamina: 2 });
      const [{ result }] = await sql`select result from private.jobs where dedupe_key=${`pair:${T}:bronze`}`;
      const routes = Object.fromEntries((result as PairingResult).tournament!.routes.map(r => [r.gladiatorId, [r.route, r.reason, r.staminaDebit]]));
      expect([routes[cheaper.gid], routes[dearer.gid], routes[pricier.gid]]).toEqual([['rest', 'insufficient-stamina', 0],
        ['arena', 'insufficient-stamina', 25], ['tournament', 'bracket', 25]]);
      expect((await assignments()).flatMap(x => x.assignment.sides.map(s => s.gladiatorId))).toEqual([dearer.gid]);
    });

    it('runs regular Arena only on a slot that is not a tournament slot, whatever the flag', async () => {
      await resetWorld(T);
      const entrants = await many(3, { firstSlot: T + 1, optIn: true });
      expect(isTournamentSlot(slotAt((T + 1) * SLOT))).toBe(false);
      await toPublished(T + 1);
      expect(await tournaments()).toEqual([]);
      expect(await boutJobs()).toEqual([]);
      expect((await assignments()).flatMap(a => a.assignment.sides.map(s => s.gladiatorId)).sort()).toEqual(entrants.map(f => f.gid).sort());
      const [{ result }] = await sql`select result from private.jobs where kind='pair'`;
      expect((result as PairingResult).tournament!.routes.map(r => r.reason)).toEqual(Array(3).fill('not-tournament-slot'));
    });
  });

  describe('acceptance of the TypeScript-built bracket', () => {
    it('rejects a pairing result that omits, duplicates or alters an entrant or fighter, misroutes a candidate, or carries a graph that fails checkGraph', async () => {
      await many(5, { optIn: true });
      const optedOut = await fighter(), tired = await fighter({ optIn: true, stamina: 10 });
      await toPairing(T, await coordinatorLease());
      const [job] = await claim('pair');
      const valid = pairResult(job);
      expect(valid.tournament!.bracket!.size).toBe(8);
      type Loose = Record<string, any>;
      const variant = (change: (copy: Loose) => void) => { const copy = structuredClone(valid) as unknown as Loose; change(copy); return copy; };
      const graphOfCopy = (copy: Loose) => copy.tournament.bracket as Loose;
      const route = (copy: Loose, gid: string) => copy.tournament.routes.find((r: Loose) => r.gladiatorId === gid);
      const fought = (copy: Loose) => graphOfCopy(copy).bouts.find((b: Loose) => b.round === 1 && !b.bye);
      const byeBout = (copy: Loose) => graphOfCopy(copy).bouts.find((b: Loose) => b.bye);
      const entrants: [string, Loose][] = [
        ['an omitted entrant', variant(c => { graphOfCopy(c).entries.pop(); })],
        ['a duplicated entrant', variant(c => { const e = graphOfCopy(c).entries; e[1] = { ...e[0], rank: 2 }; })],
        ['a bracket entrant routed to regular Arena', variant(c => { Object.assign(route(c, graphOfCopy(c).entries[0].gladiatorId), { route: 'arena', reason: 'opted-out' }); })],
        ['a foreign entrant', variant(c => { graphOfCopy(c).entries[0].gladiatorId = randomUUID(); })],
        ['an altered rating', variant(c => { graphOfCopy(c).entries[0].rating += 1; })],
        ['an altered activity', variant(c => { graphOfCopy(c).entries[0].activityId = randomUUID(); })],
        ['an altered fighter', variant(c => { graphOfCopy(c).entries[0].fighter.maxHealth += 1; })],
        ['an extra fighter key', variant(c => { graphOfCopy(c).entries[1].fighter.seed = 'x'; })],
        ['an extra entry key', variant(c => { graphOfCopy(c).entries[1].seed = 'x'; })],
        ['an omitted Rest route', variant(c => { c.tournament.routes = c.tournament.routes.filter((r: Loose) => r.gladiatorId !== tired.gid); })],
        ['an omitted Arena route', variant(c => { c.tournament.routes = c.tournament.routes.filter((r: Loose) => r.gladiatorId !== optedOut.gid); })],
        ['a duplicated route', variant(c => { c.tournament.routes.push(c.tournament.routes[0]); })],
        ['a Rest fallback routed to regular Arena', variant(c => { Object.assign(route(c, tired.gid), { route: 'arena', reason: 'opted-out', staminaDebit: 25 }); })],
        ['an Arena entrant routed to Rest', variant(c => { Object.assign(route(c, optedOut.gid), { route: 'rest', reason: 'insufficient-stamina', staminaDebit: 0 }); })],
        ['an altered stamina debit', variant(c => { route(c, graphOfCopy(c).entries[0].gladiatorId).staminaDebit = 0; })],
        ['an extra route key', variant(c => { c.tournament.routes[0].seed = 'x'; })],
        ['an extra result key', { ...valid, bracket: valid.tournament!.bracket }],
        ['an extra tournament key', variant(c => { c.tournament.seed = 'x'; })],
        ['no bracket for bracket routes', variant(c => { c.tournament.bracket = null; })],
        ['an extra graph key', variant(c => { graphOfCopy(c).seed = 'x'; })],
      ];
      // Each of these graphs also fails the canonical checkGraph (readyBouts runs it).
      const graphs: [string, Loose][] = [
        ['swapped placement', variant(c => { fought(c).placed.reverse(); })],
        ['ranks out of order', variant(c => { const e = graphOfCopy(c).entries; [e[0].rank, e[1].rank] = [e[1].rank, e[0].rank]; })],
        ['an altered bout id', variant(c => { fought(c).id += 'x'; })],
        ['an altered battle id', variant(c => { fought(c).battleId = 'arena:301:forged'; })],
        ['an altered parent', variant(c => { graphOfCopy(c).bouts.at(-1).parentBoutIds.reverse(); })],
        ['a floored reveal time', variant(c => { const g = graphOfCopy(c); g.revealAtMs[0] -= 1; for (const b of g.bouts) if (b.round === 1) b.revealAtMs -= 1; })],
        ['an extra bye', variant(c => { const b = fought(c); b.bye = true; b.result = { winnerId: b.placed[0], loserId: null, log: null }; })],
        ['a bye won by another entrant', variant(c => { byeBout(c).result.winnerId = fought(c).placed[0]; })],
        ['a result for an unfought bout', variant(c => { const b = fought(c); b.result = { winnerId: b.placed[0], loserId: b.placed[1], log: null }; })],
        ['a missing bout', variant(c => { graphOfCopy(c).bouts.pop(); })],
        ['a duplicated bout', variant(c => { const g = graphOfCopy(c); g.bouts[g.bouts.length - 1] = g.bouts[0]; })],
        ['a larger bracket', variant(c => { const g = graphOfCopy(c); g.size = 16; g.rounds = 4; })],
        ['another league', variant(c => { const g = graphOfCopy(c); g.league = 'silver'; })],
        ['another tournament id', variant(c => { graphOfCopy(c).id = `tournament:${T}:silver`; })],
        ['a late settlement', variant(c => { graphOfCopy(c).settlesAtMs += 1; })],
      ];
      for (const [name, graph] of graphs) expect(() => readyBouts(graph.tournament.bracket as TournamentGraph), name).toThrow();
      for (const [name, result] of [...entrants, ...graphs]) {
        expect(await complete(job, result), name).toMatchObject({ ok: false, code: 'invalid' });
        expect(await sql`select (select count(*) from private.tournaments)::int as t, (select count(*) from private.tournament_bouts)::int as b,
          (select count(*) from private.arena_assignments)::int as a`, name).toEqual([{ t: 0, b: 0, a: 0 }]);
      }
      expect(await complete(job, valid)).toMatchObject({ ok: true });
      const [t] = await tournaments();
      // The stored graph is the TypeScript-built one, and it still passes checkGraph.
      expect(await graphOf(t.id)).toEqual(JSON.parse(JSON.stringify(valid.tournament!.bracket)));
      expect(readyBouts(await graphOf(t.id)).length).toBeGreaterThan(0);
      // Bracket, entries and bouts are immutable; a lost response replays without a second write.
      expect(await complete(job, valid)).toMatchObject({ ok: true, replayed: true });
      await expect(sql`update private.tournaments set size=16`).rejects.toThrow('immutable tournaments');
      await expect(sql`update private.tournament_entries set rating=1`).rejects.toThrow('immutable tournament_entries');
      await expect(sql`update private.tournament_bouts set seed='forged' where not bye`).rejects.toThrow('immutable tournament_bouts');
      await expect(sql`update private.tournament_bouts set result=null where bye`).rejects.toThrow('immutable tournament_bouts');
    });
  });

  describe('seeds', () => {
    it('places the bracket under a one-way seed of the pairing job seed and stores a one-way seed per fought bout, stable across a retried pairing', async () => {
      const entrants = await many(5, { optIn: true });
      await toPairing(T, await coordinatorLease());
      const [first] = await claim('pair');
      const input = first.snapshot as PairingInput;
      const bracketSeed = sha256(`${first.seed}:bracket`);
      expect(input.tournament!.bracketSeed).toBe(bracketSeed);
      expect(bracketSeed).not.toBe(first.seed);
      // An injected failure while the bout rows are written rolls the whole completion back.
      await sql.unsafe(`create function private.task19_crash() returns trigger language plpgsql set search_path='' as $$
        begin raise exception 'injected bout crash'; end $$;
        create trigger task19_crash before insert on private.tournament_bouts for each row execute function private.task19_crash();`);
      try {
        await expect(complete(first, pairResult(first))).rejects.toThrow('injected bout crash');
      } finally {
        await sql.unsafe('drop trigger task19_crash on private.tournament_bouts; drop function private.task19_crash();');
      }
      expect(await tournaments()).toEqual([]);
      expect(await sql`select count(*)::int as n from private.tournament_entries`).toEqual([{ n: 0 }]);
      expect(await rpc('fail_job', { job_id: first.id, lease_token: first.token, failure_code: 'execution-failed' })).toMatchObject({ ok: true, status: 'pending' });
      const [retry] = await claim('pair');
      expect(retry).toMatchObject({ id: first.id, attempt: 2, seed: first.seed });
      expect(retry.snapshot).toEqual(first.snapshot);
      expect(pairResult(retry)).toEqual(pairResult(first));
      expect(await complete(retry, pairResult(retry))).toMatchObject({ ok: true });
      const [t] = await tournaments();
      // The stored placement is buildBracket under the derived placement seed.
      const expected = buildBracket(input.tournament!.candidates.map(c => input.entrants.find(e => e.gladiatorId === c.gladiatorId)!), bracketSeed);
      expect((await entriesOf(t.id)).map(e => e.gladiator_id)).toEqual(expected.entries.map(e => e.gladiatorId));
      expect(new Set((await entriesOf(t.id)).map(e => e.gladiator_id))).toEqual(new Set(entrants.map(f => f.gid)));
      const bouts = await boutsOf(t.id);
      for (const bout of bouts) expect(bout.seed).toBe(bout.bye ? null : sha256(`${first.seed}:${bout.id}`));
      const seeds = bouts.filter(b => !b.bye).map(b => b.seed);
      expect(new Set([...seeds, first.seed, bracketSeed]).size).toBe(seeds.length + 2);
      // Publication copies each bout seed onto its job; a lease retry reuses the same seed and input.
      const token = await coordinatorLease();
      expect(await advance(T, token)).toMatchObject({ phase: 9, status: 'complete' });
      const jobs = await boutJobs();
      for (const job of jobs) expect(job.seed).toBe(bouts.find(b => `tournament-bout:${b.id}` === job.key)!.seed);
      const [claimed] = await claim('simulation', 1);
      expect(await rpc('fail_job', { job_id: claimed.id, lease_token: claimed.token, failure_code: 'execution-failed' })).toMatchObject({ ok: true, status: 'pending' });
      const [again] = await claim('simulation', 1);
      expect(again).toMatchObject({ id: claimed.id, attempt: 2, seed: claimed.seed });
      expect(again.snapshot).toEqual(claimed.snapshot);
    });
  });

  describe('bout jobs', () => {
    it('creates one simulation job per fought bout at phase 8, idempotently, anchored to rank 1 and gated by its fought parents', async () => {
      await many(5, { optIn: true });
      await toPublished();
      const [t] = await tournaments();
      const entries = await entriesOf(t.id), bouts = await boutsOf(t.id);
      const id = (round: number, position: number) => `${t.id}:${round}:${position}`;
      // Five entrants in eight slots: ranks 1, 2 and 3 have byes; round 1 fights only 4 v 5.
      expect(bouts.filter(b => b.bye).map(b => [b.id, b.result!.winnerId])).toEqual([[id(1, 0), entries[0].gladiator_id], [id(1, 2), entries[1].gladiator_id],
        [id(1, 3), entries[2].gladiator_id]]);
      const jobs = await boutJobs();
      expect(jobs.map(j => j.key)).toEqual([id(1, 1), id(2, 0), id(2, 1), id(3, 0)].map(b => `tournament-bout:${b}`));
      for (const job of jobs) {
        expect(job).toMatchObject({ gladiator_id: entries[0].gladiator_id, activity_id: entries[0].activity_id, slot: T, due: CUTOFF, status: 'pending', rules: 'v1' });
        expect(job.input).toEqual({ kind: 'tournament-bout', tournamentId: t.id, boutId: job.key.slice('tournament-bout:'.length) });
      }
      const dependencies = async () => Object.fromEntries((await sql`select j.dedupe_key as key, array_agg(p.dedupe_key order by p.dedupe_key) as needs
        from private.job_dependencies d join private.jobs j on j.id=d.job_id join private.jobs p on p.id=d.prerequisite_id group by j.dedupe_key`)
        .map(r => [r.key, r.needs]));
      const before = await dependencies();
      const bout = (b: string) => `tournament-bout:${b}`;
      expect(Object.fromEntries(Object.entries(before).filter(([key]) => key.startsWith('tournament-bout:'))))
        .toEqual({ [bout(id(2, 0))]: [bout(id(1, 1))], [bout(id(3, 0))]: [bout(id(2, 0)), bout(id(2, 1))] });
      // Every entrant's settlement waits for every bout of the tournament.
      for (const entry of entries) expect(before[`settlement:${entry.activity_id}`]).toEqual(jobs.map(j => j.key));
      // Idempotent: preparing every entrant again adds no job or dependency.
      const counts = async () => (await sql`select (select count(*) from private.jobs)::int as jobs, (select count(*) from private.job_dependencies)::int as deps`)[0];
      const expectedCounts = await counts();
      for (const entry of entries) await sql`select private.prepare_activity_jobs(${entry.activity_id})`;
      expect(await counts()).toEqual(expectedCounts);
      expect(await dependencies()).toEqual(before);
      // Only bouts whose fought parents are done are claimable: 4 v 5, and the two bye winners at once.
      const claimed = await claim('simulation', 5);
      expect(claimed.map(j => (j.snapshot as TournamentBoutInput).boutId).sort()).toEqual([id(1, 1), id(2, 1)]);
      expect(await claim('simulation', 5)).toEqual([]);
      const byes = claimed.find(j => (j.snapshot as TournamentBoutInput).boutId === id(2, 1))!;
      const read = await boutRead(byes);
      if (!read.ok) throw new Error('the fenced bout read was refused');
      expect(read.graph).toEqual(await graphOf(t.id));
      expect(read.names).toEqual(Object.fromEntries(entries.map(e => [e.gladiator_id, e.name])));
      expect(JSON.stringify(read)).not.toMatch(/"seed"/);
      const fought = simulateTournamentBoutV1(byes.snapshot as TournamentBoutInput, read, byes.seed);
      expect(fought.log.participants.map(p => [p.gladiatorId, p.name])).toEqual([entries[1], entries[2]].map(e => [e.gladiator_id, e.name]));
      // Phase 2a stops before results are accepted: the bout's completion is refused, writing nothing.
      expect(await complete(byes, fought)).toMatchObject({ ok: false, code: 'invalid' });
      expect(bouts.find(b => b.id === id(2, 1))!.result).toBeNull();
      expect((await boutsOf(t.id)).find(b => b.id === id(2, 1))!.result).toBeNull();
    });

    it('lets a child bout read its parents’ stored winners under its own lease fence', async () => {
      await many(5, { optIn: true });
      await toPublished();
      const [t] = await tournaments();
      const entries = await entriesOf(t.id);
      const id = (round: number, position: number) => `${t.id}:${round}:${position}`;
      const claimed = await claim('simulation', 5);
      const parent = claimed.find(j => (j.snapshot as TournamentBoutInput).boutId === id(1, 1))!;
      const read = await boutRead(parent);
      if (!read.ok) throw new Error('the fenced bout read was refused');
      const parentLog = simulateTournamentBoutV1(parent.snapshot as TournamentBoutInput, read, parent.seed).log;
      // The fence: another token, an expired lease, a job of another kind.
      expect(await rpc('tournament_bout_input', { job_id: parent.id, lease_token: randomUUID() })).toEqual({ ok: false, code: 'conflict' });
      const [settlementJob] = await sql`select id from private.jobs where kind='settlement' limit 1`;
      expect(await rpc('tournament_bout_input', { job_id: settlementJob.id, lease_token: parent.token })).toEqual({ ok: false, code: 'invalid' });
      expect(await rpc('tournament_bout_input', { job_id: randomUUID(), lease_token: parent.token })).toEqual({ ok: false, code: 'not-found' });
      // Trusted operator stand-in for phase 2b's result fence: the parent's result is written once and its job completes.
      const winner = parentLog.winnerId, loser = parentLog.participants.map(p => p.id).find(p => p !== winner)!;
      await sql`update private.tournament_bouts set result=${sql.json({ winnerId: winner, loserId: loser, log: parentLog } as never)} where id=${id(1, 1)} and result is null`;
      await expect(sql`update private.tournament_bouts set result=${sql.json({ winnerId: loser, loserId: winner, log: parentLog } as never)} where id=${id(1, 1)}`)
        .rejects.toThrow('immutable tournament_bouts');
      await sql`update private.jobs set status='completed',result=${sql.json({ boutId: id(1, 1), log: parentLog } as never)},completed_at_ms=0 where id=${parent.id}`;
      const [child] = await claim('simulation', 5);
      expect((child.snapshot as TournamentBoutInput).boutId).toBe(id(2, 0));
      const childRead = await boutRead(child);
      if (!childRead.ok) throw new Error('the fenced bout read was refused');
      expect(childRead.graph.bouts.find(b => b.id === id(1, 1))!.result).toEqual(JSON.parse(JSON.stringify({ winnerId: winner, loserId: loser, log: parentLog })));
      const log = simulateTournamentBoutV1(child.snapshot as TournamentBoutInput, childRead, child.seed).log;
      // The child fights rank 1 (its bye) against the parent's stored winner, both at full health.
      expect(log.participants.map(p => [p.gladiatorId, p.initialHealth === p.maxHealth])).toEqual([[entries[0].gladiator_id, true], [winner, true]]);
      // An expired lease is refused even though the token is current.
      await sql`update private.jobs set lease_until_ms=0 where id=${child.id}`;
      expect(await boutRead(child)).toEqual({ ok: false, code: 'conflict' });
    });

    it('checks the bout lease after a proven wait for its job row lock', async () => {
      await many(2, { optIn: true });
      await toPublished();
      const [job] = await claim('simulation', 1);
      const [{ expiry }] = await sql`update private.jobs set lease_until_ms=private.planning_now_ms()+3000 where id=${job.id} returning lease_until_ms::text as expiry`;
      let locked!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { locked = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      const blocker = sql.begin(async tx => { await tx`select 1 from private.jobs where id=${job.id} for update`; locked(); await hold; });
      await ready;
      const contender = await sql.reserve();
      let response: PromiseLike<unknown> | undefined;
      try {
        const [{ pid }] = await contender`select pg_backend_pid() as pid`;
        response = contender`select public.tournament_bout_input(${job.id},${job.token}) as outcome`.execute();
        let blocked = false;
        for (let n = 0; n < 100; n++) {
          const [state] = await sql`select cardinality(pg_blocking_pids(${pid}))>0 as blocked, private.planning_now_ms()::text as now`;
          if (state.blocked) { expect(Number(state.now)).toBeLessThan(Number(expiry)); blocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        while (Number((await sql`select private.planning_now_ms()::text as now`)[0].now) <= Number(expiry)) await new Promise(resolve => setTimeout(resolve, 40));
        release(); await blocker;
        expect(await response).toMatchObject([{ outcome: { ok: false, code: 'conflict' } }]);
      } finally { release(); await blocker; await response; contender.release(); }
    });
  });

  it('counts human tournament bouts in the pairing history: round one from the placement, later rounds once their result is stored', async () => {
    const entrants = await many(4, { optIn: true });
    await toPublished();
    const [t] = await tournaments();
    const entries = await entriesOf(t.id);
    // Trusted operator stand-in for phase 2b: the slot's bouts are recorded with real logs under their stored seeds, and the
    // slot is marked settled so the next boundary can open.
    let graph = await graphOf(t.id);
    const names = Object.fromEntries(entries.map(e => [e.gladiator_id, e.name]));
    const seeds = Object.fromEntries((await boutsOf(t.id)).map(b => [b.id, b.seed]));
    for (const round of [1, 2]) {
      for (const job of readyBouts(graph).filter(b => b.round === round)) graph = recordBout(graph, job.boutId, runBout(job, seeds[job.boutId]!, names));
    }
    const final = graph.bouts.find(b => b.round === 2)!;
    for (const bout of graph.bouts.filter(b => b.round === 1)) {
      await sql`update private.tournament_bouts set result=${sql.json(bout.result as never)} where id=${bout.id}`;
    }
    await sql`update public.activities set status='completed' where slot_index=${T}`;
    const token = await coordinatorLease();
    await toPairing(T + 1, token);
    const [job] = await claim('pair');
    const pairOf = (bout: { placed: readonly (string | null)[] | null }) => [...bout.placed!];
    const roundOne = graph.bouts.filter(b => b.round === 1).map(b => ({ slotIndex: T, gladiatorIds: pairOf(b) }));
    // Round one counts from the stored placement; the final has no stored result yet, so it does not count.
    expect((job.snapshot as PairingInput).recent).toEqual(roundOne);
    await sql`update private.tournament_bouts set result=${sql.json(final.result as never)} where id=${final.id}`;
    const [{ input }] = await sql`select private.pairing_input(${T + 1},'bronze',0,'v1') as input`;
    expect((input as PairingInput).recent).toEqual([...roundOne, { slotIndex: T, gladiatorIds: [final.result!.winnerId, final.result!.loserId] }]);
    expect(new Set(roundOne.flatMap(r => r.gladiatorIds))).toEqual(new Set(entrants.map(f => f.gid)));
  });

  it('denies clients the tournament tables, the placement and bout seeds, the opt-in RPC and the fenced bout read', async () => {
    const [owner, other] = await many(2, { optIn: true });
    await toPublished();
    const tables = ['tournaments', 'tournament_entries', 'tournament_bouts'];
    expect(await sql`select c.relname, c.relrowsecurity as rls,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') as client
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in ${sql(tables)} order by c.relname`)
      .toEqual(tables.sort().map(relname => ({ relname, rls: true, client: false })));
    for (const client of [owner.client, other.client, anonymous]) {
      for (const table of tables) expect((await client.schema('private').from(table).select('*')).error, table).not.toBeNull();
    }
    const functions = await sql`select p.oid::regprocedure::text as name, p.prosecdef,
      has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE') as client,
      has_function_privilege('service_role',p.oid,'EXECUTE') as backend
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where (n.nspname='public' and p.proname in ('set_tournament_opt_in','tournament_bout_input'))
        or (n.nspname='private' and p.proname in ('valid_bracket','tournament_graph','guard_tournament_bout','pairing_input','boundary_pair',
          'accept_pairing','prepare_activity_jobs','activity_executor_ready'))`;
    expect(functions).toHaveLength(10);
    for (const f of functions) expect(f, f.name).toMatchObject({ prosecdef: false, client: false, backend: true });
    for (const client of [owner.client, anonymous]) {
      const operationId = randomUUID();
      expect((await client.rpc('set_tournament_opt_in', { actor_id: owner.id, operation_id: operationId,
        input: { command: { kind: 'set-tournament-opt-in', operationId, enabled: false } } })).error).not.toBeNull();
      const [job] = await sql`select id from private.jobs where dedupe_key like 'tournament-bout:%'`;
      expect((await client.rpc('tournament_bout_input', { job_id: job.id, lease_token: randomUUID() })).error).not.toBeNull();
    }
    expect(await owner.row()).toMatchObject({ optIn: true });
    // No seed, placement seed, rank, frozen fighter or bracket internals reach an owner, spectator or public read.
    const [pairing] = await sql`select seed, input->'tournament'->>'bracketSeed' as bracket from private.jobs where kind='pair'`;
    const boutSeeds = (await sql`select seed from private.tournament_bouts where seed is not null`).map(r => r.seed);
    const activity = (await activityOf(owner.gid)).id;
    const visible = JSON.stringify([await owner.state(), await readProfile(other.client, owner.gid), (await owner.client.from('activities').select('*')).data,
      (await other.client.from('world_actor_reads').select('*')).data, (await other.client.from('activity_stages').select('*')).data,
      (await other.client.from('recent_results').select('*')).data, await readTimeline(other.client, activity), await readTimeline(owner.client, activity)]);
    for (const seed of [pairing.seed, pairing.bracket, ...boutSeeds]) expect(visible).not.toContain(seed);
    expect(visible).not.toMatch(/"seed"|bracketSeed|"rank"|"fighter"|"placed"|"routes"|tournament:301/);
  });

  it('times a 50-entrant tournament slot at the one-minute cron cadence: steady-state publication with every bracket and bout job, in both dispatch window cases', async () => {
    // Two runs of the same pair of boundaries through the real scheduled tick and the real private Edge worker reached
    // through pg_net: P, a cold regular Arena slot, then the tournament slot T = P + 1 in steady state (P's 50
    // settlements fall due at T's cutoff and must finish before phase 1 continues). Run 1 ticks T exactly a minute apart
    // (the rolling dispatch window has cleared), run 2 ticks it 1 ms less than a minute apart (it still holds the previous
    // tick). T is the next real Wednesday or Saturday 17:20 UTC slot, so database time stays near real time.
    let tournamentSlot = nowSlot() + 2;
    while (!isTournamentSlot(slotAt(tournamentSlot * SLOT))) tournamentSlot += 1;
    const P = tournamentSlot - 1;
    const secret = process.env.LOCAL_WORKER_SECRET ?? '';
    expect(secret.length).toBeGreaterThanOrEqual(32);
    const clockQuery = `select pg_get_functiondef('private.planning_now_ms()'::regprocedure) as definition`;
    const [{ definition }] = await sql.unsafe(clockQuery);
    const setClock = (body: string) => sql.unsafe(`create or replace function private.planning_now_ms() returns bigint language sql
      volatile security invoker set search_path='' as '${body}'`);
    type Report = { failed: number; conflicts: number; unrecorded: number; deferred?: number; byKind: Record<string, number> };
    type Tick = { atMs: number; dispatched: number; claimableSimple: number; claimableCombat: number; invocations: string[] };
    const reports: Report[] = [];
    async function tick(at: number): Promise<Tick> {
      await setClock(`select ${at}::bigint`);
      // The scheduler is enabled only inside this transaction, so the real pg_cron run stays inert.
      const result = await sql.begin(async tx => {
        await tx`update private.scheduler set enabled=true where singleton`;
        const [{ tick: ran }] = await tx`select private.cron_tick() as tick`;
        await tx`update private.scheduler set enabled=false where singleton`;
        return ran;
      });
      const [{ real }] = await sql`select floor(extract(epoch from clock_timestamp())*1000)::float8 as real`;
      await setClock(`select floor(extract(epoch from clock_timestamp())*1000)::bigint+${at - real}`);
      const ids: number[] = result.dispatch.requestIds;
      let responses: { status_code: number | null; content: string | null }[] = [];
      for (const deadline = Date.now() + 60_000; ids.length && Date.now() < deadline;) {
        responses = await sql`select status_code, content from net._http_response where id in ${sql(ids)}`;
        if (responses.length === ids.length && responses.every(r => r.status_code)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(responses.map(r => r.status_code)).toEqual(ids.map(() => 200));
      const invocations = responses.map(r => JSON.parse(r.content!) as Report);
      reports.push(...invocations);
      return { atMs: at, dispatched: result.dispatch.dispatched, claimableSimple: result.dispatch.claimableSimple,
        claimableCombat: result.dispatch.claimableCombat,
        invocations: invocations.map(r => Object.entries(r.byKind).filter(([, n]) => n).map(([kind, n]) => `${kind} ${n}`).join(', ') || 'idle') };
    }
    const phaseOf = async (slot: number) => (await sql`select phase::int from private.boundaries where slot_index=${slot}`)[0]?.phase ?? 0;
    /** One run: the cold regular slot P to its minute-60 reveals, then the tournament slot T from its cutoff to publication. */
    async function run(spacing: number) {
      await resetWorld(P - 1);
      await many(50, { firstSlot: P, optIn: true });
      for (let k = 0; k < 6 && !(await phaseOf(P) === 9 && (await sql`select count(*)::int as n from private.jobs
        where kind='simulation' and slot_index=${P} and status<>'completed'`)[0].n === 0); k++) await tick(P * SLOT + k * MINUTE);
      for (let k = 0; k < 3; k++) {
        await tick(P * SLOT + RULES_V1.arena.revealAfterMs + k * MINUTE);
        if ((await sql`select count(*)::int as n from private.jobs where kind='reveal' and slot_index=${P} and status<>'completed'`)[0].n === 0) break;
      }
      const cutoff = tournamentSlot * SLOT, ticks: Tick[] = [];
      for (let k = 0; k < 5 && await phaseOf(tournamentSlot) !== 9; k++) ticks.push(await tick(cutoff + k * spacing));
      const [m] = await sql`select
        (select max(completed_at_ms) from private.jobs where kind='settlement' and slot_index=${P})::float8 as settled,
        (select max(completed_at_ms) from private.jobs where kind='prepare' and slot_index=${tournamentSlot})::float8 as prepared,
        (select max(completed_at_ms) from private.jobs where kind='pair' and slot_index=${tournamentSlot})::float8 as paired,
        (select completed_at_ms from private.boundaries where slot_index=${tournamentSlot})::float8 as published,
        (select count(*)::int from private.jobs where dedupe_key like 'tournament-bout:%' and slot_index=${tournamentSlot}) as bouts,
        (select count(*)::int from private.job_dependencies d join private.jobs j on j.id=d.job_id where j.slot_index=${tournamentSlot}) as dependencies`;
      const since = (ms: number | null) => ms === null ? null : ms - cutoff;
      return { spacingMs: spacing, settledMs: since(m.settled), preparedMs: since(m.prepared)!, pairedMs: since(m.paired)!, publishedMs: since(m.published),
        bouts: m.bouts as number, dependencies: m.dependencies as number, ticks: ticks.map(x => ({ ...x, atMs: x.atMs - cutoff })) };
    }
    await sql`delete from vault.secrets where name in ('game_worker_url','game_worker_secret')`;
    const started = Date.now();
    const measured: Awaited<ReturnType<typeof run>>[] = [];
    try {
      await sql`select vault.create_secret('http://supabase_edge_runtime_Cloudiator:8081/game-worker','game_worker_url')`;
      await sql`select vault.create_secret(${secret},'game_worker_secret')`;
      measured.push(await run(MINUTE));
      // Checked here, before the second run resets the world: one 50-entrant Bronze bracket and no other league.
      const [t] = await tournaments();
      expect(await tournaments()).toHaveLength(1);
      expect(t).toMatchObject({ league: 'bronze', size: 64, rounds: 6 });
      expect(await sql`select count(*)::int as n from private.tournament_entries`).toEqual([{ n: 50 }]);
      expect(await sql`select count(*)::int as n from private.tournament_bouts where bye`).toEqual([{ n: 14 }]);
      expect(await sql`select count(*)::int as n from private.jobs where kind='pair' and slot_index=${tournamentSlot}`).toEqual([{ n: 1 }]);
      expect(await sql`select count(*)::int as n from public.activities where slot_index=${tournamentSlot} and resolved_kind='tournament'
        and status='active' and debited and stamina_debit=25`).toEqual([{ n: 50 }]);
      // Only the ready bouts are claimable: the 18 fought first-round bouts and the round-two bouts between two bye winners.
      const graph = await graphOf(t.id);
      const ready = readyBouts(graph).map(b => `tournament-bout:${b.boutId}`).sort();
      const claimable = (await sql`select dedupe_key from private.jobs where dedupe_key like 'tournament-bout:%' and status='pending'
        and private.dependencies_ready(id) order by dedupe_key`).map(r => r.dedupe_key);
      expect(claimable).toEqual(ready);
      measured.push(await run(MINUTE - 1));
    } finally {
      await sql`update private.scheduler set enabled=false where singleton`;
      await sql.unsafe(definition);
      await sql`delete from vault.secrets where name in ('game_worker_url','game_worker_secret')`;
    }
    expect((await sql.unsafe(clockQuery))[0].definition).toBe(definition);
    console.info(`Task 19 tournament slot at the one-minute cron cadence: ${JSON.stringify({ entrants: 50, tournamentSlot, targetMs: 120_000,
      wallMs: Date.now() - started, runs: measured })}`);
    const [cleared, held] = measured;
    for (const m of measured) {
      // 49 bout jobs (n − 1), and each of the 50 settlement jobs waits for all of them, plus the bouts' parent dependencies.
      expect(m.bouts).toBe(49);
      expect(m.publishedMs).not.toBeNull();
      expect(m.settledMs!).toBeLessThanOrEqual(m.preparedMs);
      expect(m.preparedMs <= m.pairedMs && m.pairedMs <= m.publishedMs!).toBe(true);
      expect(m.ticks[0]).toMatchObject({ atMs: 0, dispatched: 3, claimableSimple: 50 });
    }
    expect(cleared.publishedMs!).toBeLessThan(120_000);
    expect(held.publishedMs!).toBeLessThan(180_000);
    // Every simple job was run by the real worker with no failure, conflict, unrecorded failure or deferral.
    expect(reports.reduce((sum, r) => sum + r.failed + r.conflicts + r.unrecorded + (r.deferred ?? 0), 0)).toBe(0);
  }, 600_000);
});
