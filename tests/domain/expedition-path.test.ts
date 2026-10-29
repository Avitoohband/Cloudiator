import { describe, expect, it } from 'vitest';
import { loadAssetManifest, type MapData, type TilePoint } from '@/game/assets';
import { EXPEDITION_APPROACH_MS, JOURNEY, renderExpeditionStage, type JourneyPoint, type RouteProgress } from '@/game/expedition-stage';
import { REPLAY_OUTRO_MS } from '@/game/replay';
import { pathLength } from '@/game/paths';
import { REST_PATTERN, SEARCH_PATTERN, gladiatorPose, journeyMap, legPath, wanderPoints, type GladiatorPose, type JourneyMap } from '@/game/expedition-path';
import { frameIndex } from '@/game/battle-stage';
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
    // On arrival it starts searching at the spot, facing se (the search cycle is covered below).
    const reach = (pathLength(legPath(j, 'start', 'search-1')!) / SPEED) * 1000;
    const searching = gladiatorPose(j, route('start', 'search-1', reach + 1_000, 'search'), SPEED);
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
    // Leaving the scene once back at camp: where it waited, standing; the scene fades it out.
    expect(gladiatorPose(j, route('end', 'end', 1_000, 'leave'), SPEED)).toMatchObject({ x: j.points.end.x + 0.5, y: j.points.end.y + 0.5, action: 'idle', walking: false });
    expect(gladiatorPose(j, route('safe', 'safe', 1_000, 'leave'), SPEED)).toMatchObject({ x: j.points.safe.x + 0.5, y: j.points.safe.y + 0.5, action: 'idle', walking: false });
    // After a defeat the leave route carries the rest it came from: it keeps that pose while it fades (Task 15 review).
    for (const ms of [1_000, REST_PATTERN.sitMs + 1_000]) {
      const leaving = { ...route('safe', 'safe', 1_000, 'leave'), rest: route('encounter-2', 'safe', arrive + ms, 'rest') };
      expect(gladiatorPose(j, leaving, SPEED)).toEqual(gladiatorPose(j, leaving.rest, SPEED));
      expect(gladiatorPose(j, leaving, SPEED).action).toBe(rest(ms));
    }
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

// Searching at a spot (Avi, 2026-10-29: "Slow + look around"): the leg in, the spot and the leg after the search.
const SEARCHES: [JourneyPoint, JourneyPoint, JourneyPoint][] = [
  ['start', 'search-1', 'encounter-1'], ['encounter-1', 'search-2', 'encounter-2'],
  ['encounter-2', 'search-3', 'encounter-3'], ['encounter-3', 'search-4', 'end'],
];
const SEARCH_ANIM = manifest.animations[manifest.actors.gladiator.animations.search.se];
/** Crouching and looking at the ground (frames 0-1) or standing and looking around (frames 2-3), as the scene draws the pose. */
const searchLook = (pose: GladiatorPose) => (frameIndex(SEARCH_ANIM, pose.animMs!) < 2 ? 'crouch' : 'look');
/** The search route `restMs` after arriving at the spot; the search ends `untilMs` after arriving (if given). */
const searchAt = (j: JourneyMap, from: JourneyPoint, spot: JourneyPoint, restMs: number, untilMs?: number): RouteProgress => {
  const reach = (pathLength(legPath(j, from, spot)!) / SPEED) * 1000;
  return { ...route(from, spot, reach + restMs, 'search'), ...(untilMs === undefined ? {} : { untilMs: reach + untilMs }) };
};
const off = (pose: { x: number; y: number }, p: TilePoint) => Math.hypot(pose.x - (p.x + 0.5), pose.y - (p.y + 0.5));
const STEP_MS = 50;

describe('searching around a spot (Avi, 2026-10-29: slower, looking around)', () => {
  it('times the search cycle by the manifest search loop: a crouch, then a look, about 2.5 s each', () => {
    const d = SEARCH_ANIM.durationsMs;
    expect(d).toHaveLength(4);
    expect(d[0] + d[1]).toBe(SEARCH_PATTERN.crouchMs);
    expect(d[2] + d[3]).toBe(SEARCH_PATTERN.lookMs);
    expect(SEARCH_PATTERN.crouchMs).toBeGreaterThanOrEqual(2_000);
    expect(SEARCH_PATTERN.lookMs).toBeGreaterThanOrEqual(2_000);
  });

  it('crouches and looks at the spot, turns, and walks a few steps to a walkable point nearby', () => {
    for (const map of maps) {
      const j = journeyMap(map);
      for (const [from, spot] of SEARCHES) {
        const centre = j.points[spot];
        const label = `${map.id} ${spot}`;
        const poses = Array.from({ length: 40_000 / STEP_MS }, (_, i) => gladiatorPose(j, searchAt(j, from, spot, i * STEP_MS), SPEED));
        // It arrives and crouches at the spot, looking at the ground, for about 2.5 s, then stands and looks.
        expect(poses[0], label).toMatchObject({ x: centre.x + 0.5, y: centre.y + 0.5, action: 'search', walking: false, facing: 'se' });
        const stood = poses.findIndex(p => p.action !== 'search' || off(p, centre) > 0 || searchLook(p) !== 'crouch');
        expect(stood * STEP_MS, label).toBeGreaterThanOrEqual(2_000);
        expect(poses[stood], label).toMatchObject({ x: centre.x + 0.5, y: centre.y + 0.5, action: 'search', walking: false });
        expect(searchLook(poses[stood]), label).toBe('look');
        // A turn: the facing changes while it stands still.
        const turn = poses.findIndex((p, i) => i > 0 && !p.walking && !poses[i - 1].walking && p.x === poses[i - 1].x && p.y === poses[i - 1].y && p.facing !== poses[i - 1].facing);
        expect(turn, label).toBeGreaterThan(0);
        // Steps: it walks, with the walk animation, to a point within 1.5 tiles and searches there.
        expect(poses.some(p => p.walking && p.action === 'walk'), label).toBe(true);
        expect(poses.some(p => !p.walking && off(p, centre) > 0.5), label).toBe(true);
        // Everywhere: walkable, within 1.5 tiles of the spot, never faster than walking (no jump), and searching
        // whenever it stands, facing se or sw (the search art has only front frames).
        poses.forEach((p, i) => {
          const at = `${label} at ${i * STEP_MS} ms`;
          expect(walkable(map, p.x, p.y), at).toBe(true);
          expect(off(p, centre), at).toBeLessThanOrEqual(1.5 + 1e-9);
          if (i) expect(Math.hypot(p.x - poses[i - 1].x, p.y - poses[i - 1].y), at).toBeLessThanOrEqual((SPEED * STEP_MS) / 1000 + 1e-9);
          if (p.walking) expect(p.action, at).toBe('walk');
          else {
            expect(p.action, at).toBe('search');
            expect(['se', 'sw'], at).toContain(p.facing);
          }
        });
        // A cycle of about 12 to 16 s: it sets off from the spot at least twice in 40 s, never before its first search.
        const departures = poses.flatMap((p, i) => (i && p.walking && !poses[i - 1].walking && off(poses[i - 1], centre) === 0 ? [i * STEP_MS] : []));
        expect(departures.length, label).toBeGreaterThanOrEqual(2);
        expect(departures[0], label).toBeGreaterThanOrEqual(SEARCH_PATTERN.crouchMs + SEARCH_PATTERN.lookMs);
        expect(departures[1] - departures[0], label).toBeGreaterThanOrEqual(12_000);
        expect(departures[1] - departures[0], label).toBeLessThanOrEqual(16_000);
      }
    }
  });

  it('gives the same pose for the same route progress, whatever was asked before', () => {
    const times = Array.from({ length: 240 }, (_, i) => (i * 7_919) % 61_000);
    for (const map of maps) {
      for (const [from, spot] of SEARCHES) {
        const a = journeyMap(map);
        const b = journeyMap(map);
        const forward = times.map(ms => gladiatorPose(a, searchAt(a, from, spot, ms, 45_000), SPEED));
        const backward = [...times].reverse().map(ms => gladiatorPose(b, searchAt(b, from, spot, ms, 45_000), SPEED)).reverse();
        expect(backward, `${map.id} ${spot}`).toEqual(forward);
        expect(times.map(ms => gladiatorPose(a, searchAt(a, from, spot, ms, 45_000), SPEED)), `${map.id} ${spot}`).toEqual(forward);
      }
    }
  });

  it('is back at the spot when the search ends, where the next leg starts', () => {
    for (const map of maps) {
      const j = journeyMap(map);
      for (const [from, spot, next] of SEARCHES) {
        const centre = j.points[spot];
        const start = gladiatorPose(j, route(spot, next, 0, 'wait'), SPEED);
        expect([start.x, start.y]).toEqual([centre.x + 0.5, centre.y + 0.5]);
        // A search that ends at any moment of its first cycles (it searches from 0 ms, on arrival).
        for (let until = 1; until <= 45_000; until += 97) {
          const last = gladiatorPose(j, searchAt(j, from, spot, until - 1, until), SPEED);
          expect([last.x, last.y], `${map.id} ${spot}, a search of ${until} ms`).toEqual([start.x, start.y]);
        }
      }
    }
  });

  it('starts the next leg of every fixture run where its search ended', () => {
    let searches = 0;
    for (const [key, t] of Object.entries(T)) {
      const map = maps.find(m => m.id === EXPEDITION_FIXTURES[key as keyof typeof T].expedition)!;
      const j = journeyMap(map);
      for (const stage of t.stages) {
        const approach = stage.endsAtMs - EXPEDITION_APPROACH_MS;
        const before = renderExpeditionStage(t, approach - 1).route;
        const after = renderExpeditionStage(t, approach).route;
        if (before?.then !== 'search' || after?.then !== 'wait') continue;
        searches += 1;
        const a = gladiatorPose(j, before, SPEED);
        const b = gladiatorPose(j, after, SPEED);
        expect(Math.hypot(a.x - b.x, a.y - b.y), `${key} ${stage.id}`).toBeLessThanOrEqual(SPEED / 1000 + 1e-9);
      }
    }
    expect(searches).toBeGreaterThan(0);
  });

  it('wanders only to walkable points near the spot, never onto a prop, an encounter spot or another leg\'s route', () => {
    const legs: [JourneyPoint, JourneyPoint][] = [
      ...JOURNEY.slice(1).map((to, i): [JourneyPoint, JourneyPoint] => [JOURNEY[i], to]),
      ...[1, 2, 3].map((n): [JourneyPoint, JourneyPoint] => [`encounter-${n}` as JourneyPoint, 'safe']),
    ];
    for (const map of maps) {
      const j = journeyMap(map);
      const props = new Set(map.props.flatMap(p => Array.from({ length: p.w * p.d }, (_, i) => `${p.x + (i % p.w)},${p.y + Math.floor(i / p.w)}`)));
      const encounters = new Set(j.encounters.flatMap(e => [`${e.gladiator.x},${e.gladiator.y}`, `${e.enemy.x},${e.enemy.y}`]));
      for (const [, spot] of SEARCHES) {
        const centre = j.points[spot];
        const otherLegs = new Set(legs.filter(([a, b]) => a !== spot && b !== spot).flatMap(([a, b]) => legPath(j, a, b)!.map(p => `${p.x},${p.y}`)));
        const points = wanderPoints(j, spot);
        // Two points, one on either side of the spot on screen, computed once per journey map and spot.
        expect(points.length, `${map.id} ${spot}`).toBe(2);
        expect(new Set(points.map(w => Math.sign(w.point.x - centre.x - (w.point.y - centre.y)))), `${map.id} ${spot}`).toEqual(new Set([-1, 1]));
        expect(wanderPoints(j, spot)).toBe(points);
        for (const w of points) {
          const at = `${map.id} ${spot} ${w.point.x},${w.point.y}`;
          const k = `${w.point.x},${w.point.y}`;
          expect(map.walkable[w.point.y][w.point.x], at).toBe('1');
          expect(props.has(k), at).toBe(false);
          expect(encounters.has(k), at).toBe(false);
          expect(otherLegs.has(k), at).toBe(false);
          expect(Object.values(j.points).some(p => p.x === w.point.x && p.y === w.point.y), at).toBe(false);
          expect(Math.hypot(w.point.x - centre.x, w.point.y - centre.y), at).toBeLessThanOrEqual(1.5);
          expect(w.out[0], at).toEqual(centre);
          expect(w.out.at(-1), at).toEqual(w.point);
          expect(w.back, at).toEqual([...w.out].reverse());
          expect(pathLength(w.out), at).toBeLessThanOrEqual(1.5);
          for (const p of w.out) expect(map.walkable[p.y][p.x], at).toBe('1');
        }
      }
    }
  });
});
