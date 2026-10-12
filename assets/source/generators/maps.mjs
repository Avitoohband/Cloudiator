// Map data for the camp and the three expeditions: autotiled ground, prop placements,
// walkability, zones with activity stations, a walkable path graph, lights and routes.
// Tile (x, y) has its north vertex at screen ((x - y) * 32, (x + y) * 16).
import { createRandom, hashSeed } from '../tools/random.mjs';
import { ARENA } from './props.mjs';
import { TILESETS, tileVariants } from './tiles.mjs';

export const CAMP = { width: 46, height: 46, arenaCentre: [23, 23] };

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function segDist(p, a, b) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return dist(p, [a[0] + dx * t, a[1] + dy * t]);
}
const screenX = (x, y) => (x - y) * 32;

/** Which tile anchors each arena wall segment (tile containing the outer-arc midpoint). */
export function arenaSegmentAnchors() {
  const [cx, cy] = CAMP.arenaCentre;
  const span = 360 / ARENA.segments;
  const inGate = d => Math.abs(((d - ARENA.gateAngle + 540) % 360) - 180) < ARENA.gateHalfWidth + 2;
  return Array.from({ length: ARENA.segments }, (_, index) => {
    const drawn = Array.from({ length: 9 }, (_, k) => index * span + (span * k) / 8).filter(d => !inGate(d));
    const midDeg = drawn.length ? drawn.reduce((a, d) => a + d, 0) / drawn.length : (index + 0.5) * span;
    const mid = (midDeg * Math.PI) / 180;
    return { index, anchorTile: [Math.floor(cx + ARENA.radius * Math.cos(mid)), Math.floor(cy + ARENA.radius * Math.sin(mid))] };
  });
}

function inArenaGate(x, y) {
  const [cx, cy] = CAMP.arenaCentre;
  const deg = (Math.atan2(y + 0.5 - cy, x + 0.5 - cx) * 180) / Math.PI;
  return Math.abs(((deg - ARENA.gateAngle + 540) % 360) - 180) < ARENA.gateHalfWidth;
}

class MapBuilder {
  constructor(id, width, height, tileset, propAtlas, propMeta) {
    Object.assign(this, { id, width, height, tileset, propAtlas, propMeta });
    this.vertices = Array.from({ length: height + 1 }, () => new Array(width + 1).fill(0));
    this.blocked = Array.from({ length: height }, () => new Array(width).fill(false));
    this.props = [];
    this.lights = [];
    this.zones = [];
    this.occupied = Array.from({ length: height }, () => new Array(width).fill(false));
  }
  inside(x, y) { return x >= 0 && y >= 0 && x < this.width && y < this.height; }
  paintVertices(test, value = 1) {
    for (let y = 0; y <= this.height; y += 1) for (let x = 0; x <= this.width; x += 1) if (test(x, y)) this.vertices[y][x] = value;
  }
  block(x, y) { if (this.inside(x, y)) this.blocked[y][x] = true; }
  free(x, y) { return this.inside(x, y) && !this.blocked[y][x] && !this.occupied[y][x]; }
  /** Place a prop by frame name with its anchor tile; footprint tiles become blocked unless walkable. */
  place(frame, x, y, extra = {}) {
    const meta = this.propMeta[frame];
    if (!meta) throw new Error(`${this.id}: unknown prop frame ${frame}`);
    const { w, d } = meta.footprint;
    for (let yy = y; yy < y + d; yy += 1) for (let xx = x; xx < x + w; xx += 1) {
      if (!this.inside(xx, yy)) throw new Error(`${this.id}: ${frame} at ${x},${y} leaves the map`);
      this.occupied[yy][xx] = true;
      if (!meta.walkable && !extra.passable) this.blocked[yy][xx] = true;
    }
    const placement = { id: `${frame.replace(/\//g, '-')}@${x},${y}`, frame, x, y, w, d, sortY: meta.sortY, layer: meta.layer, occludes: meta.occludes, walkable: !!(meta.walkable || extra.passable) };
    if (extra.animation) placement.animation = extra.animation;
    if (extra.interact) placement.interact = extra.interact;
    this.props.push(placement);
    if (meta.light) this.lights.push({ x: x + 0.5, y: y + 0.5, radius: meta.light.radius, color: meta.light.color, kind: frame.split('/')[0] });
    return placement;
  }
  tryPlace(frame, x, y, { allowBlocked = false } = {}) {
    const { w, d } = this.propMeta[frame].footprint;
    for (let yy = y; yy < y + d; yy += 1) for (let xx = x; xx < x + w; xx += 1) {
      if (!this.inside(xx, yy) || this.occupied[yy][xx] || (!allowBlocked && this.blocked[yy][xx])) return false;
    }
    this.place(frame, x, y);
    return true;
  }
  zone(id, label, bounds, stations) {
    this.zones.push({ id, label, bounds, stations });
  }
  build(extra = {}) {
    const ground = [];
    const groundFrames = [];
    const index = new Map();
    const rand = createRandom(hashSeed(`${this.id}/ground`));
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const v = this.vertices;
        const mask = v[y][x] * 1 + v[y][x + 1] * 2 + v[y + 1][x + 1] * 4 + v[y + 1][x] * 8;
        const frame = `${this.tileset}/${mask}/${rand.int(0, tileVariants(mask) - 1)}`;
        if (!index.has(frame)) { index.set(frame, groundFrames.length); groundFrames.push(frame); }
        ground.push(index.get(frame));
      }
    }
    const walkable = this.blocked.map(row => row.map(b => (b ? '0' : '1')).join(''));
    const zones = this.zones.map(z => {
      let count = 0;
      for (let y = z.bounds.y; y < z.bounds.y + z.bounds.h; y += 1) for (let x = z.bounds.x; x < z.bounds.x + z.bounds.w; x += 1) if (this.inside(x, y) && !this.blocked[y][x]) count += 1;
      return { ...z, walkableTiles: count };
    });
    return {
      id: this.id, width: this.width, height: this.height, tileWidth: 64, tileHeight: 32,
      tilesAtlas: this.tileset, propsAtlas: this.propAtlas,
      projection: 'tile (x, y) north vertex at screen ((x - y) * 32, (x + y) * 16)',
      vertices: this.vertices.map(row => row.join('')),
      groundFrames, ground, walkable,
      props: this.props.sort((a, b) => (a.y + a.x) - (b.y + b.x) || a.x - b.x),
      zones, lights: this.lights, ...extra,
    };
  }
}

/** Facing that looks toward a target tile, using the drawn front directions. */
function faceToward(from, to) {
  return screenX(to[0], to[1]) >= screenX(from[0], from[1]) ? 'se' : 'sw';
}

export function buildCamp(propMeta) {
  const { width: W, height: H } = CAMP;
  const [cx, cy] = CAMP.arenaCentre;
  const b = new MapBuilder('camp', W, H, 'camp', 'camp-props', propMeta);
  const rand = createRandom(hashSeed('camp/layout'));

  // --- ground: sand plaza, zone floors and lanes over grass
  const zoneCentres = { training: [9.5, 19.5], merchants: [22, 9.5], rest: [21, 35.5], gate: [37, 23], exit: [45.5, 22.5] };
  const lanes = [
    [[cx - 8, cy], zoneCentres.training], [[cx, cy - 8], zoneCentres.merchants], [[cx, cy + 8], [21, 33]],
    [[cx + 8, cy], zoneCentres.gate], [zoneCentres.gate, zoneCentres.exit], [[21, 33], [21, 38]],
  ];
  b.paintVertices((x, y) => dist([x, y], [cx, cy]) < 9.7);
  b.paintVertices((x, y) => x >= 4 && x <= 14 && y >= 13 && y <= 25);
  b.paintVertices((x, y) => x >= 16 && x <= 28 && y >= 4 && y <= 12);
  b.paintVertices((x, y) => x >= 32 && x <= 46 && y >= 19 && y <= 26);
  b.paintVertices((x, y) => lanes.some(([p, q]) => segDist([x, y], p, q) < 1.6));

  // --- forest border and palisade
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const outside = x < 3 || y < 3 || x > 42 || y > 42;
    const exit = x > 42 && y >= 21 && y <= 23;
    if (outside && !exit) b.block(x, y);
  }
  for (let t = 3; t <= 42; t += 1) {
    b.place('palisade-x', t, 3);
    b.place('palisade-x', t, 42);
    if (t > 3 && t < 42) b.place('palisade-y', 3, t);
    if (t > 3 && t < 42 && (t < 20 || t > 24)) b.place('palisade-y', 42, t);
  }
  b.place('gate-pillar', 42, 20);
  b.place('gate-pillar', 42, 24);
  b.place('gate-arch', 42, 21);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const outside = x < 3 || y < 3 || x > 42 || y > 42;
    if (!outside || (x > 42 && y >= 20 && y <= 24)) continue;
    const roll = rand.next();
    if (roll < 0.5) b.tryPlace(rand.pick(['tree-oak/0', 'tree-oak/1', 'tree-pine/0']), x, y, { allowBlocked: true });
    else if (roll < 0.62) b.tryPlace(rand.pick(['bush/0', 'bush/1', 'rock-small', 'rock-large']), x, y, { allowBlocked: true });
  }

  // --- arena ring
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const r = dist([x + 0.5, y + 0.5], [cx, cy]);
    if (Math.abs(r - ARENA.radius) < 0.8 && !inArenaGate(x, y)) b.block(x, y);
  }
  for (const { index, anchorTile } of arenaSegmentAnchors()) {
    const meta = propMeta[`arena-wall/${index}`];
    b.props.push({ id: `arena-wall-${index}`, frame: `arena-wall/${index}`, x: anchorTile[0], y: anchorTile[1], w: 1, d: 1, sortY: meta.sortY, layer: 'object', occludes: true, walkable: false });
  }
  for (const [deg, frame] of [[ARENA.gateAngle - ARENA.gateHalfWidth - 2, 'arena-gate-post-right'], [ARENA.gateAngle + ARENA.gateHalfWidth + 2, 'arena-gate-post-left']]) {
    const a = (deg * Math.PI) / 180;
    b.place(frame, Math.floor(cx + ARENA.radius * Math.cos(a)), Math.floor(cy + ARENA.radius * Math.sin(a)));
  }
  // torches stand outside the plaza walkway ring, on the diagonals between lanes
  for (const deg of [45, 135, 225, 315]) {
    const a = (deg * Math.PI) / 180;
    b.place('torch/0', Math.floor(cx + 10.3 * Math.cos(a)), Math.floor(cy + 10.3 * Math.sin(a)), { animation: 'torch' });
  }

  const arenaRings = [];
  const ringPairs = [[-3, -1], [0, -3], [2, 0], [-1, 2], [-3, 2], [2, -3]];
  ringPairs.forEach(([dx, dy], i) => {
    const a = [cx + dx - 1, cy + dy];
    const z = [cx + dx, cy + dy - 1];
    arenaRings.push({ id: `arena-ring-${i}-a`, kind: 'arena-ring', x: a[0], y: a[1], facing: 'se', partner: `arena-ring-${i}-b` });
    arenaRings.push({ id: `arena-ring-${i}-b`, kind: 'arena-ring', x: z[0], y: z[1], facing: 'sw', partner: `arena-ring-${i}-a` });
  });
  const staging = [];
  for (let k = 0; k < 24; k += 1) {
    const a = ((k / 24) * 360 * Math.PI) / 180;
    const x = Math.floor(cx + 4.6 * Math.cos(a));
    const y = Math.floor(cy + 4.6 * Math.sin(a));
    if (staging.some(s => s.x === x && s.y === y) || arenaRings.some(s => s.x === x && s.y === y)) continue;
    staging.push({ id: `arena-staging-${staging.length}`, kind: 'arena-staging', x, y, facing: faceToward([x, y], [cx, cy]) });
  }
  b.zone('arena', 'Arena', { x: cx - 6, y: cy - 6, w: 12, h: 12 }, [...arenaRings, ...staging]);

  // --- training grounds
  const training = [];
  [[5, 14], [7, 14], [9, 14], [5, 16], [7, 16], [9, 16]].forEach(([x, y], i) => training.push({ id: `weights-${i}`, kind: 'weights', x, y, facing: 'se' }));
  b.place('weight-rack', 11, 14);
  [[5, 20], [8, 20], [11, 20], [5, 23]].forEach(([x, y], i) => {
    b.place('dummy', x + 1, y - 1);
    training.push({ id: `practice-${i}`, kind: 'practice', x, y, facing: 'se' });
  });
  [[8, 24], [11, 24], [11, 17]].forEach(([x, y], i) => {
    training.push({ id: `spar-${i}-a`, kind: 'spar', x, y, facing: 'se', partner: `spar-${i}-b` });
    training.push({ id: `spar-${i}-b`, kind: 'spar', x: x + 1, y: y - 1, facing: 'sw', partner: `spar-${i}-a` });
  });
  b.place('weapon-rack', 4, 13);
  b.place('weapon-rack', 13, 13);
  b.place('torch/0', 4, 25, { animation: 'torch' });
  b.place('torch/0', 14, 18, { animation: 'torch' });
  b.place('banner-teal', 14, 13);
  b.zone('training', 'Training grounds', { x: 4, y: 13, w: 11, h: 13 }, training);

  // --- resting quarters
  const rest = [];
  b.place('tent-large', 15, 31);
  b.place('tent-small', 19, 31);
  [[15, 35], [17, 35], [19, 35], [15, 37], [17, 37], [19, 37], [15, 39], [17, 39]].forEach(([x, y], i) => {
    b.place(i % 2 ? 'bedroll-crimson' : 'bedroll-teal', x, y);
    rest.push({ id: `sleep-${i}`, kind: 'sleep', x, y, facing: 'se' });
  });
  const fire = [25, 35];
  b.place('campfire/0', fire[0], fire[1], { animation: 'campfire' });
  [[24, 34], [26, 34], [24, 36], [26, 36], [25, 33], [25, 37], [23, 35], [27, 35]].forEach(([x, y], i) => {
    b.place(i % 3 === 0 ? 'bench' : 'log-seat', x, y);
    rest.push({ id: `sit-${i}`, kind: 'sit', x, y, facing: faceToward([x, y], fire) });
  });
  b.place('table', 21, 39);
  b.place('table', 24, 39);
  [[21, 40], [22, 40], [24, 40], [25, 40], [20, 39], [26, 39]].forEach(([x, y], i) => {
    b.place('bench', x, y);
    rest.push({ id: `eat-${i}`, kind: 'eat', x, y, facing: faceToward([x, y], [x < 23 ? 21.5 : 24.5, 39]) });
  });
  b.place('well', 27, 31);
  b.place('barrel', 26, 41);
  b.place('crate', 27, 41);
  b.place('torch/0', 14, 34, { animation: 'torch' });
  b.zone('rest', 'Resting quarters', { x: 14, y: 30, w: 14, h: 12 }, rest);

  // --- merchant stalls
  b.place('stall-weapons', 17, 5);
  b.place('stall-armor', 23, 5);
  const merchants = [
    { id: 'merchant-weapons', kind: 'merchant-weapons', x: 18, y: 7, facing: 'sw', npc: 'smith' },
    { id: 'merchant-armor', kind: 'merchant-armor', x: 24, y: 7, facing: 'sw', npc: 'armorer' },
  ];
  [[18, 9], [19, 9], [24, 9], [25, 9], [21, 10]].forEach(([x, y], i) => merchants.push({ id: `customer-${i}`, kind: 'browse', x, y, facing: 'se' }));
  for (const [f, x, y] of [['crate', 16, 5], ['barrel', 21, 5], ['sacks', 22, 5], ['crate', 27, 5], ['barrel', 27, 6], ['banner-crimson', 20, 4], ['torch/0', 16, 10], ['torch/0', 28, 10]]) {
    b.place(f, x, y, f.startsWith('torch') ? { animation: 'torch' } : {});
  }
  b.zone('merchants', 'Merchant stalls', { x: 16, y: 4, w: 13, h: 9 }, merchants);

  // --- expedition gate
  b.place('watchtower', 38, 16);
  const gate = [
    { id: 'gate', kind: 'gate', x: 41, y: 22, facing: 'se' },
    { id: 'gate-guard', kind: 'guard', x: 40, y: 20, facing: 'sw', npc: 'guard' },
    { id: 'departure-0', kind: 'depart', x: 39, y: 22, facing: 'se' },
    { id: 'departure-1', kind: 'depart', x: 39, y: 23, facing: 'se' },
  ];
  b.place('torch/0', 40, 19, { animation: 'torch' });
  b.place('torch/0', 40, 25, { animation: 'torch' });
  b.place('crate', 35, 26);
  b.place('barrel', 36, 27);
  b.zone('expedition-gate', 'Expedition gate', { x: 32, y: 17, w: 11, h: 11 }, gate);

  // --- groves and decoration on open grass, kept clear of sand, zones and stations
  const nearSand = (x, y, r) => {
    for (let yy = Math.max(0, y - r); yy <= Math.min(H, y + 1 + r); yy += 1) for (let xx = Math.max(0, x - r); xx <= Math.min(W, x + 1 + r); xx += 1) if (b.vertices[yy][xx]) return true;
    return false;
  };
  const inZone = (x, y) => b.zones.some(({ bounds: z }) => x >= z.x - 1 && y >= z.y - 1 && x <= z.x + z.w && y <= z.y + z.h);
  for (let y = 4; y < 42; y += 1) for (let x = 4; x < 42; x += 1) {
    if (inZone(x, y) || dist([x, y], [cx, cy]) < 11.5) continue;
    const roll = rand.next();
    if (!nearSand(x, y, 2) && roll < 0.1) b.tryPlace(rand.pick(['tree-oak/0', 'tree-oak/1', 'tree-pine/0', 'tree-oak/0']), x, y);
    else if (!nearSand(x, y, 0) && roll < 0.17) b.tryPlace(rand.pick(['flowers', 'bush/0', 'flowers', 'rock-small', 'bush/1']), x, y);
  }

  // --- path graph over walkable tiles
  const plaza = Array.from({ length: 8 }, (_, k) => {
    const a = (k * 45 * Math.PI) / 180;
    return { id: `plaza-${k * 45}`, x: Math.floor(cx + 8.8 * Math.cos(a)), y: Math.floor(cy + 8.8 * Math.sin(a)) };
  });
  const nodes = [
    ...plaza,
    { id: 'arena-gate', x: 27, y: 27 }, { id: 'arena-centre', x: cx, y: cy },
    { id: 'training', x: 10, y: 21 }, { id: 'merchants', x: 21, y: 10 }, { id: 'rest', x: 21, y: 34 },
    { id: 'gate', x: 38, y: 22 }, { id: 'exit', x: 45, y: 22 },
  ];
  const edges = [];
  for (let k = 0; k < 8; k += 1) edges.push([plaza[k].id, plaza[(k + 1) % 8].id]);
  edges.push(['plaza-45', 'arena-gate'], ['arena-gate', 'arena-centre'], ['plaza-180', 'training'], ['plaza-270', 'merchants'], ['plaza-90', 'rest'], ['plaza-0', 'gate'], ['gate', 'exit']);
  return b.build({ spawn: { x: 38, y: 22 }, arena: { centre: CAMP.arenaCentre, radius: ARENA.radius }, paths: { nodes, edges } });
}

const ROUTES = {
  woodland: [[3, 11], [8, 7], [14, 12], [20, 9], [26, 14], [32, 9], [38, 12], [42, 10]],
  outpost: [[3, 10], [9, 13], [15, 8], [21, 12], [27, 7], [33, 12], [39, 9], [42, 11]],
  mountain: [[3, 12], [9, 8], [14, 13], [21, 9], [27, 13], [33, 8], [38, 12], [42, 9]],
};

const SCATTER = {
  woodland: { dense: ['tree-oak/0', 'tree-oak/1', 'tree-oak/2', 'tree-pine/0', 'tree-pine/1'], light: ['bush/0', 'bush/1', 'log', 'mushrooms', 'rock-small', 'rock-large', 'flowers'], density: 0.34 },
  outpost: { dense: ['ruin-wall-x/0', 'ruin-wall-x/1', 'ruin-wall-y/0', 'ruin-wall-y/1', 'pillar/0', 'pillar/1', 'dead-tree'], light: ['rubble/0', 'rubble/1', 'crate', 'barrel', 'rock-small', 'bush/0', 'torn-banner'], density: 0.22 },
  mountain: { dense: ['pine-snow/0', 'pine-snow/1', 'spire/0', 'spire/1', 'boulder/0', 'dead-tree'], light: ['boulder/1', 'rock-small', 'crystal', 'bones'], density: 0.26 },
};

export function buildExpedition(id, propMeta) {
  const W = 46;
  const H = 22;
  const b = new MapBuilder(id, W, H, id, id, propMeta);
  const rand = createRandom(hashSeed(`${id}/layout`));
  const route = ROUTES[id];
  const nearRoute = (x, y, r) => route.slice(1).some((q, i) => segDist([x, y], route[i], q) < r);
  // ground: route uses the top material except on the mountain, where the path is bare rock in snow
  if (id === 'mountain') b.paintVertices((x, y) => !nearRoute(x, y, 1.7) && ((x * 7 + y * 13) % 11 !== 0));
  else b.paintVertices((x, y) => nearRoute(x, y, 1.6));
  if (id === 'outpost') b.paintVertices((x, y) => dist([x, y], [24, 10]) < 4 || dist([x, y], [36, 10]) < 3.2);

  // encounters at 1/4, 2/4, 3/4 of the route length
  const segLens = route.slice(1).map((q, i) => dist(route[i], q));
  const total = segLens.reduce((s, l) => s + l, 0);
  const pointAt = f => {
    let left = f * total;
    for (let i = 0; i < segLens.length; i += 1) {
      if (left <= segLens[i]) { const t = left / segLens[i]; return [route[i][0] + (route[i + 1][0] - route[i][0]) * t, route[i][1] + (route[i + 1][1] - route[i][1]) * t]; }
      left -= segLens[i];
    }
    return route[route.length - 1];
  };
  const encounters = [1, 2, 3].map(index => {
    const [px, py] = pointAt(index / 4).map(Math.floor);
    return { index, x: px, y: py, enemyX: px + 1, enemyY: py - 1, facing: 'se', enemyFacing: 'sw' };
  });
  const safePoint = (() => {
    const offsets = [];
    for (let r = 3; r <= 6; r += 1) for (const [dx, dy] of [[0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0]]) offsets.push([dx * r, dy * r]);
    for (const [dx, dy] of offsets) {
      const sx = route[0][0] + dx;
      const sy = route[0][1] + dy;
      const tiles = [[sx, sy], [sx + 1, sy + 1], [sx - 2, sy - 1], [sx - 1, sy - 1], [sx - 2, sy], [sx - 1, sy]];
      if (tiles.every(([x, y]) => x >= 1 && y >= 1 && x < W - 1 && y < H - 1 && !nearRoute(x, y, 1.9)) && !nearRoute(sx, sy, 2.2)) return { x: sx, y: sy };
    }
    throw new Error(`${id}: no safe point near the route start`);
  })();
  const searchSpots = [0.12, 0.37, 0.62, 0.88].map((f, i) => {
    const [px, py] = pointAt(f);
    return { x: Math.floor(px) + (i % 2 ? 1 : -1), y: Math.floor(py) + (i % 2 ? -1 : 1) };
  });
  const keepClear = (x, y) => nearRoute(x, y, 2.4)
    || encounters.some(e => dist([x, y], [e.x, e.y]) < 3)
    || dist([x, y], [safePoint.x - 0.5, safePoint.y]) < 3.2
    || searchSpots.some(s => dist([x, y], [s.x, s.y]) < 1.5);
  b.place('tent-small', safePoint.x - 2, safePoint.y - 1);
  b.place('campfire/0', safePoint.x + 1, safePoint.y + 1, { animation: 'campfire' });
  const { dense, light, density } = SCATTER[id];
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    if (keepClear(x, y)) continue;
    const edge = y < 2 || y > H - 3 || x < 1 || x > W - 2;
    const roll = rand.next();
    if (roll < density + (edge ? 0.35 : 0)) b.tryPlace(rand.pick(dense), x, y);
    else if (roll < density + 0.16) b.tryPlace(rand.pick(light), x, y);
  }
  const nodes = route.map(([x, y], i) => ({ id: `route-${i}`, x, y }));
  const edges = route.slice(1).map((_, i) => [`route-${i}`, `route-${i + 1}`]);
  return b.build({
    spawn: { x: route[0][0], y: route[0][1] },
    paths: { nodes, edges },
    expedition: {
      start: { x: route[0][0], y: route[0][1] },
      end: { x: route[route.length - 1][0], y: route[route.length - 1][1] },
      route: route.map(([x, y]) => ({ x, y })),
      encounters, searchSpots, safePoint,
    },
  });
}

export const MAP_IDS = ['camp', 'woodland', 'outpost', 'mountain'];
export { TILESETS };
