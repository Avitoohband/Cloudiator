// Words for the Arena card and standings, from the stage core's state and the credited summary only. Nothing here
// computes a result, reward, rating or another player's league index.
import type { ActivitySummary } from '@contracts/events';
import type { ClassId, LeagueId } from '@contracts/commands';
import { RULES_V1 } from '@domain/rules-v1';
import { ARENA_REVEAL_MS, ARENA_SLOT_MS, type ArenaResult, type ArenaStageState } from '../../game/arena-stage';

/** The slot's reveal and settlement minutes (60 and 80 in rules v1). */
export const REVEAL_MINUTE = ARENA_REVEAL_MS / 60_000;
export const SLOT_MINUTES = ARENA_SLOT_MS / 60_000;

/** The binding fallback disclosure (plan Step 1). */
export const NPC_DISCLOSURE = 'NPC opponent — reduced renown, no rating change';
export const NO_INJURY = 'Arena health is fight-local: no lasting injury and no gear lost.';

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
export const className = (classId: ClassId | null) => (classId ? capital(classId) : 'NPC');
export const leagueName = (league: LeagueId) => capital(league);

/** The card's headline for a phase. A credited bout is completed; its rewards show separately. */
export function phaseTitle(state: ArenaStageState): string {
  switch (state.phase) {
    case 'warming-up': return 'Warming up';
    case 'preparing': return 'Preparing';
    case 'bout': return 'Bout in progress';
    default: return 'Completed';
  }
}

/** What the phase means, for the owner or a spectator. Never names an outcome before the bout ends. */
export function phaseDetail(state: ArenaStageState, owner: boolean, revealAt: string | null): string {
  switch (state.phase) {
    // Worded without the phase title, so the title is the card's only "Warming up".
    case 'warming-up': return `In the arena staging area until the bout is revealed at minute ${REVEAL_MINUTE}${revealAt ? ` (${revealAt})` : ''}. The warm-up grants no training.`;
    case 'preparing': return state.awaitingSummary
      ? `Processing results: minute ${SLOT_MINUTES} has passed, but the bout and rewards are not published yet. Nothing is credited until the server records them.`
      // Only a known slot start can say that the reveal minute has passed.
      : state.minute !== null && state.minute >= REVEAL_MINUTE
        ? `Minute ${REVEAL_MINUTE} has passed, but the bout has not been published yet. It appears here as soon as it is revealed.`
        : 'The bout has not been published yet. It appears here as soon as it is revealed.';
    case 'bout': return 'The revealed bout is being fought now. Its result shows when it ends.';
    case 'completed': return owner
      ? state.awaitingSummary ? 'Processing results: the rewards and rating change appear once the server credits them.' : `Rewards and any rating change are credited at minute ${SLOT_MINUTES}.`
      : 'Rewards are private to the gladiator’s owner.';
    default: return 'The result is credited.';
  }
}

/**
 * Why the card cannot show an activity: the build has no Arena read yet (the live game until Task 10's timeline read
 * lands), the read found no activity, or a real read failed (temporary; the card reads again on focus).
 */
export function arenaUnavailableText(reason: 'build' | 'not-found' | 'unavailable'): string {
  return reason === 'build' ? 'The Arena card is not available in this build yet.'
    : reason === 'not-found' ? 'No Arena activity matches this selection.'
      : 'Arena activity cannot be loaded right now. Only revealed stages are ever shown.';
}

/** "Victory" or "Defeat", with how the logged winner won. The winner is always the logged winnerId. */
export function resultText(result: ArenaResult, names: { entrant: string; opponent: string }): { title: string; detail: string } {
  const winner = result.outcome === 'victory' ? names.entrant : names.opponent;
  const loser = result.outcome === 'victory' ? names.opponent : names.entrant;
  const detail = result.reason === 'tie-break'
    ? result.tieBreakReason === 'simultaneous-defeat'
      ? `Both fighters fell at the same moment. A seeded tie-break named ${winner} the winner.`
      : `Time ran out with equal shares of health. A seeded tie-break named ${winner} the winner.`
    : result.reason === 'health-fraction' ? `Time ran out. ${winner} kept the larger share of health.`
      : result.reason === 'defeat' ? `${loser} was defeated.` : `${winner} won.`;
  return { title: result.outcome === 'victory' ? 'Victory' : 'Defeat', detail };
}

/** Credited lines from the owner's summary: renown, then the rating change (human bouts) or none (NPC). */
export function creditedLines(summary: ActivitySummary): string[] {
  const renown = summary.rewards.renown;
  const lines = [renown ? `+${renown} renown` : 'No renown'];
  if (summary.ratingDelta === undefined) lines.push('No rating change');
  else lines.push(summary.ratingDelta === 0 ? 'Rating unchanged' : `Rating ${summary.ratingDelta > 0 ? '+' : '−'}${Math.abs(summary.ratingDelta)}`);
  return lines;
}

/** The fixed replay route for a revealed bout; fixture previews keep their mode. */
export function replayHref(replay: { activityId: string; stageId: string }, fixture: boolean): string {
  return `/replay/?${fixture ? 'mode=fixture&' : ''}activity=${encodeURIComponent(replay.activityId)}&stage=${encodeURIComponent(replay.stageId)}`;
}

/** League thresholds and rules from the spec (§8.1, §8.3), for the standings explanation. */
export function leagueRules(): { league: LeagueId; range: string }[] {
  const { silver, gold, champion } = RULES_V1.leagues;
  return [
    { league: 'bronze', range: `below ${silver}` },
    { league: 'silver', range: `${silver}–${gold - 1}` },
    { league: 'gold', range: `${gold}–${champion - 1}` },
    { league: 'champion', range: `${champion} and above` },
  ];
}
