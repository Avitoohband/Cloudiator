// Gladiator layered animation package: one reusable body plus aligned equipment layers.
import { renderLayers } from './rig.mjs';
import { GLADIATOR_ACTIONS } from './poses.mjs';
import { RAMP, SKIN, accent, body, chestWrap, heavyArmor, held, helmet, helmetCrest, hood, kilt, lightArmor, hair, shield, weapon, wristWraps } from './outfits.mjs';

/**
 * Runtime draw order (back to front). Depth inside a frame is resolved by slot clipping. A gladiator draws one body
 * (body, or body-female for a female body), its clothes (cloth or cloth-female) and at most one hair layer (hair is
 * short; hair-long, hair-ponytail; none when bald). Equipment is shared: the female layers stay inside the male masks.
 */
export const GLADIATOR_LAYERS = [
  { id: 'body', slot: 'body', tintable: true, tint: 'skin' },
  { id: 'body-female', slot: 'body', tintable: true, tint: 'skin' },
  { id: 'cloth', slot: 'cloth', tintable: true, tint: 'cloth' },
  { id: 'cloth-female', slot: 'cloth', tintable: true, tint: 'cloth' },
  { id: 'hair', slot: 'hair', tintable: true, tint: 'hair' },
  { id: 'hair-long', slot: 'hair', tintable: true, tint: 'hair' },
  { id: 'hair-ponytail', slot: 'hair', tintable: true, tint: 'hair' },
  { id: 'armor-light', slot: 'body-armor', tintable: false },
  { id: 'armor-heavy', slot: 'body-armor', tintable: false },
  { id: 'accent', slot: 'accent', tintable: true, tint: 'cloth' },
  { id: 'head-hood', slot: 'head', tintable: false },
  { id: 'head-helmet', slot: 'head', tintable: false },
  { id: 'head-helmet-crest', slot: 'head', tintable: true, tint: 'cloth' },
  { id: 'weapon-sword', slot: 'weapon', tintable: false },
  { id: 'weapon-axe', slot: 'weapon', tintable: false },
  { id: 'weapon-spear', slot: 'weapon', tintable: false },
  { id: 'weapon-bow', slot: 'weapon', tintable: false },
  { id: 'offhand-shield', slot: 'offhand', tintable: false },
  { id: 'held', slot: 'held', tintable: false },
];

export const PAINTERS = {
  body: body(SKIN.light),
  'body-female': body(SKIN.light, 'female'),
  cloth: ctx => { kilt(RAMP.gray)(ctx); wristWraps(RAMP.gray)(ctx); },
  'cloth-female': ctx => { chestWrap(RAMP.gray)(ctx); kilt(RAMP.gray)(ctx); },
  hair: hair(RAMP.gray, 'short'),
  'hair-long': hair(RAMP.gray, 'long'),
  'hair-ponytail': hair(RAMP.gray, 'ponytail'),
  'armor-light': lightArmor(),
  'armor-heavy': heavyArmor(),
  accent: accent(RAMP.gray),
  'head-hood': hood(RAMP.leather),
  'head-helmet': helmet(null),
  'head-helmet-crest': helmetCrest(RAMP.gray),
  'weapon-sword': weapon('sword'),
  'weapon-axe': weapon('axe'),
  'weapon-spear': weapon('spear'),
  'weapon-bow': weapon('bow'),
  'offhand-shield': shield(RAMP.teal, RAMP.gold),
  held: held(),
};

const VIEW_DIR = { front: 'se', back: 'ne' };

/** @returns {{ frames: { name: string, canvas: import('../tools/canvas.mjs').PixelCanvas }[], animations: Record<string, object> }} */
export function renderGladiator() {
  const frames = [];
  const animations = {};
  for (const [action, def] of Object.entries(GLADIATOR_ACTIONS)) {
    for (const view of def.views) {
      const dir = VIEW_DIR[view];
      const names = [];
      def.frames.forEach((pose, i) => {
        const layers = renderLayers(pose, view, PAINTERS);
        for (const layer of GLADIATOR_LAYERS) frames.push({ name: `${layer.id}/${action}/${dir}/${i}`, canvas: layers[layer.id] });
        names.push(`body/${action}/${dir}/${i}`);
      });
      animations[`gladiator/${action}/${dir}`] = { atlas: 'gladiators', frames: names, durationsMs: def.durations, loop: def.loop };
    }
  }
  return { frames, animations };
}
