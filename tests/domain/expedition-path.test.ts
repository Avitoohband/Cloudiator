import { describe, expect, it } from 'vitest';
import { loadAssetManifest, type MapData } from '@/game/assets';
import { EXPEDITION_APPROACH_MS, JOURNEY, renderExpeditionStage, type JourneyPoint, type RouteProgress } from '@/game/expedition-stage';
import { REPLAY_OUTRO_MS } from '@/game/replay';
import { pathLength } from '@/game/paths';
import { REST_PATTERN, gladiatorPose, journeyMap, legPath } from '@/game/expedition-path';
import { EXPEDITION_FIXTURES, EXPEDITION_FIXTURE_TIMELINES as T } from '../fixtures/expeditions';

const manifest = loadAssetManifest();
const maps = (['woodland', 'outpost', 'mountain'] as const).map(id => manifest.maps.find(m => m.id === id) as MapData);
const SPEED = manifest.actors.gladiator.walk.tilesPerSecond;
const walkable = (map: MapData, x: number, y: number) => map.walkable[Math.floor(y)]?.[Math.floor(x)] === '1';
const route = (from: JourneyPoint, to: JourneyPoint, walkedMs: number, then: RouteProgress['then']): RouteProgress =>
  ({ segment: Math.max(0, JOURNEY.indexOf(from as (typeof JOURNEY)[number])), from, to, walkedMs, then });

describe('expedition journey on the map', () => {
  it('resolves every journey point to the map route, its search spots, encounters and safe point', () => {
    for (const map of maps) {
      const j = journeyMap(map);
      const e = map.expedition!;
      expect(j.points.start).toEqual(e.start);
      expect(j.points.end).toEqual(e.end);
      expect(j.points.safe).toEqual(e.safePoint);
      e.searchSpots.forEach((spot, i) => expect(j.points[`search-${i + 1}` as JourneyPoint]).toEqual(spot));
      e.encounters.forEach((enc, i) => {
        expect(j.points[`encounter-${i + 1}` as JourneyPoint]).toEqual({ x: enc.x, y: enc.y });
        expect(j.encounters[i]).toEqual({ gladiator: { x: enc.x, y: enc.y }, enemy: { x: enc.enemyX, y: enc.enemyY }, facing: enc.facing, enemyFacing: enc.enemyFacing, creature: enc.creature });
      });
      for (const [name, p] of Object.entries(j.points)) expect(walkable(map, p.x, p.y), `${map.id} ${name}`).toBe(true);
    }
  });

  it('walks every leg on walkable tiles, arriving well before the next encounter is due', () => {
    const legs: [JourneyPoint, JourneyPoint, number][] = [
      // [from, to, display time available for the walk]
      ['start', 'search-1', 20 * 60_000 - EXPEDITION_APPROACH_MS],
      ...[1, 2, 3].map(n => [`search-${n}`, `encounter-${n}`, EXPEDITION_APPROACH_MS] as [JourneyPoint, JourneyPoint, number]),
      ...[1, 2, 3].map(n => [`encounter-${n}`, `search-${n + 1}`, 15 * 60_000] as [JourneyPoint, JourneyPoint, number]),
      ['search-4', 'end', EXPEDITION_APPROACH_MS],
      ...[1, 2, 3].map(n => [`encounter-${n}`, 'safe', 15 * 60_000] as [JourneyPoint, JourneyPoint, number]),
    ];
    for (const map of maps) {
      const j = journeyMap(map);
      for (const [from, to, budget] of legs) {
        const path = legPath(j, from, to);
        expect(path, `${map.id} ${from} to ${to}`).not.toBeNull();
        const tiles = path!.reduce((sum, p, i) => sum + (i ? Math.hypot(p.x - path![i - 1].x, p.y - path![i - 1].y) : 0), 0);
        // At the manifest walking speed, with a wide margin.
        expect((tiles / SPEED) * 1000, `${map.id} ${from} to ${to}`).toBeLessThan(budget * 0.6);
        for (let ms = 0; ms <= (tiles / SPEED) * 1000 + 500; ms += 250) {
          const pose = gladiatorPose(j, route(from, to, ms, 'wait'), SPEED);
          expect(walkable(map, pose.x, pose.y), `${map.id} ${from}→${to} at ${ms} ms: ${pose.x},${pose.y}`).toBe(true);
        }
      }
    }
  });

  it('places the gladiator along the leg, then does what the route says on arrival', () => {
    const j = journeyMap(maps[0]);
    const start = gladiatorPose(j, route('start', 'search-1', 0, 'search'), SPEED);
    expect(start).toMatchObject({ x: j.points.start.x + 0.5, y: j.points.start.y + 0.5, action: 'walk', walking: true });
    const mid = gladiatorPose(j, route('start', 'search-1', 1500, 'search'), SPEED);
    expect(mid.action).toBe('walk');
    expect(Math.hypot(mid.x - start.x, mid.y - start.y)).toBeGreaterThan(1);
    const searching = gladiatorPose(j, route('start', 'search-1', 5 * 60_000, 'search'), SPEED);
    expect(searching).toMatchObject({ x: j.points['search-1'].x + 0.5, y: j.points['search-1'].y + 0.5, action: 'search', walking: false, facing: 'se' });
    expect(gladiatorPose(j, route('search-1', 'encounter-1', 60_000, 'wait'), SPEED)).toMatchObject({ action: 'idle', facing: j.encounters[0].facing, x: j.encounters[0].gladiator.x + 0.5 });
    expect(gladiatorPose(j, route('encounter-1', 'encounter-1', 3_000, 'fight'), SPEED)).toMatchObject({ action: 'fight', walking: false, x: j.encounters[0].gladiator.x + 0.5, y: j.encounters[0].gladiator.y + 0.5 });
    // Resting at the safe point: sitting first, then sleeping, on a fixed pattern of display time.
    const arrive = (pathLength(legPath(j, 'encounter-2', 'safe')!) / SPEED) * 1000 + 500;
    const rest = (ms: number) => gladiatorPose(j, route('encounter-2', 'safe', arrive + ms, 'rest'), SPEED).action;
    expect(rest(1_000)).toBe('sit');
    expect(rest(REST_PATTERN.sitMs + 1_000)).toBe('sleep');
    expect(rest(REST_PATTERN.sitMs + REST_PATTERN.sleepMs + 1_000)).toBe('sit');
    expect(gladiatorPose(j, route('encounter-2', 'safe', arrive + 1_000, 'rest'), SPEED)).toMatchObject({ x: j.points.safe.x + 0.5, y: j.points.safe.y + 0.5 });
  });

  it('turns a fixture state into a pose on its map for every minute of each run', () => {
    for (const [key, t] of Object.entries(T)) {
      const map = maps.find(m => m.id === EXPEDITION_FIXTURES[key as keyof typeof T].expedition)!;
      const j = journeyMap(map);
      const s0 = t.stages[0].startedAtMs;
      for (let minute = 0; minute <= 90; minute += 0.25) {
        const state = renderExpeditionStage(t, s0 + minute * 60_000);
        const pose = gladiatorPose(j, state.route!, SPEED);
        expect(walkable(map, pose.x, pose.y), `${key} minute ${minute}`).toBe(true);
        if (state.phase === 'encounter') expect(pose.action, `${key} minute ${minute}`).toBe('fight');
      }
      // Just after a battle the gladiator still stands at the encounter spot.
      for (const stage of t.stages.filter(s => s.kind === 'encounter')) {
        const state = renderExpeditionStage(t, stage.endsAtMs + REPLAY_OUTRO_MS - 1);
        expect(gladiatorPose(j, state.route!, SPEED).action, key).toBe('fight');
      }
    }
  });
});
