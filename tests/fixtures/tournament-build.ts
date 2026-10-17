// Projects private Task 19 tournament graphs to the public TournamentView a server would return at a given time, and
// builds the camp actors of a fixture tournament and the owner's own tournament timeline. It imports no JSON and no
// engine code (domain types only), so browser specs can use it; tests/domain/tournament-fixtures.test.ts runs the real
// domain and commits the views and timelines.
//
// The projection is an explicit whitelist, never a spread of the graph, and mirrors Task 19 phase 2b's public rows: no
// seeds (the graph holds none), fighter snapshots, ratings, private outcomes, rewards or receipts. Entrants are listed
// in a neutral public order (by name). From the start the bracket carries its size, rounds and seeded first-round slots,
// so the byes are public then too; a fought bout's result appears only once its round's reveal time has passed, with
// the logged winner, and participants of a future round stay hidden inside the null result. Placements (public place
// and Task 10's six safe completion fields) appear only once the tournament is settled at minute 80; an owner reads its
// own rewards from its own activity timeline.
import type { TournamentGraph, TournamentOutcome } from '../../supabase/functions/_shared/domain/tournament.ts';
import type { ActivitySummary, BattleLog, PublicActivitySummary, RevealedStage, RevealedTimeline } from '../../supabase/functions/_shared/contracts/events.ts';
import type { PublicActor, TournamentBout, TournamentEntrant, TournamentView } from '../../supabase/functions/_shared/contracts/reads.ts';
import type { LeagueId } from '../../supabase/functions/_shared/contracts/commands.ts';
import { ARENA_GLADIATORS, fixtureUuid, type ArenaGladiatorKey } from './arena-ids.ts';
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
  return { ...frame(key), status: 'scheduled', bracket: null, entrants: [], bouts: [], placements: [] };
}

/** A league with fewer than two qualifiers: no bracket; its entrants ran regular Arena in the same slot. */
export function insufficientView(key: TournamentKey): TournamentView {
  const entrants = TOURNAMENTS[key].entrants.map(g => ARENA_GLADIATORS[g].id);
  return { ...frame(key), status: 'insufficient-entrants', bracket: null, entrants: publicEntrants(entrants), bouts: [], placements: [] };
}

/** Task 10's six safe fields of an entrant's settled tournament activity, as its public completion shows them. */
function completionOf(graph: TournamentGraph, o: TournamentOutcome): PublicActivitySummary {
  return { activityId: o.activityId, resolvedKind: 'tournament', result: o.result, success: o.success, settledAtMs: graph.settlesAtMs,
    replayExpiry: { state: 'available', expiresAtMs: graph.settlesAtMs + REPLAY_KEPT_MS } };
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
  const started = asOfMs >= graph.startsAtMs;
  const bouts: TournamentBout[] = graph.bouts.map(bout => {
    // A bye is public from the start (the bracket slots); a fought result from its round's reveal time.
    const result = bout.result !== null && (bout.bye ? started : asOfMs >= bout.revealAtMs) ? bout.result : null;
    let revealedResult: TournamentBout['revealedResult'] = null;
    if (result && bout.bye) revealedResult = { participants: [entrant(result.winnerId)], winnerId: result.winnerId, bye: true };
    else if (result) {
      const log = structuredClone(result.log) as BattleLog;
      revealedResult = { participants: log.participants.map(p => entrant(p.gladiatorId)), winnerId: result.winnerId, bye: false, battleLog: log };
    }
    return { id: bout.id, round: bout.round, position: bout.position, parentBoutIds: [...bout.parentBoutIds], revealedResult };
  });
  const settled = outcomes !== null && asOfMs >= graph.settlesAtMs;
  const placements: TournamentView['placements'] = !settled ? [] : [...outcomes]
    .sort((a, b) => a.place - b.place || (a.gladiatorId < b.gladiatorId ? -1 : 1))
    .map(o => ({ gladiatorId: o.gladiatorId, place: o.place, completion: completionOf(graph, o) }));
  return {
    id: graph.id, league: graph.league, slotIndex: graph.slotIndex, startsAtMs: graph.startsAtMs, endsAtMs: graph.settlesAtMs,
    status: !started ? 'scheduled' : settled ? 'completed' : asOfMs < graph.settlesAtMs ? 'active' : 'processing',
    bracket: started ? { size: graph.size, rounds: graph.rounds, slots: graph.bouts.filter(b => b.round === 1).flatMap(b => [...b.placed!]) } : null,
    entrants, bouts, placements,
  };
}

const roundLabel = (round: number, rounds: number) =>
  round === rounds ? 'Final' : round === rounds - 1 ? 'Semifinal' : round === rounds - 2 ? 'Quarterfinal' : `Round ${round}`;
/**
 * One entrant's own settled tournament timeline at server time `asOfMs`, as Task 19 phase 2b publishes it: staging from
 * the start until its first fought bout's reveal, one stage per fought bout at its round's reveal with the shared log and
 * its own label, and the zero-length return when credited; plus its owner-only summary (rewards, receipt, rating change)
 * and the public completion.
 */
export function ownerTimeline(graph: TournamentGraph, o: TournamentOutcome, asOfMs: number): RevealedTimeline {
  const id = o.gladiatorId, activityId = o.activityId;
  const fought = graph.bouts.filter(b => !b.bye && b.result !== null && (b.result.winnerId === id || b.result.loserId === id));
  const bye = graph.bouts.some(b => b.bye && b.result?.winnerId === id);
  const stages: RevealedStage[] = [
    { id: `${activityId}:0`, kind: 'staging', revealedAtMs: graph.startsAtMs, startedAtMs: graph.startsAtMs,
      endsAtMs: graph.revealAtMs[bye ? 1 : 0], label: 'Tournament staging' },
    ...fought.map((b): RevealedStage => ({ id: `${activityId}:${b.round}`, kind: 'bout', revealedAtMs: b.revealAtMs, startedAtMs: b.revealAtMs,
      endsAtMs: b.revealAtMs + b.result!.log!.durationMs, label: `${roundLabel(b.round, graph.rounds)}: ${b.result!.winnerId === id ? 'victory' : 'defeat'}`,
      battleLog: structuredClone(b.result!.log) as BattleLog })),
    { id: `${activityId}:${graph.rounds + 1}`, kind: 'return', revealedAtMs: graph.settlesAtMs, startedAtMs: graph.settlesAtMs,
      endsAtMs: graph.settlesAtMs, label: 'Results credited' },
  ];
  const completion = completionOf(graph, o);
  const summary: ActivitySummary = { activityId, resolvedKind: 'tournament', result: o.result, success: o.success,
    rewards: { money: o.rewards.money, renown: o.rewards.renown, xp: o.rewards.xp, attributePoints: o.rewards.attributePoints, items: [],
      overflowMoney: o.rewards.overflowMoney },
    receiptId: fixtureUuid(`tournament-receipt-${graph.id}-${id}`), settledAtMs: graph.settlesAtMs, replayExpiry: completion.replayExpiry,
    ratingDelta: o.ratingDelta };
  return { activityId, serverNowMs: asOfMs, visibleThroughMs: asOfMs, stages, summary, completion };
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

/**
 * A large league tournament for scale checks (Task 13.9: the Task 19 R4 ring schedule and the late-joiner log
 * measurement): `count` synthetic entrants in the tournament slot that starts at `startsAtMs`, the round-1 pairs seated
 * first and one bye for each remaining pair (so 50 entrants fight 18 round-1 bouts in a 64-slot bracket), and every
 * result published, each bout's first seat winning. Each fought result carries a battle log cloned from `templates` in
 * turn, its two combatants renamed to the bout's entrants and its participants in the log's order, as Task 19 writes
 * them. Real engine logs, built without the engine, so browser specs can use it. The stage core hides each result until
 * its round's reveal, and a live route serves only the rows that are due.
 */
export function largeTournament(count: number, options: { startsAtMs: number; league: LeagueId; templates: readonly BattleLog[] }): { view: TournamentView; actors: PublicActor[] } {
  const { startsAtMs, league, templates } = options;
  const slotIndex = startsAtMs / TOURNAMENT_SLOT_MS;
  const id = `tournament:${slotIndex}:${league}`;
  const keys = Object.keys(TOURNAMENT_LOOKS) as ArenaGladiatorKey[];
  const seeded: TournamentEntrant[] = Array.from({ length: count }, (_, i) => ({
    gladiatorId: fixtureUuid(`large-${id}-${i}`), name: `Entrant ${String(i + 1).padStart(2, '0')}`, classId: TOURNAMENT_LOOKS[keys[i % keys.length]].classId,
  }));
  let size = 1, rounds = 0;
  while (size < count) { size *= 2; rounds += 1; }
  const fought = count - size / 2;
  const slots = Array.from({ length: size / 2 }, (_, p) => (p < fought ? [seeded[2 * p], seeded[2 * p + 1]] : [seeded[fought + p], null])).flat();
  const named = new Map(seeded.map(e => [e.gladiatorId, e]));
  const winners = new Map<string, TournamentEntrant>();
  const bouts: TournamentBout[] = [];
  let used = 0;
  for (let round = 1; round <= rounds; round += 1) {
    for (let position = 0; position < size / 2 ** round; position += 1) {
      const boutId = `${id}:${round}:${position}`;
      const parentBoutIds = round === 1 ? [] : [`${id}:${round - 1}:${2 * position}`, `${id}:${round - 1}:${2 * position + 1}`];
      const sides = round === 1 ? [slots[2 * position], slots[2 * position + 1]].filter((s): s is TournamentEntrant => s !== null) : parentBoutIds.map(p => winners.get(p)!);
      winners.set(boutId, sides[0]);
      if (sides.length === 1) {
        bouts.push({ id: boutId, round, position, parentBoutIds, revealedResult: { participants: [{ ...sides[0] }], winnerId: sides[0].gladiatorId, bye: true } });
        continue;
      }
      const log = renamedLog(templates[used % templates.length], boutId, sides[0], sides[1]);
      used += 1;
      bouts.push({ id: boutId, round, position, parentBoutIds,
        revealedResult: { participants: log.participants.map(p => ({ ...named.get(p.gladiatorId!)! })), winnerId: log.winnerId, bye: false, battleLog: log } });
    }
  }
  const view: TournamentView = { id, league, slotIndex, startsAtMs, endsAtMs: startsAtMs + TOURNAMENT_SLOT_MS, status: 'active',
    bracket: { size, rounds, slots: slots.map(s => s?.gladiatorId ?? null) }, entrants: [...seeded].sort(byName), bouts, placements: [] };
  const actors: PublicActor[] = seeded.map((e, i) => {
    const look = TOURNAMENT_LOOKS[keys[i % keys.length]];
    return { gladiatorId: e.gladiatorId, name: e.name, classId: look.classId, equipmentSilhouettes: [...look.silhouettes], league, level: look.level,
      phase: 'afternoon', location: 'tournament', activityId: fixtureUuid(`large-activity-${id}-${i}`), activityStatus: 'active',
      startsAtMs, endsAtMs: startsAtMs + TOURNAMENT_SLOT_MS, visibleStage: null };
  });
  return { view, actors };
}

/** `template` as bout `battleId`, its winner renamed to `winner` and its loser to `loser` (ids, names and every event). */
function renamedLog(template: BattleLog, battleId: string, winner: TournamentEntrant, loser: TournamentEntrant): BattleLog {
  const loserId = template.participants.find(p => p.id !== template.winnerId)!.id;
  const to = new Map([[template.winnerId, winner], [loserId, loser]]);
  const rename = (combatant: string) => to.get(combatant)!.gladiatorId;
  const participants = template.participants.map(p => ({ ...structuredClone(p), id: rename(p.id), gladiatorId: rename(p.id), name: to.get(p.id)!.name })) as unknown as BattleLog['participants'];
  const events = template.events.map(e => (e.kind === 'attack' ? { ...e, attackerId: rename(e.attackerId), defenderId: rename(e.defenderId) }
    : { ...e, winnerId: rename(e.winnerId), loserId: rename(e.loserId) }));
  return { ...structuredClone(template), battleId, participants, events, winnerId: winner.gladiatorId };
}
