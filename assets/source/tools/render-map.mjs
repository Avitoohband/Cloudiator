#!/usr/bin/env node
// Offline map renderer for art review: composes ground, props and sample actors exactly as the
// manifest describes (projection, anchors, sortY), writing a PNG.
//   node assets/source/tools/render-map.mjs <mapId> <out.png> [scale] [--actors]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PixelCanvas } from './canvas.mjs';
import { decodePng, encodePng } from './png.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ASSETS = join(ROOT, 'public', 'assets');
const [mapId = 'camp', out = 'map.png', scaleArg = '1'] = process.argv.slice(2);
const withActors = process.argv.includes('--actors');
const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'));
const entry = manifest.maps.find(m => m.id === mapId);
const map = JSON.parse(readFileSync(join(ASSETS, entry.data), 'utf8'));

const sheets = {};
function atlas(key) {
  if (!sheets[key]) {
    const def = manifest.atlases[key];
    const img = decodePng(readFileSync(join(ASSETS, def.image)));
    const canvas = new PixelCanvas(img.width, img.height);
    canvas.data.set(img.rgba);
    sheets[key] = { canvas, frames: JSON.parse(readFileSync(join(ASSETS, def.data), 'utf8')).frames };
  }
  return sheets[key];
}
const toScreen = (x, y) => [(x - y) * 32, (x + y) * 16];
const originX = map.height * 32 + 32;
const originY = 120;
const scene = new PixelCanvas((map.width + map.height) * 32 + 64, (map.width + map.height) * 16 + 200);
for (let y = 0; y < scene.height; y += 1) for (let x = 0; x < scene.width; x += 1) scene.set(x, y, 'leaf3');

function draw(key, frameName, sx, sy, flipX = false) {
  const a = atlas(key);
  const f = a.frames[frameName];
  if (!f) throw new Error(`missing ${key}:${frameName}`);
  const img = a.canvas.crop(f.frame.x, f.frame.y, f.frame.w, f.frame.h);
  const ax = flipX ? f.frame.w - 1 - f.anchor.x : f.anchor.x;
  scene.blit(img, Math.round(originX + sx - ax), Math.round(originY + sy - f.anchor.y), { flipX });
}

for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
  const [sx, sy] = toScreen(x, y);
  draw(map.tilesAtlas, map.groundFrames[map.ground[y * map.width + x]], sx, sy);
}
const items = [];
for (const p of map.props) {
  const [sx, sy] = toScreen(p.x, p.y);
  const depth = p.layer === 'floor' ? -1e6 + sy : p.layer === 'foreground' ? 1e6 + sy : sy + p.sortY;
  items.push({ depth, draw: () => draw(map.propsAtlas, p.frame, sx, sy) });
}
if (withActors) {
  const g = manifest.actors.gladiator;
  const loadouts = [
    ['body', 'cloth', 'hair', 'weapon-sword', 'offhand-shield'], ['body', 'cloth', 'armor-heavy', 'head-helmet', 'weapon-spear'],
    ['body', 'cloth', 'hair', 'armor-light', 'weapon-axe', 'offhand-shield'], ['body', 'cloth', 'armor-light', 'head-hood', 'weapon-bow'],
  ];
  const kindAction = { weights: 'weights', practice: 'practice', spar: 'spar', sit: 'sit', eat: 'eat', sleep: 'sleep', 'arena-ring': 'spar', 'arena-staging': 'idle', browse: 'idle', depart: 'idle', gate: 'idle' };
  let n = 0;
  for (const zone of map.zones) for (const s of zone.stations) {
    if (s.npc) {
      const npc = manifest.actors.npcs.find(x => x.id === s.npc);
      const [sx, sy] = toScreen(s.x + 0.5, s.y + 0.5);
      const anim = manifest.animations[npc.animations[s.kind.startsWith('merchant') ? 'tend' : 'idle'].se];
      items.push({ depth: sy, draw: () => draw(npc.atlas, anim.frames[0], sx, sy, s.facing === 'sw') });
      continue;
    }
    const action = kindAction[s.kind];
    if (!action || n % 2 === 1 && s.kind === 'arena-staging') { n += 1; continue; }
    const lo = loadouts[n % loadouts.length];
    const anim = manifest.animations[g.animations[action].se];
    const frame = anim.frames[n % anim.frames.length].replace(/^body\//, '');
    const [sx, sy] = toScreen(s.x + 0.5, s.y + 0.5);
    const flip = s.facing === 'sw';
    items.push({ depth: sy, draw: () => { for (const layer of lo) draw(g.atlas, `${layer}/${frame}`, sx, sy, flip); } });
    n += 1;
  }
  if (map.expedition) {
    const creature = manifest.actors.creatures.find(c => c.expedition === mapId);
    for (const e of map.expedition.encounters) {
      const [px, py] = toScreen(e.x + 0.5, e.y + 0.5);
      const [ex, ey] = toScreen(e.enemyX + 0.5, e.enemyY + 0.5);
      const ga = manifest.animations[g.animations.attack.se].frames[2].replace(/^body\//, '');
      items.push({ depth: py, draw: () => { for (const layer of loadouts[e.index % 4]) draw(g.atlas, `${layer}/${ga}`, px, py); } });
      items.push({ depth: ey, draw: () => draw('creatures', manifest.animations[creature.animations.idle.se].frames[0], ex, ey, true) });
    }
  }
}
items.sort((a, b) => a.depth - b.depth);
for (const item of items) item.draw();
const S = Number(scaleArg);
const outCanvas = S === 1 ? scene : (() => {
  const big = new PixelCanvas(scene.width * S, scene.height * S);
  for (let y = 0; y < scene.height; y += 1) for (let x = 0; x < scene.width; x += 1) {
    const k = (y * scene.width + x) * 4;
    for (let dy = 0; dy < S; dy += 1) for (let dx = 0; dx < S; dx += 1) big.data.set(scene.data.subarray(k, k + 4), ((y * S + dy) * big.width + x * S + dx) * 4);
  }
  return big;
})();
writeFileSync(out, encodePng(outCanvas.width, outCanvas.height, outCanvas.data));
console.log(`${out} ${outCanvas.width}x${outCanvas.height}`);
