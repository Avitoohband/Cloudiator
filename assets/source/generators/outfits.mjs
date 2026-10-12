// Layer painters for the humanoid rig. Each painter registers parts on depth slots;
// the rig clips every part by the body slots in front of it, so separately rendered
// layers composite correctly in a fixed runtime order.
import { Mask, PixelCanvas } from '../tools/canvas.mjs';
import { DIMS, FRAME, GROUND, add, lerp, dirVec, limbShapes, torsoPolygon } from './rig.mjs';

const shade = PixelCanvas.shade;
const m = () => new Mask(FRAME, FRAME);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (v, k) => [v[0] * k, v[1] * k];
const norm = v => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

export const SKIN = {
  light: { hi: 'skin1', mid: 'skin2', lo: 'skin3', deep: 'skin4' },
  tan: { hi: 'skin2', mid: 'skin3', lo: 'skin4', deep: 'dskin3' },
  dark: { hi: 'dskin1', mid: 'dskin2', lo: 'dskin3', deep: 'outline' },
  troll: { hi: 'troll1', mid: 'troll2', lo: 'troll3', deep: 'outline' },
  stone: { hi: 'snow2', mid: 'stone1', lo: 'stone2', deep: 'stone4' },
};
export const RAMP = {
  gray: { hi: 'white', mid: 'gray1', lo: 'gray2', deep: 'gray3' },
  teal: { hi: 'teal1', mid: 'teal2', lo: 'teal3', deep: 'teal4' },
  crimson: { hi: 'crimson1', mid: 'crimson2', lo: 'crimson3', deep: 'crimson4' },
  leather: { hi: 'leather1', mid: 'leather2', lo: 'leather3', deep: 'wood4' },
  canvas: { hi: 'canvas1', mid: 'canvas2', lo: 'canvas3', deep: 'sand4' },
  leaf: { hi: 'grass2', mid: 'leaf1', lo: 'leaf2', deep: 'leaf3' },
  fur: { hi: 'fur1', mid: 'fur2', lo: 'fur3', deep: 'outline' },
  steel: { hi: 'steel1', mid: 'steel2', lo: 'steel3', deep: 'steel4' },
  wood: { hi: 'wood1', mid: 'wood2', lo: 'wood3', deep: 'wood4' },
  gold: { hi: 'gold1', mid: 'gold2', lo: 'gold3', deep: 'wood4' },
  stone: { hi: 'stone1', mid: 'stone2', lo: 'stone3', deep: 'stone4' },
  violet: { hi: 'violet1', mid: 'violet2', lo: 'teal4', deep: 'outline' },
  brownHair: { hi: 'wood2', mid: 'wood3', lo: 'wood4', deep: 'outline' },
  blackHair: { hi: 'gray4', mid: 'shadow', lo: 'outline', deep: 'outline' },
  grayHair: { hi: 'gray1', mid: 'gray2', lo: 'gray3', deep: 'gray4' },
};
const lit = r => shade(r.hi, r.mid, r.lo);
const dim = r => shade(r.mid, r.lo, r.deep);

/** Helpers bound to one frame's skeleton. */
function frameTools(ctx) {
  const { p, pose, scale: sc } = ctx;
  const r = (pose.rotate ?? 0) * Math.PI / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const rot = ([x, y]) => [x * cos - y * sin, x * sin + y * cos];
  const unrot = ([x, y]) => [x * cos + y * sin, -x * sin + y * cos];
  /** absolute point from a head-local upright offset in unscaled pixels */
  const H = (dx, dy) => add(p.head, rot([dx * sc, dy * sc]));
  /** head-local upright coordinates of a pixel centre */
  const headLocal = (x, y) => { const [lx, ly] = unrot([x + 0.5 - p.head[0], y + 0.5 - p.head[1]]); return [lx / sc, ly / sc]; };
  const hv = norm(sub(p.farHip, p.nearHip)); // along hips, near -> far
  const up = norm(sub(p.neck, p.hip));
  const torsoLen = Math.hypot(...sub(p.hip, p.neck));
  /** distance down the torso axis from the neck */
  const torsoT = (x, y) => dot(sub([x + 0.5, y + 0.5], p.neck), mul(up, -1));
  const regionMask = (bounds, test) => {
    const out = m();
    for (let y = 0; y < FRAME; y += 1) for (let x = 0; x < FRAME; x += 1) if (bounds.has(x, y) && test(x, y)) out.add(x, y);
    return out;
  };
  const headBox = (rx, ry) => m().ellipse(p.head[0], p.head[1], (Math.max(rx, ry) + 2) * sc, (Math.max(rx, ry) + 2) * sc);
  const segment = (a, b, t0, t1) => [lerp(a, b, t0), lerp(a, b, t1)];
  return { rot, unrot, H, headLocal, hv, up, torsoLen, torsoT, regionMask, headBox, segment, sc };
}

const limbMask = (a, b, t0, t1) => m().limb(a[0], a[1], b[0], b[1], t0, t1);

// ---------------------------------------------------------------- body
export function body(skin = SKIN.light) {
  return ctx => {
    const { p, view, part, pose } = ctx;
    const T = frameTools(ctx);
    const sc = T.sc;
    const L = limbShapes(ctx);
    part('farLeg', c => {
      c.stamp(L.farLeg, dim(skin));
      c.stamp(L.farFoot, shade('leather2', 'leather3', 'wood4'));
    });
    part('nearLeg', c => {
      c.stamp(L.nearLeg, lit(skin));
      c.stamp(L.nearFoot, shade('leather1', 'leather2', 'leather3'));
    });
    part('farArm', c => c.stamp(L.farArm, dim(skin)));
    part('nearArm', c => c.stamp(L.nearArm, lit(skin)));
    part('torso', c => {
      c.stamp(L.neck, lit(skin));
      const torso = L.torso;
      c.stamp(torso, view === 'front' ? lit(skin) : shade(skin.mid, skin.mid, skin.lo));
      if (!pose.rotate) {
        if (view === 'front') {
          const chestY = Math.round(p.neck[1] + 5 * sc);
          const xs = [p.nearShoulder[0], p.farShoulder[0]].sort((a, b) => a - b);
          const mid = Math.round((xs[0] + xs[1]) / 2);
          for (let x = Math.round(xs[0]) + 1; x < Math.round(xs[1]); x += 1) if (x !== mid && torso.has(x, chestY)) c.set(x, chestY, skin.lo);
          const absY = Math.round(p.hip[1] - 4 * sc);
          if (torso.has(mid, absY)) c.set(mid, absY, skin.lo);
          if (torso.has(mid, absY - 2)) c.set(mid, absY - 2, skin.lo);
        } else {
          const midX = Math.round((p.neck[0] + p.hip[0]) / 2);
          for (let y = Math.round(p.neck[1] + 2); y < Math.round(p.hip[1] - 1); y += 1) if (torso.has(midX, y)) c.set(midX, y, skin.lo);
        }
      }
      // belt
      const a = add(p.nearHip, add(mul(T.hv, -1.6 * sc), mul(T.up, 1 * sc)));
      const b = add(p.farHip, add(mul(T.hv, 1.6 * sc), mul(T.up, 1 * sc)));
      c.stamp(m().line(a[0], a[1], b[0], b[1], 2), shade('leather1', 'leather2', 'leather3'));
      const buckle = lerp(a, b, view === 'front' ? 0.62 : 0.38);
      c.set(buckle[0], buckle[1], 'gold1');
    });
    part('head', c => {
      c.stamp(L.head, lit(skin));
      if (view === 'front') face(c, T, skin, pose.face);
      else { c.set(...T.H(DIMS.headRx - 0.8, 0.6), skin.lo); c.set(...T.H(-DIMS.headRx + 0.8, 0.6), skin.lo); }
    });
  };
}

function face(c, T, skin, state) {
  const P = (dx, dy) => T.H(dx, dy);
  c.set(...P(-1.8, 0.4), skin.lo); // ear
  c.set(...P(-1.8, 1.4), skin.lo);
  c.set(...P(5.5, 0.8), skin.lo); // nose
  if (state === 'closed') {
    c.set(...P(2.4, 0), skin.deep); c.set(...P(3.4, 0), skin.deep);
  } else if (state === 'hurt' || state === 'strain') {
    c.set(...P(2.4, 0), 'outline'); c.set(...P(3.4, 0), 'outline'); c.set(...P(2.4, -2), skin.deep);
  } else {
    c.set(...P(2.8, -1), 'outline'); c.set(...P(2.8, 0), 'outline'); c.set(...P(2.8, -2.2), skin.deep); c.set(...P(3.8, -2.2), skin.deep);
  }
  if (state === 'shout' || state === 'hurt') { c.set(...P(3.4, 3), 'outline'); c.set(...P(3.4, 3.9), 'outline'); }
  else if (state === 'strain') { c.set(...P(2.6, 3.3), skin.deep); c.set(...P(3.6, 3.3), skin.deep); }
  else c.set(...P(3.4, 3.3), skin.deep);
}

// ---------------------------------------------------------------- cloth
/** Kilt/loincloth with pleats; length is the fraction of the thigh covered. */
export function kilt(r = RAMP.gray, length = 0.55) {
  return ctx => ctx.part('torso', c => {
    const { p } = ctx;
    const T = frameTools(ctx);
    const sc = T.sc;
    const topN = add(p.nearHip, add(mul(T.hv, -1.6 * sc), mul(T.up, -0.2 * sc)));
    const topF = add(p.farHip, add(mul(T.hv, 1.6 * sc), mul(T.up, -0.2 * sc)));
    const botF = add(lerp(p.farHip, p.farKnee, length), mul(T.hv, 2 * sc));
    const botN = add(lerp(p.nearHip, p.nearKnee, length), mul(T.hv, -2 * sc));
    const flap = lerp(p.hip, lerp(p.nearKnee, p.farKnee, 0.5), length + 0.15);
    const mask = m().polygon([topN, topF, botF, flap, botN]);
    c.stamp(mask, (x, y, mk) => {
      const base = lit(r)(x, y, mk);
      if (base !== r.mid) return base;
      const along = Math.floor(dot(sub([x, y], p.hip), T.hv) + 20);
      return along % 3 === 0 ? r.lo : r.mid;
    });
  });
}

export function wristWraps(r = RAMP.gray) {
  return ctx => {
    const { p, part } = ctx;
    const sc = frameTools(ctx).sc;
    for (const [slot, el, hand] of [['nearArm', p.nearElbow, p.nearHand], ['farArm', p.farElbow, p.farHand]]) {
      const [a, b] = [lerp(el, hand, 0.55), lerp(el, hand, 0.82)];
      part(slot, c => c.stamp(limbMask(a, b, 3.2 * sc, 3 * sc), slot === 'nearArm' ? lit(r) : dim(r)));
    }
  };
}

// ---------------------------------------------------------------- hair
export function hair(r = RAMP.gray, style = 'short') {
  return ctx => ctx.part('head', c => {
    const { view } = ctx;
    const T = frameTools(ctx);
    const mask = T.regionMask(T.headBox(6, 6), (x, y) => {
      const [lx, ly] = T.headLocal(x, y);
      const ry = style === 'long' ? 6.7 : 6.4;
      if ((lx / 6.1) ** 2 + (ly / ry) ** 2 > 1) {
        if (style === 'long' && ly > 0 && ly < 8.5 && (view === 'back' ? Math.abs(lx) < 6 : lx < -1.5 && lx > -6.8)) return true;
        if (style === 'bun' && (lx + 4.6) ** 2 + (ly + 5.2) ** 2 < 6) return true;
        if (style === 'short' && lx < -4 && lx > -6.6 && ly > -2 && ly < 2.5) return true; // top tuft
        return false;
      }
      if (view === 'back') return ly < (style === 'long' ? 7 : 3.2);
      if (ly < -2.4 + Math.max(0, -lx - 2) * 0.5) return true;
      if (lx < -0.8 && ly < (style === 'long' ? 7 : 3)) return true;
      return lx < 0.4 && lx > -0.8 && ly < 1;
    });
    c.stamp(mask, (x, y, mk) => {
      const base = lit(r)(x, y, mk);
      if (base !== r.mid) return base;
      return (x * 3 + y * 5) % 7 === 0 ? r.lo : r.mid;
    });
  });
}

export function beard(r = RAMP.blackHair) {
  return ctx => ctx.part('head', c => {
    if (ctx.view !== 'front') return;
    const T = frameTools(ctx);
    const mask = T.regionMask(T.headBox(6, 6), (x, y) => {
      const [lx, ly] = T.headLocal(x, y);
      return (lx / 6) ** 2 + (ly / 7.4) ** 2 <= 1 && ly > 2.3 && lx > -1.4;
    });
    c.stamp(mask, lit(r));
    c.set(...T.H(3.3, 3.3), 'outline');
  });
}

// ---------------------------------------------------------------- armor
export function lightArmor() {
  return ctx => {
    const { p, part } = ctx;
    const T = frameTools(ctx);
    const sc = T.sc;
    part('torso', c => {
      const torso = m().polygon(torsoPolygon(ctx));
      const chest = T.regionMask(torso, (x, y) => { const t = T.torsoT(x, y); return t > 2.4 * sc && t < 8.4 * sc; });
      c.stamp(chest, (x, y, mk) => { const v = lit(RAMP.leather)(x, y, mk); return (x + y) % 5 === 0 && v === 'leather2' ? 'leather3' : v; });
      const strapA = lerp(p.nearShoulder, p.neck, 0.2);
      const strapB = lerp(p.farHip, p.hip, 0.1);
      c.paint(m().line(strapA[0], strapA[1], strapB[0], strapB[1], 1), 'leather3');
      const stud = lerp(strapA, strapB, 0.35);
      c.set(stud[0], stud[1], 'gold2');
    });
    part('nearArm', c => {
      c.stamp(m().ellipse(p.nearShoulder[0], p.nearShoulder[1] + 0.5, 2.7 * sc, 2.3 * sc), lit(RAMP.leather));
      const [a, b] = T.segment(p.nearElbow, p.nearHand, 0.3, 0.8);
      c.stamp(limbMask(a, b, 3.5 * sc, 3.3 * sc), lit(RAMP.leather));
    });
    part('farArm', c => { const [a, b] = T.segment(p.farElbow, p.farHand, 0.3, 0.8); c.stamp(limbMask(a, b, 3.5 * sc, 3.3 * sc), dim(RAMP.leather)); });
    for (const [slot, knee, ankle, ramp] of [['nearLeg', p.nearKnee, p.nearAnkle, lit], ['farLeg', p.farKnee, p.farAnkle, dim]]) {
      part(slot, c => {
        const [a, b] = T.segment(knee, ankle, 0.22, 0.8);
        const wrap = limbMask(a, b, 3.7 * sc, 3.4 * sc);
        c.stamp(wrap, (x, y, mk) => { const v = ramp(RAMP.leather)(x, y, mk); return (x + 2 * y) % 4 === 0 ? 'leather3' : v; });
      });
    }
  };
}

export function heavyArmor() {
  return ctx => {
    const { p, part } = ctx;
    const T = frameTools(ctx);
    const sc = T.sc;
    part('torso', c => {
      const torso = m().polygon(torsoPolygon(ctx)).dilate();
      const plate = T.regionMask(torso, (x, y) => { const t = T.torsoT(x, y); return t > 0.6 * sc && t < T.torsoLen + 0.6 * sc; });
      c.stamp(plate, (x, y, mk) => {
        const t = T.torsoT(x, y);
        if (t < 2 * sc) return 'gold2';
        const v = lit(RAMP.steel)(x, y, mk);
        if (v !== 'steel2') return v;
        return Math.round(t) % 4 === 0 ? 'steel3' : v;
      });
      // fauld: hanging plates over the hips
      const topN = add(p.nearHip, mul(T.hv, -2 * sc));
      const topF = add(p.farHip, mul(T.hv, 2 * sc));
      const botF = add(lerp(p.farHip, p.farKnee, 0.42), mul(T.hv, 1.8 * sc));
      const botN = add(lerp(p.nearHip, p.nearKnee, 0.42), mul(T.hv, -1.8 * sc));
      c.stamp(m().polygon([topN, topF, botF, botN]), (x, y, mk) => {
        const v = lit(RAMP.steel)(x, y, mk);
        return Math.floor(dot(sub([x, y], p.hip), T.hv) + 20) % 3 === 0 ? 'steel4' : v;
      });
    });
    for (const [slot, sh, el, hand, ramp] of [['nearArm', p.nearShoulder, p.nearElbow, p.nearHand, lit], ['farArm', p.farShoulder, p.farElbow, p.farHand, dim]]) {
      part(slot, c => {
        c.stamp(m().ellipse(sh[0], sh[1] + 2.4 * sc, 3.3 * sc, 2.4 * sc), ramp(RAMP.steel));
        c.stamp(m().ellipse(sh[0], sh[1] + 0.2 * sc, 3.8 * sc, 2.8 * sc), ramp(RAMP.steel));
        const [a, b] = T.segment(el, hand, 0.2, 0.9);
        c.stamp(limbMask(a, b, 3.9 * sc, 3.6 * sc), ramp(RAMP.steel));
        c.stamp(m().ellipse(hand[0], hand[1], 1.9 * sc, 1.9 * sc), shade('steel2', 'steel3', 'steel4'));
      });
    }
    for (const [slot, knee, ankle, ramp] of [['nearLeg', p.nearKnee, p.nearAnkle, lit], ['farLeg', p.farKnee, p.farAnkle, dim]]) {
      part(slot, c => {
        const [a, b] = T.segment(knee, ankle, 0.05, 0.9);
        c.stamp(limbMask(a, b, 4.2 * sc, 3.8 * sc), ramp(RAMP.steel));
        c.stamp(m().ellipse(knee[0], knee[1], 2.3 * sc, 2.1 * sc), ramp(RAMP.steel));
        c.stamp(m().ellipse(ankle[0] + 1.6 * sc, ankle[1] + 0.6 * sc, 2.3 * sc, 1.4 * sc), shade('steel2', 'steel3', 'steel4'));
      });
    }
  };
}

// ---------------------------------------------------------------- head gear
export function hood(r = RAMP.leather) {
  return ctx => ctx.part('head', c => {
    const { view } = ctx;
    const T = frameTools(ctx);
    const mask = T.regionMask(T.headBox(7, 8), (x, y) => {
      const [lx, ly] = T.headLocal(x, y);
      const inHood = ((lx + 0.3) / 6.8) ** 2 + ((ly + 0.2) / 6.9) ** 2 <= 1;
      const peak = view === 'back' ? (lx + 2.5) ** 2 + (ly + 6.4) ** 2 < 2.2 : (lx + 4.6) ** 2 + (ly + 5.4) ** 2 < 2.2;
      const cowl = ly > 3.5 && ly < 8.6 && Math.abs(lx + 0.5) < 6.6 - (ly - 3.5) * 0.15;
      if (!(inHood || peak || cowl)) return false;
      if (view === 'front' && ((lx - 3) / 3.6) ** 2 + ((ly - 0.8) / 4) ** 2 <= 1) return false;
      return true;
    });
    c.stamp(mask, lit(r));
  });
}

export function helmet(crest = RAMP.crimson) {
  return ctx => ctx.part('head', c => {
    const { view } = ctx;
    const T = frameTools(ctx);
    const dome = T.regionMask(T.headBox(7, 8), (x, y) => {
      const [lx, ly] = T.headLocal(x, y);
      if ((lx / 6.5) ** 2 + ((ly + 0.6) / 6.7) ** 2 <= 1 && ly < (view === 'back' ? 2.4 : 0.9)) return true;
      if (view === 'front' && lx > 0.8 && lx < 4.2 && ly >= 0.9 && ly < 4.6) return true; // cheek guard
      return lx < -2.8 && lx > -7.4 && ly >= -1 && ly < 3.6; // neck guard
    });
    c.stamp(dome, (x, y, mk) => {
      const [, ly] = T.headLocal(x, y);
      const v = lit(RAMP.steel)(x, y, mk);
      return Math.abs(ly - 0.6) < 0.55 && v === 'steel2' ? 'steel3' : v;
    });
    if (crest) c.stamp(m().curve(CREST_ARC.map(([x, y]) => T.H(x, y)), 2), lit(crest));
  });
}

const CREST_ARC = [[-5.8, -3], [-4.4, -7], [-1, -9], [2.4, -8.4], [4.8, -5.8]];
/** Helmet crest on its own layer so the runtime can tint it with the player's colour. */
export function helmetCrest(r = RAMP.gray) {
  return ctx => ctx.part('head', c => {
    const T = frameTools(ctx);
    c.stamp(m().curve(CREST_ARC.map(([x, y]) => T.H(x, y)), 2), lit(r));
  });
}

/** Player-colour accent worn over any armour: a chest sash and a front flap below the belt. */
export function accent(r = RAMP.gray) {
  return ctx => {
    const { p, view } = ctx;
    const T = frameTools(ctx);
    const sc = T.sc;
    ctx.part('torso', c => {
      const a = lerp(p.nearShoulder, p.neck, 0.15);
      const b = add(lerp(p.farHip, p.hip, 0.35), mul(T.up, 1 * sc));
      c.stamp(m().line(a[0], a[1], b[0], b[1], 2), lit(r));
      if (view === 'front') {
        const top = add(lerp(p.nearHip, p.farHip, 0.5), mul(T.up, 0.6 * sc));
        const bot = lerp(top, lerp(p.nearKnee, p.farKnee, 0.5), 0.62);
        const w = mul(T.hv, 1.6 * sc);
        c.stamp(m().polygon([add(top, mul(w, -1)), add(top, w), add(bot, w), add(bot, [0, 1]), add(bot, mul(w, -1))]), lit(r));
      }
    });
  };
}

/** Cloth band around the head (NPC headwear). */
export function headband(r = RAMP.crimson) {
  return ctx => ctx.part('head', c => {
    const T = frameTools(ctx);
    const band = T.regionMask(T.headBox(7, 7), (x, y) => {
      const [lx, ly] = T.headLocal(x, y);
      return (lx / 6) ** 2 + ((ly + 0.3) / 6.4) ** 2 <= 1 && ly > -3.4 && ly < -1.8;
    });
    c.stamp(band, lit(r));
  });
}

// ---------------------------------------------------------------- weapons
const REACH = { sword: [-2.5, 15], axe: [-3, 14], spear: [-9, 24], club: [-2, 15], hammer: [-2, 11.5], ladle: [-1, 13], staff: [-10, 15.5] };
/** Slide a weapon along its own axis so both ends stay inside the frame (shafts slide freely, short weapons a little). */
function keepInFrame(g, d, kind) {
  const [back, front] = REACH[kind] ?? [0, 0];
  let lo = -Infinity;
  let hi = Infinity;
  for (const axis of [0, 1]) {
    if (Math.abs(d[axis]) < 1e-6) continue;
    for (const t of [back, front]) {
      const a = (2 - g[axis]) / d[axis] - t;
      const b = (FRAME - 3 - g[axis]) / d[axis] - t;
      lo = Math.max(lo, Math.min(a, b));
      hi = Math.min(hi, Math.max(a, b));
    }
  }
  if (lo > hi) return g;
  const limit = kind === 'spear' || kind === 'staff' ? Infinity : 4;
  const shift = Math.max(-limit, Math.min(limit, Math.min(hi, Math.max(lo, 0))));
  return add(g, mul(d, shift));
}

function drawBlade(c, g0, ang, kind) {
  const d = dirVec(ang, 1);
  const g = keepInFrame(g0, d, kind);
  const perp = [-d[1], d[0]];
  const at = t => add(g, mul(d, t));
  if (kind === 'sword') {
    c.stamp(m().line(...at(2.5), ...at(13.5), 2).add(...at(14.5)), shade('steel1', 'steel2', 'steel3'));
    const ga = add(at(2), mul(perp, 2.6));
    const gb = add(at(2), mul(perp, -2.6));
    c.stamp(m().line(...ga, ...gb, 1), 'gold2');
    c.stamp(m().ellipse(...at(-2), 1.1, 1.1), 'gold1');
    c.paint(m().line(...at(-1), ...at(1), 1), 'leather3');
  } else if (kind === 'axe') {
    c.stamp(m().line(...at(-3), ...at(13), 2), shade('wood1', 'wood2', 'wood3'));
    const head = m().polygon([at(8.5), add(at(8), mul(perp, 3.4)), add(at(10.8), mul(perp, 6.2)), add(at(13.6), mul(perp, 3.4)), at(13.2)]);
    c.stamp(head, (x, y, mk) => {
      const edge = !mk.has(x + Math.round(perp[0]), y + Math.round(perp[1]));
      return edge ? 'steel1' : shade('steel2', 'steel2', 'steel4')(x, y, mk);
    });
    c.stamp(m().polygon([at(10), add(at(10.5), mul(perp, -2.4)), at(11.6)]), 'steel3');
  } else if (kind === 'spear') {
    c.stamp(m().line(...at(-9), ...at(16), 2), shade('wood1', 'wood2', 'wood3'));
    c.stamp(m().polygon([add(at(16), mul(perp, 1.8)), at(23.5), add(at(16), mul(perp, -1.8)), at(15)]), shade('steel1', 'steel2', 'steel3'));
    c.set(...add(at(15), mul(perp, 1.6)), 'crimson2');
    c.set(...add(at(14), mul(perp, 1.8)), 'crimson2');
    c.set(...add(at(15), mul(perp, -1.6)), 'crimson3');
  } else if (kind === 'club') {
    c.stamp(m().limb(...at(-2), ...at(10), 2.4, 3.2), shade('wood1', 'wood2', 'wood3'));
    c.stamp(m().ellipse(...at(11.5), 3.4, 3.4), shade('wood2', 'wood3', 'wood4'));
    c.set(...add(at(12), mul(perp, 2.6)), 'stone3');
    c.set(...add(at(10.5), mul(perp, -2.4)), 'stone3');
  } else if (kind === 'hammer') {
    c.stamp(m().line(...at(-2), ...at(9), 1), 'wood2');
    c.stamp(m().polygon([add(at(8), mul(perp, -2.5)), add(at(8), mul(perp, 3)), add(at(11), mul(perp, 3)), add(at(11), mul(perp, -2.5))]), shade('stone2', 'stone3', 'stone4'));
  } else if (kind === 'ladle') {
    c.stamp(m().line(...at(-1), ...at(10), 1), 'wood1');
    c.stamp(m().ellipse(...add(at(11), mul(perp, 1)), 2, 1.6), shade('steel2', 'steel3', 'steel4'));
  } else if (kind === 'staff') {
    c.stamp(m().line(...at(-10), ...at(15), 2), shade('wood1', 'wood2', 'wood3'));
    c.set(...at(15), 'gold2');
  }
}

/** Bow along an axis (degrees, 180 = vertical) centred at the grip; drawFrom pulls the string. */
function drawBow(c, grip, axis, drawFrom, arrow) {
  const a = dirVec(axis, 1);
  const n = [-a[1], a[0]];
  const tipA = add(add(grip, mul(a, 10)), mul(n, -2.6));
  const tipB = add(add(grip, mul(a, -10)), mul(n, -2.6));
  const ctrl = add(grip, mul(n, 3.4));
  const pts = [];
  for (let i = 0; i <= 14; i += 1) {
    const t = i / 14;
    pts.push([(1 - t) ** 2 * tipA[0] + 2 * (1 - t) * t * ctrl[0] + t ** 2 * tipB[0], (1 - t) ** 2 * tipA[1] + 2 * (1 - t) * t * ctrl[1] + t ** 2 * tipB[1]]);
  }
  if (drawFrom) {
    c.paint(m().line(...tipA, ...drawFrom, 1), 'gray1');
    c.paint(m().line(...drawFrom, ...tipB, 1), 'gray1');
  } else {
    c.paint(m().line(...tipA, ...tipB, 1), 'gray1');
  }
  c.stamp(m().curve(pts, 2), shade('wood1', 'wood2', 'wood3'));
  c.set(...tipA, 'gold2');
  c.set(...tipB, 'gold2');
  c.paint(m().line(...add(grip, mul(a, 1.2)), ...add(grip, mul(a, -1.2)), 2), 'leather3');
  if (arrow) {
    const [from, dir] = arrow;
    const to = add(from, mul(dir, 15));
    c.paint(m().line(...from, ...to, 1), 'wood1');
    c.set(...to, 'steel1');
    c.set(...add(to, mul(dir, -1)), 'steel2');
    c.set(...add(from, [0, -1]), 'crimson2');
    c.set(...add(from, [0, 1]), 'crimson2');
  }
}

function stowedGrip(ctx, kind) {
  const { p, side } = ctx;
  if (kind === 'sword') return [add(p.nearShoulder, [side * 0.6, -3]), side < 0 ? 32 : -32];
  if (kind === 'axe') return [add(p.neck, [-side * 2.5, 5]), 196];
  if (kind === 'spear') return [add(p.neck, [-side * 1.5, 6]), 202];
  return [add(p.neck, [-side * 1.5, 5]), 205];
}

export function weapon(kind) {
  return ctx => {
    const { p, pose, part, view } = ctx;
    const mode = pose.weapon;
    if (mode === 'none') return;
    if (kind === 'bow') {
      if (mode === 'stowed') {
        const [g, axis] = stowedGrip(ctx, 'bow');
        part('back', c => drawBow(c, g, axis, null, null));
      } else if (mode === 'dropped') {
        part('back', c => drawBow(c, [48, GROUND - 2], 90, null, null));
      } else {
        const phase = pose.bow;
        const drawFrom = phase === 'nock' || phase === 'draw' ? p.nearHand : null;
        const arrow = drawFrom ? [p.nearHand, norm(sub(p.farHand, p.nearHand))] : null;
        part(view === 'front' ? 'shield' : 'farArm', c => drawBow(c, p.farHand, 180, drawFrom, arrow));
      }
      return;
    }
    if (mode === 'stowed') {
      const [g, ang] = stowedGrip(ctx, kind);
      part('back', c => drawBlade(c, g, ang, kind));
    } else if (mode === 'dropped') {
      part('back', c => drawBlade(c, kind === 'spear' ? [36, GROUND - 1] : [42, GROUND - 1], 90, kind));
    } else {
      part('weapon', c => drawBlade(c, p.nearHand, pose.weaponAngle, kind));
    }
  };
}

/** Tools carried by NPCs and creatures share the weapon slot. */
export const tool = kind => ctx => {
  const { p, pose, part } = ctx;
  if (pose.weapon === 'none' || pose.weapon === 'stowed') return;
  if (pose.weapon === 'dropped') { part('back', c => drawBlade(c, [42, GROUND - 1], 90, kind)); return; }
  part('weapon', c => drawBlade(c, p.nearHand, pose.weaponAngle, kind));
};

// ---------------------------------------------------------------- shield
export function shield(face = RAMP.teal, rim = RAMP.gold, size = 1) {
  return ctx => {
    const { p, pose, part, view } = ctx;
    const mode = pose.offhand;
    if (mode === 'none') return;
    const paintFace = (c, cx, cy, rx, ry) => {
      const inner = m().ellipse(cx, cy, rx - 1.3, ry - 1.3);
      c.stamp(m().ellipse(cx, cy, rx, ry), (x, y, mk) => (inner.has(x, y) ? lit(face)(x, y, inner) : lit(rim)(x, y, mk)));
      c.stamp(m().ellipse(cx + 0.4, cy, 1.4, 1.6), shade(rim.hi, rim.mid, rim.lo));
      for (const [dx, dy] of [[0, -3], [0, 3], [-2.2, 0], [2.4, 0]]) c.set(cx + dx * size, cy + dy * size, rim.lo);
    };
    const paintBack = (c, cx, cy, rx, ry) => {
      c.stamp(m().ellipse(cx, cy, rx, ry), (x, y, mk) => (mk.has(x - 1, y) && mk.has(x + 1, y) && mk.has(x, y - 1) && mk.has(x, y + 1) ? lit(RAMP.wood)(x, y, mk) : 'steel3'));
      c.paint(m().line(cx - rx + 1.5, cy, cx + rx - 1.5, cy, 1), 'leather3');
    };
    if (mode === 'back') {
      const cx = p.neck[0] - ctx.side * 0.5;
      const cy = p.neck[1] + 6;
      part('back', c => (view === 'back' ? paintFace(c, cx, cy, 4.6 * size, 6 * size) : paintBack(c, cx, cy, 4.6 * size, 6 * size)));
      return;
    }
    if (mode === 'dropped') {
      part('back', c => paintFace(c, 22, GROUND - 2.5, 5.5 * size, 2.6 * size));
      return;
    }
    const raised = mode === 'raised';
    const cx = p.farHand[0] + (raised ? 2 : 1.5);
    const cy = p.farHand[1] + (raised ? -2 : 0.5);
    const rx = (raised ? 5 : 4.6) * size;
    const ry = (raised ? 7.2 : 6.6) * size;
    part('shield', c => (view === 'front' ? paintFace(c, cx, cy, rx, ry) : paintBack(c, cx, cy, rx, ry)));
  };
}

// ---------------------------------------------------------------- held props
export function held() {
  return ctx => {
    const { p, pose, part } = ctx;
    if (pose.held === 'barbell') {
      part('held', c => {
        const mid = lerp(p.nearHand, p.farHand, 0.5);
        c.stamp(m().line(mid[0] - 11, mid[1], mid[0] + 11, mid[1], 1), 'steel3');
        for (const sx of [-1, 1]) {
          c.stamp(m().ellipse(mid[0] + sx * 9.5, mid[1], 1.6, 4.3), shade('stone2', 'stone4', 'stone5'));
          c.stamp(m().ellipse(mid[0] + sx * 7.6, mid[1], 1.2, 3.3), shade('stone2', 'stone3', 'stone4'));
        }
      });
    } else if (pose.held === 'bowl') {
      part('held', c => {
        const b = add(p.farHand, [1.5, -0.8]);
        c.stamp(m().ellipse(b[0], b[1], 3.6, 2.1), shade('wood1', 'wood2', 'wood3'));
        c.paint(m().ellipse(b[0], b[1] - 0.9, 2.4, 0.9), 'sand2');
        c.paint(m().line(p.nearHand[0], p.nearHand[1], p.nearHand[0] + 2, p.nearHand[1] - 2, 1), 'wood1');
      });
    } else if (pose.held === 'jug') {
      part('held', c => {
        const b = add(p.farHand, [1, 1.5]);
        c.stamp(m().ellipse(b[0], b[1], 2.6, 3.4), shade('sand2', 'sand3', 'sand4'));
        c.stamp(m().rect(b[0] - 1, b[1] - 5, 2, 2), 'sand3');
      });
    }
  };
}

// ---------------------------------------------------------------- NPC clothing
export function tunic(r, { skirt = 0.75, sleeves = 0.5 } = {}) {
  return ctx => {
    const { p, part } = ctx;
    const T = frameTools(ctx);
    const sc = T.sc;
    part('torso', c => {
      c.stamp(m().polygon(torsoPolygon(ctx)).dilate(), lit(r));
      const topN = add(p.nearHip, add(mul(T.hv, -2 * sc), mul(T.up, 1 * sc)));
      const topF = add(p.farHip, add(mul(T.hv, 2 * sc), mul(T.up, 1 * sc)));
      const botF = add(lerp(p.farHip, p.farKnee, skirt), mul(T.hv, 2.4 * sc));
      const botN = add(lerp(p.nearHip, p.nearKnee, skirt), mul(T.hv, -2.4 * sc));
      c.stamp(m().polygon([topN, topF, botF, botN]), lit(r));
      const a = add(p.nearHip, add(mul(T.hv, -2 * sc), mul(T.up, 1.2 * sc)));
      const b = add(p.farHip, add(mul(T.hv, 2 * sc), mul(T.up, 1.2 * sc)));
      c.paint(m().line(a[0], a[1], b[0], b[1], 1), 'leather3');
    });
    if (sleeves > 0) {
      for (const [slot, sh, el, hand, ramp] of [['nearArm', p.nearShoulder, p.nearElbow, p.nearHand, lit], ['farArm', p.farShoulder, p.farElbow, p.farHand, dim]]) {
        const end = sleeves <= 1 ? lerp(sh, el, sleeves * 1.6) : lerp(el, hand, sleeves - 1);
        part(slot, c => {
          c.stamp(limbMask(sh, sleeves <= 1 ? end : el, 4 * sc, 3.6 * sc), ramp(r));
          if (sleeves > 1) c.stamp(limbMask(el, end, 3.6 * sc, 3.4 * sc), ramp(r));
        });
      }
    }
  };
}

export function robe(r) {
  return ctx => {
    const { p } = ctx;
    const T = frameTools(ctx);
    const sc = T.sc;
    tunic(r, { skirt: 0.5, sleeves: 1.85 })(ctx);
    ctx.part('torso', c => {
      const topN = add(p.nearHip, mul(T.hv, -2.4 * sc));
      const topF = add(p.farHip, mul(T.hv, 2.4 * sc));
      const botF = add(p.farAnkle, mul(T.hv, 2.6 * sc));
      const botN = add(p.nearAnkle, mul(T.hv, -2.6 * sc));
      c.stamp(m().polygon([topN, topF, botF, add(botF, mul(T.up, -0.5)), add(botN, mul(T.up, -0.5)), botN]), (x, y, mk) => {
        const v = lit(r)(x, y, mk);
        return v === r.mid && Math.floor(dot(sub([x, y], p.hip), T.hv) + 20) % 4 === 0 ? r.lo : v;
      });
      const a = add(p.nearHip, add(mul(T.hv, -2.2 * sc), mul(T.up, 1 * sc)));
      const b = add(p.farHip, add(mul(T.hv, 2.2 * sc), mul(T.up, 1 * sc)));
      c.paint(m().line(a[0], a[1], b[0], b[1], 1), 'gold2');
    });
  };
}

export function apron(r) {
  return ctx => {
    if (ctx.view !== 'front') return;
    const { p } = ctx;
    ctx.part('torso', c => {
      const a = add(lerp(p.nearShoulder, p.farShoulder, 0.2), [0, 3]);
      const b = add(lerp(p.nearShoulder, p.farShoulder, 0.8), [0, 3]);
      const cc = add(lerp(p.farKnee, p.farHip, 0.15), [1.5, 0]);
      const d = add(lerp(p.nearKnee, p.nearHip, 0.15), [-1.5, 0]);
      c.stamp(m().polygon([a, b, cc, d]), lit(r));
    });
  };
}

export function cape(r) {
  return ctx => {
    const { p, side } = ctx;
    ctx.part('back', c => {
      const a = add(p.nearShoulder, [side * 1.5, -0.5]);
      const b = add(p.farShoulder, [-side * 1.5, -0.5]);
      const back = -1; // capes trail behind (screen-left) for right-facing frames
      const cc = add(lerp(p.farHip, p.farKnee, 0.9), [back * 3 - side * 2, 0]);
      const d = add(lerp(p.nearHip, p.nearKnee, 0.9), [back * 3 + side * 2, 0]);
      c.stamp(m().polygon([a, b, cc, d]), (x, y, mk) => { const v = dim(r)(x, y, mk); return (x % 3 === 0 && v === r.lo) ? r.deep : v; });
    });
  };
}

export function cap(r) {
  return ctx => ctx.part('head', c => {
    const T = frameTools(ctx);
    const mask = T.regionMask(T.headBox(7, 9), (x, y) => {
      const [lx, ly] = T.headLocal(x, y);
      return ((lx / 6.5) ** 2 + ((ly + 0.8) / 6.7) ** 2 <= 1 && ly < -2.2) || ((lx + 0.5) ** 2 / 24 + (ly + 8.4) ** 2 / 6.5 <= 1);
    });
    c.stamp(mask, lit(r));
  });
}

export function trollFeatures(skin = SKIN.troll) {
  return ctx => ctx.part('head', c => {
    const T = frameTools(ctx);
    const ear = ctx.view === 'front'
      ? [T.H(-3.6, -1.6), T.H(-8.2, -5.2), T.H(-3.2, 1.2)]
      : [T.H(4.2, -1.2), T.H(8.4, -4.8), T.H(4.4, 1.6)];
    c.stamp(m().polygon(ear), lit(skin));
    if (ctx.view === 'front') {
      c.set(...T.H(4, 2.6), 'white'); c.set(...T.H(2.7, 3), 'white');
      c.set(...T.H(2.8, -1), 'fire2');
      c.set(...T.H(1.8, -2.3), 'outline'); c.set(...T.H(2.8, -2.3), 'outline'); c.set(...T.H(3.8, -2.1), 'outline');
    }
  });
}
