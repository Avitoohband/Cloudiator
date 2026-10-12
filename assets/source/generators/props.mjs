// Isometric props for the camp and the three expeditions.
// Every prop is anchored at the NORTH vertex of its footprint's first tile; sortY is the
// depth offset (pixels below the anchor) the renderer uses for painter ordering.
import { Mask, PixelCanvas } from '../tools/canvas.mjs';
import { createRandom, hashSeed } from '../tools/random.mjs';

const shade = PixelCanvas.shade;
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const up = (p, h) => [p[0], p[1] - h];
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Canvas with room for a W x D footprint and `height` pixels above the ground. */
function proto(W, D, height, extraX = 0) {
  const pad = 4 + extraX;
  const c = new PixelCanvas((W + D) * 32 + pad * 2, (W + D) * 16 + height + pad * 2);
  const N = [D * 32 + pad, height + pad];
  const E = add(N, [32 * W, 16 * W]);
  const S = add(N, [32 * (W - D), 16 * (W + D)]);
  const Wv = add(N, [-32 * D, 16 * D]);
  const m = () => new Mask(c.width, c.height);
  /** iso ground point from tile-local (u along x, v along y) */
  const g = (u, v) => add(N, [32 * (u - v), 16 * (u + v)]);
  return { c, N, E, S, Wv, m, g, W, D };
}

/** Crop to content (1px clear margin) and return the prop frame record. */
function finish(P, opts = {}) {
  const { c, N, W, D } = P;
  let minX = c.width; let minY = c.height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < c.height; y += 1) for (let x = 0; x < c.width; x += 1) if (c.opaque(x, y)) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const x0 = Math.min(minX - 1, Math.round(N[0]) - 1);
  const y0 = Math.min(minY - 1, Math.round(N[1]) - 1);
  const x1 = Math.max(maxX + 1, Math.round(N[0]) + 1);
  const y1 = Math.max(maxY + 1, Math.round(N[1]) + 1);
  const canvas = c.crop(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  return {
    canvas,
    anchorX: Math.round(N[0]) - x0,
    anchorY: Math.round(N[1]) - y0,
    footprint: { w: W, d: D },
    sortY: opts.sortY ?? (W + D) * 16,
    occludes: opts.occludes ?? false,
    walkable: opts.walkable ?? false,
    layer: opts.layer ?? 'object',
    ...(opts.light ? { light: opts.light } : {}),
  };
}

function box(P, base, W, D, h, faces) {
  const { c, m } = P;
  const N = base;
  const E = add(N, [32 * W, 16 * W]);
  const S = add(N, [32 * (W - D), 16 * (W + D)]);
  const Wv = add(N, [-32 * D, 16 * D]);
  if (faces.left) c.stamp(m().polygon([Wv, S, up(S, h), up(Wv, h)]), faces.left);
  if (faces.right) c.stamp(m().polygon([S, E, up(E, h), up(S, h)]), faces.right);
  if (faces.top) c.stamp(m().polygon([up(N, h), up(E, h), up(S, h), up(Wv, h)]), faces.top);
  return { N, E, S, Wv };
}

/** Texture helpers: return fill functions over a mask. */
const planks = (light, mid, dark, pitch = 4) => (x, y, mk) => {
  if (!mk.has(x - 1, y)) return light;
  if (!mk.has(x + 1, y) || !mk.has(x, y + 1)) return dark;
  return x % pitch === 0 ? dark : mid;
};
const bricks = (light, mid, dark, mortar) => (x, y, mk) => {
  if (!mk.has(x, y - 1)) return light;
  if (!mk.has(x, y + 1)) return dark;
  const row = Math.floor(y / 4);
  if (y % 4 === 0) return mortar;
  return (x + row * 4) % 8 === 0 ? mortar : mid;
};
const stripes = (a, b, width = 4) => x => (Math.floor(x / width) % 2 === 0 ? a : b);

// ------------------------------------------------------------------ camp structures
function tentLarge() {
  const P = proto(3, 3, 64);
  const { c, m, g } = P;
  const ridgeA = up(g(0.4, 1.5), 50);
  const ridgeB = up(g(2.7, 1.5), 50);
  // back roof plane (north-east facing, slightly visible above ridge)
  c.stamp(m().polygon([g(0.2, 0.2), g(2.9, 0.2), ridgeB, ridgeA]), shade('canvas2', 'canvas2', 'canvas3'));
  // front roof plane (south-west facing)
  c.stamp(m().polygon([ridgeA, ridgeB, g(2.9, 2.9), g(0.2, 2.9)]), (x, y, mk) => {
    const v = shade('canvas1', 'canvas1', 'canvas3')(x, y, mk);
    return v === 'canvas1' && x % 9 === 0 ? 'canvas2' : v;
  });
  // gable end (south-east facing)
  const gable = m().polygon([g(2.9, 0.2), ridgeB, g(2.9, 2.9)]);
  c.stamp(gable, shade('canvas2', 'canvas2', 'canvas3'));
  // doorway and banner
  const door = m().polygon([up(g(2.9, 1.1), 0), up(g(2.9, 1.5), 30), up(g(2.9, 1.9), 0)]);
  c.paint(door, 'shadow');
  const b0 = up(g(1.2, 2.9), 36);
  c.stamp(m().polygon([b0, add(b0, [14, 7]), add(b0, [14, 25]), add(b0, [7, 21]), add(b0, [0, 18])]), shade('teal1', 'teal2', 'teal3'));
  c.stamp(m().ellipse(b0[0] + 7, b0[1] + 11, 2.6, 2.6), 'gold2');
  // ropes and pegs
  for (const [a, b] of [[ridgeA, g(-0.2, 1.5)], [ridgeB, g(3.3, 1.5)]]) c.paint(m().line(...a, ...b, 1), 'wood3');
  return finish(P, { occludes: true });
}

function tentSmall(variant = 'teal') {
  const P = proto(2, 2, 44);
  const { c, m, g } = P;
  const apex = up(g(1, 1), 36);
  c.stamp(m().polygon([g(0.1, 0.1), g(1.9, 0.1), apex]), shade('canvas2', 'canvas2', 'canvas3'));
  c.stamp(m().polygon([g(0.1, 0.1), apex, g(0.1, 1.9)]), shade('canvas2', 'canvas3', 'canvas3'));
  c.stamp(m().polygon([g(0.1, 1.9), apex, g(1.9, 1.9)]), shade('canvas1', 'canvas1', 'canvas3'));
  c.stamp(m().polygon([g(1.9, 0.1), g(1.9, 1.9), apex]), shade('canvas1', 'canvas2', 'canvas3'));
  c.paint(m().polygon([g(1.9, 0.75), up(g(1.9, 1), 20), g(1.9, 1.25)]), 'shadow');
  const trim = variant === 'teal' ? 'teal2' : 'crimson2';
  c.paint(m().line(...g(0.1, 1.9), ...g(1.9, 1.9), 1), trim);
  c.set(apex[0], apex[1] - 1, 'wood3'); c.set(apex[0], apex[1] - 2, 'wood3');
  c.set(apex[0] + 1, apex[1] - 3, trim); c.set(apex[0] + 2, apex[1] - 3, trim);
  return finish(P, { occludes: true });
}

function bedroll(color = 'teal') {
  const P = proto(1, 1, 8);
  const { c, m, g } = P;
  const ctr = g(0.5, 0.5);
  c.stamp(m().rect(ctr[0] - 15, ctr[1] - 4, 30, 9), shade('canvas1', 'canvas2', 'canvas3'));
  c.stamp(m().rect(ctr[0] - 6, ctr[1] - 4, 21, 9), shade(`${color}1`, `${color}2`, `${color}3`));
  c.stamp(m().ellipse(ctr[0] - 11, ctr[1], 4, 3), shade('white', 'canvas1', 'canvas2'));
  return finish(P, { walkable: true, layer: 'floor', sortY: 0 });
}

function bench() {
  const P = proto(1, 1, 12);
  const { c, m, g } = P;
  const ctr = g(0.5, 0.5);
  c.stamp(m().rect(ctr[0] - 9, ctr[1] - 2, 3, 6), 'wood3');
  c.stamp(m().rect(ctr[0] + 6, ctr[1] - 2, 3, 6), 'wood3');
  c.stamp(m().rect(ctr[0] - 12, ctr[1] - 5, 24, 4), planks('wood1', 'wood2', 'wood3', 6));
  return finish(P, { walkable: true, layer: 'floor', sortY: 0 });
}

function logSeat() {
  const P = proto(1, 1, 10);
  const { c, m, g } = P;
  const ctr = g(0.5, 0.5);
  c.stamp(m().rect(ctr[0] - 11, ctr[1] - 4, 20, 7), (x, y, mk) => (y % 3 === 0 ? 'wood3' : shade('wood1', 'wood2', 'wood3')(x, y, mk)));
  c.stamp(m().ellipse(ctr[0] + 10, ctr[1] - 0.5, 2.5, 3.6), shade('sand1', 'sand2', 'wood2'));
  return finish(P, { walkable: true, layer: 'floor', sortY: 0 });
}

function table() {
  const P = proto(2, 1, 24);
  const { c, m } = P;
  box(P, add(P.N, [0, 0]), 2, 1, 1, {});
  const top = box(P, up(P.g(0.2, 0.2), 12), 1.6, 0.6, 3, { left: 'wood3', right: 'wood4', top: planks('wood1', 'wood1', 'wood2', 6) });
  for (const leg of [P.g(0.3, 0.75), P.g(1.7, 0.75), P.g(1.7, 0.3)]) c.stamp(m().rect(leg[0] - 1, leg[1] - 10, 2, 10), 'wood3');
  const mid = lerp(up(top.N, 3), up(top.S, 3), 0.5);
  c.stamp(m().ellipse(mid[0] - 8, mid[1] - 1, 3, 1.6), shade('wood1', 'wood2', 'wood3'));
  c.stamp(m().ellipse(mid[0] + 7, mid[1] + 1, 3, 1.6), shade('wood1', 'wood2', 'wood3'));
  c.stamp(m().ellipse(mid[0], mid[1] - 3, 2, 1.2), shade('crimson1', 'crimson2', 'crimson3'));
  return finish(P);
}

function campfire(frame = 0) {
  const P = proto(1, 1, 26);
  const { c, m, g } = P;
  const ctr = g(0.5, 0.5);
  const r = createRandom(7);
  for (let i = 0; i < 9; i += 1) {
    const a = (i / 9) * Math.PI * 2;
    c.stamp(m().ellipse(ctr[0] + Math.cos(a) * 11, ctr[1] + Math.sin(a) * 5.5, 2.6, 2), shade('stone1', 'stone2', 'stone4'));
    void r;
  }
  c.stamp(m().line(ctr[0] - 6, ctr[1] + 2, ctr[0] + 6, ctr[1] - 2, 2), 'wood3');
  c.stamp(m().line(ctr[0] - 6, ctr[1] - 2, ctr[0] + 6, ctr[1] + 2, 2), 'wood2');
  flame(c, ctr[0], ctr[1] - 1, 1, frame);
  return finish(P, { light: { radius: 6, color: 'fire2' } });
}

/** Animated flame; frame 0..2 changes the tongue shapes. */
function flame(c, x, y, size, frame) {
  const m = () => new Mask(c.width, c.height);
  const sway = [0, 1.2, -1][frame % 3];
  const h = [12, 14, 11][frame % 3] * size;
  c.stamp(m().polygon([[x - 5 * size, y], [x - 2 * size + sway, y - h * 0.6], [x + sway * 1.5, y - h], [x + 2.5 * size + sway, y - h * 0.55], [x + 5 * size, y]]), 'fire4', 'fire4');
  c.paint(m().polygon([[x - 3.5 * size, y], [x - 1 * size + sway, y - h * 0.5], [x + sway, y - h * 0.8], [x + 2 * size + sway * 0.5, y - h * 0.45], [x + 3.5 * size, y]]), 'fire3');
  c.paint(m().polygon([[x - 2 * size, y], [x + sway * 0.5, y - h * 0.5], [x + 2 * size, y]]), 'fire2');
  c.set(x, y - 1, 'fire1'); c.set(x + 1, y - 2, 'fire1');
}

function torch(frame = 0) {
  const P = proto(1, 1, 52);
  const { c, m, g } = P;
  const base = g(0.5, 0.5);
  c.stamp(m().rect(base[0] - 1, base[1] - 30, 3, 31), shade('wood1', 'wood2', 'wood3'));
  c.stamp(m().polygon([[base[0] - 5, base[1] - 34], [base[0] + 6, base[1] - 34], [base[0] + 3, base[1] - 28], [base[0] - 2, base[1] - 28]]), shade('steel2', 'steel3', 'steel4'));
  flame(c, base[0] + 0.5, base[1] - 34, 0.75, frame);
  return finish(P, { light: { radius: 4, color: 'fire2' } });
}

function dummy() {
  const P = proto(1, 1, 50);
  const { c, m, g } = P;
  const b = g(0.5, 0.5);
  c.stamp(m().ellipse(b[0], b[1], 7, 3.5), shade('sand1', 'sand2', 'sand4'));
  c.stamp(m().rect(b[0] - 1, b[1] - 40, 3, 40), shade('wood1', 'wood2', 'wood3'));
  c.stamp(m().rect(b[0] - 11, b[1] - 31, 22, 3), shade('wood1', 'wood2', 'wood3'));
  c.stamp(m().ellipse(b[0], b[1] - 23, 6, 9), (x, y, mk) => (y % 3 === 0 ? 'sand3' : shade('gold1', 'sand2', 'sand3')(x, y, mk)));
  c.stamp(m().ellipse(b[0], b[1] - 37, 4.5, 4.5), shade('canvas1', 'canvas2', 'canvas3'));
  c.paint(m().line(b[0] - 5, b[1] - 20, b[0] + 5, b[1] - 20, 1), 'crimson2');
  c.set(b[0] + 2, b[1] - 38, 'outline'); c.set(b[0] - 1, b[1] - 38, 'outline');
  return finish(P, { occludes: false });
}

function weightRack() {
  const P = proto(2, 1, 26);
  const { c, m, g } = P;
  for (const t of [0.15, 1.85]) {
    const p = g(t, 0.5);
    c.stamp(m().rect(p[0] - 1, p[1] - 18, 3, 18), shade('wood1', 'wood2', 'wood3'));
  }
  const a = up(g(0.15, 0.5), 16);
  const b = up(g(1.85, 0.5), 16);
  c.stamp(m().line(...a, ...b, 1), 'steel3');
  for (const t of [0.3, 0.7]) {
    const p = lerp(a, b, t);
    for (const s of [-6, 6]) c.stamp(m().ellipse(p[0] + s, p[1] + s / 2, 2, 4.5), shade('stone2', 'stone4', 'stone5'));
  }
  c.stamp(m().ellipse(...add(g(1, 0.6), [0, -2]), 5, 3), shade('stone2', 'stone4', 'stone5'));
  return finish(P);
}

function weaponRack() {
  const P = proto(1, 1, 44);
  const { c, m, g } = P;
  const b = g(0.5, 0.5);
  c.stamp(m().rect(b[0] - 12, b[1] - 6, 24, 3), shade('wood1', 'wood2', 'wood3'));
  c.stamp(m().rect(b[0] - 12, b[1] - 24, 24, 3), shade('wood1', 'wood2', 'wood3'));
  for (const [dx, kind] of [[-8, 'spear'], [-3, 'sword'], [2, 'spear'], [7, 'axe']]) {
    const top = kind === 'spear' ? 38 : 30;
    c.stamp(m().line(b[0] + dx, b[1] - 4, b[0] + dx, b[1] - top, 1), kind === 'sword' ? 'steel2' : 'wood2');
    if (kind === 'spear') c.stamp(m().polygon([[b[0] + dx - 1.5, b[1] - top], [b[0] + dx + 0.5, b[1] - top - 5], [b[0] + dx + 2, b[1] - top]]), 'steel2');
    if (kind === 'axe') c.stamp(m().polygon([[b[0] + dx, b[1] - top + 2], [b[0] + dx + 5, b[1] - top - 1], [b[0] + dx + 5, b[1] - top + 6], [b[0] + dx, b[1] - top + 5]]), 'steel2');
    if (kind === 'sword') c.stamp(m().line(b[0] + dx - 2, b[1] - 9, b[0] + dx + 2, b[1] - 9, 1), 'gold2');
  }
  return finish(P);
}

function stall(kind) {
  const P = proto(3, 2, 62);
  const { c, m, g } = P;
  const [awA, awB] = kind === 'weapons' ? ['crimson2', 'canvas1'] : ['teal2', 'canvas1'];
  for (const p of [g(0.1, 0.1), g(2.9, 0.1), g(2.9, 1.9), g(0.1, 1.9)]) c.stamp(m().rect(p[0] - 1, p[1] - 40, 3, 40), shade('wood1', 'wood2', 'wood3'));
  // counter along the south-west edge
  box(P, up(g(0.2, 1.3), 0), 2.6, 0.5, 14, { left: planks('wood2', 'wood2', 'wood4', 5), right: 'wood4', top: planks('wood1', 'wood1', 'wood2', 7) });
  // goods on the counter
  const top = (u) => up(g(u, 1.55), 15);
  if (kind === 'weapons') {
    for (const [u, len] of [[0.5, 12], [0.9, 10], [1.3, 12]]) { const p = top(u); c.stamp(m().line(p[0], p[1], p[0] + len, p[1] + len / 2, 1), 'steel2'); c.set(p[0] - 1, p[1], 'gold2'); }
    const p = top(1.9); c.stamp(m().polygon([[p[0], p[1] - 4], [p[0] + 6, p[1] - 6], [p[0] + 6, p[1]], [p[0], p[1] + 1]]), shade('steel1', 'steel2', 'steel3'));
    const q = top(2.4); c.stamp(m().ellipse(q[0], q[1] - 3, 4, 5), shade('teal1', 'teal2', 'teal3')); c.set(q[0], q[1] - 3, 'gold1');
  } else {
    const p = top(0.7); c.stamp(m().ellipse(p[0], p[1] - 4, 5, 4), shade('steel1', 'steel2', 'steel3'));
    const q = top(1.5); c.stamp(m().rect(q[0] - 4, q[1] - 9, 9, 9), shade('leather1', 'leather2', 'leather3'));
    const r = top(2.3); c.stamp(m().ellipse(r[0], r[1] - 4, 4, 5), shade('steel1', 'steel2', 'steel4')); c.paint(m().rect(r[0] - 1, r[1] - 9, 3, 3), 'crimson2');
  }
  // striped awning sloping toward the front
  const a0 = up(g(0, 0), 46);
  const a1 = up(g(3, 0), 46);
  const a2 = up(g(3, 2.2), 36);
  const a3 = up(g(0, 2.2), 36);
  c.stamp(m().polygon([a0, a1, a2, a3]), (x, y) => stripes(awA, awB, 6)(x + Math.floor(y / 2)));
  for (let u = 0; u <= 3; u += 0.5) { const p = up(g(u, 2.2), 36); c.stamp(m().polygon([p, add(p, [10, 5]), add(p, [5, 8])]), Math.round(u * 2) % 2 ? awA : awB); }
  return finish(P, { occludes: true });
}

function crate() {
  const P = proto(1, 1, 22);
  const { c } = P;
  box(P, up(P.g(0.2, 0.2), 0), 0.6, 0.6, 16, { left: planks('wood1', 'wood2', 'wood3', 5), right: planks('wood2', 'wood3', 'wood4', 5), top: shade('wood1', 'wood1', 'wood2') });
  void c;
  return finish(P);
}

function barrel() {
  const P = proto(1, 1, 24);
  const { c, m, g } = P;
  const b = g(0.5, 0.5);
  c.stamp(m().rect(b[0] - 7, b[1] - 16, 15, 16).ellipse(b[0] + 0.5, b[1], 7.5, 3.5), (x, y, mk) => {
    if (y === Math.round(b[1] - 12) || y === Math.round(b[1] - 4)) return 'steel3';
    return planks('wood1', 'wood2', 'wood3', 3)(x, y, mk);
  });
  c.stamp(m().ellipse(b[0] + 0.5, b[1] - 16, 7.5, 3.5), shade('wood2', 'wood3', 'wood3'));
  return finish(P);
}

function sacks() {
  const P = proto(1, 1, 18);
  const { c, m, g } = P;
  const b = g(0.5, 0.5);
  c.stamp(m().ellipse(b[0] - 4, b[1] - 6, 6, 7), shade('canvas1', 'canvas2', 'canvas3'));
  c.stamp(m().ellipse(b[0] + 5, b[1] - 4, 5, 5.5), shade('canvas1', 'canvas2', 'canvas3'));
  return finish(P);
}

function palisade(axis) {
  const P = proto(1, 1, 46);
  const { c, m, g } = P;
  const pts = [0.1, 0.35, 0.6, 0.85].map(t => (axis === 'x' ? g(t, 0.5) : g(0.5, t)));
  pts.sort((a, b) => a[1] - b[1]);
  for (const p of pts) {
    c.stamp(m().rect(p[0] - 3, p[1] - 36, 7, 36).polygon([[p[0] - 3, p[1] - 36], [p[0] + 0.5, p[1] - 42], [p[0] + 4, p[1] - 36]]), planks('wood1', 'wood2', 'wood3', 99));
  }
  const a = axis === 'x' ? g(0, 0.5) : g(0.5, 0);
  const b = axis === 'x' ? g(1, 0.5) : g(0.5, 1);
  c.paint(new Mask(c.width, c.height).line(a[0], a[1] - 26, b[0], b[1] - 26, 2), 'wood4');
  return finish(P, { occludes: true });
}

function gatePillar() {
  const P = proto(1, 1, 70);
  const { c, m, g } = P;
  box(P, P.g(0.15, 0.15), 0.7, 0.7, 50, { left: bricks('stone1', 'stone2', 'stone3', 'stone4'), right: bricks('stone2', 'stone3', 'stone4', 'stone5'), top: 'stone1' });
  const t = up(g(0.5, 0.5), 54);
  c.stamp(m().ellipse(t[0], t[1], 7, 3), shade('steel2', 'steel3', 'steel4'));
  flame(c, t[0], t[1] - 1, 0.8, 0);
  const banner = up(g(0.85, 0.85), 44);
  c.stamp(m().polygon([banner, add(banner, [9, -4]), add(banner, [9, 18]), add(banner, [4.5, 15]), add(banner, [0, 22])]), shade('crimson1', 'crimson2', 'crimson3'));
  c.stamp(m().ellipse(banner[0] + 4.5, banner[1] + 6, 2, 2), 'gold2');
  return finish(P, { occludes: true, light: { radius: 4, color: 'fire2' } });
}

function gateArch() {
  // Wooden crossbeam with banner spanning three tiles along the y axis; drawn over walkers.
  const P = proto(1, 3, 80, 40);
  const { c, m, g } = P;
  const a = up(g(0.5, -0.5), 62);
  const b = up(g(0.5, 3.5), 62);
  c.stamp(m().polygon([a, b, add(b, [0, 7]), add(a, [0, 7])]), planks('wood1', 'wood2', 'wood3', 7));
  const mid = lerp(a, b, 0.5);
  c.stamp(m().polygon([add(mid, [-9, 8]), add(mid, [9, 8]), add(mid, [9, 30]), add(mid, [0, 25]), add(mid, [-9, 30])]), shade('teal1', 'teal2', 'teal3'));
  c.stamp(m().ellipse(mid[0], mid[1] + 15, 3, 3), shade('gold1', 'gold2', 'gold3'));
  return finish(P, { occludes: true, layer: 'foreground', walkable: true, sortY: 9999 });
}

function bannerPole(color) {
  const P = proto(1, 1, 64);
  const { c, m, g } = P;
  const b = g(0.5, 0.5);
  c.stamp(m().rect(b[0] - 1, b[1] - 56, 2, 56), shade('wood1', 'wood2', 'wood3'));
  c.set(b[0], b[1] - 58, 'gold1');
  c.stamp(m().polygon([[b[0] + 1, b[1] - 54], [b[0] + 16, b[1] - 50], [b[0] + 12, b[1] - 44], [b[0] + 16, b[1] - 38], [b[0] + 1, b[1] - 40]]), shade(`${color}1`, `${color}2`, `${color}3`));
  return finish(P);
}

function watchtower() {
  const P = proto(2, 2, 110);
  const { c, m, g } = P;
  for (const p of [g(0.2, 0.2), g(1.8, 0.2), g(1.8, 1.8), g(0.2, 1.8)]) c.stamp(m().rect(p[0] - 2, p[1] - 72, 4, 72), shade('wood1', 'wood2', 'wood3'));
  c.paint(m().line(...up(g(0.2, 1.8), 10), ...up(g(1.8, 1.8), 50), 2), 'wood3');
  c.paint(m().line(...up(g(1.8, 1.8), 10), ...up(g(1.8, 0.2), 50), 2), 'wood3');
  box(P, up(g(0, 0), 70), 2, 2, 14, { left: planks('wood1', 'wood2', 'wood3', 5), right: planks('wood2', 'wood3', 'wood4', 5), top: 'wood2' });
  for (const p of [g(0.15, 0.15), g(1.85, 0.15), g(1.85, 1.85), g(0.15, 1.85)]) c.stamp(m().rect(p[0] - 1, p[1] - 92, 3, 8), 'wood3');
  const apex = up(g(1, 1), 106);
  c.stamp(m().polygon([up(g(-0.1, 1), 86), apex, up(g(1, 2.1), 86)]), shade('crimson1', 'crimson2', 'crimson3'));
  c.stamp(m().polygon([up(g(1, 2.1), 86), apex, up(g(2.1, 1), 86)]), shade('crimson2', 'crimson3', 'crimson4'));
  return finish(P, { occludes: true });
}

function well() {
  const P = proto(1, 1, 40);
  const { c, m, g } = P;
  const b = g(0.5, 0.5);
  c.stamp(m().ellipse(b[0], b[1] - 4, 12, 6).rect(b[0] - 12, b[1] - 10, 24, 6), bricks('stone1', 'stone2', 'stone3', 'stone4'));
  c.paint(m().ellipse(b[0], b[1] - 10, 9, 4), 'water3');
  c.stamp(m().rect(b[0] - 11, b[1] - 32, 2, 22), 'wood2');
  c.stamp(m().rect(b[0] + 9, b[1] - 32, 2, 22), 'wood2');
  c.stamp(m().polygon([[b[0] - 14, b[1] - 30], [b[0], b[1] - 38], [b[0] + 14, b[1] - 30]]), shade('crimson1', 'crimson2', 'crimson3'));
  return finish(P);
}

// ------------------------------------------------------------------ arena ring
export const ARENA = { radius: 6.5, segments: 16, wallHeight: 26, gateAngle: 45, gateHalfWidth: 13 };

/**
 * One arc segment of the arena wall. Geometry is computed in tile space around the
 * ring centre vertex; the frame anchor is the north vertex of `anchorTile` so the map
 * can place it like any other prop.
 */
export function arenaSegment(index, centre, anchorTile) {
  const { radius: R, segments, wallHeight: H, gateAngle, gateHalfWidth } = ARENA;
  const span = 360 / segments;
  const t0 = index * span;
  const t1 = t0 + span;
  const toScreen = (x, y) => [(x - y) * 32, (x + y) * 16];
  const ring = (r, deg) => { const a = (deg * Math.PI) / 180; return toScreen(centre[0] + r * Math.cos(a), centre[1] + r * Math.sin(a)); };
  const pad = 40;
  const pts = [];
  for (let d = t0; d <= t1 + 1e-6; d += span / 8) pts.push(ring(R + 0.45, d), ring(R - 0.45, d));
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  const ox = Math.floor(Math.min(...xs)) - pad;
  const oy = Math.floor(Math.min(...ys)) - H - pad;
  const c = new PixelCanvas(Math.ceil(Math.max(...xs)) - ox + pad, Math.ceil(Math.max(...ys)) - oy + pad);
  const L = ([x, y]) => [x - ox, y - oy];
  const m = () => new Mask(c.width, c.height);
  const steps = 8;
  const inGate = d => Math.abs(((d - gateAngle + 540) % 360) - 180) < gateHalfWidth;
  let lowest = -Infinity;
  for (let i = 0; i < steps; i += 1) {
    const da = t0 + (span * i) / steps;
    const db = t0 + (span * (i + 1)) / steps;
    if (inGate((da + db) / 2)) continue;
    const oa = L(ring(R + 0.45, da)); const ob = L(ring(R + 0.45, db));
    const ia = L(ring(R - 0.45, da)); const ib = L(ring(R - 0.45, db));
    const mid = ((da + db) / 2) * Math.PI / 180;
    const facesViewer = Math.cos(mid) + Math.sin(mid) > 0; // outward normal points down-screen
    lowest = Math.max(lowest, oa[1], ob[1]);
    if (facesViewer) {
      c.stamp(m().polygon([oa, ob, up(ob, H), up(oa, H)]), bricks('stone2', 'stone2', 'stone4', 'stone4'), 'stone5');
    } else {
      c.stamp(m().polygon([ia, ib, up(ib, H), up(ia, H)]), bricks('stone3', 'stone3', 'stone4', 'stone5'), 'stone5');
    }
    c.stamp(m().polygon([up(oa, H), up(ob, H), up(ib, H), up(ia, H)]), shade('stone1', 'stone1', 'stone2'), 'stone5');
  }
  // crimson banner hung on alternate front segments
  const midDeg = (t0 + t1) / 2;
  const midRad = midDeg * Math.PI / 180;
  if (index % 2 === 0 && Math.cos(midRad) + Math.sin(midRad) > 0.3 && !inGate(midDeg)) {
    const p = up(L(ring(R + 0.5, midDeg)), H - 3);
    c.stamp(m().polygon([p, add(p, [10, 0]), add(p, [10, 16]), add(p, [5, 13]), add(p, [0, 16])]), shade('crimson1', 'crimson2', 'crimson3'));
    c.stamp(m().ellipse(p[0] + 5, p[1] + 6, 2, 2), 'gold2');
  }
  const anchor = L(toScreen(anchorTile[0], anchorTile[1]));
  const frame = {
    canvas: c,
    anchorX: Math.round(anchor[0]),
    anchorY: Math.round(anchor[1]),
    footprint: { w: 1, d: 1 },
    sortY: Math.round(lowest === -Infinity ? 0 : lowest - anchor[1]),
    occludes: true,
    walkable: false,
    layer: 'object',
  };
  return cropFrame(frame);
}

function cropFrame(frame) {
  const { canvas: c } = frame;
  let minX = c.width; let minY = c.height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < c.height; y += 1) for (let x = 0; x < c.width; x += 1) if (c.opaque(x, y)) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (maxX < 0) { minX = frame.anchorX; minY = frame.anchorY; maxX = frame.anchorX; maxY = frame.anchorY; }
  const x0 = Math.min(minX - 1, frame.anchorX - 1);
  const y0 = Math.min(minY - 1, frame.anchorY - 1);
  const x1 = Math.max(maxX + 1, frame.anchorX + 1);
  const y1 = Math.max(maxY + 1, frame.anchorY + 1);
  return { ...frame, canvas: c.crop(x0, y0, x1 - x0 + 1, y1 - y0 + 1), anchorX: frame.anchorX - x0, anchorY: frame.anchorY - y0 };
}

function arenaGatePost(side) {
  const P = proto(1, 1, 64);
  const { c, m, g } = P;
  box(P, P.g(0.2, 0.2), 0.6, 0.6, 38, { left: bricks('stone1', 'stone2', 'stone3', 'stone4'), right: bricks('stone2', 'stone3', 'stone4', 'stone5'), top: 'stone1' });
  const t = up(g(0.5, 0.5), 40);
  c.stamp(m().ellipse(t[0], t[1], 5, 2.5), shade('steel2', 'steel3', 'steel4'));
  flame(c, t[0], t[1] - 1, 0.6, side === 'left' ? 0 : 1);
  return finish(P, { occludes: true, light: { radius: 4, color: 'fire2' } });
}

// ------------------------------------------------------------------ nature
function treeOak(seed = 1, palette = ['leaf1', 'grass3', 'leaf2', 'leaf3']) {
  const P = proto(1, 1, 92, 12);
  const { c, m, g } = P;
  const r = createRandom(hashSeed(`oak${seed}`));
  const b = g(0.5, 0.5);
  c.stamp(m().rect(b[0] - 3, b[1] - 46, 7, 46).polygon([[b[0] - 6, b[1]], [b[0] - 2, b[1] - 6], [b[0] + 3, b[1] - 6], [b[0] + 7, b[1]]]), planks('wood2', 'wood3', 'wood4', 3));
  const blobs = [];
  for (let i = 0; i < 9; i += 1) blobs.push([b[0] + r.int(-15, 15), b[1] - 58 + r.int(-14, 8), r.int(9, 12)]);
  blobs.sort((a, b2) => a[1] - b2[1]);
  const canopy = m();
  for (const [x, y, rad] of blobs) canopy.ellipse(x, y, rad, rad * 0.85);
  c.stamp(canopy, (x, y, mk) => {
    const v = shade(palette[1], palette[0], palette[2], { depth: 2 })(x, y, mk);
    if (v === palette[0] && (x * 7 + y * 3) % 11 === 0) return palette[2];
    if (v === palette[0] && y > b[1] - 50) return palette[2];
    return v;
  });
  for (const [x, y, rad] of blobs.slice(-4)) c.paint(m().ellipse(x - rad * 0.3, y - rad * 0.35, rad * 0.35, rad * 0.25), palette[1]);
  return finish(P, { occludes: true });
}

function treePine(seed = 1, snow = false) {
  const P = proto(1, 1, 100, 6);
  const { c, m, g } = P;
  const b = g(0.5, 0.5);
  c.stamp(m().rect(b[0] - 2, b[1] - 16, 5, 16), planks('wood2', 'wood3', 'wood4', 3));
  const tiers = [[b[1] - 12, 18], [b[1] - 30, 15], [b[1] - 46, 12], [b[1] - 60, 8]];
  for (const [y, w] of tiers) {
    c.stamp(m().polygon([[b[0] - w, y], [b[0] + 0.5, y - w * 1.6], [b[0] + w + 1, y]]), (x, yy, mk) => {
      const v = shade('grass3', 'leaf1', 'leaf2')(x, yy, mk);
      if (snow && (!mk.has(x, yy - 1) || !mk.has(x, yy - 2))) return 'snow1';
      if (snow && yy > y - 2) return 'snow2';
      return x > b[0] + 1 && v === 'leaf1' ? 'leaf2' : v;
    });
  }
  void seed;
  return finish(P, { occludes: true });
}

function deadTree() {
  const P = proto(1, 1, 70, 8);
  const { c, m, g } = P;
  const b = g(0.5, 0.5);
  const trunk = m().limb(b[0], b[1], b[0] + 2, b[1] - 40, 6, 3).limb(b[0] + 1, b[1] - 24, b[0] - 12, b[1] - 40, 3, 1.5).limb(b[0] + 2, b[1] - 34, b[0] + 14, b[1] - 50, 3, 1.5).limb(b[0] + 2, b[1] - 40, b[0] - 2, b[1] - 56, 2.4, 1.2);
  c.stamp(trunk, shade('wood2', 'wood3', 'wood4'));
  return finish(P, { occludes: true });
}

function bush(seed = 1, palette = ['grass2', 'grass3', 'leaf1']) {
  const P = proto(1, 1, 24);
  const { c, m, g } = P;
  const r = createRandom(hashSeed(`bush${seed}`));
  const b = g(0.5, 0.5);
  const mk0 = m();
  for (let i = 0; i < 4; i += 1) mk0.ellipse(b[0] + r.int(-8, 8), b[1] - 6 + r.int(-4, 2), r.int(5, 8), r.int(4, 6));
  c.stamp(mk0, shade(palette[0], palette[1], palette[2]));
  if (r.chance(0.6)) for (let i = 0; i < 3; i += 1) c.set(b[0] + r.int(-7, 7), b[1] - 8 + r.int(-3, 3), r.pick(['crimson1', 'fire2', 'white']));
  return finish(P);
}

function rock(seed = 1, size = 1, palette = ['stone1', 'stone2', 'stone4']) {
  const P = proto(1, 1, 30 * size);
  const { c, m, g } = P;
  const r = createRandom(hashSeed(`rock${seed}`));
  const b = g(0.5, 0.5);
  const pts = [];
  const n = 7;
  for (let i = 0; i < n; i += 1) {
    const a = Math.PI + (i / (n - 1)) * Math.PI;
    const rad = (10 + r.int(-2, 3)) * size;
    pts.push([b[0] + Math.cos(a) * rad * 1.3, b[1] + 2 + Math.sin(a) * rad * 1.1]);
  }
  pts.push([b[0] + 13 * size, b[1] + 3], [b[0] - 13 * size, b[1] + 3]);
  const mk = m().polygon(pts);
  c.stamp(mk, shade(palette[0], palette[1], palette[2], { depth: 2 }));
  c.paint(m().line(b[0] - 3 * size, b[1] - 6 * size, b[0] + 2 * size, b[1] - 2 * size, 1), palette[2]);
  return finish(P);
}

function logProp() {
  const P = proto(1, 1, 14);
  const { c, m, g } = P;
  const b = g(0.5, 0.5);
  c.stamp(m().polygon([[b[0] - 14, b[1] - 4], [b[0] + 10, b[1] - 9], [b[0] + 12, b[1] - 2], [b[0] - 12, b[1] + 3]]), (x, y, mk) => (x % 5 === 0 ? 'wood3' : shade('wood1', 'wood2', 'wood3')(x, y, mk)));
  c.stamp(m().ellipse(b[0] + 11, b[1] - 5.5, 2.6, 3.8), shade('sand1', 'sand2', 'wood2'));
  return finish(P);
}

function mushrooms() {
  const P = proto(1, 1, 14);
  const { c, m, g } = P;
  const b = g(0.5, 0.5);
  for (const [dx, dy, s] of [[-5, 0, 1], [2, 2, 0.8], [6, -2, 0.7]]) {
    c.stamp(m().rect(b[0] + dx - 1, b[1] + dy - 5 * s, 2, 5 * s), 'canvas1');
    c.stamp(m().ellipse(b[0] + dx, b[1] + dy - 6 * s, 4 * s, 2.6 * s), shade('crimson1', 'crimson2', 'crimson3'));
    c.set(b[0] + dx - 1, b[1] + dy - 7 * s, 'white');
  }
  return finish(P, { walkable: true, layer: 'floor', sortY: 0 });
}

function flowers() {
  const P = proto(1, 1, 10);
  const { c, g } = P;
  const r = createRandom(31);
  const b = g(0.5, 0.5);
  for (let i = 0; i < 9; i += 1) {
    const x = b[0] + r.int(-12, 12);
    const y = b[1] + r.int(-5, 5);
    c.set(x, y + 1, 'grass3'); c.set(x, y, r.pick(['fire2', 'crimson1', 'white', 'violet1']));
  }
  return finish(P, { walkable: true, layer: 'floor', sortY: 0 });
}

// ------------------------------------------------------------------ outpost & mountain
function ruinWall(axis, seed = 1) {
  const P = proto(1, 1, 50);
  const r = createRandom(hashSeed(`ruin${axis}${seed}`));
  const h = r.int(22, 40);
  if (axis === 'x') box(P, P.g(0, 0.3), 1, 0.4, h, { left: bricks('stone2', 'stone2', 'stone4', 'stone4'), right: bricks('stone3', 'stone3', 'stone4', 'stone5'), top: 'stone1' });
  else box(P, P.g(0.3, 0), 0.4, 1, h, { left: bricks('stone2', 'stone2', 'stone4', 'stone4'), right: bricks('stone3', 'stone3', 'stone4', 'stone5'), top: 'stone1' });
  // broken top: erase a jagged notch
  const { c } = P;
  const notch = new Mask(c.width, c.height);
  const cx = P.g(0.5, 0.5)[0] + r.int(-6, 6);
  const topY = P.g(0.5, 0.5)[1] - h - 6;
  notch.polygon([[cx - 9, topY - 10], [cx + 9, topY - 10], [cx + 4, topY + 8], [cx - 2, topY + 5]]);
  c.erase(notch);
  return finish(P, { occludes: true });
}

function brokenPillar(seed = 1) {
  const P = proto(1, 1, 60);
  const { c, m, g } = P;
  const r = createRandom(hashSeed(`pillar${seed}`));
  const b = g(0.5, 0.5);
  const h = r.int(26, 48);
  c.stamp(m().ellipse(b[0], b[1], 9, 4.5), shade('stone1', 'stone2', 'stone4'));
  c.stamp(m().rect(b[0] - 6, b[1] - h, 13, h), (x, y, mk) => ((x - b[0] + 6) % 4 === 0 ? 'stone3' : shade('stone1', 'stone2', 'stone4')(x, y, mk)));
  c.stamp(m().polygon([[b[0] - 6, b[1] - h], [b[0] - 2, b[1] - h - 5], [b[0] + 2, b[1] - h - 1], [b[0] + 7, b[1] - h - 6], [b[0] + 7, b[1] - h]]), 'stone1');
  return finish(P, { occludes: true });
}

function rubble(seed = 1) {
  const P = proto(1, 1, 14);
  const { c, m, g } = P;
  const r = createRandom(hashSeed(`rubble${seed}`));
  const b = g(0.5, 0.5);
  for (let i = 0; i < 6; i += 1) c.stamp(m().ellipse(b[0] + r.int(-12, 12), b[1] + r.int(-4, 4), r.int(2, 4), r.int(1, 3)), shade('stone1', 'stone2', 'stone4'));
  return finish(P, { walkable: true, layer: 'floor', sortY: 0 });
}

function tornBanner() {
  const P = proto(1, 1, 60);
  const { c, m, g } = P;
  const b = g(0.5, 0.5);
  c.stamp(m().line(b[0], b[1], b[0] + 3, b[1] - 50, 2), 'wood3');
  c.stamp(m().polygon([[b[0] + 3, b[1] - 48], [b[0] + 18, b[1] - 46], [b[0] + 14, b[1] - 40], [b[0] + 17, b[1] - 33], [b[0] + 9, b[1] - 36], [b[0] + 4, b[1] - 30]]), shade('crimson2', 'crimson3', 'crimson4'));
  return finish(P);
}

function bones() {
  const P = proto(1, 1, 12);
  const { c, m, g } = P;
  const b = g(0.5, 0.5);
  c.stamp(m().ellipse(b[0] - 4, b[1] - 2, 3.5, 3), shade('white', 'canvas1', 'canvas3'));
  c.set(b[0] - 5, b[1] - 2, 'outline'); c.set(b[0] - 3, b[1] - 2, 'outline');
  c.stamp(m().line(b[0], b[1] + 1, b[0] + 9, b[1] - 2, 1), 'canvas1');
  c.stamp(m().line(b[0] + 2, b[1] - 3, b[0] + 8, b[1] + 2, 1), 'canvas2');
  return finish(P, { walkable: true, layer: 'floor', sortY: 0 });
}

function crystal() {
  const P = proto(1, 1, 34);
  const { c, m, g } = P;
  const b = g(0.5, 0.5);
  for (const [dx, h, w] of [[-5, 18, 4], [3, 26, 5], [9, 14, 3]]) {
    c.stamp(m().polygon([[b[0] + dx - w, b[1]], [b[0] + dx - w, b[1] - h * 0.7], [b[0] + dx, b[1] - h], [b[0] + dx + w, b[1] - h * 0.7], [b[0] + dx + w, b[1]]]), (x, y, mk) => (x <= b[0] + dx ? shade('water1', 'violet1', 'violet2')(x, y, mk) : 'violet2'));
  }
  return finish(P);
}

function rockSpire(seed = 1) {
  const P = proto(1, 1, 80, 6);
  const { c, m, g } = P;
  const r = createRandom(hashSeed(`spire${seed}`));
  const b = g(0.5, 0.5);
  const h = r.int(50, 70);
  const mk = m().polygon([[b[0] - 16, b[1] + 2], [b[0] - 10, b[1] - h * 0.5], [b[0] - 4, b[1] - h], [b[0] + 4, b[1] - h * 0.8], [b[0] + 10, b[1] - h * 0.45], [b[0] + 16, b[1] + 2]]);
  c.stamp(mk, (x, y, k) => {
    if (!k.has(x, y - 1) || !k.has(x, y - 2)) return y < b[1] - h * 0.3 ? 'snow1' : 'stone1';
    return x > b[0] ? 'stone3' : shade('stone1', 'stone2', 'stone4')(x, y, k);
  });
  c.paint(m().line(b[0] - 2, b[1] - h * 0.7, b[0] + 2, b[1] - h * 0.3, 1), 'stone4');
  return finish(P, { occludes: true });
}

function raiderTent() {
  const f = tentSmall('crimson');
  return f;
}

// ------------------------------------------------------------------ catalogue
export function renderCampProps() {
  const list = [
    ['tent-large', tentLarge()], ['tent-small', tentSmall('teal')], ['bedroll-teal', bedroll('teal')], ['bedroll-crimson', bedroll('crimson')],
    ['bench', bench()], ['log-seat', logSeat()], ['table', table()], ['campfire/0', campfire(0)], ['campfire/1', campfire(1)], ['campfire/2', campfire(2)],
    ['torch/0', torch(0)], ['torch/1', torch(1)], ['torch/2', torch(2)], ['dummy', dummy()], ['weight-rack', weightRack()], ['weapon-rack', weaponRack()],
    ['stall-weapons', stall('weapons')], ['stall-armor', stall('armor')], ['crate', crate()], ['barrel', barrel()], ['sacks', sacks()],
    ['palisade-x', palisade('x')], ['palisade-y', palisade('y')], ['gate-pillar', gatePillar()], ['gate-arch', gateArch()],
    ['banner-teal', bannerPole('teal')], ['banner-crimson', bannerPole('crimson')], ['watchtower', watchtower()], ['well', well()],
    ['arena-gate-post-left', arenaGatePost('left')], ['arena-gate-post-right', arenaGatePost('right')],
    ['tree-oak/0', treeOak(0)], ['tree-oak/1', treeOak(1)], ['tree-pine/0', treePine(0)], ['bush/0', bush(0)], ['bush/1', bush(1)],
    ['rock-small', rock(1, 0.7)], ['rock-large', rock(2, 1.2)], ['flowers', flowers()],
  ];
  return list.map(([name, f]) => ({ name, ...f }));
}

export function renderExpeditionProps(id) {
  const props = {
    woodland: [
      ['tree-oak/0', treeOak(10)], ['tree-oak/1', treeOak(11)], ['tree-oak/2', treeOak(12)], ['tree-pine/0', treePine(3)], ['tree-pine/1', treePine(4)],
      ['bush/0', bush(5)], ['bush/1', bush(6)], ['log', logProp()], ['mushrooms', mushrooms()], ['rock-small', rock(7, 0.7)], ['rock-large', rock(8, 1.1)],
      ['flowers', flowers()], ['tent-small', tentSmall('teal')], ['campfire/0', campfire(0)], ['campfire/1', campfire(1)], ['campfire/2', campfire(2)],
    ],
    outpost: [
      ['ruin-wall-x/0', ruinWall('x', 1)], ['ruin-wall-x/1', ruinWall('x', 2)], ['ruin-wall-y/0', ruinWall('y', 3)], ['ruin-wall-y/1', ruinWall('y', 4)],
      ['pillar/0', brokenPillar(1)], ['pillar/1', brokenPillar(2)], ['rubble/0', rubble(1)], ['rubble/1', rubble(2)], ['crate', crate()], ['barrel', barrel()],
      ['raider-tent', raiderTent()], ['tent-small', tentSmall('teal')], ['torn-banner', tornBanner()], ['dead-tree', deadTree()], ['rock-small', rock(9, 0.7, ['sand2', 'sand3', 'sand4'])],
      ['bush/0', bush(9, ['grass3', 'grass4', 'leaf2'])], ['campfire/0', campfire(0)], ['campfire/1', campfire(1)], ['campfire/2', campfire(2)],
    ],
    mountain: [
      ['pine-snow/0', treePine(5, true)], ['pine-snow/1', treePine(6, true)], ['spire/0', rockSpire(1)], ['spire/1', rockSpire(2)],
      ['boulder/0', rock(10, 1.2)], ['boulder/1', rock(11, 0.9)], ['rock-small', rock(12, 0.6)], ['crystal', crystal()], ['bones', bones()],
      ['dead-tree', deadTree()], ['tent-small', tentSmall('crimson')], ['campfire/0', campfire(0)], ['campfire/1', campfire(1)], ['campfire/2', campfire(2)],
    ],
  }[id];
  return props.map(([name, f]) => ({ name, ...f }));
}

export const PROP_ANIMATIONS = {
  torch: { frames: ['torch/0', 'torch/1', 'torch/2'], durationsMs: [140, 120, 160] },
  campfire: { frames: ['campfire/0', 'campfire/1', 'campfire/2'], durationsMs: [130, 150, 120] },
};
