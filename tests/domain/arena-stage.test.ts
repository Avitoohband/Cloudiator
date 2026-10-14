import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RevealedTimeline } from '@contracts/events';
import type { PublicActor } from '@contracts/reads';
import { ARENA_REVEAL_MS, ARENA_SLOT_MS, arenaRevealMarks, arenaStageOfActor, renderArenaStage, type ArenaStageState } from '@/game/arena-stage';
import {
  ARENA_ACTIVITIES, ARENA_BATTLE_LOGS, ARENA_GLADIATORS, ARENA_TIMELINES, ARENA_WORLD_ACTORS, arenaActivityId, arenaBattleId, type ArenaActivityKey,
} from '../fixtures/arena';
import { worldFixture } from '../fixtures/domain';

const MIN = 60_000;
const NOW = worldFixture.serverNowMs;
const SLOT_START = NOW - (NOW % ARENA_SLOT_MS);
const timeline = (key: ArenaActivityKey) => ARENA_TIMELINES[arenaActivityId(key)];
const startOf = (key: ArenaActivityKey) => SLOT_START - ARENA_ACTIVITIES[key].slotsAgo * ARENA_SLOT_MS;
const entrantOf = (key: ArenaActivityKey) => ARENA_GLADIATORS[ARENA_ACTIVITIES[key].gladiator].id;
/** The state of an entrant's own activity at a minute of its slot. */
function at(key: ArenaActivityKey, minute: number, owner = ARENA_ACTIVITIES[key].owner) {
  return renderArenaStage(timeline(key), startOf(key) + minute * MIN, { entrantId: entrantOf(key), owner });
}
const boutEnd = (key: ArenaActivityKey) => timeline(key).stages[1].endsAtMs;
/** Every outcome word or bout identity a state could leak, searched in its serialised form. */
const leaks = (state: ArenaStageState, key: ArenaActivityKey) => {
  const text = JSON.stringify(state);
  const log = ARENA_BATTLE_LOGS[ARENA_ACTIVITIES[key].bout!];
  return ['victory', 'defeat', log.battleId, log.participants[1].name, log.participants[1].id].filter(word => text.includes(word));
};

afterEach(() => vi.restoreAllMocks());

describe('arena stage timing', () => {
  it('warms up from minute 0 to 59 without any opponent, bout, outcome or replay', () => {
    for (const minute of [0, 30, 59, 59.999]) {
      const s = at('ownerHumanWin', minute);
      expect(s, `minute ${minute}`).toMatchObject({ phase: 'warming-up', opponent: null, entrant: null, npcOpponent: false, bout: null, replay: null, result: null, summary: null, awaitingSummary: false });
      expect(s.stages.map(x => x.label)).toEqual(['Warming up']);
      expect(s.minute).toBeCloseTo(minute, 6);
      expect(leaks(s, 'ownerHumanWin'), `minute ${minute}`).toEqual([]);
    }
  });

  it('reveals the opponent, the bout and its replay at minute 60, with no outcome until the bout ends', () => {
    const key = 'ownerHumanWin';
    const log = ARENA_BATTLE_LOGS.ownerHumanWin;
    for (const t of [startOf(key) + ARENA_REVEAL_MS, startOf(key) + ARENA_REVEAL_MS + log.durationMs / 2, boutEnd(key) - 1]) {
      const s = renderArenaStage(timeline(key), t, { entrantId: entrantOf(key), owner: true });
      expect(s.phase).toBe('bout');
      expect(s.opponent).toEqual({ id: ARENA_GLADIATORS.varro.id, gladiatorId: ARENA_GLADIATORS.varro.id, name: 'Varro', classId: 'berserker', npc: false });
      expect(s.entrant).toMatchObject({ gladiatorId: ARENA_GLADIATORS.aster.id, name: 'Aster', npc: false });
      expect(s.bout).toMatchObject({ stageId: `${arenaActivityId(key)}:1`, battleId: arenaBattleId('ownerHumanWin'), elapsedMs: t - (startOf(key) + ARENA_REVEAL_MS), finished: false });
      expect(s.bout!.log).toBe(log);
      expect(s.replay).toEqual({ activityId: arenaActivityId(key), stageId: `${arenaActivityId(key)}:1` });
      expect(s.result).toBeNull();
      // The published label names the outcome; while the bout runs it reads only "Bout in progress".
      expect(s.stages.map(x => x.label)).toEqual(['Warming up', 'Bout in progress']);
      expect(s.stages[1].inProgress).toBe(true);
      expect(JSON.stringify({ ...s, bout: null })).not.toMatch(/victory|defeat/i);
    }
  });

  it('shows the completed bout until minute 80 and the credited summary from minute 80 for the owner', () => {
    const key = 'ownerHumanWin';
    const after = renderArenaStage(timeline(key), boutEnd(key), { entrantId: entrantOf(key), owner: true });
    expect(after).toMatchObject({ phase: 'completed', summary: null, awaitingSummary: false });
    expect(after.result).toEqual({ outcome: 'victory', winnerId: ARENA_GLADIATORS.aster.id, reason: 'defeat', tieBreakReason: null, finalHp: [50, 0] });
    expect(after.stages.map(x => x.label)).toEqual(['Warming up', 'Bout: victory']);
    expect(at(key, 79)).toMatchObject({ phase: 'completed', summary: null });
    const credited = at(key, 80);
    expect(credited.phase).toBe('credited');
    expect(credited.summary).toMatchObject({ result: 'victory', rewards: { renown: 10 }, ratingDelta: 13 });
    expect(credited.stages.map(x => x.label)).toEqual(['Warming up', 'Bout: victory', 'Results credited']);
    expect(credited.replay).not.toBeNull();
  });

  it('discloses an NPC fallback opponent after reveal and credits reduced renown with no rating change', () => {
    expect(at('ownerNpcWin', 59)).toMatchObject({ npcOpponent: false, opponent: null });
    const revealed = at('ownerNpcWin', 60);
    expect(revealed.npcOpponent).toBe(true);
    expect(revealed.opponent).toEqual({ id: `npc:${ARENA_GLADIATORS.aster.id}`, gladiatorId: null, name: 'Iron Warden', classId: null, npc: true });
    expect(revealed.replay).not.toBeNull();
    const credited = at('ownerNpcWin', 80);
    expect(credited.summary).toMatchObject({ result: 'victory', rewards: { renown: 3 } });
    expect(credited.summary).not.toHaveProperty('ratingDelta');
    const lost = at('ownerNpcLoss', 80);
    expect(lost.result).toMatchObject({ outcome: 'defeat' });
    expect(lost.summary).toMatchObject({ result: 'defeat', rewards: { renown: 0 } });
    expect(at('ownerHumanLoss', 80).summary).toMatchObject({ result: 'defeat', rewards: { renown: 2 }, ratingDelta: -13 });
  });

  it('is preparing once minute 60 has passed with no bout published, and awaits results after minute 80', () => {
    for (const minute of [60, 65, 79]) expect(at('ownerDelayed', minute), `minute ${minute}`).toMatchObject({ phase: 'preparing', bout: null, replay: null, opponent: null, awaitingSummary: false });
    expect(at('ownerDelayed', 59).phase).toBe('warming-up');
    expect(at('ownerDelayed', 85)).toMatchObject({ phase: 'preparing', awaitingSummary: true });
    // Only the owner is told about processing; a spectator sees the same truthful phase.
    expect(at('ownerDelayed', 85, false)).toMatchObject({ phase: 'preparing', awaitingSummary: false });
  });

  it('decides the winner by winnerId, even when both fighters end on 0 HP', () => {
    const own = at('ownerTieBreak', 80);
    expect(own.result).toEqual({ outcome: 'victory', winnerId: ARENA_GLADIATORS.aster.id, reason: 'tie-break', tieBreakReason: 'simultaneous-defeat', finalHp: [0, 0] });
    expect(own.summary).toMatchObject({ result: 'victory', ratingDelta: 15 });
    const end = boutEnd('faustina') - startOf('faustina');
    expect(at('faustina', end / MIN).result).toMatchObject({ outcome: 'defeat', winnerId: ARENA_GLADIATORS.gallus.id, finalHp: [0, 0] });
    expect(at('gallus', end / MIN).result).toMatchObject({ outcome: 'victory', winnerId: ARENA_GLADIATORS.gallus.id, finalHp: [0, 0] });
  });
});

describe('arena stage audiences', () => {
  it('names each entrant of a human pair from its own timeline, with the same battle', () => {
    const bellator = at('bellator', 61);
    const corvina = at('corvina', 61);
    expect(bellator.bout!.battleId).toBe(corvina.bout!.battleId);
    expect([bellator.entrant!.name, bellator.opponent!.name]).toEqual(['Bellator', 'Corvina']);
    expect([corvina.entrant!.name, corvina.opponent!.name]).toEqual(['Corvina', 'Bellator']);
    expect([bellator.result!.outcome, corvina.result!.outcome]).toEqual(['victory', 'defeat']);
    // Without an entrant id, participant 0 is the entrant.
    expect(renderArenaStage(timeline('corvina'), startOf('corvina') + 61 * MIN).entrant!.name).toBe('Bellator');
  });

  it('never shows rewards to a spectator, even after minute 80', () => {
    const spectator = at('varroSpectator', 85);
    expect(spectator).toMatchObject({ phase: 'completed', summary: null, awaitingSummary: false });
    expect(spectator.result).toMatchObject({ outcome: 'defeat' });
    expect(JSON.stringify(spectator)).not.toMatch(/renown|ratingDelta|receipt/);
    // An owner timeline viewed as a spectator hides its summary as well.
    const hidden = at('ownerHumanWin', 85, false);
    expect(hidden).toMatchObject({ phase: 'completed', summary: null });
    expect(JSON.stringify(hidden)).not.toMatch(/renown|ratingDelta|receipt/);
  });

  it('hides every stage revealed after the display time, even when the timeline already holds it', () => {
    const s = at('bellator', 40);
    expect(s.stages).toHaveLength(1);
    expect(leaks(s, 'bellator')).toEqual([]);
    expect(at('ownerHumanWin', 79).stages).toHaveLength(2);
  });

  it('reads the phase from a public actor whose visible stage has no battle log', () => {
    const actor = ARENA_WORLD_ACTORS.find(a => a.name === 'Bellator')!;
    expect(arenaStageOfActor(actor, NOW)).toMatchObject({ phase: 'warming-up', startMs: SLOT_START, opponent: null, replay: null });
    const { battleLog: _log, ...bout } = timeline('bellator').stages[1];
    const revealed: PublicActor = { ...actor, visibleStage: bout };
    const running = arenaStageOfActor(revealed, bout.startedAtMs + 1000);
    expect(running).toMatchObject({ phase: 'bout', opponent: null, result: null, replay: { activityId: actor.activityId, stageId: bout.id } });
    expect(running.stages[0].label).toBe('Bout in progress');
    const done = arenaStageOfActor(revealed, bout.endsAtMs);
    expect(done).toMatchObject({ phase: 'completed', result: { outcome: 'victory' } });
    expect(arenaStageOfActor({ ...actor, visibleStage: null }, SLOT_START + 61 * MIN).phase).toBe('preparing');
    expect(arenaStageOfActor({ ...actor, activityId: null, visibleStage: null }, NOW).replay).toBeNull();
  });
});

describe('arena stage purity', () => {
  it('is deterministic, frozen, leaves its input untouched and reads no clock or randomness', () => {
    const now = vi.spyOn(Date, 'now');
    const random = vi.spyOn(Math, 'random');
    const perf = vi.spyOn(performance, 'now');
    const input: RevealedTimeline = structuredClone(timeline('ownerHumanWin'));
    const before = JSON.stringify(input);
    const t = startOf('ownerHumanWin') + 80 * MIN;
    const first = renderArenaStage(input, t, { entrantId: entrantOf('ownerHumanWin'), owner: true });
    const second = renderArenaStage(input, t, { entrantId: entrantOf('ownerHumanWin'), owner: true });
    expect(second).toEqual(first);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(first) && Object.isFrozen(first.stages) && Object.isFrozen(first.result) && Object.isFrozen(first.summary)).toBe(true);
    // The summary is a copy, never the caller's object; the log is shared by reference.
    expect(first.summary).not.toBe(input.summary);
    expect(first.bout!.log).toBe(input.stages[1].battleLog);
    expect([now, random, perf].map(spy => spy.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it('lists the display times when a fresh read may reveal more', () => {
    const S = startOf('ownerHumanWin');
    expect(arenaRevealMarks(at('ownerHumanWin', 30))).toEqual([S + 60 * MIN, S + 80 * MIN]);
    expect(arenaRevealMarks(at('ownerHumanWin', 70))).toEqual([S + 80 * MIN]);
    expect(arenaRevealMarks(at('ownerHumanWin', 80))).toEqual([]);
    expect(arenaRevealMarks(at('ownerDelayed', 65))).toEqual([startOf('ownerDelayed') + 80 * MIN]);
  });
});
