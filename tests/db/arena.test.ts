import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { sql, account, resetIdentity, admin, anonymous, creation } from '../fixtures/db.ts';
import { createDatabase, createWorkerDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { DEFAULT_EXECUTORS, prepareActivityV1, runWorker } from '../../supabase/functions/_shared/backend/jobs.ts';
import type { ArenaSimulationInput, ArenaSimulationResult, PairingInput, PairingResult } from '../../supabase/functions/_shared/backend/jobs.ts';
import { estimateArenaStrength, leagueFor, makeFallback, matchArena } from '../../supabase/functions/_shared/domain/arena.ts';
import { makeFighter } from '../../supabase/functions/_shared/domain/combat.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import type { Attributes, ClassId, FighterSnapshot, JobLease, PreparationInput, PreparationResult, Stance } from '../../supabase/functions/_shared/domain/types.ts';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands.ts';
import type { ActivitySummary, BattleLog, RevealedStage } from '../../supabase/functions/_shared/contracts/events.ts';
import type { OwnerState, StandingRow } from '../../supabase/functions/_shared/contracts/reads.ts';
import { readProfile, readStandings, readTimeline } from '../../src/lib/api/reads.ts';

const SLOT = 4_800_000;
const MINUTE = 60_000;
const commands = createDatabase(admin);
const worker = createWorkerDatabase(admin);
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
type Build = { classId?: ClassId; stance?: Stance; allocations?: Attributes };
const allocation = (strength: number, agility: number, vitality: number, endurance: number, precision: number): Attributes =>
  ({ strength, agility, vitality, endurance, precision });
/** Strengths with the starter sword and light armor, found by a probe over real catalog builds (see the phase 2a report). */
const BUILDS = {
  weak: { classId: 'berserker', allocations: allocation(0, 0, 0, 0, 6) },        // 708.37
  double: { classId: 'guardian', allocations: allocation(7, 4, 4, 0, 3) },       // 1416.74, exactly 2 × 708.37
  doublePlus: { classId: 'berserker', allocations: allocation(0, 0, 10, 0, 6) }, // 1416.75, one hundredth above
  strong: { classId: 'guardian', allocations: allocation(5, 2, 3, 0, 2) },       // 1175.35
  starter: { classId: 'guardian', allocations: allocation(2, 2, 2, 2, 2) },      // 931.75, the creation build
} satisfies Record<string, Build>;

/**
 * Real creation, then the operator places the character at a historical first slot with trusted progression inputs
 * (earned and banked points, level, historical gear strength) and a build that boundary preparation validates again.
 */
async function fighter(options: { firstSlot?: number; schedule?: Choices; earned?: number; level?: number; peak?: number; league?: string; build?: Build } = {}) {
  const firstSlot = options.firstSlot ?? 300, schedule = options.schedule ?? ARENA;
  const owner = await account();
  const created = await commands.createGladiator({ userId: owner.id }, creation('Arena ' + randomUUID().slice(0, 8)));
  if (!created.ok) throw new Error('creation failed');
  const gid = created.value.gladiatorId;
  const createdAt = (firstSlot - 1) * SLOT + 1;
  const [{ current }] = await sql`select current_build as current from public.builds where gladiator_id=${gid}`;
  const build = { ...current, classId: options.build?.classId ?? current.classId, stance: options.build?.stance ?? current.stance,
    allocations: options.build?.allocations ?? current.allocations };
  const allocated = Object.values(build.allocations as Attributes).reduce((sum, value) => sum + value, 0);
  // Enough earned points for the build; at most 18 keeps the default placement Bronze (2 + 3 + 2).
  const earned = options.earned ?? Math.max(10, allocated);
  await sql`update public.builds set current_build=${sql.json(build)} where gladiator_id=${gid}`;
  await sql`update public.gladiators set created_at_ms=${createdAt},orientation_end_ms=${firstSlot * SLOT},processed_slot_index=${firstSlot - 1},
    earned_points=${earned},unspent_points=${earned - allocated},level=${options.level ?? 1},peak_strength=greatest(peak_strength,${options.peak ?? 0})
    ${options.league ? sql`,league=${options.league}` : sql``} where id=${gid}`;
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
  const row = async () => (await sql`select league, rating::int as rating, stamina_current::int as stamina, processed_slot_index::int as processed
    from public.gladiators where id=${gid}`)[0];
  return { ...owner, gid, state, row };
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
/** Completes every due preparation through the canonical v1 executor, without letting a worker coordinate afterwards. */
async function completePreparations() {
  for (let jobs = await claim('prepare'); jobs.length; jobs = await claim('prepare')) {
    for (const job of jobs) expect(await complete(job, prepareActivityV1(job.snapshot as PreparationInput))).toMatchObject({ ok: true });
  }
}
/** Phases 1–6 with canonical preparation, stopping where phase 7 waits for its fenced pairing jobs. */
async function toPairing(target: number, token: string) {
  expect(await advance(target, token)).toMatchObject({ phase: 4, status: 'waiting', wait: 'preparation' });
  await completePreparations();
  expect(await advance(target, token)).toMatchObject({ phase: 7, status: 'waiting', wait: 'pairing' });
}
const pairResult = (job: JobLease) => DEFAULT_EXECUTORS.v1.pair!(job) as PairingResult;
/** Claims and completes every pairing job of the slot with the canonical executor. */
async function completePairings() {
  const jobs = await claim('pair');
  for (const job of jobs) expect(await complete(job, pairResult(job))).toMatchObject({ ok: true });
  return jobs;
}
const preparation = async (target: number, gid: string): Promise<PreparationResult> =>
  (await sql`select result from private.jobs where dedupe_key=${`prepare:${target}:${gid}`}`)[0].result;
type ArenaRow = PairingResult['assignments'][number];
type AssignmentRow = { battle_id: string; kind: 'human' | 'npc'; league: string; season: number; slot: number; seed: string;
  pairing_job_id: string; assignment: ArenaRow };
const assignments = async () => (await sql`select battle_id, kind, league, season_index::int as season, slot_index::int as slot, seed,
  pairing_job_id, assignment from private.arena_assignments order by battle_id`) as unknown as AssignmentRow[];
const ratingRows = (gid: string) => sql`select league, season_index::int as season, rating::int as rating, human_wins::int as wins,
  human_losses::int as losses from private.arena_ratings where gladiator_id=${gid} order by league`;
const sidesOf = (rows: Awaited<ReturnType<typeof assignments>>) => rows.flatMap(r => r.assignment.sides.map(s => s.gladiatorId));

/** Phases 1–8 with canonical preparation and pairing: every Arena activity is published with its jobs and warm-up. */
async function toPublished(target: number, token: string) {
  await toPairing(target, token);
  await completePairings();
  expect(await advance(target, token)).toMatchObject({ phase: 9, status: 'complete' });
}
/** Runs every due battle simulation through the canonical v1 executor, at most five per claim as the worker does. */
async function simulateAll() {
  const done: JobLease[] = [];
  for (let jobs = await claim('simulation', 5); jobs.length; jobs = await claim('simulation', 5)) {
    for (const job of jobs) {
      expect(await complete(job, DEFAULT_EXECUTORS.v1.simulation!(job))).toMatchObject({ ok: true });
      done.push(job);
    }
  }
  return done;
}
async function revealAll() {
  for (let jobs = await claim('reveal'); jobs.length; jobs = await claim('reveal')) {
    for (const job of jobs) expect(await complete(job, {})).toMatchObject({ ok: true });
  }
}
type Settled = { ok: boolean; code?: string; newGrants?: number; replayed?: boolean; summary?: ActivitySummary };
const settle = async (job: JobLease) => await worker.settle(job.activityId!, job.token) as Settled;
/** Claims every due settlement and settles each side through the real worker RPC adapter, one side at a time. */
async function settleAll() {
  const settled = new Map<string, Settled>();
  for (const job of await claim('settlement')) settled.set(job.activityId!, await settle(job));
  return settled;
}
/** A whole regular-Arena slot: the boundary, one simulation per battle, the minute-60 reveals and the minute-80 credit. */
async function arenaSlot(target = 300) {
  const token = await coordinatorLease();
  await toPublished(target, token);
  await simulateAll();
  await revealAll();
  return { token, settled: await settleAll() };
}
const activityOf = async (gid: string, slot = 300): Promise<string> =>
  (await sql`select id from public.activities where gladiator_id=${gid} and slot_index=${slot}`)[0].id;
const summaryOf = async (gid: string, slot = 300): Promise<ActivitySummary> =>
  (await sql`select summary from public.activities where gladiator_id=${gid} and slot_index=${slot}`)[0].summary;
/**
 * `db.settleNpcWin()` (plan Step 1): a lone entrant fights its NPC fallback through a whole slot. The battle seed is private
 * and random (derived from the pairing job's own seed), and the starter build beats its 85% fallback about nine times in
 * ten, so the helper repeats fresh slots until a credited win; a seeded loss on the way must credit no renown.
 */
async function settleNpcWin() {
  for (let attempt = 1; attempt <= 8; attempt++) {
    await resetWorld(299);
    const solo = await fighter();
    await arenaSlot();
    const summary = await summaryOf(solo.gid);
    if (summary.result === 'victory') return { solo, summary, attempt, renown: summary.rewards.renown, ratingDelta: summary.ratingDelta };
    expect(summary).toMatchObject({ result: 'defeat', success: false, rewards: { renown: 0 }, ratingDelta: 0 });
  }
  throw new Error('no NPC win in eight seeded bouts');
}
type StageRow = { ordinal: number; reveal: number; stage: RevealedStage };
const stagesOf = async (activity: string) => (await sql`select ordinal::int, reveal_at_ms::float8 as reveal, stage from public.activity_stages
  where activity_id=${activity} order by ordinal`) as unknown as StageRow[];
const walletOf = async (gid: string) => (await sql`select money::int as money, renown::int as renown from public.wallets where gladiator_id=${gid}`)[0];
const ledgerOf = (gid: string) => sql`select money_delta::int as money, renown_delta::int as renown, reason from public.wallet_ledger
  where gladiator_id=${gid} and reason<>'creation'`;
const definitionOf = async (signature: string): Promise<string> =>
  (await sql`select pg_get_functiondef(${signature}::regprocedure) as definition`)[0].definition;

describe('Arena league placement, rating rows and pairing inside the boundary', () => {
  beforeEach(() => resetWorld(299));
  afterAll(() => sql.end());

  describe('league placement and ratings at phase 4', () => {
    it('promotes from banked points at a boundary and starts the new league-season rating at 1000, keeping the old record', async () => {
      const owner = await fighter({ schedule: TRAINING, earned: 105 });
      // Allocated points alone would stay Bronze; every earned point counts, including the 95 still banked.
      expect([leagueFor(1, 10, 28), leagueFor(1, 105, 28)]).toEqual(['bronze', 'silver']);
      // An earlier Bronze season record (as if after bouts) and its cache on the character.
      await sql`insert into private.arena_ratings(gladiator_id,league,season_index,rating,human_wins,human_losses) values(${owner.gid},'bronze',0,1040,3,1)`;
      await sql`update public.gladiators set rating=1040 where id=${owner.gid}`;
      const token = await coordinatorLease();
      expect(await advance(300, token)).toMatchObject({ phase: 4, wait: 'preparation' });
      // Promotion applies only at the boundary, after preparation.
      expect(await owner.row()).toMatchObject({ league: 'bronze', rating: 1040 });
      await completePreparations();
      expect(await advance(300, token)).toMatchObject({ status: 'complete' });
      expect((await preparation(300, owner.gid)).league).toBe('silver');
      expect(await owner.row()).toMatchObject({ league: 'silver', rating: 1000 });
      expect(await ratingRows(owner.gid)).toEqual([{ league: 'bronze', season: 0, rating: 1040, wins: 3, losses: 1 },
        { league: 'silver', season: 0, rating: 1000, wins: 0, losses: 0 }]);
      const [{ starting }] = await sql`select snapshot->'starting' as starting from private.activity_snapshots`;
      expect(starting).toMatchObject({ league: 'silver', rating: 1000, earnedPoints: 105, unspentPoints: 95 });
      expect((await owner.state()).progression).toMatchObject({ league: 'silver', rating: 1000 });
    });

    it('never lowers a placement, even when the frozen computation is lower', async () => {
      const owner = await fighter({ schedule: TRAINING, league: 'gold' });
      expect(await rpcBoundary(300)).toMatchObject({ status: 'complete' });
      expect((await preparation(300, owner.gid)).league).toBe('bronze');
      expect(await owner.row()).toMatchObject({ league: 'gold', rating: 1000 });
      expect(await ratingRows(owner.gid)).toEqual([{ league: 'gold', season: 0, rating: 1000, wins: 0, losses: 0 }]);
      await expect(sql`update public.gladiators set league='silver' where id=${owner.gid}`).rejects.toThrow('league placement decrease');
      await expect(sql`update private.arena_ratings set league='bronze' where gladiator_id=${owner.gid}`).rejects.toThrow('immutable arena rating');
      await expect(sql`update private.arena_ratings set human_wins=-1 where gladiator_id=${owner.gid}`).rejects.toThrow();
      await expect(sql`delete from private.arena_ratings where gladiator_id=${owner.gid}`).rejects.toThrow('immutable arena rating');
    });

    it('keeps a weak current loadout in its historical league and publishes its current combat strength separately', async () => {
      const owner = await fighter({ schedule: TRAINING, peak: 560 }), spectator = await account();
      // Historical gear 560 places Gold (2 + 2 + 56); the current starter loadout's own score (28) would give Bronze.
      expect([leagueFor(1, 10, 560), leagueFor(1, 10, 28)]).toEqual(['gold', 'bronze']);
      expect((await readProfile(spectator.client, owner.gid)).combatStrength).toBeNull();
      expect(await rpcBoundary(300)).toMatchObject({ status: 'complete' });
      const prepared = await preparation(300, owner.gid);
      // Recompute from the frozen job input, not the stored snapshot: JSONB reorders the equipment keys that
      // makeFighter's silhouette order follows, which is why the fighter itself is frozen for comparison.
      const [{ input }] = await sql`select input from private.jobs where dedupe_key=${`prepare:300:${owner.gid}`}`;
      const recomputed = prepareActivityV1(input as PreparationInput);
      const current = makeFighter(recomputed.snapshot, 'arena', RULES_V1);
      expect(prepared.snapshot).toEqual(recomputed.snapshot);
      expect(makeFighter(prepared.snapshot, 'arena', RULES_V1).equipmentSilhouettes).toEqual([...current.equipmentSilhouettes].reverse());
      expect(prepared).toMatchObject({ league: 'gold', arenaStrength: 931.75 });
      expect(prepared.arenaFighter).toEqual(current);
      expect(prepared.npcTemplate).toEqual(makeFallback(current));
      expect(await owner.row()).toMatchObject({ league: 'gold', rating: 1000 });
      const profile = await readProfile(spectator.client, owner.gid);
      expect(profile).toMatchObject({ combatStrength: estimateArenaStrength(current), rating: 1000, actor: { league: 'gold' } });
      expect(profile.combatStrength).toBe(931.75);
    });

    it('derives seasons from one immutable epoch and waits truthfully at phase 4 when no epoch covers the slot', async () => {
      expect(await sql`select private.season_index(0)::int as a, private.season_index(503)::int as b, private.season_index(504)::int as c,
        private.season_index(300)::int as d`).toEqual([{ a: 0, b: 0, c: 1, d: 0 }]);
      await expect(sql`update private.season_epoch set epoch_slot=1`).rejects.toThrow('immutable season_epoch');
      await expect(sql`delete from private.season_epoch`).rejects.toThrow('immutable season_epoch');
      await expect(sql`insert into private.season_epoch(epoch_slot) values(5)`).rejects.toThrow(/duplicate key/);
      const owner = await fighter({ schedule: TRAINING });
      const rollback = new Error('rollback-only');
      await expect(sql.begin(async tx => {
        // Rollback-only operator transaction: a database whose launch epoch was never set.
        await tx`alter table private.season_epoch disable trigger guard_frozen`;
        await tx`delete from private.season_epoch`;
        expect(await tx`select private.season_index(300) as season`).toEqual([{ season: null }]);
        const token = randomUUID();
        await tx`update private.coordinator set lease_token=${token},lease_until_ms=9007199254740991 where singleton`;
        expect((await tx`select public.advance_boundary(300,${token}) as r`)[0].r).toMatchObject({ phase: 4, wait: 'preparation' });
        const [job] = (await tx`select public.claim_jobs(${randomUUID()},'prepare',20) as jobs`)[0].jobs as JobLease[];
        expect((await tx`select public.complete_job(${job.id},${job.token},${tx.json(prepareActivityV1(job.snapshot as PreparationInput) as never)}) as r`)[0].r).toMatchObject({ ok: true });
        expect((await tx`select public.advance_boundary(300,${token}) as r`)[0].r).toMatchObject({ phase: 4, status: 'waiting', wait: 'epoch' });
        expect((await tx`select count(*)::int as n from private.arena_ratings`)[0].n).toBe(0);
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await sql`select epoch_slot::int as epoch from private.season_epoch`).toEqual([{ epoch: 0 }]);
      expect(await owner.row()).toMatchObject({ processed: 299 });
    });
  });

  describe('fenced per-league pairing job at phase 7', () => {
    it('waits for the pairing job, reaches operator after three failures, then adopts the resumed result', async () => {
      const a = await fighter(), b = await fighter();
      const token = await coordinatorLease();
      await toPairing(300, token);
      for (let attempt = 1; attempt <= 3; attempt++) {
        const [job] = await claim('pair');
        expect(job).toMatchObject({ kind: 'pair', gladiatorId: null, activityId: null, slotIndex: 300, attempt });
        expect(await rpc('fail_job', { job_id: job.id, lease_token: job.token, failure_code: 'execution-failed' }))
          .toMatchObject({ ok: true, status: attempt === 3 ? 'operator' : 'pending' });
      }
      expect(await advance(300, token)).toMatchObject({ phase: 7, status: 'waiting', wait: 'operator' });
      expect(await assignments()).toEqual([]);
      await sql`select private.resume_operator_job(id) from private.jobs where kind='pair'`;
      expect(await advance(300, token)).toMatchObject({ phase: 7, wait: 'pairing' });
      const [job] = await completePairings();
      expect(job.attempt).toBe(4);
      // Adopted. Since phase 2b Arena has its executor: phase 8 debits once and publishes both activities.
      expect(await advance(300, token)).toMatchObject({ phase: 9, status: 'complete' });
      const rows = await assignments();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'human', league: 'bronze', season: 0, slot: 300, pairing_job_id: job.id });
      expect(sidesOf(rows).sort()).toEqual([a.gid, b.gid].sort());
      for (const owner of [a, b]) expect(await owner.row()).toMatchObject({ stamina: 79, processed: 300 });
      expect(await sql`select count(*)::int as n from public.activities where status='active'`).toEqual([{ n: 2 }]);
      expect(await sql`select count(*)::int as n from private.jobs where kind='simulation'`).toEqual([{ n: 1 }]);
    });

    it('freezes one job per slot and league with its own seed, no gladiator, and the frozen entrants as input', async () => {
      const bronze = [await fighter(), await fighter()], silver = await fighter({ earned: 105 });
      const token = await coordinatorLease();
      await toPairing(300, token);
      const jobs = await sql`select dedupe_key, gladiator_id, activity_id, slot_index::int as slot, seed, input from private.jobs where kind='pair' order by dedupe_key`;
      expect(jobs.map(j => [j.dedupe_key, j.gladiator_id, j.activity_id, j.slot])).toEqual([['pair:300:bronze', null, null, 300], ['pair:300:silver', null, null, 300]]);
      const seeds = await sql`select seed from private.activity_snapshots`;
      for (const job of jobs) {
        expect(job.seed).toMatch(/^[0-9a-f]{64}$/);
        expect(seeds.map(s => s.seed)).not.toContain(job.seed);
      }
      const input = jobs[0].input as PairingInput;
      expect(input).toMatchObject({ slotIndex: 300, league: 'bronze', seasonId: '0', rulesVersion: 'v1', recent: [] });
      expect(input.entrants.map(e => e.gladiatorId).sort()).toEqual(bronze.map(f => f.gid).sort());
      for (const entrant of input.entrants) {
        const prepared = await preparation(300, entrant.gladiatorId);
        const [{ activity }] = await sql`select id as activity from public.activities where gladiator_id=${entrant.gladiatorId}`;
        expect(entrant).toEqual({ gladiatorId: entrant.gladiatorId, activityId: activity, seasonId: '0', league: 'bronze', slotIndex: 300, rating: 1000,
          fighter: prepared.arenaFighter });
      }
      expect((jobs[1].input as PairingInput).entrants.map(e => e.gladiatorId)).toEqual([silver.gid]);
      // Only pairing jobs may omit a gladiator, and a frozen job's identity stays immutable.
      await expect(sql`insert into private.jobs(kind,dedupe_key,slot_index,input,rules_version,due_at_ms) values('reveal','orphan',300,'{}','v1',0)`)
        .rejects.toThrow(/jobs_gladiator_check/);
      await expect(sql`update private.jobs set gladiator_id=${silver.gid} where dedupe_key='pair:300:silver'`).rejects.toThrow('immutable job');
      expect(await advance(300, token)).toMatchObject({ phase: 7, wait: 'pairing' });
      expect(await sql`select count(*)::int as n from private.jobs where kind='pair'`).toEqual([{ n: 2 }]);
    });

    it('rejects a pairing result that omits, duplicates or alters an entrant, fighter or NPC template', async () => {
      await fighter({ build: BUILDS.strong }); await fighter({ build: BUILDS.starter }); await fighter({ build: BUILDS.weak });
      const token = await coordinatorLease();
      await toPairing(300, token);
      const [job] = await claim('pair');
      const valid = pairResult(job);
      expect(valid.assignments.map(a => a.kind)).toEqual(['human', 'npc']);
      type Mutable = { assignments: Record<string, any>[] } & Record<string, unknown>;
      const variant = (change: (copy: Mutable) => void) => { const copy = structuredClone(valid) as unknown as Mutable; change(copy); return copy; };
      const human = 0, npc = 1;
      const duplicateNpc = (copy: Mutable) => {
        // A well-formed NPC bout for an entrant already in the human bout, dropping the real NPC entrant.
        const side = copy.assignments[human].sides[0];
        copy.assignments[npc] = { ...copy.assignments[npc], battleId: `arena:300:${side.gladiatorId}:npc`, sides: [side],
          opponent: { id: `npc:${side.gladiatorId}`, snapshot: makeFallback(side.fighter as FighterSnapshot) } };
      };
      const cases: [string, unknown][] = [
        ['not an object', []], ['no assignment array', { assignments: {} }], ['an extra result key', { ...valid, extra: true }],
        ['an omitted entrant', variant(c => { c.assignments.pop(); })],
        ['a duplicated assignment', variant(c => { c.assignments.push(c.assignments[human]); })],
        ['a duplicated entrant', variant(duplicateNpc)],
        ['an altered fighter', variant(c => { c.assignments[human].sides[0].fighter.maxHealth += 1; })],
        ['an extra fighter key', variant(c => { c.assignments[human].sides[1].fighter.seed = 'x'; })],
        ['an altered NPC template', variant(c => { c.assignments[npc].opponent.snapshot.baseDamage += 1; })],
        ['an altered NPC identity', variant(c => { c.assignments[npc].opponent.id = 'npc:someone'; })],
        ['an altered rating', variant(c => { c.assignments[human].sides[0].rating += 1; })],
        ['an altered strength', variant(c => { c.assignments[human].sides[1].strength += 0.01; })],
        ['an altered activity', variant(c => { c.assignments[npc].sides[0].activityId = randomUUID(); })],
        ['a foreign entrant', variant(c => { c.assignments[npc].sides[0].gladiatorId = randomUUID(); })],
        ['another league', variant(c => { c.assignments[human].league = 'silver'; })],
        ['another season', variant(c => { c.assignments[npc].seasonId = '1'; })],
        ['another slot', variant(c => { c.assignments[human].slotIndex = 301; })],
        ['an altered battle id', variant(c => { c.assignments[human].battleId = 'arena:300:forged'; })],
        ['a swapped kind', variant(c => { c.assignments[npc].kind = 'human'; })],
        ['an extra assignment key', variant(c => { c.assignments[human].winnerId = 'x'; })],
        ['an extra side key', variant(c => { c.assignments[npc].sides[0].seed = 'x'; })],
      ];
      for (const [name, result] of cases) {
        expect(await complete(job, result), name).toMatchObject({ ok: false, code: 'invalid' });
        expect(await assignments(), name).toEqual([]);
      }
      expect(await complete(job, valid)).toMatchObject({ ok: true });
      expect(await assignments()).toHaveLength(2);
    });

    it('writes immutable private assignments whose battle seed is stable across a retried pairing', async () => {
      const entrants = [await fighter({ build: BUILDS.strong }), await fighter({ build: BUILDS.starter }), await fighter({ build: BUILDS.weak })];
      const token = await coordinatorLease();
      await toPairing(300, token);
      const [first] = await claim('pair');
      // An injected failure while the assignment rows are written rolls the whole completion back.
      await sql.unsafe(`create function private.task16_crash() returns trigger language plpgsql set search_path='' as $$
        begin raise exception 'injected assignment crash'; end $$;
        create trigger task16_crash before insert on private.arena_assignment_sides for each row execute function private.task16_crash();`);
      try {
        await expect(complete(first, pairResult(first))).rejects.toThrow('injected assignment crash');
      } finally {
        await sql.unsafe('drop trigger task16_crash on private.arena_assignment_sides; drop function private.task16_crash();');
      }
      expect(await assignments()).toEqual([]);
      expect(await sql`select status, attempts::int from private.jobs where kind='pair'`).toEqual([{ status: 'leased', attempts: 1 }]);
      expect(await rpc('fail_job', { job_id: first.id, lease_token: first.token, failure_code: 'execution-failed' })).toMatchObject({ ok: true, status: 'pending' });
      const [retry] = await claim('pair');
      expect(retry).toMatchObject({ id: first.id, attempt: 2, seed: first.seed });
      expect(retry.snapshot).toEqual(first.snapshot);
      expect(pairResult(retry)).toEqual(pairResult(first));
      expect(await complete(retry, pairResult(retry))).toMatchObject({ ok: true });
      const rows = await assignments();
      expect(rows.map(r => r.kind).sort()).toEqual(['human', 'npc']);
      for (const row of rows) {
        expect(row.seed).toBe(createHash('sha256').update(`${first.seed}:${row.battle_id}`).digest('hex'));
        expect(row.assignment.battleId).toBe(row.battle_id);
      }
      expect(new Set(rows.map(r => r.seed)).size).toBe(2);
      const sides = await sql`select activity_id, battle_id, side::int from private.arena_assignment_sides order by battle_id, side`;
      expect(sides).toHaveLength(3);
      const activityIds = await sql`select id from public.activities where gladiator_id in ${sql(entrants.map(e => e.gid))}`;
      expect(sides.map(s => s.activity_id).sort()).toEqual(activityIds.map(a => a.id).sort());
      // A lost response replays without writing a second set; the committed rows never change.
      expect(await complete(retry, pairResult(retry))).toMatchObject({ ok: true, replayed: true });
      expect(await assignments()).toEqual(rows);
      await expect(sql`update private.arena_assignments set seed='forged'`).rejects.toThrow('immutable arena_assignments');
      await expect(sql`update private.arena_assignment_sides set side=0`).rejects.toThrow('immutable arena_assignment_sides');
    });
  });

  describe('pairing real boundary snapshots', () => {
    it('never pairs across leagues', async () => {
      const bronze = [await fighter(), await fighter()], silver = [await fighter({ earned: 105 }), await fighter({ earned: 110 })];
      const token = await coordinatorLease();
      await toPairing(300, token);
      expect((await completePairings()).length).toBe(2);
      expect(await advance(300, token)).toMatchObject({ phase: 9, status: 'complete' });
      const rows = await assignments();
      expect(rows.map(r => [r.kind, r.league])).toEqual(expect.arrayContaining([['human', 'bronze'], ['human', 'silver']]));
      for (const row of rows) {
        expect(row.assignment.league).toBe(row.league);
        const members = row.league === 'bronze' ? bronze : silver;
        expect(row.assignment.sides.map(s => s.gladiatorId).sort()).toEqual(members.map(f => f.gid).sort());
      }
    });

    it('pairs exactly twice the weaker strength and gives NPC bouts one hundredth above it', async () => {
      // Bronze: 708.37 against exactly 1416.74. Silver (105 earned): 708.37 against 1416.75.
      const weak = await fighter({ build: BUILDS.weak, earned: 20 }), double = await fighter({ build: BUILDS.double, earned: 20 });
      const weakSilver = await fighter({ build: BUILDS.weak, earned: 105 }), above = await fighter({ build: BUILDS.doublePlus, earned: 105 });
      const token = await coordinatorLease();
      await toPairing(300, token);
      expect([(await preparation(300, weak.gid)).arenaStrength, (await preparation(300, double.gid)).arenaStrength]).toEqual([708.37, 1416.74]);
      expect([(await preparation(300, weakSilver.gid)).arenaStrength, (await preparation(300, above.gid)).arenaStrength]).toEqual([708.37, 1416.75]);
      await completePairings();
      const rows = await assignments();
      expect(rows.filter(r => r.league === 'bronze').map(r => r.battle_id)).toEqual([`arena:300:${double.gid}:${weak.gid}`]);
      expect(rows.filter(r => r.league === 'silver').map(r => r.battle_id).sort()).toEqual([`arena:300:${above.gid}:npc`, `arena:300:${weakSilver.gid}:npc`].sort());
    });

    it('counts only human bouts of the preceding 18 slots when choosing between equally near opponents', async () => {
      const first = await fighter({ build: BUILDS.strong }), b = await fighter({ build: BUILDS.starter }), c = await fighter({ build: BUILDS.starter });
      // Prior human bouts: the first entrant met C once at S − 18 (counted) and B twice at S − 19 (outside the window).
      const prior = async (slot: number, opponent: Fighter, n: number) => {
        const [{ id }] = await sql`insert into private.jobs(kind,dedupe_key,slot_index,input,rules_version,due_at_ms,status)
          values('pair',${`pair:${slot}:history:${n}`},${slot},'{}','v1',0,'completed') returning id`;
        const battleId = `arena:${slot}:${first.gid}:${opponent.gid}:${n}`;
        await sql`insert into private.arena_assignments(battle_id,pairing_job_id,slot_index,league,season_index,kind,seed,assignment,created_at_ms)
          values(${battleId},${id},${slot},'bronze',0,'human','history',${sql.json({ kind: 'human', battleId, seasonId: '0', league: 'bronze', slotIndex: slot,
            sides: [{ gladiatorId: first.gid }, { gladiatorId: opponent.gid }] })},0)`;
      };
      await prior(282, c, 1); await prior(281, b, 2); await prior(281, b, 3);
      const token = await coordinatorLease();
      await toPairing(300, token);
      const [job] = await claim('pair');
      expect((job.snapshot as PairingInput).recent).toEqual([{ slotIndex: 282, gladiatorIds: [first.gid, c.gid] }]);
      expect(await complete(job, pairResult(job))).toMatchObject({ ok: true });
      const rows = (await assignments()).filter(r => r.slot === 300);
      expect(rows.map(r => r.battle_id).sort()).toEqual([`arena:300:${first.gid}:${b.gid}`, `arena:300:${c.gid}:npc`].sort());
    });

    it('gives the weakest entrant of an odd count its frozen NPC fallback bout', async () => {
      const strongest = await fighter({ build: BUILDS.double }), middle = await fighter({ build: BUILDS.strong }), weakest = await fighter({ build: BUILDS.starter });
      const token = await coordinatorLease();
      await toPairing(300, token);
      await completePairings();
      const rows = await assignments();
      expect(rows.map(r => r.battle_id).sort()).toEqual([`arena:300:${strongest.gid}:${middle.gid}`, `arena:300:${weakest.gid}:npc`].sort());
      const npc = rows.find(r => r.kind === 'npc')!.assignment;
      const prepared = await preparation(300, weakest.gid);
      expect(npc).toMatchObject({ opponent: { id: `npc:${weakest.gid}`, snapshot: prepared.npcTemplate }, sides: [{ strength: 931.75, fighter: prepared.arenaFighter }] });
      expect(prepared.npcTemplate).toEqual(makeFallback(prepared.arenaFighter));
    });

    it('creates no pairing job for no entrants and an NPC bout for a single entrant', async () => {
      await fighter({ schedule: TRAINING });
      expect(await rpcBoundary(300)).toMatchObject({ status: 'complete' });
      expect(await sql`select count(*)::int as n from private.jobs where kind='pair'`).toEqual([{ n: 0 }]);
      expect(await assignments()).toEqual([]);
      await resetWorld(299);
      const solo = await fighter();
      const token = await coordinatorLease();
      await toPairing(300, token);
      await completePairings();
      expect(await advance(300, token)).toMatchObject({ phase: 9, status: 'complete' });
      const rows = await assignments();
      expect(rows.map(r => [r.battle_id, r.kind])).toEqual([[`arena:300:${solo.gid}:npc`, 'npc']]);
    });

    it('times consecutive 50-entrant Arena boundaries at the one-minute cron cadence: steady-state publication within 120 s once the rolling dispatch window clears, within 180 s while it holds the previous tick, every bout before minute 60', async () => {
      // Three consecutive 50-entrant Arena slots P, P + 1 and P + 2 run end to end through the real scheduled tick and the
      // real private Edge worker reached through pg_net. P is a cold first boundary. P + 1 and P + 2 are steady state: the
      // previous slot's 50 settlements fall due at their cutoff and must finish before phase 1 continues, under the same
      // dispatch budget (at most five invocations per rolling minute) and batch limits as the boundary itself.
      const first = (await stableRealSlot(30_000)) + 1;
      await resetWorld(first - 1);
      const CLASSES = ['berserker', 'guardian', 'duelist'] as const;
      const owners: Fighter[] = [];
      for (let batch = 0; batch < 5; batch++) {
        owners.push(...await Promise.all(Array.from({ length: 10 }, (_, j) => {
          const i = batch * 10 + j;
          return fighter({ firstSlot: first, earned: i < 10 ? 105 : 40, build: { classId: CLASSES[i % 3],
            allocations: allocation(i % 7, (i * 3) % 5, (i * 2) % 4, i % 3, (i * 5) % 4) } });
        })));
      }
      const secret = process.env.LOCAL_WORKER_SECRET ?? '';
      expect(secret.length).toBeGreaterThanOrEqual(32);
      const clockQuery = `select pg_get_functiondef('private.planning_now_ms()'::regprocedure) as definition`;
      const [{ definition }] = await sql.unsafe(clockQuery);
      // Test-only stand-ins for the database clock, restored and verified below. Database time stays ahead of real time.
      const setClock = (body: string) => sql.unsafe(`create or replace function private.planning_now_ms() returns bigint language sql
        volatile security invoker set search_path='' as '${body}'`);
      type Report = { failed: number; conflicts: number; unrecorded: number; deferred?: number; byKind: Record<string, number> };
      type Tick = { atMs: number; dispatched: number; claimableSimple: number; claimableCombat: number; invocations: string[] };
      const reports: Report[] = [];
      /**
       * One scheduled tick at database time `at`. The clock stands still for cron_tick() itself, so its dispatch is sampled
       * exactly at `at`, then runs on in real time from `at` while the dispatched invocations work. The tick returns once
       * every invocation has answered, which the minute between real ticks always allows; no other wall-clock time is spent.
       */
      async function tick(at: number): Promise<Tick> {
        await setClock(`select ${at}::bigint`);
        // The function pg_cron runs every minute. The scheduler is enabled only inside this transaction, so the real pg_cron
        // run stays inert and never adds an uncontrolled tick.
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
        // Every invocation was the real private Edge worker and answered.
        expect(responses.map(r => r.status_code)).toEqual(ids.map(() => 200));
        const invocations = responses.map(r => JSON.parse(r.content!) as Report);
        reports.push(...invocations);
        return { atMs: at, dispatched: result.dispatch.dispatched, claimableSimple: result.dispatch.claimableSimple,
          claimableCombat: result.dispatch.claimableCombat,
          invocations: invocations.map(r => Object.entries(r.byKind).filter(([, n]) => n).map(([kind, n]) => `${kind} ${n}`).join(', ') || 'idle') };
      }
      /** Ticks one boundary from its cutoff every `spacing` ms until it is published and every bout is simulated. */
      async function boundary(slot: number, spacing: number) {
        const cutoff = slot * SLOT, ticks: Tick[] = [];
        for (let k = 0; k < 8; k++) {
          ticks.push(await tick(cutoff + k * spacing));
          const [state] = await sql`select (select phase::int from private.boundaries where slot_index=${slot}) as phase,
            (select count(*)::int from private.arena_assignments where slot_index=${slot}) as battles,
            (select count(*)::int from private.jobs where kind='simulation' and slot_index=${slot} and status='completed') as simulated`;
          if (state.phase === 9 && state.battles > 0 && state.simulated === state.battles) break;
        }
        const [t] = await sql`select
          (select max(completed_at_ms) from private.jobs where kind='settlement' and slot_index=${slot - 1})::float8 as settled,
          (select max(completed_at_ms) from private.jobs where kind='prepare' and slot_index=${slot})::float8 as prepared,
          (select max(completed_at_ms) from private.jobs where kind='pair' and slot_index=${slot})::float8 as paired,
          (select completed_at_ms from private.boundaries where slot_index=${slot})::float8 as published,
          (select max(completed_at_ms) from private.jobs where kind='simulation' and slot_index=${slot})::float8 as simulated,
          (select count(*)::int from private.arena_assignments where slot_index=${slot}) as battles,
          (select count(*)::int from private.jobs where kind='simulation' and slot_index=${slot} and status='completed') as simulations`;
        const since = (ms: number | null) => ms === null ? null : ms - cutoff;
        return { slot, spacingMs: spacing, battles: t.battles as number, simulations: t.simulations as number, settledMs: since(t.settled),
          preparedMs: since(t.prepared)!, pairedMs: since(t.paired)!, publishedMs: since(t.published)!, simulatedMs: since(t.simulated)!,
          ticks: ticks.map(x => ({ ...x, atMs: x.atMs - cutoff })) };
      }
      /** The minute-60 reveals of a slot, one scheduled tick a minute, long before the next cutoff. */
      async function reveals(slot: number) {
        for (let k = 0; k < 3; k++) {
          await tick(slot * SLOT + RULES_V1.arena.revealAfterMs + k * MINUTE);
          const [{ n }] = await sql`select count(*)::int as n from private.jobs where kind='reveal' and slot_index=${slot} and status<>'completed'`;
          if (n === 0) return;
        }
        throw new Error(`the minute-60 reveals of slot ${slot} did not complete`);
      }
      await sql`delete from vault.secrets where name in ('game_worker_url','game_worker_secret')`;
      const started = Date.now();
      let measured: Awaited<ReturnType<typeof boundary>>[] = [];
      try {
        await sql`select vault.create_secret('http://supabase_edge_runtime_Cloudiator:8081/game-worker','game_worker_url')`;
        await sql`select vault.create_secret(${secret},'game_worker_secret')`;
        // P: the cold first boundary (nothing to settle), then its minute-60 reveals.
        const cold = await boundary(first, MINUTE);
        await reveals(first);
        // P + 1: steady state, each tick exactly one minute after the previous one, so the rolling window has cleared.
        const cleared = await boundary(first + 1, MINUTE);
        await reveals(first + 1);
        // P + 2: steady state, each tick 1 ms less than a minute after the previous one, so the window still holds the
        // previous tick's invocations. Cron start and coordination jitter decide which of the two cases a real minute sees.
        const held = await boundary(first + 2, MINUTE - 1);
        measured = [cold, cleared, held];
      } finally {
        await sql`update private.scheduler set enabled=false where singleton`;
        await sql.unsafe(definition);
        await sql`delete from vault.secrets where name in ('game_worker_url','game_worker_secret')`;
      }
      expect((await sql.unsafe(clockQuery))[0].definition).toBe(definition);
      console.info(`Task 16 Arena boundaries at the one-minute cron cadence: ${JSON.stringify({ entrants: 50, targetMs: 120_000,
        revealMs: RULES_V1.arena.revealAfterMs, wallMs: Date.now() - started, boundaries: measured })}`);
      const [cold, cleared, held] = measured;
      for (const b of measured) {
        expect(b.simulations).toBe(b.battles);
        expect(b.preparedMs <= b.pairedMs && b.pairedMs <= b.publishedMs && b.publishedMs <= b.simulatedMs).toBe(true);
        // The bouts need only be simulated before the minute-60 reveal.
        expect(b.simulatedMs).toBeLessThan(RULES_V1.arena.revealAfterMs);
      }
      expect(cold.settledMs).toBeNull();
      expect(cold.publishedMs).toBeLessThan(120_000);
      for (const b of [cleared, held]) {
        // Steady state: the cutoff tick dispatches the previous slot's 50 settlements to three invocations, and they finish
        // before preparation (phase 4) can start.
        expect(b.ticks[0]).toMatchObject({ atMs: 0, dispatched: 3, claimableSimple: 50 });
        expect(b.settledMs).not.toBeNull();
        expect(b.settledMs!).toBeLessThanOrEqual(b.preparedMs);
      }
      // Spec §10.4: normal boundary processing (settling the previous slot through publication) within two minutes.
      expect(cleared.publishedMs).toBeLessThan(120_000);
      // While the window still holds the cutoff tick's three invocations, the next tick can dispatch only two, which run 40
      // of the 50 preparations, so publication waits for a third tick. (The cutoff tick's spare 10 slots cannot prepare:
      // preparation jobs exist only after the last settlement commits.)
      expect(held.ticks[1]).toMatchObject({ dispatched: 2 });
      expect(held.publishedMs).toBeLessThan(180_000);
      // Every job was run by the real worker, with no failure, conflict, unrecorded failure or deferral.
      expect(reports.reduce((sum, r) => sum + r.failed + r.conflicts + r.unrecorded + (r.deferred ?? 0), 0)).toBe(0);
      const total = (kind: string) => reports.reduce((sum, r) => sum + (r.byKind[kind] ?? 0), 0);
      expect([total('settlement'), total('prepare'), total('pair'), total('reveal'), total('simulation')])
        .toEqual([100, 150, 6, 100, cold.battles + cleared.battles + held.battles]);
      expect(await sql`select count(*)::int as n from public.activities where slot_index in ${sql([first, first + 1])} and status='completed'`)
        .toEqual([{ n: 100 }]);
      // The last slot: every entrant exactly once, within its league, exactly as canonical matchArena pairs the frozen input
      // (with the two earlier slots' human bouts as history).
      const target = first + 2;
      const jobs = await sql`select id, seed, input, status from private.jobs where kind='pair' and slot_index=${target} order by dedupe_key`;
      expect(jobs.map(j => j.status)).toEqual(['completed', 'completed']);
      const rows = (await assignments()).filter(r => r.slot === target);
      for (const job of jobs) {
        const input = job.input as PairingInput;
        expect(input.historyFromSlot).toBe(target - RULES_V1.matchmaking.recentPairingSlots);
        const expected = matchArena(input.entrants, input.recent, job.seed);
        expect(rows.filter(r => r.pairing_job_id === job.id).map(r => r.assignment)).toEqual(expect.arrayContaining(JSON.parse(JSON.stringify(expected))));
        expect(rows.filter(r => r.pairing_job_id === job.id)).toHaveLength(expected.length);
      }
      expect(sidesOf(rows).sort()).toEqual(owners.map(o => o.gid).sort());
      expect(await sql`select count(distinct s.activity_id)::int as n from private.arena_assignment_sides s
        join public.activities a on a.id=s.activity_id where a.slot_index=${target}`).toEqual([{ n: 50 }]);
      for (const row of rows.filter(r => r.kind === 'human')) {
        const [x, y] = row.assignment.sides.map(s => Math.round(s.strength * 100));
        expect(Math.max(x, y)).toBeLessThanOrEqual(2 * Math.min(x, y));
      }
      // One simulation per battle under its battle seed, anchored to its first side, its log frozen once.
      const simulations = await sql`select j.seed, j.activity_id, j.gladiator_id, x.battle_id, x.seed as battle_seed, x.assignment, r.log
        from private.jobs j join private.arena_assignments x on j.dedupe_key='arena:'||x.battle_id
        left join private.arena_results r on r.battle_id=x.battle_id where j.kind='simulation' and j.slot_index=${target}`;
      expect(simulations).toHaveLength(held.battles);
      for (const s of simulations) {
        expect(s.seed).toBe(s.battle_seed);
        expect([s.activity_id, s.gladiator_id]).toEqual([s.assignment.sides[0].activityId, s.assignment.sides[0].gladiatorId]);
        expect(s.log.battleId).toBe(s.battle_id);
      }
      // Every entrant was debited once and shows only its warm-up; reveals and settlements wait for minutes 60 and 80.
      expect(await sql`select count(*)::int as n from public.activities where slot_index=${target} and resolved_kind='arena'
        and status='active' and debited`).toEqual([{ n: 50 }]);
      expect(await sql`select s.ordinal::int, count(*)::int as n from public.activity_stages s join public.activities a on a.id=s.activity_id
        where a.slot_index=${target} group by s.ordinal`).toEqual([{ ordinal: 0, n: 50 }]);
      expect(await sql`select status, count(*)::int as n from private.jobs where kind in ('reveal','settlement') and slot_index=${target}
        group by status`).toEqual([{ status: 'pending', n: 100 }]);
      for (const owner of owners) expect(await owner.row()).toMatchObject({ processed: target });
    }, 600_000);
  });

  it('denies clients the assignments, battle seeds and results, rating rows, the epoch and the Arena internals', async () => {
    const owner = await fighter(), other = await fighter();
    await arenaSlot();
    const tables = ['arena_assignments', 'arena_assignment_sides', 'arena_ratings', 'arena_results', 'season_epoch'];
    expect(await sql`select c.relname, c.relrowsecurity as rls,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') as client
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in ${sql(tables)} order by c.relname`)
      .toEqual(tables.sort().map(relname => ({ relname, rls: true, client: false })));
    for (const client of [owner.client, other.client, anonymous]) {
      for (const table of tables) expect((await client.schema('private').from(table).select('*')).error, table).not.toBeNull();
    }
    // The public standings projection and its invoker view: visitors (Task 13.1) and signed-in players read, only the backend writes.
    expect(await sql`select c.relname, c.relrowsecurity as rls, c.reloptions, has_table_privilege('anon',c.oid,'SELECT') as anon,
      has_table_privilege('authenticated',c.oid,'SELECT') as player,
      has_table_privilege('anon',c.oid,'INSERT,UPDATE,DELETE') or has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE') as write
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('arena_standings','arena_standing_reads')
      order by c.relname`).toEqual([
      { relname: 'arena_standing_reads', rls: false, reloptions: ['security_invoker=true'], anon: true, player: true, write: false },
      { relname: 'arena_standings', rls: true, reloptions: null, anon: true, player: true, write: false }]);
    for (const client of [owner.client, other.client, anonymous]) {
      expect((await client.from('arena_standings').update({ rating: 5000 }).eq('gladiator_id', owner.gid)).error).not.toBeNull();
      expect((await client.from('arena_standings').insert({ gladiator_id: owner.gid, league: 'gold', season_index: 0, name: 'Forged',
        rating: 1, human_wins: 0, human_losses: 0 })).error).not.toBeNull();
      expect((await client.from('arena_standings').delete().eq('gladiator_id', owner.gid)).error).not.toBeNull();
    }
    expect((await anonymous.from('arena_standing_reads').select('*')).error).toBeNull();
    const names = ['season_index', 'league_rank', 'accept_pairing', 'boundary_pair', 'boundary_recompute_leagues', 'guard_league', 'guard_arena_rating',
      'pairing_input', 'accept_arena_result', 'arena_rewards', 'arena_settlement_failure', 'accept_job_result', 'prepare_activity_jobs',
      'settle_rewards', 'settle_activity_core', 'project_character', 'activity_executor_ready'];
    const functions = await sql`select p.oid::regprocedure::text as name, p.prosecdef,
      has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE') as client,
      has_function_privilege('service_role',p.oid,'EXECUTE') as backend
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in ${sql(names)}`;
    expect(functions).toHaveLength(names.length);
    for (const f of functions) expect(f, f.name).toMatchObject({ prosecdef: false, client: false, backend: true });
    for (const client of [owner.client, anonymous]) {
      expect((await client.rpc('settle_activity', { activity_id: await activityOf(owner.gid), lease_token: randomUUID() })).error).not.toBeNull();
    }
    // No seed, simulation input or private outcome reaches an owner, spectator or public read; only the public log does.
    const [row] = await assignments();
    const [simulation] = await sql`select seed from private.jobs where kind='simulation'`;
    const visible = JSON.stringify([await owner.state(), await readProfile(other.client, owner.gid), (await owner.client.from('activities').select('*')).data,
      (await other.client.from('world_actor_reads').select('*')).data, (await other.client.from('activity_stages').select('*')).data,
      (await other.client.from('recent_results').select('*')).data, await readStandings(other.client, 'bronze'),
      await readTimeline(other.client, await activityOf(owner.gid), { ownerSummary: true })]);
    for (const seed of [row.seed, simulation.seed]) expect(visible).not.toContain(seed);
    expect(visible).not.toMatch(/"seed"|npcTemplate|arenaFighter|ratingBefore|ratingAfter|"outcomes"|"names"|"assignment"/);
    // A spectator never reads another owner's credited summary.
    expect((await other.client.from('activities').select('summary').eq('id', await activityOf(owner.gid))).data).toEqual([]);
    expect((await other.client.from('public_profiles').update({ combat_strength: 1 }).eq('gladiator_id', owner.gid)).error).not.toBeNull();
  });

  describe('regular bouts, settlement one side at a time, public stages and standings (phase 2b)', () => {
    it('settleNpcWin credits an NPC win 3 renown and no rating change, with no XP, money or training point', async () => {
      const win = await settleNpcWin();
      expect(win).toMatchObject({ renown: 3, ratingDelta: 0 });
      const { solo, summary } = win;
      expect(summary).toMatchObject({ resolvedKind: 'arena', result: 'victory', success: true, ratingDelta: 0, replayExpiry: { state: 'expired' },
        rewards: { money: 0, renown: 3, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 } });
      // NPC bouts never change a rating or count as human bouts.
      expect(await solo.row()).toMatchObject({ league: 'bronze', rating: 1000, stamina: 79, processed: 300 });
      expect(await ratingRows(solo.gid)).toEqual([{ league: 'bronze', season: 0, rating: 1000, wins: 0, losses: 0 }]);
      expect(await walletOf(solo.gid)).toEqual({ money: 100, renown: 3 });
      expect(await ledgerOf(solo.gid)).toEqual([{ money: 0, renown: 3, reason: 'arena' }]);
      // The warm-up grants no training point, and no XP is credited.
      expect(await sql`select earned_points::int as earned, xp::int as xp from public.gladiators where id=${solo.gid}`).toEqual([{ earned: 10, xp: 0 }]);
      const stages = await stagesOf(await activityOf(solo.gid));
      expect(stages.map(s => [s.ordinal, s.stage.kind, s.stage.label])).toEqual([[0, 'staging', 'Warming up'], [1, 'bout', 'Bout: victory'],
        [2, 'return', 'Results credited']]);
      // The NPC is logged as npc:<entrant> with a null gladiatorId, from the frozen fallback template.
      const log = stages[1].stage.battleLog!;
      const [row] = await assignments();
      if (row.assignment.kind !== 'npc') throw new Error('expected an NPC bout');
      expect(log.participants.map(p => [p.id, p.gladiatorId])).toEqual([[solo.gid, solo.gid], [`npc:${solo.gid}`, null]]);
      expect(log.participants[1]).toMatchObject({ name: 'Bronze Sentinel', classId: null, stance: 'balanced',
        maxHealth: row.assignment.opponent.snapshot.maxHealth, armor: row.assignment.opponent.snapshot.armor });
      expect(log.winnerId).toBe(solo.gid);
    }, 120_000);

    it('reveals one shared log to both entrants of a human bout and credits exactly one win: 10 and 2 renown, Elo ±12', async () => {
      const a = await fighter(), b = await fighter(), spectator = await account();
      const S = 300 * SLOT;
      const token = await coordinatorLease();
      await toPublished(300, token);
      const [aid, bid] = [await activityOf(a.gid), await activityOf(b.gid)];
      const [row] = await assignments();
      expect(row.kind).toBe('human');
      // One simulation for the battle, anchored to its first side and carrying the battle seed; each activity's own
      // reveal and settlement keep the activity seed and depend on it.
      const graph = await sql`select j.kind, j.dedupe_key as key, j.activity_id, j.seed, j.due_at_ms::float8 as due,
        coalesce((select array_agg(p.kind::text order by p.kind) from private.job_dependencies d join private.jobs p on p.id=d.prerequisite_id
          where d.job_id=j.id),'{}') as needs
        from private.jobs j where j.kind in ('simulation','reveal','settlement') order by j.kind, j.activity_id`;
      const seeds = Object.fromEntries((await sql`select activity_id, seed from private.activity_snapshots`).map(r => [r.activity_id, r.seed]));
      const sideOf = (activity: string) => row.assignment.sides.findIndex(s => s.activityId === activity);
      expect(graph.filter(j => j.kind === 'simulation')).toEqual([{ kind: 'simulation', key: `arena:${row.battle_id}`,
        activity_id: row.assignment.sides[0].activityId, seed: row.seed, due: S, needs: [] }]);
      for (const activity of [aid, bid]) {
        expect(sideOf(activity)).toBeGreaterThanOrEqual(0);
        expect(graph.filter(j => j.activity_id === activity && j.kind !== 'simulation').map(j => [j.kind, j.key, j.seed, j.due, j.needs])).toEqual([
          ['reveal', `arena-reveal:${activity}`, seeds[activity], S + 60 * MINUTE, ['simulation']],
          ['settlement', `settlement:${activity}`, seeds[activity], S + 80 * MINUTE, ['reveal', 'simulation']]]);
      }
      const [simulated] = await simulateAll();
      expect(simulated).toMatchObject({ seed: row.seed, gladiatorId: row.assignment.sides[0].gladiatorId });
      // Simulated but not revealed: nothing a player can read names the opponent before minute 60.
      for (const [me, opponent, activity] of [[a, b, aid], [b, a, bid]] as const) {
        const seen = JSON.stringify([await me.state(), await readTimeline(me.client, activity, { ownerSummary: true }), await readTimeline(spectator.client, activity, { ownerSummary: true }),
          (await spectator.client.from('world_actor_reads').select('actor').eq('gladiator_id', me.gid)).data, await readProfile(spectator.client, me.gid)]);
        const [{ name }] = await sql`select name from public.gladiators where id=${opponent.gid}`;
        expect(seen).not.toContain(opponent.gid);
        expect(seen).not.toContain(name);
        expect((await readTimeline(me.client, activity, { ownerSummary: true })).stages.map(s => s.kind)).toEqual(['staging']);
      }
      await revealAll();
      const [aStages, bStages] = [await stagesOf(aid), await stagesOf(bid)];
      const log: BattleLog = aStages[1].stage.battleLog!;
      expect(bStages[1].stage.battleLog).toEqual(log);
      const [winner, loser] = log.winnerId === a.gid ? [a, b] : [b, a];
      // Each entrant finds itself by gladiatorId in the one shared log; its label is its own perspective.
      expect(log.participants.map(p => p.gladiatorId).sort()).toEqual([a.gid, b.gid].sort());
      expect((await stagesOf(await activityOf(winner.gid)))[1].stage.label).toBe('Bout: victory');
      expect((await stagesOf(await activityOf(loser.gid)))[1].stage.label).toBe('Bout: defeat');
      for (const stages of [aStages, bStages]) {
        expect(stages.map(s => [s.ordinal, s.reveal, s.stage.kind, s.stage.startedAtMs, s.stage.endsAtMs])).toEqual([
          [0, S, 'staging', S, S + 60 * MINUTE], [1, S + 60 * MINUTE, 'bout', S + 60 * MINUTE, S + 60 * MINUTE + log.durationMs]]);
      }
      // Minute 80, one side at a time: each settlement checks and moves only its own league-season row.
      const jobs = await claim('settlement');
      const first = jobs.find(j => j.activityId === aid)!, second = jobs.find(j => j.activityId === bid)!;
      expect(await settle(first)).toMatchObject({ ok: true, newGrants: 1 });
      expect(await ratingRows(a.gid)).toEqual([{ league: 'bronze', season: 0, rating: a === winner ? 1012 : 988, wins: a === winner ? 1 : 0, losses: a === winner ? 0 : 1 }]);
      expect(await ratingRows(b.gid)).toEqual([{ league: 'bronze', season: 0, rating: 1000, wins: 0, losses: 0 }]);
      // The second side settles after the first moved its row: it compares only its own frozen rating with its own row.
      expect(await settle(second)).toMatchObject({ ok: true, newGrants: 1 });
      expect(await ratingRows(winner.gid)).toEqual([{ league: 'bronze', season: 0, rating: 1012, wins: 1, losses: 0 }]);
      expect(await ratingRows(loser.gid)).toEqual([{ league: 'bronze', season: 0, rating: 988, wins: 0, losses: 1 }]);
      expect(await winner.row()).toMatchObject({ rating: 1012 });
      expect(await loser.row()).toMatchObject({ rating: 988 });
      const credited = (renown: number) => ({ money: 0, renown, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 });
      expect(await summaryOf(winner.gid)).toMatchObject({ resolvedKind: 'arena', result: 'victory', success: true, rewards: credited(10), ratingDelta: 12 });
      expect(await summaryOf(loser.gid)).toMatchObject({ resolvedKind: 'arena', result: 'defeat', success: false, rewards: credited(2), ratingDelta: -12 });
      expect([await summaryOf(a.gid), await summaryOf(b.gid)].filter(s => s.success)).toHaveLength(1);
      expect(await walletOf(winner.gid)).toEqual({ money: 100, renown: 10 });
      expect(await walletOf(loser.gid)).toEqual({ money: 100, renown: 2 });
      expect(await ledgerOf(winner.gid)).toEqual([{ money: 0, renown: 10, reason: 'arena' }]);
      // Owners read their credited summary; a spectator reads only the public completion and the public rating.
      const owned = await readTimeline(winner.client, await activityOf(winner.gid), { ownerSummary: true });
      expect(owned.stages.map(s => s.kind)).toEqual(['staging', 'bout', 'return']);
      expect(owned.stages[2]).toEqual({ id: `${await activityOf(winner.gid)}:2`, kind: 'return', revealedAtMs: S + 80 * MINUTE,
        startedAtMs: S + 80 * MINUTE, endsAtMs: S + 80 * MINUTE, label: 'Results credited' });
      expect(owned.summary).toMatchObject({ rewards: { renown: 10 }, ratingDelta: 12 });
      const watched = await readTimeline(spectator.client, await activityOf(loser.gid), { ownerSummary: true });
      expect(watched.summary).toBeUndefined();
      expect(watched.completion).toEqual({ activityId: await activityOf(loser.gid), resolvedKind: 'arena', result: 'defeat', success: false,
        settledAtMs: (await summaryOf(loser.gid)).settledAtMs, replayExpiry: { state: 'expired' } });
      expect(JSON.stringify(watched)).not.toMatch(/renown|ratingDelta|receiptId|"rewards"/);
      expect((await readProfile(spectator.client, winner.gid)).rating).toBe(1012);
      expect((await readProfile(spectator.client, loser.gid)).rating).toBe(988);
    });

    it('settles both sides concurrently under their own locks: simultaneous settlement retries grant exactly once each', async () => {
      const a = await fighter(), b = await fighter();
      await toPublished(300, await coordinatorLease());
      await simulateAll();
      await revealAll();
      const jobs = await claim('settlement');
      expect(jobs).toHaveLength(2);
      const attempts = [...jobs, ...jobs, ...jobs];
      const results = await Promise.all(attempts.map(settle));
      for (const job of jobs) {
        const mine = results.filter((_, i) => attempts[i] === job);
        expect(mine.every(r => r.ok)).toBe(true);
        expect(mine.reduce((sum, r) => sum + (r.newGrants ?? 0), 0)).toBe(1);
        expect(mine.filter(r => r.replayed)).toHaveLength(2);
      }
      const rows = [...await ratingRows(a.gid), ...await ratingRows(b.gid)];
      expect(rows.map(r => r.rating).sort((x, y) => x - y)).toEqual([988, 1012]);
      expect(rows.map(r => r.wins + r.losses)).toEqual([1, 1]);
      expect([(await walletOf(a.gid)).renown, (await walletOf(b.gid)).renown].sort((x, y) => x - y)).toEqual([2, 10]);
      expect(await sql`select count(*)::int as n from public.wallet_ledger where reason='arena'`).toEqual([{ n: 2 }]);
      expect(await sql`select count(*)::int as n from private.settled_slots`).toEqual([{ n: 2 }]);
      expect(await sql`select count(*)::int as n from public.activity_stages where ordinal=2`).toEqual([{ n: 2 }]);
      // A lost response retried later replays the committed receipt with no new grant.
      for (const job of jobs) expect(await settle(job)).toMatchObject({ ok: true, newGrants: 0, replayed: true });
    });

    it('fails a side closed to operator state when its frozen rating differs from its live row, leaving the other side to settle', async () => {
      const a = await fighter(), b = await fighter();
      const token = await coordinatorLease();
      await toPublished(300, token);
      await simulateAll();
      await revealAll();
      const [aid, bid] = [await activityOf(a.gid), await activityOf(b.gid)];
      // Trusted operator drift: A's live row no longer matches the rating frozen into its assignment.
      await sql`update private.arena_ratings set rating=1040 where gladiator_id=${a.gid}`;
      const jobs = await claim('settlement');
      const ja = jobs.find(j => j.activityId === aid)!, jb = jobs.find(j => j.activityId === bid)!;
      expect(await settle(ja)).toEqual({ ok: false, code: 'operator' });
      expect(await sql`select status, last_failure from private.jobs where id=${ja.id}`).toEqual([{ status: 'operator', last_failure: 'rating-mismatch' }]);
      expect(await sql`select outcome, failure_code from private.job_attempts where job_id=${ja.id}`).toEqual([{ outcome: 'failed', failure_code: 'rating-mismatch' }]);
      // Neither value was used: no grant, rating, counter, cache, return stage or permanent checkpoint for A.
      expect(await ratingRows(a.gid)).toEqual([{ league: 'bronze', season: 0, rating: 1040, wins: 0, losses: 0 }]);
      expect(await a.row()).toMatchObject({ rating: 1000 });
      expect(await walletOf(a.gid)).toEqual({ money: 100, renown: 0 });
      expect((await stagesOf(aid)).map(s => s.ordinal)).toEqual([0, 1]);
      expect(await sql`select status from public.activities where id=${aid}`).toEqual([{ status: 'active' }]);
      expect(await sql`select count(*)::int as n from private.settled_slots where activity_id=${aid}`).toEqual([{ n: 0 }]);
      // B compares only its own frozen rating with its own row, and settles.
      expect(await settle(jb)).toMatchObject({ ok: true, newGrants: 1 });
      // The next boundary waits truthfully for the operator.
      expect(await advance(301, token)).toMatchObject({ phase: 1, status: 'waiting', wait: 'operator' });
      // Once the operator restores the row, the same job resumes and settles from the frozen values.
      await sql`update private.arena_ratings set rating=1000 where gladiator_id=${a.gid}`;
      expect((await sql`select private.resume_operator_job(${ja.id}) as r`)[0].r).toEqual({ ok: true });
      const [retry] = await claim('settlement');
      expect(retry).toMatchObject({ id: ja.id, attempt: 2 });
      expect(await settle(retry)).toMatchObject({ ok: true, newGrants: 1 });
      const rows = [...await ratingRows(a.gid), ...await ratingRows(b.gid)];
      expect(rows.map(r => r.rating).sort((x, y) => x - y)).toEqual([988, 1012]);
    });

    it('rolls back every Arena settlement write when the settlement hook returns a malformed outcome', async () => {
      const a = await fighter(), b = await fighter();
      await toPublished(300, await coordinatorLease());
      await simulateAll();
      await revealAll();
      const definition = await definitionOf('private.settle_rewards(uuid)');
      // Test-only stand-in: apply the real Arena writes, then return a negative renown that the whitelist refuses.
      const malformed = { result: 'victory', success: true, ratingDelta: 12, replayExpiry: { state: 'expired' },
        rewards: { money: 0, renown: -3, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 } };
      await sql.unsafe(`create or replace function private.settle_rewards(activity uuid) returns jsonb language plpgsql security invoker
        set search_path='' as $hook$ begin perform private.arena_rewards(activity); return '${JSON.stringify(malformed)}'::jsonb; end $hook$`);
      try {
        const database = { ...worker, coordinate: async () => ({ ok: true, publishedSlot: 300 }) };
        expect(await runWorker({ database, workerId: randomUUID() })).toMatchObject({ failed: 2, completed: 0 });
        for (const f of [a, b]) {
          expect(await ratingRows(f.gid)).toEqual([{ league: 'bronze', season: 0, rating: 1000, wins: 0, losses: 0 }]);
          expect(await f.row()).toMatchObject({ rating: 1000 });
          expect(await walletOf(f.gid)).toEqual({ money: 100, renown: 0 });
          expect((await stagesOf(await activityOf(f.gid))).map(s => s.ordinal)).toEqual([0, 1]);
        }
        expect(await sql`select count(*)::int as n from private.settled_slots`).toEqual([{ n: 0 }]);
        expect(await sql`select count(*)::int as n from public.wallet_ledger where reason='arena'`).toEqual([{ n: 0 }]);
        expect(await sql`select status, last_failure from private.jobs where kind='settlement'`)
          .toEqual([{ status: 'pending', last_failure: 'execution-failed' }, { status: 'pending', last_failure: 'execution-failed' }]);
      } finally {
        await sql.unsafe(definition);
      }
      expect(await definitionOf('private.settle_rewards(uuid)')).toBe(definition);
      // Restored: the same jobs retry and credit each side once.
      expect([...(await settleAll()).values()].map(r => r.newGrants)).toEqual([1, 1]);
    });

    it('rejects a bout result that does not belong to its frozen assignment, writing nothing', async () => {
      // Three equal starters: one human bout and one NPC bout.
      await fighter(); await fighter(); await fighter();
      await toPublished(300, await coordinatorLease());
      const jobs = await claim('simulation', 5);
      expect(jobs.map(j => (j.snapshot as ArenaSimulationInput).assignment.kind).sort()).toEqual(['human', 'npc']);
      let accepted = 0;
      for (const job of jobs) {
        const valid = DEFAULT_EXECUTORS.v1.simulation!(job) as ArenaSimulationResult;
        const human = (job.snapshot as ArenaSimulationInput).assignment.kind === 'human';
        type Loose = Record<string, any>;
        const variant = (change: (copy: Loose) => void) => { const copy = structuredClone(valid) as Loose; change(copy); return copy; };
        const winner = (copy: Loose) => copy.outcomes.find((o: Loose) => o.result === 'victory') ?? copy.outcomes[0];
        const cases: [string, unknown][] = [
          ['not an object', []], ['an extra result key', { ...valid, seed: job.seed }], ['no outcomes', { battleId: valid.battleId, log: valid.log }],
          ['another battle', variant(c => { c.battleId = 'arena:300:forged'; })],
          ['a log of another battle', variant(c => { c.log.battleId = 'arena:300:forged'; })],
          ['another rules version', variant(c => { c.log.rulesVersion = 'v2'; })],
          ['a malformed log', variant(c => { delete c.log.events; })],
          ['swapped participants', variant(c => { c.log.participants.reverse(); })],
          ['an altered participant id', variant(c => { c.log.participants[1].id = 'npc:someone'; })],
          ['a relabelled gladiatorId', variant(c => { c.log.participants[1].gladiatorId = human ? null : c.log.participants[0].gladiatorId; })],
          ['an altered fighter', variant(c => { c.log.participants[0].maxHealth += 1; c.log.participants[0].initialHealth += 1; })],
          ['an injured start', variant(c => { c.log.participants[0].initialHealth -= 1; })],
          ['an altered armor', variant(c => { c.log.participants[1].armor += 1; })],
          ['altered silhouettes', variant(c => { c.log.participants[0].equipmentSilhouettes.reverse(); })],
          ['an altered name', variant(c => { c.log.participants[0].name = 'Impostor'; })],
          ['a winner outside the bout', variant(c => { c.log.winnerId = 'npc:elsewhere'; })],
          ['a winner its victory event contradicts', variant(c => { c.log.events.at(-1).winnerId = c.log.participants.find((p: Loose) => p.id !== c.log.winnerId).id; })],
          ['a missing outcome', variant(c => { c.outcomes.pop(); })],
          ['an extra outcome', variant(c => { c.outcomes.push(c.outcomes[0]); })],
          ['outcomes out of assignment order', variant(c => { c.outcomes.reverse(); if (!human) c.outcomes[0].activityId = randomUUID(); })],
          ['results against the logged winner', variant(c => { for (const o of c.outcomes) { o.result = o.success ? 'defeat' : 'victory'; o.success = !o.success; } })],
          ['money', variant(c => { c.outcomes[0].rewards.money = 5; })],
          ['XP', variant(c => { c.outcomes[0].rewards.xp = 1; })],
          ['an attribute point', variant(c => { c.outcomes[0].rewards.attributePoints = 1; })],
          ['an item', variant(c => { c.outcomes[0].rewards.items = [{ catalogId: 'salvage', catalogVersion: 'v1', tier: 1, rarity: 'common', quantity: 1 }]; })],
          ['negative renown', variant(c => { c.outcomes[0].rewards.renown = -1; })],
          ['fractional renown', variant(c => { c.outcomes[0].rewards.renown = 2.5; })],
          ['another frozen rating', variant(c => { c.outcomes[0].ratingBefore += 40; c.outcomes[0].ratingAfter += 40; })],
          ['an inconsistent delta', variant(c => { c.outcomes[0].ratingDelta += 1; })],
          [human ? 'a winner losing rating' : 'an NPC bout changing rating',
            variant(c => { const o = winner(c); o.ratingAfter = human ? o.ratingBefore - 5 : o.ratingBefore + 5; o.ratingDelta = o.ratingAfter - o.ratingBefore; })],
          ['an extra outcome key', variant(c => { c.outcomes[0].receiptId = randomUUID(); })],
          ['an extra reward key', variant(c => { c.outcomes[0].rewards.overflow = []; })],
        ];
        for (const [name, result] of cases) {
          expect(await complete(job, result), name).toMatchObject({ ok: false, code: 'invalid' });
          expect(await sql`select count(*)::int as n from private.arena_results`, name).toEqual([{ n: accepted }]);
        }
        expect(await complete(job, valid)).toMatchObject({ ok: true });
        accepted += 1;
        const [frozen] = await sql`select log, outcomes from private.arena_results where battle_id=${valid.battleId}`;
        expect(frozen).toEqual(JSON.parse(JSON.stringify({ log: valid.log, outcomes: valid.outcomes })));
        // A lost response replays without a second write, and the frozen bout never changes.
        expect(await complete(job, valid)).toMatchObject({ ok: true, replayed: true });
        await expect(sql`update private.arena_results set outcomes='[]' where battle_id=${valid.battleId}`).rejects.toThrow('immutable arena_results');
      }
    });

    it.each([['complete_job', 'job'], ['settle_activity', 'job'], ['settle_activity', 'rating']] as const)(
      '%s on an Arena job checks expiry after a proven wait for its %s row lock', async (name, held) => {
        const a = await fighter(), b = await fighter();
        await toPublished(300, await coordinatorLease());
        if (name === 'settle_activity') { await simulateAll(); await revealAll(); }
        const aid = await activityOf(a.gid);
        const [job] = name === 'complete_job' ? await claim('simulation') : (await claim('settlement')).filter(j => j.activityId === aid);
        const payload = name === 'complete_job' ? DEFAULT_EXECUTORS.v1.simulation!(job) : null;
        const [{ expiry }] = await sql`update private.jobs set lease_until_ms=private.planning_now_ms()+3000 where id=${job.id} returning lease_until_ms::text as expiry`;
        let locked!: () => void, release!: () => void;
        const ready = new Promise<void>(resolve => { locked = resolve; });
        const hold = new Promise<void>(resolve => { release = resolve; });
        const blocker = sql.begin(async tx => {
          if (held === 'job') await tx`select 1 from private.jobs where id=${job.id} for update`;
          else await tx`select 1 from private.arena_ratings where gladiator_id=${a.gid} for update`;
          locked(); await hold;
        });
        await ready;
        const contender = await sql.reserve();
        let response: PromiseLike<unknown> | undefined;
        try {
          const [{ pid }] = await contender`select pg_backend_pid() as pid`;
          response = (name === 'complete_job' ? contender`select public.complete_job(${job.id},${job.token},${contender.json(payload as never)}) as outcome`
            : contender`select public.settle_activity(${aid},${job.token}) as outcome`).execute();
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
          expect((await sql`select status, lease_until_ms::text as expiry from private.jobs where id=${job.id}`)[0]).toEqual({ status: 'leased', expiry });
          expect(await sql`select count(*)::int as n from private.arena_results`).toEqual([{ n: name === 'complete_job' ? 0 : 1 }]);
          expect(await sql`select count(*)::int as n from private.settled_slots`).toEqual([{ n: 0 }]);
          expect(await ratingRows(a.gid)).toEqual([{ league: 'bronze', season: 0, rating: 1000, wins: 0, losses: 0 }]);
          expect(await walletOf(a.gid)).toEqual({ money: 100, renown: 0 });
          expect(b.gid).not.toBe(a.gid);
        } finally { release(); await blocker; await response; contender.release(); }
      });

    it('takes every member’s account lock before phase 8 anchors a battle job to side 0, so an owner command holding side 0’s lock cannot deadlock it', async () => {
      // Two entrants; the higher gladiator id gets the stronger build, so matchArena puts it on side 0 and phase 8, which
      // walks members in gladiator order, reaches the lower-id side 1 first. Side 1's call creates the battle's job
      // anchored to side 0, whose foreign keys take KEY SHARE locks on side 0's gladiator and activity rows.
      const x = await fighter(), y = await fighter();
      const [low, high] = x.gid < y.gid ? [x, y] : [y, x];
      const allocations = BUILDS.strong.allocations, allocated = Object.values(allocations).reduce((sum, value) => sum + value, 0);
      await sql`update public.builds set current_build=jsonb_set(jsonb_set(current_build,'{allocations}',${sql.json(allocations)}),'{classId}',${sql.json(BUILDS.strong.classId)})
        where gladiator_id=${high.gid}`;
      await sql`update public.gladiators set earned_points=${allocated},unspent_points=0 where id=${high.gid}`;
      const token = await coordinatorLease();
      await toPairing(300, token);
      await completePairings();
      const [row] = await assignments();
      expect([row.kind, row.assignment.sides.map(s => s.gladiatorId)]).toEqual(['human', [high.gid, low.gid]]);
      // Session B is an owner command of side 0: it holds side 0's account lock, then asks for its gladiator row.
      let locked!: (pid: number) => void, release!: () => void;
      const ready = new Promise<number>(resolve => { locked = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      const command = sql.begin(async tx => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${high.id}::text,0))`;
        const [{ pid }] = await tx`select pg_backend_pid() as pid`;
        locked(pid); await hold;
        await tx`set local lock_timeout='3s'`;
        return (await tx`select id from public.gladiators where id=${high.gid} for update`).length;
      });
      const commandPid = await ready;
      const contender = await sql.reserve();
      let boundary: Promise<{ r: Record<string, unknown> }[]> | undefined;
      try {
        const [{ pid }] = await contender`select pg_backend_pid() as pid`;
        // Session A: the boundary's phase 8. It must wait for side 0's account lock, held by B.
        boundary = contender`select public.advance_boundary(300,${token}) as r`.execute() as unknown as Promise<{ r: Record<string, unknown> }[]>;
        // A failure is asserted below; this only keeps an early rejection from being reported as unhandled.
        boundary.catch(() => undefined);
        let waiting = false;
        for (let n = 0; n < 200 && !waiting; n++) {
          waiting = (await sql`select ${commandPid}::int = any(pg_blocking_pids(${pid})) as waiting`)[0].waiting;
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        // B now asks for side 0's gladiator row. It succeeds and commits, and A then completes: no 40P01 either side.
        release();
        expect(await command).toBe(1);
        expect((await boundary)[0].r).toMatchObject({ ok: true, phase: 9, status: 'complete' });
      } finally {
        release();
        await command.catch(() => undefined);
        await boundary?.catch(() => undefined);
        contender.release();
      }
      expect(await sql`select count(*)::int as n from private.jobs where dedupe_key=${`arena:${row.battle_id}`}`).toEqual([{ n: 1 }]);
      expect(await sql`select debited, status from public.activities where slot_index=300 order by gladiator_id`)
        .toEqual([{ debited: true, status: 'active' }, { debited: true, status: 'active' }]);
    });

    it('publishes each Arena stage only when it is due under database time, naming no opponent before minute 60', async () => {
      const a = await fighter(), b = await fighter();
      const S = 300 * SLOT, rollback = new Error('rollback-only');
      await expect(sql.begin(async tx => {
        // Rollback-only operator transaction: the database clock is set to chosen instants of slot 300.
        const clock = (ms: number) => tx.unsafe(`create or replace function private.planning_now_ms() returns bigint language sql volatile
          security invoker set search_path='' as 'select ${ms}::bigint'`);
        const claimTx = async (kind: string) => (await tx`select public.claim_jobs(${randomUUID()},${kind},20) as jobs`)[0].jobs as JobLease[];
        const completeTx = async (job: JobLease, result: unknown) =>
          (await tx`select public.complete_job(${job.id},${job.token},${tx.json(result as never)}) as r`)[0].r;
        const token = randomUUID();
        const advanceTx = async () => (await tx`select public.advance_boundary(300,${token}) as r`)[0].r;
        const visible = async (gid: string) => (await tx`select s.ordinal::int as ordinal, s.reveal_at_ms::float8 as reveal, s.stage
          from public.activity_stages s join public.activities x on x.id=s.activity_id where x.gladiator_id=${gid} order by s.ordinal`) as unknown as StageRow[];
        await clock(S + 1_000);
        await tx`update private.coordinator set lease_token=${token},lease_until_ms=9007199254740991 where singleton`;
        expect(await advanceTx()).toMatchObject({ phase: 4, wait: 'preparation' });
        for (const job of await claimTx('prepare')) expect(await completeTx(job, prepareActivityV1(job.snapshot as PreparationInput))).toMatchObject({ ok: true });
        expect(await advanceTx()).toMatchObject({ phase: 7, wait: 'pairing' });
        for (const job of await claimTx('pair')) expect(await completeTx(job, DEFAULT_EXECUTORS.v1.pair!(job))).toMatchObject({ ok: true });
        expect(await advanceTx()).toMatchObject({ phase: 9, status: 'complete' });
        const ids: Record<string, string> = Object.fromEntries((await tx`select gladiator_id, id from public.activities`).map(r => [r.gladiator_id, r.id]));
        // From minute 0: the warm-up only, revealed and started at S and ending at minute 60.
        for (const f of [a, b]) {
          expect(await visible(f.gid)).toEqual([{ ordinal: 0, reveal: S, stage: { id: `${ids[f.gid]}:0`, kind: 'staging', revealedAtMs: S, startedAtMs: S,
            endsAtMs: S + 60 * MINUTE, label: 'Warming up' } }]);
        }
        const [simulation] = await claimTx('simulation');
        expect(await completeTx(simulation, DEFAULT_EXECUTORS.v1.simulation!(simulation))).toMatchObject({ ok: true });
        // Minute 59: the bout exists privately, but no reveal or credit is due and nothing readable names the opponent.
        await clock(S + 60 * MINUTE - 1);
        expect(await claimTx('reveal')).toEqual([]);
        expect(await claimTx('settlement')).toEqual([]);
        for (const [me, other] of [[a, b], [b, a]] as const) {
          const [{ state }] = await tx`select state from public.owner_state where owner_id=${me.id}`;
          expect(JSON.stringify([await visible(me.gid), state])).not.toContain(other.gid);
        }
        // Minute 60: each entrant's bout stage.
        await clock(S + 60 * MINUTE);
        const reveals = await claimTx('reveal');
        expect(reveals).toHaveLength(2);
        for (const job of reveals) expect(await completeTx(job, {})).toMatchObject({ ok: true });
        for (const f of [a, b]) expect((await visible(f.gid)).map(s => [s.ordinal, s.reveal])).toEqual([[0, S], [1, S + 60 * MINUTE]]);
        // Minute 79: nothing is credited yet.
        await clock(S + 80 * MINUTE - 1);
        expect(await claimTx('settlement')).toEqual([]);
        // Minute 80: each side's settlement credits it and publishes its zero-length return stage in the same transaction.
        await clock(S + 80 * MINUTE);
        const settlements = await claimTx('settlement');
        expect(settlements).toHaveLength(2);
        for (const job of settlements) {
          expect((await tx`select public.settle_activity(${job.activityId},${job.token}) as r`)[0].r).toMatchObject({ ok: true, newGrants: 1,
            summary: { resolvedKind: 'arena', settledAtMs: S + 80 * MINUTE,
              replayExpiry: { state: 'available', expiresAtMs: S + 80 * MINUTE + RULES_V1.retention.replayMs } } });
        }
        for (const f of [a, b]) {
          const stages = await visible(f.gid);
          expect(stages.map(s => [s.ordinal, s.reveal])).toEqual([[0, S], [1, S + 60 * MINUTE], [2, S + 80 * MINUTE]]);
          expect(stages[2].stage).toEqual({ id: `${ids[f.gid]}:2`, kind: 'return', revealedAtMs: S + 80 * MINUTE, startedAtMs: S + 80 * MINUTE,
            endsAtMs: S + 80 * MINUTE, label: 'Results credited' });
        }
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await sql`select count(*)::int as n from public.activities`).toEqual([{ n: 0 }]);
    });

    it('promotes from points banked by real Training settlement only at the next boundary', async () => {
      // 2 × 1 + floor(104 / 5) + floor(28 / 10) = 24: Bronze, with 94 points banked. One Training point makes 25: Silver.
      const banker = await fighter({ schedule: TRAINING, earned: 104 });
      expect([leagueFor(1, 104, 28), leagueFor(1, 105, 28)]).toEqual(['bronze', 'silver']);
      expect(await rpcBoundary(300)).toMatchObject({ status: 'complete' });
      expect([...(await settleAll()).values()]).toMatchObject([{ ok: true, newGrants: 1 }]);
      // Settled: the point is earned and banked, but placement waits for the next boundary.
      expect(await sql`select earned_points::int as earned, unspent_points::int as banked, league from public.gladiators where id=${banker.gid}`)
        .toEqual([{ earned: 105, banked: 95, league: 'bronze' }]);
      expect(await ratingRows(banker.gid)).toEqual([{ league: 'bronze', season: 0, rating: 1000, wins: 0, losses: 0 }]);
      expect(await rpcBoundary(301)).toMatchObject({ status: 'complete' });
      expect((await preparation(301, banker.gid)).league).toBe('silver');
      expect(await banker.row()).toMatchObject({ league: 'silver', rating: 1000 });
      expect(await ratingRows(banker.gid)).toEqual([{ league: 'bronze', season: 0, rating: 1000, wins: 0, losses: 0 },
        { league: 'silver', season: 0, rating: 1000, wins: 0, losses: 0 }]);
    });

    it('promotes from real Task 8 acquisitions only at a boundary: sold, unequipped and bound renown gear count, and a respec never lowers it', async () => {
      const current = await stableRealSlot(120_000), next = current + 1;
      await resetWorld(current);
      // Level 10 and the ten starting points: 20 + 2 + floor(gear history / 10). The starter history 28 stays Bronze (24);
      // a best legal loadout of 30 or more is Silver (25).
      expect([leagueFor(10, 10, 28), leagueFor(10, 10, 30)]).toEqual(['bronze', 'silver']);
      const [seller, bound, control] = await Promise.all([1, 2, 3].map(() => fighter({ firstSlot: next, schedule: TRAINING, level: 10 })));
      // 2 + floor(105 / 5) + 2 = 25: Silver from earned points, 95 of them banked, whatever the allocation.
      const respec = await fighter({ firstSlot: next, schedule: TRAINING, earned: 105 });
      await sql`update public.wallets set renown=50 where gladiator_id=${bound.gid}`;
      type Bought = { ok: boolean; code?: string; value?: { itemIds: string[]; peakStrength: number; bound: boolean } };
      const buy = async (owner: Fighter, catalogId: string) => await commands.inventory({ userId: owner.id },
        { kind: 'buy-shop', operationId: randomUUID(), catalogId, catalogVersion: 'v1', quantity: 1 }) as Bought;
      const sell = (owner: Fighter, itemId: string) => commands.inventory({ userId: owner.id }, { kind: 'sell-item', operationId: randomUUID(), itemId, quantity: 1 });
      // Light boots, bought and never equipped, lift the best legal loadout to 24 + 4 + 2 = 30; selling them keeps it.
      const boots = await buy(seller, 'light-boots:1:common');
      expect(boots).toMatchObject({ ok: true, value: { peakStrength: 30 } });
      expect(await sell(seller, boots.value!.itemIds[0])).toMatchObject({ ok: true });
      // A bound renown sword scores its arena bonus, 4 × 6.6 + 4 = 30.4, and can never be sold.
      const sword = await buy(bound, 'sword:1:renown');
      expect(sword).toMatchObject({ ok: true, value: { peakStrength: 30.4, bound: true } });
      expect(await sell(bound, sword.value!.itemIds[0])).toMatchObject({ ok: false, code: 'invalid' });
      // A second common sword adds nothing to the best legal loadout: 24 + 4 = 28.
      expect(await buy(control, 'sword:1:common')).toMatchObject({ ok: true, value: { peakStrength: 28 } });
      // A paid respec lowers allocated points, never earned ones.
      const state = await respec.state();
      const lowered: Extract<GameCommand, { kind: 'queue-build' }> = { kind: 'queue-build', operationId: randomUUID(), expectedVersion: state.buildVersion,
        classId: state.currentBuild.classId, stance: state.currentBuild.stance, allocation: { ...state.currentBuild.allocations, strength: 0 },
        equipment: state.currentBuild.equipment };
      expect(await commands.plan({ userId: respec.id }, lowered)).toMatchObject({ ok: true, value: { reservedMoney: 100 } });
      const peaks = Object.fromEntries((await sql`select id, peak_strength::float8 as peak from public.gladiators`).map(r => [r.id, r.peak]));
      expect(peaks).toEqual({ [seller.gid]: 30, [bound.gid]: 30.4, [control.gid]: 28, [respec.gid]: 28 });
      // Promotion applies only at a boundary: every placement is still Bronze, whatever the history says now.
      for (const f of [seller, bound, control, respec]) expect(await f.row()).toMatchObject({ league: 'bronze' });
      // The next boundary, in a rollback-only operator transaction under database time just after its cutoff.
      const rollback = new Error('rollback-only');
      await expect(sql.begin(async tx => {
        await tx.unsafe(`create or replace function private.planning_now_ms() returns bigint language sql volatile security invoker
          set search_path='' as 'select ${next * SLOT + 1_000}::bigint'`);
        const token = randomUUID();
        await tx`update private.coordinator set lease_token=${token},lease_until_ms=9007199254740991 where singleton`;
        expect((await tx`select public.advance_boundary(${next},${token}) as r`)[0].r).toMatchObject({ phase: 4, wait: 'preparation' });
        const jobs = (await tx`select public.claim_jobs(${randomUUID()},'prepare',20) as jobs`)[0].jobs as JobLease[];
        expect(jobs).toHaveLength(4);
        for (const job of jobs) {
          expect((await tx`select public.complete_job(${job.id},${job.token},${tx.json(prepareActivityV1(job.snapshot as PreparationInput) as never)}) as r`)[0].r)
            .toMatchObject({ ok: true });
        }
        expect((await tx`select public.advance_boundary(${next},${token}) as r`)[0].r).toMatchObject({ phase: 9, status: 'complete' });
        const placed = Object.fromEntries((await tx`select g.id, g.league, j.result->>'league' as computed, g.earned_points::int as earned,
            (b.current_build->'allocations'->>'strength')::int as strength
          from public.gladiators g join public.builds b on b.gladiator_id=g.id join private.jobs j on j.dedupe_key=('prepare:'||${String(next)}||':'||g.id::text)`)
          .map(r => [r.id, [r.league, r.computed, r.earned, r.strength]]));
        expect(placed).toEqual({ [seller.gid]: ['silver', 'silver', 10, 2], [bound.gid]: ['silver', 'silver', 10, 2],
          [control.gid]: ['bronze', 'bronze', 10, 2], [respec.gid]: ['silver', 'silver', 105, 0] });
        throw rollback;
      })).rejects.toBe(rollback);
    }, 60_000);

    it('serves public, paginated standings of the latest season from the rating rows, with no wallet or loot', async () => {
      const bronze: Fighter[] = [];
      for (let batch = 0; batch < 4; batch++) bronze.push(...await Promise.all(Array.from({ length: 13 }, () => fighter({ schedule: TRAINING }))));
      // Trusted fixture rows: season 1 is the latest; the season 0 row is an older season that must not appear.
      const records = bronze.map((f, i) => ({ gid: f.gid, rating: 1000 + (i % 5) * 10, wins: i % 4, losses: i % 3 }));
      for (const r of records) {
        await sql`insert into private.arena_ratings(gladiator_id,league,season_index,rating,human_wins,human_losses)
          values(${r.gid},'bronze',1,${r.rating},${r.wins},${r.losses})`;
      }
      await sql`insert into private.arena_ratings(gladiator_id,league,season_index,rating) values(${bronze[0].gid},'bronze',0,1500)`;
      // One character moved up to Silver this season: its Bronze record stays listed, marked promoted.
      await sql`insert into private.arena_ratings(gladiator_id,league,season_index,rating,human_wins) values(${bronze[1].gid},'silver',1,1003,1)`;
      const expected = [...records].sort((p, q) => q.rating - p.rating || q.wins - p.wins || p.losses - q.losses || (p.gid < q.gid ? -1 : 1));
      const names: Record<string, string> = Object.fromEntries((await sql`select id, name from public.gladiators`).map(r => [r.id, r.name]));
      const spectator = await account();
      const first = await readStandings(spectator.client, 'bronze');
      expect(first).toMatchObject({ league: 'bronze', seasonId: '1', archived: false, nextCursor: '1:50' });
      expect(first.rows).toHaveLength(50);
      const second = await readStandings(spectator.client, 'bronze', first.nextCursor!);
      expect(second).toMatchObject({ league: 'bronze', seasonId: '1', archived: false, nextCursor: null });
      const rows: StandingRow[] = [...first.rows, ...second.rows];
      expect(rows).toEqual(expected.map((r, i): StandingRow => ({ rank: i + 1, gladiatorId: r.gid, name: names[r.gid], rating: r.rating,
        humanWins: r.wins, humanLosses: r.losses, promoted: r.gid === bronze[1].gid, inactive: r.wins + r.losses === 0,
        rewardEligible: r.wins + r.losses >= RULES_V1.seasons.minimumHumanBouts, awardPlace: null })));
      expect(rows.filter(r => r.rewardEligible).length).toBeGreaterThan(0);
      expect(rows.filter(r => r.inactive).length).toBeGreaterThan(0);
      expect(await readStandings(spectator.client, 'silver')).toEqual({ league: 'silver', seasonId: '1', archived: false, nextCursor: null,
        rows: [{ rank: 1, gladiatorId: bronze[1].gid, name: names[bronze[1].gid], rating: 1003, humanWins: 1, humanLosses: 0, promoted: false,
          inactive: false, rewardEligible: false, awardPlace: null }] });
      expect(await readStandings(spectator.client, 'champion')).toEqual({ league: 'champion', seasonId: '1', archived: false, rows: [], nextCursor: null });
      // Privacy: the read model has only public standing columns; no wallet, inventory, owner or loot.
      expect((await sql`select column_name from information_schema.columns where table_schema='public' and table_name='arena_standing_reads'
        order by ordinal_position`).map(c => c.column_name))
        .toEqual(['league', 'season_index', 'gladiator_id', 'name', 'rating', 'human_wins', 'human_losses', 'rank', 'promoted', 'reward_eligible']);
      expect(JSON.stringify((await spectator.client.from('arena_standing_reads').select('*')).data)).not.toMatch(/money|renown|inventory|owner|item/);
      // Visitors (Task 13.1) read the same standings as a signed-in spectator.
      for (const league of ['bronze', 'silver', 'champion'] as const) {
        expect(await readStandings(anonymous, league), league).toEqual(await readStandings(spectator.client, league));
      }
      // A malformed cursor is rejected before any query is sent.
      await expect(readStandings(spectator.client, 'bronze', '1:50,rating.lt.0')).rejects.toMatchObject({ code: 'unavailable' });
      // Task 10's projection hooks follow the private rows: a credited rating republishes the row and bumps the revision.
      const [{ revision }] = await sql`select revision::int from public.world_revision_state`;
      await sql`update private.arena_ratings set rating=2000 where gladiator_id=${bronze[5].gid} and league='bronze' and season_index=1`;
      expect((await readStandings(spectator.client, 'bronze')).rows[0]).toMatchObject({ rank: 1, gladiatorId: bronze[5].gid, rating: 2000 });
      expect((await sql`select revision::int from public.world_revision_state`)[0].revision).toBeGreaterThan(revision);
    }, 120_000);
  });
});

/** A whole boundary with canonical preparation and pairing, for slots whose activities need no Arena executor. */
async function rpcBoundary(target: number) {
  const token = await coordinatorLease();
  const first = await advance(target, token);
  if (first.status === 'complete') return first;
  await completePreparations();
  const second = await advance(target, token);
  if (second.wait !== 'pairing') return second;
  await completePairings();
  return advance(target, token);
}
