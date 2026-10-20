import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BattleAction, BattleLog, RevealedCombatant } from '@contracts/events';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { decodePng } from '../../assets/source/tools/png.mjs';
import { loadAssetManifest } from '@/game/assets';
import { planActorRoutine } from '@/game/actors';
import { NPC_CLOTH, backdropFor, creatureFor, fighterLook, planStage, stageAt, stageLayout, type StageFrame, type StageLayout } from '@/game/battle-stage';
import { REPLAY_OUTRO_MS } from '@/game/replay';
import { FIXTURE_BATTLE_LOGS } from '../fixtures/battles';

const manifest = loadAssetManifest();
const PUBLIC = join(__dirname, '..', '..', 'public', 'assets');
const images = new Map<string, { width: number; rgba: Uint8Array }>();
/** Opaque pixel bounds of an atlas frame relative to its anchor, in art pixels (read from the shipped PNG). */
const boundsCache = new Map<string, { l: number; r: number; t: number; b: number } | null>();
function frameBounds(atlasKey: string, name: string) {
  const key = `${atlasKey}:${name}`;
  if (boundsCache.has(key)) return boundsCache.get(key)!;
  const atlas = manifest.atlases[atlasKey];
  if (!images.has(atlas.image)) images.set(atlas.image, decodePng(readFileSync(join(PUBLIC, atlas.image))));
  const { width, rgba } = images.get(atlas.image)!;
  const f = atlas.frames[name];
  expect(f, key).toBeDefined();
  let out: { l: number; r: number; t: number; b: number } | null = null;
  for (let y = 0; y < f.h; y += 1) for (let x = 0; x < f.w; x += 1) {
    if (!rgba[((f.y + y) * width + f.x + x) * 4 + 3]) continue;
    const [px, py] = [x - f.anchorX, y - f.anchorY];
    out = out ? { l: Math.min(out.l, px), r: Math.max(out.r, px + 1), t: Math.min(out.t, py), b: Math.max(out.b, py + 1) } : { l: px, r: px + 1, t: py, b: py + 1 };
  }
  boundsCache.set(key, out);
  return out;
}
/** Screen rectangle (CSS px) covered by a fighter pose's opaque pixels. */
function fighterRect(frame: StageFrame, i: 0 | 1, layout: StageLayout) {
  const f = frame.fighters[i];
  const s = layout.scale;
  let r = { l: Infinity, r: -Infinity, t: Infinity, b: -Infinity };
  for (const name of f.frames) {
    const b = frameBounds(f.atlas, name);
    if (b) r = { l: Math.min(r.l, b.l), r: Math.max(r.r, b.r), t: Math.min(r.t, b.t), b: Math.max(r.b, b.b) };
  }
  const [left, right] = f.flip ? [f.x - r.r * s, f.x - r.l * s] : [f.x + r.l * s, f.x + r.r * s];
  return { left: left + frame.shake.x, right: right + frame.shake.x, top: f.y + r.t * s + frame.shake.y, bottom: f.y + r.b * s + frame.shake.y };
}
const combatant = (patch: Partial<RevealedCombatant>): RevealedCombatant => ({
  id: 'x', gladiatorId: 'x', name: 'X', classId: 'guardian', stance: 'balanced',
  attributes: { strength: 5, agility: 5, vitality: 5, endurance: 5, precision: 5 },
  maxHealth: 100, initialHealth: 100, armor: 0, weaponDamage: 6, attackIntervalMs: 1000, efficiencyBasisPoints: 10_000, equipmentSilhouettes: [], ...patch,
});
const attacksOf = (log: BattleLog) => log.events.filter((e): e is BattleAction => e.kind === 'attack');
const index = (log: BattleLog, id: string) => (log.participants[0].id === id ? 0 : 1);
const logs = Object.entries(FIXTURE_BATTLE_LOGS);
const VIEWS: [number, number][] = [[320, 300], [360, 300], [768, 340], [960, 372]];

describe('fighter looks', () => {
  it('maps battle-log catalog ids to the same layers and colours the camp uses', () => {
    const silhouettes = ['sword:1:common', 'round-shield:1:common', 'iron-helmet:1:common', 'light-armor:1:common'];
    const look = fighterLook(combatant({ id: 'g1', gladiatorId: 'g1', equipmentSilhouettes: silhouettes }), manifest);
    expect(look.kind).toBe('gladiator');
    expect(look.atlas).toBe('gladiators');
    expect(look.layers.map(l => l.id)).toEqual(['body', 'cloth', 'armor-light', 'accent', 'head-helmet', 'head-helmet-crest', 'weapon-sword', 'offhand-shield', 'held']);
    const camp = planActorRoutine({ gladiatorId: 'g1', name: 'X', classId: 'guardian', equipmentSilhouettes: [], league: 'bronze', level: 1, phase: 'morning',
      location: 'arena', activityId: null, activityStatus: 'idle', startsAtMs: null, endsAtMs: null, visibleStage: null, resting: false }, 1);
    const tint = Object.fromEntries(look.layers.map(l => [l.id, l.tint]));
    expect(tint).toMatchObject({ body: camp.tint.skin, cloth: camp.tint.cloth, accent: camp.tint.cloth, 'head-helmet-crest': camp.tint.cloth, 'weapon-sword': null, 'armor-light': null });
    expect(look.animations.attack).toBe('gladiator/attack/se');
  });

  it('uses the thrust and shoot attacks for spears and bows', () => {
    expect(fighterLook(combatant({ equipmentSilhouettes: ['spear:5:rare'] }), manifest).animations.attack).toBe('gladiator/thrust/se');
    expect(fighterLook(combatant({ equipmentSilhouettes: ['bow:1:common', 'light-armor:1:common'] }), manifest).animations.attack).toBe('gladiator/shoot/se');
  });

  it('draws an NPC fallback as a gladiator in neutral grey, and creatures from the creature atlas', () => {
    const npc = fighterLook(combatant({ id: 'npc:fallback:1', gladiatorId: null, classId: null, name: 'Iron Warden', equipmentSilhouettes: ['bow:1:common'] }), manifest);
    expect(npc).toMatchObject({ kind: 'npc', atlas: 'gladiators', creatureId: null });
    expect(npc.layers.find(l => l.id === 'cloth')!.tint).toBe(NPC_CLOTH);
    const wolf = fighterLook(combatant({ id: 'creature:timber-wolf:2', gladiatorId: null, classId: null, name: 'Timber Wolf' }), manifest);
    expect(wolf).toMatchObject({ kind: 'creature', atlas: 'creatures', creatureId: 'timber-wolf', home: 'woodland' });
    expect(wolf.animations).toMatchObject({ attack: 'creature-timber-wolf/attack/se', defeat: 'creature-timber-wolf/defeat/se', idle: 'creature-timber-wolf/idle/se' });
  });

  it('finds a creature by id prefix, by name, or by its catalog enemy name', () => {
    const find = (id: string, name: string) => creatureFor(combatant({ id, name, gladiatorId: null }), manifest.actors.creatures)?.id ?? null;
    expect(find('creature:frost-troll:3', 'Something')).toBe('frost-troll');
    expect(find('enemy-7', 'Raider Archer')).toBe('raider-archer');
    for (const [expedition, { enemy }] of Object.entries(CATALOG_V1.expeditions)) {
      const id = find(`enemy:${expedition}`, enemy.name);
      expect(manifest.actors.creatures.find(c => c.id === id)?.expedition, enemy.name).toBe(expedition);
    }
    expect(find('npc:fallback:1', 'Iron Warden')).toBeNull();
    expect(creatureFor(combatant({ id: 'creature:dire-wolf:1', gladiatorId: 'g' }), manifest.actors.creatures)).toBeNull();
  });

  it('warns in development whenever a non-gladiator falls back to NPC art, even with a creature id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const look = (id: string, name: string) => creatureFor(combatant({ id, name, gladiatorId: null }), manifest.actors.creatures);
      expect(look('creature:timber-wolf:2', 'Timber Wolf')?.id).toBe('timber-wolf');
      expect(warn).not.toHaveBeenCalled();
      expect(look('creature:no-such-beast:1', 'Mystery Beast')).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('creature:no-such-beast:1');
    } finally {
      warn.mockRestore();
    }
  });

  it('draws an Arena NPC fallback (id npc:<entrant>) as an NPC without a creature lookup or warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Named like a creature on purpose: the npc: id alone decides.
      expect(creatureFor(combatant({ id: 'npc:0d5f8471-d919-428f-9ab7-058c95821757', name: 'Timber Wolf', gladiatorId: null }), manifest.actors.creatures)).toBeNull();
      expect(fighterLook(combatant({ id: 'npc:0d5f8471-d919-428f-9ab7-058c95821757', name: 'Iron Warden', gladiatorId: null }), manifest).kind).toBe('npc');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('stages arena bouts in the arena and encounters where the creature lives', () => {
    expect(backdropFor(FIXTURE_BATTLE_LOGS.pvp, manifest)).toBe('arena');
    expect(backdropFor(FIXTURE_BATTLE_LOGS.npc, manifest)).toBe('arena');
    expect(backdropFor(FIXTURE_BATTLE_LOGS['expedition-2'], manifest)).toBe('woodland');
  });
});

describe('stage layout', () => {
  it('puts the backdrop floor under the fighters at an integer 3x scale', () => {
    expect(stageLayout(manifest, 360, 300)).toEqual({
      width: 360, height: 300, scale: 3, backdropX: -300, backdropY: -78, feet: [{ x: 126, y: 234 }, { x: 234, y: 234 }],
    });
    for (const [w, h] of VIEWS) {
      const l = stageLayout(manifest, w, h);
      expect(Number.isInteger(l.backdropX) && Number.isInteger(l.backdropY), `${w}x${h}`).toBe(true);
      expect(l.backdropX).toBeLessThanOrEqual(0);
      expect(l.backdropY).toBeLessThanOrEqual(0);
      expect(l.backdropX + manifest.closeups.width * 3).toBeGreaterThanOrEqual(w);
      expect(l.backdropY + manifest.closeups.height * 3).toBeGreaterThanOrEqual(h);
      // Feet sit on the backdrop's floor row, on the same 3px art grid.
      for (const [i, f] of l.feet.entries()) expect([f.x, f.y]).toEqual([l.backdropX + manifest.closeups.fighterX[i] * 3, l.backdropY + manifest.closeups.groundY * 3]);
    }
  });

  it('keeps every combat frame of every gladiator loadout and creature inside the smallest stage', () => {
    const g = manifest.actors.gladiator;
    const combat = ['idle', 'attack', 'thrust', 'shoot', 'hit', 'defend', 'evade', 'defeat', 'victory'] as const;
    let union = { l: Infinity, r: -Infinity, t: Infinity, b: -Infinity };
    const grow = (b: { l: number; r: number; t: number; b: number } | null) => { if (b) union = { l: Math.min(union.l, b.l), r: Math.max(union.r, b.r), t: Math.min(union.t, b.t), b: Math.max(union.b, b.b) }; };
    for (const action of combat) for (const name of manifest.animations[g.animations[action].se].frames) for (const layer of g.layers) grow(frameBounds(g.atlas, name.replace(/^body\//, `${layer.id}/`)));
    for (const c of manifest.actors.creatures) for (const d of Object.values(c.animations)) for (const name of manifest.animations[d!.se].frames) grow(frameBounds(c.atlas, name));
    for (const [w, h] of VIEWS) {
      const l = stageLayout(manifest, w, h);
      const s = l.scale;
      // Left fighter faces se; the right one is mirrored to face sw. Room for a 3px shake on each side.
      expect(l.feet[0].x + union.l * s - 3, `${w}x${h} left`).toBeGreaterThanOrEqual(0);
      expect(l.feet[1].x - union.l * s + 3, `${w}x${h} right`).toBeLessThanOrEqual(w);
      expect(l.feet[0].y + union.t * s - 3, `${w}x${h} top`).toBeGreaterThanOrEqual(0);
      expect(l.feet[0].y + union.b * s + 3, `${w}x${h} bottom`).toBeLessThanOrEqual(h);
    }
  });
});

describe('stage choreography from the log', () => {
  const sampleTimes = (log: BattleLog) => [0, ...new Set(log.events.flatMap(e => [e.elapsedMs - 150, e.elapsedMs, e.elapsedMs + 60, e.elapsedMs + 200, e.elapsedMs + 420])),
    ...[300, 700, 1100, 1500, REPLAY_OUTRO_MS].map(d => log.durationMs + d)].filter(t => t >= 0);

  it.each(logs)('keeps both fighters facing each other and fully inside the frame for every action (%s)', (_name, log) => {
    const plan = planStage(log, manifest);
    for (const [w, h] of [[360, 300], [960, 372]] as const) {
      const layout = stageLayout(manifest, w, h);
      for (const t of sampleTimes(log)) {
        const frame = stageAt(plan, t, layout);
        expect([frame.fighters[0].flip, frame.fighters[1].flip], `t=${t}`).toEqual([false, true]);
        expect(frame.fighters[0].x).toBeLessThan(frame.fighters[1].x);
        for (const i of [0, 1] as const) {
          const r = fighterRect(frame, i, layout);
          expect(r.left >= 0 && r.right <= w && r.top >= 0 && r.bottom <= h, `${w}x${h} t=${t} fighter ${i} ${frame.fighters[i].action} ${JSON.stringify(r)}`).toBe(true);
        }
        for (const label of frame.labels) expect(label.y, `label at t=${t}`).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it.each(logs)('animates attacks, reactions, effects and damage labels exactly as logged (%s)', (_name, log) => {
    const plan = planStage(log, manifest);
    const layout = stageLayout(manifest, 960, 372);
    let reactions = 0;
    for (const e of attacksOf(log)) {
      const a = index(log, e.attackerId);
      const d = index(log, e.defenderId);
      const sameGroupAttack = attacksOf(log).some(o => o.elapsedMs === e.elapsedMs && o.attackerId === e.defenderId);
      // A fighter mid-swing finishes its own strike first; otherwise it reacts as logged, and a fighter
      // struck while landing an equal-time blow reacts right after that swing.
      const busy = attacksOf(log).some(o => o.attackerId === e.defenderId && o.elapsedMs !== e.elapsedMs && Math.abs(o.elapsedMs - e.elapsedMs) < 450);
      const impact = stageAt(plan, e.elapsedMs, layout);
      // The blow lands at the logged time: the attacker is on its impact frame.
      expect(impact.fighters[a].action, `seq ${e.sequence}`).toBe('attack');
      expect(impact.fighters[a].frame, `seq ${e.sequence}`).toBe(2);
      const after = stageAt(plan, e.elapsedMs + 10, layout);
      const reaction = e.evade ? 'evade' : e.defend ? 'defend' : 'hit';
      if (!busy) {
        const seen = sameGroupAttack ? stageAt(plan, e.elapsedMs + 280, layout) : after;
        expect(seen.fighters[d].action, `seq ${e.sequence}`).toBe(reaction);
        reactions += 1;
      }
      const effectId = e.evade ? 'evade' : e.critical ? 'critical' : e.defend ? 'defend' : 'hit';
      const effect = after.effects.find(x => x.sequence === e.sequence && x.effect === effectId);
      expect(effect, `seq ${e.sequence} ${effectId}`).toBeDefined();
      expect(effect!.target).toBe(d);
      const body = fighterRect(after, d, layout);
      expect(effect!.x >= body.left - 6 && effect!.x <= body.right + 6 && effect!.y >= body.top && effect!.y <= body.bottom, `effect on defender, seq ${e.sequence}`).toBe(true);
      const label = after.labels.find(l => l.sequence === e.sequence);
      expect(label?.target).toBe(d);
      expect(label?.text).toBe(!e.hit ? 'MISS' : e.critical ? `-${e.damage} CRIT` : e.defend ? `-${e.damage} GUARD` : `-${e.damage}`);
    }
    expect(reactions).toBeGreaterThan(0);
  });

  it.each(logs)('ends with the loser down and the winner celebrating (%s)', (_name, log) => {
    const plan = planStage(log, manifest);
    const layout = stageLayout(manifest, 960, 372);
    const end = stageAt(plan, log.durationMs + REPLAY_OUTRO_MS, layout);
    const winner = index(log, log.winnerId);
    expect(end.fighters[1 - winner].action).toBe('defeat');
    expect(end.fighters[winner].action).toBe('victory');
    const last = (anim: string) => manifest.animations[anim].frames.length - 1;
    expect(end.fighters[1 - winner].frame).toBe(last(end.fighters[1 - winner].animation));
    expect(end.fighters[winner].frame).toBe(last(end.fighters[winner].animation));
    const stars = end.effects.find(x => x.effect === 'defeat' && x.target === 1 - winner)!;
    expect(stars).toBeDefined();
    // The knocked-out stars circle over the fallen body.
    const down = fighterRect(end, (1 - winner) as 0 | 1, layout);
    const drawnTop = stars.y + frameBounds('effects', stars.frameName)!.t * layout.scale;
    expect(stars.x >= down.left && stars.x <= down.right && drawnTop <= down.top + 6, JSON.stringify({ stars, drawnTop, down })).toBe(true);
    // Before the result, nobody is defeated.
    const before = stageAt(plan, log.durationMs - 1, stageLayout(manifest, 960, 372));
    expect(before.fighters.map(f => f.action)).not.toContain('defeat');
  });

  it('shakes and flashes on critical hits only without reduced motion, and keeps labels still with it', () => {
    const log = FIXTURE_BATTLE_LOGS.pvp;
    const crit = attacksOf(log).find(e => e.critical)!;
    const plan = planStage(log, manifest);
    const layout = stageLayout(manifest, 960, 372);
    const moving = stageAt(plan, crit.elapsedMs + 30, layout);
    expect(Math.abs(moving.shake.x) + Math.abs(moving.shake.y)).toBeGreaterThan(0);
    expect(moving.flash).toBeGreaterThan(0);
    const still = stageAt(plan, crit.elapsedMs + 30, layout, { reducedMotion: true });
    expect(still.shake).toEqual({ x: 0, y: 0 });
    expect(still.flash).toBe(0);
    const early = stageAt(plan, crit.elapsedMs + 20, layout, { reducedMotion: true }).labels.find(l => l.sequence === crit.sequence)!;
    const late = stageAt(plan, crit.elapsedMs + 500, layout, { reducedMotion: true }).labels.find(l => l.sequence === crit.sequence)!;
    expect(late.y).toBe(early.y);
    expect(late.text).toBe(`-${crit.damage} CRIT`);
    // Without reduced motion the label rises.
    expect(stageAt(plan, crit.elapsedMs + 500, layout).labels.find(l => l.sequence === crit.sequence)!.y).toBeLessThan(early.y);
    const plain = attacksOf(log).find(e => e.hit && !e.critical)!;
    const calm = stageAt(plan, plain.elapsedMs + 30, layout);
    if (!attacksOf(log).some(e => e.critical && Math.abs(e.elapsedMs - plain.elapsedMs) < 300)) expect([calm.shake, calm.flash]).toEqual([{ x: 0, y: 0 }, 0]);
  });

  it('is a pure function of the replay position', () => {
    const log = FIXTURE_BATTLE_LOGS.npc;
    const plan = planStage(log, manifest);
    const layout = stageLayout(manifest, 360, 300);
    const forward = [1200, 5000, 9100].map(t => stageAt(plan, t, layout));
    const backward = [9100, 5000, 1200].map(t => stageAt(plan, t, layout)).reverse();
    expect(forward).toEqual(backward);
    expect(stageAt(planStage(log, manifest), 5000, layout)).toEqual(forward[1]);
  });
});
