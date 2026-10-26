// The appearance art (Task 2 of the gladiator appearance change): a female body and clothes, long hair and a
// ponytail, drawn on the shared skeleton so every equipment layer still fits over them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../../assets/source/tools/png.mjs';
import { Mask } from '../../assets/source/tools/canvas.mjs';
import { limbShapes, skeleton, torsoPolygon } from '../../assets/source/generators/rig.mjs';
import { GLADIATOR_ACTIONS } from '../../assets/source/generators/poses.mjs';
import { loadAssetManifest } from '@/game/assets';

const ROOT = join(__dirname, '..', '..');
const manifest = loadAssetManifest();
const gladiator = manifest.actors.gladiator;
const atlas = manifest.atlases[gladiator.atlas];
const png = decodePng(readFileSync(join(ROOT, 'public', 'assets', atlas.image)));
const SIZE = 64;
const NEW_LAYERS = { 'body-female': 'skin', 'cloth-female': 'cloth', 'hair-long': 'hair', 'hair-ponytail': 'hair' } as const;
const REPLACES = { 'body-female': 'body', 'cloth-female': 'cloth', 'hair-long': 'hair', 'hair-ponytail': 'hair' } as const;
const bodyFrames = Object.keys(atlas.frames).filter(name => name.startsWith('body/'));
const layerFrame = (layer: string, bodyFrame: string) => bodyFrame.replace(/^body\//, `${layer}/`);

/** RGBA of one 64x64 frame, row by row. */
function pixels(name: string) {
  const f = atlas.frames[name];
  if (!f) throw new Error(`missing frame ${name}`);
  const out = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    const from = ((f.y + y) * png.width + f.x) * 4;
    out.set(png.rgba.subarray(from, from + SIZE * 4), y * SIZE * 4);
  }
  return out;
}
const opaque = (name: string) => { const px = pixels(name); return Array.from({ length: SIZE * SIZE }, (_, i) => px[i * 4 + 3] > 0); };
const count = (mask: boolean[]) => mask.filter(Boolean).length;
const minus = (a: boolean[], b: boolean[]) => a.map((v, i) => v && !b[i]);

describe('gladiator appearance art', () => {
  it('adds the female body and clothes, long hair and ponytail as tinted layers with every body frame', () => {
    expect(bodyFrames).toHaveLength(71);
    for (const [id, tint] of Object.entries(NEW_LAYERS)) {
      const layer = gladiator.layers.find(l => l.id === id);
      expect(layer, id).toMatchObject({ tintable: true, tint });
      expect(layer!.slot, `${id} takes the slot of ${REPLACES[id as keyof typeof REPLACES]}`).toBe(gladiator.layers.find(l => l.id === REPLACES[id as keyof typeof REPLACES])!.slot);
      for (const frame of bodyFrames) expect(atlas.frames[layerFrame(id, frame)], `${id} ${frame}`).toBeDefined();
    }
  });

  it('keeps the gladiator atlas under 4096 px tall', () => {
    expect(png.height).toBe(atlas.height);
    expect(atlas.height).toBeLessThan(4096);
  });

  it('female body and clothes stay inside the male masks', () => {
    const outside: string[] = [];
    for (const frame of bodyFrames) {
      const cloth = opaque(layerFrame('cloth', frame));
      const male = opaque(frame).map((v, i) => v || cloth[i]);
      for (const id of ['body-female', 'cloth-female']) {
        const extra = count(minus(opaque(layerFrame(id, frame)), male));
        if (extra) outside.push(`${layerFrame(id, frame)}: ${extra} px`);
      }
    }
    expect(outside).toEqual([]);
  });

  it('paints every frame of the new layers in hard-edged palette colours', () => {
    const palette = new Set(Object.values(manifest.palette).map(hex => hex.toLowerCase()));
    const strays = new Set<string>();
    const empty: string[] = [];
    for (const id of Object.keys(NEW_LAYERS)) for (const frame of bodyFrames) {
      const name = layerFrame(id, frame);
      const px = pixels(name);
      let seen = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue;
        seen += 1;
        if (px[i + 3] !== 255) { strays.add(`${name} alpha ${px[i + 3]}`); continue; }
        const hex = `#${[px[i], px[i + 1], px[i + 2]].map(v => v.toString(16).padStart(2, '0')).join('')}`;
        if (!palette.has(hex)) strays.add(`${name} ${hex}`);
      }
      if (!seen) empty.push(name);
    }
    expect([...strays].slice(0, 10)).toEqual([]);
    expect(empty).toEqual([]);
  });

  it('gives the female body its own face and torso and a chest wrap in the clothes layer', () => {
    for (const frame of ['body/idle/se/0', 'body/idle/ne/0', 'body/walk/se/2']) {
      expect(pixels(layerFrame('body-female', frame)), frame).not.toEqual(pixels(frame));
      expect(pixels(layerFrame('cloth-female', frame)), frame).not.toEqual(pixels(layerFrame('cloth', frame)));
    }
    // The upper chest (2-7 px below the neck, inside the torso, clear of the arms) is bare on the male and wrapped
    // on the female.
    for (const view of ['front', 'back'] as const) {
      const S = skeleton(GLADIATOR_ACTIONS.idle.frames[0], view) as unknown as { p: Record<string, [number, number]> };
      const torso = new Mask(SIZE, SIZE).polygon(torsoPolygon(S));
      const limbs = limbShapes(S);
      const arms = limbs.nearArm.clone().union(limbs.farArm).dilate();
      const chest = Array.from({ length: SIZE * SIZE }, (_, i) => {
        const x = i % SIZE; const y = Math.floor(i / SIZE);
        return torso.has(x, y) && !arms.has(x, y) && y >= S.p.neck[1] + 2 && y <= S.p.neck[1] + 7;
      });
      const dir = view === 'front' ? 'se' : 'ne';
      const covered = (layer: string) => count(opaque(`${layer}/idle/${dir}/0`).map((v, i) => v && chest[i]));
      expect(covered('cloth'), `${view}: the male chest is bare`).toBe(0);
      expect(covered('cloth-female') / count(chest), `${view}: the female chest is wrapped`).toBeGreaterThan(0.5);
    }
  });

  it('draws short, long and ponytail hair as three distinct silhouettes', () => {
    for (const frame of ['idle/se/0', 'idle/ne/0', 'walk/se/2', 'attack/se/1']) {
      const short = opaque(`hair/${frame}`);
      const long = opaque(`hair-long/${frame}`);
      const pony = opaque(`hair-ponytail/${frame}`);
      expect(count(minus(long, short)), `${frame}: long hair falls past the short hair`).toBeGreaterThan(12);
      expect(count(minus(pony, short)), `${frame}: the ponytail hangs past the short hair`).toBeGreaterThan(8);
      expect(count(minus(long, pony)) + count(minus(pony, long)), `${frame}: long and ponytail differ`).toBeGreaterThan(12);
    }
  });
});
