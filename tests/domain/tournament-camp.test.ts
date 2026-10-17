import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PublicActor, TournamentView } from '@contracts/reads';
import type { MapData } from '@/game/assets';
import { npcPostTiles } from '@/game/npcs';
import { layoutCamp, planActorRoutine } from '@/game/actors';
import { ringTiles } from '@/game/arena-layout';
import {
  TOURNAMENT_LOG_WINDOW_MS, TOURNAMENT_RETRY_MS, assignSpectators, campTournamentFights, campTournamentIds, campTournamentRoles, mergeCampFights,
  recordTournamentRead, spectatorSpots, tournamentIdOfActor, tournamentLogsDue, tournamentReadsDue, type TournamentRead,
} from '@/game/tournament-camp';
import { renderTournament, withTournamentLogs, withoutTournamentLogs } from '@/game/tournament-stage';
import { ARENA_ENTRY_MS, ARENA_RESULT_HOLD_MS, scheduleArenaRings, updateRingSchedule, type CampFight, type RingSlot } from '@/game/arena-layout';
import { ARENA_GLADIATORS } from '../fixtures/arena-ids';
import { largeTournament, tournamentCampActors } from '../fixtures/tournament-build';
import { TOURNAMENT_VIEWS, TOURNAMENTS, tournamentId } from '../fixtures/tournaments';

const MIN = 60_000;
const camp = JSON.parse(readFileSync('public/assets/camp/map.json', 'utf8')) as MapData;
const S = TOURNAMENTS.completed.startsAtMs;
const ACTORS = tournamentCampActors('completed');
const VIEWS = new Map<string, TournamentView>([[tournamentId('completed'), TOURNAMENT_VIEWS.completed]]);
const id = (name: keyof typeof ARENA_GLADIATORS) => ARENA_GLADIATORS[name].id;
const fightsAt = (minute: number, actors: PublicActor[] = ACTORS) => campTournamentFights(actors, VIEWS, S + minute * MIN);

describe('tournament fights in the camp', () => {
  it('finds each entrant’s tournament by its slot and league', () => {
    expect(new Set(ACTORS.map(tournamentIdOfActor))).toEqual(new Set([tournamentId('completed')]));
  });

  it('stages no fight before a round reveals, then each revealed bout of two camp entrants from its reveal time', () => {
    expect(fightsAt(19.99)).toEqual([]);
    const round1 = fightsAt(20);
    expect(round1).toHaveLength(4);
    const bouts = TOURNAMENT_VIEWS.completed.bouts.filter(b => b.round === 1);
    expect(round1.map(f => f.battleId).sort()).toEqual(bouts.map(b => b.id).sort());
    for (const fight of round1) {
      const log = bouts.find(b => b.id === fight.battleId)!.revealedResult!.battleLog!;
      expect(fight.log).toBe(log);
      expect(fight.startedAtMs).toBe(S + 20 * MIN);
      // The ring shows the result from the stage core's decision, when the Tournaments panel shows the winner.
      expect(fight.endsAtMs).toBe(S + 20 * MIN + log.durationMs);
      // Ring side a holds participant 0, as for Arena bouts; both activities are the entrants' tournament activities.
      expect(fight.fighters).toEqual(log.participants.map(p => p.gladiatorId));
      expect(fight.activities).toEqual(fight.fighters.map(g => ACTORS.find(a => a.gladiatorId === g)!.activityId));
    }
    // Earlier bouts stay listed (their ring windows are over), so a round's reveal never moves a scheduled fight.
    expect(fightsAt(40).map(f => f.battleId)).toEqual([...round1.map(f => f.battleId), ...TOURNAMENT_VIEWS.completed.bouts.filter(b => b.round === 2).map(b => b.id)]);
    expect(fightsAt(79)).toHaveLength(7);
  });

  it('needs both fighters in camp, never draws an NPC and leaves Arena entrants alone', () => {
    const withoutAster = ACTORS.filter(a => a.gladiatorId !== id('aster'));
    expect(fightsAt(20, withoutAster)).toHaveLength(3);
    const asArena = ACTORS.map(a => ({ ...a, location: 'arena' as const }));
    expect(fightsAt(20, asArena)).toEqual([]);
    expect(campTournamentFights(ACTORS, new Map(), S + 30 * MIN)).toEqual([]);
    for (const fight of fightsAt(79)) expect(fight.fighters.every(f => f !== null)).toBe(true);
  });

  it('merges tournament and Arena fights in start order, so they share the six rings', () => {
    const log = TOURNAMENT_VIEWS.pair.bouts[0].revealedResult!.battleLog!;
    const arena: CampFight = { battleId: 'arena-b', startedAtMs: S + 10 * MIN, endsAtMs: S + 10 * MIN + log.durationMs, log, fighters: ['x', null], activities: ['ax', 'ax'] };
    const merged = mergeCampFights(fightsAt(20), [arena]);
    expect(merged[0].battleId).toBe('arena-b');
    expect(merged).toHaveLength(5);
    const schedule = scheduleArenaRings(merged, 6);
    expect(new Set([...schedule.values()].map(s => s.ring)).size).toBe(5);
  });
});

describe('tournament roles in the camp', () => {
  it('gives every camp entrant its role at the display time', () => {
    const roles = (minute: number) => Object.fromEntries([...campTournamentRoles(ACTORS, VIEWS, S + minute * MIN)].map(([g, r]) => [g, r.role]));
    expect(new Set(Object.values(roles(5)))).toEqual(new Set(['waiting']));
    expect(new Set(Object.values(roles(20.1)))).toEqual(new Set(['fighting']));
    expect(roles(30)[id('aster')]).toBe('spectating');
    expect(roles(30)[id('decimus')]).toBe('waiting');
    expect(roles(79)[id('varro')]).toBe('champion');
    expect(Object.values(roles(79)).filter(r => r === 'spectating')).toHaveLength(7);
    expect(campTournamentRoles(ACTORS, VIEWS, S + 30 * MIN).get(id('aster'))!.eliminatedInRound).toBe(1);
    expect(campTournamentRoles(ACTORS, new Map(), S + 30 * MIN).size).toBe(0);
  });
});

describe('tournament entrants in the arena layout', () => {
  it('waits every entrant in the arena staging area, never in a ring before its revealed bout', () => {
    // A full stress case: 40 entrants, more than the staging spots.
    const many = Array.from({ length: 40 }, (_, i) => ({ ...ACTORS[i % ACTORS.length], gladiatorId: `t-${i}`, name: `T${i}` }));
    const { placements } = layoutCamp(many, camp, S / 4_800_000, { reserved: npcPostTiles() });
    expect(placements.size).toBe(40);
    const rings = ringTiles(camp);
    for (const p of placements.values()) {
      expect(p.zone).toBe('arena');
      expect(p.routine.variant).toBe('arena-staging');
      expect(p.partnerId).toBeUndefined();
      expect(rings.has(`${p.x},${p.y}`), `${p.x},${p.y}`).toBe(false);
    }
    expect(new Set(many.map(a => planActorRoutine(a, S / 4_800_000).variant))).toEqual(new Set(['arena-staging']));
  });
});

describe('spectator spots', () => {
  const spots = spectatorSpots(camp, npcPostTiles());
  const [cx, cy] = camp.arena!.centre;

  it('rings the arena outside its wall, on free walkable tiles of no other zone, facing the arena', () => {
    expect(spots.length).toBeGreaterThanOrEqual(49);
    expect(new Set(spots.map(s => `${s.x},${s.y}`)).size).toBe(spots.length);
    const stations = new Set(camp.zones.flatMap(z => z.stations).map(s => `${s.x},${s.y}`));
    const posts = npcPostTiles();
    for (const s of spots) {
      const d = Math.hypot(s.x + 0.5 - cx, s.y + 0.5 - cy);
      expect(camp.walkable[s.y][s.x], `${s.x},${s.y}`).toBe('1');
      expect(d).toBeGreaterThan(camp.arena!.radius + 0.5);
      expect(d).toBeLessThan(camp.arena!.radius + 3);
      expect(stations.has(`${s.x},${s.y}`) || posts.has(`${s.x},${s.y}`)).toBe(false);
      for (const z of camp.zones.filter(z => z.id !== 'arena')) {
        const b = z.bounds;
        expect(s.x >= b.x && s.y >= b.y && s.x < b.x + b.w && s.y < b.y + b.h, `${s.x},${s.y} in ${z.id}`).toBe(false);
      }
      // Facing the arena: south-facing spots stand north of it on screen (smaller x + y), and so on.
      const below = s.x + s.y < cx + cy;
      const left = s.x - s.y < cx - cy;
      expect(s.facing, `${s.x},${s.y}`).toBe(below ? (left ? 'se' : 'sw') : (left ? 'ne' : 'nw'));
    }
    // The gate stays clear for NPC opponents and walkers.
    expect(spots.some(s => Math.hypot(s.x + 0.5 - 28.5, s.y + 0.5 - 28.5) < 2.5)).toBe(false);
  });

  it('assigns spots by elimination round, then id, so earlier spectators never move', () => {
    const first = assignSpectators([{ gladiatorId: 'b', eliminatedInRound: 1 }, { gladiatorId: 'a', eliminatedInRound: 1 }], spots);
    expect(first.get('a')).toEqual(spots[0]);
    expect(first.get('b')).toEqual(spots[1]);
    const later = assignSpectators([{ gladiatorId: 'a', eliminatedInRound: 1 }, { gladiatorId: '0', eliminatedInRound: 2 }, { gladiatorId: 'b', eliminatedInRound: 1 }], spots);
    expect([later.get('a'), later.get('b'), later.get('0')]).toEqual([spots[0], spots[1], spots[2]]);
    // More spectators than spots: the rest keep their staging spot.
    expect(assignSpectators(Array.from({ length: spots.length + 3 }, (_, i) => ({ gladiatorId: `g${i}`, eliminatedInRound: 1 })), spots).size).toBe(spots.length);
  });
});

describe('tournament reads for the camp', () => {
  const known = (entries: [string, TournamentRead][]) => new Map(entries);
  const tid = tournamentId('completed');

  it('reads each entrant tournament once during its slot, again after a reveal mark, and on retry while results are missing', () => {
    expect(tournamentReadsDue(ACTORS, known([]), S + 5 * MIN)).toEqual([tid]);
    expect(tournamentReadsDue(ACTORS, known([]), S - 1)).toEqual([]);
    expect(tournamentReadsDue(ACTORS, known([]), S + 80 * MIN)).toEqual([]);
    const read = (minute: number, view: TournamentView | null = TOURNAMENT_VIEWS.completed): [string, TournamentRead] => [tid, { readAtMs: S + minute * MIN, view }];
    expect(tournamentReadsDue(ACTORS, known([read(5)]), S + 19 * MIN)).toEqual([]);
    expect(tournamentReadsDue(ACTORS, known([read(5)]), S + 20 * MIN)).toEqual([tid]);
    // A failed read is retried every 30 s.
    expect(tournamentReadsDue(ACTORS, known([read(5, null)]), S + 5 * MIN + TOURNAMENT_RETRY_MS - 1)).toEqual([]);
    expect(tournamentReadsDue(ACTORS, known([read(5, null)]), S + 5 * MIN + TOURNAMENT_RETRY_MS)).toEqual([tid]);
    // A view whose due round is unpublished is asked for again every 30 s.
    const opening = TOURNAMENT_VIEWS.opening;
    const openingActors = tournamentCampActors('opening');
    const o = TOURNAMENTS.opening.startsAtMs;
    const stale = known([[tournamentId('opening'), { readAtMs: o + 25 * MIN, view: opening }]]);
    expect(tournamentReadsDue(openingActors, stale, o + 25 * MIN + 29_000)).toEqual([]);
    expect(tournamentReadsDue(openingActors, stale, o + 25 * MIN + 30_000)).toEqual([tournamentId('opening')]);
    // Only tournament entrants count.
    expect(tournamentReadsDue(ACTORS.map(a => ({ ...a, location: 'arena' as const })), known([]), S + 5 * MIN)).toEqual([]);
  });
});

describe('one malformed camp actor (2b review M3)', () => {
  // Server projections constrain the league and the start, but the camp must never throw for one actor: an entrant
  // whose slot or league cannot name a tournament simply has none, and every other entrant keeps its tournament.
  const broken: PublicActor[] = [
    { ...ACTORS[0], gladiatorId: 'bad-league', name: 'Bad league', league: 'platinum' as never },
    { ...ACTORS[1], gladiatorId: 'bad-slot', name: 'Bad slot', startsAtMs: Number.NaN },
    { ...ACTORS[2], gladiatorId: 'negative-slot', name: 'Negative slot', startsAtMs: -4_800_000 },
  ];
  const all = [...broken, ...ACTORS];

  it('gives that actor no tournament and carries on with the rest', () => {
    for (const actor of broken) expect(tournamentIdOfActor(actor), actor.name).toBeNull();
    expect(() => campTournamentFights(all, VIEWS, S + 30 * MIN)).not.toThrow();
    expect(campTournamentFights(all, VIEWS, S + 30 * MIN)).toEqual(campTournamentFights(ACTORS, VIEWS, S + 30 * MIN));
    expect([...campTournamentRoles(all, VIEWS, S + 30 * MIN)]).toEqual([...campTournamentRoles(ACTORS, VIEWS, S + 30 * MIN)]);
    expect(tournamentReadsDue(all, new Map(), S + 5 * MIN)).toEqual([tournamentId('completed')]);
    expect(campTournamentIds(all)).toEqual(campTournamentIds(ACTORS));
  });
});

describe('processing re-reads in the camp (2b review I1)', () => {
  const tid = tournamentId('completed');
  /** The completed view as a server reports it while a settlement or reveal is stuck: processing. */
  const stuck: TournamentView = { ...TOURNAMENT_VIEWS.completed, status: 'processing' };
  const at = (seconds: number) => S + 61 * MIN + seconds * 1000;
  const due = (read: TournamentRead, seconds: number, options?: { focused?: boolean }) =>
    tournamentReadsDue(ACTORS, new Map([[tid, read]]), at(seconds), options).includes(tid);

  it('backs off 30 s, 60 s, 120 s, 240 s, then every 5 minutes, and resets once the status changes', () => {
    // From minute 61 the final is revealed and only minute 80 is still a reveal mark, so only processing retries are due.
    let read = recordTournamentRead(undefined, stuck, at(0));
    expect(read.processingReads).toBe(1);
    let t = 0;
    for (const wait of [30, 60, 120, 240, 300, 300]) {
      expect(due(read, t + wait - 0.001), `before ${wait} s`).toBe(false);
      expect(due(read, t + wait), `after ${wait} s`).toBe(true);
      t += wait;
      read = recordTournamentRead(read, stuck, at(t));
    }
    expect(read.processingReads).toBe(7);
    // A read that is no longer processing resets the schedule: no processing retry, and the next one starts at 30 s.
    read = recordTournamentRead(read, TOURNAMENT_VIEWS.completed, at(t));
    expect(read.processingReads).toBe(0);
    expect(due(read, t + 60)).toBe(false);
    read = recordTournamentRead(read, stuck, at(t + 10));
    expect([read.processingReads, due(read, t + 10 + 29.999), due(read, t + 10 + 30)]).toEqual([1, false, true]);
    // A failed read keeps the previous view and its count; the failure retry stays at 30 s.
    const failed = recordTournamentRead(read, null, at(t + 40));
    expect(failed).toEqual({ readAtMs: at(t + 40), view: stuck, processingReads: 1 });
    expect(TOURNAMENT_RETRY_MS).toBe(30_000);
  });

  it('re-reads a processing tournament once on focus, whatever is left of its wait, and never a settled one', () => {
    let read = recordTournamentRead(undefined, stuck, at(0));
    for (const t of [30, 90, 210]) read = recordTournamentRead(read, stuck, at(t));
    expect([due(read, 220), due(read, 220, { focused: true })]).toEqual([false, true]);
    const fine = recordTournamentRead(undefined, TOURNAMENT_VIEWS.completed, at(0));
    expect(due(fine, 10, { focused: true })).toBe(false);
  });
});

describe('battle logs in the camp load on demand (2b review I1)', () => {
  const tid = tournamentId('completed');
  const polled = withoutTournamentLogs(TOURNAMENT_VIEWS.completed);
  const logOf = (boutId: string) => TOURNAMENT_VIEWS.completed.bouts.find(b => b.id === boutId)!.revealedResult!.battleLog!;
  const ringsAt = (views: ReadonlyMap<string, TournamentView>, t: number, actors = ACTORS) => scheduleArenaRings(campTournamentFights(actors, views, t), 6);

  it('stages each revealed bout from its fight summary at once, and asks for the logs of the bouts it stages, once', () => {
    expect(polled.bouts.every(b => !b.revealedResult?.battleLog)).toBe(true);
    const views = new Map([[tid, polled]]);
    expect(campTournamentFights(ACTORS, views, S + 19.99 * MIN)).toEqual([]);
    const round1 = TOURNAMENT_VIEWS.completed.bouts.filter(b => b.round === 1).map(b => b.id);
    // Without its log a revealed bout is staged all the same (Task 19 R4): its fight summary times it; the log attaches later.
    const staged = campTournamentFights(ACTORS, views, S + 20 * MIN);
    const full = campTournamentFights(ACTORS, VIEWS, S + 20 * MIN);
    expect(staged.map(f => f.log)).toEqual([null, null, null, null]);
    expect(staged.map(({ log: _log, ...fight }) => fight)).toEqual(full.map(({ log: _log, ...fight }) => fight));
    const rings = ringsAt(views, S + 20 * MIN);
    expect(tournamentLogsDue(polled, S + 20 * MIN, TOURNAMENT_LOG_WINDOW_MS, rings).sort()).toEqual([...round1].sort());
    const merged = withTournamentLogs(polled, new Map(round1.map(b => [b, logOf(b)])));
    expect(tournamentLogsDue(merged, S + 20 * MIN, TOURNAMENT_LOG_WINDOW_MS, rings)).toEqual([]);
    expect(campTournamentFights(ACTORS, new Map([[tid, merged]]), S + 20 * MIN)).toEqual(full);
    // Round 2 adds only its own two bouts; a bout with an entrant outside the camp has no ring, so it needs no log.
    expect(tournamentLogsDue(merged, S + 40 * MIN, TOURNAMENT_LOG_WINDOW_MS, ringsAt(new Map([[tid, merged]]), S + 40 * MIN))).toHaveLength(2);
    const withoutAster = ACTORS.filter(a => a.gladiatorId !== id('aster'));
    expect(tournamentLogsDue(polled, S + 20 * MIN, TOURNAMENT_LOG_WINDOW_MS, ringsAt(views, S + 20 * MIN, withoutAster))).toHaveLength(3);
  });
});

describe('a large tournament in the camp (Task 19 R4 and the live-camp gate)', () => {
  const TEMPLATES = Object.values(TOURNAMENT_VIEWS).flatMap(v => v.bouts.flatMap(b => (b.revealedResult?.battleLog ? [b.revealedResult.battleLog] : [])));
  // A real tournament slot (Saturday 17:20 UTC) with 50 entrants: a 64-slot bracket of six rounds, 18 fought bouts in round 1.
  const START = TOURNAMENTS.completed.startsAtMs;
  const { view, actors } = largeTournament(50, { startsAtMs: START, league: 'silver', templates: TEMPLATES });
  const polled = withoutTournamentLogs(view);
  const reveal = (round: number) => START + Math.ceil(80 * MIN * round / 7);
  const logs = new Map(view.bouts.flatMap(b => (b.revealedResult?.battleLog ? [[b.id, b.revealedResult.battleLog] as const] : [])));
  const viewsWith = (loaded: Iterable<string>) => new Map([[view.id, withTournamentLogs(polled, new Map([...loaded].map(b => [b, logs.get(b)!])))]]);
  const round1 = view.bouts.filter(b => b.round === 1 && !b.revealedResult!.bye).map(b => b.id);
  /** What the camp schedules and asks for at display time `t`, its rings planned from scratch. */
  const at = (t: number, loaded: readonly string[] = []) => {
    const views = viewsWith(loaded);
    const rings = scheduleArenaRings(campTournamentFights(actors, views, t), 6);
    return { rings, due: tournamentLogsDue(views.get(view.id)!, t, TOURNAMENT_LOG_WINDOW_MS, rings) };
  };

  it('assigns the same rings whatever order the logs arrive in', () => {
    expect([view.bracket!.size, view.bracket!.rounds, round1.length]).toEqual([64, 6, 18]);
    /** The camp from round 1's reveal, its logs arriving six at a time (LOG_LOADS) in `order`, one batch a second, rescheduled by the scene's rule. */
    const play = (order: readonly string[]) => {
      let schedule: ReadonlyMap<string, RingSlot> = new Map(), key = '';
      const loaded: string[] = [];
      for (let step = 0; step <= 3; step += 1) {
        const t = reveal(1) + 500 + step * 1000;
        loaded.push(...order.slice(Math.max(0, step - 1) * 6, step * 6));
        const fights = campTournamentFights(actors, viewsWith(loaded), t);
        const next = fights.map(f => f.battleId).join('|');
        if (next !== key) { key = next; schedule = updateRingSchedule(schedule, fights, 6, t); }
      }
      return schedule;
    };
    const forward = play(round1);
    const backward = play([...round1].reverse());
    expect(forward.size).toBe(18);
    expect(backward).toEqual(forward);
    // Both are the schedule of the whole round known at once: the logged times put the first six in the rings.
    expect(forward).toEqual(scheduleArenaRings(campTournamentFights(actors, viewsWith(round1), reveal(1)), 6));
    expect([...forward.values()].filter(s => s.enterAtMs === reveal(1))).toHaveLength(6);
  });

  it('asks for logs only for current and upcoming ring windows', () => {
    expect(TOURNAMENT_LOG_WINDOW_MS).toBe(ARENA_ENTRY_MS + ARENA_RESULT_HOLD_MS);
    expect(at(reveal(1) - 1).due).toEqual([]);
    // Round 1 shows 18 bouts but the camp has six rings: only the six entering now are due.
    const first = at(reveal(1));
    expect(first.due).toHaveLength(6);
    for (const b of first.due) expect(first.rings.get(b)!.enterAtMs).toBe(reveal(1));
    // A loaded log is never asked for again.
    expect(at(reveal(1), first.due).due).toEqual([]);
    for (let t = reveal(1) - 2000; t < reveal(3) + 3 * MIN; t += 500) {
      const { rings, due } = at(t);
      // Exactly the windows that are current or start within the window, soonest first; never one that ended or starts later.
      const expected = [...rings.values()].filter(s => s.enterAtMs <= t + TOURNAMENT_LOG_WINDOW_MS && s.leaveAtMs > t)
        .sort((p, q) => p.enterAtMs - q.enterAtMs || (p.battleId < q.battleId ? -1 : 1)).map(s => s.battleId);
      expect(due, `${t - START} ms`).toEqual(expected);
      // So each ring asks for at most its current window and the next one.
      for (let ring = 0; ring < 6; ring += 1) expect(due.filter(b => rings.get(b)!.ring === ring).length, `ring ${ring}`).toBeLessThanOrEqual(2);
    }
  });

  it('a viewer joining late asks for at most the current and next ring window of each ring', () => {
    // Joining 10 s after round 2 shows: rounds 1 and 2 hold 34 revealed fought bouts, all of which Task 19's camp loaded.
    const t = reveal(2) + 10_000;
    const revealed = renderTournament(polled, t).rounds.flatMap(r => r.bouts).filter(b => b.status === 'fighting' || b.status === 'decided');
    expect(revealed).toHaveLength(34);
    const { rings, due } = at(t);
    expect(due.length).toBeGreaterThan(0);
    expect(due.length).toBeLessThanOrEqual(12);
    expect(due.every(b => b.startsWith(`${view.id}:2:`))).toBe(true);
    expect(due.length).toBe([...rings.values()].filter(s => s.enterAtMs <= t + TOURNAMENT_LOG_WINDOW_MS && s.leaveAtMs > t).length);
  });

  it('names the tournaments with an entrant in camp, so the camp forgets the others', () => {
    expect(campTournamentIds([...ACTORS, ...actors])).toEqual(new Set([tournamentId('completed'), view.id]));
    // Once the large tournament's entrants have left the camp (their slot is over), only the other one is kept.
    expect(campTournamentIds(ACTORS)).toEqual(new Set([tournamentId('completed')]));
    expect(campTournamentIds(actors.map(a => ({ ...a, location: 'arena' as const })))).toEqual(new Set());
    expect(campTournamentIds([])).toEqual(new Set());
  });
});
