// Fixture tournaments: dates, leagues, entrants and public looks (no JSON imports, so browser specs can use them
// directly). The public views are engine-generated JSON in tests/fixtures/tournaments/ (see
// tests/domain/tournament-fixtures.test.ts, which builds each bracket with the real Task 19 domain and projects it
// to a public TournamentView through tests/fixtures/tournament-build.ts). Every case is its own tournament slot
// (Wednesday or Saturday, 18:40 UTC, the evening slot), projected at the server time `asOfMinute` minutes after its start.
import type { ClassId, LeagueId } from '../../supabase/functions/_shared/contracts/commands.ts';
import type { EquipmentSilhouette } from '../../supabase/functions/_shared/contracts/reads.ts';
import { ARENA_GLADIATORS, fixtureUuid, type ArenaGladiatorKey } from './arena-ids.ts';

export const TOURNAMENT_MIN = 60_000;
export const TOURNAMENT_SLOT_MS = 4_800_000;
/** Launch feedback (2026-10-25): Wednesday or Saturday at 18:40 UTC, the evening slot (epoch ms). */
const at1840 = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day, 18, 40);

export type TournamentKey = keyof typeof TOURNAMENTS;
/**
 * The cases (dispatch decision 3; `aged` is Task 22.5's). `entrants` are fixture gladiators (Aster is the fixture
 * owner); the projection is the view a server would return `asOfMinute` minutes after the start. The fixture world's
 * time is Saturday 2026-10-10 00:40 UTC, so `upcoming` (that day's 18:40 UTC tournament) is still scheduled and the
 * others are past. `aged` is projected ten days after its start, after the cleanup that compacts its bout logs.
 */
export const TOURNAMENTS = {
  upcoming: { startsAtMs: at1840(2026, 10, 10), league: 'bronze', entrants: [], asOfMinute: -1000, label: 'Next tournament: scheduled, entries not yet fixed' },
  opening: { startsAtMs: at1840(2026, 10, 7), league: 'bronze', entrants: ['aster', 'varro', 'cassia', 'severus', 'bellator', 'corvina', 'nerva', 'titus'], asOfMinute: 5, label: 'Bronze, 7 Oct: started, before round 1' },
  midway: { startsAtMs: at1840(2026, 10, 3), league: 'bronze', entrants: ['faustina', 'gallus', 'aurelia', 'decimus', 'cato'], asOfMinute: 45, label: 'Bronze, 3 Oct: five entrants with byes, mid-way' },
  late: { startsAtMs: at1840(2026, 9, 30), league: 'bronze', entrants: ['varro', 'cassia', 'bellator', 'corvina', 'faustina', 'gallus', 'nerva', 'titus'], asOfMinute: 75, label: 'Bronze, 30 Sep: final revealed, placements pending' },
  completed: { startsAtMs: at1840(2026, 9, 26), league: 'bronze', entrants: ['aster', 'varro', 'cassia', 'severus', 'bellator', 'corvina', 'aurelia', 'decimus'], asOfMinute: 85, label: 'Bronze, 26 Sep: completed; you lost in the first round' },
  pair: { startsAtMs: at1840(2026, 9, 23), league: 'bronze', entrants: ['aster', 'severus'], asOfMinute: 85, label: 'Bronze, 23 Sep: two entrants, a 0 HP tie-break final' },
  insufficient: { startsAtMs: at1840(2026, 9, 19), league: 'gold', entrants: ['valeria'], asOfMinute: 85, label: 'Gold, 19 Sep: one qualifier, regular Arena instead' },
  // Task 22.5: projected ten days after its start, after the cleanup that compacts its bout logs to fight summaries.
  aged: { startsAtMs: at1840(2026, 9, 16), league: 'silver', entrants: ['lucilla', 'marcellus', 'nerva', 'titus'], asOfMinute: 14_400, label: 'Silver, 16 Sep: over a week old, bout replays no longer kept' },
} as const satisfies Record<string, { startsAtMs: number; league: LeagueId; entrants: readonly ArenaGladiatorKey[]; asOfMinute: number; label: string }>;

export const TOURNAMENT_KEYS = Object.keys(TOURNAMENTS) as TournamentKey[];
export const tournamentSlotIndex = (key: TournamentKey) => TOURNAMENTS[key].startsAtMs / TOURNAMENT_SLOT_MS;
/** The domain graph id (`buildBracket`: `tournament:<slot>:<league>`), which the fixture views keep. */
export const tournamentId = (key: TournamentKey) => `tournament:${tournamentSlotIndex(key)}:${TOURNAMENTS[key].league}`;
/** The server time each fixture view was projected at. */
export const tournamentAsOf = (key: TournamentKey) => TOURNAMENTS[key].startsAtMs + TOURNAMENTS[key].asOfMinute * TOURNAMENT_MIN;
/** Each entrant's tournament activity (private to the bracket; the public view carries it only in a placement summary). */
export const tournamentActivityId = (key: TournamentKey, gladiator: ArenaGladiatorKey) => fixtureUuid(`tournament-activity-${key}-${gladiator}`);

/** Public look of each fixture gladiator: the same classes, gear silhouettes and levels as the Arena fixtures. */
export const TOURNAMENT_LOOKS: Record<ArenaGladiatorKey, { classId: ClassId; silhouettes: EquipmentSilhouette[]; level: number }> = {
  aster: { classId: 'guardian', silhouettes: ['weapon-sword', 'offhand-shield', 'head-helmet', 'armor-light'], level: 1 },
  varro: { classId: 'berserker', silhouettes: ['weapon-spear', 'head-hood', 'armor-heavy'], level: 3 },
  cassia: { classId: 'duelist', silhouettes: ['weapon-sword', 'head-hood', 'armor-light'], level: 2 },
  severus: { classId: 'guardian', silhouettes: ['weapon-sword', 'offhand-shield', 'head-helmet', 'armor-light'], level: 4 },
  bellator: { classId: 'berserker', silhouettes: ['weapon-axe', 'armor-light'], level: 2 },
  corvina: { classId: 'duelist', silhouettes: ['weapon-sword', 'offhand-shield', 'head-hood'], level: 2 },
  faustina: { classId: 'duelist', silhouettes: ['weapon-sword'], level: 1 },
  gallus: { classId: 'duelist', silhouettes: ['weapon-sword'], level: 1 },
  lucilla: { classId: 'guardian', silhouettes: ['weapon-spear', 'head-helmet', 'armor-heavy'], level: 6 },
  marcellus: { classId: 'berserker', silhouettes: ['weapon-axe', 'offhand-shield', 'armor-light'], level: 5 },
  nerva: { classId: 'duelist', silhouettes: ['weapon-bow', 'head-hood', 'armor-light'], level: 3 },
  titus: { classId: 'guardian', silhouettes: ['weapon-sword', 'offhand-shield', 'armor-heavy'], level: 3 },
  aurelia: { classId: 'duelist', silhouettes: ['weapon-spear', 'armor-light'], level: 2 },
  decimus: { classId: 'berserker', silhouettes: ['weapon-axe', 'head-helmet', 'armor-heavy'], level: 4 },
  valeria: { classId: 'guardian', silhouettes: ['weapon-sword', 'head-helmet', 'armor-light'], level: 9 },
  cato: { classId: 'berserker', silhouettes: ['weapon-bow', 'head-hood'], level: 2 },
  ardea: { classId: 'duelist', silhouettes: ['weapon-sword', 'offhand-shield'], level: 1 },
};

/** Gladiator key of a fixture gladiator id. */
export const gladiatorKeyOf = (id: string) => (Object.keys(ARENA_GLADIATORS) as ArenaGladiatorKey[]).find(key => ARENA_GLADIATORS[key].id === id) ?? null;
/** The tournament samples listed on the fixture game page, in this order. */
export const TOURNAMENT_SAMPLE_KEYS: readonly TournamentKey[] = ['opening', 'midway', 'late', 'completed', 'pair', 'insufficient', 'aged', 'upcoming'];
