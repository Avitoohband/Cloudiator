// Sleeping without armor (Task 14): every layer has the sleep/se frames the scenes show when they swap the visible set, and the
// hair layers, which come back in bed under no head gear, are not empty.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../../assets/source/tools/png.mjs';
import { loadAssetManifest } from '@/game/assets';

const manifest = loadAssetManifest();
const gladiator = manifest.actors.gladiator;
const atlas = manifest.atlases[gladiator.atlas];
const png = decodePng(readFileSync(join(__dirname, '..', '..', 'public', 'assets', atlas.image)));
// The animation lists the body's frame names, `body/sleep/se/<n>`; every other layer has the same name under its own id.
const frames = manifest.animations['gladiator/sleep/se'].frames;
const frameOf = (layer: string, frame: string) => frame.replace(/^body\//, `${layer}/`);

function opaque(name: string): number {
  const f = atlas.frames[name];
  let count = 0;
  for (let y = 0; y < f.h; y += 1) for (let x = 0; x < f.w; x += 1) if (png.rgba[((f.y + y) * png.width + f.x + x) * 4 + 3] > 0) count += 1;
  return count;
}

describe('sleep frames for every layer', () => {
  it('has <layer>/sleep/se/<n> in the atlas for every layer and sleep frame', () => {
    expect(frames.length).toBeGreaterThan(0);
    for (const layer of gladiator.layers) for (const n of frames) expect(atlas.frames[frameOf(layer.id, n)], `${layer.id}/${n}`).toBeTruthy();
  });

  it('draws the three hair layers in bed', () => {
    for (const layer of ['hair', 'hair-long', 'hair-ponytail']) for (const n of frames) expect(opaque(frameOf(layer, n)), `${layer}/${n}`).toBeGreaterThan(0);
  });
});
