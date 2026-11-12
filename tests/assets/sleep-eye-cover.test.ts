// The sleeper's eye cover (Task 11b; final review 2026-11-12). It was painted into the skin-tinted body layer, so on deep skin with
// black hair it was a faint dark strand, not a cover. It is now in the untinted `held` layer, which every scene draws over the hair:
// a 1-2 px band of light cloth across the closed eyes with its own 1 px outline, inside the head.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../../assets/source/tools/png.mjs';
import { PALETTE } from '../../assets/source/tools/palette.mjs';
import { loadAssetManifest } from '@/game/assets';
import { LAYER_ORDER, layersFor } from '@/game/actors';

const manifest = loadAssetManifest();
const gladiator = manifest.actors.gladiator;
const atlas = manifest.atlases[gladiator.atlas];
const png = decodePng(readFileSync(join(__dirname, '..', '..', 'public', 'assets', atlas.image)));
const SLEEP = manifest.animations[gladiator.animations.sleep!.se].frames;
const hex = (name: keyof typeof PALETTE) => PALETTE[name].toLowerCase();
const FILL = new Set([hex('water1'), hex('water2')]);

/** The palette colour of each pixel of a 64x64 frame ('' where it is transparent). */
function colours(name: string) {
  const f = atlas.frames[name];
  if (!f) throw new Error(`missing frame ${name}`);
  return (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= f.w || y >= f.h) return '';
    const i = ((f.y + y) * png.width + f.x + x) * 4;
    if (png.rgba[i + 3] === 0) return '';
    return `#${[0, 1, 2].map(k => png.rgba[i + k].toString(16).padStart(2, '0')).join('')}`;
  };
}

describe('the sleeper\'s eye cover', () => {
  it('is drawn in the untinted held layer, which every gladiator draws last, over its hair and gear', () => {
    expect(gladiator.layers.find(layer => layer.id === 'held')).toEqual({ id: 'held', slot: 'held', tintable: false });
    expect(LAYER_ORDER.at(-1)).toBe('held');
    for (const look of [layersFor([]), layersFor(['iron-helmet', 'heavy-armor', 'spear']), layersFor([], { body: 'female', hair: 'long', skin: 4, hairColor: 1, cloth: 0 })]) {
      expect(look.at(-1)).toBe('held');
    }
  });

  it('is a 1-2 px band of light cloth across the eyes with its own 1 px outline, on the head, in both sleep frames', () => {
    expect(SLEEP).toHaveLength(2);
    for (const frame of SLEEP) {
      const held = colours(frame.replace(/^body\//, 'held/')), body = colours(frame);
      const fill: [number, number][] = [];
      for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) if (FILL.has(held(x, y))) fill.push([x, y]);
      expect(fill.length, frame).toBeGreaterThanOrEqual(6);
      const xs = fill.map(([x]) => x), ys = fill.map(([, y]) => y);
      const span = [Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1];
      expect(Math.min(...span), `${frame}: band thickness`).toBeGreaterThanOrEqual(1);
      expect(Math.min(...span), `${frame}: band thickness`).toBeLessThanOrEqual(2);
      expect(Math.max(...span), `${frame}: band length`).toBeGreaterThanOrEqual(3);
      for (const [x, y] of fill) {
        expect(body(x, y), `${frame}: ${x},${y} lies on the head`).not.toBe('');
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const next = held(x + dx, y + dy);
          expect(FILL.has(next) || next === hex('outline'), `${frame}: ${x + dx},${y + dy} outlines the band`).toBe(true);
        }
      }
      // Nothing of the cover is left in a tinted layer: the old dark cover (gray4 and shadow) is gone from both bodies' heads.
      const dark: string[] = [];
      for (const layer of ['body', 'body-female']) {
        const px = colours(frame.replace(/^body\//, `${layer}/`));
        for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) if ([hex('gray4'), hex('shadow')].includes(px(x, y))) dark.push(`${layer} ${x},${y}`);
      }
      expect(dark, frame).toEqual([]);
    }
  });
});
