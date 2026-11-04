// Words of the seasons UI (Task 21.4, plan Decision 8): Arena standings' season picker, countdown, prizes and medals, and
// the season titles and badges on profile cards. Everything comes from the reads (SeasonView, StandingRow, PrestigeAward)
// and RULES_V1's season placements; nothing here decides an award or a placement (SQL is the one authority).
//
// Patch 1.6 (spec "Season card (a v2 season)"): a season pays the prizes of the rules version that opened it (its `rulesVersion`, M27's
// `seasons.rules_version`; absent is v1). A v2 season's card shows every league's gold in a table (`seasonPrizeTable`) and one line for the
// renown, title and badges (`seasonPrizeNote`); a v1 season (season 1) keeps today's list. The numbers are its own rules', never typed here.
import type { LeagueId } from '@contracts/commands';
import type { PrestigeAward, SeasonView, StandingRow } from '@contracts/reads';
import { seasonPrizes } from '@domain/economy';
import { isRulesV2 } from '@domain/rules';
import { RULES_V1 } from '@domain/rules-v1';
import type { ClockMode } from '../../lib/clock-setting';
import { displayRules } from '../../lib/rules-version';
import { dayText, timeOfDay } from '../../lib/time-format';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const leagueWord = (league: LeagueId) => capital(league);

const MEDALS: Readonly<Record<string, string>> = { gold: '🥇', silver: '🥈', bronze: '🥉' };
/** The medal of a badge (the placements' gold, silver and bronze; RULES_V1 types a badge as text), or nothing for another. */
export const medalOf = (badge: string): string => MEDALS[badge] ?? '';
const ORDINALS = ['1st', '2nd', '3rd'] as const;
/** The season prize table's place headers: "1st", "2nd", "3rd". */
export const PLACE_HEADERS: readonly string[] = ORDINALS;
const LEAGUES: readonly LeagueId[] = ['bronze', 'silver', 'gold', 'champion'];

/** A season's gold prizes by league (a v2 season: one row per league, in league order, 1st to 3rd), or none by league (v1). */
export type SeasonPrizeTable = { byLeague: false } | { byLeague: true; rows: { league: LeagueId; gold: readonly number[] }[] };

/** The gold table of a season opened under `rulesVersion`: by league for 'v2'; for 'v1', an absent or an unknown version, none. */
export function seasonPrizeTable(rulesVersion: string | undefined): SeasonPrizeTable {
  const rules = displayRules(rulesVersion);
  if (!isRulesV2(rules)) return { byLeague: false };
  return { byLeague: true, rows: LEAGUES.map(league => ({ league, gold: seasonPrizes(rules, league).map(prize => prize.money) })) };
}

const list = (items: readonly string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
/**
 * The line under a v2 season's table: the renown, the title and the badges every league pays ("Gold for each place. Every league also pays
 * 100, 60 and 40 renown, the Champion title for 1st, and gold, silver and bronze badges."), from its rules; null when the table is not shown.
 */
export function seasonPrizeNote(rulesVersion: string | undefined): string | null {
  const rules = displayRules(rulesVersion);
  if (!isRulesV2(rules)) return null;
  const places = seasonPrizes(rules, 'bronze');
  const titled = places.findIndex(place => place.title !== null);
  const title = titled < 0 ? '' : ` the ${capital(places[titled].title!)} title for ${ORDINALS[titled]},`;
  return `Gold for each place. Every league also pays ${list(places.map(place => String(place.renown)))} renown,${title} and ${list(places.map(place => place.badge))} badges.`;
}

/** "Season N" for a season id (its index as text; players count from 1), or "Season" when there is none yet. */
export function seasonName(seasonId: string): string {
  return /^\d{1,15}$/.test(seasonId) ? `Season ${Number(seasonId) + 1}` : 'Season';
}

/** Time left until `endsAtMs`: days and hours, then hours and minutes, then minutes (at least 1 while any is left), else "0 min". */
function countdown(leftMs: number): string {
  if (leftMs <= 0) return '0 min';
  if (leftMs >= DAY) {
    const days = Math.floor(leftMs / DAY);
    return `${days} ${days === 1 ? 'day' : 'days'} ${Math.floor((leftMs % DAY) / HOUR)} h`;
  }
  if (leftMs >= HOUR) return `${Math.floor(leftMs / HOUR)} h ${Math.floor((leftMs % HOUR) / MINUTE)} min`;
  return `${Math.max(1, Math.floor(leftMs / MINUTE))} min`;
}

/**
 * When a season ends: the countdown from `nowMs` (the shared display clock's time), the end in the viewer's time zone
 * ("Sun 15 Nov, 7:00 PM"; `timeZone` undefined is the runtime's zone) and in UTC ("5:00 PM UTC", with its own day when the
 * UTC date differs from the local one). The times of day are written in the form `clock` asks for (the device's clock setting):
 * "7:00 PM" and "5:00 PM UTC", or "19:00" and "17:00 UTC".
 */
export function seasonEnds(endsAtMs: number, nowMs: number, clock: ClockMode, timeZone?: string): { countdown: string; local: string; utc: string } {
  const localDay = dayText(endsAtMs, timeZone), utcDay = dayText(endsAtMs, 'UTC');
  const utcTime = `${timeOfDay(endsAtMs, clock, 'UTC')} UTC`;
  return { countdown: countdown(endsAtMs - nowMs), local: `${localDay}, ${timeOfDay(endsAtMs, clock, timeZone)}`, utc: utcDay === localDay ? utcTime : `${utcDay}, ${utcTime}` };
}

/** The picker's label: "Season 2 · current" for the open season, "Season 1 · ended Sun 18 Oct" (local date) for a closed one. */
export function seasonLabel(season: SeasonView, timeZone?: string): string {
  const name = seasonName(season.seasonId);
  return season.closedAtMs === null ? `${name} · current` : `${name} · ended ${dayText(season.endsAtMs, timeZone)}`;
}

/** An award's badge chip: "🥇 Season 1 · Silver". */
export function badgeText(award: PrestigeAward): string {
  return `${medalOf(award.badge)} ${seasonName(award.seasonId)} · ${leagueWord(award.league)}`;
}

/** An award's title line, "Champion · Season 1 Silver", or null when it carries no title. */
export function titleText(award: PrestigeAward): string | null {
  return award.title === 'champion' ? `Champion · ${seasonName(award.seasonId)} ${leagueWord(award.league)}` : null;
}

/**
 * An archived row's place as its medal and its words ("🥇" and "1st · Champion"; "🥈" and "2nd"; "🥉" and "3rd"), the medal and
 * title from RULES_V1's placements. The pill shows the medal as decoration, so the words are read once.
 */
export function placeParts(place: 1 | 2 | 3): { medal: string; words: string } {
  const placement = RULES_V1.seasons.placements[place - 1];
  return { medal: medalOf(placement.badge), words: `${ORDINALS[place - 1]}${placement.title ? ` · ${capital(placement.title)}` : ''}` };
}

/** An archived row's place in one line: "🥇 1st · Champion", "🥈 2nd", "🥉 3rd". */
export function placeText(place: 1 | 2 | 3): string {
  const { medal, words } = placeParts(place);
  return `${medal} ${words}`;
}

/** The current season's footnote on the ✓ Eligible mark (the database's reward_eligible rule). */
export const ELIGIBLE_NOTE = `✓ Eligible: has ${RULES_V1.seasons.minimumHumanBouts} or more human bouts and this is their highest qualifying league.`;

/**
 * A finished season's footnote on promotion. A row with the minimum human bouts that is not reward-eligible qualified in
 * a higher league (the archive marks it promoted), so only that league could reward it (it may have placed outside the
 * medals there) and this league's medals pass to the next eligible rows: such rows ranked above the last medal are named
 * (up to three), without claiming a reward. Otherwise the rule is stated.
 */
export function promotionNote(rows: readonly StandingRow[], league: LeagueId): string {
  const { minimumHumanBouts, placements } = RULES_V1.seasons;
  const medals = rows.filter(r => r.awardPlace !== null).map(r => r.rank);
  // With fewer medals than places, any such row would have taken one; otherwise only rows above the last medal matter.
  const last = medals.length >= placements.length ? Math.max(...medals) : Infinity;
  const skipped = rows.filter(r => r.promoted && !r.rewardEligible && r.humanWins + r.humanLosses >= minimumHumanBouts && r.rank < last).map(r => r.name);
  if (!skipped.length) {
    return `A gladiator promoted during the season is rewarded only in their highest league with at least ${minimumHumanBouts} human bouts; a lower league’s medals then go to its next eligible gladiators.`;
  }
  const medalsGo = `and the ${leagueWord(league)} medals go to the next eligible gladiators.`;
  if (skipped.length === 1) return `${skipped[0]} was promoted and qualified in a higher league, so only that league can reward ${skipped[0]}, ${medalsGo}`;
  const named = skipped.length > 3 ? [...skipped.slice(0, 3), `${skipped.length - 3} more`] : skipped;
  const names = `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
  return `${names} were promoted and qualified in higher leagues, so only those leagues can reward ${names}, ${medalsGo}`;
}

/**
 * The owner's progress to the minimum human bouts in a league this season (NPC bouts never count). The league is named, since
 * a gladiator promoted mid-season may already qualify in a lower one and be rewarded there if it places.
 */
export function qualifyText(humanBouts: number, league: LeagueId): string {
  const { minimumHumanBouts } = RULES_V1.seasons;
  const left = minimumHumanBouts - humanBouts;
  if (left > 0) return `${left} more human ${left === 1 ? 'bout' : 'bouts'} in the ${leagueWord(league)} league to qualify there. NPC bouts do not count.`;
  return `Qualified: at least ${minimumHumanBouts} human bouts in the ${leagueWord(league)} league, so a top-three place among its eligible gladiators wins a season reward.`;
}
