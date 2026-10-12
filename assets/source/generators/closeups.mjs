// Close-up battle backdrops (reference panel A's side-on fight view): the arena, and one per
// expedition for encounter replays. Each is a 320x128 painting drawn at an integer 3x scale behind
// two fighters who stand on the floor at `CLOSEUP.groundY`, either side of the centre.
// The middle (where fighters stand) is kept calm so the fighters stay readable.
import { Mask, PixelCanvas } from '../tools/canvas.mjs';
import { createRandom, hashSeed } from '../tools/random.mjs';

export const CLOSEUP = { width: 320, height: 128, groundY: 104, fighterX: [142, 178], scale: 3 };
export const CLOSEUP_THEMES = ['arena', 'woodland', 'outpost', 'mountain'];

const W = CLOSEUP.width;
const H = CLOSEUP.height;
const CX = W / 2;
const shade = PixelCanvas.shade;

/** Cheap deterministic per-pixel noise in [0, 1). */
function noise(seed) {
  return (x, y) => {
    let h = (Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663) ^ seed) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
}
/** Smooth 1-D value noise for wobbly silhouettes. */
function wobble(seed, period) {
  const r = createRandom(seed);
  const pts = Array.from({ length: Math.ceil(W / period) + 2 }, () => r.next() * 2 - 1);
  return x => {
    const i = Math.floor(x / period);
    const f = x / period - i;
    const t = f * f * (3 - 2 * f);
    return pts[i] * (1 - t) + pts[i + 1] * t;
  };
}
/** The far boundary (wall base, tree line) curves up towards the centre, like the inside of a ring. */
const arc = (x, centre, edge) => Math.round(centre + (edge - centre) * ((x - CX) / CX) ** 2);
const fill = (c, fn) => { for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) { const v = fn(x, y); if (v) c.set(x, y, v); } };

// ------------------------------------------------------------------ floors
/** Floor painter: a base material with dithered light and dark patches and sparse marks. */
function floor(c, top, { base, light, dark, deep, marks = [], seed }) {
  const n = noise(seed);
  const patch = wobble(seed + 1, 9);
  for (let x = 0; x < W; x += 1) {
    for (let y = top(x); y < H; y += 1) {
      const d = y - top(x);
      const v = n(x, y);
      const p = patch(x + y * 3);
      let col = base;
      if (d < 2) col = deep;
      else if (d < 5) col = v < 0.55 ? dark : base;
      else if (p > 0.45 && v < 0.5) col = light;
      else if (p < -0.5 && v < 0.4) col = dark;
      else if (v < 0.03) col = dark;
      else if (v > 0.985) col = light;
      c.set(x, y, col);
    }
  }
  const r = createRandom(seed + 2);
  for (const [col, count, len] of marks) {
    for (let i = 0; i < count; i += 1) {
      const x = r.int(2, W - 6);
      const y = r.int(top(x) + 6, H - 2);
      for (let k = 0; k < len; k += 1) c.set(x + k, y, col);
    }
  }
}
function pebbles(c, top, seed, colours, count) {
  const r = createRandom(seed);
  for (let i = 0; i < count; i += 1) {
    const x = r.int(4, W - 5);
    const y = r.int(top(x) + 8, H - 3);
    if (Math.abs(x - CX) < 40 && Math.abs(y - CLOSEUP.groundY) < 5) continue; // keep the fighters' feet clear
    const big = r.chance(0.3);
    c.set(x, y, colours[0]);
    if (big) { c.set(x + 1, y, colours[1]); c.set(x, y + 1, colours[2]); c.set(x + 1, y + 1, colours[2]); }
    else c.set(x, y + 1, colours[2]);
  }
}

// ------------------------------------------------------------------ arena
const CLOTHS = [['teal2', 'teal3'], ['crimson2', 'crimson3'], ['gold2', 'gold3'], ['violet1', 'violet2'], ['water2', 'water3'], ['grass2', 'grass3'], ['canvas2', 'canvas3'], ['leather1', 'leather2']];
const SKINS = ['skin1', 'skin2', 'skin3', 'dskin1', 'dskin2'];
const HAIRS = ['wood3', 'wood4', 'outline', 'gold3', 'leather3', 'gray2'];

function spectator(c, x, base, r, far) {
  const [cloth, clothDark] = r.pick(CLOTHS);
  const skin = r.pick(SKINS);
  const m = () => new Mask(W, H);
  const body = m().rect(x - 2, base - 5, 5, 5).add(x - 2, base - 6).add(x + 2, base - 6);
  c.stamp(body, (px, py) => (far || px >= x + 2 || py >= base - 2 ? clothDark : cloth));
  c.stamp(m().rect(x - 1, base - 9, 3, 3), skin);
  const hair = r.pick(HAIRS);
  if (r.chance(0.75)) { c.set(x - 1, base - 10, hair); c.set(x, base - 10, hair); c.set(x + 1, base - 10, hair); }
  // Some cheer with a raised arm.
  if (r.chance(0.28)) { const side = r.chance(0.5) ? -3 : 3; c.set(x + side, base - 7, skin); c.set(x + side, base - 8, skin); c.set(x + side, base - 9, skin); c.set(x + side, base - 10, 'outline'); }
}

function banner(c, x, top, colours) {
  const [light, mid, dark] = colours;
  const m = new Mask(W, H).polygon([[x - 6, top], [x + 7, top], [x + 7, top + 17], [x + 0.5, top + 13], [x - 6, top + 17]]);
  c.stamp(m, (px, py) => (px === x - 6 || py === top ? light : px >= x + 5 ? dark : mid));
  // A gold shield emblem with crossed blades.
  c.stamp(new Mask(W, H).ellipse(x + 0.5, top + 6.5, 3.2, 3.4), shade('gold1', 'gold2', 'gold3'));
  c.set(x, top + 6, 'outline'); c.set(x + 1, top + 7, 'outline');
  // Hanging rod with finials.
  for (let k = -7; k <= 8; k += 1) c.set(x + k, top - 1, 'wood3');
  c.set(x - 8, top - 1, 'gold2'); c.set(x + 9, top - 1, 'gold2');
}

function brazier(c, x, y) {
  const m = () => new Mask(W, H);
  c.stamp(m().rect(x - 1, y - 6, 3, 6), shade('stone2', 'stone3', 'stone4'));
  c.stamp(m().polygon([[x - 5, y - 9], [x + 6, y - 9], [x + 3, y - 5], [x - 2, y - 5]]), shade('steel2', 'steel3', 'steel4'));
  c.stamp(m().polygon([[x - 4, y - 9], [x - 1, y - 16], [x + 1, y - 12], [x + 2, y - 17], [x + 5, y - 9]]), (px, py) => (py > y - 11 ? 'fire3' : py > y - 14 ? 'fire2' : 'fire1'), 'fire4');
}

/** The editor's box behind the fighters: a dark, calm recess between gold-capped pillars. */
function royalBox(c, top) {
  const left = 122;
  const right = 198;
  const m = () => new Mask(W, H);
  const roof = 9;
  for (let x = left; x <= right; x += 1) {
    for (let y = roof; y < top(x) - 6; y += 1) c.set(x, y, (x + y) % 9 === 0 && y > 18 ? 'stone5' : 'shadow');
  }
  // Crimson drape swags under a gold pelmet.
  for (let x = left; x <= right; x += 1) {
    const sag = Math.round(3 * Math.sin((((x - left) % 19) / 19) * Math.PI));
    for (let y = roof; y <= roof + 4 + sag; y += 1) c.set(x, y, y === roof ? 'gold2' : y === roof + 4 + sag ? 'crimson3' : (x - left) % 19 === 0 ? 'crimson3' : 'crimson2');
    c.set(x, roof + 5 + sag, 'gold3');
  }
  // A gold laurel emblem on the back wall.
  c.stamp(m().ellipse(CX, 25, 6, 5.5), shade('gold1', 'gold2', 'gold3'));
  c.stamp(m().ellipse(CX, 25, 3, 2.7), 'crimson2');
  for (const side of [-1, 1]) for (let k = 0; k < 5; k += 1) c.set(CX + side * (8 + k), 22 + k, k % 2 ? 'grass2' : 'grass3');
  // Pillars and the balustrade in front of the box.
  for (const px of [left - 3, right - 2]) {
    c.stamp(m().rect(px, roof - 1, 6, top(px) - roof - 4), (x, y, mk) => (y <= roof + 1 ? 'gold2' : shade('stone1', 'stone2', 'stone3')(x, y, mk)));
  }
  for (let x = left; x <= right; x += 1) {
    const t = top(x);
    for (let y = t - 6; y < t; y += 1) {
      const local = y - (t - 6);
      c.set(x, y, local === 0 ? 'outline' : local === 1 ? 'gold2' : local === 5 ? 'stone4' : (x - left) % 6 === 0 ? 'stone3' : (x - left) % 6 === 5 ? 'stone4' : 'stone1');
    }
  }
}

function renderArena() {
  const c = new PixelCanvas(W, H);
  const base = x => arc(x, 78, 90);
  const top = x => base(x) - 22;
  // Stands: dark stepped seating behind the crowd, under a striped awning.
  fill(c, (x, y) => {
    if (y > top(x)) return null;
    const step = (top(x) - y) % 11;
    return step === 0 ? 'stone3' : step === 1 ? 'stone4' : 'stone5';
  });
  const r = createRandom(hashSeed('closeup-arena-crowd'));
  for (let row = 0; row < 6; row += 1) {
    for (let x = 3 + (row % 2) * 3; x < W - 2; x += 6 + (r.chance(0.2) ? 1 : 0)) {
      const b = top(x) - 1 - row * 11;
      if (b - 10 < 7) continue;
      if (r.chance(0.08)) continue; // an empty seat now and then
      spectator(c, x + r.int(-1, 1), b, r, row >= 3);
    }
  }
  royalBox(c, top);
  // Awning: alternating canvas and crimson panels with scalloped edges.
  for (let x = 0; x < W; x += 1) {
    const panel = Math.floor(x / 16) % 2 === 0 ? ['canvas1', 'canvas2'] : ['crimson2', 'crimson3'];
    const depth = 6 + Math.round(2 * Math.sin(((x % 16) / 16) * Math.PI));
    for (let y = 0; y < depth; y += 1) c.set(x, y, y === 0 ? 'wood3' : y === depth - 1 ? 'outline' : x % 16 === 0 ? panel[1] : panel[0]);
  }
  // The podium wall: staggered stone blocks following the arc, a gold-trimmed coping and a dark plinth.
  for (let x = 0; x < W; x += 1) {
    for (let y = top(x); y <= base(x); y += 1) {
      const local = y - top(x);
      let col;
      if (local === 0) col = 'outline';
      else if (local <= 2) col = local === 1 ? 'stone1' : 'stone2';
      else if (local === 3) col = 'gold2';
      else if (local === 4) col = 'stone4';
      else if (local >= 20) col = local === 22 ? 'outline' : 'stone4';
      else {
        const row = Math.floor((local - 5) / 5);
        const ry = (local - 5) % 5;
        const bx = (x + (row % 2) * 7) % 14;
        col = ry === 4 || bx === 13 ? 'stone4' : ry === 0 || bx === 0 ? 'stone1' : bx > 10 || ry === 3 ? 'stone3' : 'stone2';
      }
      c.set(x, y, col);
    }
  }
  // Banners away from the middle, alternating team colours; braziers between them.
  const TEAL = ['teal1', 'teal2', 'teal3'];
  const CRIMSON = ['crimson1', 'crimson2', 'crimson3'];
  for (const [x, colours] of [[30, CRIMSON], [82, TEAL], [238, TEAL], [290, CRIMSON]]) banner(c, x, top(x) + 6, colours);
  for (const x of [56, 112, 208, 264]) brazier(c, x, top(x));
  // Sand floor with raked lines and a faint fighting circle.
  floor(c, x => base(x) + 1, { base: 'sand2', light: 'sand1', dark: 'sand3', deep: 'sand4', seed: hashSeed('closeup-arena-sand'), marks: [['sand3', 40, 3], ['sand1', 30, 2]] });
  const ring = new Mask(W, H).ellipse(CX, CLOSEUP.groundY + 2, 96, 13);
  ring.subtract(new Mask(W, H).ellipse(CX, CLOSEUP.groundY + 2, 95, 12)).forEach((x, y) => { if ((x >> 2) % 2 === 0) c.set(x, y, 'sand3'); });
  pebbles(c, x => base(x) + 1, hashSeed('closeup-arena-pebbles'), ['stone2', 'stone3', 'sand4'], 26);
  return c;
}

// ------------------------------------------------------------------ expeditions
function sky(c, horizon, colours = ['sky1', 'water1']) {
  fill(c, (x, y) => (y < horizon ? (y < horizon * 0.45 ? colours[0] : (x + y) % 2 === 0 && y < horizon * 0.6 ? colours[0] : colours[1]) : null));
}
function cloud(c, x, y, w) {
  const m = new Mask(W, H).ellipse(x, y, w, 3).ellipse(x - w * 0.4, y + 1, w * 0.5, 2.5).ellipse(x + w * 0.45, y + 1, w * 0.45, 2.4);
  c.paint(m, (px, py) => (py > y + 1 ? 'snow2' : 'white'));
}

function renderWoodland() {
  const c = new PixelCanvas(W, H);
  const base = x => arc(x, 82, 90);
  sky(c, 70);
  cloud(c, 48, 10, 12); cloud(c, 250, 7, 15);
  // Distant hills, then a dense tree line whose canopy follows the arc.
  const hill = wobble(hashSeed('wood-hill'), 40);
  fill(c, (x, y) => (y >= 40 + Math.round(hill(x) * 6) && y <= base(x) ? 'leaf3' : null));
  const r = createRandom(hashSeed('closeup-woodland'));
  const m = () => new Mask(W, H);
  for (let x = -6; x < W + 10; x += 11 + r.int(0, 6)) {
    if (Math.abs(x - CX) < 34) continue; // a clearing behind the fighters
    const b = base(x);
    const trunk = m().rect(x - 2, b - 30, 5, 31);
    c.stamp(trunk, (px) => (px === x - 2 ? 'wood2' : px >= x + 2 ? 'wood4' : 'wood3'));
    const canopy = m();
    for (let k = 0; k < 5; k += 1) canopy.ellipse(x + r.int(-8, 8), b - 34 + r.int(-10, 4), r.int(8, 12), r.int(6, 9));
    c.stamp(canopy, (px, py, mk) => { const v = shade('grass3', 'leaf1', 'leaf2', { depth: 2 })(px, py, mk); return v === 'leaf1' && (px * 5 + py * 3) % 13 === 0 ? 'leaf2' : v; });
  }
  // Shrubs at the forest edge.
  for (let x = 2; x < W; x += 9 + r.int(0, 5)) {
    const b = base(x);
    c.stamp(m().ellipse(x, b - 2, r.int(5, 8), r.int(3, 5)), shade('grass2', 'grass3', 'grass4'));
    if (r.chance(0.35)) c.set(x + r.int(-3, 3), b - 4, r.pick(['crimson1', 'gold1', 'white']));
  }
  // Grass floor with a trodden dirt clearing where the fight happens.
  floor(c, x => base(x) + 1, { base: 'grass2', light: 'grass1', dark: 'grass3', deep: 'grass4', seed: hashSeed('closeup-woodland-grass'), marks: [['grass3', 60, 2], ['grass1', 40, 1]] });
  const n = noise(hashSeed('closeup-woodland-dirt'));
  const clearing = m().ellipse(CX, CLOSEUP.groundY + 3, 92, 13);
  clearing.forEach((x, y) => {
    const v = n(x, y);
    const edge = !clearing.has(x, y - 2) || !clearing.has(x - 3, y) || !clearing.has(x + 3, y);
    c.set(x, y, edge ? (v < 0.5 ? 'grass3' : 'sand4') : v < 0.12 ? 'sand4' : v > 0.9 ? 'sand2' : 'sand3');
  });
  pebbles(c, x => base(x) + 1, hashSeed('closeup-woodland-flowers'), ['gold1', 'crimson1', 'grass3'], 30);
  return c;
}

function renderOutpost() {
  const c = new PixelCanvas(W, H);
  const base = x => arc(x, 82, 90);
  sky(c, 74, ['sky1', 'canvas1']);
  cloud(c, 90, 9, 10); cloud(c, 230, 14, 13);
  // Ruined stone wall with a broken top, patched by a timber palisade.
  const broken = wobble(hashSeed('outpost-ruin'), 13);
  const r = createRandom(hashSeed('closeup-outpost'));
  for (let x = 0; x < W; x += 1) {
    const b = base(x);
    const palisade = (x > 96 && x < 124) || x > 268;
    const height = palisade ? 30 : 18 + Math.round(broken(x) * 9) + (Math.abs(x - CX) < 40 ? -2 : 4);
    for (let y = b - height; y <= b; y += 1) {
      const local = y - (b - height);
      if (palisade) {
        const stake = x % 6;
        const tip = local < 3 && Math.abs(stake - 2.5) > local;
        if (tip) continue;
        c.set(x, y, local === 0 || stake === 0 ? 'outline' : stake === 1 ? 'wood1' : stake >= 4 ? 'wood3' : 'wood2');
        continue;
      }
      const row = Math.floor(y / 5);
      const bx = (x + (row % 2) * 6) % 12;
      c.set(x, y, local === 0 ? 'outline' : y % 5 === 4 || bx === 11 ? 'stone4' : local <= 1 ? 'stone1' : bx === 0 ? 'stone2' : bx > 8 ? 'stone4' : 'stone3');
    }
  }
  // A torn raider banner on a pole, a weapon rack and scattered crates near the walls.
  const m = () => new Mask(W, H);
  for (const px of [44, 276]) {
    const b = base(px);
    c.stamp(m().rect(px, b - 44, 2, 44), shade('wood2', 'wood3', 'wood4'));
    c.stamp(m().polygon([[px + 2, b - 43], [px + 16, b - 41], [px + 13, b - 36], [px + 17, b - 31], [px + 2, b - 29]]), shade('crimson1', 'crimson2', 'crimson3'));
    c.stamp(m().ellipse(px + 8, b - 36, 2.5, 2.5), 'canvas1');
  }
  for (const [x, w] of [[66, 12], [214, 10], [236, 8]]) {
    const b = base(x) + 2;
    c.stamp(m().rect(x, b - w, w, w), (px, py) => (py === b - w || px === x ? 'wood1' : px === x + w - 1 || py === b - 1 ? 'wood3' : (px - x) % 4 === 0 ? 'wood3' : 'wood2'));
  }
  floor(c, x => base(x) + 1, { base: 'sand3', light: 'sand2', dark: 'sand4', deep: 'stone4', seed: hashSeed('closeup-outpost-dirt'), marks: [['sand4', 50, 3], ['leather2', 20, 2]] });
  pebbles(c, x => base(x) + 1, hashSeed('closeup-outpost-stones'), ['stone2', 'stone3', 'stone4'], 40);
  void r;
  return c;
}

function renderMountain() {
  const c = new PixelCanvas(W, H);
  const base = x => arc(x, 80, 88);
  sky(c, 60, ['sky1', 'snow2']);
  cloud(c, 60, 12, 14); cloud(c, 270, 8, 10);
  // Far peaks with snow caps.
  const peaks = [[30, 18], [92, 8], [150, 22], [210, 6], [282, 14]];
  const ridge = x => Math.min(...peaks.map(([px, py]) => py + Math.abs(x - px) * 0.9));
  fill(c, (x, y) => {
    const h = ridge(x);
    if (y < h || y >= base(x)) return null;
    return y < h + 5 ? (y < h + 3 ? 'snow1' : 'snow2') : (x + Math.floor(y / 3)) % 7 === 0 ? 'stone3' : 'stone2';
  });
  // The near cliff wall: dark rock with snowy ledges, following the arc.
  const ledge = wobble(hashSeed('mountain-cliff'), 11);
  const strata = wobble(hashSeed('mountain-strata'), 23);
  const cracks = createRandom(hashSeed('closeup-mountain-cracks'));
  const crackXs = Array.from({ length: 14 }, () => cracks.int(0, W - 1));
  for (let x = 0; x < W; x += 1) {
    const b = base(x);
    const height = 26 + Math.round(ledge(x) * 7) + (Math.abs(x - CX) < 40 ? -6 : 0);
    for (let y = b - height; y <= b; y += 1) {
      const local = y - (b - height);
      // Broad tilted rock bands with snow on a few ledges and the odd dark crack.
      const band = Math.floor((y + strata(x) * 3 + x * 0.08) / 5);
      const crack = crackXs.some(cx => Math.abs(x - cx - Math.round((y - b) * 0.2)) === 0) && local > 4;
      c.set(x, y, local === 0 ? 'outline' : local <= 2 ? 'snow1' : local === 3 ? 'snow3'
        : crack ? 'stone5' : band % 4 === 0 && (y + band) % 5 === 0 ? 'snow2' : band % 2 === 0 ? 'stone4' : 'stone3');
    }
  }
  floor(c, x => base(x) + 1, { base: 'snow1', light: 'white', dark: 'snow2', deep: 'snow3', seed: hashSeed('closeup-mountain-snow'), marks: [['snow2', 60, 3], ['snow3', 20, 2]] });
  // Rock outcrops poking through the snow, away from the fighters.
  const m = () => new Mask(W, H);
  for (const [x, y, w] of [[24, 114, 9], [70, 100, 6], [252, 98, 7], [298, 118, 10], [110, 122, 5]]) {
    c.stamp(m().polygon([[x - w, y], [x - w * 0.4, y - w * 0.8], [x + w * 0.5, y - w * 0.6], [x + w, y]]), (px, py, mk) => (!mk.has(px, py - 1) ? 'snow1' : shade('stone2', 'stone3', 'stone4')(px, py, mk)));
  }
  pebbles(c, x => base(x) + 1, hashSeed('closeup-mountain-pebbles'), ['stone3', 'stone2', 'snow3'], 24);
  return c;
}

const RENDER = { arena: renderArena, woodland: renderWoodland, outpost: renderOutpost, mountain: renderMountain };

/** Atlas frames, one per theme, anchored at the floor centre where the fighters stand. */
export function renderCloseups() {
  return CLOSEUP_THEMES.map(theme => ({ name: theme, canvas: RENDER[theme](), anchorX: CX, anchorY: CLOSEUP.groundY }));
}
