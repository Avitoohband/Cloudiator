// Pure choreography for the close-up battle replay. Given a revealed BattleLog, it plans which
// animation each fighter plays, which effect lands where and which damage label shows, and
// `stageAt` returns the whole picture for a replay position. Every value comes from the log
// (attacker, defender, hit, critical, defend, evade, damage, the victory); nothing is simulated.
// Because the picture is a function of the position alone, pause, seek, restart, skip and both
// speeds always agree, and the frame rate never changes the result.
import type { BattleAction, BattleLog, RevealedCombatant } from '@contracts/events';
import type { AnimationDef, AssetManifest, CloseupTheme, EffectId } from './assets';
import { layersFor, tintFor } from './actors';

export type FighterKind = 'gladiator' | 'npc' | 'creature';
export type CombatAction = 'idle' | 'attack' | 'hit' | 'defend' | 'evade' | 'defeat' | 'victory';
const COMBAT_ACTIONS: CombatAction[] = ['idle', 'attack', 'hit', 'defend', 'evade', 'defeat', 'victory'];
export type Creature = AssetManifest['actors']['creatures'][number];

/** NPC fallback opponents wear a neutral steel grey, so they are not mistaken for a player. */
export const NPC_CLOTH = 0x8394a1;
/** Every attack animation lands its blow on this frame; the frame starts at the logged time. */
export const IMPACT_FRAME = 2;
/** Floor rows shown below the fighters' feet. */
const FLOOR_BELOW = 22;
const LABEL_MS = 800;
const SHAKE_MS = 180;
const FLASH_MS = 140;
const ARROW_MS = 120;

export type FighterLook = {
  kind: FighterKind;
  atlas: string;
  /** Layers in draw order with their multiply tint (null = untinted). A creature has one layer, ''. */
  layers: { id: string; tint: number | null }[];
  /** Manifest animation key of each combat action, facing se. */
  animations: Record<CombatAction, string>;
  creatureId: string | null;
  /** The expedition a creature belongs to, for its close-up backdrop. */
  home: Creature['expedition'] | null;
  /** Where the head rests once defeated, in art pixels towards the opponent (humanoids fall backwards, wolves forwards). */
  lyingHeadX: number;
};

/** The catalog's expedition enemy names, shown by the closest creature art of that expedition. */
const ENEMY_NAMES: Record<string, string> = { 'wild beast': 'dire-wolf', 'armed raider': 'raider', 'dangerous creature': 'rock-troll' };

/**
 * Creature art for a participant, or null. Only participants without a gladiator can be creatures.
 * Lookup order: an id of the form `creature:<manifest creature id>[:...]`, then the creature's name
 * (case-insensitive), then a catalog expedition enemy name. Anyone else without a gladiator is an
 * NPC fallback and is drawn as a gladiator.
 */
export function creatureFor(p: RevealedCombatant, list: readonly Creature[]): Creature | null {
  if (p.gladiatorId !== null) return null;
  const byId = /^creature:([a-z0-9-]+)/.exec(p.id)?.[1];
  const name = p.name.trim().toLowerCase();
  const creature = list.find(c => c.id === byId) ?? list.find(c => c.name.toLowerCase() === name) ?? list.find(c => c.id === ENEMY_NAMES[name]) ?? null;
  // A non-gladiator that matches nothing is drawn as an NPC fallback. Producers (Tasks 8 and 9) should
  // use `creature:<manifest id>` ids so a renamed or new enemy never silently loses its art; an id whose
  // creature is missing from the manifest warns too.
  if (!creature && process.env.NODE_ENV !== 'production') console.warn(`battle replay: no creature art for "${p.name}" (${p.id}); drawing an NPC fallback`);
  return creature;
}

export function fighterLook(p: RevealedCombatant, manifest: AssetManifest): FighterLook {
  const creature = creatureFor(p, manifest.actors.creatures);
  if (creature) {
    const animations = Object.fromEntries(COMBAT_ACTIONS.map(a => [a, creature.animations[a]!.se])) as Record<CombatAction, string>;
    return { kind: 'creature', atlas: creature.atlas, layers: [{ id: '', tint: null }], animations, creatureId: creature.id, home: creature.expedition, lyingHeadX: /wolf/.test(creature.id) ? 10 : -16 };
  }
  const g = manifest.actors.gladiator;
  const ids = layersFor(p.equipmentSilhouettes);
  const tint = p.gladiatorId ? tintFor(p.gladiatorId) : { ...tintFor(p.id), cloth: NPC_CLOTH };
  const keyOf = new Map(g.layers.map(l => [l.id, l.tint]));
  const weapon = ids.find(id => id.startsWith('weapon-'))?.slice('weapon-'.length);
  const variant = weapon ? g.attackVariants[weapon] : undefined;
  const animations = Object.fromEntries(COMBAT_ACTIONS.map(a => [a, g.animations[a === 'attack' && variant ? variant : a].se])) as Record<CombatAction, string>;
  return {
    kind: p.gladiatorId ? 'gladiator' : 'npc',
    atlas: g.atlas,
    layers: ids.map(id => { const key = keyOf.get(id); return { id, tint: key ? tint[key] : null }; }),
    animations, creatureId: null, home: null, lyingHeadX: -16,
  };
}

/** Arena bouts use the arena close-up; an encounter uses its creature's expedition. */
export function backdropFor(log: BattleLog, manifest: AssetManifest): CloseupTheme {
  for (const p of log.participants) { const c = creatureFor(p, manifest.actors.creatures); if (c) return c.expedition; }
  return 'arena';
}

// ------------------------------------------------------------------ layout

export type StageLayout = {
  width: number; height: number; scale: number;
  /** Top-left of the backdrop in canvas pixels. */
  backdropX: number; backdropY: number;
  /** Feet of the left (facing se) and right (facing sw) fighter. */
  feet: [{ x: number; y: number }, { x: number; y: number }];
};

/** Centres the close-up at the integer scale, with a few floor rows below the fighters' feet. */
export function stageLayout(manifest: AssetManifest, width: number, height: number): StageLayout {
  const { scale, width: bw, groundY, fighterX } = manifest.closeups;
  const feetY = Math.round(height - FLOOR_BELOW * scale);
  const backdropX = Math.round(width / 2 - (bw * scale) / 2);
  const backdropY = feetY - groundY * scale;
  return {
    width, height, scale, backdropX, backdropY,
    feet: [{ x: backdropX + fighterX[0] * scale, y: feetY }, { x: backdropX + fighterX[1] * scale, y: feetY }],
  };
}

// ------------------------------------------------------------------ plan

/** `strikeEnd`: an attack outranks reactions until its impact frame ends (who strikes whom), not through the recovery. */
type Window = { start: number; end: number; action: CombatAction; animation: string; strikeEnd?: number };
type EffectWindow = {
  sequence: number; effect: EffectId; target: 0 | 1; start: number; end: number; loop: boolean;
  place: 'body' | 'dodge' | 'head' | 'aura' | 'arrow';
  /** For arrows: the shooter. */
  from?: 0 | 1;
};
type LabelWindow = { sequence: number; target: 0 | 1; start: number; text: string; kind: 'damage' | 'critical' | 'guard' | 'miss' };

export type StagePlan = {
  log: BattleLog;
  looks: [FighterLook, FighterLook];
  windows: [Window[], Window[]];
  effects: EffectWindow[];
  labels: LabelWindow[];
  criticals: number[];
  animations: AssetManifest['animations'];
  effectAnimations: AssetManifest['effects'];
};

const total = (anim: AnimationDef) => anim.durationsMs.reduce((s, d) => s + d, 0);

/** Frame index of an animation `t` ms after it started; one-shot animations hold their last frame. */
export function frameIndex(anim: AnimationDef, t: number): number {
  const length = total(anim);
  let local = anim.loop ? ((t % length) + length) % length : Math.min(Math.max(0, t), length - 1);
  for (let i = 0; i < anim.durationsMs.length; i += 1) {
    if (local < anim.durationsMs[i]) return i;
    local -= anim.durationsMs[i];
  }
  return anim.frames.length - 1;
}

export function planStage(log: BattleLog, manifest: AssetManifest): StagePlan {
  const looks: [FighterLook, FighterLook] = [fighterLook(log.participants[0], manifest), fighterLook(log.participants[1], manifest)];
  const index = (id: string): 0 | 1 => (log.participants[0].id === id ? 0 : 1);
  const anim = (key: string) => manifest.animations[key];
  const windows: [Window[], Window[]] = [[], []];
  const effects: EffectWindow[] = [];
  const labels: LabelWindow[] = [];
  const criticals: number[] = [];
  const attacks = log.events.filter((e): e is Readonly<BattleAction> => e.kind === 'attack');
  const attackWindow = new Map<number, Window>();
  for (const e of attacks) {
    const a = index(e.attackerId);
    const key = looks[a].animations.attack;
    const def = anim(key);
    const lead = def.durationsMs.slice(0, IMPACT_FRAME).reduce((s, d) => s + d, 0);
    const w = { start: e.elapsedMs - lead, end: e.elapsedMs - lead + total(def), action: 'attack' as const, animation: key, strikeEnd: e.elapsedMs + def.durationsMs[IMPACT_FRAME] };
    windows[a].push(w);
    attackWindow.set(e.sequence, w);
  }
  for (const e of attacks) {
    const a = index(e.attackerId);
    const d = index(e.defenderId);
    const reaction: CombatAction = e.evade ? 'evade' : e.defend ? 'defend' : 'hit';
    const key = looks[d].animations[reaction];
    // A fighter who is struck while landing its own equal-time blow reacts once that swing ends.
    const own = attacks.find(o => o.elapsedMs === e.elapsedMs && o.attackerId === e.defenderId);
    const start = own ? Math.max(e.elapsedMs, attackWindow.get(own.sequence)!.end) : e.elapsedMs;
    windows[d].push({ start, end: start + total(anim(key)), action: reaction, animation: key });
    const effect: EffectId = e.evade ? 'evade' : e.critical ? 'critical' : e.defend ? 'defend' : 'hit';
    // The evade effect carries its own dust puff, so it sits low enough for the puff to touch the floor.
    effects.push({ sequence: e.sequence, effect, target: d, start: e.elapsedMs, end: e.elapsedMs + total(anim(manifest.effects[effect])), loop: false, place: e.evade ? 'dodge' : 'body' });
    if (looks[a].animations.attack.includes('/shoot/') || looks[a].creatureId === 'raider-archer') {
      effects.push({ sequence: e.sequence, effect: 'arrow', target: d, from: a, start: e.elapsedMs - ARROW_MS, end: e.elapsedMs, loop: false, place: 'arrow' });
    }
    labels.push({
      sequence: e.sequence, target: d, start: e.elapsedMs,
      text: !e.hit ? 'MISS' : e.critical ? `-${e.damage} CRIT` : e.defend ? `-${e.damage} GUARD` : `-${e.damage}`,
      kind: !e.hit ? 'miss' : e.critical ? 'critical' : e.defend ? 'guard' : 'damage',
    });
    if (e.critical) criticals.push(e.elapsedMs);
  }
  // The result: the loser falls once its last reaction ends, then the winner celebrates.
  const victory = log.events.find(e => e.kind === 'victory');
  if (victory) {
    const w = index(victory.winnerId);
    const l = (1 - w) as 0 | 1;
    const settled = (i: 0 | 1) => Math.max(log.durationMs, ...windows[i].map(x => x.end));
    const fall = settled(l);
    const cheer = settled(w) + 150;
    const defeat = looks[l].animations.defeat;
    windows[l].push({ start: fall, end: Infinity, action: 'defeat', animation: defeat });
    windows[w].push({ start: cheer, end: Infinity, action: 'victory', animation: looks[w].animations.victory });
    effects.push({ sequence: victory.sequence, effect: 'defeat', target: l, start: fall + total(anim(defeat)) - 200, end: Infinity, loop: true, place: 'head' });
    effects.push({ sequence: victory.sequence, effect: 'victory', target: w, start: cheer + 280, end: cheer + 280 + total(anim(manifest.effects.victory)), loop: false, place: 'aura' });
  }
  for (const list of windows) list.sort((x, y) => x.start - y.start);
  effects.sort((x, y) => x.start - y.start);
  return { log, looks, windows, effects, labels, criticals, animations: manifest.animations, effectAnimations: manifest.effects };
}

// ------------------------------------------------------------------ frames

export type FighterPose = {
  index: 0 | 1; action: CombatAction; animation: string; frame: number;
  /** Atlas frame per layer, in draw order. */
  frames: string[]; atlas: string;
  /** True for the right-hand fighter, mirrored to face sw. */
  flip: boolean; x: number; y: number; depth: number;
};
export type EffectPose = { sequence: number; effect: EffectId; frameName: string; frame: number; target: 0 | 1; x: number; y: number; flip: boolean };
export type LabelPose = { sequence: number; text: string; kind: LabelWindow['kind']; target: 0 | 1; x: number; y: number; alpha: number };
export type StageFrame = {
  fighters: [FighterPose, FighterPose];
  effects: EffectPose[];
  labels: LabelPose[];
  /** Camera offset in canvas pixels; always zero with reduced motion. */
  shake: { x: number; y: number };
  /** White flash opacity; always zero with reduced motion. */
  flash: number;
};

/** The window shown at `ms`: an attack that has not yet struck wins, otherwise the latest started. */
function activeWindow(list: Window[], ms: number): Window | null {
  let lo = 0;
  let hi = list.length - 1;
  let last = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].start <= ms) { last = mid; lo = mid + 1; } else hi = mid - 1; }
  let best: Window | null = null;
  for (let i = last; i >= 0 && list[i].start > ms - 4000; i -= 1) {
    const w = list[i];
    if (ms >= w.end) continue;
    if (w.strikeEnd !== undefined && ms < w.strikeEnd) return w;
    best ??= w;
  }
  return best;
}

export function stageAt(plan: StagePlan, positionMs: number, layout: StageLayout, opts: { reducedMotion?: boolean } = {}): StageFrame {
  const ms = Math.max(0, positionMs);
  const reduced = !!opts.reducedMotion;
  const s = layout.scale;
  const fighters = ([0, 1] as const).map(i => {
    const look = plan.looks[i];
    const w = activeWindow(plan.windows[i], ms);
    const animation = w ? w.animation : look.animations.idle;
    const def = plan.animations[animation];
    // Idle loops run on the replay clock, offset so the two fighters breathe out of step.
    const frame = frameIndex(def, w ? ms - w.start : ms + i * 370);
    const name = def.frames[frame];
    const frames = look.kind === 'creature' ? [name] : look.layers.map(l => name.replace(/^body\//, `${l.id}/`));
    const depth = w?.action === 'attack' ? 20 : 10 + i;
    return { index: i, action: w ? w.action : 'idle', animation, frame, frames, atlas: look.atlas, flip: i === 1, x: layout.feet[i].x, y: layout.feet[i].y, depth } satisfies FighterPose;
  }) as [FighterPose, FighterPose];

  const effects: EffectPose[] = [];
  for (const e of plan.effects) {
    if (e.start > ms) break;
    if (ms >= e.end) continue;
    const def = plan.animations[plan.effectAnimations[e.effect]];
    const t = ms - e.start;
    const frame = frameIndex(e.loop ? { ...def, loop: true } : def, t);
    const feet = layout.feet[e.target];
    const toward = e.target === 0 ? 1 : -1; // from the defender towards its opponent
    let x = feet.x;
    let y = feet.y;
    let flip = e.target === 1;
    if (e.place === 'body') { x += toward * 4 * s; y -= 24 * s; }
    else if (e.place === 'dodge') { y -= 16 * s; }
    else if (e.place === 'head') { x += toward * plan.looks[e.target].lyingHeadX * s; y -= 4 * s; }
    else if (e.place === 'aura') { y -= 28 * s; }
    else {
      const from = layout.feet[e.from!];
      const p = t / (e.end - e.start);
      const x0 = from.x - toward * 14 * s;
      const x1 = feet.x + toward * 6 * s;
      x = Math.round(x0 + (x1 - x0) * p);
      y = feet.y - 28 * s;
      flip = e.from === 1;
    }
    effects.push({ sequence: e.sequence, effect: e.effect, frameName: def.frames[frame], frame, target: e.target, x, y, flip });
  }

  // Newest labels first; at most two per fighter (one with reduced motion, since they do not rise apart).
  const labels: LabelPose[] = [];
  const shown = [0, 0];
  for (let k = plan.labels.length - 1; k >= 0; k -= 1) {
    const l = plan.labels[k];
    if (l.start > ms) continue;
    const t = ms - l.start;
    if (t >= LABEL_MS) { if (ms - l.start > LABEL_MS + 5000) break; continue; }
    if (shown[l.target] >= (reduced ? 1 : 2)) continue;
    shown[l.target] += 1;
    const p = t / LABEL_MS;
    const feet = layout.feet[l.target];
    labels.push({
      sequence: l.sequence, text: l.text, kind: l.kind, target: l.target, x: feet.x,
      y: Math.round(feet.y - 50 * s - (reduced ? 0 : 12 * s * p)),
      alpha: p < 0.7 ? 1 : Math.max(0, 1 - (p - 0.7) / 0.3),
    });
  }

  let shake = { x: 0, y: 0 };
  let flash = 0;
  if (!reduced) {
    const crit = plan.criticals.filter(t => t <= ms && ms < t + SHAKE_MS).at(-1);
    if (crit !== undefined) {
      const p = (ms - crit) / SHAKE_MS;
      const amplitude = 3 * (1 - p);
      shake = { x: Math.round(amplitude * Math.sin(p * Math.PI * 6 + 0.5)), y: Math.round(amplitude * 0.5 * Math.cos(p * Math.PI * 5)) };
    }
    const lit = plan.criticals.filter(t => t <= ms && ms < t + FLASH_MS).at(-1);
    if (lit !== undefined) flash = 0.3 * (1 - (ms - lit) / FLASH_MS);
  }
  return { fighters, effects, labels, shake, flash };
}
