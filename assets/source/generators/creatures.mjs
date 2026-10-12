// Expedition enemies: woodland dire wolf (quadruped), outpost raider and mountain troll (humanoid rig).
import { Mask, PixelCanvas } from '../tools/canvas.mjs';
import { FRAME, GROUND, clearBorder, flatten, renderLayers } from './rig.mjs';
import { CREATURE_ACTIONS, GLADIATOR_ACTIONS } from './poses.mjs';
import { RAMP, SKIN, body, hood, kilt, lightArmor, shield, tool, trollFeatures, weapon } from './outfits.mjs';

export const CREATURES = [
  { id: 'dire-wolf', name: 'Dire Wolf', expedition: 'woodland' },
  { id: 'raider', name: 'Outpost Raider', expedition: 'outpost' },
  { id: 'rock-troll', name: 'Rock Troll', expedition: 'mountain' },
];

const HUMANOIDS = {
  raider: { scale: 1, layers: [body(SKIN.tan), kilt(RAMP.leather, 0.6), lightArmor(), hood(RAMP.crimson), weapon('axe'), shield(RAMP.wood, RAMP.steel, 0.85)] },
  'rock-troll': { scale: 1.3, pose: { offhand: 'none' }, layers: [body(SKIN.troll), kilt(RAMP.fur, 0.5), trollFeatures(), tool('club')] },
};

// ------------------------------------------------------------- wolf
const shade = PixelCanvas.shade;
const D2R = Math.PI / 180;
const WOLF_POSES = {
  idle: { durations: [300, 260, 300, 260], loop: true, frames: [
    { tail: 20 }, { tail: 30, breath: 1 }, { tail: 40, breath: 1 }, { tail: 28 },
  ] },
  walk: { durations: [100, 100, 100, 100, 100, 100], loop: true, frames: [0, 1, 2, 3, 4, 5].map(i => {
    const ph = (i / 6) * Math.PI * 2;
    return { legs: [Math.sin(ph) * 28, -Math.sin(ph) * 28, -Math.sin(ph) * 26, Math.sin(ph) * 26], bob: Math.abs(Math.cos(ph)) > 0.7 ? 0 : -1, tail: 35 + Math.sin(ph) * 8 };
  }) },
  attack: { durations: [110, 90, 130, 160], loop: false, frames: [
    { crouch: 2, head: [-1, 2], tail: 10, legs: [-10, -10, 10, 10] },
    { dx: 3, lift: 3, jaw: 1, legs: [40, 40, -40, -40], tail: 50 },
    { dx: 6, jaw: 1, head: [2, 1], legs: [30, 30, -20, -20], tail: 45 },
    { dx: 2, legs: [5, 5, -5, -5], tail: 25 },
  ] },
  hit: { durations: [120, 170], loop: false, frames: [
    { dx: -2, head: [-1, -2], hurt: true, tail: 60 }, { dx: -1, head: [0, -1], hurt: true, tail: 40 },
  ] },
  defend: { durations: [150, 220], loop: false, frames: [
    { crouch: 3, head: [0, 2], jaw: 1, tail: 0, legs: [-8, -8, 12, 12] }, { crouch: 4, head: [0, 3], jaw: 1, tail: -5, legs: [-10, -10, 14, 14] },
  ] },
  evade: { durations: [90, 110, 130], loop: false, frames: [
    { crouch: 2, tail: 20 }, { dx: -5, lift: 4, legs: [-30, -30, 30, 30], tail: 50 }, { dx: -3, crouch: 1, tail: 30 },
  ] },
  defeat: { durations: [160, 180, 180, 400], loop: false, frames: [
    { dx: -1, head: [-1, 1], hurt: true, crouch: 2, tail: 0 },
    { dx: -1, head: [0, 4], hurt: true, crouch: 5, tail: -10, legs: [30, 30, -30, -30] },
    { lying: 0.5, hurt: true, head: [0, 3] },
    { lying: 1, hurt: true, closed: true, head: [0, 4] },
  ] },
};

function drawWolf(pose) {
  const c = new PixelCanvas(FRAME, FRAME);
  const m = () => new Mask(FRAME, FRAME);
  const dx = pose.dx ?? 0;
  const crouch = pose.crouch ?? 0;
  const lift = pose.lift ?? 0;
  const lying = pose.lying ?? 0;
  const bob = pose.bob ?? 0;
  const breath = pose.breath ?? 0;
  const by = GROUND - 12 + crouch - lift + bob + lying * 6;
  const bx = 29 + dx;
  const legs = pose.legs ?? [0, 0, 0, 0];
  const legLen = 9 - crouch * 0.6 - lying * 4;
  const fur = shade('fur1', 'fur2', 'fur3');
  const furDark = shade('fur2', 'fur3', 'outline');
  const ta = (pose.tail ?? 25) * D2R;
  const tailBase = [bx - 9, by - 2];
  const tailMid = [tailBase[0] - Math.cos(ta) * 5, tailBase[1] - Math.sin(ta) * 5];
  const tailTip = [tailMid[0] - Math.cos(ta - 0.6) * 5, tailMid[1] - Math.sin(ta - 0.6) * 5 + 2];
  c.stamp(m().limb(...tailBase, ...tailMid, 3.6, 3.2).limb(...tailMid, ...tailTip, 3.2, 1.6), fur);
  const leg = (x0, ang, far) => {
    if (lying >= 1) return m().limb(x0, by + 2, x0 + 6, GROUND - 2, 3, 2.4);
    const knee = [x0 + Math.sin(ang * D2R) * legLen * 0.55, by + 3 + Math.cos(ang * D2R) * legLen * 0.55];
    const foot = [knee[0] + Math.sin(ang * 0.4 * D2R) * legLen * 0.5, Math.min(GROUND - 1 - (far ? 1 : 0), knee[1] + legLen * 0.5)];
    return m().limb(x0, by + 2, ...knee, 3.4, 2.8).limb(...knee, ...foot, 2.8, 2.4).ellipse(foot[0] + 1, foot[1] + 0.5, 1.8, 1.1);
  };
  c.stamp(leg(bx + 6, legs[1], true), furDark);
  c.stamp(leg(bx - 6, legs[3], true), furDark);
  c.stamp(m().ellipse(bx, by - breath * 0.5, 9.5, 5.5 + breath * 0.3).ellipse(bx + 5, by - 1, 5.5, 6), (x, y, mk) => {
    const v = fur(x, y, mk);
    return y > by + 3 && v !== 'fur1' ? 'gray1' : v;
  });
  c.stamp(leg(bx + 5, legs[0], false), fur);
  c.stamp(leg(bx - 7, legs[2], false), fur);
  const [hdx, hdy] = pose.head ?? [0, 0];
  const hx = bx + 11 + hdx + lying;
  const hy = by - 5 + hdy;
  c.stamp(m().polygon([[hx - 2, hy - 5], [hx - 0.5, hy - 9.5], [hx + 1.5, hy - 4]]), fur);
  c.stamp(m().ellipse(hx, hy, 4.6, 4.2), fur);
  const jaw = pose.jaw ? 2 : 0;
  c.stamp(m().polygon([[hx + 2, hy - 2], [hx + 9, hy + 0.5], [hx + 8.5, hy + 2], [hx + 2, hy + 3]]), fur);
  if (jaw) {
    c.stamp(m().polygon([[hx + 2, hy + 3], [hx + 8, hy + 3 + jaw], [hx + 7.5, hy + 4.5 + jaw], [hx + 1.5, hy + 4.5]]), shade('fur2', 'fur3', 'outline'));
    c.set(hx + 7, hy + 3, 'white'); c.set(hx + 5, hy + 3, 'white'); c.set(hx + 6, hy + 4, 'crimson2');
  }
  c.set(hx + 9, hy + 0.5, 'outline');
  c.stamp(m().polygon([[hx - 3.5, hy - 3], [hx - 2.5, hy - 9], [hx - 0.5, hy - 3.5]]), fur);
  c.set(hx - 2.2, hy - 6, 'crimson3');
  if (pose.closed) { c.set(hx + 1, hy - 1, 'outline'); c.set(hx + 2, hy - 1, 'outline'); }
  else if (pose.hurt) { c.set(hx + 1, hy - 1, 'outline'); c.set(hx + 2, hy - 2, 'outline'); }
  else { c.set(hx + 1.5, hy - 1.5, 'gold1'); c.set(hx + 1.5, hy - 0.5, 'outline'); }
  clearBorder(c);
  return c;
}

export function renderCreatures() {
  const frames = [];
  const animations = {};
  for (const creature of CREATURES) {
    for (const action of CREATURE_ACTIONS) {
      let def;
      let names;
      if (creature.id === 'dire-wolf') {
        def = WOLF_POSES[action];
        names = def.frames.map((pose, i) => {
          const name = `${creature.id}/${action}/se/${i}`;
          frames.push({ name, canvas: drawWolf(pose) });
          return name;
        });
      } else {
        const spec = HUMANOIDS[creature.id];
        def = GLADIATOR_ACTIONS[action];
        const painters = Object.fromEntries(spec.layers.map((p, i) => [`l${i}`, p]));
        names = def.frames.map((pose, i) => {
          const name = `${creature.id}/${action}/se/${i}`;
          frames.push({ name, canvas: flatten(renderLayers({ ...pose, ...spec.pose }, 'front', painters, { scale: spec.scale }), Object.keys(painters)) });
          return name;
        });
      }
      animations[`creature-${creature.id}/${action}/se`] = { atlas: 'creatures', frames: names, durationsMs: def.durations, loop: def.loop };
    }
  }
  return { frames, animations };
}
