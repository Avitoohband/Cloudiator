// Combat effects (48x48 frames, anchored at the centre) and 16x16 interface icons.
import { Mask, PixelCanvas } from '../tools/canvas.mjs';
import { createRandom } from '../tools/random.mjs';

const shade = PixelCanvas.shade;
const FX = 48;

function burst(c, cx, cy, rays, inner, outer, colours, rotation = 0) {
  const m = () => new Mask(c.width, c.height);
  const pts = [];
  for (let i = 0; i < rays * 2; i += 1) {
    const a = rotation + (i / (rays * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? outer : inner;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.85]);
  }
  c.stamp(m().polygon(pts), colours[0], colours[3] ?? 'outline');
  if (outer > 4) {
    const pts2 = pts.map(([x, y]) => [cx + (x - cx) * 0.6, cy + (y - cy) * 0.6]);
    c.paint(m().polygon(pts2), colours[1]);
    c.paint(m().ellipse(cx, cy, inner * 0.6, inner * 0.5), colours[2]);
  }
}

const EFFECTS = {
  hit: { durations: [50, 60, 70, 80], draw: (c, i) => {
    const s = [6, 11, 13, 9][i];
    if (i < 3) burst(c, 24, 24, 6, s * 0.45, s, ['fire2', 'fire1', 'white']);
    else { for (const [dx, dy] of [[-8, -6], [9, -4], [-6, 8], [7, 7]]) c.stamp(new Mask(FX, FX).ellipse(24 + dx, 24 + dy, 1.4, 1.4), 'fire2'); }
  } },
  critical: { durations: [50, 50, 70, 80, 90], draw: (c, i) => {
    const s = [8, 14, 18, 16, 10][i];
    burst(c, 24, 24, 8, s * 0.4, s, ['crimson2', 'fire3', 'fire1'], i * 0.2);
    if (i >= 1 && i <= 3) { const m = new Mask(FX, FX); c.stamp(m.rect(23, 15, 3, 9).rect(23, 26, 3, 3), 'white'); }
  } },
  defend: { durations: [60, 80, 100], draw: (c, i) => {
    const m = new Mask(FX, FX);
    const r = [9, 13, 15][i];
    const arc = [];
    for (let k = -4; k <= 4; k += 1) { const a = (k / 4) * 1.1; arc.push([24 + Math.cos(a) * r, 24 + Math.sin(a) * r * 1.1]); }
    c.stamp(m.curve(arc, i === 2 ? 1 : 2), i === 2 ? 'steel2' : 'water1');
    if (i < 2) for (const [dx, dy] of [[r + 2, -5], [r + 3, 4]]) c.set(24 + dx, 24 + dy, 'white');
  } },
  evade: { durations: [60, 80, 100], draw: (c, i) => {
    const m = new Mask(FX, FX);
    for (let k = 0; k < 3; k += 1) { const y = 18 + k * 6; const x0 = 10 + i * 4; c.paint(m.clone().line(x0, y, x0 + 14 - i * 3, y, 1), 'white'); }
    c.stamp(new Mask(FX, FX).ellipse(30 - i * 3, 36, 4 + i * 2, 2 + i), shade('sand1', 'sand2', 'sand3'));
  } },
  defeat: { durations: [120, 120, 120, 160], draw: (c, i) => {
    for (let k = 0; k < 3; k += 1) {
      const a = i * 0.9 + (k / 3) * Math.PI * 2;
      const x = 24 + Math.cos(a) * 10;
      const y = 16 + Math.sin(a) * 4 - i;
      burst(c, x, y, 5, 1.4, 3.4, ['gold2', 'gold1', 'gold1']);
    }
  } },
  victory: { durations: [120, 120, 120, 160], draw: (c, i) => {
    const r = createRandom(11 + i);
    for (let k = 0; k < 6; k += 1) {
      const x = 8 + r.int(0, 32);
      const y = 40 - ((k * 7 + i * 6) % 34);
      c.set(x, y, 'gold1'); c.set(x - 1, y, 'gold2'); c.set(x + 1, y, 'gold2'); c.set(x, y - 1, 'gold2'); c.set(x, y + 1, 'gold2');
    }
  } },
  dust: { durations: [70, 90, 110], draw: (c, i) => {
    const m = new Mask(FX, FX);
    m.ellipse(20 - i * 2, 40, 3 + i, 2 + i * 0.5).ellipse(28 + i * 2, 40, 3 + i, 2 + i * 0.5);
    c.stamp(m, i === 2 ? 'sand1' : shade('sand1', 'sand2', 'sand3'), i === 2 ? null : 'sand4');
  } },
  arrow: { durations: [100], draw: c => {
    const m = new Mask(FX, FX);
    c.paint(m.line(12, 24, 34, 24, 1), 'wood1');
    c.stamp(new Mask(FX, FX).polygon([[34, 22], [38, 24], [34, 26]]), 'steel2');
    c.set(12, 23, 'crimson2'); c.set(13, 23, 'crimson2'); c.set(12, 25, 'crimson2'); c.set(13, 25, 'crimson2');
  } },
};

export function renderEffects() {
  const frames = [];
  const animations = {};
  const effects = {};
  for (const [id, def] of Object.entries(EFFECTS)) {
    const names = def.durations.map((_, i) => {
      const c = new PixelCanvas(FX, FX);
      def.draw(c, i);
      for (let k = 0; k < FX; k += 1) { c.clearPixel(k, 0); c.clearPixel(k, FX - 1); c.clearPixel(0, k); c.clearPixel(FX - 1, k); }
      const name = `${id}/${i}`;
      frames.push({ name, canvas: c, anchorX: 24, anchorY: 24 });
      return name;
    });
    animations[`effect-${id}`] = { atlas: 'effects', frames: names, durationsMs: def.durations, loop: false };
    effects[id] = `effect-${id}`;
  }
  return { frames, animations, effects };
}

// ---------------------------------------------------------------- icons
const I = 16;
const icon = draw => { const c = new PixelCanvas(I, I); draw(c, () => new Mask(I, I)); return c; };
const coin = (c, m, x, y) => { c.stamp(m().ellipse(x, y, 3.2, 2.4), shade('gold1', 'gold2', 'gold3')); };
const sun = (c, m, x, y, r) => { c.stamp(m().ellipse(x, y, r, r), shade('fire1', 'fire2', 'fire3')); };

const ICONS = {
  money: (c, m) => { coin(c, m, 6, 11); coin(c, m, 10, 9); coin(c, m, 7, 6); },
  renown: (c, m) => { c.stamp(m().curve([[4, 13], [3, 9], [4, 5], [7, 3]], 2), shade('grass1', 'grass2', 'grass3')); c.stamp(m().curve([[11, 13], [12, 9], [11, 5], [8, 3]], 2), shade('grass1', 'grass2', 'grass3')); c.stamp(m().ellipse(7.5, 10, 2, 2), 'gold2'); },
  stamina: (c, m) => c.stamp(m().polygon([[9, 1], [3, 9], [7, 9], [5, 15], [12, 6], [8, 6], [10, 1]]), shade('fire1', 'fire2', 'fire3')),
  xp: (c, m) => c.stamp(m().polygon([[8, 1], [10, 6], [15, 6], [11, 9], [12.5, 14.5], [8, 11.5], [3.5, 14.5], [5, 9], [1, 6], [6, 6]]), shade('violet1', 'violet1', 'violet2')),
  level: (c, m) => { c.stamp(m().polygon([[3, 2], [13, 2], [13, 10], [8, 14], [3, 10]]), shade('teal1', 'teal2', 'teal3')); c.paint(m().polygon([[5, 9], [8, 5], [11, 9], [10, 10], [8, 8], [6, 10]]), 'gold1'); },
  hp: (c, m) => c.stamp(m().ellipse(5.5, 6, 3.2, 3).ellipse(10.5, 6, 3.2, 3).polygon([[2.5, 7], [13.5, 7], [8, 14]]), shade('crimson1', 'crimson2', 'crimson3')),
  training: (c, m) => { c.stamp(m().line(3, 8, 12, 8, 1), 'steel3'); for (const x of [3, 12]) c.stamp(m().rect(x - 1, 4, 3, 9), shade('stone2', 'stone4', 'stone5')); },
  rest: (c, m) => { c.stamp(m().ellipse(8, 8, 6, 6), shade('gold1', 'gold2', 'gold3')); c.erase(m().ellipse(11, 6, 5, 5)); c.outlineAll(); },
  expedition: (c, m) => { c.stamp(m().polygon([[2, 3], [6, 2], [10, 3], [14, 2], [14, 13], [10, 14], [6, 13], [2, 14]]), shade('canvas1', 'canvas2', 'canvas3')); c.paint(m().line(4, 11, 7, 8, 1).line(7, 8, 9, 9, 1).line(9, 9, 12, 5, 1), 'crimson2'); c.set(12, 5, 'crimson1'); },
  arena: (c, m) => { c.stamp(m().line(3, 3, 12, 12, 1), 'steel2'); c.stamp(m().line(12, 3, 3, 12, 1), 'steel2'); c.stamp(m().line(2, 10, 5, 13, 1).line(13, 10, 10, 13, 1), 'gold2'); },
  tournament: (c, m) => { c.stamp(m().polygon([[3, 2], [13, 2], [12, 7], [8, 10], [4, 7]]), shade('gold1', 'gold2', 'gold3')); c.stamp(m().rect(7, 10, 2, 3).rect(4, 13, 8, 2), 'gold3'); },
  market: (c, m) => { c.stamp(m().line(8, 2, 8, 13, 1).line(3, 4, 13, 4, 1), 'wood3'); c.stamp(m().ellipse(4, 9, 2.6, 1.4), 'gold2'); c.stamp(m().ellipse(12, 9, 2.6, 1.4), 'gold2'); c.stamp(m().rect(5, 13, 6, 2), 'wood2'); },
  schedule: (c, m) => { c.stamp(m().rect(2, 3, 12, 11), shade('white', 'canvas1', 'canvas3')); c.paint(m().rect(2, 3, 12, 3), 'crimson2'); for (const [x, y] of [[4, 8], [7, 8], [10, 8], [4, 11], [7, 11]]) c.set(x, y, 'gray3'); },
  clock: (c, m) => { c.stamp(m().ellipse(8, 8, 6.2, 6.2), shade('white', 'canvas1', 'canvas3')); c.paint(m().line(8, 8, 8, 4, 1).line(8, 8, 11, 9, 1), 'outline'); },
  inventory: (c, m) => { c.stamp(m().ellipse(8, 10, 6, 5), shade('leather1', 'leather2', 'leather3')); c.stamp(m().rect(6, 3, 4, 3), 'leather3'); c.set(8, 9, 'gold2'); },
  salvage: (c, m) => { c.stamp(m().ellipse(8, 8, 5.5, 5.5), shade('steel2', 'steel3', 'steel4')); c.erase(m().ellipse(8, 8, 2, 2)); for (const [x, y] of [[8, 1.5], [14.5, 8], [8, 14.5], [1.5, 8]]) c.stamp(m().rect(x - 1, y - 1, 2, 2), 'steel3'); },
  morning: (c, m) => { sun(c, m, 8, 11, 4); c.erase(m().rect(0, 12, 16, 4)); c.paint(m().line(1, 13, 14, 13, 1), 'sand3'); },
  afternoon: (c, m) => { sun(c, m, 8, 8, 4.5); for (const [x, y] of [[8, 1], [8, 15], [1, 8], [15, 8], [3, 3], [13, 3], [3, 13], [13, 13]]) c.set(x, y, 'fire2'); },
  evening: (c, m) => { c.stamp(m().ellipse(8, 8, 5.5, 5.5), shade('snow1', 'snow2', 'snow3')); c.erase(m().ellipse(10.5, 6, 4.5, 4.5)); c.outlineAll(); c.set(13, 12, 'gold1'); },
  sword: (c, m) => { c.stamp(m().line(4, 12, 13, 3, 2), shade('steel1', 'steel2', 'steel3')); c.stamp(m().line(2, 9, 7, 14, 1), 'gold2'); c.set(2, 14, 'leather3'); },
  axe: (c, m) => { c.stamp(m().line(3, 14, 11, 4, 1), 'wood2'); c.stamp(m().polygon([[9, 2], [14, 3], [14, 9], [10, 7]]), shade('steel1', 'steel2', 'steel3')); },
  spear: (c, m) => { c.stamp(m().line(2, 14, 11, 5, 1), 'wood2'); c.stamp(m().polygon([[10, 4], [14, 2], [12, 6]]), shade('steel1', 'steel2', 'steel3')); c.set(10, 7, 'crimson2'); },
  bow: (c, m) => { c.stamp(m().curve([[4, 2], [9, 4], [11, 8], [9, 12], [4, 14]], 2), shade('wood1', 'wood2', 'wood3')); c.paint(m().line(4, 3, 4, 13, 1), 'gray1'); },
  shield: (c, m) => { c.stamp(m().ellipse(8, 8, 6, 6.5), (x, y, mk) => (Math.hypot(x - 7.5, y - 7.5) > 4.6 ? 'gold2' : shade('teal1', 'teal2', 'teal3')(x, y, mk))); c.set(8, 8, 'gold1'); },
  'armor-light': (c, m) => { c.stamp(m().polygon([[3, 3], [6, 2], [10, 2], [13, 3], [12, 9], [11, 14], [5, 14], [4, 9]]), shade('leather1', 'leather2', 'leather3')); c.paint(m().line(5, 4, 11, 12, 1), 'leather3'); },
  'armor-heavy': (c, m) => { c.stamp(m().polygon([[2, 4], [6, 2], [10, 2], [14, 4], [13, 9], [12, 14], [4, 14], [3, 9]]), shade('steel1', 'steel2', 'steel3')); c.paint(m().line(4, 8, 12, 8, 1).line(4, 11, 12, 11, 1), 'steel4'); c.paint(m().line(6, 3, 10, 3, 1), 'gold2'); },
  hood: (c, m) => { c.stamp(m().ellipse(8, 8, 6, 6.5).polygon([[2, 9], [14, 9], [13, 15], [3, 15]]), shade('leather1', 'leather2', 'leather3')); c.paint(m().ellipse(9, 9, 3, 3.6), 'shadow'); },
  helmet: (c, m) => { c.stamp(m().ellipse(8, 9, 6, 6).rect(2, 9, 12, 5), shade('steel1', 'steel2', 'steel3')); c.paint(m().rect(5, 9, 6, 2), 'shadow'); c.stamp(m().curve([[3, 4], [6, 1.5], [10, 1.5], [13, 4]], 2), 'crimson2'); },
  'boots-light': (c, m) => c.stamp(m().polygon([[4, 2], [9, 2], [9, 10], [14, 11], [14, 14], [4, 14]]), shade('leather1', 'leather2', 'leather3')),
  'boots-heavy': (c, m) => c.stamp(m().polygon([[3, 2], [10, 2], [10, 9], [15, 10], [15, 14], [3, 14]]), shade('steel1', 'steel2', 'steel3')),
  berserker: (c, m) => { c.stamp(m().line(8, 2, 8, 14, 1), 'wood2'); c.stamp(m().polygon([[8, 3], [2, 2], [2, 9], [8, 7]]), shade('steel1', 'steel2', 'steel3')); c.stamp(m().polygon([[8, 3], [14, 2], [14, 9], [8, 7]]), shade('steel1', 'steel2', 'steel3')); },
  guardian: (c, m) => c.stamp(m().polygon([[2, 2], [14, 2], [13, 9], [8, 14], [3, 9]]), (x, y, mk) => (x === 8 || y === 6 ? 'gold2' : shade('crimson1', 'crimson2', 'crimson3')(x, y, mk))),
  duelist: (c, m) => { c.stamp(m().line(3, 13, 13, 3, 1), 'steel1'); c.stamp(m().ellipse(4, 12, 2.4, 2.4), 'gold2'); c.stamp(m().line(13, 13, 3, 3, 1), 'steel2'); },
  bronze: (c, m) => c.stamp(m().ellipse(8, 8, 6, 6), shade('leather1', 'leather2', 'leather3')),
  silver: (c, m) => c.stamp(m().ellipse(8, 8, 6, 6), shade('steel1', 'steel2', 'steel3')),
  gold: (c, m) => c.stamp(m().ellipse(8, 8, 6, 6), shade('gold1', 'gold2', 'gold3')),
  champion: (c, m) => { c.stamp(m().ellipse(8, 9, 6, 5.5), shade('violet1', 'violet1', 'violet2')); c.stamp(m().polygon([[3, 6], [5, 2], [8, 5], [11, 2], [13, 6]]), shade('gold1', 'gold2', 'gold3')); },
};

export function renderIcons() {
  const frames = Object.entries(ICONS).map(([name, draw]) => ({ name, canvas: icon(draw), anchorX: 8, anchorY: 8 }));
  return { frames, icons: Object.fromEntries(Object.keys(ICONS).map(n => [n, n])) };
}
