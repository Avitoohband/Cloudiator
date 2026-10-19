import { describe, expect, it } from 'vitest';
import { WORKER_LIMITS } from '../../supabase/functions/_shared/backend/jobs.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { BUDGET_MS, bracketPairingJob, expeditionJob, machine, timeOnce, timeRuns, tournamentFinalJob, worstCaseArenaJob, writeSection } from './harness.ts';

// Task 23.3 (Review Focus 3, R7): worker CPU in pure code on this machine. Each measured run is what one Edge invocation does
// for its jobs: the job lease is parsed from JSON and frozen as `runWorker` freezes it, the v1 executor runs, and the result
// is serialized for `complete_job`. The hosted Edge CPU (C4) is a Task 24 check; this machine is recorded with the numbers.
// The budget is the worker's `cpuMs` (2,000 ms) less a 25 % margin.

const worker: Record<string, unknown> = {};

describe('Task 23.3: worker CPU in pure code (this machine; hosted Edge CPU is Task 24)', () => {
  it('simulates the worst-case 120 s fight within the 2,000 ms worker budget with a 25 % margin', () => {
    expect(BUDGET_MS).toBe(WORKER_LIMITS.cpuMs * 0.75);
    // The engine's worst case: both sides attack every 250 ms (the minimum interval) and neither falls, so the bout runs to
    // the 120 s cap with 480 attacks a side plus the victory event.
    const fight = worstCaseArenaJob();
    // The first simulation of the process is the cold one (no JIT yet), as in a fresh Edge isolate.
    const { value: probe, ms: coldMs } = timeOnce(() => fight.run('probe'));
    expect(probe.log.durationMs).toBe(RULES_V1.combat.maximumDurationMs);
    expect(probe.log.events).toHaveLength(2 * RULES_V1.combat.maximumDurationMs / RULES_V1.combat.minimumIntervalMs + 1);
    expect(probe.log.participants.map(p => p.attackIntervalMs)).toEqual([RULES_V1.combat.minimumIntervalMs, RULES_V1.combat.minimumIntervalMs]);
    const single = timeRuns(i => fight.run(`single-${i}`), 20);
    // One invocation's combat batch: five simulations (WORKER_LIMITS.combat).
    const batch = timeRuns(i => { for (let j = 0; j < WORKER_LIMITS.combat; j++) fight.run(`batch-${i}-${j}`); }, 10);
    // An expedition job plans three encounters in one simulation job; five of them are the other kind of combat batch.
    const expedition = expeditionJob();
    const expeditionBatch = timeRuns(i => { for (let j = 0; j < WORKER_LIMITS.combat; j++) expedition.run(`expedition-${i}-${j}`); }, 10);
    Object.assign(worker, { worstCombatMs: Math.max(coldMs, single.maxMs), worstCombatColdMs: coldMs, worstCombat: single, events: probe.log.events.length,
      batch5Ms: batch.maxMs, batch5: batch, expeditionBatch5Ms: expeditionBatch.maxMs, expeditionBatch5: expeditionBatch,
      expeditionEvents: expedition.events('expedition-probe') });
    expect(coldMs).toBeLessThanOrEqual(BUDGET_MS);
    for (const measured of [single, batch, expeditionBatch]) {
      expect(measured.firstMs).toBeLessThanOrEqual(BUDGET_MS);
      expect(measured.maxMs).toBeLessThanOrEqual(BUDGET_MS);
    }
  });

  it('builds the 50-entrant bracket and its jobs within budget', () => {
    // The tournament slot's pairing job: partition 50 opted-in candidates, build the bracket and check its graph.
    const pairing = bracketPairingJob(50);
    const { value: built, ms: pairingColdMs } = timeOnce(() => pairing.run('pairing-probe'));
    expect(built.tournament?.bracket?.entries).toHaveLength(50);
    expect(built.tournament?.bracket?.bouts.filter(b => !b.bye)).toHaveLength(49);
    expect(built.assignments).toEqual([]);
    const bracket = timeRuns(i => pairing.run(`pairing-${i}`), 20);
    // Its bout jobs: the heaviest is the final, whose fenced graph read carries the 48 earlier fought logs, here every one a
    // worst-case 120 s bout. Five of them stand in for one invocation's combat batch (no real batch reads a larger graph).
    const final = tournamentFinalJob(50);
    expect(final.storedLogs).toBe(48);
    const { value: decided, ms: finalColdMs } = timeOnce(() => final.run('final-probe'));
    expect(decided.outcomes).toHaveLength(50);
    const bouts = timeRuns(i => { for (let j = 0; j < WORKER_LIMITS.combat; j++) final.run(`final-${i}-${j}`); }, 5);
    Object.assign(worker, { bracket50Ms: Math.max(pairingColdMs, bracket.maxMs), bracket50ColdMs: pairingColdMs, bracket50: bracket,
      tournamentBatch5Ms: bouts.maxMs, tournamentFinalColdMs: finalColdMs, tournamentBatch5: bouts,
      finalGraphBytes: final.graphBytes });
    expect(Math.max(pairingColdMs, finalColdMs)).toBeLessThanOrEqual(BUDGET_MS);
    for (const measured of [bracket, bouts]) {
      expect(measured.firstMs).toBeLessThanOrEqual(BUDGET_MS);
      expect(measured.maxMs).toBeLessThanOrEqual(BUDGET_MS);
    }
    const section = { budgetMs: BUDGET_MS, cpuMs: WORKER_LIMITS.cpuMs, machine: machine(), ...worker };
    console.info(`Task 23.3 worker CPU: ${JSON.stringify(section)}`);
    writeSection('worker', section);
  });
});
