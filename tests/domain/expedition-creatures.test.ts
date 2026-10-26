import { describe, expect, it } from 'vitest';
import { loadAssetManifest, type MapData } from '@/game/assets';
import { journeyMap } from '@/game/expedition-path';
import { renderExpeditionStage, type ExpeditionSceneState } from '@/game/expedition-stage';
import { REPLAY_OUTRO_MS } from '@/game/replay';
import { CREATURE_FADE_MS, creatureMode, fightCreatureAlpha, waitingCreatures, type CreatureMode } from '@/game/expedition-creatures';
import { planExpedition } from '../../supabase/functions/_shared/domain/expedition.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { deriveStats } from '../../supabase/functions/_shared/domain/stats.ts';
import type { ActivitySnapshot, BuildSnapshot } from '../../supabase/functions/_shared/domain/types.ts';
import { baseFiveBuild } from '../fixtures/domain';
import { EXPEDITION_FIXTURE_TIMELINES as T } from '../fixtures/expeditions';
import type { RevealedTimeline } from '../../supabase/functions/_shared/contracts/events.ts';

const MIN = 60_000;
const manifest = loadAssetManifest();
const ids = ['woodland', 'outpost', 'mountain'] as const;
const mapOf = (id: (typeof ids)[number]) => manifest.maps.find(m => m.id === id) as MapData;
const startOf = (t: RevealedTimeline) => t.stages[0].startedAtMs;
const fightOf = (t: RevealedTimeline, n: number) => t.stages.filter(s => s.kind === 'encounter')[n - 1];
/** The modes of encounters 1 to 3 at a display time. */
const modes = (t: RevealedTimeline, ms: number): CreatureMode[] => waitingCreatures(renderExpeditionStage(t, ms)).map(e => e.mode);
const atMinute = (t: RevealedTimeline, minute: number) => modes(t, startOf(t) + minute * MIN);
/** The poses end this long after a battle ends (src/game/replay.ts). */
const posesEnd = (t: RevealedTimeline, n: number) => fightOf(t, n).endsAtMs + REPLAY_OUTRO_MS;

describe('waiting creatures', () => {
  it('has all three creatures waiting before any encounter', () => {
    for (const key of ['woodland', 'outpost', 'mountain', 'spectator'] as const) {
      const t = T[key];
      expect(atMinute(t, 0), key).toEqual(['waiting', 'waiting', 'waiting']);
      expect(atMinute(t, 10), key).toEqual(['waiting', 'waiting', 'waiting']);
      expect(modes(t, fightOf(t, 1).startedAtMs - 1), key).toEqual(['waiting', 'waiting', 'waiting']);
    }
  });

  it('returns one entry per encounter 1 to 3, in order', () => {
    const state = renderExpeditionStage(T.woodland, startOf(T.woodland) + 10 * MIN);
    expect(waitingCreatures(state)).toEqual([{ encounter: 1, mode: 'waiting' }, { encounter: 2, mode: 'waiting' }, { encounter: 3, mode: 'waiting' }]);
    for (let n = 1; n <= 3; n += 1) expect(creatureMode(state, n)).toBe(waitingCreatures(state)[n - 1].mode);
  });

  it('has only the creature of the encounter being fought fighting, from the first moment of its battle to the end of its result poses', () => {
    const t = T.woodland;
    const fight = fightOf(t, 1);
    expect(modes(t, fight.startedAtMs)).toEqual(['fighting', 'waiting', 'waiting']);
    expect(modes(t, fight.startedAtMs + 2_000)).toEqual(['fighting', 'waiting', 'waiting']);
    expect(modes(t, fight.endsAtMs)).toEqual(['fighting', 'waiting', 'waiting']);
    expect(modes(t, posesEnd(t, 1))).toEqual(['fighting', 'waiting', 'waiting']);
    // The same at the second and the third encounter.
    expect(modes(t, fightOf(t, 2).startedAtMs + 1_000)).toEqual(['gone', 'fighting', 'waiting']);
    expect(modes(t, fightOf(t, 3).startedAtMs + 1_000)).toEqual(['gone', 'gone', 'fighting']);
  });

  it('keeps a beaten creature fighting while it fades after a victory, then has it gone', () => {
    const t = T.woodland;
    expect(modes(t, posesEnd(t, 1) + 1)).toEqual(['fighting', 'waiting', 'waiting']);
    expect(modes(t, posesEnd(t, 1) + CREATURE_FADE_MS - 1)).toEqual(['fighting', 'waiting', 'waiting']);
    expect(modes(t, posesEnd(t, 1) + CREATURE_FADE_MS)).toEqual(['gone', 'waiting', 'waiting']);
    expect(atMinute(t, 39)).toEqual(['gone', 'waiting', 'waiting']);
    expect(atMinute(t, 59)).toEqual(['gone', 'gone', 'waiting']);
    expect(atMinute(t, 79)).toEqual(['gone', 'gone', 'gone']);
    expect(atMinute(t, 80)).toEqual(['gone', 'gone', 'gone']);
  });

  it('opens mid-slot after a victory with the beaten creature gone and the next two waiting', () => {
    for (const key of ['woodland', 'outpost', 'mountain'] as const) expect(atMinute(T[key], 30), key).toEqual(['gone', 'waiting', 'waiting']);
    // An encounter that is not published yet (a worker delay) keeps its creature waiting.
    expect(atMinute(T.delayed, 45)).toEqual(['gone', 'waiting', 'waiting']);
  });

  it('has a creature that beat the gladiator stay once its result poses end, with the creature of an unfought encounter waiting', () => {
    const t = T.outpost; // lost at encounter 2
    expect(atMinute(t, 30)).toEqual(['gone', 'waiting', 'waiting']);
    expect(modes(t, fightOf(t, 2).startedAtMs + 3_000)).toEqual(['gone', 'fighting', 'waiting']);
    expect(modes(t, posesEnd(t, 2))).toEqual(['gone', 'fighting', 'waiting']);
    expect(modes(t, posesEnd(t, 2) + 1)).toEqual(['gone', 'stays', 'waiting']);
    expect(modes(t, posesEnd(t, 2) + CREATURE_FADE_MS + 5_000)).toEqual(['gone', 'stays', 'waiting']);
    for (const minute of [45, 59, 60, 65, 79, 80]) expect(atMinute(t, minute), `minute ${minute}`).toEqual(['gone', 'stays', 'waiting']);
    // The same for a defeat at the first and at the last encounter.
    expect(atMinute(T.spectator, 45)).toEqual(['stays', 'waiting', 'waiting']);
    expect(atMinute(T.mountain, 70)).toEqual(['gone', 'gone', 'stays']);
    expect(atMinute(T.mountain, 80)).toEqual(['gone', 'gone', 'stays']);
  });

  it('draws nothing the stage does not know of when the replays are pruned: finished encounters follow their outcome', () => {
    const t = T.expired;
    expect(fightOf(t, 1).battleLog).toBeUndefined();
    expect(atMinute(t, 30)).toEqual(['gone', 'waiting', 'waiting']);
    expect(atMinute(t, 80)).toEqual(['gone', 'gone', 'gone']);
  });

  it('only ever moves a creature forward: waiting, fighting, then gone after a win and staying after a loss', () => {
    const order: Record<CreatureMode, number> = { waiting: 0, fighting: 1, gone: 2, stays: 2 };
    for (const key of Object.keys(T) as (keyof typeof T)[]) {
      const t = T[key];
      const encounters = t.stages.filter(s => s.kind === 'encounter');
      const previous: number[] = [0, 0, 0];
      for (let ms = startOf(t); ms <= startOf(t) + 85 * MIN; ms += 2_300) {
        modes(t, ms).forEach((mode, i) => {
          expect(order[mode], `${key} encounter ${i + 1} at ${((ms - startOf(t)) / MIN).toFixed(2)} min`).toBeGreaterThanOrEqual(previous[i]);
          previous[i] = order[mode];
          const log = encounters[i]?.battleLog;
          if (mode === 'fighting' && encounters[i]) expect(ms, key).toBeGreaterThanOrEqual(encounters[i].startedAtMs);
          if (log && mode === 'gone') expect(log.winnerId, `${key} encounter ${i + 1}`).toBe(log.participants[0].id);
          if (log && mode === 'stays') expect(log.winnerId, `${key} encounter ${i + 1}`).toBe(log.participants[1].id);
          // An encounter that has not started, or is not published, never shows more than its waiting creature.
          if (!encounters[i] || ms < encounters[i].startedAtMs) expect(mode, `${key} encounter ${i + 1}`).toBe('waiting');
        });
      }
    }
  });

  it('shows nothing about an encounter before it starts: its waiting creature does not depend on its battle log', () => {
    const stripped: RevealedTimeline = { ...T.outpost, stages: T.outpost.stages.map(s => (s === fightOf(T.outpost, 2) ? { ...s, battleLog: undefined } : s)) };
    for (const ms of [startOf(T.outpost) + 25 * MIN, fightOf(T.outpost, 2).startedAtMs - 1]) expect(modes(stripped, ms)).toEqual(modes(T.outpost, ms));
  });
});

describe('a battle that has not started', () => {
  it('shows only a waiting creature, however the state came to hold it', () => {
    const t = T.woodland;
    const fight = fightOf(t, 1);
    const later = renderExpeditionStage(t, startOf(t) + 25 * MIN);
    // A battle log published ahead of its start (the server reveals at the start, but the scene never trusts that).
    const early = { ...renderExpeditionStage(t, fight.startedAtMs + 1_000), battle: { ...renderExpeditionStage(t, fight.startedAtMs + 1_000).battle!, elapsedMs: -1_000 } };
    expect(creatureMode(early, 1)).toBe('waiting');
    expect(fightCreatureAlpha(early.battle, false)).toBe(0);
    // A finished encounter's stage dated after the display time.
    expect(creatureMode({ ...later, displayNowMs: fight.startedAtMs - 1, battle: null }, 1)).toBe('waiting');
  });
});

describe('the fight creature', () => {
  const stateAt = (t: RevealedTimeline, ms: number): ExpeditionSceneState => renderExpeditionStage(t, ms);

  it('stays fully drawn through the fight and its result poses', () => {
    const t = T.woodland;
    for (const ms of [fightOf(t, 1).startedAtMs, fightOf(t, 1).startedAtMs + 3_000, posesEnd(t, 1)]) {
      expect(fightCreatureAlpha(stateAt(t, ms).battle!, false)).toBe(1);
      expect(fightCreatureAlpha(stateAt(t, ms).battle!, true)).toBe(1);
    }
  });

  it('fades a beaten creature over the fade time, or hides it at once with reduced motion', () => {
    const t = T.woodland;
    const at = (after: number, reduced: boolean) => fightCreatureAlpha(stateAt(t, posesEnd(t, 1) + after).battle!, reduced);
    expect(at(CREATURE_FADE_MS / 2, false)).toBeCloseTo(0.5, 5);
    expect(at(CREATURE_FADE_MS, false)).toBe(0);
    expect(at(1, true)).toBe(0);
  });

  it('hands a creature that won over to its idle sprite once the result poses end, at any motion setting', () => {
    const t = T.outpost;
    for (const reduced of [false, true]) {
      expect(fightCreatureAlpha(stateAt(t, posesEnd(t, 2)).battle!, reduced)).toBe(1);
      expect(fightCreatureAlpha(stateAt(t, posesEnd(t, 2) + 1).battle!, reduced)).toBe(0);
      expect(fightCreatureAlpha(stateAt(t, posesEnd(t, 2) + 60_000).battle!, reduced)).toBe(0);
    }
  });
});

describe('the encounter creatures of the map', () => {
  /** A strong player wins all three encounters of any expedition, so the plan holds every encounter. */
  function snapshot(expeditionId: (typeof ids)[number]): ActivitySnapshot {
    const build: BuildSnapshot = { ...baseFiveBuild, allocations: { strength: 300, agility: 5, vitality: 100, endurance: 5, precision: 5 } };
    return { activityId: 'ae449160-81a3-4057-a05f-ce6ba3a43e23', gladiatorId: '0d5f8471-d919-428f-9ab7-058c95821757',
      slotIndex: 300, rulesVersion: 'v1', cutoffMs: 300 * 4_800_000, choice: { kind: 'expedition', expeditionId }, scheduleVersion: 1,
      build, derived: deriveStats(build, RULES_V1), costs: RULES_V1.activityStamina, trainingPoints: 1,
      starting: { stamina: { current: 100, maximum: 100 }, level: 10, xp: 0, earnedPoints: 200, unspentPoints: 0,
        league: 'bronze', rating: 1000, peakStrength: 0, tournamentOptIn: false } };
  }

  it.each(ids)("map creatures match the server's encounter creatures on %s", id => {
    const plan = planExpedition(snapshot(id), 'waiting-creatures', RULES_V1);
    expect(plan.encounters).toHaveLength(3);
    const spots = journeyMap(mapOf(id)).encounters;
    plan.encounters.forEach((encounter, i) => {
      const participant = encounter.battleLog.participants[1].id;
      expect(participant, `${id} encounter ${i + 1}`).toBe(`creature:${spots[i].creature}:${i + 1}`);
      // Every drawn creature has idle art for the scene.
      const art = manifest.actors.creatures.find(c => c.id === spots[i].creature);
      expect(art?.expedition, `${id} ${spots[i].creature}`).toBe(id);
      expect(manifest.animations[art!.animations.idle!.se].frames.length, `${id} ${spots[i].creature}`).toBeGreaterThan(0);
    });
  });

  it('agrees with the creatures in the shipped fixture battle logs', () => {
    for (const key of ['woodland', 'outpost', 'mountain'] as const) {
      const spots = journeyMap(mapOf(key)).encounters;
      fightsOf(T[key]).forEach((stage, i) => expect(stage.battleLog!.participants[1].id).toBe(`creature:${spots[i].creature}:${i + 1}`));
    }
    function fightsOf(t: RevealedTimeline) { return t.stages.filter(s => s.kind === 'encounter'); }
  });

  it('puts every creature at its fight spot facing the gladiator, as the fight draws its right-hand fighter', () => {
    for (const id of ids) {
      for (const spot of journeyMap(mapOf(id)).encounters) {
        expect(spot.enemyFacing, id).toBe('sw');
        expect(spot.enemy, id).not.toEqual(spot.gladiator);
      }
    }
  });
});
