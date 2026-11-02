// Patch 1.5.1 review (2026-10-30): two of the new NPC looks must read at camp zoom. The porter's raised far arm ran under his
// chin to the crate, so at zoom 2-3 his face read as hair plus a brown band (Avi asked for it redrawn); the herald's gold cape
// showed as about 1 px, so he read close to the trainer.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../../assets/source/tools/png.mjs';
import { DIMS, skeleton } from '../../assets/source/generators/rig.mjs';
import { NPC_ACTIONS } from '../../assets/source/generators/poses.mjs';
import { NPCS } from '../../assets/source/generators/npcs.mjs';
import { loadAssetManifest } from '@/game/assets';

const manifest = loadAssetManifest();
const page = manifest.atlases.npcs;
const image = decodePng(readFileSync(join(__dirname, '..', '..', 'public', 'assets', page.image)));
const npc = (id: string) => NPCS.find((n: { id: string }) => n.id === id)!;
/** Every frame's pose of an NPC look as the generator draws it (src: assets/source/generators/npcs.mjs). */
const posesOf = (id: string, view: 'front' | 'back') => Object.entries(NPC_ACTIONS).flatMap(([action, def]) =>
  def.views.includes(view) ? def.frames.map((pose: object, i: number) => ({ name: `${id}/${action}/${view === 'front' ? 'se' : 'ne'}/${i}`, pose: { offhand: 'none', ...pose, ...npc(id).pose } })) : []);

describe('patch 1.5.1 NPC art at camp zoom', () => {
  it('keeps the porter\'s raised far arm beside his face: the upper arm drops from the shoulder, the hand holds the crate beyond the head', () => {
    const frames = posesOf('porter', 'front');
    expect(frames).toHaveLength(18);
    for (const { name, pose } of frames) {
      const { p } = skeleton(pose, 'front') as unknown as { p: Record<'head' | 'farShoulder' | 'farElbow' | 'farHand', [number, number]> };
      const beyondHead = p.head[0] + DIMS.headRx + 2;
      expect(p.farElbow[1], `${name}: elbow under the shoulder, not across the chin`).toBeGreaterThanOrEqual(p.farShoulder[1] + 2);
      expect(p.farElbow[0], `${name}: elbow beyond the head`).toBeGreaterThanOrEqual(beyondHead);
      expect(p.farHand[0], `${name}: hand beyond the head`).toBeGreaterThanOrEqual(beyondHead);
      expect(p.farHand[1], `${name}: hand up at the crate`).toBeLessThan(p.farShoulder[1]);
    }
  });

  // Before the review fix the herald had 3 to 16 gold pixels a frame (fewer than the trainer's headband and staff tip: 7 to 23).
  it('shows the herald\'s gold cape in every frame, from the front and from behind', () => {
    const gold = new Set(['gold1', 'gold2', 'gold3'].map(c => manifest.palette[c].toLowerCase()));
    const herald = Object.keys(page.frames).filter(name => name.startsWith('herald/'));
    expect(herald).toHaveLength(28);
    for (const name of herald) {
      const f = page.frames[name];
      let count = 0;
      for (let y = f.y; y < f.y + f.h; y += 1) for (let x = f.x; x < f.x + f.w; x += 1) {
        const i = (y * image.width + x) * 4;
        if (image.rgba[i + 3] && gold.has(`#${[0, 1, 2].map(k => image.rgba[i + k].toString(16).padStart(2, '0')).join('')}`)) count += 1;
      }
      expect(count, `${name}: gold cape pixels`).toBeGreaterThanOrEqual(30);
    }
  });
});
