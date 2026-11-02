// Ambient camp NPC looks, fully composed per frame: today's six (two merchants, trainer, cook, healer, gate guard) and patch
// 1.5.1's five (the night watch, water carrier, herald, porter and forester). Several guards share the Gate Guard's look
// (src/game/npcs.ts names each round's look). New looks go at the end, so earlier looks keep their atlas cells.
import { flatten, renderLayers } from './rig.mjs';
import { NPC_ACTIONS } from './poses.mjs';
import { RAMP, SKIN, apron, beard, body, cap, cape, hair, headband, heavyArmor, held, helmet, hood, kilt, robe, shoulderCrate, tool, tunic, weapon } from './outfits.mjs';

/** The herald's gold cape: wide, long and flared; seen from the front behind his tunic, from behind over its back. */
const HERALD_CAPE = { spread: 3.5, flare: 8, drape: 12 };
const HERALD_CAPE_FRONT = { ...HERALD_CAPE, view: 'front' };
const HERALD_CAPE_BACK = { ...HERALD_CAPE, view: 'back' };
const guardLayers = () => [cape(RAMP.crimson), body(SKIN.tan), kilt(RAMP.crimson), heavyArmor(), helmet(RAMP.gold), weapon('spear')];

export const NPCS = [
  {
    id: 'smith', name: 'Brutus the Smith', role: 'merchant-weapons',
    layers: [body(SKIN.dark), kilt(RAMP.leather, 0.6), apron(RAMP.leather), beard(RAMP.grayHair), cap(RAMP.leather), tool('hammer')],
  },
  {
    id: 'armorer', name: 'Livia the Armorer', role: 'merchant-armor',
    layers: [body(SKIN.light), robe(RAMP.crimson), hair(RAMP.brownHair, 'long')],
  },
  {
    id: 'trainer', name: 'Doctore Cassius', role: 'trainer',
    layers: [body(SKIN.tan), tunic(RAMP.crimson, { skirt: 0.6, sleeves: 0.5 }), hair(RAMP.blackHair, 'short'), beard(RAMP.grayHair), headband(RAMP.gold), tool('staff')],
  },
  {
    id: 'cook', name: 'Old Marta', role: 'cook',
    layers: [body(SKIN.light), tunic(RAMP.teal, { skirt: 0.95, sleeves: 0.6 }), apron(RAMP.canvas), cap(RAMP.canvas), tool('ladle')],
  },
  {
    id: 'healer', name: 'Sister Iona', role: 'healer', pose: { held: 'jug', weapon: 'none' },
    layers: [body(SKIN.dark), robe(RAMP.leaf), hood(RAMP.leaf), held()],
  },
  {
    id: 'guard', name: 'Gate Guard', role: 'guard',
    layers: guardLayers(),
  },
  // Patch 1.5.1 (camp-expansion proposal, Patch 1).
  {
    // The wall patrols in the evening: the Gate Guard with a lit torch in hand and the spear on his back.
    id: 'night-watch', name: 'Night Watch', role: 'guard', pose: { weapon: 'stowed', held: 'torch' },
    layers: [...guardLayers(), held()],
  },
  {
    // Carries the healer's water jug.
    id: 'water-carrier', name: 'Petra the Water Carrier', role: 'water-carrier', pose: { held: 'jug', weapon: 'none' },
    layers: [body(SKIN.tan, 'female'), tunic(RAMP.water, { skirt: 0.9, sleeves: 0.5 }), hair(RAMP.blackHair, 'bun'), held()],
  },
  {
    // The trainer's staff and a gold cape.
    id: 'herald', name: 'Felix the Herald', role: 'herald',
    layers: [cape(RAMP.gold, HERALD_CAPE_FRONT), body(SKIN.light), tunic(RAMP.violet, { skirt: 0.8, sleeves: 0.6 }), cape(RAMP.gold, HERALD_CAPE_BACK), hair(RAMP.brownHair, 'short'), tool('staff')],
  },
  {
    // The one new part: a crate on the shoulder, steadied by the far hand.
    id: 'porter', name: 'Quintus the Porter', role: 'porter', pose: { weapon: 'none', farArm: [60, 100] },
    layers: [shoulderCrate(), body(SKIN.dark), tunic(RAMP.canvas, { skirt: 0.6, sleeves: 0.3 }), hair(RAMP.blackHair, 'short'), headband(RAMP.crimson)],
  },
  {
    // The gladiators' axe.
    id: 'forester', name: 'Silva the Forester', role: 'forester',
    layers: [body(SKIN.light, 'female'), tunic(RAMP.leaf, { skirt: 0.75, sleeves: 0.9 }), hair(RAMP.brownHair, 'ponytail'), weapon('axe')],
  },
];

const VIEW_DIR = { front: 'se', back: 'ne' };

export function renderNpcs() {
  const frames = [];
  const animations = {};
  for (const npc of NPCS) {
    const painters = Object.fromEntries(npc.layers.map((painter, i) => [`l${i}`, painter]));
    const order = Object.keys(painters);
    for (const [action, def] of Object.entries(NPC_ACTIONS)) {
      for (const view of def.views) {
        const dir = VIEW_DIR[view];
        const names = def.frames.map((pose, i) => {
          const name = `${npc.id}/${action}/${dir}/${i}`;
          frames.push({ name, canvas: flatten(renderLayers({ offhand: 'none', ...pose, ...npc.pose }, view, painters), order) });
          return name;
        });
        animations[`npc-${npc.id}/${action}/${dir}`] = { atlas: 'npcs', frames: names, durationsMs: def.durations, loop: def.loop };
      }
    }
  }
  return { frames, animations };
}
