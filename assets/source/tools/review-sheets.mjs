#!/usr/bin/env node
// Writes the art-review evidence images in docs/operations/art-review/ from the shipped atlases:
// one contact sheet per gladiator loadout (every frame of every animation, 2x), NPCs, creatures,
// effects, icons, and full renders of all four maps with sample actors.
//   node assets/source/tools/review-sheets.mjs
// With --appearance it writes only the appearance checkpoint sheets (male and female bodies with each hair
// style, idle and walk, 1x and 4x, in several colour sets, plus armour alignment) to <dir>, by default
// node_modules/.cache/appearance-sheets (not committed):
//   node assets/source/tools/review-sheets.mjs --appearance [dir]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
const flag = process.argv.indexOf('--appearance');
const APPEARANCE = flag >= 0;
const OUT = APPEARANCE
  ? resolve(process.argv[flag + 1] && !process.argv[flag + 1].startsWith('--') ? process.argv[flag + 1] : join(ROOT, 'node_modules', '.cache', 'appearance-sheets'))
  : join(ROOT, 'docs', 'operations', 'art-review');
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

// ----------------------------------------------------------------- appearance checkpoint (--appearance only)
if (APPEARANCE) {
  // A female body draws body-female and cloth-female instead of body and cloth; bald draws no hair layer.
  const BODIES = { male: ['body', 'cloth'], female: ['body-female', 'cloth-female'] };
  const HAIRS = { short: ['hair'], long: ['hair-long'], ponytail: ['hair-ponytail'], bald: [] };
  // Tints of the creation options (supabase/functions/_shared/domain/appearance.ts), named skin-hair-clothes.
  const COLOURS = {
    'light-black-teal': { skin: 0xffffff, hair: 0x2a2024, cloth: 0x22a39d },
    'brown-blond-red': { skin: 0x9f6e4c, hair: 0xe6c06a, cloth: 0xbd3429 },
    'deepbrown-red-teal': { skin: 0x7a5038, hair: 0x8a3324, cloth: 0x22a39d },
  };
  const compose = (layers, tints, bodyFrame) => {
    const c = new PixelCanvas(64, 64);
    for (const l of layers) c.blit(tinted(frame(g.atlas, bodyFrame.replace(/^body\//, `${l}/`)), tints[tintKey.get(l)]), 0, 0);
    return c;
  };
  // One row per look: idle SE, idle NE, walk SE, walk NE (20 frames).
  const strip = (layers, tints) => ['idle', 'walk'].flatMap(action => Object.values(g.animations[action])
    .flatMap(key => manifest.animations[key].frames.map(f => compose(layers, tints, f))));
  const looks = Object.entries(BODIES).flatMap(([body, bodyLayers]) => Object.entries(HAIRS)
    .map(([hair, hairLayers]) => [`${body} ${hair}`, [...bodyLayers, ...hairLayers, 'accent']]));
  const both = (name, sheet) => { save(`${name}-1x.png`, sheet, 1); save(`${name}-4x.png`, sheet, 4); };
  // Rows: male short, long, ponytail, bald, then female short, long, ponytail, bald.
  for (const [name, tints] of Object.entries(COLOURS)) both(`appearance-${name}`, grid(looks.map(([, layers]) => strip(layers, tints)), [64, 64], ['sand1', 'sand2']));
  // Lineup: the first idle frame of every look (columns as the rows above) in each colour set (rows).
  const idle = manifest.animations[g.animations.idle.se].frames[0];
  both('appearance-lineup', grid(Object.values(COLOURS).map(t => looks.map(([, layers]) => compose(layers, t, idle))), [64, 64], ['sand1', 'sand2']));
  // Armour alignment: equipment is cut from the male masks and must cover the female body and clothes.
  const ARMOUR = [
    ['male heavy helmet', ['body', 'cloth', 'armor-heavy', 'accent', 'head-helmet', 'head-helmet-crest', 'weapon-sword', 'offhand-shield']],
    ['female heavy helmet', ['body-female', 'cloth-female', 'armor-heavy', 'accent', 'head-helmet', 'head-helmet-crest', 'weapon-sword', 'offhand-shield']],
    ['female heavy long', ['body-female', 'cloth-female', 'hair-long', 'armor-heavy', 'accent', 'weapon-axe', 'offhand-shield']],
    ['female light ponytail', ['body-female', 'cloth-female', 'hair-ponytail', 'armor-light', 'accent', 'weapon-spear']],
    ['female light hood', ['body-female', 'cloth-female', 'armor-light', 'accent', 'head-hood', 'weapon-bow']],
  ];
  both('appearance-armour', grid(ARMOUR.map(([, layers]) => strip(layers, COLOURS['brown-blond-red'])), [64, 64], ['sand1', 'sand2']));
  process.exit(0);
}

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

// ----------------------------------------------------------------- close-up battle view (Task 14)
// One panel per close-up backdrop, with fighters at the manifest's stand positions (left faces se,
// right is mirrored to face sw) and effects where the replay stage places them, shown at the
// in-game integer 3x scale. Fighters and effects use the same frames and tints as the runtime.
const cu = manifest.closeups;
const pose = (layers, tints, action, index) => {
  const c = new PixelCanvas(64, 64);
  const name = manifest.animations[g.animations[action].se].frames[index];
  for (const l of layers) c.blit(tinted(frame(g.atlas, name.replace(/^body\//, `${l}/`)), tints[tintKey.get(l)]), 0, 0);
  return c;
};
const creaturePose = (id, action, index) => {
  const creature = manifest.actors.creatures.find(c => c.id === id);
  return frame(creature.atlas, manifest.animations[creature.animations[action].se].frames[index]);
};
const effectFrame = (id, index) => frame('effects', manifest.animations[manifest.effects[id]].frames[index]);
const kit = name => loadouts[name][0];
const tints = name => { const [skin, cloth, hair] = loadouts[name][1]; return { skin, cloth, hair }; };
function closeupPanel(theme, left, right, effects) {
  const c = new PixelCanvas(cu.width, cu.height);
  c.blit(frame(cu.atlas, cu.backdrops[theme]), 0, 0);
  c.blit(left, cu.fighterX[0] - 32, cu.groundY - 58);
  c.blit(right, cu.fighterX[1] - 32, cu.groundY - 58, { flipX: true });
  for (const [img, x, y, flipX] of effects) c.blit(img, x - 24, y - 24, { flipX });
  return c;
}
const [L, R] = cu.fighterX;
const body = cu.groundY - 24;
const panels = [
  // Arena: a sword strike lands on the spearman, with the hit burst on the defender.
  closeupPanel('arena', pose(kit('sword-shield'), tints('sword-shield'), 'attack', 2), pose(kit('spear-heavy-helmet'), tints('spear-heavy-helmet'), 'hit', 0),
    [[effectFrame('hit', 2), R - 4, body, true]]),
  // Woodland: the gladiator evades a wolf's lunge (the evade puff sits at the feet).
  closeupPanel('woodland', pose(kit('axe-light-hood'), tints('axe-light-hood'), 'evade', 1), creaturePose('dire-wolf', 'attack', 2),
    [[effectFrame('evade', 1), L, cu.groundY - 16, false]]),
  // Outpost: a shield guard against a raider's axe, with the guard arc facing the attacker.
  closeupPanel('outpost', pose(kit('sword-shield'), tints('sword-shield'), 'defend', 1), creaturePose('raider', 'attack', 2),
    [[effectFrame('defend', 1), L + 4, body, false]]),
  // Mountain: the result, a victory raise over a defeated troll with circling stars.
  closeupPanel('mountain', pose(kit('spear-heavy-helmet'), tints('spear-heavy-helmet'), 'victory', 3), creaturePose('rock-troll', 'defeat', 3),
    [[effectFrame('victory', 2), L, cu.groundY - 28, false], [effectFrame('defeat', 1), R + 16, cu.groundY - 4, true]]),
];
const sheet = new PixelCanvas(cu.width, panels.length * (cu.height + 2) - 2);
for (let y = 0; y < sheet.height; y += 1) for (let x = 0; x < sheet.width; x += 1) sheet.set(x, y, 'outline');
panels.forEach((p, i) => sheet.blit(p, 0, i * (cu.height + 2)));
save('closeups.png', sheet, cu.scale);
