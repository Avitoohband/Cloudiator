import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PublicActor, TournamentView } from '@contracts/reads';
import type { MapData } from '@/game/assets';
import { npcPostTiles } from '@/game/npcs';
import { layoutCamp, planActorRoutine } from '@/game/actors';
import { ringTiles } from '@/game/arena-layout';
import {
  TOURNAMENT_RETRY_MS, assignSpectators, campTournamentFights, campTournamentRoles, mergeCampFights, spectatorSpots, tournamentIdOfActor,
  tournamentReadsDue, type TournamentRead,
} from '@/game/tournament-camp';
import { scheduleArenaRings, type CampFight } from '@/game/arena-layout';
import { ARENA_GLADIATORS } from '../fixtures/arena-ids';
import { tournamentCampActors } from '../fixtures/tournament-build';
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
    const arena = { battleId: 'arena-b', startedAtMs: S + 10 * MIN, log: TOURNAMENT_VIEWS.pair.bouts[0].revealedResult!.battleLog!, fighters: ['x', null], activities: ['ax', 'ax'] } as CampFight;
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
