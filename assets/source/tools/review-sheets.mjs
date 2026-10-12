#!/usr/bin/env node
// Writes the art-review evidence images in docs/operations/art-review/ from the shipped atlases:
// one contact sheet per gladiator loadout (every frame of every animation, 2x), NPCs, creatures,
// effects, icons, and full renders of all four maps with sample actors.
//   node assets/source/tools/review-sheets.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PixelCanvas } from './canvas.mjs';
import { decodePng, encodePng } from './png.mjs';

/** Multiply tint, as the runtime does with Phaser setTint. */
function tinted(img, tint) {
  if (!tint) return img;
  const out = new PixelCanvas(img.width, img.height);
  out.data.set(img.data);
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = Math.round((out.data[i] * ((tint >> 16) & 255)) / 255);
    out.data[i + 1] = Math.round((out.data[i + 1] * ((tint >> 8) & 255)) / 255);
    out.data[i + 2] = Math.round((out.data[i + 2] * (tint & 255)) / 255);
  }
  return out;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const ASSETS = join(ROOT, 'public', 'assets');
const OUT = join(ROOT, 'docs', 'operations', 'art-review');
mkdirSync(OUT, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'));
const sheets = {};
function frame(key, name) {
  if (!sheets[key]) {
    const def = manifest.atlases[key];
    const img = decodePng(readFileSync(join(ASSETS, def.image)));
    const c = new PixelCanvas(img.width, img.height);
    c.data.set(img.rgba);
    sheets[key] = { c, frames: JSON.parse(readFileSync(join(ASSETS, def.data), 'utf8')).frames };
  }
  const f = sheets[key].frames[name].frame;
  return sheets[key].c.crop(f.x, f.y, f.w, f.h);
}
function upscale(c, s) {
  const big = new PixelCanvas(c.width * s, c.height * s);
  for (let y = 0; y < c.height; y += 1) for (let x = 0; x < c.width; x += 1) {
    const k = (y * c.width + x) * 4;
    for (let dy = 0; dy < s; dy += 1) for (let dx = 0; dx < s; dx += 1) big.data.set(c.data.subarray(k, k + 4), ((y * s + dy) * big.width + x * s + dx) * 4);
  }
  return big;
}
function grid(rows, cell, bg) {
  const cols = Math.max(...rows.map(r => r.length));
  const c = new PixelCanvas(cols * cell[0], rows.length * cell[1]);
  for (let y = 0; y < c.height; y += 1) for (let x = 0; x < c.width; x += 1) c.set(x, y, (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? bg[0] : bg[1]);
  rows.forEach((row, r) => row.forEach((img, i) => { if (img) c.blit(img, i * cell[0], r * cell[1]); }));
  return c;
}
const save = (name, c, s = 2) => { const big = upscale(c, s); writeFileSync(join(OUT, name), encodePng(big.width, big.height, big.data)); console.log(name, big.width, big.height); };

const g = manifest.actors.gladiator;
// Each sheet uses runtime-style multiply tints: [skin, cloth/accent/crest, hair].
const loadouts = {
  'sword-shield': [['body', 'cloth', 'hair', 'accent', 'weapon-sword', 'offhand-shield', 'held'], [0xffffff, 0x22a39d, 0x5a3418]],
  'axe-light-hood': [['body', 'cloth', 'armor-light', 'accent', 'head-hood', 'weapon-axe', 'offhand-shield', 'held'], [0xcf9a74, 0xbd3429, 0x2a2024]],
  'spear-heavy-helmet': [['body', 'cloth', 'armor-heavy', 'accent', 'head-helmet', 'head-helmet-crest', 'weapon-spear', 'held'], [0x9f6e4c, 0xf2b43d, 0x2a2024]],
  'bow-light': [['body', 'cloth', 'hair', 'armor-light', 'accent', 'weapon-bow', 'held'], [0x7a5038, 0x6a4fb8, 0xe6c06a]],
};
const tintKey = new Map(g.layers.map(l => [l.id, l.tint]));
for (const [id, [layers, [skin, cloth, hair]]] of Object.entries(loadouts)) {
  const tints = { skin, cloth, hair };
  const rows = [];
  for (const [action, dirs] of Object.entries(g.animations)) for (const dir of Object.values(dirs)) {
    rows.push(manifest.animations[dir].frames.map(name => {
      const c = new PixelCanvas(64, 64);
      for (const l of layers) c.blit(tinted(frame(g.atlas, name.replace(/^body\//, `${l}/`)), tints[tintKey.get(l)]), 0, 0);
      return c;
    }));
  }
  save(`gladiator-${id}.png`, grid(rows, [64, 64], ['sand1', 'sand2']));
}
const npcRows = manifest.actors.npcs.flatMap(n => Object.values(n.animations).flatMap(d => Object.values(d)).map(key => manifest.animations[key].frames.map(f => frame(n.atlas, f))));
save('npcs.png', grid(npcRows, [64, 64], ['grass1', 'grass2']));
const crRows = manifest.actors.creatures.flatMap(c => Object.values(c.animations).map(d => manifest.animations[d.se].frames.map(f => frame(c.atlas, f))));
save('creatures.png', grid(crRows, [64, 64], ['grass1', 'grass2']));
save('effects.png', grid(Object.values(manifest.effects).map(k => manifest.animations[k].frames.map(f => frame('effects', f))), [48, 48], ['shadow', 'outline']), 3);
const icons = Object.values(manifest.icons).map(f => frame('icons', f));
save('icons.png', grid([icons.slice(0, 19), icons.slice(19)], [16, 16], ['canvas1', 'canvas2']), 4);
for (const id of ['camp', 'woodland', 'outpost', 'mountain']) {
  execFileSync(process.execPath, [join(HERE, 'render-map.mjs'), id, join(OUT, `map-${id}.png`), '1', '--actors'], { stdio: 'inherit' });
}
execFileSync(process.execPath, [join(HERE, 'render-map.mjs'), 'camp', join(OUT, 'depth-probe-camp.png'), '1', '--depth-probe'], { stdio: 'inherit' });
