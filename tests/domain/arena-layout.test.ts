import { describe, expect, it } from 'vitest';
import type { RevealedTimeline } from '@contracts/events';
import type { PublicActor } from '@contracts/reads';
import { loadAssetManifest } from '@/game/assets';
import { findPath, gridFromMap, pathLength } from '@/game/paths';
import { layoutCamp } from '@/game/actors';
import { REPLAY_OUTRO_MS } from '@/game/replay';
import { ARENA_REVEAL_MS, ARENA_SLOT_MS, renderArenaStage } from '@/game/arena-stage';
import {
  ARENA_ENTRY_MS, ARENA_GATE, ARENA_JOG_PACE, ARENA_RESULT_HOLD_MS, arenaFightButton, arenaRings, arenaReadsDue, campArenaFights, fightStatus, ringTiles, scheduleArenaRings,
  updateRingSchedule, type CampFight, type RingSlot,
} from '@/game/arena-layout';
import type { ArenaFightSummary } from '@/game/bridge';
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

  it('gives every arena tile and the arena gate time to jog into any ring before its camp bout starts, with little slack', () => {
    const grid = gridFromMap(camp);
    // Pairs jog in at three times the manifest walk (about 3 tiles/s); the walk back to staging keeps the walking pace.
    const jog = manifest.actors.gladiator.walk.tilesPerSecond * ARENA_JOG_PACE;
    expect(jog).toBeGreaterThanOrEqual(2.5);
    expect(jog).toBeLessThanOrEqual(3.5);
    const zone = camp.zones.find(z => z.id === 'arena')!;
    const starts = [ARENA_GATE];
    for (let y = zone.bounds.y; y < zone.bounds.y + zone.bounds.h; y += 1) for (let x = zone.bounds.x; x < zone.bounds.x + zone.bounds.w; x += 1) {
      if (camp.walkable[y][x] !== '1' || Math.hypot(x + 0.5 - camp.arena!.centre[0], y + 0.5 - camp.arena!.centre[1]) > camp.arena!.radius - 1.1) continue;
      starts.push({ x, y });
    }
    let longest = 0;
    for (const from of starts) for (const ring of rings) for (const p of [ring.a, ring.b]) longest = Math.max(longest, pathLength(findPath(grid, from, p)!));
    expect(longest).toBeGreaterThan(5);
    const jogMs = (longest / jog) * 1000;
    expect(jogMs).toBeLessThan(ARENA_ENTRY_MS);
    // The ring plays each bout at its real time from the arrival, so a loose walk-in bound would hide the bout.
    expect(ARENA_ENTRY_MS - jogMs).toBeLessThan(1000);
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

  it('keeps an NPC fallback logged as participant 0 on its own side, and opens its entrant from either side', () => {
    const valeria = ARENA_WORLD_ACTORS.find(a => a.name === 'Valeria')!;
    const flipped: RevealedTimeline = structuredClone(ARENA_TIMELINES[valeria.activityId!]);
    const log = flipped.stages.find(s => s.kind === 'bout')!.battleLog!;
    Object.assign(log, { participants: [log.participants[1], log.participants[0]], finalHp: [log.finalHp[1], log.finalHp[0]] });
    const [fight] = fightsAt(S + 61 * MIN, [valeria], new Map([[valeria.activityId!, flipped]]));
    const fighters: readonly [string | null, string | null] = fight.fighters;
    expect(fighters).toEqual([null, ARENA_GLADIATORS.valeria.id]);
    expect(fight.activities).toEqual([valeria.activityId, valeria.activityId]);
    // The keyboard button names the gladiator first and the NPC second, and opens the gladiator's card.
    const side = (gladiatorId: string | null, name: string) => ({ gladiatorId, name, activityId: valeria.activityId!, npc: gladiatorId === null });
    const npcFirst: ArenaFightSummary = { battleId: fight.battleId, status: 'fighting', sides: [side(null, 'Iron Warden'), side(ARENA_GLADIATORS.valeria.id, 'Valeria')] };
    expect(arenaFightButton(npcFirst)).toEqual({ label: 'Valeria vs Iron Warden (NPC)', entrant: npcFirst.sides[1] });
    const npcSecond: ArenaFightSummary = { ...npcFirst, sides: [npcFirst.sides[1], npcFirst.sides[0]] };
    expect(arenaFightButton(npcSecond)).toEqual({ label: 'Valeria vs Iron Warden (NPC)', entrant: npcFirst.sides[1] });
    const human: ArenaFightSummary = { ...npcFirst, sides: [side(ARENA_GLADIATORS.bellator.id, 'Bellator'), side(ARENA_GLADIATORS.corvina.id, 'Corvina')] };
    expect(arenaFightButton(human)).toEqual({ label: 'Bellator vs Corvina', entrant: human.sides[0] });
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
      expect(slot.boutStartMs).toBe(fight.startedAtMs);
      expect(slot.fightStartMs).toBe(slot.enterAtMs + ARENA_ENTRY_MS);
      // The pair leaves after the bout's real end (plus the outro) or its own arrival, whichever is later, and the hold.
      expect(slot.leaveAtMs).toBe(Math.max(slot.fightStartMs, fight.startedAtMs + fight.log.durationMs + REPLAY_OUTRO_MS) + ARENA_RESULT_HOLD_MS);
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

  it('plans fights in start, then battle-id order, whatever order they are given in', () => {
    const shuffled = [fights[3], fights[6], fights[0], fights[5], fights[1], fights[4], fights[2]];
    expect(scheduleArenaRings(shuffled, 6)).toEqual(schedule);
    expect(scheduleArenaRings([...fights].reverse(), 3)).toEqual(scheduleArenaRings(fights, 3));
  });

  it('plans fights still queued again with the ones learned later, so the queue converges on one order (Task 19 R4)', () => {
    // Eleven bouts revealed together: six fit the rings, the rest queue. One viewer learns all of them at once; another
    // learns eight first and three a second later, before any queued bout has entered its ring.
    const eleven = 'abcdefghijk'.split('').map((letter, i): CampFight => ({ ...fights[i % fights.length], startedAtMs: S + ARENA_REVEAL_MS, battleId: `bout-${letter}` }));
    const late = new Set(['bout-g', 'bout-i', 'bout-k']);
    const whole = scheduleArenaRings(eleven, 6);
    const first = scheduleArenaRings(eleven.filter(f => !late.has(f.battleId)), 6);
    const knownAtMs = S + ARENA_REVEAL_MS + 1000;
    expect([...first.values()].filter(s => s.enterAtMs > knownAtMs).map(s => s.battleId)).toEqual(['bout-h', 'bout-j']);
    const next = scheduleArenaRings(eleven, 6, { previous: first, knownAtMs });
    // The six in the rings stay where they are; the queue is the same as the first viewer's.
    for (const id of 'abcdef') expect(next.get(`bout-${id}`)).toEqual(first.get(`bout-${id}`));
    expect(next).toEqual(whole);
  });

  it('keeps the fights still shown when the camp’s fights change, and plans the first ones from their logged times', () => {
    // The camp scene's rule (camp-scene.ts): the first fights the camp learns show where their logged times put them.
    expect(updateRingSchedule(new Map(), fights, 6, S + 70 * MIN)).toEqual(schedule);
    // Later, a fight that is no longer shown drops out, the others keep their rings, and a new one starts no earlier than now.
    const now = S + ARENA_REVEAL_MS + 4000;
    const shown = updateRingSchedule(scheduleArenaRings(fights.slice(1, 4), 6), fights.slice(0, 3), 6, now);
    expect([...shown.keys()].sort()).toEqual(fights.slice(0, 3).map(f => f.battleId).sort());
    for (const f of fights.slice(1, 3)) expect(shown.get(f.battleId)).toEqual(scheduleArenaRings(fights.slice(1, 4), 6).get(f.battleId));
    expect(shown.get(fights[0].battleId)!.enterAtMs).toBe(now);
  });

  it('walks in, plays the bout at its real time from the arrival, holds the result and returns to staging', () => {
    const slot = slots[0];
    const fight = fights[0];
    const duration = fight.log.durationMs;
    const end = fight.startedAtMs + duration;
    expect(fightStatus(slot, duration, slot.enterAtMs - 1)).toEqual({ status: 'queued', positionMs: 0 });
    expect(fightStatus(slot, duration, slot.enterAtMs)).toEqual({ status: 'entering', positionMs: 0 });
    // Arriving at the walk-in bound skips what the bout has already shown; an earlier arrival plays from its real time.
    expect(fightStatus(slot, duration, slot.fightStartMs)).toEqual({ status: 'fighting', positionMs: slot.fightStartMs - fight.startedAtMs });
    expect(fightStatus(slot, duration, fight.startedAtMs + 1234, true)).toEqual({ status: 'fighting', positionMs: 1234 });
    expect(fightStatus(slot, duration, end - 1)).toEqual({ status: 'fighting', positionMs: duration - 1 });
    expect(fightStatus(slot, duration, end)).toEqual({ status: 'result', positionMs: duration });
    expect(fightStatus(slot, duration, slot.leaveAtMs - 1)).toEqual({ status: 'result', positionMs: duration + REPLAY_OUTRO_MS });
    expect(fightStatus(slot, duration, slot.leaveAtMs)).toEqual({ status: 'done', positionMs: duration + REPLAY_OUTRO_MS });
  });

  it('ends every ring fight exactly when the Arena card completes it, and never shows a result early', () => {
    for (const [i, fight] of fights.entries()) {
      const slot = slots[i];
      const duration = fight.log.durationMs;
      const end = fight.startedAtMs + duration;
      const timeline = ARENA_TIMELINES[fight.activities[0]];
      const entrant = fight.fighters[0] ?? fight.fighters[1];
      const card = (t: number) => renderArenaStage(timeline, t, { entrantId: entrant }).result;
      expect(timeline.stages.find(s => s.kind === 'bout')!.endsAtMs, fight.battleId).toBe(end);
      for (let t = fight.startedAtMs - 1000; t <= slot.leaveAtMs + 1000; t += 250) {
        for (const arrived of [false, true]) {
          const { status, positionMs } = fightStatus(slot, duration, t, arrived);
          if (status === 'fighting') {
            expect(card(t), `${fight.battleId} at ${t - fight.startedAtMs} ms`).toBeNull();
            expect(positionMs).toBe(t - fight.startedAtMs);
          }
          if (status === 'result') {
            expect(card(t), `${fight.battleId} at ${t - fight.startedAtMs} ms`).not.toBeNull();
            expect(positionMs).toBe(Math.min(duration + REPLAY_OUTRO_MS, t - fight.startedAtMs));
          }
        }
      }
      // A pair in its ring on time: the fight and the card change over at the same display time.
      if (slot.fightStartMs < end) {
        expect([fightStatus(slot, duration, end - 1).status, card(end - 1)]).toEqual(['fighting', null]);
        expect(fightStatus(slot, duration, end).status).toBe('result');
        expect(card(end)).not.toBeNull();
      }
    }
  });

  it('changes ring and card over together at the bout’s end, even when its stage publishes another end', () => {
    // Task 23.5 (C19): one definition of an ended bout, `boutEndMs`, its logged end (the server publishes exactly that as
    // the stage's end), shared by the ring, the card and the replay. A stage whose published end differs (as the replay
    // fixtures' 60–80 minute bout stages do) changes nothing: ring and card still change over together, at the logged end.
    const bellator = ARENA_WORLD_ACTORS.find(a => a.name === 'Bellator')!;
    const pair = ARENA_WORLD_ACTORS.filter(a => a.name === 'Bellator' || a.name === 'Corvina');
    for (const shift of [-1500, 1500]) {
      const timeline: RevealedTimeline = structuredClone(ARENA_TIMELINES[bellator.activityId!]);
      const stage = timeline.stages.find(s => s.kind === 'bout')!;
      const end = stage.endsAtMs;
      stage.endsAtMs += shift;
      const [fight] = fightsAt(S + 61 * MIN, pair, new Map([[bellator.activityId!, timeline]]));
      const duration = fight.log.durationMs;
      expect(end - fight.startedAtMs - duration).toBe(0);
      expect(stage.endsAtMs - end).toBe(shift);
      expect(fight.endsAtMs).toBe(end);
      const slot = scheduleArenaRings([fight], 6).get(fight.battleId)!;
      expect(slot.boutEndsAtMs).toBe(end);
      expect(slot.leaveAtMs).toBe(Math.max(slot.fightStartMs, end + REPLAY_OUTRO_MS) + ARENA_RESULT_HOLD_MS);
      const card = (t: number) => renderArenaStage(timeline, t, { entrantId: bellator.gladiatorId }).result;
      for (let t = fight.startedAtMs; t <= slot.leaveAtMs + 1000; t += 250) {
        for (const arrived of [false, true]) {
          const { status, positionMs } = fightStatus(slot, duration, t, arrived);
          // A fighting ring never reaches the logged result poses, and a ring showing the result never fights on.
          if (status === 'fighting') expect([card(t), positionMs < duration], `${shift}: ${t - fight.startedAtMs} ms`).toEqual([null, true]);
          if (status === 'result') expect([card(t) !== null, positionMs >= duration], `${shift}: ${t - fight.startedAtMs} ms`).toEqual([true, true]);
        }
      }
      expect([fightStatus(slot, duration, end - 1, true).status, card(end - 1)]).toEqual(['fighting', null]);
      expect(fightStatus(slot, duration, end, true)).toEqual({ status: 'result', positionMs: duration });
      expect(card(end)).not.toBeNull();
      // The replay outro runs from the stage's end.
      expect(fightStatus(slot, duration, end + 1000, true).positionMs).toBe(duration + 1000);
      expect(fightStatus(slot, duration, slot.leaveAtMs - 1, true).positionMs).toBe(duration + REPLAY_OUTRO_MS);
    }
  });

  it('shows a queued pair that reaches its ring after its bout ended only the end state', () => {
    const queued = slots[6];
    const fight = fights[6];
    const end = fight.startedAtMs + fight.log.durationMs;
    expect(queued.fightStartMs).toBeGreaterThan(end + REPLAY_OUTRO_MS);
    expect(queued.leaveAtMs).toBe(queued.fightStartMs + ARENA_RESULT_HOLD_MS);
    for (let t = queued.enterAtMs; t < queued.leaveAtMs; t += 250) {
      const { status, positionMs } = fightStatus(queued, fight.log.durationMs, t);
      expect(status, `${t - queued.enterAtMs} ms after entering`).not.toBe('fighting');
      if (status === 'result') expect(positionMs).toBe(fight.log.durationMs + REPLAY_OUTRO_MS);
    }
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
