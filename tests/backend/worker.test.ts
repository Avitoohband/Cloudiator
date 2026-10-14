import { describe, expect, it } from 'vitest';
import { DEFAULT_EXECUTORS, handleWorker, prepareActivityV1, runWorker, WORKER_LIMITS } from '../../supabase/functions/_shared/backend/jobs.ts';
import type { ArenaSimulationInput, ArenaSimulationResult, PairingInput } from '../../supabase/functions/_shared/backend/jobs.ts';
import type { ExecutorRegistry, JobOutcome, WorkerDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import type { ActivitySnapshot, Attributes, JobKind, JobLease, PreparationInput } from '../../supabase/functions/_shared/domain/types.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { makeFighter, simulateBattle } from '../../supabase/functions/_shared/domain/combat.ts';
import { planExpedition } from '../../supabase/functions/_shared/domain/expedition.ts';
import { arenaNpcName, arenaOutcomes, estimateArenaStrength, makeFallback, matchArena } from '../../supabase/functions/_shared/domain/arena.ts';
import type { ArenaAssignment } from '../../supabase/functions/_shared/domain/arena.ts';
import { itemFixture } from '../fixtures/domain.ts';

const SECRET = 'unit-worker-secret-0123456789abcdef0123456789';
const gid = '0d5f8471-d919-428f-9ab7-058c95821757';
function preparation(overrides: Partial<PreparationInput> = {}): PreparationInput {
  return { gladiatorId: gid, slotIndex: 300, rulesVersion: 'v1', level: 1, earnedPoints: 10, items: [],
    build: { version: 1, classId: 'berserker', stance: 'balanced', allocations: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 },
      equipment: { weapon: null, offHand: null, head: null, body: null, feet: null } }, ...overrides } as PreparationInput;
}
let sequence = 0;
function lease(kind: JobKind, overrides: Partial<JobLease> = {}): JobLease {
  sequence += 1;
  return { id: `job-${sequence}`, token: `token-${sequence}`, expiresAtMs: Date.now() + WORKER_LIMITS.leaseMs, kind,
    activityId: kind === 'settlement' ? `activity-${sequence}` : null, gladiatorId: gid, slotIndex: 300,
    snapshot: kind === 'prepare' ? preparation() : {}, seed: `seed-${sequence}`, rulesVersion: 'v1', attempt: 1, ...overrides } as JobLease;
}
/** In-memory port recording calls; the SQL fencing itself is exercised by tests/db/activities.test.ts. */
function port(queues: Partial<Record<JobKind, JobLease[]>>, outcome: (call: string) => JobOutcome = () => ({ ok: true })) {
  const calls: { name: string; args: unknown[] }[] = [];
  const database: WorkerDatabase = {
    coordinate: async () => { calls.push({ name: 'coordinate', args: [] }); return { ok: true, publishedSlot: 300 }; },
    claim: async (worker, kind, limit) => { calls.push({ name: 'claim', args: [worker, kind, limit] }); return (queues[kind] ?? []).splice(0, limit); },
    renew: async (id, token) => { calls.push({ name: 'renew', args: [id, token] }); return { ok: true, expiresAtMs: Date.now() + WORKER_LIMITS.leaseMs }; },
    complete: async (id, token, result) => { calls.push({ name: 'complete', args: [id, token, result] }); return outcome('complete'); },
    settle: async (id, token) => { calls.push({ name: 'settle', args: [id, token] }); return outcome('settle'); },
    fail: async (id, token, code) => { calls.push({ name: 'fail', args: [id, token, code] }); return { ok: true }; },
  };
  return { database, calls };
}
const post = (authorization?: string, method = 'POST') => new Request('http://local/game-worker', {
  method, headers: authorization === undefined ? {} : { Authorization: authorization } });

describe('canonical v1 activity preparation', () => {
  it('derives versioned stamina costs and the training reward without a second stats engine', () => {
    const result = prepareActivityV1(preparation());
    expect(result).toMatchObject({ rulesVersion: 'v1', staminaMaximum: 100, trainingPoints: 1,
      costs: { training: 20, rest: 0, expedition: 30, arena: 25, tournament: 25 } });
    expect(result.derived.maxStamina).toBe(100);
    expect(result.snapshot.rulesVersion).toBe('v1');
  });
  it('charges overloaded Training through the canonical activity cost formula', () => {
    const heavy = { ...itemFixture(CATALOG_V1.items['heavy-armor:1:common']), id: '7f6c3cf0-4f43-4d7c-9df6-0a0c3a4a8b11', ownerId: gid,
      reservation: { kind: 'equipment' as const, referenceId: gid } };
    const helmet = { ...itemFixture(CATALOG_V1.items['iron-helmet:1:common']), id: '7f6c3cf0-4f43-4d7c-9df6-0a0c3a4a8b12', ownerId: gid,
      reservation: { kind: 'equipment' as const, referenceId: gid } };
    const input = preparation({ items: [heavy, helmet], build: { ...preparation().build, equipment: { weapon: null, offHand: null, head: helmet.id, body: heavy.id, feet: null } } });
    // Endurance 5 gives capacity 20; 14 load is not overloaded, so add a second heavy item through the boots slot.
    const boots = { ...itemFixture(CATALOG_V1.items['heavy-boots:1:common']), id: '7f6c3cf0-4f43-4d7c-9df6-0a0c3a4a8b13', ownerId: gid,
      reservation: { kind: 'equipment' as const, referenceId: gid } };
    const shield = { ...itemFixture(CATALOG_V1.items['round-shield:1:common']), id: '7f6c3cf0-4f43-4d7c-9df6-0a0c3a4a8b14', ownerId: gid,
      reservation: { kind: 'equipment' as const, referenceId: gid } };
    const overloaded = prepareActivityV1({ ...input, items: [heavy, helmet, boots, shield],
      build: { ...input.build, equipment: { ...input.build.equipment, feet: boots.id, offHand: shield.id } } });
    // Load 23 against capacity 20: overload 0.15, ceil(20 × 1.15) = 23.
    expect(overloaded.derived.overload).toBeCloseTo(0.15, 10);
    expect(overloaded.costs).toMatchObject({ training: 23, rest: 0, expedition: 35, arena: 29 });
  });
  it('fails closed with a sanitized code when the build is no longer legal', () => {
    expect(() => prepareActivityV1(preparation({ earnedPoints: 10, build: { ...preparation().build, allocations: { strength: 11, agility: 0, vitality: 0, endurance: 0, precision: 0 } } })))
      .toThrow(expect.objectContaining({ code: 'invalid-build' }));
    expect(() => prepareActivityV1(preparation({ rulesVersion: 'v2' }))).toThrow(expect.objectContaining({ code: 'unsupported-rules' }));
  });
  it('freezes the arena fighter, its NPC template, the visible strength and the league from the canonical domain', () => {
    const result = prepareActivityV1(preparation({ peakStrength: 28 }));
    const fighter = makeFighter(result.snapshot, 'arena', RULES_V1);
    expect(result.arenaFighter).toEqual(fighter);
    expect(result.npcTemplate).toEqual(makeFallback(fighter));
    expect(result.arenaStrength).toBe(estimateArenaStrength(fighter));
    // Unarmed berserker: 100 HP × 2.75 × .71 hit × 1.0325 critical × 1000 / 952 ms = 211.759…
    expect(result.arenaStrength).toBe(211.76);
    expect(result.league).toBe('bronze');
  });
  it('places banked earned points and historical gear, never the current loadout', () => {
    // 2 × 1 + floor(105 / 5) + floor(28 / 10) = 25: Silver with every extra point still banked.
    expect(prepareActivityV1(preparation({ earnedPoints: 105, peakStrength: 28 })).league).toBe('silver');
    // An unarmed current build keeps the Gold placement of its 560 history: 2 + 2 + 56 = 60.
    const weak = prepareActivityV1(preparation({ peakStrength: 560 }));
    expect(weak.league).toBe('gold');
    expect(weak.arenaStrength).toBe(211.76);
  });
});

describe('regular Arena pairing executor', () => {
  const fighterFor = (allocations: Attributes) => prepareActivityV1(preparation({ earnedPoints: 40,
    build: { ...preparation().build, allocations } })).arenaFighter;
  const entrant = (id: string, allocations: Attributes, rating = 1000) => ({ gladiatorId: id, activityId: `activity-${id}`, seasonId: '0',
    league: 'bronze' as const, slotIndex: 300, rating, fighter: fighterFor(allocations) });
  const input = (): PairingInput => ({ slotIndex: 300, league: 'bronze', seasonId: '0', rulesVersion: 'v1', historyFromSlot: 282, entrants: [
    entrant('a', { strength: 6, agility: 2, vitality: 4, endurance: 0, precision: 2 }),
    entrant('b', { strength: 4, agility: 2, vitality: 2, endurance: 0, precision: 2 }, 1040),
    entrant('c', { strength: 2, agility: 2, vitality: 2, endurance: 0, precision: 2 })],
    recent: [{ slotIndex: 299, gladiatorIds: ['a', 'b'] }] });
  it('pairs one league’s frozen entrants with matchArena under the job’s own private seed', () => {
    const job = lease('pair', { snapshot: input(), seed: 'pair-seed', gladiatorId: null });
    const result = DEFAULT_EXECUTORS.v1.pair!(job);
    expect(result).toEqual({ assignments: matchArena(input().entrants, input().recent, 'pair-seed') });
    expect((result as { assignments: unknown[] }).assignments).toHaveLength(2);
  });
  it('fails a malformed, mixed or unknown-rules pairing input closed with sanitized codes', () => {
    const run = (snapshot: unknown) => () => DEFAULT_EXECUTORS.v1.pair!(lease('pair', { snapshot: snapshot as PairingInput, gladiatorId: null }));
    const valid = input();
    expect(run({ ...valid, entrants: null })).toThrow(expect.objectContaining({ code: 'invalid-input' }));
    expect(run({ ...valid, recent: undefined })).toThrow(expect.objectContaining({ code: 'invalid-input' }));
    expect(run({ ...valid, entrants: [{ ...valid.entrants[0], league: 'silver' }, ...valid.entrants.slice(1)] })).toThrow(expect.objectContaining({ code: 'invalid-input' }));
    expect(run({ ...valid, entrants: [{ ...valid.entrants[0], slotIndex: 301 }] })).toThrow(expect.objectContaining({ code: 'invalid-input' }));
    expect(run({ ...valid, entrants: [{ ...valid.entrants[0], seasonId: '1' }] })).toThrow(expect.objectContaining({ code: 'invalid-input' }));
    expect(run({ ...valid, rulesVersion: 'v2' })).toThrow(expect.objectContaining({ code: 'unsupported-rules' }));
  });
  it('fails closed when SQL passed a history window narrower than the versioned rules window', () => {
    const run = (snapshot: unknown) => () => DEFAULT_EXECUTORS.v1.pair!(lease('pair', { snapshot: snapshot as PairingInput, gladiatorId: null }));
    const invalid = expect.objectContaining({ code: 'invalid-input' });
    // v1 counts slots S − 18 … S − 1, so the bound SQL used must reach back at least to S − 18.
    expect(run({ ...input(), historyFromSlot: 283 })).toThrow(invalid);
    expect(run({ ...input(), historyFromSlot: undefined })).toThrow(invalid);
    expect(run({ ...input(), historyFromSlot: 282.5 })).toThrow(invalid);
    expect(run({ ...input(), historyFromSlot: 282 })).not.toThrow();
    expect(run({ ...input(), historyFromSlot: 200 })).not.toThrow();
  });
});

describe('regular Arena simulation executor', () => {
  const SLOT_MS = RULES_V1.clock.slotMs;
  const zero: Attributes = { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 };
  const fighter = prepareActivityV1(preparation({ earnedPoints: 40, build: { ...preparation().build, allocations: { ...zero, strength: 6, vitality: 4, precision: 2 } } })).arenaFighter;
  const entrant = (id: string) => ({ gladiatorId: id, activityId: `activity-${id}`, seasonId: '0', league: 'bronze' as const, slotIndex: 300, rating: 1000, fighter });
  const [human] = matchArena([entrant('a'), entrant('b')], [], 'pair-seed');
  const [npc] = matchArena([entrant('solo')], [], 'pair-seed');
  const input = (assignment: ArenaAssignment, overrides: Record<string, unknown> = {}): ArenaSimulationInput => ({ kind: 'arena', battleId: assignment.battleId,
    slotIndex: 300, rulesVersion: 'v1', startsAtMs: 300 * SLOT_MS, revealAtMs: 300 * SLOT_MS + RULES_V1.arena.revealAfterMs, assignment,
    names: assignment.sides.map(side => `Name ${side.gladiatorId}`), ...overrides }) as ArenaSimulationInput;
  const run = (snapshot: unknown, seed = 'battle-seed') =>
    DEFAULT_EXECUTORS.v1.simulation!(lease('simulation', { snapshot: snapshot as ArenaSimulationInput, seed })) as ArenaSimulationResult;

  it('runs one simulateBattle from the frozen fighters and returns the log with both sides’ outcomes', () => {
    expect(human.kind).toBe('human');
    const result = run(input(human));
    const log = simulateBattle({ battleId: human.battleId, rulesVersion: 'v1', rules: RULES_V1, fighters: human.sides.map(side =>
      ({ id: side.gladiatorId, gladiatorId: side.gladiatorId, name: `Name ${side.gladiatorId}`, snapshot: side.fighter })) as never }, 'battle-seed');
    expect(result).toEqual({ battleId: human.battleId, log, outcomes: arenaOutcomes(human, log) });
    // A human participant is logged with its own gladiatorId, in assignment order, and exactly one side wins.
    expect(log.participants.map(p => [p.id, p.gladiatorId])).toEqual(human.sides.map(side => [side.gladiatorId, side.gladiatorId]));
    expect(result.outcomes.filter(o => o.result === 'victory')).toHaveLength(1);
    expect(run(input(human))).toEqual(result);
  });

  it('logs the NPC fallback as npc:<entrant> with a null gladiatorId and its frozen template', () => {
    expect(npc.kind).toBe('npc');
    const result = run(input(npc));
    const [entrantLog, npcLog] = result.log.participants;
    expect(entrantLog).toMatchObject({ id: 'solo', gladiatorId: 'solo', name: 'Name solo', maxHealth: fighter.maxHealth });
    if (npc.kind !== 'npc') throw new Error('expected an NPC assignment');
    expect(npcLog).toMatchObject({ id: 'npc:solo', gladiatorId: null, name: arenaNpcName('bronze'), classId: null, stance: 'balanced',
      maxHealth: npc.opponent.snapshot.maxHealth, attackIntervalMs: npc.opponent.snapshot.attackIntervalMs });
    expect(result.outcomes).toEqual(arenaOutcomes(npc, result.log));
    expect(result.outcomes[0]).toMatchObject({ ratingDelta: 0, ratingAfter: 1000,
      rewards: { renown: result.log.winnerId === 'solo' ? 3 : 0, money: 0, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 } });
    expect(['Bronze Sentinel', 'Silver Sentinel', 'Gold Sentinel', 'Champion Sentinel'])
      .toEqual((['bronze', 'silver', 'gold', 'champion'] as const).map(arenaNpcName));
  });

  it('simulates the frozen fighter exactly as stored, never a recomputation from a build', () => {
    // A fighter read back from JSONB keeps its own silhouette order; the bout must carry that order unchanged.
    const frozen = structuredClone(human) as unknown as { sides: { fighter: { equipmentSilhouettes: string[] } }[] };
    frozen.sides[0].fighter.equipmentSilhouettes = ['light-armor:1:common', 'sword:1:common'];
    expect(run(input(frozen as unknown as ArenaAssignment)).log.participants[0].equipmentSilhouettes).toEqual(['light-armor:1:common', 'sword:1:common']);
  });

  it('fails a malformed, mismatched or unknown-rules Arena input closed with sanitized codes', () => {
    const invalid = expect.objectContaining({ code: 'invalid-input' });
    expect(() => run(input(human, { battleId: 'arena:300:forged' }))).toThrow(invalid);
    expect(() => run(input(human, { slotIndex: 301 }))).toThrow(invalid);
    expect(() => run(input(human, { names: ['Only one'] }))).toThrow(invalid);
    expect(() => run(input(human, { names: ['', 'Name b'] }))).toThrow(invalid);
    // SQL restates the minute-60 reveal; the versioned executor checks it against its own rules.
    expect(() => run(input(human, { revealAtMs: 300 * SLOT_MS + RULES_V1.arena.revealAfterMs - 1 }))).toThrow(invalid);
    expect(() => run(input(human, { startsAtMs: 301 * SLOT_MS, revealAtMs: 301 * SLOT_MS + RULES_V1.arena.revealAfterMs }))).toThrow(invalid);
    expect(() => run(input(human, { assignment: null }))).toThrow(invalid);
    const broken = structuredClone(human) as unknown as { sides: { fighter: { maxHealth: number } }[] };
    broken.sides[1].fighter.maxHealth = 0;
    expect(() => run(input(broken as unknown as ArenaAssignment))).toThrow(invalid);
    expect(() => run(input(human, { rulesVersion: 'v2' }))).toThrow(expect.objectContaining({ code: 'unsupported-rules' }));
  });

  it('dispatches simulations on an explicit kind and fails an unknown kind with unsupported-executor', async () => {
    const unknown = [{ kind: 'tournament' }, { kind: 'expedition' }, { choice: { kind: 'training' } }, {}, null]
      .map(snapshot => lease('simulation', { snapshot: snapshot as never }));
    const { database, calls } = port({ simulation: unknown });
    const report = await runWorker({ database, workerId: 'worker-k' });
    expect(calls.filter(c => c.name === 'fail').map(c => c.args[2])).toEqual(Array(5).fill('unsupported-executor'));
    expect(report).toMatchObject({ failed: 5, completed: 0 });
  });

  it('keeps an expedition simulation, whose input is its activity snapshot, on the expedition planner', () => {
    const prepared = prepareActivityV1(preparation());
    const snapshot: ActivitySnapshot = { activityId: 'activity-trip', gladiatorId: gid, slotIndex: 300, rulesVersion: 'v1', cutoffMs: 300 * SLOT_MS,
      choice: { kind: 'expedition', expeditionId: 'woodland' }, scheduleVersion: 1, build: prepared.snapshot, derived: prepared.derived,
      costs: prepared.costs, trainingPoints: 1, starting: { stamina: { current: 100, maximum: 100 }, level: 1, xp: 0, earnedPoints: 10,
        unspentPoints: 10, league: 'bronze', rating: 1000, peakStrength: 0, tournamentOptIn: false } };
    expect(DEFAULT_EXECUTORS.v1.simulation!(lease('simulation', { snapshot, seed: 'trip' }))).toEqual(planExpedition(snapshot, 'trip', RULES_V1));
  });
});

describe('fenced worker orchestration', () => {
  it('claims at most twenty simple jobs, settles before preparing and coordinates between batches', async () => {
    const settlements = Array.from({ length: 12 }, () => lease('settlement'));
    const prepares = Array.from({ length: 30 }, () => lease('prepare'));
    const { database, calls } = port({ settlement: settlements, prepare: prepares, simulation: [lease('simulation')] });
    const report = await runWorker({ database, workerId: 'worker-a' });
    const claims = calls.filter(c => c.name === 'claim').map(c => c.args.slice(1));
    expect(claims).toEqual([['settlement', 20], ['prepare', 8]]);
    expect(report).toMatchObject({ claimed: 20, completed: 20, failed: 0, conflicts: 0, byKind: { settlement: 12, prepare: 8, simulation: 0 } });
    expect(calls.filter(c => c.name === 'settle')).toHaveLength(12);
    expect(calls.filter(c => c.name === 'complete')).toHaveLength(8);
    expect(calls.filter(c => c.name === 'coordinate').length).toBeGreaterThanOrEqual(3);
  });
  it('claims pairing as simple work after preparation and before reveals, within one twenty-job budget', async () => {
    const pairing: PairingInput = { slotIndex: 300, league: 'bronze', seasonId: '0', rulesVersion: 'v1', historyFromSlot: 282, recent: [], entrants: [
      { gladiatorId: 'solo', activityId: 'activity-solo', seasonId: '0', league: 'bronze', slotIndex: 300, rating: 1000,
        fighter: prepareActivityV1(preparation()).arenaFighter }] };
    const { database, calls } = port({ prepare: [lease('prepare')], pair: [lease('pair', { snapshot: pairing, gladiatorId: null })], reveal: [lease('reveal')] });
    const report = await runWorker({ database, workerId: 'worker-p' });
    expect(calls.filter(c => c.name === 'claim').map(c => c.args.slice(1))).toEqual([['settlement', 20], ['prepare', 20], ['pair', 19], ['reveal', 18]]);
    expect(report).toMatchObject({ claimed: 3, completed: 3, failed: 0, byKind: { prepare: 1, pair: 1, reveal: 1, simulation: 0 } });
    const completedPair = calls.find(c => c.name === 'complete' && (c.args[2] as { assignments?: unknown }).assignments);
    expect(completedPair?.args[2]).toMatchObject({ assignments: [{ kind: 'npc', battleId: 'arena:300:solo:npc' }] });
  });
  /** A port whose boundary waits on preparation until `preparations` completed, then on pairing until 2 pairings completed. */
  function pairingBoundary(queues: Partial<Record<JobKind, JobLease[]>>, preparations = 20) {
    const { database, calls } = port(queues);
    database.coordinate = async () => {
      calls.push({ name: 'coordinate', args: [] });
      const done = (kind: JobKind) => calls.filter(c => c.name === 'complete' && c.args[2] && (c.args[2] as { kind?: string }).kind === kind).length;
      const boundary = done('prepare') < preparations ? { ok: true, slotIndex: 300, phase: 4, status: 'waiting' as const, wait: 'preparation' as const }
        : done('pair') < 2 ? { ok: true, slotIndex: 300, phase: 7, status: 'waiting' as const, wait: 'pairing' as const }
        : { ok: true, slotIndex: 300, phase: 9, status: 'complete' as const };
      return { ok: true, publishedSlot: boundary.phase === 9 ? 300 : 299, currentSlot: 300, boundaries: [boundary] };
    };
    const executors: ExecutorRegistry = { v1: { prepare: () => ({ kind: 'prepare' }), pair: () => ({ kind: 'pair' }) } };
    return { database, calls, executors };
  }
  it('claims the pairing jobs its own coordination released after spending its simple budget, one at a time', async () => {
    // The invocation that completes a boundary's last preparation has usually spent its twenty simple jobs; without this
    // claim the released pairing would wait a whole scheduled minute for the next dispatch.
    const pairs = [lease('pair', { gladiatorId: null }), lease('pair', { gladiatorId: null })], pairIds = pairs.map(p => p.id);
    const { database, calls, executors } = pairingBoundary({ prepare: Array.from({ length: 20 }, () => lease('prepare')), pair: pairs,
      simulation: [lease('simulation')] });
    const report = await runWorker({ database, workerId: 'worker-q', executors });
    // The third claim finds no pairing job left.
    expect(calls.filter(c => c.name === 'claim').map(c => c.args.slice(1))).toEqual([['settlement', 20], ['prepare', 20], ['pair', 1], ['pair', 1], ['pair', 1]]);
    expect(calls.filter(c => c.name === 'complete').slice(-2).map(c => c.args[0])).toEqual(pairIds);
    // It coordinates once more after pairing, which publishes; simulations still wait for an invocation without simple work.
    expect(calls.at(-1)?.name).toBe('coordinate');
    expect(report).toMatchObject({ claimed: 22, completed: 22, failed: 0, byKind: { prepare: 20, pair: 2, simulation: 0 },
      coordination: { publishedSlot: 300 } });
  });
  it('claims no pairing beyond the simple budget once the compute budget is spent', async () => {
    let cpu = 0;
    const { database, calls, executors } = pairingBoundary({ prepare: Array.from({ length: 20 }, () => lease('prepare')), pair: [lease('pair')] });
    const timed: ExecutorRegistry = { v1: { ...executors.v1, prepare: job => { cpu += WORKER_LIMITS.cpuMs / 20; return executors.v1.prepare!(job); } } };
    const report = await runWorker({ database, workerId: 'worker-r', executors: timed, cpuNow: () => cpu });
    expect(calls.filter(c => c.name === 'claim').map(c => c.args[1])).toEqual(['settlement', 'prepare']);
    expect(report).toMatchObject({ claimed: 20, byKind: { prepare: 20, pair: 0 } });
  });
  it('checks the compute budget before each pairing claim, so a spent budget never leaves a pairing job leased and unrun', async () => {
    let cpu = 0;
    const queues = { prepare: Array.from({ length: 20 }, () => lease('prepare')), pair: [lease('pair', { gladiatorId: null }), lease('pair', { gladiatorId: null })] };
    const second = queues.pair[1];
    const { database, calls, executors } = pairingBoundary(queues);
    const timed: ExecutorRegistry = { v1: { ...executors.v1, pair: job => { cpu += WORKER_LIMITS.cpuMs; return executors.v1.pair!(job); } } };
    const report = await runWorker({ database, workerId: 'worker-s', executors: timed, cpuNow: () => cpu });
    // The first pairing job spends the budget, so the second is never claimed: it stays pending for the next invocation
    // instead of waiting out a lease this invocation would only defer.
    expect(calls.filter(c => c.name === 'claim').map(c => c.args.slice(1))).toEqual([['settlement', 20], ['prepare', 20], ['pair', 1]]);
    expect(queues.pair).toEqual([second]);
    expect(report.deferred).toBeUndefined();
    expect(report).toMatchObject({ claimed: 21, completed: 21, byKind: { prepare: 20, pair: 1 } });
  });
  it('claims at most five pairing jobs after the simple loop, one at a time', async () => {
    const queues = { prepare: Array.from({ length: 20 }, () => lease('prepare')), pair: Array.from({ length: 7 }, () => lease('pair', { gladiatorId: null })) };
    const left = queues.pair.slice(WORKER_LIMITS.combat);
    const { database, calls, executors } = pairingBoundary(queues);
    const report = await runWorker({ database, workerId: 'worker-t', executors });
    expect(calls.filter(c => c.name === 'claim' && c.args[1] === 'pair').map(c => c.args[2])).toEqual(Array(WORKER_LIMITS.combat).fill(1));
    expect(queues.pair).toEqual(left);
    expect(report).toMatchObject({ claimed: 25, completed: 25, byKind: { prepare: 20, pair: WORKER_LIMITS.combat } });
  });
  it('claims nothing after the simple loop when its final coordination waits on anything but pairing', async () => {
    // The budget is spent with five preparations still outstanding: the boundary still waits on preparation, so neither the
    // waiting pairing job nor a simulation is claimed by this invocation.
    const queues = { prepare: Array.from({ length: 25 }, () => lease('prepare')), pair: [lease('pair', { gladiatorId: null })], simulation: [lease('simulation')] };
    const { database, calls, executors } = pairingBoundary(queues, 25);
    const report = await runWorker({ database, workerId: 'worker-u', executors });
    expect(calls.filter(c => c.name === 'claim').map(c => c.args.slice(1))).toEqual([['settlement', 20], ['prepare', 20]]);
    expect([queues.prepare.length, queues.pair.length, queues.simulation.length]).toEqual([5, 1, 1]);
    expect(report).toMatchObject({ claimed: 20, byKind: { prepare: 20, pair: 0, simulation: 0 },
      coordination: { boundaries: [{ status: 'waiting', wait: 'preparation' }] } });
  });
  it('processes at most five combat jobs only when no simple work exists', async () => {
    const simulations = Array.from({ length: 9 }, () => lease('simulation'));
    let executed = 0;
    const executors: ExecutorRegistry = { v1: { simulation: () => { executed += 1; return { outcome: 'private' }; } } };
    const { database, calls } = port({ simulation: simulations });
    const report = await runWorker({ database, workerId: 'worker-b', executors });
    expect(calls.filter(c => c.name === 'claim').map(c => c.args.slice(1)).at(-1)).toEqual(['simulation', 5]);
    expect(executed).toBe(5);
    expect(report).toMatchObject({ claimed: 5, completed: 5 });
  });
  it('dispatches by the job’s persisted rules version and keeps an older executor available', async () => {
    const seen: string[] = [];
    const executors: ExecutorRegistry = {
      v0: { prepare: job => { seen.push(`v0:${job.id}`); return { retained: true }; } },
      v1: { prepare: job => { seen.push(`v1:${job.id}`); return { current: true }; } },
    };
    const old = lease('prepare', { rulesVersion: 'v0' }), current = lease('prepare');
    const { database, calls } = port({ prepare: [old, current] });
    await runWorker({ database, workerId: 'worker-c', executors });
    expect(seen).toEqual([`v0:${old.id}`, `v1:${current.id}`]);
    expect(calls.find(c => c.name === 'complete' && c.args[0] === old.id)?.args[2]).toEqual({ retained: true });
  });
  it('fails unknown rules versions and missing executors closed with sanitized codes only', async () => {
    const unknown = lease('prepare', { rulesVersion: 'v9' }), missing = lease('reveal');
    const leaking = lease('prepare');
    const executors: ExecutorRegistry = { v1: { prepare: () => { throw new Error('postgres://user:secret@host leaked'); } } };
    const { database, calls } = port({ prepare: [unknown, leaking], reveal: [missing] });
    const report = await runWorker({ database, workerId: 'worker-d', executors });
    expect(calls.filter(c => c.name === 'fail').map(c => c.args)).toEqual([
      [unknown.id, unknown.token, 'unsupported-rules'], [leaking.id, leaking.token, 'execution-failed'], [missing.id, missing.token, 'unsupported-executor']]);
    expect(report).toMatchObject({ failed: 3, completed: 0 });
    expect(JSON.stringify(report)).not.toContain('secret');
  });
  it('renews a lease that is close to expiry before executing and stops when renewal is fenced', async () => {
    const soon = lease('settlement', { expiresAtMs: Date.now() + 1_000 });
    const stale = lease('settlement', { expiresAtMs: Date.now() + 1_000 });
    const { database, calls } = port({ settlement: [soon, stale] });
    let renewals = 0;
    database.renew = async (id, token) => {
      calls.push({ name: 'renew', args: [id, token] });
      renewals += 1;
      return renewals === 1 ? { ok: true, expiresAtMs: Date.now() + WORKER_LIMITS.leaseMs } : { ok: false, code: 'conflict' };
    };
    const report = await runWorker({ database, workerId: 'worker-e' });
    expect(calls.filter(c => c.name === 'renew').map(c => c.args[0])).toEqual([soon.id, stale.id]);
    expect(calls.filter(c => c.name === 'settle').map(c => c.args[0])).toEqual([soon.activityId]);
    expect(report).toMatchObject({ completed: 1, conflicts: 1 });
  });
  it('counts fenced completions and replayed settlements without inventing grants', async () => {
    const jobs = [lease('settlement'), lease('settlement'), lease('settlement')];
    const outcomes: JobOutcome[] = [{ ok: true, newGrants: 1 }, { ok: true, newGrants: 0, replayed: true }, { ok: false, code: 'conflict' }];
    const { database } = port({ settlement: jobs }, () => outcomes.shift()!);
    expect(await runWorker({ database, workerId: 'worker-f' })).toMatchObject({ completed: 1, replayed: 1, conflicts: 1, failed: 0 });
  });
  it('uses the authoritative renewed expiry and renews again after long execution before completion', async () => {
    let clock = 1_000;
    const job = lease('simulation', { expiresAtMs: 2_000 });
    const { database, calls } = port({ simulation: [job] });
    database.renew = async (id, token) => { calls.push({ name: 'renew', args: [id, token] }); return { ok: true, expiresAtMs: clock + 120_000 }; };
    const executors: ExecutorRegistry = { v1: { simulation: observed => {
      expect(observed.expiresAtMs).toBe(121_000); clock = 100_000; return {};
    } } };
    expect(await runWorker({ database, executors, workerId: 'renew', now: () => clock })).toMatchObject({ completed: 1 });
    expect(calls.filter(c => c.name === 'renew')).toHaveLength(2);
  });
  it('stops execution at the two-second compute budget and leaves unprocessed leases reclaimable', async () => {
    let cpu = 0;
    const { database, calls } = port({ simulation: [lease('simulation'), lease('simulation')] });
    const executors: ExecutorRegistry = { v1: { simulation: () => { cpu += 2_001; return {}; } } };
    const result = await runWorker({ database, executors, workerId: 'budget', cpuNow: () => cpu });
    expect(result).toMatchObject({ claimed: 2, completed: 1, deferred: 1 });
    expect(calls.filter(c => c.name === 'complete')).toHaveLength(1);
  });
  it('still claims and runs due jobs when coordination itself is unavailable', async () => {
    const job = lease('settlement');
    const { database, calls } = port({ settlement: [job] });
    database.coordinate = async () => { calls.push({ name: 'coordinate', args: [] }); throw new Error('worker-database-unavailable'); };
    const report = await runWorker({ database, workerId: 'worker-h' });
    expect(calls.filter(c => c.name === 'settle').map(c => c.args[0])).toEqual([job.activityId]);
    expect(report).toMatchObject({ claimed: 1, completed: 1, coordination: { ok: false, code: 'coordinator-unavailable', publishedSlot: null } });
  });
  it('does not count a failure as recorded when the fail RPC itself is unreachable', async () => {
    const job = lease('prepare', { rulesVersion: 'v9' });
    const { database } = port({ prepare: [job] });
    database.fail = async () => { throw new Error('worker-database-unavailable'); };
    expect(await runWorker({ database, workerId: 'worker-i' })).toMatchObject({ claimed: 1, failed: 0, unrecorded: 1, completed: 0 });
  });
  it('counts a settlement the database retained for operator action as failed, never as a grant or a conflict', async () => {
    const job = lease('settlement');
    const { database, calls } = port({ settlement: [job] }, () => ({ ok: false, code: 'operator' }));
    expect(await runWorker({ database, workerId: 'worker-o' })).toMatchObject({ claimed: 1, failed: 1, conflicts: 0, completed: 0 });
    // The database already retained the job; the worker no longer owns a lease it could fail.
    expect(calls.filter(c => c.name === 'fail')).toEqual([]);
  });
  it('fails a job whose prepared result the database rejects as invalid', async () => {
    const job = lease('prepare');
    const { database, calls } = port({ prepare: [job] }, () => ({ ok: false, code: 'invalid' }));
    expect(await runWorker({ database, workerId: 'worker-g' })).toMatchObject({ failed: 1, completed: 0 });
    expect(calls.find(c => c.name === 'fail')?.args).toEqual([job.id, job.token, 'invalid-result']);
  });
});

describe('private worker HTTP boundary', () => {
  const run = async () => ({ claimed: 0, completed: 0, replayed: 0, failed: 0, conflicts: 0, unrecorded: 0,
    byKind: { prepare: 0, pair: 0, simulation: 0, reveal: 0, settlement: 0 }, coordination: null });
  it('rejects missing, publishable and near-miss credentials before any database work', async () => {
    for (const authorization of [undefined, 'Bearer publishable-key', `Bearer ${SECRET}x`, SECRET, `Bearer ${SECRET.slice(0, -1)}`]) {
      const response = await handleWorker(post(authorization), { secret: SECRET, run: async () => { throw new Error('must not run'); } });
      expect(response.status, String(authorization)).toBe(401);
      expect(await response.json()).toEqual({ ok: false, code: 'unauthenticated' });
    }
    const unconfigured = await handleWorker(post('Bearer '), { secret: '', run: async () => { throw new Error('must not run'); } });
    expect(unconfigured.status).toBe(401);
  });
  it('accepts only POST with the server secret and returns an uncached report without CORS', async () => {
    expect((await handleWorker(post(`Bearer ${SECRET}`, 'GET'), { secret: SECRET, run })).status).toBe(405);
    const response = await handleWorker(post(`Bearer ${SECRET}`), { secret: SECRET, run });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(await response.json()).toMatchObject({ claimed: 0, coordination: null });
  });
  it('masks unexpected worker failures', async () => {
    const response = await handleWorker(post(`Bearer ${SECRET}`), { secret: SECRET, run: async () => { throw new Error('service key abc'); } });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('service key');
  });
});
