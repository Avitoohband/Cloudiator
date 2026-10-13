import { describe, expect, it } from 'vitest';
import type { BattleLog, RevealedTimeline } from '@contracts/events';
import { RULES_V1 } from '@domain/rules-v1';
import { EXPEDITION_FIXTURE_TIMELINES as T } from '../fixtures/expeditions';
import { reduceReplay, REPLAY_OUTRO_MS } from '@/game/replay';
import {
  EXPEDITION_APPROACH_MS, JOURNEY, expeditionRevealMarks, renderExpeditionStage, type ExpeditionSceneState,
} from '@/game/expedition-stage';

const MIN = 60_000;
const start = (t: RevealedTimeline) => t.stages[0].startedAtMs;
const at = (t: RevealedTimeline, minute: number) => renderExpeditionStage(t, start(t) + minute * MIN);
const labels = (s: ExpeditionSceneState) => s.stages.map(x => x.label);
const logOf = (t: RevealedTimeline, n: number) => t.stages.filter(s => s.kind === 'encounter')[n - 1].battleLog!;
const encounterStage = (t: RevealedTimeline, n: number) => t.stages.filter(s => s.kind === 'encounter')[n - 1];
function deepFreeze<V>(value: V): V {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const v of Object.values(value)) deepFreeze(v); }
  return value;
}
/** Every text the state could put on screen, without the revealed battle logs themselves. */
const texts = (s: ExpeditionSceneState) => JSON.stringify({ ...s, battle: s.battle && { ...s.battle, log: undefined } });

describe('expedition minute table', () => {
  const D = 'Depart for Woodland Path';
  it('walks a full success through minutes 19, 20, 39, 40, 59, 60, 79 and 80', () => {
    const t = T.woodland;
    const rows: [number, ExpeditionSceneState['phase'], string[]][] = [
      [19, 'depart', [D]],
      [20, 'encounter', [D, 'Encounter 1']],
      [39, 'exploration', [D, 'Encounter 1: victory', 'Recover and continue exploring']],
      [40, 'encounter', [D, 'Encounter 1: victory', 'Recover and continue exploring', 'Encounter 2']],
      [59, 'exploration', [D, 'Encounter 1: victory', 'Recover and continue exploring', 'Encounter 2: victory', 'Recover and continue exploring']],
      [60, 'encounter', [D, 'Encounter 1: victory', 'Recover and continue exploring', 'Encounter 2: victory', 'Recover and continue exploring', 'Encounter 3']],
      [79, 'returning', [D, 'Encounter 1: victory', 'Recover and continue exploring', 'Encounter 2: victory', 'Recover and continue exploring', 'Encounter 3: victory', 'Return to camp']],
      [80, 'arrived', [D, 'Encounter 1: victory', 'Recover and continue exploring', 'Encounter 2: victory', 'Recover and continue exploring', 'Encounter 3: victory', 'Return to camp', 'Arrive at camp']],
    ];
    for (const [minute, phase, expected] of rows) {
      const s = at(t, minute);
      expect(s.phase, `minute ${minute}`).toBe(phase);
      expect(labels(s), `minute ${minute}`).toEqual(expected);
      expect(s.current?.label).toBe(expected.at(-1));
    }
    // Settled once the summary's settlement time has passed.
    const settled = renderExpeditionStage(t, t.summary!.settledAtMs);
    expect(settled.phase).toBe('settled');
    expect(settled).toMatchObject({ complete: true, outcome: 'success', summary: t.summary, awaitingSummary: false });
  });

  it('ends further encounters after a defeat in encounter 1, 2 or 3 and rests at the safe point', () => {
    const cases: [RevealedTimeline, number][] = [[T.spectator, 1], [T.outpost, 2], [T.mountain, 3]];
    for (const [t, lost] of cases) {
      for (const minute of [19, 20, 39, 40, 59, 60, 79, 80]) {
        const s = at(t, minute);
        const due = Math.min(3, Math.floor(minute / 20));
        const expectedPhase = minute < 20 ? 'depart'
          : minute === 80 ? 'arrived'
            : due > lost || (due === lost && minute % 20 !== 0) ? 'safe-return'
              : minute % 20 === 0 ? 'encounter' : 'exploration';
        expect(s.phase, `defeat ${lost}, minute ${minute}`).toBe(expectedPhase);
        // Encounters after the defeat never appear, even when their minute has passed.
        for (let n = lost + 1; n <= 3; n += 1) expect(labels(s).some(l => l.startsWith(`Encounter ${n}`)), `encounter ${n} at ${minute}`).toBe(false);
        if (expectedPhase === 'safe-return') {
          expect(s.current?.label).toBe('Rest at the safe return point');
          expect(labels(s)).toContain(`Encounter ${lost}: defeat`);
          expect(s.route).toMatchObject({ to: 'safe', then: 'rest' });
        }
      }
      const arrived = at(t, 80);
      expect(arrived).toMatchObject({ complete: true, outcome: 'failure' });
      expect(arrived.route).toMatchObject({ from: 'safe', to: 'safe', then: 'rest' });
    }
  });
});

describe('revealed stages only', () => {
  it('hides a stage that the timeline holds but whose reveal time has not come', () => {
    const t = T.woodland;
    const before = renderExpeditionStage(t, start(t) + 20 * MIN - 1);
    expect(before.phase).toBe('depart');
    expect(labels(before)).toEqual(['Depart for Woodland Path']);
    expect(before.battle).toBeNull();
    // At minute 39 the timeline already holds encounters 2 and 3 and the summary; none of them leak.
    const s = at(t, 39);
    expect(s.stages.map(x => x.id)).toEqual(t.stages.slice(0, 3).map(x => x.id));
    expect(texts(s)).not.toMatch(/Encounter [23]|Return to camp|Arrive at camp/);
    expect(s.summary).toBeNull();
    expect(texts(s)).not.toMatch(/rewards|receipt|light-boots|salvage/i);
    expect(s.battle?.stageId).toBe(encounterStage(t, 1).id);
  });

  it('shows Preparing, never a fabricated encounter, when a due stage is missing', () => {
    const t = T.delayed;
    expect(at(t, 39).phase).toBe('exploration');
    for (const minute of [40, 45, 60, 80, 85]) {
      const s = at(t, minute);
      expect(s.phase, `minute ${minute}`).toBe('preparing');
      expect(labels(s)).toEqual(['Depart for Woodland Path', 'Encounter 1: victory', 'Recover and continue exploring']);
      expect(s.battle?.stageId).toBe(encounterStage(t, 1).id);
      // The gladiator waits at the next encounter spot; no creature or fight is invented.
      expect(s.route).toMatchObject({ to: 'encounter-2', then: 'wait' });
      expect(s.complete).toBe(false);
    }
    // A battle that ended before its follow-up stage was published also shows Preparing.
    const cut: RevealedTimeline = { ...T.woodland, stages: T.woodland.stages.slice(0, 2) };
    const after = renderExpeditionStage(cut, encounterStage(cut, 1).endsAtMs + 5_000);
    expect(after.phase).toBe('preparing');
    expect(after.stages.at(-1)!.label).toBe('Encounter 1: victory');
    expect(after.battle).toMatchObject({ finished: true });
    // Before anything is revealed there is nothing to follow yet.
    const none = renderExpeditionStage(T.woodland, start(T.woodland) - 1);
    expect(none).toMatchObject({ phase: 'preparing', stages: [], current: null, route: null, progress: null, battle: null, hp: null });
  });

  it('never states the outcome of an encounter before its battle has ended', () => {
    for (const [t, n] of [[T.woodland, 1], [T.outpost, 2], [T.spectator, 1], [T.mountain, 3]] as const) {
      const stage = encounterStage(t, n);
      for (const ms of [stage.startedAtMs, stage.startedAtMs + 1_000, stage.endsAtMs - 1]) {
        const s = renderExpeditionStage(t, ms);
        expect(s.phase).toBe('encounter');
        const shown = s.stages.at(-1)!;
        expect(shown).toMatchObject({ label: `Encounter ${n}`, encounter: n, inProgress: true, outcome: null, replay: false });
        // Earlier encounters keep their published labels; this one shows no result, and no safe-return stage appears.
        expect(texts(s)).not.toContain(`Encounter ${n}:`);
        expect(texts(s)).not.toMatch(/safe return|safe-return|Return to camp/i);
        expect(s.outcome).toBeNull();
        expect(s.battle).toMatchObject({ stageId: stage.id, encounter: n, elapsedMs: ms - stage.startedAtMs, finished: false });
        expect(s.battle!.log).toBe(stage.battleLog);
      }
      const ended = renderExpeditionStage(t, stage.endsAtMs);
      expect(ended.stages.find(x => x.id === stage.id)).toMatchObject({ label: stage.label, inProgress: false, outcome: stage.label.endsWith('victory') ? 'victory' : 'defeat' });
    }
  });
});

describe('health from the battle logs', () => {
  it('reads health from the logs only: running health in a fight, then the final health until the next log', () => {
    const t = T.woodland;
    expect(at(t, 10).hp).toBeNull();
    for (const n of [1, 2, 3]) {
      const log = logOf(t, n);
      const stage = encounterStage(t, n);
      expect(renderExpeditionStage(t, stage.startedAtMs).hp).toEqual({ current: log.participants[0].initialHealth, max: log.participants[0].maxHealth, encounter: n });
      for (const event of log.events) {
        const s = renderExpeditionStage(t, stage.startedAtMs + event.elapsedMs);
        expect(s.hp!.current).toBe(reduceReplay(log, event.elapsedMs).hp[0]);
      }
      expect(renderExpeditionStage(t, stage.endsAtMs + 60_000).hp).toEqual({ current: log.finalHp[0], max: log.participants[0].maxHealth, encounter: n });
    }
    // Between encounters it shows the logged final health, never a computed 20% recovery.
    expect(at(t, 39).hp!.current).toBe(logOf(t, 1).finalHp[0]);
    expect(at(t, 40).hp!.current).toBe(logOf(t, 2).participants[0].initialHealth);
  });

  it('follows an unusual logged starting health instead of recomputing it', () => {
    const t = structuredClone(T.woodland);
    const second = encounterStage(t, 2).battleLog as { participants: { initialHealth: number }[] };
    second.participants[0].initialHealth = 77;
    expect(at(t, 39).hp!.current).toBe(logOf(t, 1).finalHp[0]);
    expect(at(t, 40).hp!.current).toBe(77);
  });

  it('has no health to show when the detailed logs were pruned', () => {
    expect(at(T.expired, 39).hp).toBeNull();
    expect(at(T.expired, 85).hp).toBeNull();
  });
});

describe('replays and the summary', () => {
  it('offers a replay for each completed encounter whose log is kept', () => {
    const t = T.woodland;
    const replays = (s: ExpeditionSceneState) => s.stages.filter(x => x.replay).map(x => x.encounter);
    expect(replays(at(t, 20))).toEqual([]);
    expect(replays(at(t, 39))).toEqual([1]);
    expect(replays(at(t, 85))).toEqual([1, 2, 3]);
    // A spectator has no summary; completed encounters are still replayable.
    expect(replays(at(T.spectator, 30))).toEqual([1]);
    // Pruned logs or an expired summary: no replay links.
    expect(replays(at(T.expired, 85))).toEqual([]);
    const expired: RevealedTimeline = { ...t, summary: { ...t.summary!, replayExpiry: { state: 'expired' } } };
    expect(replays(at(expired, 85))).toEqual([]);
    expect(replays(at(expired, 39))).toEqual([]);
  });

  it('takes the result and rewards only from the timeline summary, once it is settled', () => {
    const t = T.woodland;
    expect(at(t, 80)).toMatchObject({ phase: 'arrived', summary: null, awaitingSummary: true, outcome: 'success' });
    expect(texts(at(t, 80))).not.toMatch(/rewards|receipt/i);
    const s = renderExpeditionStage(t, t.summary!.settledAtMs);
    expect(s.summary).toEqual(t.summary);
    expect(s.summary).not.toBe(t.summary);
    // A spectator's timeline never has a summary; its result comes from the revealed encounters.
    const spectator = at(T.spectator, 85);
    expect(spectator).toMatchObject({ phase: 'arrived', summary: null, complete: true, outcome: 'failure' });
    expect(texts(spectator)).not.toMatch(/rewards|receipt|money|renown/i);
    // Without logs, the published labels decide the outcome.
    expect(at(T.expired, 85)).toMatchObject({ phase: 'settled', outcome: 'success' });
    // A failed run settles with the summary's (empty) rewards.
    const mountain = renderExpeditionStage(T.mountain, T.mountain.summary!.settledAtMs);
    expect(mountain).toMatchObject({ phase: 'settled', outcome: 'failure', summary: { success: false } });
  });
});

describe('journey and progress', () => {
  it('measures progress along the 80-minute slot', () => {
    const t = T.woodland;
    expect(RULES_V1.clock.slotMs).toBe(80 * MIN);
    expect(at(t, 0).progress).toEqual({ startMs: start(t), endMs: start(t) + 80 * MIN, fraction: 0, minute: 0 });
    expect(at(t, 40).progress).toMatchObject({ fraction: 0.5, minute: 40 });
    expect(at(t, 200).progress).toMatchObject({ fraction: 1, minute: 80 });
  });

  it('walks to the search spots, waits at each encounter, fights there, and returns or rests', () => {
    const t = T.woodland;
    const s = start(t);
    const first = encounterStage(t, 1);
    expect(JOURNEY).toEqual(['start', 'search-1', 'encounter-1', 'search-2', 'encounter-2', 'search-3', 'encounter-3', 'search-4', 'end']);
    expect(renderExpeditionStage(t, s + 5 * MIN)).toMatchObject({ searchSpot: 1, route: { segment: 0, from: 'start', to: 'search-1', walkedMs: 5 * MIN, then: 'search' } });
    const approach = s + 20 * MIN - EXPEDITION_APPROACH_MS;
    expect(renderExpeditionStage(t, approach + 1_000)).toMatchObject({ searchSpot: null, route: { segment: 1, from: 'search-1', to: 'encounter-1', walkedMs: 1_000, then: 'wait' } });
    expect(renderExpeditionStage(t, first.startedAtMs + 2_000).route).toEqual({ segment: 2, from: 'encounter-1', to: 'encounter-1', walkedMs: 2_000, then: 'fight' });
    // The fighters finish their result poses before the gladiator moves on.
    expect(renderExpeditionStage(t, first.endsAtMs + REPLAY_OUTRO_MS - 1).route).toMatchObject({ from: 'encounter-1', to: 'encounter-1', then: 'fight' });
    expect(renderExpeditionStage(t, first.endsAtMs + REPLAY_OUTRO_MS + 3_000)).toMatchObject({ searchSpot: 2, route: { segment: 2, from: 'encounter-1', to: 'search-2', walkedMs: 3_000, then: 'search' } });
    expect(renderExpeditionStage(t, s + 40 * MIN - 10_000).route).toMatchObject({ segment: 3, from: 'search-2', to: 'encounter-2', then: 'wait' });
    expect(at(t, 70).route).toMatchObject({ segment: 6, from: 'encounter-3', to: 'search-4', then: 'search' });
    expect(at(t, 80 - 0.5).route).toMatchObject({ segment: 7, from: 'search-4', to: 'end', then: 'wait' });
    expect(at(t, 85).route).toMatchObject({ from: 'end', to: 'end', then: 'wait' });
    const lost = encounterStage(T.outpost, 2);
    expect(renderExpeditionStage(T.outpost, lost.endsAtMs + REPLAY_OUTRO_MS + 4_000).route).toEqual({ segment: 4, from: 'encounter-2', to: 'safe', walkedMs: 4_000, then: 'rest' });
  });

  it('lists the moments when a fresh read can reveal more', () => {
    const t = T.woodland;
    const s = start(t);
    expect(expeditionRevealMarks(at(t, 39))).toEqual([s + 40 * MIN, s + 60 * MIN, s + 80 * MIN]);
    const fight = encounterStage(t, 2);
    expect(expeditionRevealMarks(renderExpeditionStage(t, fight.startedAtMs + 1_000))).toEqual([fight.endsAtMs, s + 60 * MIN, s + 80 * MIN]);
    expect(expeditionRevealMarks(at(t, 85))).toEqual([]);
    expect(expeditionRevealMarks(at(T.delayed, 45))).toEqual([start(T.delayed) + 60 * MIN, start(T.delayed) + 80 * MIN]);
  });
});

describe('purity', () => {
  it('is deterministic, never mutates its input and shares no mutable state', () => {
    const t = deepFreeze(structuredClone(T.woodland));
    const copy = JSON.stringify(t);
    const times = [-5, 0, 19, 20, 20.05, 39, 40, 60, 79, 80, 81, 200].map(m => start(t) + m * MIN);
    const first = times.map(ms => renderExpeditionStage(t, ms));
    const second = [...times].reverse().map(ms => renderExpeditionStage(t, ms)).reverse();
    expect(second).toEqual(first);
    expect(JSON.stringify(t)).toBe(copy);
    const s = renderExpeditionStage(t, start(t) + 85 * MIN);
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.stages)).toBe(true);
    expect(Object.isFrozen(s.stages[0])).toBe(true);
    expect(() => { (s.summary as { success: boolean }).success = false; }).toThrow();
  });

  it('uses no clock, randomness or browser state of its own', async () => {
    const source = (await import('node:fs')).readFileSync('src/game/expedition-stage.ts', 'utf8');
    expect(source).not.toMatch(/Date\.now|performance\.now|Math\.random|window\.|document\./);
    expect(source).not.toMatch(/from '[^']*(phaser|react|combat)[^']*'/);
    const log: BattleLog = logOf(T.woodland, 1);
    expect(log.participants[1].id).toBe('creature:dire-wolf:1');
  });
});
