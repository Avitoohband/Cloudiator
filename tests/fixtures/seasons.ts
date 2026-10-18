// Task 21.3: the fixture seasons for the local preview and the browser specs (no JSON imports, so specs can use it directly).
//
// Two seasons built with seasonAt from one fixture launch epoch: season '1' is the current one (open) and holds the fixture
// world's slot, so its standings are tests/fixtures/arena-build.ts's ARENA_STANDINGS (every Arena bout of the fixture world
// is in it); season '0' is closed, with the archived pages the live read serves from `public.season_standings`: every league
// ranked, medals on the first eligible rows, a promoted gladiator rewarded only in the higher league, and inactive rows.
//
// SQL is the one authority for closing a season (private.close_season, tests/db/seasons.test.ts). The archive below is
// derived from each character's recorded league rows with the same rules, for fixtures only: rank by rating, human wins,
// fewer human losses, then id; a row qualifies with the minimum human bouts and is reward-eligible when it is the character's
// highest qualifying league; places 1 to 3 go to the first eligible rows of the league; promoted is a higher league row of
// the character; inactive is no human bout. tests/api/fixture-gateway.test.ts pins the result by name.
import type { GladiatorId, LeagueId } from '../../supabase/functions/_shared/contracts/commands.ts';
import type { PrestigeAward, SeasonView, StandingRow } from '../../supabase/functions/_shared/contracts/reads.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { seasonAt } from '../../supabase/functions/_shared/domain/season.ts';
import { worldFixture } from './domain.ts';
import { ARENA_GLADIATORS, fixtureUuid, type ArenaGladiatorKey } from './arena-ids.ts';

const { durationSlots, minimumHumanBouts } = RULES_V1.seasons;
/**
 * The fixture world's launch epoch slot: one and a half seasons (756 slots, 42 days) before the fixture world's current slot.
 * So the world sits in the middle of season 1, 14 days after it began and 14 days before it ends, far from both boundaries
 * (its Arena bouts, at most 5 slots old, all belong to season 1), and season 0 is the full season before it.
 */
export const FIXTURE_EPOCH_SLOT = worldFixture.slotIndex - durationSlots - durationSlots / 2;

const CURRENT = seasonAt(worldFixture.slotIndex, FIXTURE_EPOCH_SLOT);
const PREVIOUS = seasonAt(FIXTURE_EPOCH_SLOT, FIXTURE_EPOCH_SLOT);
/** The coordinator closes a season a few seconds after its boundary opens the next one. */
const CLOSE_DELAY_MS = 3_000;

/** The seasons, newest first as `GameGateway.seasons()` returns them: '1' (current, open) and '0' (closed). */
export const FIXTURE_SEASONS: readonly SeasonView[] = [
  { seasonId: String(CURRENT.index), startsAtMs: CURRENT.startsAtMs, endsAtMs: CURRENT.endsAtMs, closedAtMs: null },
  { seasonId: String(PREVIOUS.index), startsAtMs: PREVIOUS.startsAtMs, endsAtMs: PREVIOUS.endsAtMs, closedAtMs: PREVIOUS.endsAtMs + CLOSE_DELAY_MS },
];
/** The current (open) season's id. */
export const FIXTURE_CURRENT_SEASON = FIXTURE_SEASONS[0].seasonId;

// ------------------------------------------------------------------ season 0: the archive

const LEAGUE_ORDER: readonly LeagueId[] = ['bronze', 'silver', 'gold', 'champion'];
/** One character's rating row in one league of the season, as it stood at the close. */
type Entry = { league: LeagueId; gladiatorId: GladiatorId; name: string; rating: number; humanWins: number; humanLosses: number };

const named = (league: LeagueId, key: ArenaGladiatorKey, rating: number, humanWins: number, humanLosses: number): Entry =>
  ({ league, gladiatorId: ARENA_GLADIATORS[key].id, name: ARENA_GLADIATORS[key].name, rating, humanWins, humanLosses });

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
const NAMES = ['Brutus', 'Camilla', 'Drusus', 'Flavia', 'Gaius', 'Helvia', 'Livia', 'Marius', 'Octavia', 'Pompey', 'Quintus', 'Rufus'];
const NUMERALS = ['', ' II', ' III', ' IV', ' V'];

/**
 * Season 0's rating rows. Lucilla and Marcellus moved from Bronze to Silver and Valeria from Silver to Gold during the season.
 * Lucilla qualified in both leagues, so Bronze's first rank earns her nothing and its medals go to the next eligible rows
 * (Severus, Nerva and Aster, whose bronze badge is Aster's season 0 prestige); she is Silver's champion. Marcellus has only
 * four Bronze bouts, so his Silver row is his reward row (second place); Valeria is Gold's champion. Gold has only two
 * eligible rows, so only two places are awarded. Gallus and Ardea never fought.
 */
function season0Entries(): Entry[] {
  // A character outside the named cast: a stable id and a distinct name, by order of creation.
  let created = 0;
  const filler = (league: LeagueId, rating: number, humanWins: number, humanLosses: number): Entry => {
    const n = created++;
    return { league, gladiatorId: fixtureUuid(`season-0-filler-${n}`), name: `${NAMES[n % NAMES.length]}${NUMERALS[Math.floor(n / NAMES.length)]}`, rating, humanWins, humanLosses };
  };
  const bronzeFillers = Array.from({ length: 40 }, (_, i) => {
    const h = hash(`season-0-bronze-${i}`);
    const bouts = i % 9 === 4 ? 0 : 1 + (h % 12);
    const wins = bouts === 0 ? 0 : (h >>> 4) % (bouts + 1);
    // Rated below Varro (1061), so the named order at the top is fixed.
    return filler('bronze', bouts === 0 ? 1000 : 880 + ((h >>> 8) % 180), wins, bouts - wins);
  });
  return [
    named('bronze', 'lucilla', 1158, 13, 3), named('bronze', 'severus', 1131, 11, 2), named('bronze', 'nerva', 1098, 9, 4), named('bronze', 'aster', 1074, 8, 5),
    named('bronze', 'varro', 1061, 7, 5), named('bronze', 'bellator', 1048, 6, 4), named('bronze', 'marcellus', 1040, 3, 1), named('bronze', 'aurelia', 1033, 6, 3),
    named('bronze', 'cassia', 1012, 4, 4), named('bronze', 'corvina', 996, 2, 3), named('bronze', 'decimus', 990, 3, 3), named('bronze', 'titus', 975, 1, 3),
    named('bronze', 'cato', 960, 1, 4), named('bronze', 'faustina', 1000, 1, 1), named('bronze', 'gallus', 1000, 0, 0), named('bronze', 'ardea', 1000, 0, 0),
    ...bronzeFillers,
    named('silver', 'lucilla', 1112, 7, 3), named('silver', 'marcellus', 1085, 6, 4), named('silver', 'valeria', 1056, 2, 1),
    filler('silver', 1060, 5, 2), filler('silver', 1051, 4, 3), filler('silver', 1044, 3, 1), filler('silver', 1030, 6, 5), filler('silver', 1015, 2, 2),
    filler('silver', 1008, 5, 0), filler('silver', 993, 1, 4), filler('silver', 1000, 0, 0), filler('silver', 1000, 0, 0),
    named('gold', 'valeria', 1140, 12, 2), filler('gold', 1101, 6, 2), filler('gold', 1020, 3, 1),
  ];
}

/** Ranks, flags and places each league's rows as the close does (see the header). */
function archiveOf(entries: Entry[]): Record<LeagueId, StandingRow[]> {
  const bouts = (e: Entry) => e.humanWins + e.humanLosses;
  const level = (e: Entry) => LEAGUE_ORDER.indexOf(e.league);
  const ofCharacter = (e: Entry) => entries.filter(x => x.gladiatorId === e.gladiatorId);
  const archive: Record<LeagueId, StandingRow[]> = { bronze: [], silver: [], gold: [], champion: [] };
  for (const league of LEAGUE_ORDER) {
    let placed = 0;
    archive[league] = entries.filter(e => e.league === league)
      .sort((p, q) => q.rating - p.rating || q.humanWins - p.humanWins || p.humanLosses - q.humanLosses || p.gladiatorId.localeCompare(q.gladiatorId))
      .map((e, i): StandingRow => {
        const highestQualifying = Math.max(-1, ...ofCharacter(e).filter(x => bouts(x) >= minimumHumanBouts).map(level));
        const rewardEligible = bouts(e) >= minimumHumanBouts && level(e) === highestQualifying;
        const awardPlace = rewardEligible && placed < 3 ? (++placed as 1 | 2 | 3) : null;
        return { rank: i + 1, gladiatorId: e.gladiatorId, name: e.name, rating: e.rating, humanWins: e.humanWins, humanLosses: e.humanLosses,
          promoted: ofCharacter(e).some(x => level(x) > level(e)), inactive: bouts(e) === 0, rewardEligible, awardPlace };
      });
  }
  return archive;
}

/** Each closed season's archive by season id, every league already ranked: what `public.season_standings` holds. */
export const FIXTURE_ARCHIVE: Readonly<Record<string, Readonly<Record<LeagueId, readonly StandingRow[]>>>> = {
  [FIXTURE_SEASONS[1].seasonId]: archiveOf(season0Entries()),
};

const BADGES = ['gold', 'silver', 'bronze'] as const;
/** A gladiator's season awards from the archives, oldest season first (a first place also holds the champion title). */
export function fixturePrestige(gladiatorId: GladiatorId): PrestigeAward[] {
  const awards: PrestigeAward[] = [];
  for (const [seasonId, archive] of Object.entries(FIXTURE_ARCHIVE).sort(([p], [q]) => Number(p) - Number(q))) {
    for (const league of LEAGUE_ORDER) {
      for (const row of archive[league]) {
        if (row.gladiatorId === gladiatorId && row.awardPlace !== null) {
          awards.push({ seasonId, league, place: row.awardPlace, badge: BADGES[row.awardPlace - 1], title: row.awardPlace === 1 ? 'champion' : null });
        }
      }
    }
  }
  return awards;
}
