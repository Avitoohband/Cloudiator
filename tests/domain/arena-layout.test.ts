import { describe, expect, it } from 'vitest';
import type { RevealedTimeline } from '@contracts/events';
import type { PublicActor } from '@contracts/reads';
import { loadAssetManifest } from '@/game/assets';
import { findPath, gridFromMap, pathLength } from '@/game/paths';
import { layoutCamp } from '@/game/actors';
import { REPLAY_OUTRO_MS } from '@/game/replay';
import { ARENA_REVEAL_MS, ARENA_SLOT_MS } from '@/game/arena-stage';
import {
  ARENA_ENTRY_MS, ARENA_RESULT_HOLD_MS, arenaRings, arenaReadsDue, campArenaFights, fightStatus, ringTiles, scheduleArenaRings,
  type CampFight, type RingSlot,
} from '@/game/arena-layout';
import { ARENA_BATTLE_LOGS, ARENA_GLADIATORS, ARENA_TIMELINES, ARENA_WORLD_ACTORS, arenaBattleId } from '../fixtures/arena';
import { worldFixture } from '../fixtures/domain';

const manifest = loadAssetManifest();
const camp = manifest.maps.find(m => m.id === 'camp')!;
const MIN = 60_000;
const NOW = worldFixture.serverNowMs;
const S = NOW - (NOW % ARENA_SLOT_MS);
const timelines: ReadonlyMap<string, RevealedTimeline> = new Map(ARENA_WORLD_ACTORS.map(a => [a.activityId!, ARENA_TIMELINES[a.activityId!]]));
const fightsAt = (t: number, actors: readonly PublicActor[] = ARENA_WORLD_ACTORS, known = timelines) => campArenaFights(actors, known, t);
const inRing = (slot: RingSlot, t: number) => slot.enterAtMs <= t && t < slot.leaveAtMs;
const arenaActor = (i: number): PublicActor => ({
  gladiatorId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Gladiator ${i}`, classId: 'duelist', equipmentSilhouettes: ['weapon-sword'],
  league: 'bronze', level: 1, phase: 'morning', location: 'arena', activityId: `activity-${i}`, activityStatus: 'active', startsAtMs: S, endsAtMs: S + ARENA_SLOT_MS, visibleStage: null,
});

describe('arena sparring rings', () => {
  const rings = arenaRings(camp);

  it('has six bounded rings inside the arena wall, each a face-to-face pair of tiles', () => {
    expect(rings).toHaveLength(6);
    const tiles = new Set<string>();
    for (const ring of rings) {
      expect([ring.a.facing, ring.b.facing], `ring ${ring.index}`).toEqual(['se', 'sw']);
      // Side by side on screen: b is one tile east and one tile north of a, so the two face each other.
      expect([ring.b.x - ring.a.x, ring.b.y - ring.a.y]).toEqual([1, -1]);
      for (const p of [ring.a, ring.b]) {
        expect(camp.walkable[p.y][p.x], `${p.x},${p.y}`).toBe('1');
        expect(Math.hypot(p.x + 0.5 - camp.arena!.centre[0], p.y + 0.5 - camp.arena!.centre[1])).toBeLessThan(camp.arena!.radius - 1.1);
        tiles.add(`${p.x},${p.y}`);
      }
    }
    expect(tiles.size).toBe(12);
    expect(ringTiles(camp)).toEqual(tiles);
  });

  it('gives every arena tile time to walk into any ring before its camp bout starts', () => {
    const grid = gridFromMap(camp);
    const speed = manifest.actors.gladiator.walk.tilesPerSecond;
    const zone = camp.zones.find(z => z.id === 'arena')!;
    let longest = 0;
    for (let y = zone.bounds.y; y < zone.bounds.y + zone.bounds.h; y += 1) for (let x = zone.bounds.x; x < zone.bounds.x + zone.bounds.w; x += 1) {
      if (camp.walkable[y][x] !== '1' || Math.hypot(x + 0.5 - camp.arena!.centre[0], y + 0.5 - camp.arena!.centre[1]) > camp.arena!.radius - 1.1) continue;
      for (const ring of rings) for (const p of [ring.a, ring.b]) longest = Math.max(longest, pathLength(findPath(grid, { x, y }, p)!));
    }
    expect(longest).toBeGreaterThan(5);
    expect((longest / speed) * 1000).toBeLessThan(ARENA_ENTRY_MS);
  });

  it('keeps arena entrants in staging before any bout is known, never paired and never on a ring tile', () => {
    const reserved = ringTiles(camp);
    for (const count of [8, 22, 50]) {
      const actors = Array.from({ length: count }, (_, i) => arenaActor(i));
      const { placements } = layoutCamp(actors, camp, 373_248);
      expect(placements.size, `${count}`).toBe(count);
      expect(new Set([...placements.values()].map(p => `${p.x},${p.y}`)).size).toBe(count);
      for (const p of placements.values()) {
        expect(p.partnerId, 'no pairing is shown before reveal').toBeUndefined();
        expect(p.routine.variant).toBe('arena-staging');
        expect(reserved.has(`${p.x},${p.y}`), `${p.x},${p.y}`).toBe(false);
      }
    }
  });
});

describe('camp arena fights', () => {
  it('finds no fight before minute 60, then every revealed bout whose fighters are in camp', () => {
    expect(fightsAt(S + 40 * MIN)).toEqual([]);
    expect(fightsAt(S + ARENA_REVEAL_MS - 1)).toEqual([]);
    const fights = fightsAt(S + 61 * MIN);
    expect(fights).toHaveLength(7);
    expect(new Set(fights.map(f => f.battleId)).size).toBe(7);
    const byId = new Map(fights.map(f => [f.battleId, f]));
    const pair = byId.get(arenaBattleId('campOne'))!;
    expect(pair.fighters).toEqual([ARENA_GLADIATORS.bellator.id, ARENA_GLADIATORS.corvina.id]);
    const activity = (id: string) => ARENA_WORLD_ACTORS.find(a => a.gladiatorId === id)!.activityId;
    expect(pair.activities).toEqual([activity(ARENA_GLADIATORS.bellator.id), activity(ARENA_GLADIATORS.corvina.id)]);
    expect(pair.log).toBe(ARENA_BATTLE_LOGS.campOne);
    const npc = byId.get(arenaBattleId('campNpcOne'))!;
    expect(npc.fighters).toEqual([ARENA_GLADIATORS.valeria.id, null]);
    expect(npc.activities).toEqual([activity(ARENA_GLADIATORS.valeria.id), activity(ARENA_GLADIATORS.valeria.id)]);
    // The delayed entrant has no bout; fights are ordered by start, then battle id.
    expect(fights.some(f => f.fighters.includes(ARENA_GLADIATORS.ardea.id))).toBe(false);
    expect(fights.map(f => f.battleId)).toEqual([...fights.map(f => f.battleId)].sort());
  });

  it('pairs a human bout from either timeline alone, and skips it when the opponent is not in camp', () => {
    const corvina = ARENA_WORLD_ACTORS.find(a => a.name === 'Corvina')!;
    const one = new Map([[corvina.activityId!, ARENA_TIMELINES[corvina.activityId!]]]);
    expect(fightsAt(S + 61 * MIN, ARENA_WORLD_ACTORS, one).map(f => f.fighters)).toEqual([[ARENA_GLADIATORS.bellator.id, ARENA_GLADIATORS.corvina.id]]);
    expect(fightsAt(S + 61 * MIN, ARENA_WORLD_ACTORS.filter(a => a.name !== 'Bellator'), one)).toEqual([]);
    // Away from the arena (or not drawn at all) a timeline adds no fight.
    expect(fightsAt(S + 61 * MIN, ARENA_WORLD_ACTORS.map(a => ({ ...a, location: 'rest' as const })))).toEqual([]);
  });
});

describe('ring schedule', () => {
  const fights = fightsAt(S + 61 * MIN);
  const schedule = scheduleArenaRings(fights, 6);
  const slots = fights.map(f => schedule.get(f.battleId)!);

  it('puts the first six revealed bouts in their own rings at minute 60 and queues the seventh in staging', () => {
    expect(slots.slice(0, 6).map(s => s.ring)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const [i, slot] of slots.entries()) {
      const fight = fights[i];
      expect(slot.fightStartMs).toBe(slot.enterAtMs + ARENA_ENTRY_MS);
      expect(slot.leaveAtMs).toBe(slot.fightStartMs + fight.log.durationMs + REPLAY_OUTRO_MS + ARENA_RESULT_HOLD_MS);
    }
    for (const slot of slots.slice(0, 6)) expect(slot.enterAtMs).toBe(S + ARENA_REVEAL_MS);
    const seventh = slots[6];
    expect(seventh.enterAtMs).toBe(Math.min(...slots.slice(0, 6).map(s => s.leaveAtMs)));
    expect(slots.filter(s => s.ring === seventh.ring && s !== seventh).every(s => s.leaveAtMs <= seventh.enterAtMs)).toBe(true);
    expect(scheduleArenaRings(fights, 6)).toEqual(schedule);
  });

  it('never has more fights in the rings than rings, at any moment', () => {
    for (const ringCount of [1, 3, 6]) {
      const many = scheduleArenaRings(fights, ringCount);
      for (let t = S + ARENA_REVEAL_MS - 1000; t < S + ARENA_REVEAL_MS + 10 * MIN; t += 500) {
        const busy = [...many.values()].filter(slot => inRing(slot, t));
        expect(busy.length, `${ringCount} rings at ${t}`).toBeLessThanOrEqual(ringCount);
        expect(new Set(busy.map(s => s.ring)).size).toBe(busy.length);
      }
    }
  });

  it('keeps scheduled fights where they are when a late bout is revealed, and starts the late one no earlier than it is known', () => {
    // Three rings are still free, so only the reveal time holds the late bout back.
    const early = fights.slice(1, 4);
    const first = scheduleArenaRings(early, 6);
    const knownAtMs = S + ARENA_REVEAL_MS + 4000;
    const next = scheduleArenaRings(fights, 6, { previous: first, knownAtMs });
    for (const [id, slot] of first) expect(next.get(id), id).toEqual(slot);
    const late = next.get(fights[0].battleId)!;
    expect(late.enterAtMs).toBe(knownAtMs);
    expect([...next.values()].filter(s => s.ring === late.ring && s !== late).every(s => s.leaveAtMs <= late.enterAtMs || s.enterAtMs >= late.leaveAtMs)).toBe(true);
    // A fight that is no longer revealed drops out.
    expect(scheduleArenaRings(early.slice(1), 6, { previous: first, knownAtMs }).has(early[0].battleId)).toBe(false);
  });

  it('walks in, fights from the log, holds the result and returns to staging', () => {
    const slot = slots[0];
    const duration = fights[0].log.durationMs;
    expect(fightStatus(slot, duration, slot.enterAtMs - 1)).toEqual({ status: 'queued', positionMs: 0 });
    expect(fightStatus(slot, duration, slot.enterAtMs)).toEqual({ status: 'entering', positionMs: 0 });
    expect(fightStatus(slot, duration, slot.fightStartMs)).toEqual({ status: 'fighting', positionMs: 0 });
    expect(fightStatus(slot, duration, slot.fightStartMs + 1234)).toEqual({ status: 'fighting', positionMs: 1234 });
    expect(fightStatus(slot, duration, slot.fightStartMs + duration)).toEqual({ status: 'result', positionMs: duration });
    expect(fightStatus(slot, duration, slot.leaveAtMs - 1)).toEqual({ status: 'result', positionMs: duration + REPLAY_OUTRO_MS });
    expect(fightStatus(slot, duration, slot.leaveAtMs)).toEqual({ status: 'done', positionMs: duration + REPLAY_OUTRO_MS });
  });
});

describe('arena timeline reads for the camp', () => {
  const actors = ARENA_WORLD_ACTORS;
  const ids = (due: string[]) => [...due].sort();

  it('reads nothing before minute 60, then each arena entrant once, then retries only bouts still missing', () => {
    expect(arenaReadsDue(actors, new Map(), S + 40 * MIN)).toEqual([]);
    const at60 = S + ARENA_REVEAL_MS;
    expect(ids(arenaReadsDue(actors, new Map(), at60))).toEqual(ids(actors.map(a => a.activityId!)));
    const known = new Map(actors.map(a => [a.activityId!, { readAtMs: at60, hasBout: a.name !== 'Ardea' }]));
    expect(arenaReadsDue(actors, known, at60 + 10_000)).toEqual([]);
    const ardea = actors.find(a => a.name === 'Ardea')!.activityId!;
    expect(arenaReadsDue(actors, known, at60 + 30_000)).toEqual([ardea]);
    // The slot is over: no more polling for it.
    expect(arenaReadsDue(actors, known, S + ARENA_SLOT_MS + 10 * MIN)).toEqual([]);
  });

  it('reads at once when the public stage already shows the bout, and never for actors outside the arena', () => {
    const [first] = actors;
    const { battleLog: _log, ...bout } = ARENA_TIMELINES[first.activityId!].stages[1];
    const shown = [{ ...first, visibleStage: bout }, ...actors.slice(1).map(a => ({ ...a, location: 'training' as const }))];
    expect(arenaReadsDue(shown, new Map(), S + 40 * MIN)).toEqual([first.activityId]);
    expect(arenaReadsDue(shown, new Map([[first.activityId!, { readAtMs: S + 40 * MIN, hasBout: true }]]), S + 61 * MIN)).toEqual([]);
  });
});

// Typing check: the fixture fights satisfy the public shape the scene consumes.
const _shape: CampFight[] = fightsAt(S + 61 * MIN);
void _shape;
