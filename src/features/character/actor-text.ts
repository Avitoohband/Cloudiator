// Words for a gladiator's public actor (the shared world's whitelisted projection), used by the Gladiators list and the
// profile card: where they are now, their class line and their equipped gear. Nothing here reads private state.
import type { EquipmentSilhouette, PublicActor } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import type { ClockMode } from '../../lib/clock-setting';
import { timeOfDay } from '../../lib/time-format';

const PLACE: Record<string, string> = {
  orientation: 'Arriving at camp', camp: 'At camp', training: 'Training', rest: 'Resting', arena: 'In the arena', tournament: 'In a tournament',
};
const GEAR: Record<EquipmentSilhouette, string> = {
  'weapon-sword': 'sword', 'weapon-axe': 'axe', 'weapon-spear': 'spear', 'weapon-bow': 'bow', 'offhand-shield': 'shield',
  'armor-light': 'light armor', 'armor-heavy': 'heavy armor', 'head-hood': 'hood', 'head-helmet': 'helmet', 'feet-light': 'light boots', 'feet-heavy': 'heavy boots',
};

export const title = (value: string) => (value ? value[0].toUpperCase() + value.slice(1) : value);
/** Whether the gladiator is away from the camp on an expedition or in a dungeon. */
export const isAway = (actor: Pick<PublicActor, 'location'>) => actor.location.startsWith('expedition:') || actor.location.startsWith('dungeon:');

export function dungeonPlace(location: PublicActor['location']): string | null {
  if (!location.startsWith('dungeon:')) return null;
  const dungeon = Object.values(CATALOG_V1.dungeons).find(entry => location === `dungeon:${entry.id}`);
  return dungeon ? `In ${dungeon.name}` : 'In a dungeon';
}
/**
 * A gladiator resting at home (Task 23.9; Task 23.8's PublicActor.resting: its owner has sent no activity signal for 14
 * days), as everyone sees it.
 */
export const restingText = (name: string) => `Resting at home: back when ${name}'s owner returns.`;
/** Where the gladiator is now, from its public location (or that it rests at home). */
export const placeOf = (actor: Pick<PublicActor, 'location' | 'name' | 'resting'>) => (actor.resting ? restingText(actor.name)
  : dungeonPlace(actor.location) ?? (isAway(actor) ? 'On an expedition' : PLACE[actor.location] ?? 'At camp'));
/** "Guardian · Level 1 · Bronze league". */
export const classLine = (actor: Pick<PublicActor, 'classId' | 'level' | 'league' | 'botTeam'>) =>
  `${title(actor.classId)} · Level ${actor.level}${actor.botTeam ? '' : ` · ${title(actor.league)} league`}`;

export function botDutyText(actor: Pick<PublicActor, 'botDuty' | 'botReturnsAtMs'>, clock: ClockMode): string | null {
  if (actor.botDuty === 'on-duty') return 'Available for eligible dungeon parties';
  if (actor.botDuty !== 'off-duty') return null;
  const returns = actor.botReturnsAtMs == null ? '' : timeOfDay(actor.botReturnsAtMs, clock);
  return returns ? `Off duty · Back at ${returns}` : 'Off duty';
}
/** How many gladiators there are and where they are now (Patch A item 8): every gladiator counts, those resting at home too. */
export type PlayerCounts = { total: number; inCamp: number; away: number; resting: number };

/** Counts the world's gladiators: away on an expedition; resting at home (and not away); the rest are in the camp. */
export function playerCounts(actors: readonly Pick<PublicActor, 'location' | 'resting'>[]): PlayerCounts {
  let away = 0;
  let resting = 0;
  for (const actor of actors) {
    if (isAway(actor)) away += 1;
    else if (actor.resting) resting += 1;
  }
  return { total: actors.length, inCamp: actors.length - away - resting, away, resting };
}

/**
 * The line over the Gladiators list: ["50 players", " · 43 in camp · 6 on expeditions · 1 resting at home"]. The first part
 * is shown bold. A part with a zero count is left out, never the total; `compact` (the phone) says "away" for "on an
 * expedition(s)".
 */
export function countLine(counts: PlayerCounts, compact: boolean): [lead: string, rest: string] {
  const parts = [
    counts.inCamp > 0 ? `${counts.inCamp} in camp` : '',
    counts.away > 0 ? `${counts.away} ${compact ? 'away' : counts.away === 1 ? 'on an expedition' : 'on expeditions'}` : '',
    counts.resting > 0 ? `${counts.resting} resting at home` : '',
  ].filter(Boolean);
  return [`${counts.total} ${counts.total === 1 ? 'player' : 'players'}`, parts.map(part => ` · ${part}`).join('')];
}

/** The line while a name is typed in the filter and matches someone: ["4 of 50 players", " match “ar”"]. */
export function matchLine(shown: number, total: number, query: string): [lead: string, rest: string] {
  return [`${shown} of ${total} ${total === 1 ? 'player' : 'players'}`, ` match “${query}”`];
}

/**
 * Why Find cannot take the camera to a gladiator yet, or null: the camp view is unavailable (no WebGL, art that failed to load) or
 * still opening (the scene has not said who it draws). The Gladiators list and the arrival banner say the same words.
 */
export function campViewReason(sceneStatus: 'loading' | 'ready' | 'unavailable', hasRoster: boolean): string | null {
  return sceneStatus === 'unavailable' ? 'The camp view is unavailable, so gladiators cannot be shown on the map.'
    : sceneStatus === 'loading' || !hasRoster ? 'The camp view is still opening.' : null;
}

/** The equipped gear the world shows, e.g. "Sword, shield, helmet". */
export function gearText(silhouettes: readonly EquipmentSilhouette[]): string {
  const names = silhouettes.map(s => GEAR[s] ?? s);
  return names.length ? title(names.join(', ')) : 'No gear shown';
}
