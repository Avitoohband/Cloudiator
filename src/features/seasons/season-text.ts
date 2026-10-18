// Words of the seasons UI (Task 21.4, plan Decision 8): Arena standings' season picker, countdown, prizes and medals, and
// the season titles and badges on profile cards. Everything comes from the reads (SeasonView, StandingRow, PrestigeAward)
// and RULES_V1's season placements; nothing here decides an award or a placement (SQL is the one authority).
import type { LeagueId } from '@contracts/commands';
import type { PrestigeAward, SeasonView, StandingRow } from '@contracts/reads';
import { RULES_V1 } from '@domain/rules-v1';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const leagueWord = (league: LeagueId) => capital(league);

const MEDALS: Readonly<Record<string, string>> = { gold: '🥇', silver: '🥈', bronze: '🥉' };
/** The medal of a badge (the placements' gold, silver and bronze; RULES_V1 types a badge as text), or nothing for another. */
export const medalOf = (badge: string): string => MEDALS[badge] ?? '';
const ORDINALS = ['1st', '2nd', '3rd'] as const;

/** "Season N" for a season id (its index as text; players count from 1), or "Season" when there is none yet. */
export function seasonName(seasonId: string): string {
  return /^\d{1,15}$/.test(seasonId) ? `Season ${Number(seasonId) + 1}` : 'Season';
}

type DateParts = { day: string; time: string };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * A time's day ("Sun 15 Nov") and 24-hour time ("19:00") in a time zone (the runtime's when undefined). Intl gives only the
 * zone's numeric calendar fields; the names are fixed here, since ICU versions abbreviate differently (en-GB "Sept").
 */
function dateParts(ms: number, timeZone?: string): DateParts {
  const parts = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone })
    .formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === type)?.value);
  const [year, month, day] = [part('year'), part('month'), part('day')];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const pad = (n: number) => String(n).padStart(2, '0');
  return { day: `${WEEKDAYS[weekday]} ${day} ${MONTHS[month - 1]}`, time: `${pad(part('hour'))}:${pad(part('minute'))}` };
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
 * ("Sun 15 Nov, 19:00"; `timeZone` undefined is the runtime's zone) and in UTC ("17:00 UTC", with its own day when the
 * UTC date differs from the local one).
 */
export function seasonEnds(endsAtMs: number, nowMs: number, timeZone?: string): { countdown: string; local: string; utc: string } {
  const local = dateParts(endsAtMs, timeZone), utc = dateParts(endsAtMs, 'UTC');
  return { countdown: countdown(endsAtMs - nowMs), local: `${local.day}, ${local.time}`, utc: utc.day === local.day ? `${utc.time} UTC` : `${utc.day}, ${utc.time} UTC` };
}

/** The picker's label: "Season 2 · current" for the open season, "Season 1 · ended Sun 18 Oct" (local date) for a closed one. */
export function seasonLabel(season: SeasonView, timeZone?: string): string {
  const name = seasonName(season.seasonId);
  return season.closedAtMs === null ? `${name} · current` : `${name} · ended ${dateParts(season.endsAtMs, timeZone).day}`;
}

/** An award's badge chip: "🥇 Season 1 · Silver". */
export function badgeText(award: PrestigeAward): string {
  return `${medalOf(award.badge)} ${seasonName(award.seasonId)} · ${leagueWord(award.league)}`;
}

/** An award's title line, "Champion · Season 1 Silver", or null when it carries no title. */
export function titleText(award: PrestigeAward): string | null {
  return award.title === 'champion' ? `Champion · ${seasonName(award.seasonId)} ${leagueWord(award.league)}` : null;
}

/** An archived row's place: "🥇 1st · Champion", "🥈 2nd", "🥉 3rd" (medal and title from RULES_V1's placements). */
export function placeText(place: 1 | 2 | 3): string {
  const placement = RULES_V1.seasons.placements[place - 1];
  return `${medalOf(placement.badge)} ${ORDINALS[place - 1]}${placement.title ? ` · ${capital(placement.title)}` : ''}`;
}

/** The current season's footnote on the ✓ Eligible mark (the database's reward_eligible rule). */
export const ELIGIBLE_NOTE = `✓ Eligible: has ${RULES_V1.seasons.minimumHumanBouts} or more human bouts and this is their highest qualifying league.`;

/**
 * A finished season's footnote on promotion. A row with the minimum human bouts that is not reward-eligible qualified in
 * a higher league (the archive marks it promoted), so it is rewarded there only and this league's medals pass to the next
 * eligible rows: such rows ranked above the last medal are named (up to three). Otherwise the rule is stated.
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
  if (skipped.length === 1) return `${skipped[0]} was promoted and qualified in a higher league, so ${skipped[0]} is rewarded there only, ${medalsGo}`;
  const named = skipped.length > 3 ? [...skipped.slice(0, 3), `${skipped.length - 3} more`] : skipped;
  return `${named.slice(0, -1).join(', ')} and ${named.at(-1)} were promoted and qualified in a higher league, so they are rewarded there only, ${medalsGo}`;
}

/** The owner's progress to the minimum human bouts in its league this season (NPC bouts never count). */
export function qualifyText(humanBouts: number, league: LeagueId): string {
  const { minimumHumanBouts } = RULES_V1.seasons;
  const left = minimumHumanBouts - humanBouts;
  if (left > 0) return `${left} more human ${left === 1 ? 'bout' : 'bouts'} to qualify for season rewards. NPC bouts do not count.`;
  return `Qualified: at least ${minimumHumanBouts} human bouts in the ${leagueWord(league)} league, so a top-three place among its eligible gladiators wins a season reward.`;
}
