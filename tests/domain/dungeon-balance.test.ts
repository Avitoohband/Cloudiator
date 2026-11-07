import { describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClassId } from '@contracts/commands.ts';
import { CATALOG_V1 } from '@domain/catalog-v1.ts';
import { planDungeonRun, type DungeonRunInput } from '@domain/dungeon.ts';
import { expeditionReward, trainingCap } from '@domain/economy.ts';
import { RULES_V2 } from '@domain/rules-v2.ts';
import { cappedDungeonBuild, partyInput, representativeBuild, type RepresentativeLevel } from '../fixtures/dungeon-builds.ts';
import { recordMeasurement } from '../fixtures/measurements.ts';

const timing = vi.hoisted(() => ({ fightMs: undefined as number[] | undefined }));
vi.mock('@domain/party-combat.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('@domain/party-combat.ts')>();
  return { ...actual, simulateSkirmish: (...args: Parameters<typeof actual.simulateSkirmish>) => {
    if (!timing.fightMs) return actual.simulateSkirmish(...args);
    const start = performance.now();
    const log = actual.simulateSkirmish(...args);
    timing.fightMs.push(performance.now() - start);
    return log;
  } };
});

const CLASSES = ['berserker', 'guardian', 'duelist'] as const;
const ROWS = [
  { id: 'wolf-den', map: 'woodland', level: 3, over: 5, fullTarget: .9, soloTarget: .45 },
  { id: 'raider-stronghold', map: 'outpost', level: 7, over: 10, fullTarget: .88, soloTarget: .56 },
  { id: 'troll-hall', map: 'mountain', level: 12, over: 15, fullTarget: .87, soloTarget: .51 },
] as const;
const SAMPLES = 300;

function report(name: string, value: unknown) {
  recordMeasurement(`Dungeon ${name}`, value);
  const directory = process.env.CLOUDIATOR_DUNGEON_BALANCE_DIR;
  if (directory) writeFileSync(join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function inputFor(row: typeof ROWS[number], classes: readonly ClassId[], level: RepresentativeLevel, capped = false): DungeonRunInput {
  const input = partyInput(row.id, classes.map(classId => ({ classId, level })), `dungeon:1:${row.id}:1`);
  if (!capped) return input;
  return { ...input, seats: input.seats.map(seat => seat.kind === 'human'
    ? { ...seat, build: cappedDungeonBuild(seat.build.classId, level) } : seat) };
}

function measure(input: DungeonRunInput, shape: string, comparisonXp: number) {
  let rooms = 0, majors = 0, xp = 0, members = 0;
  let longest = { seed: '', ordinal: 0, durationMs: 0, logBytes: 0 };
  for (let i = 0; i < SAMPLES; i++) {
    const seed = `balance:${input.dungeonId}:${shape}:${i}`;
    const plan = planDungeonRun(input, seed, RULES_V2);
    if (plan.fights[2]?.won) rooms++;
    if (plan.fights[3]?.won) majors++;
    for (const member of plan.outcomes) { xp += member.rewards.xp; members++; }
    for (const fight of plan.fights) {
      if (fight.log.durationMs > longest.durationMs) longest = { seed, ordinal: fight.ordinal, durationMs: fight.log.durationMs,
        logBytes: Buffer.byteLength(JSON.stringify(fight.log), 'utf8') };
    }
  }
  return { runs: SAMPLES, members, rooms, majors, xp, roomRate: rooms / SAMPLES, majorRate: majors / SAMPLES,
    meanXp: xp / members, xpRatio: xp / members / comparisonXp, longest };
}

function assertBand(value: number, minimum: number, maximum: number, label: string) {
  expect.soft(value, label).toBeGreaterThanOrEqual(minimum);
  expect.soft(value, label).toBeLessThanOrEqual(maximum);
}

describe('party dungeon balance under retained v2', () => {
  it('ports the prototype allocation and gear independently of the hired catalog', () => {
    for (const row of ROWS) {
      const hired = CATALOG_V1.dungeons[row.id].hired;
      for (const kit of Object.values(hired)) {
        const build = representativeBuild(kit.classId, row.level);
        expect(build.allocations).toEqual(kit.allocations);
        expect(build.stance).toBe(kit.stance);
        expect(Object.fromEntries(Object.entries(build.equipment).map(([slot, item]) => [slot, item?.catalogId ?? null])))
          .toEqual(kit.equipment);
      }
    }
  });

  for (const row of ROWS) {
    it(`${row.id} meets the reference combat and XP bands`, { timeout: 180_000 }, () => {
      const comparisonXp = expeditionReward(RULES_V2, row.map).xp;
      const full = measure(inputFor(row, CLASSES, row.level), 'full', comparisonXp);
      const solos = CLASSES.map(classId => measure(inputFor(row, [classId], row.level), `solo-${classId}`, comparisonXp));
      const over = measure(inputFor(row, CLASSES, row.over), 'over', comparisonXp);
      const soloMajor = solos.reduce((sum, result) => sum + result.majorRate, 0) / solos.length;
      const soloXp = solos.reduce((sum, result) => sum + result.xpRatio, 0) / solos.length;
      report(`balance-${row.id}`, { comparisonXp, full, solos, over, soloMajor, soloXp });

      const fullPercent = Math.round(100 * row.fullTarget), soloPercent = Math.round(100 * row.soloTarget);
      assertBand(full.majorRate, (fullPercent - 8) / 100, (fullPercent + 8) / 100, `${row.id} full major win rate`);
      assertBand(soloMajor, (soloPercent - 8) / 100, (soloPercent + 8) / 100, `${row.id} mean solo major win rate`);
      for (const [index, result] of solos.entries()) {
        expect.soft(result.majorRate, `${row.id} solo ${CLASSES[index]} major win rate`).toBeGreaterThanOrEqual(.35);
        expect.soft(result.roomRate, `${row.id} solo ${CLASSES[index]} room clear rate`).toBeGreaterThanOrEqual(.97);
      }
      expect.soft(full.roomRate, `${row.id} full room clear rate`).toBeGreaterThanOrEqual(.97);
      expect.soft(over.roomRate, `${row.id} over-level room clear rate`).toBeGreaterThanOrEqual(.97);
      expect.soft(over.majorRate, `${row.id} over-level major win rate`).toBeGreaterThanOrEqual(.95);
      assertBand(soloXp, 1, 1.25, `${row.id} mean solo XP ratio`);
      assertBand(full.xpRatio, 1.35, 1.65, `${row.id} full XP ratio`);
    });

    it(`${row.id} measures capped v2 builds separately`, { timeout: 180_000 }, () => {
      const comparisonXp = expeditionReward(RULES_V2, row.map).xp;
      const input = inputFor(row, CLASSES, row.level, true);
      const pointCap = trainingCap(RULES_V2, row.level);
      for (const seat of input.seats) if (seat.kind === 'human') {
        expect(Object.values(seat.build.allocations).reduce((sum, points) => sum + points, 0)).toBe(pointCap);
      }
      const full = measure(input, 'capped-full', comparisonXp);
      const solos = CLASSES.map(classId => measure(inputFor(row, [classId], row.level, true), `capped-solo-${classId}`, comparisonXp));
      report(`capped-${row.id}`, { pointCap, full, solos });
    });
  }

  it('plans 50 full Troll Hall runs in under 100 ms on average', { timeout: 180_000 }, () => {
    const row = ROWS[2];
    const input = inputFor(row, CLASSES, row.level);
    const samples: { seed: string; planMs: number; fightMs: number[]; runBytes: number }[] = [];
    try {
      for (let i = 0; i < 50; i++) {
        const seed = `benchmark:troll-hall:full:${i}`;
        const fightMs: number[] = [];
        timing.fightMs = fightMs;
        const start = performance.now();
        const plan = planDungeonRun(input, seed, RULES_V2);
        const planMs = performance.now() - start;
        expect(fightMs).toHaveLength(plan.fights.length);
        samples.push({ seed, planMs, fightMs, runBytes: Buffer.byteLength(JSON.stringify(plan), 'utf8') });
      }
    } finally { timing.fightMs = undefined; }
    const fights = samples.flatMap(sample => sample.fightMs).sort((a, b) => a - b);
    const bytes = samples.map(sample => sample.runBytes).sort((a, b) => a - b);
    const meanPlanMs = samples.reduce((sum, sample) => sum + sample.planMs, 0) / samples.length;
    const percentile = (values: number[], p: number) => values[Math.ceil(values.length * p) - 1];
    report('troll-hall-benchmark', { meanPlanMs, fights: fights.length, fightP50Ms: percentile(fights, .5),
      fightP95Ms: percentile(fights, .95), fightMaxMs: fights.at(-1), runP95Bytes: percentile(bytes, .95), samples });
    expect(meanPlanMs).toBeLessThan(100);
  });
});
