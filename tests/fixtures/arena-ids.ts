// Fixture Arena gladiators, activities and bouts (no JSON imports, so browser specs can use them directly).
// The battle logs are engine-generated JSON in tests/fixtures/arena/ (see tests/domain/arena-fixtures.test.ts);
// tests/fixtures/arena.ts assembles them into timelines with the proposed Task 16 stage sequence.

/** Deterministic UUID-shaped id from a label (fixture data only; FNV-1a, as src/game/demo-world.ts). */
export function fixtureUuid(label: string): string {
  const hash = (text: string) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
  };
  const hex = [0, 1, 2, 3].map(k => hash(`${label}#${k}`).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-9${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type ArenaGladiatorKey = keyof typeof ARENA_GLADIATORS;
/** Aster is the fixture owner (tests/fixtures/domain.ts); Varro and Cassia keep their Task 14 ids. */
export const ARENA_GLADIATORS = {
  aster: { id: '0d5f8471-d919-428f-9ab7-058c95821757', name: 'Aster' },
  varro: { id: '5b0c3f8e-2d4a-4e61-9a7b-6c5d4e3f2a10', name: 'Varro' },
  cassia: { id: '7e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b', name: 'Cassia' },
  severus: { id: fixtureUuid('arena-gladiator-severus'), name: 'Severus' },
  bellator: { id: fixtureUuid('arena-gladiator-bellator'), name: 'Bellator' },
  corvina: { id: fixtureUuid('arena-gladiator-corvina'), name: 'Corvina' },
  faustina: { id: fixtureUuid('arena-gladiator-faustina'), name: 'Faustina' },
  gallus: { id: fixtureUuid('arena-gladiator-gallus'), name: 'Gallus' },
  lucilla: { id: fixtureUuid('arena-gladiator-lucilla'), name: 'Lucilla' },
  marcellus: { id: fixtureUuid('arena-gladiator-marcellus'), name: 'Marcellus' },
  nerva: { id: fixtureUuid('arena-gladiator-nerva'), name: 'Nerva' },
  titus: { id: fixtureUuid('arena-gladiator-titus'), name: 'Titus' },
  aurelia: { id: fixtureUuid('arena-gladiator-aurelia'), name: 'Aurelia' },
  decimus: { id: fixtureUuid('arena-gladiator-decimus'), name: 'Decimus' },
  valeria: { id: fixtureUuid('arena-gladiator-valeria'), name: 'Valeria' },
  cato: { id: fixtureUuid('arena-gladiator-cato'), name: 'Cato' },
  ardea: { id: fixtureUuid('arena-gladiator-ardea'), name: 'Ardea' },
} as const;

export type ArenaBoutKey = keyof typeof ARENA_BOUTS;
/**
 * Each bout: its entrant (participant 0), its opponent (a gladiator, or null for an NPC fallback, which is
 * participant 1 with id `npc:<entrant gladiatorId>`), and the slot it was fought in, counted back from the
 * fixture world's current slot (0 = the current slot, whose bouts the camp shows).
 */
export const ARENA_BOUTS = {
  ownerHumanWin: { entrant: 'aster', opponent: 'varro', slotsAgo: 1, npcName: null },
  ownerHumanLoss: { entrant: 'aster', opponent: 'cassia', slotsAgo: 2, npcName: null },
  ownerNpcWin: { entrant: 'aster', opponent: null, slotsAgo: 3, npcName: 'Iron Warden' },
  ownerNpcLoss: { entrant: 'aster', opponent: null, slotsAgo: 4, npcName: 'Bronze Sentinel' },
  ownerTieBreak: { entrant: 'aster', opponent: 'severus', slotsAgo: 5, npcName: null },
  campOne: { entrant: 'bellator', opponent: 'corvina', slotsAgo: 0, npcName: null },
  campTieBreak: { entrant: 'faustina', opponent: 'gallus', slotsAgo: 0, npcName: null },
  campThree: { entrant: 'lucilla', opponent: 'marcellus', slotsAgo: 0, npcName: null },
  campFour: { entrant: 'nerva', opponent: 'titus', slotsAgo: 0, npcName: null },
  campFive: { entrant: 'aurelia', opponent: 'decimus', slotsAgo: 0, npcName: null },
  campNpcOne: { entrant: 'valeria', opponent: null, slotsAgo: 0, npcName: 'Iron Warden' },
  campNpcTwo: { entrant: 'cato', opponent: null, slotsAgo: 0, npcName: 'Stone Gladius' },
} as const satisfies Record<string, { entrant: ArenaGladiatorKey; opponent: ArenaGladiatorKey | null; slotsAgo: number; npcName: string | null }>;

export const arenaBattleId = (bout: ArenaBoutKey) => fixtureUuid(`arena-bout-${bout}`);

export type ArenaActivityKey = keyof typeof ARENA_ACTIVITIES;
/**
 * One timeline per entrant. `bout: null` is a worker delay: minute 60 has passed but no bout is published.
 * `owner` timelines carry the owner's settled summary (fixture owner Aster); every other timeline is what a
 * spectator reads, with no summary.
 */
export const ARENA_ACTIVITIES = {
  ownerHumanWin: { gladiator: 'aster', bout: 'ownerHumanWin', slotsAgo: 1, owner: true, label: 'Arena: Aster beats Varro (credited)' },
  varroSpectator: { gladiator: 'varro', bout: 'ownerHumanWin', slotsAgo: 1, owner: false, label: "Arena: Varro's side of that bout (spectator)" },
  ownerHumanLoss: { gladiator: 'aster', bout: 'ownerHumanLoss', slotsAgo: 2, owner: true, label: 'Arena: Aster loses to Cassia (credited)' },
  ownerNpcWin: { gladiator: 'aster', bout: 'ownerNpcWin', slotsAgo: 3, owner: true, label: 'Arena: Aster beats an NPC opponent (credited)' },
  ownerNpcLoss: { gladiator: 'aster', bout: 'ownerNpcLoss', slotsAgo: 4, owner: true, label: 'Arena: Aster loses to an NPC opponent (credited)' },
  ownerTieBreak: { gladiator: 'aster', bout: 'ownerTieBreak', slotsAgo: 5, owner: true, label: 'Arena: Aster wins a tie-break at 0 HP (credited)' },
  ownerDelayed: { gladiator: 'aster', bout: null, slotsAgo: 6, owner: true, label: 'Arena: the bout is not published yet (worker delay)' },
  bellator: { gladiator: 'bellator', bout: 'campOne', slotsAgo: 0, owner: false, label: 'Camp arena: Bellator' },
  corvina: { gladiator: 'corvina', bout: 'campOne', slotsAgo: 0, owner: false, label: 'Camp arena: Corvina' },
  faustina: { gladiator: 'faustina', bout: 'campTieBreak', slotsAgo: 0, owner: false, label: 'Camp arena: Faustina' },
  gallus: { gladiator: 'gallus', bout: 'campTieBreak', slotsAgo: 0, owner: false, label: 'Camp arena: Gallus' },
  lucilla: { gladiator: 'lucilla', bout: 'campThree', slotsAgo: 0, owner: false, label: 'Camp arena: Lucilla' },
  marcellus: { gladiator: 'marcellus', bout: 'campThree', slotsAgo: 0, owner: false, label: 'Camp arena: Marcellus' },
  nerva: { gladiator: 'nerva', bout: 'campFour', slotsAgo: 0, owner: false, label: 'Camp arena: Nerva' },
  titus: { gladiator: 'titus', bout: 'campFour', slotsAgo: 0, owner: false, label: 'Camp arena: Titus' },
  aurelia: { gladiator: 'aurelia', bout: 'campFive', slotsAgo: 0, owner: false, label: 'Camp arena: Aurelia' },
  decimus: { gladiator: 'decimus', bout: 'campFive', slotsAgo: 0, owner: false, label: 'Camp arena: Decimus' },
  valeria: { gladiator: 'valeria', bout: 'campNpcOne', slotsAgo: 0, owner: false, label: 'Camp arena: Valeria' },
  cato: { gladiator: 'cato', bout: 'campNpcTwo', slotsAgo: 0, owner: false, label: 'Camp arena: Cato' },
  ardea: { gladiator: 'ardea', bout: null, slotsAgo: 0, owner: false, label: 'Camp arena: Ardea (bout delayed)' },
} as const satisfies Record<string, { gladiator: ArenaGladiatorKey; bout: ArenaBoutKey | null; slotsAgo: number; owner: boolean; label: string }>;

export const arenaActivityId = (key: ArenaActivityKey) => fixtureUuid(`arena-activity-${key}`);
/** Stage ids are `<activityId>:<index>`: 0 staging, 1 bout, 2 return. */
export const arenaStageId = (key: ArenaActivityKey, index: 0 | 1 | 2) => `${arenaActivityId(key)}:${index}`;

/** The owner's arena activities, listed as samples on the fixture game page. */
export const ARENA_SAMPLE_KEYS: readonly ArenaActivityKey[] = ['ownerNpcWin', 'ownerHumanWin', 'ownerHumanLoss', 'ownerNpcLoss', 'ownerTieBreak', 'ownerDelayed', 'varroSpectator'];
/** Current-slot entrants added to the fixture camp world. */
export const ARENA_CAMP_KEYS: readonly ArenaActivityKey[] = (Object.keys(ARENA_ACTIVITIES) as ArenaActivityKey[]).filter(key => ARENA_ACTIVITIES[key].slotsAgo === 0);
