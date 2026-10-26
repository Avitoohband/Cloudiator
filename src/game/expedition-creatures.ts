// Pure rules for the creatures of an expedition scene: which of the three encounters shows its creature waiting at
// its spot, which one is fighting, and what becomes of it afterwards. The creature of each encounter is fixed per
// expedition (the map and the server's `creature:<id>:<n>` ids), not an outcome, so showing it from the start reveals
// nothing; what a battle brings appears only once the battle is revealed and played, exactly as before.
//   waiting   the encounter has not started (or is not published): its creature idles at its spot.
//   fighting  its battle is staged: the fight sprite is drawn, in its result poses too, and fades after a victory.
//   gone      the gladiator won and the beaten creature has faded away.
//   stays     the gladiator lost: once the result poses end the winning creature idles at its spot again.
// A function of the stage state alone: no Phaser, clock or randomness.
import type { ExpeditionBattle, ExpeditionSceneState } from './expedition-stage';
import { EXPEDITION_ENCOUNTERS } from './expedition-stage';
import { REPLAY_OUTRO_MS } from './replay';

/** A beaten creature fades this long after the result poses. */
export const CREATURE_FADE_MS = 1500;

export type CreatureMode = 'waiting' | 'fighting' | 'gone' | 'stays';
export type WaitingCreature = { encounter: number; mode: CreatureMode };

/** Time since the result poses of a battle ended (positive once they are over). */
const afterPoses = (battle: ExpeditionBattle) => battle.elapsedMs - battle.log.durationMs - REPLAY_OUTRO_MS;
/** The logged winner alone decides, as the stage core settles it. */
const gladiatorWon = (battle: ExpeditionBattle) => battle.log.winnerId === battle.log.participants[0].id;

/**
 * The mode of one encounter's creature (1 to 3). Allocation-free: the scene reads it for every encounter on
 * every frame.
 */
export function creatureMode(state: ExpeditionSceneState, encounter: number): CreatureMode {
  const battle = state.battle;
  // The battle the scene stages is the latest revealed one, fought or not yet started.
  if (battle && battle.encounter === encounter) {
    if (battle.elapsedMs < 0) return 'waiting';
    const after = afterPoses(battle);
    if (after <= 0) return 'fighting';
    if (!gladiatorWon(battle)) return 'stays';
    return after < CREATURE_FADE_MS ? 'fighting' : 'gone';
  }
  let stage: ExpeditionSceneState['stages'][number] | null = null;
  for (const s of state.stages) if (s.encounter === encounter) { stage = s; break; }
  if (!stage || stage.startedAtMs > state.displayNowMs) return 'waiting';
  // An encounter that is no longer the staged battle (a later one is) or whose battle log is gone: its outcome decides.
  if (stage.inProgress) return 'waiting';
  return stage.outcome === 'defeat' ? 'stays' : 'gone';
}

/** One entry per encounter 1 to 3, in order. */
export function waitingCreatures(state: ExpeditionSceneState): WaitingCreature[] {
  return Array.from({ length: EXPEDITION_ENCOUNTERS }, (_, i) => ({ encounter: i + 1, mode: creatureMode(state, i + 1) }));
}

/**
 * How much of the fight sprite of the staged battle's creature is drawn: fully through the fight and its result
 * poses, then (after a gladiator victory) fading over `CREATURE_FADE_MS`, or at once with reduced motion. After a
 * defeat the winning creature is drawn by its idle sprite instead, so the fight sprite is hidden.
 */
export function fightCreatureAlpha(battle: ExpeditionBattle, reducedMotion: boolean): number {
  if (battle.elapsedMs < 0) return 0;
  const after = afterPoses(battle);
  if (after <= 0) return 1;
  if (!gladiatorWon(battle) || reducedMotion) return 0;
  return Math.max(0, 1 - after / CREATURE_FADE_MS);
}
