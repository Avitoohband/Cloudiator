// Words and times for the Tournaments panel, from the stage core's state and the viewer's own summary only. Times
// show in the viewer's time zone with the fixed UTC time beside them (spec §8.2: no local daylight-saving change moves
// a tournament). Nothing here computes a result, reward, rating or another player's eligibility.
import type { ActivityChoice, LeagueId } from '@contracts/commands';
import type { ActivitySummary } from '@contracts/events';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { RULES_V1 } from '@domain/rules-v1';
import {
  nextTournament, tournamentWindowAt, type BracketShape, type TournamentBoutState, type TournamentEntrantState, type TournamentRoundState,
  type TournamentStageState, type TournamentStatus,
} from '../../game/tournament-stage';

const FORMAT = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;

/**
 * A tournament time in the viewer's zone (or `timeZone`, for tests and captures) and in UTC, e.g.
 * `{ local: 'Wed 28 Oct, 18:20 GMT+1', utc: 'Wed 28 Oct, 17:20 UTC' }`. A zone at UTC+0 reads "UTC" (ICU writes "GMT" or "GMT+0").
 */
export function tournamentTimeText(ms: number, timeZone?: string): { local: string; utc: string } {
  const local = new Intl.DateTimeFormat('en-GB', { ...FORMAT, timeZone, timeZoneName: 'shortOffset' }).format(ms).replace(/ GMT(?:[+-]0+(?::00)?)?$/, ' UTC');
  const utc = new Intl.DateTimeFormat('en-GB', { ...FORMAT, timeZone: 'UTC', timeZoneName: 'short' }).format(ms);
  return { local, utc };
}
/** The local time with the UTC time in parentheses, or just the UTC time for a viewer at UTC+0. */
export function timeWithUtc(ms: number, timeZone?: string): string {
  const { local, utc } = tournamentTimeText(ms, timeZone);
  return local === utc ? utc : `${local} (${utc})`;
}

/** Time left: days, hours and minutes (rounded down); within the last hour, minutes and seconds (rounded up). */
export function countdownText(ms: number): string {
  if (!(ms > 0)) return 'now';
  if (ms < 3_600_000) {
    const seconds = Math.ceil(ms / 1000);
    return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), rest = minutes % 60;
  return `${days ? `${days} d ` : ''}${hours} h ${rest} min`;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The fixed cutoff, the tournament's start (v1: 17:20 UTC). */
export const CUTOFF_UTC = `${pad(RULES_V1.tournament.hourUtc)}:${pad(RULES_V1.tournament.minuteUtc)} UTC`;
/** Stamina needed at the cutoff: the Arena activity and the tournament must both be affordable (Task 19 partition). */
export const ENTRY_STAMINA = Math.max(RULES_V1.activityStamina.arena, RULES_V1.activityStamina.tournament);
const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

/** Spec §8.2 entry rules, as the registration section states them. */
export const ENTRY_RULES: readonly string[] = [
  `Entry needs automatic entry switched on, Arena scheduled for the afternoon (the tournament phase) and at least ${ENTRY_STAMINA} stamina at the cutoff, the tournament’s ${CUTOFF_UTC} start.`,
  `Tournaments run on ${RULES_V1.tournament.utcWeekdays.map(d => DAYS[d]).join(' and ')} at ${CUTOFF_UTC} for one 80-minute afternoon slot. Entry works without an open browser.`,
  'With automatic entry off, an Arena afternoon stays a normal Arena bout.',
  'A change made after a tournament’s cutoff applies from the next tournament.',
  `Each league holds its own bracket when at least ${RULES_V1.tournament.minimumEntrants} gladiators qualify; otherwise they fight regular Arena that slot.`,
  'The whole tournament costs stamina once. Every bout starts at full health, and an eliminated gladiator stays to spectate until the tournament ends.',
];

/** Which tournament a registration change made now applies to; during a tournament, the next one. */
export function registrationNote(displayNowMs: number, timeZone?: string): { fixed: string | null; applies: string } {
  const next = timeWithUtc(nextTournament(displayNowMs).startsAtMs, timeZone);
  return tournamentWindowAt(displayNowMs)
    ? { fixed: `Entries for the tournament running now were fixed at its ${CUTOFF_UTC} cutoff.`, applies: `A change now applies from the next tournament, ${next}.` }
    : { fixed: null, applies: `A change now applies to the next tournament, ${next}, if it is saved before that cutoff.` };
}

/** The owner's afternoon choice, with a note when it is not Arena (no tournament entry). */
export function afternoonText(choice: ActivityChoice): string {
  if (choice.kind === 'arena') return 'Arena';
  const name = choice.kind === 'expedition' ? `Expedition: ${CATALOG_V1.expeditions[choice.expeditionId]?.name ?? choice.expeditionId}`
    : choice.kind === 'training' ? 'Training' : 'Rest';
  return `${name} (not Arena)`;
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
export const leagueName = (league: LeagueId) => capital(league);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function statusText(status: TournamentStatus): string {
  switch (status) {
    case 'scheduled': return 'Scheduled';
    case 'active': return 'In progress';
    case 'processing': return 'Processing results';
    case 'completed': return 'Completed';
    default: return 'Not held: too few entrants';
  }
}

/** What the status means now. Never names a result. */
export function statusDetail(state: TournamentStageState, timeZone?: string): string {
  switch (state.status) {
    case 'scheduled': return `Entrants and the bracket are published at the start, ${timeWithUtc(state.startsAtMs, timeZone)}.`;
    case 'active': {
      const next = state.rounds.find(r => !r.due);
      return next ? `Next reveal: ${next.label}, ${timeWithUtc(next.revealAtMs, timeZone)}.`
        : `Every round is revealed. Placements settle at minute 80, ${timeWithUtc(state.endsAtMs, timeZone)}.`;
    }
    case 'processing': return !state.shape ? 'The bracket is not published yet. It appears here once the server records the entrants.'
      : state.displayNowMs >= state.endsAtMs ? 'Minute 80 has passed, but the placements are not published yet. Nothing is credited until the server records them.'
        : 'A round is due, but its results are not published yet. They appear as soon as they are revealed.';
    case 'completed': return 'Placements and rewards were credited at minute 80.';
    default: {
      const n = state.entrants.length;
      return n === 0 ? `No gladiator qualified in the ${leagueName(state.league)} league, so no bracket was held this slot.`
        : `Only ${plural(n, 'gladiator')} qualified in the ${leagueName(state.league)} league, so no bracket was held: ${n === 1 ? 'that entrant' : 'they'} fought regular Arena this slot (with an NPC opponent where needed).`;
    }
  }
}

export const shapeText = (shape: BracketShape) => `${shape.size}-slot bracket · ${plural(shape.rounds, 'round')} · ${plural(shape.byes, 'bye')}`;

/** A round's headline: one "Result preparing" until its results show. */
export function roundStatus(round: TournamentRoundState): string {
  if (!round.due || round.delayed) return 'Result preparing';
  return round.bouts.some(b => b.status === 'fighting') ? 'Bouts in progress' : 'Results revealed';
}
export function roundNote(round: TournamentRoundState, timeZone?: string): string | null {
  if (!round.due) return `Revealed at ${timeWithUtc(round.revealAtMs, timeZone)}.`;
  if (round.delayed) return `These results were due at ${timeWithUtc(round.revealAtMs, timeZone)} but are not published yet. They appear here as soon as they are revealed.`;
  return null;
}

/** How the logged winner won, from its fight summary (no log needed). The winner is always the logged winnerId. */
export function victoryText(bout: TournamentBoutState): string | null {
  const fight = bout.fight;
  if (!fight || bout.status !== 'decided') return null;
  if (fight.victoryReason === 'tie-break') return fight.tieBreakReason === 'simultaneous-defeat' ? 'Both fell at 0 HP; a seeded tie-break decided it.' : 'Time ran out with equal health; a seeded tie-break decided it.';
  if (fight.victoryReason === 'health-fraction') return 'Time ran out; the winner kept the larger share of health.';
  const loser = bout.sides.find(s => s?.gladiatorId === bout.loserId);
  return loser ? `${loser.name} was defeated.` : null;
}

export function roleText(entrant: TournamentEntrantState, state: TournamentStageState): string {
  const label = (round: number) => state.rounds.find(r => r.round === round)?.label ?? `Round ${round}`;
  switch (entrant.role) {
    case 'waiting': return 'Waiting';
    case 'fighting': return 'Fighting';
    case 'spectating': return `Eliminated in the ${label(entrant.eliminatedInRound!)} · spectating`;
    case 'champion': return 'Champion';
    default: return 'Regular Arena';
  }
}

export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/** The viewer's own credited placement rewards (money and renown only; a tournament grants nothing else). */
export function creditedText(summary: ActivitySummary): string {
  const parts = [summary.rewards.money ? `+${summary.rewards.money} money` : null, summary.rewards.renown ? `+${summary.rewards.renown} renown` : null].filter(Boolean);
  return parts.length ? parts.join(', ') : 'nothing';
}

/** The viewer's own place in the tournament now, or null without a bracket. */
export function viewerText(state: TournamentStageState, hasViewer: boolean, timeZone?: string): string | null {
  if (!state.shape || !hasViewer) return null;
  const me = state.viewer.entrant;
  if (!me) return 'You are not entered in this tournament.';
  const label = (round: number) => state.rounds.find(r => r.round === round)?.label ?? `Round ${round}`;
  switch (me.role) {
    case 'fighting': return 'Your bout is being fought now.';
    case 'spectating': return `You were eliminated in the ${label(me.eliminatedInRound!)}. You stay in the tournament as a spectator until it ends at ${timeWithUtc(state.endsAtMs, timeZone)}; this slot has no other activity for you.`;
    case 'champion': return 'You are the champion of this tournament!';
    default: {
      const due = state.rounds.filter(r => r.due);
      if (!due.length) {
        // A bye is public from the start: its receiver's first bout comes a round later.
        const bye = state.rounds[0].bouts.some(b => b.status === 'bye' && b.winnerId === me.gladiatorId);
        return bye ? `You are entered with a bye in the ${state.rounds[0].label}. Your first bout is revealed at ${timeWithUtc(state.rounds[1].revealAtMs, timeZone)}.`
          : `You are entered. Your first bout is revealed at ${timeWithUtc(state.rounds[0].revealAtMs, timeZone)}.`;
      }
      // "You advance" only after a shown win or bye in every due round; the first due round without one holds the
      // viewer's unpublished (delayed) result. A waiting entrant has lost no shown bout.
      const open = due.find(r => !r.bouts.some(b => (b.status === 'decided' || b.status === 'bye') && b.winnerId === me.gladiatorId));
      if (open) return `Your ${open.label} result is not published yet. It appears here as soon as it is revealed.`;
      const next = state.rounds.find(r => !r.due);
      return next ? `You advance. Your next bout is revealed at ${timeWithUtc(next.revealAtMs, timeZone)}.` : 'You advance. Your next result is being prepared.';
    }
  }
}
