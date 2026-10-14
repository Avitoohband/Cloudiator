// Builds every fixture tournament with the real, reviewed Task 19 domain (buildBracket, readyBouts, runBout,
// recordBout, placementGrants, tournamentOutcomes) and explicit per-bout seeds, projects each one to the public
// TournamentView a server would return at its `asOfMinute` (tests/fixtures/tournament-build.ts), and checks the
// committed JSON byte for byte. The browser never runs the engine: it only reads these views.
// To rewrite them after an intentional change: UPDATE_TOURNAMENT_FIXTURES=1 npx vitest run tests/domain/tournament-fixtures.test.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeFighter } from '@domain/combat.ts';
import { RULES_V1 } from '@domain/rules-v1.ts';
import { CATALOG_V1 } from '@domain/catalog-v1.ts';
import type { ArenaEntrant } from '@domain/arena.ts';
import {
  buildBracket, isTournamentSlot, placementGrants, readyBouts, recordBout, runBout, tournamentOutcomes, type TournamentGraph,
} from '@domain/tournament.ts';
import { slotAt } from '@domain/clock.ts';
import type { BuildSnapshot } from '@domain/types.ts';
import type { BattleLog } from '@contracts/events.ts';
import type { TournamentView } from '@contracts/reads.ts';
import { itemFixture, worldFixture } from '../fixtures/domain.ts';
import { ARENA_GLADIATORS, type ArenaGladiatorKey } from '../fixtures/arena-ids.ts';
import {
  TOURNAMENT_KEYS, TOURNAMENT_LOOKS, TOURNAMENT_SAMPLE_KEYS, TOURNAMENTS, tournamentActivityId, tournamentAsOf, tournamentId,
  tournamentSlotIndex, type TournamentKey,
} from '../fixtures/tournament-ids.ts';
import { insufficientView, projectTournament, scheduledView, tournamentCampActors } from '../fixtures/tournament-build.ts';
import { TOURNAMENT_SAMPLES, TOURNAMENT_VIEWS } from '../fixtures/tournaments.ts';
import { EQUIPMENT_LAYERS } from '../../src/game/actors.ts';

const DIR = join(__dirname, '..', 'fixtures', 'tournaments');
const UPDATE = process.env.UPDATE_TOURNAMENT_FIXTURES === '1';
const SEASON = 'fixture-season-1';

const item = (id: string) => itemFixture(CATALOG_V1.items[id]);
const none = { weapon: null, offHand: null, head: null, body: null, feet: null };
type Gear = Partial<Record<keyof typeof none, string>>;
function build(classId: BuildSnapshot['classId'], stance: BuildSnapshot['stance'], allocations: BuildSnapshot['allocations'], equipment: Gear): BuildSnapshot {
  return { rulesVersion: 'v1', classId, stance, allocations,
    equipment: { ...none, ...Object.fromEntries(Object.entries(equipment).map(([slot, id]) => [slot, item(id!)])) } };
}
const a = (strength: number, agility: number, vitality: number, endurance: number, precision: number) => ({ strength, agility, vitality, endurance, precision });

/** Private builds (test inputs only; the logs carry the derived public snapshots). The same builds as the Arena fixtures. */
const ASTER = build('guardian', 'balanced', a(3, 2, 3, 1, 1), { weapon: 'sword:1:common', offHand: 'round-shield:1:common', head: 'iron-helmet:1:common', body: 'light-armor:1:common' });
const BUILDS: Record<ArenaGladiatorKey, BuildSnapshot> = {
  aster: ASTER,
  varro: build('berserker', 'offensive', a(4, 1, 3, 2, 0), { weapon: 'spear:1:common', head: 'leather-hood:1:common', body: 'heavy-armor:1:common' }),
  cassia: build('duelist', 'balanced', a(2, 3, 1, 2, 2), { weapon: 'sword:1:common', head: 'leather-hood:1:common', body: 'light-armor:1:common' }),
  // A mirror of Aster, so their two-entrant final can end with both at 0 HP.
  severus: ASTER,
  bellator: build('berserker', 'offensive', a(4, 2, 2, 1, 1), { weapon: 'axe:1:common', body: 'light-armor:1:common' }),
  corvina: build('duelist', 'defensive', a(2, 3, 2, 1, 2), { weapon: 'sword:1:common', offHand: 'round-shield:1:common', head: 'leather-hood:1:common' }),
  faustina: build('duelist', 'balanced', a(2, 2, 0, 3, 3), { weapon: 'sword:1:common' }),
  gallus: build('duelist', 'balanced', a(2, 2, 0, 3, 3), { weapon: 'sword:1:common' }),
  lucilla: build('guardian', 'defensive', a(3, 1, 3, 2, 1), { weapon: 'spear:1:common', head: 'iron-helmet:1:common', body: 'heavy-armor:1:common' }),
  marcellus: build('berserker', 'balanced', a(4, 2, 2, 1, 1), { weapon: 'axe:1:common', offHand: 'round-shield:1:common', body: 'light-armor:1:common' }),
  nerva: build('duelist', 'offensive', a(2, 3, 1, 1, 3), { weapon: 'bow:1:common', head: 'leather-hood:1:common', body: 'light-armor:1:common' }),
  titus: build('guardian', 'balanced', a(3, 1, 3, 2, 1), { weapon: 'sword:1:common', offHand: 'round-shield:1:common', body: 'heavy-armor:1:common' }),
  aurelia: build('duelist', 'balanced', a(2, 3, 2, 1, 2), { weapon: 'spear:1:common', body: 'light-armor:1:common' }),
  decimus: build('berserker', 'defensive', a(4, 1, 3, 1, 1), { weapon: 'axe:1:common', head: 'iron-helmet:1:common', body: 'heavy-armor:1:common' }),
  valeria: build('guardian', 'offensive', a(3, 2, 2, 1, 2), { weapon: 'sword:1:common', head: 'iron-helmet:1:common', body: 'light-armor:1:common' }),
  cato: build('berserker', 'balanced', a(3, 3, 2, 1, 1), { weapon: 'bow:1:common', head: 'leather-hood:1:common' }),
  ardea: build('duelist', 'balanced', a(2, 3, 2, 1, 2), { weapon: 'sword:1:common', offHand: 'round-shield:1:common' }),
};
/** Private league ratings before each tournament (never in a public view). */
const RATING = (g: ArenaGladiatorKey) => 950 + (Object.keys(ARENA_GLADIATORS).indexOf(g) * 37) % 160;
const NAMES = Object.fromEntries(Object.values(ARENA_GLADIATORS).map(g => [g.id, g.name]));
const ASTER_ID = ARENA_GLADIATORS.aster.id;

type BracketKey = Exclude<TournamentKey, 'upcoming' | 'insufficient'>;
const BRACKET_KEYS = TOURNAMENT_KEYS.filter((k): k is BracketKey => k !== 'upcoming' && k !== 'insufficient');

function entrantsOf(key: TournamentKey): ArenaEntrant[] {
  return TOURNAMENTS[key].entrants.map(g => ({
    gladiatorId: ARENA_GLADIATORS[g].id, activityId: tournamentActivityId(key, g), seasonId: SEASON, league: TOURNAMENTS[key].league,
    slotIndex: tournamentSlotIndex(key), rating: RATING(g), fighter: makeFighter(BUILDS[g], 'arena', RULES_V1),
  }));
}
/** The bracket placement seed of a fixture tournament (a private test input, like every bout seed). */
const placementSeed = (key: TournamentKey) => `fixture-${key}-placement`;
const boutSeed = (key: TournamentKey, boutId: string, n: number) => `fixture-${key}-${boutId}-${n}`;

/**
 * Bout shapes the fixtures need: in `completed` the owner loses her first bout (and spectates); the `pair` final is a
 * simultaneous defeat at 0 HP that the logged seeded tie-break gives to the owner. Every other bout takes seed n = 0.
 */
const WANTED: Partial<Record<BracketKey, { owns(graph: TournamentGraph, boutId: string): boolean; wanted(log: BattleLog): boolean }>> = {
  completed: {
    owns: (graph, boutId) => graph.bouts.find(b => b.id === boutId)!.round === 1 && graph.bouts.find(b => b.id === boutId)!.placed!.includes(ASTER_ID),
    wanted: log => log.winnerId !== ASTER_ID && log.victoryReason === 'defeat',
  },
  pair: {
    owns: () => true,
    wanted: log => log.tieBreakReason === 'simultaneous-defeat' && log.victoryReason === 'tie-break' && log.winnerId === ASTER_ID
      && log.finalHp[0] === 0 && log.finalHp[1] === 0,
  },
};

/** Plays a bracket to completion: each ready bout runs once, with its seed, and is recorded through the fence. */
function play(key: BracketKey, seedFor: (graph: TournamentGraph, boutId: string) => string): TournamentGraph {
  let graph = buildBracket(entrantsOf(key), placementSeed(key));
  for (let jobs = readyBouts(graph); jobs.length; jobs = readyBouts(graph)) {
    for (const job of jobs) graph = recordBout(graph, job.boutId, runBout(job, seedFor(graph, job.boutId), NAMES));
  }
  return graph;
}
/** The first `boutSeed` n (0, 1, ...) giving each owned bout its wanted shape; n = 0 for the rest. */
function searchSeeds(key: BracketKey): Record<string, string> {
  const want = WANTED[key];
  const found: Record<string, string> = {};
  play(key, (graph, boutId) => {
    if (!want?.owns(graph, boutId)) return (found[boutId] = boutSeed(key, boutId, 0));
    const job = readyBouts(graph).find(j => j.boutId === boutId)!;
    for (let n = 0; n < 3000; n += 1) if (want.wanted(runBout(job, boutSeed(key, boutId, n), NAMES))) return (found[boutId] = boutSeed(key, boutId, n));
    throw new Error(`no ${key} seed for ${boutId}`);
  });
  return found;
}

// Recorded per-bout seeds, found by the deterministic searches below. They are private test inputs: the views (and the
// browser bundle) never contain them.
const SEEDS: Record<BracketKey, Record<string, string>> = {
  opening: {
    'tournament:373207:bronze:1:0': 'fixture-opening-tournament:373207:bronze:1:0-0',
    'tournament:373207:bronze:1:1': 'fixture-opening-tournament:373207:bronze:1:1-0',
    'tournament:373207:bronze:1:2': 'fixture-opening-tournament:373207:bronze:1:2-0',
    'tournament:373207:bronze:1:3': 'fixture-opening-tournament:373207:bronze:1:3-0',
    'tournament:373207:bronze:2:0': 'fixture-opening-tournament:373207:bronze:2:0-0',
    'tournament:373207:bronze:2:1': 'fixture-opening-tournament:373207:bronze:2:1-0',
    'tournament:373207:bronze:3:0': 'fixture-opening-tournament:373207:bronze:3:0-0',
  },
  midway: {
    'tournament:373135:bronze:1:1': 'fixture-midway-tournament:373135:bronze:1:1-0',
    'tournament:373135:bronze:2:0': 'fixture-midway-tournament:373135:bronze:2:0-0',
    'tournament:373135:bronze:2:1': 'fixture-midway-tournament:373135:bronze:2:1-0',
    'tournament:373135:bronze:3:0': 'fixture-midway-tournament:373135:bronze:3:0-0',
  },
  late: {
    'tournament:373081:bronze:1:0': 'fixture-late-tournament:373081:bronze:1:0-0',
    'tournament:373081:bronze:1:1': 'fixture-late-tournament:373081:bronze:1:1-0',
    'tournament:373081:bronze:1:2': 'fixture-late-tournament:373081:bronze:1:2-0',
    'tournament:373081:bronze:1:3': 'fixture-late-tournament:373081:bronze:1:3-0',
    'tournament:373081:bronze:2:0': 'fixture-late-tournament:373081:bronze:2:0-0',
    'tournament:373081:bronze:2:1': 'fixture-late-tournament:373081:bronze:2:1-0',
    'tournament:373081:bronze:3:0': 'fixture-late-tournament:373081:bronze:3:0-0',
  },
  completed: {
    'tournament:373009:bronze:1:0': 'fixture-completed-tournament:373009:bronze:1:0-0',
    'tournament:373009:bronze:1:1': 'fixture-completed-tournament:373009:bronze:1:1-0',
    'tournament:373009:bronze:1:2': 'fixture-completed-tournament:373009:bronze:1:2-0',
    'tournament:373009:bronze:1:3': 'fixture-completed-tournament:373009:bronze:1:3-1',
    'tournament:373009:bronze:2:0': 'fixture-completed-tournament:373009:bronze:2:0-0',
    'tournament:373009:bronze:2:1': 'fixture-completed-tournament:373009:bronze:2:1-0',
    'tournament:373009:bronze:3:0': 'fixture-completed-tournament:373009:bronze:3:0-0',
  },
  pair: {
    'tournament:372955:bronze:1:0': 'fixture-pair-tournament:372955:bronze:1:0-16',
  },
};

// A bout missing from SEEDS falls back to n = 0 here, and the explicit-seed test below fails until it is recorded.
const graphs = Object.fromEntries(BRACKET_KEYS.map(key => [key, play(key, (_graph, boutId) => SEEDS[key][boutId] ?? boutSeed(key, boutId, 0))])) as Record<BracketKey, TournamentGraph>;
function viewOf(key: TournamentKey): TournamentView {
  if (key === 'upcoming') return scheduledView(key);
  if (key === 'insufficient') return insufficientView(key);
  const graph = graphs[key];
  return projectTournament(graph, tournamentOutcomes(graph), tournamentAsOf(key));
}

/** Every key outside the revealed battle logs (which carry the revealed fighter snapshots by contract). */
function keysOutsideLogs(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach(v => keysOutsideLogs(v, into));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { into.add(k); if (k !== 'battleLog') keysOutsideLogs(v, into); }
  }
  return into;
}

describe('tournament fixture brackets', () => {
  it('starts every case on a Wednesday or Saturday 17:20 UTC tournament slot', () => {
    for (const key of TOURNAMENT_KEYS) {
      const start = TOURNAMENTS[key].startsAtMs;
      expect(isTournamentSlot(slotAt(start)), key).toBe(true);
      expect(slotAt(start).phase, key).toBe('afternoon');
    }
    // The fixture world is Saturday 2026-10-10 00:40 UTC: the upcoming case is that day's tournament, the rest are past.
    expect(TOURNAMENTS.upcoming.startsAtMs - worldFixture.serverNowMs).toBe((16 * 60 + 40) * 60_000);
    for (const key of TOURNAMENT_KEYS.filter(k => k !== 'upcoming')) expect(TOURNAMENTS[key].startsAtMs + 4_800_000, key).toBeLessThan(worldFixture.serverNowMs);
  });

  it('records the first seeds that give each wanted bout shape', () => {
    expect(Object.fromEntries(BRACKET_KEYS.map(key => [key, searchSeeds(key)]))).toEqual(SEEDS);
  });

  it('plays every bracket to completion through the domain fence, with every bout seed explicit', () => {
    for (const key of BRACKET_KEYS) {
      const graph = graphs[key];
      expect(graph.bouts.every(b => b.result !== null), key).toBe(true);
      expect(Object.keys(SEEDS[key]).sort(), key).toEqual(graph.bouts.filter(b => !b.bye).map(b => b.id).sort());
      expect(graph.id).toBe(tournamentId(key));
    }
    // Shapes: 8 entrants fill an 8-slot bracket; 5 get three byes; 2 meet in a one-round final.
    expect([graphs.opening.size, graphs.opening.rounds, graphs.opening.bouts.filter(b => b.bye).length]).toEqual([8, 3, 0]);
    expect([graphs.midway.size, graphs.midway.rounds, graphs.midway.bouts.filter(b => b.bye).length]).toEqual([8, 3, 3]);
    expect([graphs.pair.size, graphs.pair.rounds]).toEqual([2, 1]);
    // The owner loses her first bout in `completed`; the `pair` final is a 0 HP seeded tie-break she wins.
    const lost = graphs.completed.bouts.find(b => b.round === 1 && b.placed!.includes(ASTER_ID))!;
    expect(lost.result!.loserId).toBe(ASTER_ID);
    const final = graphs.pair.bouts[0].result!.log!;
    expect([final.finalHp, final.tieBreakReason, final.winnerId]).toEqual([[0, 0], 'simultaneous-defeat', ASTER_ID]);
  });
});

describe('tournament fixture views', () => {
  const generated = Object.fromEntries(TOURNAMENT_KEYS.map(key => [key, viewOf(key)])) as Record<TournamentKey, TournamentView>;

  it.each(TOURNAMENT_KEYS)('commits %s.json exactly as the domain and projection regenerate it', key => {
    const path = join(DIR, `${key}.json`);
    const text = `${JSON.stringify(generated[key], null, 2)}\n`;
    if (UPDATE) writeFileSync(path, text);
    expect(existsSync(path), `${key}.json is missing; run with UPDATE_TOURNAMENT_FIXTURES=1`).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(JSON.stringify(TOURNAMENT_VIEWS[key])).toBe(JSON.stringify(generated[key]));
  });

  it('publishes only whitelisted public fields: no seeds, snapshots, ratings, ranks or private outcomes', () => {
    const allowed = new Set(['id', 'league', 'slotIndex', 'startsAtMs', 'endsAtMs', 'status', 'entrants', 'bouts', 'placements',
      'gladiatorId', 'name', 'classId', 'round', 'position', 'parentBoutIds', 'revealedResult', 'participants', 'winnerId', 'bye', 'battleLog',
      'place', 'summary', 'activityId', 'resolvedKind', 'result', 'success', 'rewards', 'money', 'renown', 'xp', 'attributePoints', 'items',
      'overflowMoney', 'receiptId', 'settledAtMs', 'replayExpiry', 'state', 'expiresAtMs']);
    for (const key of TOURNAMENT_KEYS) {
      const view = generated[key];
      expect([...keysOutsideLogs(view)].filter(k => !allowed.has(k)), key).toEqual([]);
      expect(JSON.stringify(view), key).not.toMatch(/seed|"rating|ratingDelta|baseDamage|"efficiency"|"rank"|grant/i);
      // A participant snapshot appears only inside a revealed battle log, and activity ids only in settled summaries.
      for (const bout of view.bouts) expect(JSON.stringify(bout), key).not.toContain('activityId');
    }
  });

  it('reveals each bout only from its round reveal time, and places entrants only once settled', () => {
    for (const key of BRACKET_KEYS) {
      const graph = graphs[key];
      const view = generated[key];
      const asOf = tournamentAsOf(key);
      expect(view.bouts.map(b => b.id), key).toEqual(graph.bouts.map(b => b.id));
      view.bouts.forEach((bout, i) => {
        const due = graph.bouts[i].revealAtMs <= asOf;
        expect(bout.revealedResult !== null, `${key} ${bout.id}`).toBe(due);
        if (bout.revealedResult) {
          expect(bout.revealedResult.winnerId).toBe(graph.bouts[i].result!.winnerId);
          expect(bout.revealedResult.bye).toBe(graph.bouts[i].bye);
          if (!bout.revealedResult.bye) expect(bout.revealedResult.battleLog).toEqual(graph.bouts[i].result!.log);
        }
      });
      const settled = asOf >= graph.settlesAtMs;
      expect(view.status, key).toBe(settled ? 'completed' : 'active');
      expect(view.placements.length, key).toBe(settled ? graph.entries.length : 0);
      if (settled) {
        const grants = placementGrants(graph);
        for (const p of view.placements) expect(p.place, p.gladiatorId).toBe(grants.find(g => g.gladiatorId === p.gladiatorId)!.place);
        const outcomes = tournamentOutcomes(graph);
        for (const p of view.placements) {
          const o = outcomes.find(x => x.gladiatorId === p.gladiatorId)!;
          expect(p.summary).toMatchObject({ activityId: o.activityId, resolvedKind: 'tournament', result: o.result, success: o.success,
            rewards: { money: o.rewards.money, renown: o.rewards.renown }, settledAtMs: graph.settlesAtMs });
          expect(p.summary).not.toHaveProperty('ratingDelta');
        }
      }
    }
    // The cases: before round 1, mid-way (two of three rounds), late (every round, no placements yet), completed.
    const revealedRounds = (key: BracketKey) => [...new Set(generated[key].bouts.filter(b => b.revealedResult).map(b => b.round))];
    expect(revealedRounds('opening')).toEqual([]);
    expect(revealedRounds('midway')).toEqual([1, 2]);
    expect([revealedRounds('late'), generated.late.placements]).toEqual([[1, 2, 3], []]);
    expect(generated.completed.placements.map(p => p.place)).toEqual([1, 2, 3, 3, 5, 5, 5, 5]);
    expect(generated.pair.placements.map(p => [p.gladiatorId, p.place])).toEqual([[ASTER_ID, 1], [ARENA_GLADIATORS.severus.id, 2]]);
    // Byes reveal with round 1 and name only the advancing entrant.
    const byes = generated.midway.bouts.filter(b => b.revealedResult?.bye);
    expect(byes).toHaveLength(3);
    for (const bye of byes) expect([bye.revealedResult!.participants.length, bye.revealedResult!.battleLog]).toEqual([1, undefined]);
  });

  it('lists entrants by name, not by the private seeded rank, and keeps the special views empty', () => {
    for (const key of TOURNAMENT_KEYS) {
      const names = generated[key].entrants.map(e => e.name);
      expect(names, key).toEqual([...names].sort());
      expect(generated[key].entrants.map(e => e.gladiatorId).sort(), key).toEqual(TOURNAMENTS[key].entrants.map(g => ARENA_GLADIATORS[g].id).sort());
    }
    expect(generated.upcoming).toMatchObject({ status: 'scheduled', entrants: [], bouts: [], placements: [] });
    expect(generated.insufficient).toMatchObject({ status: 'insufficient-entrants', league: 'gold', bouts: [], placements: [] });
    expect(generated.insufficient.entrants).toHaveLength(1);
  });

  it('lists every sample once, by its tournament id', () => {
    expect(TOURNAMENT_SAMPLES.map(s => s.id)).toEqual(TOURNAMENT_SAMPLE_KEYS.map(tournamentId));
    expect(new Set(TOURNAMENT_SAMPLE_KEYS)).toEqual(new Set(TOURNAMENT_KEYS));
    for (const s of TOURNAMENT_SAMPLES) expect(s.label.length).toBeGreaterThan(10);
  });

  it('gives the camp actors the public look the battle logs show', () => {
    const actors = tournamentCampActors('completed');
    expect(actors.map(x => x.location)).toEqual(Array(8).fill('tournament'));
    for (const actor of actors) {
      const key = (Object.keys(ARENA_GLADIATORS) as ArenaGladiatorKey[]).find(k => ARENA_GLADIATORS[k].id === actor.gladiatorId)!;
      expect(actor).toMatchObject({ classId: TOURNAMENT_LOOKS[key].classId, startsAtMs: TOURNAMENTS.completed.startsAtMs, league: 'bronze' });
      const log = generated.completed.bouts.find(b => b.revealedResult?.participants.some(p => p.gladiatorId === actor.gladiatorId))!.revealedResult!.battleLog!;
      const p = log.participants.find(x => x.gladiatorId === actor.gladiatorId)!;
      const fromLog = p.equipmentSilhouettes.map(id => EQUIPMENT_LAYERS[id.split(':')[0]]).filter(Boolean).sort();
      expect([...actor.equipmentSilhouettes].sort(), actor.name).toEqual(fromLog);
      expect(p.classId).toBe(actor.classId);
    }
  });
});
