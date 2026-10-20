// Words for a gladiator's public actor (the shared world's whitelisted projection), used by the Gladiators list and the
// profile card: where they are now, their class line and their equipped gear. Nothing here reads private state.
import type { EquipmentSilhouette, PublicActor } from '@contracts/reads';

const PLACE: Record<string, string> = {
  orientation: 'Arriving at camp', camp: 'At camp', training: 'Training', rest: 'Resting', arena: 'In the arena', tournament: 'In a tournament',
};
const GEAR: Record<EquipmentSilhouette, string> = {
  'weapon-sword': 'sword', 'weapon-axe': 'axe', 'weapon-spear': 'spear', 'weapon-bow': 'bow', 'offhand-shield': 'shield',
  'armor-light': 'light armor', 'armor-heavy': 'heavy armor', 'head-hood': 'hood', 'head-helmet': 'helmet', 'feet-light': 'light boots', 'feet-heavy': 'heavy boots',
};

export const title = (value: string) => (value ? value[0].toUpperCase() + value.slice(1) : value);
/** Whether the gladiator is away from the camp on an expedition. */
export const isAway = (actor: Pick<PublicActor, 'location'>) => actor.location.startsWith('expedition:');
/**
 * A gladiator resting at home (Task 23.9; Task 23.8's PublicActor.resting: its owner has sent no activity signal for 14
 * days), as everyone sees it.
 */
export const restingText = (name: string) => `Resting at home: back when ${name}'s owner returns.`;
/** Where the gladiator is now, from its public location (or that it rests at home). */
export const placeOf = (actor: Pick<PublicActor, 'location' | 'name' | 'resting'>) => (actor.resting ? restingText(actor.name)
  : isAway(actor) ? 'On an expedition' : PLACE[actor.location] ?? 'At camp');
/** "Guardian · Level 1 · Bronze league". */
export const classLine = (actor: Pick<PublicActor, 'classId' | 'level' | 'league'>) => `${title(actor.classId)} · Level ${actor.level} · ${title(actor.league)} league`;
/** The equipped gear the world shows, e.g. "Sword, shield, helmet". */
export function gearText(silhouettes: readonly EquipmentSilhouette[]): string {
  const names = silhouettes.map(s => GEAR[s] ?? s);
  return names.length ? title(names.join(', ')) : 'No gear shown';
}
