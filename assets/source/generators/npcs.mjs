// Six ambient camp NPCs (two merchants, trainer, cook, healer, gate guard), fully composed per frame.
import { flatten, renderLayers } from './rig.mjs';
import { NPC_ACTIONS } from './poses.mjs';
import { RAMP, SKIN, apron, beard, body, cap, cape, hair, heavyArmor, held, helmet, hood, kilt, robe, tool, tunic, weapon } from './outfits.mjs';

export const NPCS = [
  {
    id: 'smith', name: 'Brutus the Smith', role: 'merchant-weapons',
    layers: [body(SKIN.dark), kilt(RAMP.leather, 0.6), apron(RAMP.leather), beard(RAMP.grayHair), tool('hammer')],
  },
  {
    id: 'armorer', name: 'Livia the Armorer', role: 'merchant-armor',
    layers: [body(SKIN.light), robe(RAMP.crimson), hair(RAMP.brownHair, 'long')],
  },
  {
    id: 'trainer', name: 'Doctore Cassius', role: 'trainer',
    layers: [body(SKIN.tan), tunic(RAMP.crimson, { skirt: 0.6, sleeves: 0.5 }), beard(RAMP.grayHair), tool('staff')],
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
    layers: [cape(RAMP.crimson), body(SKIN.tan), kilt(RAMP.crimson), heavyArmor(), helmet(RAMP.gold), weapon('spear')],
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
