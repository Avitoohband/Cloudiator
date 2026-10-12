import { describe, expect, it, vi } from 'vitest';
import type { PublicActor } from '@contracts/reads';
import { loadAssetManifest } from '@/game/assets';
import { mapScreenBounds, screenToWorld, worldToScreen } from '@/game/iso';
import { clampView, zoomAround, ZOOM_LIMITS } from '@/game/camera';
import { findPath, gridFromMap } from '@/game/paths';
import { EQUIPMENT_LAYERS, layoutCamp, locationKind, planActorRoutine } from '@/game/actors';
import { frontEdgeY, propSlices } from '@/game/depth';
import { NPC_ROUTINES, planNpcPosition } from '@/game/npcs';
import { phaseLighting } from '@/game/lighting';
import { createSceneBridge } from '@/game/bridge';
import { createDemoWorld } from '@/game/demo-world';

const manifest = loadAssetManifest();
const camp = manifest.maps.find(m => m.id === 'camp')!;
const SLOT = 373_248;

function actor(i: number, location: string, overrides: Partial<PublicActor> = {}): PublicActor {
  return {
    gladiatorId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Gladiator ${i}`, classId: 'duelist',
    equipmentSilhouettes: ['weapon-sword', 'offhand-shield'], league: 'bronze', level: 1, phase: 'morning', location,
    activityId: `activity-${i}`, activityStatus: 'active', startsAtMs: 1, endsAtMs: 2, visibleStage: null, ...overrides,
  };
}

describe('isometric projection', () => {
  it('maps tile corners and centres with the manifest rule', () => {
    expect(worldToScreen(0, 0)).toEqual({ x: 0, y: 0 });
    expect(worldToScreen(1, 0)).toEqual({ x: 32, y: 16 });
    expect(worldToScreen(0, 1)).toEqual({ x: -32, y: 16 });
    expect(worldToScreen(2.5, 3.5)).toEqual({ x: -32, y: 96 });
  });

  it('inverts screen positions back to tile coordinates', () => {
    for (const [x, y] of [[0, 0], [3.25, 7.5], [45, 12], [17.5, 40.75]]) {
      const s = worldToScreen(x, y);
      const w = screenToWorld(s.x, s.y);
      expect(w.x).toBeCloseTo(x, 9);
      expect(w.y).toBeCloseTo(y, 9);
    }
  });

  it('bounds the whole map diamond', () => {
    expect(mapScreenBounds(46, 46)).toEqual({ x: -46 * 32, y: 0, width: 92 * 32, height: 92 * 16 });
  });
});

describe('camera limits', () => {
  const bounds = { x: -1472, y: 0, width: 2944, height: 1472 };

  it('keeps the visible area inside the map bounds after an extreme pan', () => {
    const view = clampView({ centerX: 99_999, centerY: -99_999, zoom: 1, viewWidth: 800, viewHeight: 600 }, bounds);
    expect(view.centerX + 400).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(view.centerY - 300).toBeGreaterThanOrEqual(bounds.y);
  });

  it('centres the map when the view is larger than the map', () => {
    const view = clampView({ centerX: 0, centerY: 0, zoom: ZOOM_LIMITS.min, viewWidth: 4000, viewHeight: 4000 }, bounds);
    expect(view.centerX).toBe(bounds.x + bounds.width / 2);
    expect(view.centerY).toBe(bounds.y + bounds.height / 2);
  });

  it('zooms around the pointer and clamps zoom', () => {
    const start = { centerX: 0, centerY: 700, zoom: 1, viewWidth: 800, viewHeight: 600 };
    const anchor = { x: 600, y: 150 };
    const before = { x: start.centerX + (anchor.x - 400) / start.zoom, y: start.centerY + (anchor.y - 300) / start.zoom };
    const zoomed = zoomAround(start, 2, anchor, bounds);
    const after = { x: zoomed.centerX + (anchor.x - 400) / zoomed.zoom, y: zoomed.centerY + (anchor.y - 300) / zoomed.zoom };
    expect(zoomed.zoom).toBe(2);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(zoomAround(start, 100, anchor, bounds).zoom).toBe(ZOOM_LIMITS.max);
    expect(zoomAround(start, 0.0001, anchor, bounds).zoom).toBe(ZOOM_LIMITS.min);
  });
});

describe('walkable paths', () => {
  const grid = gridFromMap(camp);

  it('routes between zones without crossing blocked tiles', () => {
    const path = findPath(grid, { x: 10, y: 21 }, { x: 38, y: 22 })!;
    expect(path.length).toBeGreaterThan(10);
    expect(path[0]).toEqual({ x: 10, y: 21 });
    expect(path.at(-1)).toEqual({ x: 38, y: 22 });
    for (const p of path) expect(grid.walkable(p.x, p.y), `${p.x},${p.y}`).toBe(true);
    for (let i = 1; i < path.length; i += 1) {
      expect(Math.max(Math.abs(path[i].x - path[i - 1].x), Math.abs(path[i].y - path[i - 1].y))).toBe(1);
    }
  });

  it('enters the arena only through its gate', () => {
    const path = findPath(grid, { x: 23, y: 12 }, { x: 23, y: 23 })!;
    const gate = path.find(p => Math.hypot(p.x + 0.5 - 23, p.y + 0.5 - 23) < 7.3 && Math.hypot(p.x + 0.5 - 23, p.y + 0.5 - 23) > 5.7);
    expect(gate).toBeDefined();
    const deg = (Math.atan2(gate!.y + 0.5 - 23, gate!.x + 0.5 - 23) * 180) / Math.PI;
    expect(Math.abs(deg - 45)).toBeLessThan(20);
  });

  it('reports unreachable targets instead of walking through walls', () => {
    expect(findPath(grid, { x: 10, y: 21 }, { x: 0, y: 0 })).toBeNull();
  });
});

describe('actor routines', () => {
  it('maps canonical locations and legacy labels to routine kinds', () => {
    expect(locationKind('training')).toBe('training');
    expect(locationKind('Practice yard')).toBe('training');
    expect(locationKind('rest')).toBe('rest');
    expect(locationKind('arena')).toBe('arena');
    expect(locationKind('tournament')).toBe('tournament');
    expect(locationKind('expedition:woodland')).toBe('away');
    expect(locationKind('orientation')).toBe('orientation');
    expect(locationKind('somewhere unknown')).toBe('idle');
  });

  it('is deterministic per character and slot but varies between characters and slots', () => {
    const a = actor(1, 'training');
    expect(planActorRoutine(a, SLOT)).toEqual(planActorRoutine(a, SLOT));
    const routines = Array.from({ length: 50 }, (_, i) => planActorRoutine(actor(i, 'training'), SLOT));
    expect(new Set(routines.map(r => r.offsetMs)).size).toBeGreaterThan(40);
    expect(new Set(routines.map(r => r.variant))).toEqual(new Set(['weights', 'practice', 'spar']));
    const changed = Array.from({ length: 20 }, (_, i) => planActorRoutine(actor(i, 'training'), SLOT).offsetMs !== planActorRoutine(actor(i, 'training'), SLOT + 1).offsetMs);
    expect(changed.filter(Boolean).length).toBeGreaterThan(15);
  });

  it('draws only the equipment the public projection shows and tints each player', () => {
    const r = planActorRoutine(actor(3, 'rest', { equipmentSilhouettes: ['weapon-spear', 'armor-heavy', 'head-helmet'] }), SLOT);
    expect(r.layers).toEqual(['body', 'cloth', 'armor-heavy', 'accent', 'head-helmet', 'head-helmet-crest', 'weapon-spear', 'held']);
    const fromCatalog = planActorRoutine(actor(5, 'rest', { equipmentSilhouettes: ['sword:1:common', 'light-armor:1:common', 'round-shield:5:rare', 'light-boots:1:common'] }), SLOT);
    expect(fromCatalog.layers).toEqual(['body', 'cloth', 'hair', 'armor-light', 'accent', 'weapon-sword', 'offhand-shield', 'held']);
    expect(EQUIPMENT_LAYERS).toEqual(manifest.equipmentLayers);
    const twoHanded = planActorRoutine(actor(4, 'rest', { equipmentSilhouettes: ['weapon-bow', 'offhand-shield'] }), SLOT);
    expect(twoHanded.layers).not.toContain('offhand-shield');
    const tints = new Set(Array.from({ length: 50 }, (_, i) => planActorRoutine(actor(i, 'rest'), SLOT).tint.cloth));
    expect(tints.size).toBeGreaterThanOrEqual(8);
    expect(new Set(Array.from({ length: 50 }, (_, i) => planActorRoutine(actor(i, 'rest'), SLOT).tint.skin)).size).toBeGreaterThanOrEqual(4);
  });

  it('gives 50 gladiators in one zone 50 unique walkable positions inside it', () => {
    for (const location of ['training', 'rest', 'arena']) {
      const actors = Array.from({ length: 50 }, (_, i) => actor(i, location));
      const { placements } = layoutCamp(actors, camp, SLOT);
      expect(placements.size, location).toBe(50);
      const tiles = [...placements.values()].map(p => `${p.x},${p.y}`);
      expect(new Set(tiles).size, location).toBe(50);
      const zone = camp.zones.find(z => z.id === location)!;
      for (const p of placements.values()) {
        expect(camp.walkable[p.y][p.x], `${location} ${p.x},${p.y}`).toBe('1');
        expect(p.x >= zone.bounds.x && p.y >= zone.bounds.y && p.x < zone.bounds.x + zone.bounds.w && p.y < zone.bounds.y + zone.bounds.h).toBe(true);
      }
    }
  });

  it('pairs sparring partners face to face and keeps a mixed camp unique', () => {
    const world = createDemoWorld(1_791_592_800_000, 50, 6);
    expect(world.actors).toHaveLength(56);
    const { placements, away } = layoutCamp(world.actors, camp, world.slotIndex);
    expect(placements.size).toBe(50);
    expect(away).toHaveLength(6);
    expect(new Set([...placements.values()].map(p => `${p.x},${p.y}`)).size).toBe(placements.size);
    for (const p of placements.values()) {
      if (p.partnerId) {
        const q = placements.get(p.partnerId)!;
        expect(q.partnerId).toBe(p.gladiatorId);
        expect(new Set([p.facing, q.facing])).toEqual(new Set(['se', 'sw']));
      }
    }
  });
});

describe('wide prop depth slices', () => {
  it('follows the footprint front edge', () => {
    expect(frontEdgeY({ w: 3, d: 3 }, -96)).toBe(48);
    expect(frontEdgeY({ w: 3, d: 3 }, 0)).toBe(96);
    expect(frontEdgeY({ w: 3, d: 3 }, 96)).toBe(48);
    expect(frontEdgeY({ w: 3, d: 2 }, 32)).toBe(80);
  });

  it('draws actors in front of a tent face over it and actors behind it under it', () => {
    const slices = propSlices({ w: 3, d: 3 }, -100, 200);
    const sliceAt = (x: number) => slices.find(s => x >= s.left && x < s.left + s.width)!;
    // Actor one tile in front of the tent's south-west face (column -64): feet at 16*(3+...)
    const frontActor = { x: -64, y: 64 + 16 + 16 };
    const behindActor = { x: -64, y: 64 - 16 };
    expect(frontActor.y).toBeGreaterThan(sliceAt(frontActor.x).depthOffset);
    expect(behindActor.y).toBeLessThan(sliceAt(behindActor.x).depthOffset);
    expect(slices.map(s => s.left + s.width / 2).every(c => Number.isFinite(c))).toBe(true);
  });
});

describe('ambient NPCs', () => {
  it('keeps six NPCs on walkable tiles near their posts at all times', () => {
    expect(NPC_ROUTINES.map(n => n.npcId).sort()).toEqual(['armorer', 'cook', 'guard', 'healer', 'smith', 'trainer']);
    for (let t = 0; t < 20 * 60_000; t += 7_919) {
      for (const routine of NPC_ROUTINES) {
        const p = planNpcPosition(routine, camp, t);
        expect(camp.walkable[Math.floor(p.y)][Math.floor(p.x)], `${routine.npcId} at ${t}`).toBe('1');
        expect(['idle', 'walk', 'talk', 'tend']).toContain(p.action);
      }
    }
    const smith = NPC_ROUTINES.find(n => n.npcId === 'smith')!;
    const at = planNpcPosition(smith, camp, 0);
    expect(Math.hypot(at.x - 18.5, at.y - 7.5)).toBeLessThan(3);
  });

  it('brings NPCs together for ambient conversations', () => {
    const talks = new Set<string>();
    for (let t = 0; t < 30 * 60_000; t += 10_000) for (const r of NPC_ROUTINES) if (planNpcPosition(r, camp, t).action === 'talk') talks.add(r.npcId);
    expect(talks.size).toBeGreaterThanOrEqual(3);
  });
});

describe('phase lighting', () => {
  it('darkens evening and lights torches without hiding characters', () => {
    const [m, a, e] = (['morning', 'afternoon', 'evening'] as const).map(phaseLighting);
    expect(e.torchIntensity).toBeGreaterThan(m.torchIntensity);
    expect(a.overlayAlpha).toBeLessThan(m.overlayAlpha);
    expect(e.overlayAlpha).toBeGreaterThan(m.overlayAlpha);
    for (const l of [m, a, e]) expect(l.overlayAlpha).toBeLessThanOrEqual(0.35);
  });
});

describe('scene bridge', () => {
  it('delivers events to listeners and stops after unsubscribe or destroy', () => {
    const bridge = createSceneBridge();
    const select = vi.fn();
    const off = bridge.on('select-character', select);
    bridge.emit('select-character', { gladiatorId: 'g1' });
    off();
    bridge.emit('select-character', { gladiatorId: 'g2' });
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith({ gladiatorId: 'g1' });
    const merchant = vi.fn();
    bridge.on('open-merchant', merchant);
    bridge.destroy();
    bridge.emit('open-merchant', { merchant: 'weapons' });
    expect(merchant).not.toHaveBeenCalled();
    expect(bridge.listenerCount()).toBe(0);
  });

  it('supports every scene event the plan names', () => {
    const bridge = createSceneBridge();
    const seen: string[] = [];
    for (const event of ['select-character', 'open-merchant', 'view-expedition', 'view-replay', 'return-camp', 'follow-character'] as const) {
      bridge.on(event, () => seen.push(event));
    }
    bridge.emit('select-character', { gladiatorId: 'g' });
    bridge.emit('open-merchant', { merchant: 'armor' });
    bridge.emit('view-expedition', { activityId: 'a' });
    bridge.emit('view-replay', { activityId: 'a' });
    bridge.emit('return-camp', {});
    bridge.emit('follow-character', { gladiatorId: 'g' });
    expect(seen).toHaveLength(6);
  });
});
