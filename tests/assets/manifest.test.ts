import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../../assets/source/tools/png.mjs';
import {
  ACTIONS,
  loadAssetManifest,
  validateAnimations,
  validateFrameBounds,
  validateMaps,
  validateProvenance,
  type AssetManifest,
} from '@/game/assets';

const ROOT = join(__dirname, '..', '..');
const PUBLIC = join(ROOT, 'public', 'assets');
const manifest: AssetManifest = loadAssetManifest();

const images = new Map<string, { width: number; height: number; rgba: Uint8Array }>();
function image(path: string) {
  if (!images.has(path)) images.set(path, decodePng(readFileSync(join(PUBLIC, path))));
  return images.get(path)!;
}

function framePixels(atlasKey: string, frameName: string) {
  const atlas = manifest.atlases[atlasKey];
  const frame = atlas.frames[frameName];
  const { width, rgba } = image(atlas.image);
  const out: number[] = [];
  for (let y = frame.y; y < frame.y + frame.h; y += 1) {
    for (let x = frame.x; x < frame.x + frame.w; x += 1) {
      const i = (y * width + x) * 4;
      out.push(rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]);
    }
  }
  return out;
}

function opaqueCount(pixels: number[]) {
  let count = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) count += 1;
  return count;
}

describe('asset manifest contract', () => {
  it('declares the four maps and the complete action set', () => {
    expect(manifest.maps.map(m => m.id)).toEqual(['camp', 'woodland', 'outpost', 'mountain']);
    expect(manifest.actions).toEqual(expect.arrayContaining(['idle', 'walk', 'weights', 'practice', 'spar', 'sit', 'eat', 'sleep', 'search', 'attack', 'hit', 'defend', 'evade', 'defeat', 'victory']));
    expect([...ACTIONS].sort()).toEqual([...manifest.actions].sort());
  });

  it('uses 64x32 ground tiles and 64x64 actor frames', () => {
    expect(manifest.pixelScale).toEqual({ tileWidth: 64, tileHeight: 32, actorWidth: 64, actorHeight: 64 });
  });

  it('keeps every frame and anchor inside its image', () => {
    expect(validateFrameBounds(manifest)).toEqual([]);
  });

  it('records provenance and license for every shipped file', () => {
    expect(validateProvenance(manifest)).toEqual([]);
  });

  it('references only existing animation frames with positive durations', () => {
    expect(validateAnimations(manifest)).toEqual([]);
  });

  it('defines walkable, connected maps with zones and routes', () => {
    expect(validateMaps(manifest)).toEqual([]);
  });
});

describe('shipped files', () => {
  it('match image sizes and provenance hashes on disk', () => {
    for (const record of manifest.provenance) {
      const path = join(PUBLIC, record.file);
      expect(existsSync(path), record.file).toBe(true);
      expect(createHash('sha256').update(readFileSync(path)).digest('hex'), record.file).toBe(record.sha256);
    }
    for (const atlas of Object.values(manifest.atlases)) {
      const png = image(atlas.image);
      expect([png.width, png.height], atlas.key).toEqual([atlas.width, atlas.height]);
    }
  });

  it('keeps generator sources and license notes in assets/source', () => {
    expect(existsSync(join(ROOT, 'assets', 'source', 'README.md'))).toBe(true);
    const provenance = JSON.parse(readFileSync(join(ROOT, 'assets', 'source', 'provenance.json'), 'utf8'));
    expect(provenance.files.map((f: { file: string }) => f.file).sort()).toEqual(manifest.provenance.map(r => r.file).sort());
    for (const record of manifest.provenance) expect(existsSync(join(ROOT, record.generator)), record.generator).toBe(true);
  });

  it('regenerates byte-identical files from the committed generators', () => {
    const out = execFileSync(process.execPath, [join(ROOT, 'assets', 'source', 'build-assets.mjs'), '--check'], { encoding: 'utf8' });
    expect(out).toMatch(/assets up to date/);
  }, 60_000);

  it('uses only hard-edged palette colors in every atlas', () => {
    const palette = new Set(Object.values(manifest.palette).map(hex => hex.toLowerCase()));
    for (const atlas of Object.values(manifest.atlases)) {
      const { rgba } = image(atlas.image);
      const strays = new Set<string>();
      for (let i = 0; i < rgba.length; i += 4) {
        const a = rgba[i + 3];
        if (a === 0) continue;
        if (a !== 255) { strays.add(`alpha:${a}`); continue; }
        const hex = `#${[rgba[i], rgba[i + 1], rgba[i + 2]].map(v => v.toString(16).padStart(2, '0')).join('')}`;
        if (!palette.has(hex)) strays.add(hex);
      }
      expect([...strays].slice(0, 10), atlas.key).toEqual([]);
    }
  });
});

describe('gladiator animation package', () => {
  const gladiator = manifest.actors.gladiator;

  it('animates every action with multiple distinct frames', () => {
    for (const action of ACTIONS) {
      const anim = manifest.animations[gladiator.animations[action].se];
      expect(anim, action).toBeDefined();
      expect(anim.frames.length, action).toBeGreaterThanOrEqual(2);
      const unique = new Set(anim.frames.map(f => framePixels(gladiator.atlas, f).join(',')));
      expect(unique.size, `${action} frames must differ`).toBeGreaterThanOrEqual(2);
    }
  });

  it('draws real south-east and north-east walking and idle frames and mirrors the rest', () => {
    for (const action of ['idle', 'walk'] as const) {
      const se = manifest.animations[gladiator.animations[action].se];
      const ne = manifest.animations[gladiator.animations[action].ne!];
      expect(ne.frames).not.toEqual(se.frames);
      expect(framePixels(gladiator.atlas, ne.frames[0])).not.toEqual(framePixels(gladiator.atlas, se.frames[0]));
    }
    expect(manifest.animations[gladiator.animations.walk.se].frames.length).toBeGreaterThanOrEqual(6);
    expect(manifest.directions).toEqual({
      se: { source: 'se', flipX: false }, sw: { source: 'se', flipX: true },
      ne: { source: 'ne', flipX: false }, nw: { source: 'ne', flipX: true },
    });
  });

  it('loops ambient routines and plays combat reactions once', () => {
    const loops = Object.fromEntries(ACTIONS.map(a => [a, manifest.animations[gladiator.animations[a].se].loop]));
    expect(loops).toEqual({
      idle: true, walk: true, weights: true, practice: true, spar: true, sit: true, eat: true, sleep: true, search: true,
      attack: false, hit: false, defend: false, evade: false, defeat: false, victory: false,
    });
  });

  it('layers four weapon silhouettes, a shield, two armors and head gear over one reusable body', () => {
    expect(gladiator.layers.map(l => l.id)).toEqual(expect.arrayContaining([
      'body', 'cloth', 'hair', 'armor-light', 'armor-heavy', 'head-hood', 'head-helmet',
      'weapon-sword', 'weapon-axe', 'weapon-spear', 'weapon-bow', 'offhand-shield',
    ]));
    const bodyFrames = Object.keys(manifest.atlases[gladiator.atlas].frames).filter(k => k.startsWith('body/'));
    for (const layer of gladiator.layers) {
      for (const frame of bodyFrames) {
        expect(manifest.atlases[gladiator.atlas].frames[frame.replace(/^body\//, `${layer.id}/`)], `${layer.id} ${frame}`).toBeDefined();
      }
    }
    const silhouettes = ['weapon-sword', 'weapon-axe', 'weapon-spear', 'weapon-bow'].map(id => framePixels(gladiator.atlas, `${id}/idle/se/0`).join(','));
    expect(new Set(silhouettes).size).toBe(4);
    expect(opaqueCount(framePixels(gladiator.atlas, 'armor-heavy/idle/se/0'))).toBeGreaterThan(opaqueCount(framePixels(gladiator.atlas, 'armor-light/idle/se/0')));
  });

  it('keeps a transparent border so nearest-neighbour scaling never bleeds', () => {
    for (const name of Object.keys(manifest.atlases[gladiator.atlas].frames)) {
      const px = framePixels(gladiator.atlas, name);
      const size = 64;
      for (let i = 0; i < size; i += 1) {
        for (const [x, y] of [[i, 0], [i, size - 1], [0, i], [size - 1, i]]) {
          expect(px[(y * size + x) * 4 + 3], `${name} border ${x},${y}`).toBe(0);
        }
      }
    }
  });
});

describe('world actors', () => {
  it('provides six visually distinct NPCs with walk, talk and tend loops', () => {
    expect(manifest.actors.npcs).toHaveLength(6);
    const looks = new Set(manifest.actors.npcs.map(npc => framePixels(npc.atlas, manifest.animations[npc.animations.idle!.se].frames[0]).join(',')));
    expect(looks.size).toBe(6);
    for (const npc of manifest.actors.npcs) {
      for (const action of ['idle', 'walk', 'talk', 'tend'] as const) {
        expect(manifest.animations[npc.animations[action]!.se].frames.length, `${npc.id} ${action}`).toBeGreaterThanOrEqual(2);
      }
      expect(npc.animations.walk!.ne, npc.id).toBeDefined();
    }
  });

  it('provides a fighting creature for each expedition', () => {
    expect(manifest.actors.creatures.map(c => c.expedition)).toEqual(['woodland', 'outpost', 'mountain']);
    for (const creature of manifest.actors.creatures) {
      for (const action of ['idle', 'walk', 'attack', 'hit', 'defend', 'evade', 'defeat'] as const) {
        expect(manifest.animations[creature.animations[action]!.se].frames.length, `${creature.id} ${action}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('ships combat effects and interface icons', () => {
    expect(Object.keys(manifest.effects)).toEqual(expect.arrayContaining(['hit', 'critical', 'defend', 'evade', 'defeat', 'victory', 'dust']));
    expect(Object.keys(manifest.icons)).toEqual(expect.arrayContaining(['money', 'renown', 'stamina', 'xp', 'level', 'training', 'rest', 'expedition', 'arena', 'sword', 'axe', 'spear', 'bow', 'shield', 'armor-light', 'armor-heavy']));
  });
});

describe('camp and expedition maps', () => {
  it('lays out the five camp zones with room for 50 gladiators each', () => {
    const camp = manifest.maps.find(m => m.id === 'camp')!;
    expect(camp.zones.map(z => z.id).sort()).toEqual(['arena', 'expedition-gate', 'merchants', 'rest', 'training']);
    for (const zone of camp.zones) expect(zone.walkableTiles, zone.id).toBeGreaterThanOrEqual(50);
    const kinds = new Set(camp.zones.flatMap(z => z.stations.map(s => s.kind)));
    for (const kind of ['weights', 'practice', 'spar', 'sit', 'eat', 'sleep', 'merchant-weapons', 'merchant-armor', 'gate', 'arena-ring', 'arena-staging']) expect(kinds, kind).toContain(kind);
    expect(camp.props.some(p => p.occludes)).toBe(true);
    expect(camp.lights.length).toBeGreaterThanOrEqual(6);
  });

  it('gives every expedition a route with three encounters and a safe return point', () => {
    for (const id of ['woodland', 'outpost', 'mountain'] as const) {
      const map = manifest.maps.find(m => m.id === id)!;
      expect(map.expedition, id).toBeDefined();
      expect(map.expedition!.encounters.map(e => e.index), id).toEqual([1, 2, 3]);
      expect(map.expedition!.route.length, id).toBeGreaterThanOrEqual(4);
      expect(map.expedition!.searchSpots.length, id).toBeGreaterThanOrEqual(3);
      expect(map.expedition!.safePoint, id).toBeDefined();
    }
  });
});
