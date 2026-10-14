// Projects private Task 19 tournament graphs to the public TournamentView a server would return at a given time, and
// builds the camp actors of a fixture tournament. It imports no JSON and no engine code (domain types only), so
// browser specs can use it; tests/domain/tournament-fixtures.test.ts runs the real domain and commits the views.
//
// The projection is an explicit whitelist, never a spread of the graph: no seeds (the graph holds none), no fighter
// snapshots, ratings, seeded ranks or private outcomes. Entrants are listed in a neutral public order (by name), not
// in the private seeded rank order. A bout's result appears only once its round's reveal time has passed (byes at
// round 1's time, as the Task 19 phase 1 report proposes), with the logged winner; participants of a future round stay
// hidden inside the null result. Placements appear only once the tournament is settled at minute 80.
import type { TournamentGraph, TournamentOutcome } from '../../supabase/functions/_shared/domain/tournament.ts';
import type { BattleLog } from '../../supabase/functions/_shared/contracts/events.ts';
import type { PublicActor, TournamentBout, TournamentEntrant, TournamentView } from '../../supabase/functions/_shared/contracts/reads.ts';
import { ARENA_GLADIATORS, fixtureUuid } from './arena-ids.ts';
import {
  TOURNAMENT_LOOKS, TOURNAMENT_SLOT_MS, TOURNAMENTS, gladiatorKeyOf, tournamentActivityId, tournamentId, tournamentSlotIndex,
  type TournamentKey,
} from './tournament-ids.ts';

const REPLAY_KEPT_MS = 604_800_000;

/** The public entrant fields of a fixture gladiator: id, name and class. */
export function entrantOf(gladiatorId: string): TournamentEntrant {
  const key = gladiatorKeyOf(gladiatorId);
  if (!key) throw new Error(`not a fixture gladiator: ${gladiatorId}`);
  return { gladiatorId, name: ARENA_GLADIATORS[key].name, classId: TOURNAMENT_LOOKS[key].classId };
}
const byName = (a: TournamentEntrant, b: TournamentEntrant) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.gladiatorId < b.gladiatorId ? -1 : 1);
const publicEntrants = (ids: readonly string[]) => ids.map(entrantOf).sort(byName);

const frame = (key: TournamentKey) => {
  const { startsAtMs, league } = TOURNAMENTS[key];
  return { id: tournamentId(key), league, slotIndex: tournamentSlotIndex(key), startsAtMs, endsAtMs: startsAtMs + TOURNAMENT_SLOT_MS };
};

/** A tournament before its cutoff: no entrants, bracket or placements are known yet. */
export function scheduledView(key: TournamentKey): TournamentView {
  return { ...frame(key), status: 'scheduled', entrants: [], bouts: [], placements: [] };
}

/** A league with fewer than two qualifiers: no bracket; its entrants ran regular Arena in the same slot. */
export function insufficientView(key: TournamentKey): TournamentView {
  const entrants = TOURNAMENTS[key].entrants.map(g => ARENA_GLADIATORS[g].id);
  return { ...frame(key), status: 'insufficient-entrants', entrants: publicEntrants(entrants), bouts: [], placements: [] };
}

/**
 * The public view of a private graph at server time `asOfMs`. `outcomes` (`tournamentOutcomes(graph)`) fill the
 * placements once `asOfMs` reaches the settlement; before that the view is active with no placements.
 */
export function projectTournament(graph: TournamentGraph, outcomes: readonly TournamentOutcome[] | null, asOfMs: number): TournamentView {
  const entrants = publicEntrants(graph.entries.map(entry => entry.gladiatorId));
  const entrant = (id: string | null): TournamentEntrant => {
    const e = entrants.find(x => x.gladiatorId === id);
    if (!e) throw new Error(`unknown entrant ${id}`);
    return { gladiatorId: e.gladiatorId, name: e.name, classId: e.classId };
  };
  const bouts: TournamentBout[] = graph.bouts.map(bout => {
    const result = bout.result !== null && asOfMs >= bout.revealAtMs ? bout.result : null;
    let revealedResult: TournamentBout['revealedResult'] = null;
    if (result && bout.bye) revealedResult = { participants: [entrant(result.winnerId)], winnerId: result.winnerId, bye: true };
    else if (result) {
      const log = structuredClone(result.log) as BattleLog;
      revealedResult = { participants: log.participants.map(p => entrant(p.gladiatorId)), winnerId: result.winnerId, bye: false, battleLog: log };
    }
    return { id: bout.id, round: bout.round, position: bout.position, parentBoutIds: [...bout.parentBoutIds], revealedResult };
  });
  const settled = outcomes !== null && asOfMs >= graph.settlesAtMs;
  const name = (id: string) => entrant(id).name;
  const placements: TournamentView['placements'] = !settled ? [] : [...outcomes]
    .sort((a, b) => a.place - b.place || (name(a.gladiatorId) < name(b.gladiatorId) ? -1 : 1))
    .map(o => ({
      gladiatorId: o.gladiatorId, place: o.place,
      // ActivitySummary is the current contract; no rating, rank or placement grant leaves the private outcome.
      summary: {
        activityId: o.activityId, resolvedKind: 'tournament', result: o.result, success: o.success,
        rewards: { money: o.rewards.money, renown: o.rewards.renown, xp: o.rewards.xp, attributePoints: o.rewards.attributePoints, items: [], overflowMoney: o.rewards.overflowMoney },
        receiptId: fixtureUuid(`tournament-receipt-${graph.id}-${o.gladiatorId}`), settledAtMs: graph.settlesAtMs,
        replayExpiry: { state: 'available', expiresAtMs: graph.settlesAtMs + REPLAY_KEPT_MS },
      },
    }));
  return {
    id: graph.id, league: graph.league, slotIndex: graph.slotIndex, startsAtMs: graph.startsAtMs, endsAtMs: graph.settlesAtMs,
    status: asOfMs < graph.startsAtMs ? 'scheduled' : settled ? 'completed' : asOfMs < graph.settlesAtMs ? 'active' : 'processing',
    entrants, bouts, placements,
  };
}

/** The tournament's entrants as public camp actors in the arena during its slot (location `tournament`). */
export function tournamentCampActors(key: TournamentKey): PublicActor[] {
  const { startsAtMs, league, entrants } = TOURNAMENTS[key];
  return entrants.map(g => ({
    gladiatorId: ARENA_GLADIATORS[g].id, name: ARENA_GLADIATORS[g].name, classId: TOURNAMENT_LOOKS[g].classId,
    equipmentSilhouettes: [...TOURNAMENT_LOOKS[g].silhouettes], league, level: TOURNAMENT_LOOKS[g].level,
    phase: 'afternoon', location: 'tournament', activityId: tournamentActivityId(key, g), activityStatus: 'active',
    startsAtMs, endsAtMs: startsAtMs + TOURNAMENT_SLOT_MS, visibleStage: null,
  }));
}
