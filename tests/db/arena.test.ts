import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { sql, account, resetIdentity, admin, anonymous, creation } from '../fixtures/db.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { DEFAULT_EXECUTORS, prepareActivityV1 } from '../../supabase/functions/_shared/backend/jobs.ts';
import type { PairingInput, PairingResult } from '../../supabase/functions/_shared/backend/jobs.ts';
import { estimateArenaStrength, leagueFor, makeFallback, matchArena } from '../../supabase/functions/_shared/domain/arena.ts';
import { makeFighter } from '../../supabase/functions/_shared/domain/combat.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import type { Attributes, ClassId, FighterSnapshot, JobLease, PreparationInput, PreparationResult, Stance } from '../../supabase/functions/_shared/domain/types.ts';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';
import { readProfile } from '../../src/lib/api/reads.ts';

const SLOT = 4_800_000;
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
      // Adopted. Phase 2a stops before any bout: Arena still has no executor, so phase 8 stalls with no debit.
      expect(await advance(300, token)).toMatchObject({ phase: 8, status: 'waiting', wait: 'integration' });
      const rows = await assignments();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'human', league: 'bronze', season: 0, slot: 300, pairing_job_id: job.id });
      expect(sidesOf(rows).sort()).toEqual([a.gid, b.gid].sort());
      for (const owner of [a, b]) expect(await owner.row()).toMatchObject({ stamina: 104, processed: 299 });
      expect(await sql`select count(*)::int as n from public.activities where status<>'preparing'`).toEqual([{ n: 0 }]);
      expect(await sql`select count(*)::int as n from private.jobs where kind not in ('prepare','pair')`).toEqual([{ n: 0 }]);
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
      expect(await advance(300, token)).toMatchObject({ phase: 8, wait: 'integration' });
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
      expect(await advance(300, token)).toMatchObject({ phase: 8, wait: 'integration' });
      const rows = await assignments();
      expect(rows.map(r => [r.battle_id, r.kind])).toEqual([[`arena:300:${solo.gid}:npc`, 'npc']]);
    });

    it('pairs 50 real entrants within the boundary through real dispatch, inside the two-minute target', async () => {
      const current = await stableRealSlot(30_000);
      await resetWorld(current - 1);
      const CLASSES = ['berserker', 'guardian', 'duelist'] as const;
      const owners: Fighter[] = [];
      for (let batch = 0; batch < 5; batch++) {
        owners.push(...await Promise.all(Array.from({ length: 10 }, (_, j) => {
          const i = batch * 10 + j;
          return fighter({ firstSlot: current, earned: i < 10 ? 105 : 40, build: { classId: CLASSES[i % 3],
            allocations: allocation(i % 7, (i * 3) % 5, (i * 2) % 4, i % 3, (i * 5) % 4) } });
        })));
      }
      const token = await coordinatorLease();
      await toPairing(current, token);
      // Hand phase 7 to the real worker: the coordinator lease is released and dispatch reaches the private Edge function.
      await sql`update private.coordinator set lease_token=null,lease_until_ms=0 where singleton`;
      const secret = process.env.LOCAL_WORKER_SECRET ?? '';
      expect(secret.length).toBeGreaterThanOrEqual(32);
      await sql`delete from vault.secrets where name in ('game_worker_url','game_worker_secret')`;
      try {
        await sql`select vault.create_secret('http://supabase_edge_runtime_Cloudiator:8081/game-worker','game_worker_url')`;
        await sql`select vault.create_secret(${secret},'game_worker_secret')`;
        const started = Date.now();
        const [{ dispatch }] = await sql`select private.dispatch_workers() as dispatch`;
        expect(dispatch).toMatchObject({ ok: true, dispatched: 1, claimableSimple: 2 });
        let boundary: { phase: number; wait: string | null } | undefined;
        for (const deadline = Date.now() + 60_000; Date.now() < deadline && boundary?.phase !== 8;) {
          [boundary] = await sql`select phase::int, wait_reason as wait from private.boundaries where slot_index=${current}`;
          if (boundary?.phase !== 8) await new Promise(resolve => setTimeout(resolve, 100));
        }
        const wallMs = Date.now() - started;
        expect(boundary).toEqual({ phase: 8, wait: 'integration' });
        const [times] = await sql`select (select min(created_at_ms) from private.jobs where kind='pair')::float8 as inserted,
          (select max(dispatched_at_ms) from private.dispatch_log)::float8 as dispatched,
          (select min(a.claimed_at_ms) from private.job_attempts a join private.jobs j on j.id=a.job_id where j.kind='pair')::float8 as claimed,
          (select max(completed_at_ms) from private.jobs where kind='pair')::float8 as completed,
          (select updated_at_ms from private.boundaries where slot_index=${current})::float8 as adopted`;
        const measured = { entrants: 50, insertToAdoptMs: times.adopted - times.inserted, dispatchToAdoptMs: times.adopted - times.dispatched,
          claimToCompleteMs: times.completed - times.claimed, completeToAdoptMs: times.adopted - times.completed, wallFromDispatchMs: wallMs, targetMs: 120_000 };
        console.info(`Task 16 pairing round trip: ${JSON.stringify(measured)}`);
        expect(times.inserted <= times.dispatched && times.dispatched <= times.claimed && times.claimed <= times.completed && times.completed <= times.adopted).toBe(true);
        expect(measured.insertToAdoptMs).toBeLessThan(120_000);
        expect(wallMs).toBeLessThan(120_000);
        // The real private Edge worker, reached through pg_net, claimed and completed both pairing jobs.
        let response: { status_code: number | null; content: string | null } | undefined;
        for (const deadline = Date.now() + 20_000; Date.now() < deadline && !response?.status_code;) {
          [response] = await sql`select status_code, content from net._http_response where id=${dispatch.requestIds[0]}`;
          if (!response?.status_code) await new Promise(resolve => setTimeout(resolve, 100));
        }
        expect(response?.status_code).toBe(200);
        expect(JSON.parse(response!.content!)).toMatchObject({ byKind: { pair: 2 }, completed: 2, failed: 0 });
      } finally {
        await sql`delete from vault.secrets where name in ('game_worker_url','game_worker_secret')`;
      }
      // Every entrant exactly once, within its league, exactly as canonical matchArena pairs the frozen input.
      const jobs = await sql`select id, seed, input, status from private.jobs where kind='pair' order by dedupe_key`;
      expect(jobs.map(j => j.status)).toEqual(['completed', 'completed']);
      const rows = await assignments();
      for (const job of jobs) {
        const input = job.input as PairingInput;
        const expected = matchArena(input.entrants, input.recent, job.seed);
        expect(rows.filter(r => r.pairing_job_id === job.id).map(r => r.assignment)).toEqual(expect.arrayContaining(JSON.parse(JSON.stringify(expected))));
        expect(rows.filter(r => r.pairing_job_id === job.id)).toHaveLength(expected.length);
      }
      expect(sidesOf(rows).sort()).toEqual(owners.map(o => o.gid).sort());
      expect(await sql`select count(distinct activity_id)::int as n from private.arena_assignment_sides`).toEqual([{ n: 50 }]);
      for (const row of rows.filter(r => r.kind === 'human')) {
        const [x, y] = row.assignment.sides.map(s => Math.round(s.strength * 100));
        expect(Math.max(x, y)).toBeLessThanOrEqual(2 * Math.min(x, y));
      }
      for (const owner of owners) expect(await owner.row()).toMatchObject({ processed: current - 1 });
    }, 300_000);
  });

  it('denies clients assignments, battle seeds, rating rows, the season epoch and the pairing internals', async () => {
    const owner = await fighter(), other = await fighter();
    const token = await coordinatorLease();
    await toPairing(300, token);
    await completePairings();
    expect(await advance(300, token)).toMatchObject({ phase: 8 });
    const tables = ['arena_assignments', 'arena_assignment_sides', 'arena_ratings', 'season_epoch'];
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
      where n.nspname='private' and p.proname in ('season_index','league_rank','accept_pairing','boundary_pair','boundary_recompute_leagues','guard_league','guard_arena_rating')`;
    expect(functions).toHaveLength(7);
    for (const f of functions) expect(f, f.name).toMatchObject({ prosecdef: false, client: false, backend: true });
    // No seed or private assignment reaches an owner, spectator or public projection.
    const [row] = await assignments();
    const visible = JSON.stringify([await owner.state(), await readProfile(other.client, owner.gid),
      (await owner.client.from('activities').select('*')).data, (await other.client.from('world_actor_reads').select('*')).data]);
    expect(visible).not.toContain(row.seed);
    expect(visible).not.toMatch(/"seed"|battleId|npcTemplate|arenaFighter/);
    expect((await other.client.from('public_profiles').update({ combat_strength: 1 }).eq('gladiator_id', owner.gid)).error).not.toBeNull();
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
