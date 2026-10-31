import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { MapData } from '@/game/assets';
import { VIGNETTE, bedFor, vignettePose } from '@/game/trip-vignette';
import type { TripVignette } from '@/game/trip-replay';

// Patch A Task 10 (spec "Camp bookends"): the whole-trip replay's camp chapters on the camp's own map. "Leaving camp" walks to the
// gate (41, 22) and fades there, "Back in camp" fades in at the gate and walks in, "Resting" walks to a bed of the rest zone and
// lies down. The camp map is the shipped one, at 1 tile per second (the manifest's walking speed).

const camp = JSON.parse(readFileSync('public/assets/camp/map.json', 'utf8')) as MapData;
const SPEED = 1;
const GATE = { x: 41.5, y: 22.5 };
const at = (kind: TripVignette['kind'], elapsedMs: number, durationMs = kind === 'resting' ? 6_000 : 5_000, key = 'g1') =>
  vignettePose(camp, { kind, elapsedMs, durationMs }, key, SPEED);
const from = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
const walkable = (x: number, y: number) => camp.walkable[Math.floor(y)]?.[Math.floor(x)] === '1';
const KEYS = Array.from({ length: 10 }, (_, i) => `g${i}`);

describe('the camp bookends of the whole-trip replay', () => {
  it('walks out through the gate and fades there', () => {
    const start = vignettePose(camp, { kind: 'leaving', elapsedMs: 0, durationMs: 5_000 }, 'g1', 1);
    expect(Math.hypot(start.x - 41.5, start.y - 22.5)).toBeLessThanOrEqual(4.5);
    expect(vignettePose(camp, { kind: 'leaving', elapsedMs: 4_000, durationMs: 5_000 }, 'g1', 1)).toMatchObject({ x: 41.5, y: 22.5 });
    expect(vignettePose(camp, { kind: 'leaving', elapsedMs: 5_000, durationMs: 5_000 }, 'g1', 1).alpha).toBe(0);
    // From inside the camp (west of the gate), walking toward it (facing the gate, se), in full view until the fade.
    expect(start).toMatchObject({ action: 'walk', facing: 'se', alpha: 1 });
    expect(start.x).toBeLessThan(GATE.x);
    expect(from(start, GATE)).toBeGreaterThan(1);
    expect(at('leaving', 4_000)).toMatchObject({ action: 'idle', facing: 'se', alpha: 1 });
    expect(at('leaving', 5_000 - VIGNETTE.fadeMs)).toMatchObject({ x: 41.5, y: 22.5, alpha: 1 });
    expect(at('leaving', 5_000 - VIGNETTE.fadeMs / 2).alpha).toBeCloseTo(0.5, 6);
  });

  it('comes in through the gate and stands', () => {
    expect(at('back', 0)).toMatchObject({ x: 41.5, y: 22.5, alpha: 0 });
    expect(at('back', 250).alpha).toBeCloseTo(0.5, 6);
    expect(at('back', 500)).toMatchObject({ x: 41.5, y: 22.5, alpha: 1 });
    // Then it walks in, away from the gate (its back to the gate, nw) …
    expect(at('back', 1_500)).toMatchObject({ action: 'walk', facing: 'nw', alpha: 1 });
    expect(at('back', 1_500).x).toBeLessThan(GATE.x);
    // … and stands inside, within 4 tiles of the gate.
    const end = at('back', 5_000);
    expect(end).toMatchObject({ action: 'idle', alpha: 1 });
    expect(from(end, GATE)).toBeGreaterThan(1);
    expect(from(end, GATE)).toBeLessThanOrEqual(4);
    expect(end.x).toBeLessThan(GATE.x);
  });

  it('lies down on the same bed for the same gladiator', () => {
    const end = vignettePose(camp, { kind: 'resting', elapsedMs: 6_000, durationMs: 6_000 }, 'g1', 1);
    expect(end).toMatchObject({ action: 'sleep', x: bedFor(camp, 'g1').x + 0.5, y: bedFor(camp, 'g1').y + 0.5 });
    expect(vignettePose(camp, { kind: 'resting', elapsedMs: 4_200, durationMs: 6_000 }, 'g1', 1).action).toBe('sleep');
    expect(new Set(Array.from({ length: 10 }, (_, i) => `${bedFor(camp, `g${i}`).x},${bedFor(camp, `g${i}`).y}`)).size).toBeGreaterThanOrEqual(3);
    // A sleep station of the rest zone, lying the station's way, after a walk of at most 4 tiles to it.
    const sleeps = camp.zones.find(z => z.id === 'rest')!.stations.filter(s => s.kind === 'sleep');
    for (const key of KEYS) {
      const bed = bedFor(camp, key);
      const station = sleeps.find(s => s.x === bed.x && s.y === bed.y);
      expect(station, key).toBeDefined();
      expect(bed.facing, key).toBe(station!.facing);
      expect(bedFor(camp, key), key).toEqual(bed);
      const start = at('resting', 0, 6_000, key);
      expect(start.action, key).toBe('walk');
      expect(from(start, { x: bed.x + 0.5, y: bed.y + 0.5 }), key).toBeGreaterThan(1);
      expect(from(start, { x: bed.x + 0.5, y: bed.y + 0.5 }), key).toBeLessThanOrEqual(4);
      expect(at('resting', 6_000, 6_000, key), key).toMatchObject({ action: 'sleep', facing: station!.facing, alpha: 1 });
    }
  });

  it('stays on walkable ground', () => {
    for (const key of KEYS) {
      const bed = bedFor(camp, key);
      for (const [kind, durationMs] of [['leaving', 5_000], ['back', 5_000], ['resting', 6_000]] as const) {
        for (let elapsedMs = 0; elapsedMs <= durationMs; elapsedMs += 100) {
          const pose = at(kind, elapsedMs, durationMs, key);
          const onBed = Math.floor(pose.x) === bed.x && Math.floor(pose.y) === bed.y;
          expect(walkable(pose.x, pose.y) || onBed, `${key} ${kind} ${elapsedMs}: ${pose.x},${pose.y}`).toBe(true);
        }
      }
    }
  });

  it('walks at the walking speed and never jumps', () => {
    for (const [kind, durationMs] of [['leaving', 5_000], ['back', 5_000], ['resting', 6_000]] as const) {
      for (let elapsedMs = 50; elapsedMs <= durationMs; elapsedMs += 50) {
        const step = from(at(kind, elapsedMs - 50, durationMs), at(kind, elapsedMs, durationMs));
        expect(step, `${kind} ${elapsedMs}`).toBeLessThanOrEqual((SPEED * 50) / 1000 + 1e-9);
      }
    }
    // A faster walker covers the same ground sooner: at 2 tiles a second the walk out is at the gate by 2 s.
    expect(vignettePose(camp, { kind: 'leaving', elapsedMs: 2_000, durationMs: 5_000 }, 'g1', 2)).toMatchObject({ x: 41.5, y: 22.5 });
  });

  it('fits a slower walk into the chapter, and survives odd inputs', () => {
    // At half the speed a 4-tile walk would not fit in 5 s: the walk is shorter, still at the gate before the fade.
    const slow = (elapsedMs: number) => vignettePose(camp, { kind: 'leaving', elapsedMs, durationMs: 5_000 }, 'g1', 0.5);
    expect(slow(5_000 - VIGNETTE.fadeMs)).toMatchObject({ x: 41.5, y: 22.5, alpha: 1 });
    expect(from(slow(0), GATE)).toBeLessThanOrEqual(((5_000 - VIGNETTE.fadeMs) * 0.5) / 1000);
    // Before the start and past the end hold the first and last pose; nonsense numbers give a pose, never a throw.
    expect(at('resting', -500)).toEqual(at('resting', 0));
    expect(at('resting', 60_000)).toEqual(at('resting', 6_000));
    for (const odd of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      const pose = vignettePose(camp, { kind: 'back', elapsedMs: odd, durationMs: odd }, 'g1', odd);
      expect([pose.x, pose.y, pose.alpha].every(Number.isFinite), String(odd)).toBe(true);
    }
  });

  it('shows no fade with reduced motion: in at once, and gone at the gate when the fade would start', () => {
    const still = (kind: TripVignette['kind'], elapsedMs: number) =>
      vignettePose(camp, { kind, elapsedMs, durationMs: kind === 'resting' ? 6_000 : 5_000 }, 'g1', 1, { fades: false });
    for (let elapsedMs = 0; elapsedMs <= 5_000; elapsedMs += 50) {
      expect([0, 1], `leaving ${elapsedMs}`).toContain(still('leaving', elapsedMs).alpha);
      expect(still('back', elapsedMs).alpha, `back ${elapsedMs}`).toBe(1);
    }
    expect(still('leaving', 5_000 - VIGNETTE.fadeMs - 1).alpha).toBe(1);
    expect(still('leaving', 5_000 - VIGNETTE.fadeMs + 1).alpha).toBe(0);
    // The walk itself is shown as without reduced motion.
    expect(still('back', 1_500)).toEqual({ ...at('back', 1_500), alpha: 1 });
    expect(still('resting', 3_000)).toEqual(at('resting', 3_000));
  });
});
