#!/usr/bin/env node
// Offline map renderer for art review: composes ground, props and sample actors exactly as the
// manifest describes (projection, anchors, sortY), writing a PNG.
//   node assets/source/tools/render-map.mjs <mapId> <out.png> [scale] [--actors]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PixelCanvas } from './canvas.mjs';
import { decodePng, encodePng } from './png.mjs';
import { drawSlices } from './depth.mjs';

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

/** Multiply tint, as the runtime does with Phaser setTint. */
export function tintCanvas(img, tint) {
  if (tint == null || tint === 0xffffff) return img;
  const out = new PixelCanvas(img.width, img.height);
  out.data.set(img.data);
  const [tr, tg, tb] = [(tint >> 16) & 255, (tint >> 8) & 255, tint & 255];
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = Math.round((out.data[i] * tr) / 255);
    out.data[i + 1] = Math.round((out.data[i + 1] * tg) / 255);
    out.data[i + 2] = Math.round((out.data[i + 2] * tb) / 255);
  }
  return out;
}

function draw(key, frameName, sx, sy, flipX = false, tint = null, slice = null) {
  const a = atlas(key);
  const f = a.frames[frameName];
  if (!f) throw new Error(`missing ${key}:${frameName}`);
  let img = tintCanvas(a.canvas.crop(f.frame.x, f.frame.y, f.frame.w, f.frame.h), tint);
  let left = 0;
  if (slice) { left = slice.left + f.anchorPx.x; img = img.crop(left, 0, slice.width, f.frame.h); }
  const ax = flipX ? f.frame.w - 1 - f.anchorPx.x : f.anchorPx.x - left;
  scene.blit(img, Math.round(originX + sx - ax), Math.round(originY + sy - f.anchorPx.y), { flipX });
}

for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
  const [sx, sy] = toScreen(x, y);
  draw(map.tilesAtlas, map.groundFrames[map.ground[y * map.width + x]], sx, sy);
}
const items = [];
for (const p of map.props) {
  const [sx, sy] = toScreen(p.x, p.y);
  const f = atlas(map.propsAtlas).frames[p.frame];
  const slices = drawSlices(p, { w: f.frame.w, anchorX: f.anchorPx.x });
  for (const slice of slices) {
    const whole = slices.length === 1 && slice.width === f.frame.w;
    items.push({ depth: sy + slice.depthOffset, draw: () => draw(map.propsAtlas, p.frame, sx, sy, false, null, whole ? null : slice) });
  }
}
if (withActors) {
  const g = manifest.actors.gladiator;
  const loadouts = [
    ['body', 'cloth', 'hair', 'accent', 'weapon-sword', 'offhand-shield', 'held'], ['body', 'cloth', 'armor-heavy', 'accent', 'head-helmet', 'head-helmet-crest', 'weapon-spear', 'held'],
    ['body', 'cloth', 'hair', 'armor-light', 'accent', 'weapon-axe', 'offhand-shield', 'held'], ['body', 'cloth', 'armor-light', 'accent', 'head-hood', 'weapon-bow', 'held'],
  ];
  const CLOTH = [0x22a39d, 0xbd3429, 0xf2b43d, 0x6a4fb8, 0x3c7fd0, 0x4e8d3b, 0xe0702a, 0xd9608c];
  const SKIN = [0xffffff, 0xeac3a0, 0xcf9a74, 0x9f6e4c, 0x7a5038];
  const HAIR = [0x5a3418, 0x2a2024, 0xb8742f, 0xe6c06a];
  const tintKey = new Map(g.layers.map(l => [l.id, l.tint]));
  const tintsFor = n => ({ skin: SKIN[n % SKIN.length], cloth: CLOTH[(n * 3) % CLOTH.length], hair: HAIR[(n * 7) % HAIR.length] });
  const drawGladiator = (layers, frame, sx, sy, flip, n) => { const t = tintsFor(n); for (const layer of layers) draw(g.atlas, `${layer}/${frame}`, sx, sy, flip, tintKey.get(layer) ? t[tintKey.get(layer)] : null); };
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
    const tintIndex = n;
    items.push({ depth: sy, draw: () => drawGladiator(lo, frame, sx, sy, flip, tintIndex) });
    n += 1;
  }
  if (map.expedition) {
    const creature = manifest.actors.creatures.find(c => c.expedition === mapId);
    for (const e of map.expedition.encounters) {
      const [px, py] = toScreen(e.x + 0.5, e.y + 0.5);
      const [ex, ey] = toScreen(e.enemyX + 0.5, e.enemyY + 0.5);
      const ga = manifest.animations[g.animations.attack.se].frames[2].replace(/^body\//, '');
      const foe = manifest.actors.creatures.find(c => c.id === e.creature) ?? creature;
      items.push({ depth: py, draw: () => drawGladiator(loadouts[e.index % 4], ga, px, py, false, e.index) });
      items.push({ depth: ey, draw: () => draw('creatures', manifest.animations[foe.animations.idle.se].frames[0], ex, ey, true) });
    }
  }
}
if (process.argv.includes('--depth-probe')) {
  const g = manifest.actors.gladiator;
  const walk = (x, y) => map.walkable[y]?.[x] === '1';
  const probed = new Set();
  let n = 0;
  for (const p of map.props) {
    if (!(p.layer === 'object' && (p.w + p.d > 2 || p.slices))) continue;
    const front = [];
    for (let x = p.x; x < p.x + p.w; x += 1) front.push([x, p.y + p.d], [x, p.y - 1]);
    for (let y = p.y; y < p.y + p.d; y += 1) front.push([p.x + p.w, y], [p.x - 1, y]);
    if (p.slices && map.arena) {
      // Arena wall: probe every walkable tile just inside and just outside the ring.
      if (n > 0 && front.length === 0) continue;
      front.length = 0;
      const [cx, cy] = map.arena.centre;
      for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
        const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (Math.abs(r - map.arena.radius) > 0.8 && Math.abs(r - map.arena.radius) < 1.9 && !probed.has(`${x},${y}`)) front.push([x, y]);
      }
    }
    for (const [x, y] of front) {
      if (!walk(x, y) || probed.has(`${x},${y}`)) continue;
      probed.add(`${x},${y}`);
      const [sx, sy] = toScreen(x + 0.5, y + 0.5);
      const frame = manifest.animations[g.animations.idle.se].frames[0].replace(/^body\//, '');
      const k = n++;
      items.push({ depth: sy, draw: () => { for (const layer of ['body', 'cloth', 'hair', 'accent', 'weapon-sword']) draw(g.atlas, `${layer}/${frame}`, sx, sy, false, layer === 'cloth' || layer === 'accent' ? [0xbd3429, 0x22a39d, 0xf2b43d][k % 3] : null); } });
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
