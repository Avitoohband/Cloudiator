import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../../assets/source/tools/png.mjs';
import { loadAssetManifest, type AssetManifest, type MapData } from '@/game/assets';
import { findPath, gridFromMap } from '@/game/paths';
import { worldToScreen } from '@/game/iso';

// Task 7c, Punchy's request (approved by Avi on 2026-10-28): the camp's 12 beds are low cots two tiles long, not one-tile
// bedrolls. This pins the approved layout: two blocks of six beside the tents, aisles between and around them, the bed's head
// tile as the sleep station, and every bed still a walkable floor prop that a gladiator can reach.

const manifest: AssetManifest = loadAssetManifest();
const camp: MapData = manifest.maps.find(m => m.id === 'camp')!;
const rest = camp.zones.find(z => z.id === 'rest')!;
const beds = camp.props.filter(p => p.frame.startsWith('bedroll-'));
const tiles = (p: { x: number; y: number; w: number; d: number }) =>
  Array.from({ length: p.w * p.d }, (_, i) => ({ x: p.x + (i % p.w), y: p.y + Math.floor(i / p.w) }));

/** Opaque test for one frame of an atlas, in the frame's own pixel coordinates. */
function opaque(atlasKey: string, frameName: string) {
  const atlas = manifest.atlases[atlasKey];
  const frame = atlas.frames[frameName];
  const { width, rgba } = decodePng(readFileSync(join(__dirname, '..', '..', 'public', 'assets', atlas.image)));
  return { frame, at: (x: number, y: number) => x >= 0 && y >= 0 && x < frame.w && y < frame.h && rgba[((frame.y + y) * width + frame.x + x) * 4 + 3] > 0 };
}

/** The approved anchors: x 14, 16, 18 by y 35 and 36 (north block), and by y 39 and 40 (south block). */
const APPROVED_ANCHORS = [14, 16, 18].flatMap(x => [35, 36, 39, 40].map(y => `${x},${y}`)).sort();

describe('camp beds (Task 7c)', () => {
  it('has 12 beds, six teal and six crimson, each a two by one cot', () => {
    expect(beds).toHaveLength(12);
    expect(beds.filter(b => b.frame === 'bedroll-teal')).toHaveLength(6);
    expect(beds.filter(b => b.frame === 'bedroll-crimson')).toHaveLength(6);
    for (const bed of beds) expect([bed.w, bed.d], bed.id).toEqual([2, 1]);
    for (const frame of ['bedroll-teal', 'bedroll-crimson']) {
      expect(manifest.atlases[camp.propsAtlas].frames[frame].meta?.footprint, frame).toEqual({ w: 2, d: 1 });
    }
  });

  it('places the beds in the two approved blocks of six, with aisles at y 34, y 37-38 and y 41', () => {
    expect(beds.map(b => `${b.x},${b.y}`).sort()).toEqual(APPROVED_ANCHORS);
    const ys = new Set(beds.flatMap(tiles).map(t => t.y));
    for (const aisle of [34, 37, 38, 41]) expect(ys.has(aisle), `y ${aisle}`).toBe(false);
    // Three beds end to end: each block spans x 14 to 19.
    expect(Math.min(...beds.map(b => b.x))).toBe(14);
    expect(Math.max(...beds.map(b => b.x + b.w - 1))).toBe(19);
  });

  it('keeps every bed a walkable floor prop, so it blocks no tile and draws under every actor', () => {
    for (const bed of beds) {
      expect([bed.layer, bed.walkable, bed.occludes], bed.id).toEqual(['floor', true, false]);
      for (const t of tiles(bed)) expect(camp.walkable[t.y][t.x], `${bed.id} tile ${t.x},${t.y}`).toBe('1');
    }
  });

  it('overlaps nothing: no two beds share a tile and no other prop stands on a bed tile', () => {
    const seen = new Map<string, string>();
    for (const bed of beds) for (const t of tiles(bed)) {
      const key = `${t.x},${t.y}`;
      expect(seen.get(key), `${bed.id} overlaps ${seen.get(key)} at ${key}`).toBeUndefined();
      seen.set(key, bed.id);
    }
    for (const prop of camp.props) {
      if (beds.includes(prop)) continue;
      for (const t of tiles(prop)) expect(seen.get(`${t.x},${t.y}`), `${prop.id} stands on ${seen.get(`${t.x},${t.y}`)}`).toBeUndefined();
    }
  });

  it('keeps every bed tile off the sand lanes and the path graph', () => {
    // A ground frame is `camp/<mask>/<variant>`; the mask has one bit per sand corner of the tile (15 is all sand).
    const sandCorners = (x: number, y: number) => Number(camp.groundFrames[camp.ground[y * camp.width + x]].split('/')[1]).toString(2).replace(/0/g, '').length;
    const sandTiles = new Set<string>();
    camp.ground.forEach((_, i) => { if (sandCorners(i % camp.width, Math.floor(i / camp.width)) === 4) sandTiles.add(`${i % camp.width},${Math.floor(i / camp.width)}`); });
    expect(sandTiles.size).toBeGreaterThan(100);
    // Every tile the path graph passes through: its nodes, and each edge sampled a quarter tile at a time.
    const node = new Map(camp.paths.nodes.map(n => [n.id, n]));
    const pathTiles = new Set<string>(camp.paths.nodes.map(n => `${n.x},${n.y}`));
    for (const [a, b] of camp.paths.edges) {
      const [p, q] = [node.get(a)!, node.get(b)!];
      const steps = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) * 4);
      for (let s = 0; s <= steps; s += 1) pathTiles.add(`${Math.floor(p.x + 0.5 + ((q.x - p.x) * s) / steps)},${Math.floor(p.y + 0.5 + ((q.y - p.y) * s) / steps)}`);
    }
    for (const bed of beds) for (const t of tiles(bed)) {
      expect(sandTiles.has(`${t.x},${t.y}`), `${bed.id} on sand at ${t.x},${t.y}`).toBe(false);
      // The foot tile of the east beds (x 19) is where the grass meets the lane, as in the approved mockup: at most the lane's
      // two edge corners, never more.
      expect(sandCorners(t.x, t.y), `${bed.id} at ${t.x},${t.y} reaches into the sand lane`).toBeLessThanOrEqual(2);
      expect(pathTiles.has(`${t.x},${t.y}`), `${bed.id} on a path tile at ${t.x},${t.y}`).toBe(false);
    }
  });

  it('gives each bed one sleep station on its head tile, facing south-east, inside the resting quarters', () => {
    const sleep = rest.stations.filter(s => s.kind === 'sleep');
    expect(sleep).toHaveLength(12);
    expect(new Set(sleep.map(s => s.id)).size).toBe(12);
    expect(sleep.map(s => `${s.x},${s.y}`).sort()).toEqual(APPROVED_ANCHORS);
    for (const s of sleep) {
      expect(s.facing, s.id).toBe('se');
      const bed = beds.find(b => b.x === s.x && b.y === s.y);
      expect(bed, `a bed has ${s.id} as its head tile`).toBeDefined();
      expect(s.x >= rest.bounds.x && s.x < rest.bounds.x + rest.bounds.w && s.y >= rest.bounds.y && s.y < rest.bounds.y + rest.bounds.h, s.id).toBe(true);
    }
    // The other resting stations keep their counts: sit and eat are unchanged by the bigger beds.
    expect(rest.stations.filter(s => s.kind === 'sit')).toHaveLength(8);
    expect(rest.stations.filter(s => s.kind === 'eat')).toHaveLength(6);
    // No two stations of the camp share a tile.
    const all = camp.zones.flatMap(z => z.stations).map(s => `${s.x},${s.y}`);
    expect(new Set(all).size).toBe(all.length);
  });

  it('draws the sleeping gladiator entirely on the bed, in both sleep frames', () => {
    const gladiator = manifest.actors.gladiator;
    const sleep = rest.stations.filter(s => s.kind === 'sleep');
    const props = manifest.atlases[camp.propsAtlas].frames;
    let checked = 0;
    for (const [i, s] of sleep.entries()) {
      const bed = beds.find(b => b.x === s.x && b.y === s.y)!;
      const bedArt = opaque(camp.propsAtlas, bed.frame);
      const anchor = worldToScreen(bed.x, bed.y); // the bed's anchor is the north vertex of its first tile
      const feet = worldToScreen(s.x + 0.5, s.y + 0.5); // the sleeper stands at the tile centre
      for (const name of manifest.animations[gladiator.animations.sleep!.se].frames.filter(f => f.startsWith('body/'))) {
        const body = opaque(gladiator.atlas, name);
        for (let y = 0; y < body.frame.h; y += 1) for (let x = 0; x < body.frame.w; x += 1) {
          if (!body.at(x, y)) continue;
          const bx = Math.floor(feet.x - gladiator.anchor.x + x - (anchor.x - props[bed.frame].anchorX));
          const by = Math.floor(feet.y - gladiator.anchor.y + y - (anchor.y - props[bed.frame].anchorY));
          expect(bedArt.at(bx, by), `sleeper ${i} (${name}) pixel ${x},${y} is off the bed`).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(12 * 2 * 400);
  });

  it('lets a gladiator walk from the rest path node to every sleep station', () => {
    const grid = gridFromMap(camp);
    const start = camp.paths.nodes.find(n => n.id === 'rest')!;
    for (const s of rest.stations.filter(st => st.kind === 'sleep')) {
      const path = findPath(grid, { x: start.x, y: start.y }, { x: s.x, y: s.y });
      expect(path, `${s.id} at ${s.x},${s.y}`).not.toBeNull();
      expect(path!.at(-1)).toEqual({ x: s.x, y: s.y });
    }
  });
});
