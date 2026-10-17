import { describe, expect, it } from 'vitest';
import type { BattleAction, BattleLog, RevealedCombatant, RevealedTimeline } from '@contracts/events';
import type { GameGateway } from '@/lib/api/gateway';
import { createFixtureGateway } from '@/lib/api/fixture-gateway';
import {
  REPLAY_OUTRO_MS,
  createReplayController,
  groupReplay,
  loadReplayView,
  reduceReplay,
  replayBattles,
  replayLines,
  replayViewOf,
  type ReplayController,
} from '@/game/replay';
import { FIXTURE_BATTLE_LOGS, REPLAY_FIXTURES, REPLAY_TIMELINES } from '../fixtures/battles';

const fighter = (id: string, name: string, maxHealth: number, initialHealth = maxHealth): RevealedCombatant => ({
  id, gladiatorId: id, name, classId: 'duelist', stance: 'balanced',
  attributes: { strength: 5, agility: 5, vitality: 5, endurance: 5, precision: 5 },
  maxHealth, initialHealth, armor: 0, weaponDamage: 6, attackIntervalMs: 1000, efficiencyBasisPoints: 10_000, equipmentSilhouettes: [],
});
const hit = (sequence: number, elapsedMs: number, attackerId: string, defenderId: string, damage: number, healthBefore: number, healthAfter: number, flags: Partial<BattleAction> = {}): BattleAction => ({
  kind: 'attack', sequence, elapsedMs, attackerId, defenderId, hit: damage > 0, critical: false, defend: false, evade: damage === 0,
  damage, healthBefore, healthAfter, ...flags,
});
/** Hand-written log: Bo starts hurt (30/40); an equal-time exchange at 1 s, then a finishing critical at 2 s. */
const small: BattleLog = {
  battleId: 'small', rulesVersion: 'v1', participants: [fighter('a', 'Ava', 50), fighter('b', 'Bo', 40, 30)],
  events: [
    hit(0, 1000, 'a', 'b', 12, 30, 18),
    hit(1, 1000, 'b', 'a', 0, 50, 50),
    hit(2, 2000, 'a', 'b', 18, 18, 0, { critical: true }),
    { kind: 'victory', sequence: 3, elapsedMs: 2000, winnerId: 'a', loserId: 'b', reason: 'defeat' },
  ],
  durationMs: 2000, winnerId: 'a', victoryReason: 'defeat', finalHp: [50, 0], tieBreakReason: null,
};
const logs = Object.entries(FIXTURE_BATTLE_LOGS);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}
/** Irregular but deterministic frame times (ms), like a browser that drops frames. */
function frameTimes(seed: number) {
  let s = seed;
  return () => { s = (s * 48271) % 2147483647; return 4 + (s % 47); };
}
function runToEnd(controller: ReplayController, seed = 1) {
  const next = frameTimes(seed);
  let realMs = 0;
  for (let i = 0; i < 1_000_000 && controller.playing; i += 1) { const dt = next(); realMs += dt; controller.tick(dt); }
  return realMs;
}

/** Plays a fixture activity the way the replay page does: one timeline read, then local playback only. */
function replayHarness(activityId: string) {
  const calls: Record<string, number> = {};
  const base = createFixtureGateway();
  const gateway = new Proxy(base, {
    get(target, key: keyof GameGateway) {
      const method = target[key];
      return (...args: unknown[]) => { calls[key] = (calls[key] ?? 0) + 1; return (method as (...a: unknown[]) => unknown).apply(target, args); };
    },
  });
  const controllerFor = async () => {
    const view = await loadReplayView(gateway, activityId);
    if (view.kind !== 'replay') throw new Error(`expected a replay, got ${view.kind}`);
    return createReplayController(view.battles[0].log);
  };
  return {
    calls,
    get commandCalls() { return calls.command ?? 0; },
    async playAt(factor: 1 | 4) {
      const c = await controllerFor();
      c.setSpeed(factor === 4 ? 'fast' : 'normal');
      c.play();
      const realMs = runToEnd(c, factor);
      return { final: c.frame, realMs, endMs: c.endMs };
    },
    async restartThenSkip() {
      const c = await controllerFor();
      c.play();
      c.tick(700);
      c.restart();
      c.skipToResult();
      return c.frame.result!;
    },
  };
}

describe('reduceReplay', () => {
  it.each(logs)('reaches the logged final health and winner for %s', (_name, log) => {
    expect(reduceReplay(log, log.durationMs).hp).toEqual(log.finalHp);
    expect(reduceReplay(log, log.durationMs).result?.winnerId).toBe(log.winnerId);
    expect(reduceReplay(log, Number.MAX_SAFE_INTEGER).hp).toEqual(log.finalHp);
  });

  it('starts from the logged initial health, before any group', () => {
    const frame = reduceReplay(small, 999);
    expect(frame).toMatchObject({ throughMs: 999, hp: [50, 30], maxHp: [50, 40], groupIndex: -1, group: null, appliedEvents: 0, finished: false, result: null });
  });

  it('applies events with the same time together as one group', () => {
    const frame = reduceReplay(small, 1000);
    expect(frame.hp).toEqual([50, 18]);
    expect(frame.groupIndex).toBe(0);
    expect(frame.group?.elapsedMs).toBe(1000);
    expect(frame.group?.events.map(e => e.sequence)).toEqual([0, 1]);
    expect(frame.appliedEvents).toBe(2);
    expect(groupReplay(small).map(g => g.events.map(e => e.sequence))).toEqual([[0, 1], [2, 3]]);
    // Every equal-time group of a real log is applied whole or not at all.
    const log = FIXTURE_BATTLE_LOGS.npc;
    const shared = groupReplay(log).filter(g => g.events.filter(e => e.kind === 'attack').length === 2);
    expect(shared.length).toBeGreaterThan(3);
    for (const g of shared) {
      expect(reduceReplay(log, g.elapsedMs - 1).appliedEvents).toBe(g.events[0].sequence);
      expect(reduceReplay(log, g.elapsedMs).appliedEvents).toBe(g.events[g.events.length - 1].sequence + 1);
    }
  });

  it('reports the result once the victory is reached, including the tie-break cause', () => {
    expect(reduceReplay(small, 1999)).toMatchObject({ finished: false, result: null });
    expect(reduceReplay(small, 2500)).toMatchObject({
      throughMs: 2000, hp: [50, 0], groupIndex: 1, finished: true,
      result: { winnerId: 'a', loserId: 'b', victoryReason: 'defeat', tieBreakReason: null },
    });
    const tie = FIXTURE_BATTLE_LOGS.tie;
    expect(reduceReplay(tie, tie.durationMs).result).toEqual({
      winnerId: tie.winnerId, loserId: tie.participants.find(p => p.id !== tie.winnerId)!.id, victoryReason: 'tie-break', tieBreakReason: 'simultaneous-defeat',
    });
  });

  it('takes health from the logged healthAfter and never recomputes it from damage', () => {
    const odd: BattleLog = { ...small, events: [hit(0, 1000, 'a', 'b', 5, 30, 21), small.events[3]], finalHp: [50, 21] };
    expect(reduceReplay(odd, 1000).hp).toEqual([50, 21]);
  });

  it.each(logs)('never lets health diverge from the log in %s', (_name, log) => {
    const latest = new Map(log.participants.map(p => [p.id, p.initialHealth]));
    for (const event of log.events) {
      if (event.kind !== 'attack') continue;
      expect(event.healthBefore, `sequence ${event.sequence}`).toBe(latest.get(event.defenderId));
      latest.set(event.defenderId, event.healthAfter);
      const frame = reduceReplay(log, event.elapsedMs);
      // Later events of the same group may hit the other fighter; this defender's value is final.
      const index = log.participants.findIndex(p => p.id === event.defenderId);
      expect(frame.hp[index]).toBe(event.healthAfter);
    }
  });

  it('never mutates the log and returns frozen frames without rewards', () => {
    const log = deepFreeze(structuredClone(FIXTURE_BATTLE_LOGS.pvp));
    const frame = reduceReplay(log, log.durationMs / 2);
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen(frame.hp)).toBe(true);
    expect(Object.keys(frame).sort()).toEqual(['appliedEvents', 'finished', 'group', 'groupIndex', 'hp', 'maxHp', 'result', 'throughMs']);
    expect(JSON.stringify(log)).toBe(JSON.stringify(FIXTURE_BATTLE_LOGS.pvp));
  });
});

describe('replay controller', () => {
  it.each(Object.values(REPLAY_FIXTURES).filter(f => 'battleId' in f || 'battleIds' in f).map(f => f.activityId))('gives the same final state at every speed and never commands (%s)', async activityId => {
    const replayHarness_ = replayHarness(activityId);
    const normal = await replayHarness_.playAt(1);
    const fast = await replayHarness_.playAt(4);
    expect(normal.final).toEqual(fast.final);
    const log = REPLAY_TIMELINES[activityId].stages.find(s => s.battleLog)!.battleLog!;
    expect(normal.final.hp).toEqual(log.finalHp);
    expect((await replayHarness_.restartThenSkip()).winnerId).toBe(log.winnerId);
    expect(replayHarness_.commandCalls).toBe(0);
    expect(replayHarness_.calls).toEqual({ timeline: 3 });
    // Fast playback reaches the end in a quarter of the real time (to within one frame).
    expect(Math.abs(normal.realMs - normal.endMs)).toBeLessThanOrEqual(50);
    expect(Math.abs(fast.realMs - normal.endMs / 4)).toBeLessThanOrEqual(50);
  });

  it('plays through the result and a short outro, then stops', () => {
    const c = createReplayController(small);
    expect(c.endMs).toBe(small.durationMs + REPLAY_OUTRO_MS);
    expect(c.playing).toBe(false);
    c.play();
    c.tick(1999);
    expect(c.frame.finished).toBe(false);
    c.tick(1);
    expect(c.frame.finished).toBe(true);
    expect(c.playing).toBe(true);
    c.tick(REPLAY_OUTRO_MS);
    expect(c.playing).toBe(false);
    expect(c.positionMs).toBe(c.endMs);
    c.tick(5000);
    expect(c.positionMs).toBe(c.endMs);
  });

  it('is independent of frame rate', () => {
    const steady = createReplayController(FIXTURE_BATTLE_LOGS.pvp);
    const jerky = createReplayController(FIXTURE_BATTLE_LOGS.pvp);
    steady.play(); jerky.play();
    for (let i = 0; i < 600; i += 1) steady.tick(16);
    for (let i = 0; i < 96; i += 1) jerky.tick(100);
    expect(steady.positionMs).toBe(9600);
    expect(jerky.positionMs).toBe(9600);
    expect(steady.frame).toEqual(jerky.frame);
    expect(steady.frame).toEqual(reduceReplay(FIXTURE_BATTLE_LOGS.pvp, 9600));
  });

  it('seeks, clamps, restarts and skips to the result', () => {
    const log = FIXTURE_BATTLE_LOGS.pvp;
    const c = createReplayController(log);
    c.seek(5000);
    expect(c.positionMs).toBe(5000);
    expect(c.frame).toEqual(reduceReplay(log, 5000));
    c.seek(-40);
    expect(c.positionMs).toBe(0);
    c.seek(10 ** 9);
    expect(c.positionMs).toBe(c.endMs);
    c.restart();
    expect(c.positionMs).toBe(0);
    expect(c.playing).toBe(true);
    expect(c.frame.hp).toEqual([log.participants[0].initialHealth, log.participants[1].initialHealth]);
    c.tick(3000);
    c.skipToResult();
    expect(c.playing).toBe(false);
    expect(c.positionMs).toBe(c.endMs);
    expect(c.frame).toMatchObject({ finished: true, hp: log.finalHp, result: { winnerId: log.winnerId } });
    // Play after the end starts again from the beginning.
    c.play();
    expect(c.positionMs).toBe(0);
    expect(c.playing).toBe(true);
  });

  it('pauses, resumes and changes speed without moving the position', () => {
    const c = createReplayController(small);
    c.play();
    c.tick(500);
    c.pause();
    c.tick(800);
    expect(c.positionMs).toBe(500);
    c.setSpeed('fast');
    expect(c.positionMs).toBe(500);
    c.play();
    c.tick(100);
    expect(c.positionMs).toBe(900);
    c.setSpeed('normal');
    c.tick(100);
    expect(c.positionMs).toBe(1000);
    expect(c.speed).toBe('normal');
  });

  it('tells subscribers about discrete changes and lets them leave', () => {
    const c = createReplayController(small);
    const seen: string[] = [];
    const off = c.subscribe(() => seen.push(`${c.playing ? 'play' : 'pause'}:${c.speed}:${c.frame.groupIndex}:${c.frame.finished}`));
    expect(c.listenerCount()).toBe(1);
    c.play();
    c.tick(400); // no new group: no notice
    c.tick(600); // first group
    c.setSpeed('fast');
    c.skipToResult();
    expect(seen).toEqual(['play:normal:-1:false', 'play:normal:0:false', 'play:fast:0:false', 'pause:fast:1:true']);
    off();
    expect(c.listenerCount()).toBe(0);
    c.restart();
    expect(seen).toHaveLength(4);
  });

  it('exposes read-only state', () => {
    const c = createReplayController(small);
    expect(Object.isFrozen(c.frame)).toBe(true);
    expect(() => { (c as { positionMs: number }).positionMs = 50; }).toThrow();
  });
});

describe('readable log', () => {
  it('describes every hit, miss, critical, guard and the result with the logged numbers', () => {
    const guarded: BattleLog = { ...small, events: [hit(0, 1250, 'a', 'b', 7, 30, 23, { defend: true }), small.events[1], small.events[2], small.events[3]] };
    expect(replayLines(guarded).map(l => [l.groupIndex, l.text])).toEqual([
      [0, '1.25 s · Ava hits Bo for 7 damage; Bo’s defensive stance softens the blow. Bo 30 → 23 HP.'],
      [1, '1.00 s · Bo attacks Ava and misses: Ava evades.'],
      [2, '2.00 s · Ava lands a critical hit on Bo for 18 damage. Bo 18 → 0 HP.'],
      [2, '2.00 s · Bo is defeated. Ava wins.'],
    ]);
    expect(replayLines(small)[0].text).toBe('1.00 s · Ava hits Bo for 12 damage. Bo 30 → 18 HP.');
  });

  it('explains time-limit and tie-break results', () => {
    const victory = (reason: 'health-fraction' | 'tie-break') => ({ kind: 'victory' as const, sequence: 1, elapsedMs: 120_000, winnerId: 'b', loserId: 'a', reason });
    const timed = (reason: 'health-fraction' | 'tie-break', tieBreakReason: BattleLog['tieBreakReason']): BattleLog => ({
      ...small, events: [hit(0, 1000, 'a', 'b', 12, 30, 18), victory(reason)], durationMs: 120_000, winnerId: 'b', victoryReason: reason, finalHp: [50, 18], tieBreakReason,
    });
    expect(replayLines(timed('health-fraction', null)).at(-1)!.text).toBe('120.00 s · Time is up. Bo wins with the larger share of health left.');
    expect(replayLines(timed('tie-break', 'equal-health-fraction')).at(-1)!.text).toBe('120.00 s · Time is up with equal shares of health. A seeded tie-break names Bo the winner.');
    expect(replayLines(timed('tie-break', 'simultaneous-defeat')).at(-1)!.text).toBe('120.00 s · Both fighters fall at the same moment. A seeded tie-break names Bo the winner.');
  });

  it('lists every fixture event once, in order', () => {
    for (const [, log] of logs) expect(replayLines(log).map(l => l.sequence)).toEqual(log.events.map(e => e.sequence));
  });
});

describe('replay views', () => {
  const timeline = (id: string) => structuredClone(REPLAY_TIMELINES[id]);

  it('offers every revealed battle of a timeline, the requested one first', () => {
    const view = replayViewOf(timeline(REPLAY_FIXTURES.expedition.activityId), 'woodland-encounter-2');
    expect(view.kind).toBe('replay');
    if (view.kind !== 'replay') return;
    expect(view.battles.map(b => b.stage.id)).toEqual(['woodland-encounter-1', 'woodland-encounter-2', 'woodland-encounter-3']);
    expect(view.selected).toBe(1);
    expect(view.summary?.rewards.xp).toBe(100);
    expect(replayViewOf(timeline(REPLAY_FIXTURES.expedition.activityId), 'nope')).toMatchObject({ kind: 'replay', selected: 0 });
  });

  it('shows the saved summary when the replay has expired, even if a log is still attached', () => {
    const expired = timeline(REPLAY_FIXTURES.expired.activityId);
    expect(replayViewOf(expired)).toEqual({ kind: 'summary', reason: 'expired', summary: expired.summary });
    const stale = timeline(REPLAY_FIXTURES.pvp.activityId);
    stale.summary = { ...stale.summary!, replayExpiry: { state: 'expired' } };
    expect(replayViewOf(stale)).toMatchObject({ kind: 'summary', reason: 'expired' });
  });

  it('shows the saved summary when no battle stage was kept, and nothing when there is no summary either', () => {
    const missing: RevealedTimeline = { ...timeline(REPLAY_FIXTURES.pvp.activityId), stages: [] };
    expect(replayViewOf(missing)).toMatchObject({ kind: 'summary', reason: 'missing', summary: { rewards: { renown: 10 } } });
    expect(replayViewOf({ ...missing, summary: undefined })).toEqual({ kind: 'unavailable', reason: 'not-revealed' });
  });

  it('turns failed reads into an unavailable view', async () => {
    const gateway = createFixtureGateway();
    await expect(loadReplayView(gateway, '9fce3cd5-e831-4a66-8ca1-16b4576b1499')).resolves.toEqual({ kind: 'unavailable', reason: 'unavailable' });
    const notFound = { timeline: async () => { throw Object.assign(new Error('not-found'), { code: 'not-found' }); } };
    await expect(loadReplayView(notFound, 'x')).resolves.toEqual({ kind: 'unavailable', reason: 'not-found' });
  });
});

describe('replay battles by display time (Task 15 review Minor 2)', () => {
  const view = replayViewOf(structuredClone(REPLAY_TIMELINES[REPLAY_FIXTURES.expedition.activityId]));
  if (view.kind !== 'replay') throw new Error('the expedition fixture is a replay');
  /** A battle ends when its logged fight does: its start plus the log's duration (the server's published bout end). */
  const endOf = (n: number) => view.battles[n].stage.startedAtMs + view.battles[n].log.durationMs;
  const endOfFirstBattle = endOf(0);

  it('keeps only the battles that ended by the display time', () => {
    expect(replayBattles(view, endOfFirstBattle - 1).map(b => b.stage.id)).toEqual([]);
    expect(replayBattles(view, endOfFirstBattle).map(b => b.stage.id)).toEqual(['woodland-encounter-1']);
    // A battle in progress (its log is revealed when it starts) is never offered under its server label.
    expect(replayBattles(view, view.battles[1].stage.startedAtMs + 1).map(b => b.stage.id)).toEqual(['woodland-encounter-1']);
    expect(replayBattles(view, endOf(2)).map(b => b.stage.id)).toEqual(['woodland-encounter-1', 'woodland-encounter-2', 'woodland-encounter-3']);
  });

  it('offers no battle for a saved outcome or an unavailable replay', () => {
    expect(replayBattles({ kind: 'unavailable', reason: 'not-revealed' }, endOf(2))).toEqual([]);
    expect(replayBattles(replayViewOf(structuredClone(REPLAY_TIMELINES[REPLAY_FIXTURES.expired.activityId])), endOf(2))).toEqual([]);
  });

  it("ends an Arena bout with its logged fight, not with a stage that runs to the slot's minute 80", () => {
    const tie = replayViewOf(structuredClone(REPLAY_TIMELINES[REPLAY_FIXTURES.tie.activityId]));
    if (tie.kind !== 'replay') throw new Error('the tie fixture is a replay');
    const [bout] = tie.battles;
    const ended = bout.stage.startedAtMs + bout.log.durationMs;
    expect(bout.stage.endsAtMs).toBeGreaterThan(ended);
    expect(replayBattles(tie, ended - 1)).toEqual([]);
    expect(replayBattles(tie, ended)).toHaveLength(1);
  });
});
