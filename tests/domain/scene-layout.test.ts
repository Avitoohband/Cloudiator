import { describe, expect, it, vi } from 'vitest';
import type { CampLocation, EquipmentSilhouette, PublicActor } from '@contracts/reads';
import { loadAssetManifest } from '@/game/assets';
import { mapScreenBounds, screenToWorld, worldToScreen } from '@/game/iso';
import { readFileSync } from 'node:fs';
import { CLICK_TRAVEL_PX, clampView, isClick, stepZoom, zoomAround, ZOOM_LIMITS, ZOOM_STEP } from '@/game/camera';
import { findPath, gridFromMap } from '@/game/paths';
import { BODIES, CLOTH_COLOURS, HAIRS, HAIR_COLOURS, SKIN_TONES, validAppearance, type Appearance } from '@domain/appearance';
import { CLOTH_TINTS, EQUIPMENT_LAYERS, HAIR_TINTS, LAYER_ORDER, SKIN_TINTS, hashString, layersFor, layoutCamp, legacyAppearance, locationKind, lookFor, planActorRoutine, tintFor } from '@/game/actors';
import { drawSlices, frontEdgeY, hidesActor, propSlices } from '@/game/depth';
import { NPC_ROUTINES, NPC_WALK_TILES_PER_SECOND, npcPostTiles, planNpcPosition, routineSlack, type NpcPosition } from '@/game/npcs';
import { phaseLighting } from '@/game/lighting';
import { createSceneBridge } from '@/game/bridge';
import { createDemoWorld, withDemoCrowd } from '@/game/demo-world';
import { createCampScene } from '@/game/camp-scene';

const manifest = loadAssetManifest();
const camp = manifest.maps.find(m => m.id === 'camp')!;
const SLOT = 373_248;

function actor(i: number, location: CampLocation, overrides: Partial<PublicActor> = {}): PublicActor {
  return {
    gladiatorId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Gladiator ${i}`, classId: 'duelist',
    equipmentSilhouettes: ['weapon-sword', 'offhand-shield'], appearance: null, league: 'bronze', level: 1, phase: 'morning', location,
    activityId: `activity-${i}`, activityStatus: 'active', startsAtMs: 1, endsAtMs: 2, visibleStage: null, resting: false, ...overrides,
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

  it('steps zoom through fixed levels so buttons, keys and the wheel agree', () => {
    expect(stepZoom(1, 1)).toBeCloseTo(ZOOM_STEP, 9);
    expect(stepZoom(1, -2)).toBeCloseTo(1 / ZOOM_STEP ** 2, 9);
    // Off-level zooms (after a pinch) snap to the nearest level before stepping.
    expect(stepZoom(1.3, 1)).toBeCloseTo(ZOOM_STEP ** 2, 9);
    expect(stepZoom(1.3, 0)).toBeCloseTo(ZOOM_STEP, 9);
    expect(stepZoom(ZOOM_LIMITS.max, 1)).toBe(ZOOM_LIMITS.max);
    expect(stepZoom(ZOOM_LIMITS.min, -1)).toBe(ZOOM_LIMITS.min);
    expect(stepZoom(ZOOM_LIMITS.max, -1)).toBeLessThan(ZOOM_LIMITS.max);
    expect(stepZoom(ZOOM_LIMITS.min, 1)).toBeGreaterThan(ZOOM_LIMITS.min);
    let zoom = 1;
    for (let i = 0; i < 4; i += 1) zoom = stepZoom(zoom, 1);
    for (let i = 0; i < 4; i += 1) zoom = stepZoom(zoom, -1);
    expect(zoom).toBeCloseTo(1, 9);
  });

  it('tells a click from a drag by one shared travel, so the shell and the camp scene agree at its edge (13.7 review)', () => {
    // The shell closes the menus on a camp click and the scene selects the gladiator under it: a press moved exactly
    // the threshold must be a click for both, never for one of them only.
    expect(CLICK_TRAVEL_PX).toBe(6);
    expect(isClick(0, 0)).toBe(true);
    expect(isClick(6, 0)).toBe(true);
    expect(isClick(0, -6)).toBe(true);
    expect(isClick(3.6, 4.8)).toBe(true);
    expect(isClick(6.01, 0)).toBe(false);
    expect(isClick(4.3, 4.3)).toBe(false);
    const sceneSource = readFileSync('src/game/camp-scene.ts', 'utf8');
    const shellSource = readFileSync('src/features/shell/CampShell.tsx', 'utf8');
    expect(sceneSource).toMatch(/DRAG_THRESHOLD = CLICK_TRAVEL_PX/);
    expect(shellSource).toMatch(/isClick\(/);
    expect(shellSource).not.toMatch(/CLICK_PX\s*=/);
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
    // Battle logs still carry catalog ids; the replay maps them through the same table.
    expect(layersFor(['sword:1:common', 'light-armor:1:common', 'round-shield:5:rare', 'light-boots:1:common']))
      .toEqual(['body', 'cloth', 'hair', 'armor-light', 'accent', 'weapon-sword', 'offhand-shield', 'held']);
    expect(EQUIPMENT_LAYERS).toEqual(manifest.equipmentLayers);
    const twoHanded = planActorRoutine(actor(4, 'rest', { equipmentSilhouettes: ['weapon-bow', 'offhand-shield'] }), SLOT);
    expect(twoHanded.layers).not.toContain('offhand-shield');
    const tints = new Set(Array.from({ length: 50 }, (_, i) => planActorRoutine(actor(i, 'rest'), SLOT).tint.cloth));
    expect(tints.size).toBeGreaterThanOrEqual(8);
    expect(new Set(Array.from({ length: 50 }, (_, i) => planActorRoutine(actor(i, 'rest'), SLOT).tint.skin)).size).toBeGreaterThanOrEqual(4);
  });

  it('draws every public equipment silhouette except boots, which have no layer', () => {
    const all: EquipmentSilhouette[] = ['weapon-sword', 'weapon-axe', 'weapon-spear', 'weapon-bow', 'offhand-shield', 'armor-light', 'armor-heavy', 'head-hood', 'head-helmet', 'feet-light', 'feet-heavy'];
    for (const id of all) {
      const layers = layersFor([id]);
      if (id.startsWith('feet-')) expect(layers, id).toEqual(layersFor([]));
      else expect(layers, id).toContain(id);
    }
  });

  it('keeps the layer draw order equal to the manifest layer order, new layers included', () => {
    expect(LAYER_ORDER).toEqual(manifest.actors.gladiator.layers.map(l => l.id));
    for (const id of ['body-female', 'cloth-female', 'hair-long', 'hair-ponytail']) expect(LAYER_ORDER, id).toContain(id);
  });

  it('draws the legacy look, today\'s layers and hash colours, for a gladiator with no appearance', () => {
    const sets: string[][] = [[], ['weapon-sword', 'offhand-shield'], ['weapon-spear', 'armor-heavy', 'head-helmet'], ['weapon-bow', 'armor-light', 'head-hood'],
      ['sword:1:common', 'light-armor:1:common', 'round-shield:5:rare', 'light-boots:1:common'], ['feet-light', 'feet-heavy']];
    for (let i = 0; i < 50; i += 1) {
      const id = actor(i, 'rest').gladiatorId;
      for (const set of sets) expect(lookFor(null, id, set), `${id} ${set.join()}`).toEqual({ layers: layersFor(set), tint: tintFor(id) });
    }
    // A cached read or an actor projected before the look existed lacks the key; one that is not a valid look is no look either.
    const legacy = lookFor(null, actor(7, 'rest').gladiatorId, ['weapon-sword']);
    expect(lookFor(undefined as never, actor(7, 'rest').gladiatorId, ['weapon-sword'])).toEqual(legacy);
    expect(lookFor({ body: 'female', hair: 'mohawk', skin: 0, hairColor: 0, cloth: 0 } as never, actor(7, 'rest').gladiatorId, ['weapon-sword'])).toEqual(legacy);
    expect(lookFor({ body: 'female', hair: 'long', skin: 5, hairColor: 0, cloth: 0 } as never, actor(7, 'rest').gladiatorId, ['weapon-sword'])).toEqual(legacy);
    expect(legacy.layers).toEqual(['body', 'cloth', 'hair', 'accent', 'weapon-sword', 'held']);
  });

  // Change look (2026-10-28): the picker opens a legacy gladiator on the look it already shows, so opening and saving changes nothing.
  it('names the legacy look as a valid look drawn exactly as a gladiator with no appearance is drawn', () => {
    const sets: string[][] = [[], ['weapon-sword', 'offhand-shield'], ['weapon-spear', 'armor-heavy', 'head-helmet'], ['weapon-bow', 'armor-light', 'head-hood'],
      ['sword:1:common', 'light-armor:1:common', 'round-shield:5:rare', 'light-boots:1:common'], ['feet-light', 'feet-heavy']];
    for (let i = 0; i < 50; i += 1) {
      const id = actor(i, 'rest').gladiatorId, look = legacyAppearance(id), h = hashString(id);
      expect(look, id).toEqual({ body: 'male', hair: 'short', skin: (h >>> 11) % 5, hairColor: (h >>> 5) % 6, cloth: h % 12 });
      expect(validAppearance(look), id).toBe(true);
      for (const set of sets) expect(lookFor(look, id, set), `${id} ${set.join()}`).toEqual(lookFor(null, id, set));
    }
    // It depends on the id alone, and the ids differ in their colours (not one look for everybody).
    expect(legacyAppearance(actor(3, 'rest').gladiatorId)).toEqual(legacyAppearance(actor(3, 'training').gladiatorId));
    expect(new Set(Array.from({ length: 50 }, (_, i) => JSON.stringify(legacyAppearance(actor(i, 'rest').gladiatorId)))).size).toBeGreaterThan(10);
  });

  // The expedition view draws a gladiator it cannot name yet (no actor, no revealed battle) with the activity id as the seed
  // (`ExpeditionView`: `lookFor(appearance, gladiatorId ?? activityId, …)`). A saved legacy look must not shift when the id arrives.
  it('draws a saved legacy look the same whatever seed the expedition view passes while the gladiator is unknown', () => {
    for (let i = 0; i < 50; i += 1) {
      const id = actor(i, 'rest').gladiatorId, saved = legacyAppearance(id);
      for (const set of [[], ['weapon-sword', 'offhand-shield'], ['weapon-spear', 'armor-heavy', 'head-helmet']]) {
        for (const seed of [id, `activity-${i}`, '']) expect(lookFor(saved, seed, set), `${id} seed ${seed} ${set.join()}`).toEqual(lookFor(null, id, set));
      }
    }
  });

  it('draws a chosen body, hair style and colours', () => {
    const id = actor(1, 'rest').gladiatorId;
    const look = (patch: Partial<Appearance>, set: string[] = ['weapon-sword', 'offhand-shield']) =>
      lookFor({ body: 'male', hair: 'short', skin: 0, hairColor: 0, cloth: 0, ...patch }, id, set);
    // A female body and clothes replace the male ones; every other layer is shared.
    const female = look({ body: 'female' }).layers;
    expect(female).toEqual(['body-female', 'cloth-female', 'hair', 'accent', 'weapon-sword', 'offhand-shield', 'held']);
    expect(female).not.toContain('body');
    expect(female).not.toContain('cloth');
    expect(look({ body: 'male' }).layers).toEqual(['body', 'cloth', 'hair', 'accent', 'weapon-sword', 'offhand-shield', 'held']);
    expect(look({ hair: 'long' }).layers).toEqual(['body', 'cloth', 'hair-long', 'accent', 'weapon-sword', 'offhand-shield', 'held']);
    expect(look({ hair: 'ponytail', body: 'female' }).layers).toEqual(['body-female', 'cloth-female', 'hair-ponytail', 'accent', 'weapon-sword', 'offhand-shield', 'held']);
    // Bald draws no hair layer of any kind.
    expect(look({ hair: 'bald' }).layers.filter(l => l.startsWith('hair'))).toEqual([]);
    expect(look({ hair: 'bald', body: 'female' }).layers).toEqual(['body-female', 'cloth-female', 'accent', 'weapon-sword', 'offhand-shield', 'held']);
    // Head gear hides any hair, as it hides short hair today (a helmet keeps its crest).
    for (const hair of HAIRS) for (const body of BODIES) {
      expect(look({ hair, body }, ['head-hood']).layers.filter(l => l.startsWith('hair')), `${body} ${hair} hood`).toEqual([]);
      const helmet = look({ hair, body }, ['head-helmet', 'armor-heavy']).layers;
      expect(helmet.filter(l => l.startsWith('hair')), `${body} ${hair} helmet`).toEqual([]);
      expect(helmet).toEqual(expect.arrayContaining(['head-helmet', 'head-helmet-crest', 'armor-heavy']));
    }
    // Colours come from the chosen palette indices, not from the id.
    expect(look({ skin: 4, hairColor: 5, cloth: 11 }).tint).toEqual({ skin: SKIN_TONES[4].tint, hair: HAIR_COLOURS[5].tint, cloth: CLOTH_COLOURS[11].tint });
    expect(look({ skin: 1, hairColor: 2, cloth: 3 }).tint).toEqual({ skin: SKIN_TINTS[1], hair: HAIR_TINTS[2], cloth: CLOTH_TINTS[3] });
    expect(look({ skin: 0, hairColor: 0, cloth: 0 }).tint).toEqual(look({ skin: 0, hairColor: 0, cloth: 0 }, []).tint);
  });

  it('draws every layer a chosen look names from the manifest, in manifest order', () => {
    const ids = new Set(manifest.actors.gladiator.layers.map(l => l.id));
    const tinted = new Map(manifest.actors.gladiator.layers.map(l => [l.id, l.tint]));
    const sets = [[], ['weapon-axe', 'armor-heavy', 'head-helmet', 'offhand-shield'], ['weapon-bow', 'armor-light', 'head-hood']];
    for (const body of BODIES) for (const hair of HAIRS) for (const set of sets) {
      const { layers } = lookFor({ body, hair, skin: 2, hairColor: 3, cloth: 4 }, 'g', set);
      expect(layers.every(l => ids.has(l)), `${body} ${hair}`).toBe(true);
      expect(layers, `${body} ${hair}`).toEqual(LAYER_ORDER.filter(l => layers.includes(l)));
      // The layer a look swaps in is tinted exactly as the layer it replaces.
      for (const l of layers.filter(l => /^(body|cloth|hair)/.test(l))) expect(tinted.get(l), l).toBe(l.startsWith('body') ? 'skin' : l.startsWith('cloth') ? 'cloth' : 'hair');
    }
  });

  it('plans a camp routine from the actor\'s look, and the legacy one without it', () => {
    const look: Appearance = { body: 'female', hair: 'ponytail', skin: 3, hairColor: 1, cloth: 10 };
    const legacy = planActorRoutine(actor(2, 'rest'), SLOT);
    const chosen = planActorRoutine(actor(2, 'rest', { appearance: look }), SLOT);
    expect(chosen.layers).toEqual(['body-female', 'cloth-female', 'hair-ponytail', 'accent', 'weapon-sword', 'offhand-shield', 'held']);
    expect(chosen.tint).toEqual({ skin: SKIN_TONES[3].tint, hair: HAIR_COLOURS[1].tint, cloth: CLOTH_COLOURS[10].tint });
    // Only the look differs: the day's plan for this gladiator is the same.
    expect({ ...chosen, layers: legacy.layers, tint: legacy.tint }).toEqual(legacy);
    // A world snapshot cached before the key existed is the legacy look.
    const { appearance: _dropped, ...old } = actor(2, 'rest');
    expect(planActorRoutine(old as PublicActor, SLOT)).toEqual(legacy);
  });

  it('gives the fixture crowd a mix of legacy and chosen looks, so a preview shows every body and hair style', () => {
    const crowd = createDemoWorld(1_791_592_800_000, 50, 6).actors;
    const looks = crowd.map(a => a.appearance);
    expect(looks.filter(l => l === null).length).toBeGreaterThan(5);
    const chosen = looks.filter((l): l is Appearance => l !== null);
    expect(chosen.length).toBeGreaterThan(25);
    expect(new Set(chosen.map(l => l.body))).toEqual(new Set(BODIES));
    expect(new Set(chosen.map(l => l.hair))).toEqual(new Set(HAIRS));
    expect(createDemoWorld(1_791_592_800_000, 50, 6).actors.map(a => a.appearance)).toEqual(looks);
  });

  it('gives 50 gladiators in one zone 50 unique walkable positions inside it', () => {
    for (const location of ['training', 'rest', 'arena'] as const) {
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
    // A stress layout beyond the 50-row public world: 50 in camp plus 6 away.
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

  it('keeps players off every tile an NPC stands on', () => {
    const posts = npcPostTiles();
    for (const location of ['training', 'rest', 'arena', 'camp'] as const) {
      const actors = Array.from({ length: 50 }, (_, i) => actor(i, location));
      const { placements } = layoutCamp(actors, camp, SLOT, { reserved: posts });
      for (const p of placements.values()) expect(posts.has(`${p.x},${p.y}`), `${location} ${p.x},${p.y}`).toBe(false);
    }
  });

  it('fills a fixture world up to 50 public rows with a crowd spread over every camp zone', () => {
    const base = { revision: 'r', serverNowMs: 1_791_592_800_000, slotIndex: SLOT, actors: Array.from({ length: 14 }, (_, i) => actor(900 + i, i ? 'arena' : 'training')) };
    for (const world of [{ ...base, actors: base.actors.slice(0, 1) }, base]) {
      const crowded = withDemoCrowd(world);
      expect(crowded.actors).toHaveLength(50);
      expect(crowded.actors.slice(0, world.actors.length)).toEqual(world.actors);
      expect(crowded.actors.filter(a => a.location.startsWith('expedition'))).toHaveLength(6);
      const inCamp = crowded.actors.filter(a => !a.location.startsWith('expedition'));
      expect(new Set(inCamp.map(a => locationKind(a.location))), `${world.actors.length} fixture actors`).toEqual(new Set(['training', 'rest', 'arena', 'orientation', 'idle']));
    }
    // With its own Arena entrants, the fixture world keeps the arena to them: the crowd has no timelines to read.
    expect(withDemoCrowd({ ...base, actors: base.actors.slice(0, 1) }).actors.slice(1).some(a => a.location === 'arena')).toBe(true);
    expect(withDemoCrowd(base).actors.slice(base.actors.length).some(a => a.location === 'arena')).toBe(false);
  });

  // Task 23.9 (Task 23.8's PublicActor.resting): a gladiator resting at home is neither in the camp nor away.
  it('does not draw a resting gladiator in the camp', () => {
    const rest = { location: 'camp' as const, activityId: null, activityStatus: 'idle' as const, startsAtMs: null, endsAtMs: null, resting: true };
    const world = createDemoWorld(1_791_592_800_000, 44, 6);
    const resting = [actor(990, 'camp', rest), actor(991, 'camp', rest)];
    const { placements, away } = layoutCamp([...world.actors, ...resting], camp, world.slotIndex);
    expect(placements.size).toBe(44);
    expect(away).toHaveLength(6);
    for (const a of resting) {
      expect(placements.has(a.gladiatorId)).toBe(false);
      expect(away.some(b => b.gladiatorId === a.gladiatorId)).toBe(false);
    }
    // Everyone else keeps the spot they would have without them.
    const without = layoutCamp(world.actors, camp, world.slotIndex).placements;
    for (const [id, p] of without) expect(`${placements.get(id)!.x},${placements.get(id)!.y}`, id).toBe(`${p.x},${p.y}`);
    // A drawn gladiator that starts resting leaves the camp (its kept spot is not kept), and one that wakes is drawn again.
    const sleeper = world.actors.find(a => without.has(a.gladiatorId))!;
    const next = layoutCamp(world.actors.map(a => (a === sleeper ? { ...a, ...rest } : a)), camp, world.slotIndex, { previous: without });
    expect(next.placements.has(sleeper.gladiatorId)).toBe(false);
    expect(next.away.some(a => a.gladiatorId === sleeper.gladiatorId)).toBe(false);
    const woke = layoutCamp(world.actors, camp, world.slotIndex, { previous: next.placements });
    expect(woke.placements.has(sleeper.gladiatorId)).toBe(true);
  });

  it('leaves everyone else in place when one gladiator arrives or leaves', () => {
    const world = createDemoWorld(1_791_592_800_000, 50, 6);
    const first = layoutCamp(world.actors, camp, world.slotIndex).placements;
    const tile = (p: { x: number; y: number }) => `${p.x},${p.y}`;
    for (const leaver of world.actors.filter(a => first.has(a.gladiatorId)).slice(0, 12)) {
      const next = layoutCamp(world.actors.filter(a => a !== leaver), camp, world.slotIndex, { previous: first }).placements;
      const partner = first.get(leaver.gladiatorId)!.partnerId;
      for (const [id, p] of next) if (id !== partner) expect(tile(p), `${id} after ${leaver.gladiatorId} left`).toBe(tile(first.get(id)!));
    }
    const arrival = actor(999, 'training');
    const grown = layoutCamp([...world.actors, arrival], camp, world.slotIndex, { previous: first }).placements;
    for (const [id, p] of first) expect(tile(grown.get(id)!), id).toBe(tile(p));
    expect(grown.has(arrival.gladiatorId)).toBe(true);
  });
});

describe('wide prop depth slices', () => {
  it('follows the footprint front edge', () => {
    expect(frontEdgeY({ w: 3, d: 3 }, -96)).toBe(48);
    expect(frontEdgeY({ w: 3, d: 3 }, 0)).toBe(96);
    expect(frontEdgeY({ w: 3, d: 3 }, 96)).toBe(48);
    expect(frontEdgeY({ w: 3, d: 2 }, 32)).toBe(80);
  });

  it('lets actors win ties against one-tile props by rule, not by insertion order', () => {
    // A crate at (10, 10): actors on the SE and SW neighbouring tiles have feet exactly at its sort line.
    const crate = { w: 1, d: 1, layer: 'object' as const, sortY: 32 };
    const [slice] = drawSlices(crate, { w: 64, anchorX: 32 });
    const anchorY = worldToScreen(10, 10).y;
    for (const [x, y] of [[11.5, 10.5], [10.5, 11.5]]) expect(worldToScreen(x, y).y).toBeGreaterThan(anchorY + slice.depthOffset);
    expect(worldToScreen(10.5, 9.5).y).toBeLessThan(anchorY + slice.depthOffset);
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

describe('occlusion fading', () => {
  // A 40x40 prop at (0, 0) whose only opaque pixels are its lower-left quarter, sorted at y = 100.
  const prop = { left: 0, top: 0, width: 40, height: 40, slices: [{ x0: 0, x1: 40, depth: 100 }] };
  const alphaAt = (x: number, y: number) => (x < 20 && y >= 20 ? 255 : 0);

  it('fades a prop only where its opaque pixels cover the body of an actor behind it', () => {
    expect(hidesActor(prop, alphaAt, { x: 10, y: 60 })).toBe(true);
    // Same depth relation, but the body overlaps only transparent pixels.
    expect(hidesActor(prop, alphaAt, { x: 30, y: 60 })).toBe(false);
    // In front of the prop: never hidden.
    expect(hidesActor(prop, alphaAt, { x: 10, y: 120 })).toBe(false);
    // Far outside the image.
    expect(hidesActor(prop, alphaAt, { x: 200, y: 60 })).toBe(false);
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

  it('walks NPCs at the manifest walk speed so their feet do not slide', () => {
    expect(NPC_WALK_TILES_PER_SECOND).toBe(manifest.actors.gladiator.walk.tilesPerSecond);
  });

  it('schedules enough walking time between every pair of posts', () => {
    for (const routine of NPC_ROUTINES) for (const slack of routineSlack(routine, camp)) expect(slack, routine.npcId).toBeGreaterThanOrEqual(0);
  });

  it('walks between posts without teleporting', () => {
    const maxStep = (manifest.actors.gladiator.walk.tilesPerSecond * 250) / 1000 + 1e-6;
    for (const routine of NPC_ROUTINES) {
      let prev = planNpcPosition(routine, camp, 0);
      for (let t = 250; t <= 2 * routine.periodMs; t += 250) {
        const p = planNpcPosition(routine, camp, t);
        expect(Math.hypot(p.x - prev.x, p.y - prev.y), `${routine.npcId} at ${t}`).toBeLessThanOrEqual(maxStep);
        prev = p;
      }
    }
  });

  it('meets a partner face to face for most of their talking time', () => {
    const facesEachOther = (a: NpcPosition, b: NpcPosition) => {
      const [se, sw] = a.x < b.x ? [a, b] : [b, a];
      return se.facing === 'se' && sw.facing === 'sw' && Math.abs(sw.x - se.x - 1) < 1e-9 && Math.abs(se.y - sw.y - 1) < 1e-9;
    };
    let talking = 0;
    let meeting = 0;
    const pairs = new Set<string>();
    for (let t = 0; t < 180_000; t += 500) {
      const at = new Map(NPC_ROUTINES.map(r => [r.npcId, planNpcPosition(r, camp, t)]));
      for (const [id, p] of at) {
        if (p.action !== 'talk') continue;
        talking += 1;
        const partner = [...at].find(([other, q]) => other !== id && q.action === 'talk' && facesEachOther(p, q));
        if (partner) { meeting += 1; pairs.add([id, partner[0]].sort().join('+')); }
      }
    }
    expect(meeting / talking).toBeGreaterThan(0.7);
    expect([...pairs].sort()).toEqual(['armorer+smith', 'cook+healer', 'healer+trainer']);
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
    bridge.emit('select-character', { gladiatorId: 'g1', screen: { x: 10, y: 20 } });
    off();
    bridge.emit('select-character', { gladiatorId: 'g2', screen: null });
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith({ gladiatorId: 'g1', screen: { x: 10, y: 20 } });
    const merchant = vi.fn();
    bridge.on('open-merchant', merchant);
    bridge.destroy();
    bridge.emit('open-merchant', { merchant: 'weapons' });
    expect(merchant).not.toHaveBeenCalled();
    expect(bridge.listenerCount()).toBe(0);
  });

  it('removes the camp scene listeners on dispose so a remount on the same bridge starts clean', () => {
    const bridge = createSceneBridge();
    const destroyHandlers: (() => void)[] = [];
    const P = {
      Scene: class { constructor(_config: unknown) {} },
      Scenes: { Events: { DESTROY: 'destroy' } },
      Renderer: { Events: { RESTORE_WEBGL: 'restorewebgl' } },
    } as unknown as typeof import('phaser');
    const deps = { manifest, atlasData: {}, assetBase: '/assets/', world: null, bridge, now: () => 0, onReady() {}, onError() {} };
    const first = createCampScene(P, deps);
    expect(bridge.listenerCount()).toBe(4);
    // Commands sent before the scene is ready (or after it is gone) are ignored, not thrown.
    expect(() => bridge.emit('camera-zoom', { direction: 'in' })).not.toThrow();
    first.handle.dispose();
    first.handle.dispose();
    expect(bridge.listenerCount()).toBe(0);
    expect(first.handle.debug().disposed).toBe(true);

    const second = createCampScene(P, deps);
    expect(bridge.listenerCount()).toBe(4);
    // Game.destroy emits the scene DESTROY event, which disposes as well.
    const scene = second.scene as unknown as { events: { once(event: string, fn: () => void): void }; renderer: object; init(): void };
    scene.events = { once: (event, fn) => { if (event === 'destroy') destroyHandlers.push(fn); } };
    scene.renderer = { on() {}, off() {} };
    scene.init();
    destroyHandlers.forEach(fn => fn());
    expect(bridge.listenerCount()).toBe(0);
  });

  it('answers a refused follow after the request, so later subscribers end on the true state', async () => {
    const bridge = createSceneBridge();
    const P = { Scene: class { constructor(_config: unknown) {} } } as unknown as typeof import('phaser');
    createCampScene(P, { manifest, atlasData: {}, assetBase: '/assets/', world: null, bridge, now: () => 0, onReady() {}, onError() {} });
    const seen: (string | null)[] = [];
    bridge.on('follow-character', ({ gladiatorId }) => seen.push(gladiatorId));
    bridge.emit('follow-character', { gladiatorId: 'g1' }); // the scene is not ready, so it cannot follow
    await Promise.resolve();
    expect(seen).toEqual(['g1', null]);
  });

  it('drops a refusal queued by a scene that is disposed before it is sent', async () => {
    // On unmount the old scene can be disposed with a refusal still queued. If that null arrived, it
    // would cancel a follow that a replacement scene on the same bridge had just accepted. This pins
    // the guard: a disposed scene sends nothing.
    const bridge = createSceneBridge();
    const P = { Scene: class { constructor(_config: unknown) {} } } as unknown as typeof import('phaser');
    const old = createCampScene(P, { manifest, atlasData: {}, assetBase: '/assets/', world: null, bridge, now: () => 0, onReady() {}, onError() {} });
    const seen: (string | null)[] = [];
    bridge.on('follow-character', ({ gladiatorId }) => seen.push(gladiatorId));
    bridge.emit('follow-character', { gladiatorId: 'g1' });
    old.handle.dispose();
    await Promise.resolve();
    expect(seen).toEqual(['g1']);
  });

  it('supports every scene event the plan names', () => {
    const bridge = createSceneBridge();
    const seen: string[] = [];
    for (const event of ['select-character', 'open-merchant', 'view-expedition', 'view-replay', 'return-camp', 'follow-character'] as const) {
      bridge.on(event, () => seen.push(event));
    }
    bridge.emit('select-character', { gladiatorId: 'g', screen: null });
    bridge.emit('open-merchant', { merchant: 'armor' });
    bridge.emit('view-expedition', { activityId: 'a' });
    bridge.emit('view-replay', { activityId: 'a' });
    bridge.emit('return-camp', {});
    bridge.emit('follow-character', { gladiatorId: 'g' });
    expect(seen).toHaveLength(6);
  });
});
