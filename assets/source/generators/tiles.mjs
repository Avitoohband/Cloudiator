// 64x32 isometric ground tiles. Each environment blends a base and a top material with
// corner-based autotiles (N=1, E=2, S=4, W=8 set when that corner is the top material).
// Boundary noise vanishes on tile edges, so neighbouring tiles always meet seamlessly.
import { PixelCanvas } from '../tools/canvas.mjs';
import { createRandom, hashSeed } from '../tools/random.mjs';

export const TILE_W = 64;
export const TILE_H = 32;

/** Inclusive x-range of diamond row y for a 64x32 tile whose north vertex is (32, 0). */
export function diamondRow(y) {
  const k = Math.min(y, TILE_H - 1 - y);
  return [31 - 2 * k, 32 + 2 * k];
}

/** Flat base colour plus sparse texture marks: [colour, chance, length] dashes run along the 2:1 iso axis. */
const MATERIALS = {
  grass: { base: 'grass2', marks: [['grass1', 0.05, 2], ['grass3', 0.05, 1], ['grass3', 0.012, 2]] },
  sand: { base: 'sand2', marks: [['sand1', 0.05, 2], ['sand3', 0.05, 1], ['sand3', 0.01, 3]] },
  forest: { base: 'grass3', marks: [['grass2', 0.05, 2], ['grass4', 0.05, 1], ['leaf1', 0.02, 2]] },
  dirt: { base: 'sand3', marks: [['sand2', 0.05, 2], ['sand4', 0.06, 1], ['wood3', 0.01, 2]] },
  dry: { base: 'sand3', marks: [['sand2', 0.04, 2], ['sand4', 0.05, 1], ['sand4', 0.015, 4]] },
  flagstone: null,
  rock: { base: 'stone2', marks: [['stone1', 0.04, 2], ['stone3', 0.05, 1], ['stone3', 0.015, 3]] },
  snow: { base: 'snow1', marks: [['white', 0.05, 2], ['snow2', 0.04, 1], ['snow2', 0.01, 3]] },
};

const EDGE = { sand: 'sand3', grass: 'grass3', forest: 'grass4', dirt: 'sand4', flagstone: 'stone4', dry: 'sand4', rock: 'stone4', snow: 'snow2' };

export const TILESETS = {
  camp: { base: 'grass', top: 'sand' },
  woodland: { base: 'forest', top: 'dirt' },
  outpost: { base: 'dry', top: 'flagstone' },
  mountain: { base: 'rock', top: 'snow' },
};

function flagstone(x, y) {
  // Iso-aligned slabs, two per tile edge, with offset rows; mortar lines in stone4.
  const u = ((x + 0.5 - 32) / 32 + (y + 0.5) / 16) / 2;
  const v = ((y + 0.5) / 16 - (x + 0.5 - 32) / 32) / 2;
  const su = u * 2;
  const row = Math.floor(su);
  const sv = v * 2 + (row % 2) * 0.5;
  const fu = su - row;
  const fv = sv - Math.floor(sv);
  if (fu < 0.08 || fv < 0.07) return 'stone4';
  if (fu > 0.9 || fv > 0.92) return 'stone3';
  return (row + Math.floor(sv)) % 3 === 0 ? 'stone1' : 'stone2';
}

function valueNoise(seed) {
  const grid = new Map();
  const r = createRandom(seed);
  const at = (i, j) => { const k = `${i},${j}`; if (!grid.has(k)) grid.set(k, r.next() * 2 - 1); return grid.get(k); };
  return (x, y) => {
    const gx = x / 6;
    const gy = y / 4;
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const fx = gx - i;
    const fy = gy - j;
    const top = at(i, j) * (1 - fx) + at(i + 1, j) * fx;
    const bot = at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx;
    return top * (1 - fy) + bot * fy;
  };
}

/** Paint one autotile. mask bits: N=1, E=2, S=4, W=8 (corner uses the top material). */
export function renderTile(setId, mask, variant) {
  const { base, top } = TILESETS[setId];
  const c = new PixelCanvas(TILE_W, TILE_H);
  const rand = createRandom(hashSeed(`${setId}/${mask}/${variant}`));
  const noise = valueNoise(hashSeed(`${setId}/noise/${mask}/${variant}`));
  const corner = bit => ((mask & bit) ? 1 : 0);
  const isTop = new Uint8Array(TILE_W * TILE_H);
  for (let y = 0; y < TILE_H; y += 1) {
    const [x0, x1] = diamondRow(y);
    for (let x = x0; x <= x1; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const u = Math.min(1, Math.max(0, ((px - 32) / 32 + py / 16) / 2));
      const v = Math.min(1, Math.max(0, (py / 16 - (px - 32) / 32) / 2));
      const w = corner(1) * (1 - u) * (1 - v) + corner(2) * u * (1 - v) + corner(4) * u * v + corner(8) * (1 - u) * v;
      const n = Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * noise(x, y) * 0.55;
      isTop[y * TILE_W + x] = mask === 15 || (mask !== 0 && w + n > 0.5) ? 1 : 0;
    }
  }
  const paintMat = (mat, x, y) => (mat === 'flagstone' ? flagstone(x, y) : MATERIALS[mat].base);
  for (let y = 0; y < TILE_H; y += 1) {
    const [x0, x1] = diamondRow(y);
    for (let x = x0; x <= x1; x += 1) {
      const topHere = isTop[y * TILE_W + x] === 1;
      const inRow = (xx, yy) => yy >= 0 && yy < TILE_H && xx >= diamondRow(yy)[0] && xx <= diamondRow(yy)[1];
      const neighbourBase = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => inRow(x + dx, y + dy) && !isTop[(y + dy) * TILE_W + x + dx]);
      if (topHere) c.set(x, y, neighbourBase ? EDGE[top] : paintMat(top, x, y));
      else c.set(x, y, paintMat(base, x, y));
    }
  }
  // Sparse texture marks: short dashes along the iso axis (2px across, 1px down).
  const matAt = (x, y) => (isTop[y * TILE_W + x] ? top : base);
  const inside = (x, y) => y >= 0 && y < TILE_H && x >= diamondRow(y)[0] && x <= diamondRow(y)[1];
  for (let y = 0; y < TILE_H; y += 1) {
    const [x0, x1] = diamondRow(y);
    for (let x = x0; x <= x1; x += 1) {
      const mat = matAt(x, y);
      if (mat === 'flagstone') continue;
      const roll = rand.next();
      let acc = 0;
      for (const [colour, chance, length] of MATERIALS[mat].marks) {
        acc += chance;
        if (roll < acc) {
          for (let k = 0; k < length; k += 1) {
            const xx = x + k;
            if (inside(xx, y) && matAt(xx, y) === mat && c.get(xx, y) === MATERIALS[mat].base) c.set(xx, y, colour);
          }
          break;
        }
      }
    }
  }
  // A few larger details: grass tufts, flowers, pebbles, cracks.
  const details = rand.int(1, 3);
  for (let i = 0; i < details; i += 1) {
    const y = rand.int(7, TILE_H - 8);
    const [x0, x1] = diamondRow(y);
    const x = rand.int(x0 + 8, x1 - 8);
    const mat = matAt(x, y);
    if (mat === 'grass' || mat === 'forest') {
      const hi = mat === 'grass' ? 'grass1' : 'grass2';
      const lo = mat === 'grass' ? 'grass3' : 'grass4';
      c.set(x, y - 1, hi); c.set(x - 1, y, hi); c.set(x + 1, y, hi); c.set(x - 2, y + 1, lo); c.set(x, y + 1, lo); c.set(x + 2, y + 1, lo);
      if (rand.chance(0.25)) c.set(x + 3, y - 1, rand.pick(['fire2', 'white', 'violet1']));
    } else if (mat === 'sand' || mat === 'dirt' || mat === 'dry') {
      c.set(x, y, 'stone2'); c.set(x + 1, y, 'stone2'); c.set(x, y + 1, 'stone3'); c.set(x + 1, y + 1, 'stone4');
    } else if (mat === 'rock') {
      c.set(x, y, 'stone4'); c.set(x + 1, y, 'stone4'); c.set(x + 2, y + 1, 'stone4'); c.set(x + 3, y + 1, 'stone3');
    } else if (mat === 'snow') {
      c.set(x, y, 'snow2'); c.set(x + 1, y, 'snow3');
    }
  }
  return c;
}

export const TILE_VARIANTS = 2;
export const PURE_VARIANTS = 4;

/** All tiles of a set: 16 masks x variants (pure base/top tiles get extra variety). */
export function renderTileset(setId) {
  const frames = [];
  for (let mask = 0; mask < 16; mask += 1) {
    const count = mask === 0 || mask === 15 ? PURE_VARIANTS : TILE_VARIANTS;
    for (let v = 0; v < count; v += 1) frames.push({ name: `${setId}/${mask}/${v}`, canvas: renderTile(setId, mask, v), anchorX: 32, anchorY: 0 });
  }
  return frames;
}

export function tileVariants(mask) {
  return mask === 0 || mask === 15 ? PURE_VARIANTS : TILE_VARIANTS;
}
