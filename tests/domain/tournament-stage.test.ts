import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TournamentView } from '@contracts/reads';
import {
  TOURNAMENT_DURATION_MS, bracketShape, latestTournament, nextTournament, processingRetryDelay, renderTournament, roundRevealTimes, tournamentIdFor,
  tournamentRevealMarks, tournamentWindowAt, withTournamentLogs, withoutTournamentLogs, type TournamentStageState,
} from '@/game/tournament-stage';
import { countdownText, tournamentTimeText } from '@/features/tournaments/tournament-text';
import type { ArenaEntrant } from '@domain/arena';
import { makeFighter } from '@domain/combat';
import { RULES_V1 } from '@domain/rules-v1';
import { buildBracket } from '@domain/tournament';
import { ARENA_GLADIATORS } from '../fixtures/arena-ids';
import { baseFiveBuild, worldFixture } from '../fixtures/domain';
import { TOURNAMENT_VIEWS, TOURNAMENTS, tournamentActivityId, tournamentId, type TournamentKey } from '../fixtures/tournaments';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const utc = (y: number, m: number, d: number, h = 18, min = 40) => Date.UTC(y, m - 1, d, h, min);
const view = (key: TournamentKey) => TOURNAMENT_VIEWS[key];
const S = (key: TournamentKey) => TOURNAMENTS[key].startsAtMs;
const at = (key: TournamentKey, minute: number, viewerId: string | null = null) => renderTournament(view(key), S(key) + minute * MIN, { viewerId });
const id = (name: keyof typeof ARENA_GLADIATORS) => ARENA_GLADIATORS[name].id;
const boutsOf = (state: TournamentStageState) => state.rounds.flatMap(r => r.bouts);
const roleOf = (state: TournamentStageState, name: keyof typeof ARENA_GLADIATORS) => state.entrants.find(e => e.gladiatorId === id(name))?.role;
const logOf = (key: TournamentKey, boutId: string) => view(key).bouts.find(b => b.id === boutId)!.revealedResult!.battleLog!;

afterEach(() => vi.restoreAllMocks());

describe('next tournament and countdown', () => {
  it('counts down to the next Wednesday or Saturday 18:40 UTC slot from the display time', () => {
    const now = worldFixture.serverNowMs; // Saturday 2026-10-10 00:40 UTC
    expect(tournamentWindowAt(now)).toBeNull();
    expect(nextTournament(now)).toEqual({ slotIndex: utc(2026, 10, 10) / 4_800_000, startsAtMs: utc(2026, 10, 10), endsAtMs: utc(2026, 10, 10) + 80 * MIN, countdownMs: 18 * HOUR });
    // At the start the tournament is running and the next one is Wednesday's; the slot end is exclusive.
    const start = utc(2026, 10, 10);
    expect(tournamentWindowAt(start)).toEqual({ slotIndex: start / 4_800_000, startsAtMs: start, endsAtMs: start + 80 * MIN });
    expect(tournamentWindowAt(start + 80 * MIN - 1)?.startsAtMs).toBe(start);
    expect(tournamentWindowAt(start + 80 * MIN)).toBeNull();
    expect(nextTournament(start).startsAtMs).toBe(utc(2026, 10, 14));
    expect(nextTournament(start - 1)).toMatchObject({ startsAtMs: start, countdownMs: 1 });
    // Over five weeks every next start is a Wednesday or Saturday at 18:40 UTC (checked with Date's UTC fields).
    for (let t = utc(2026, 10, 1, 0, 0); t < utc(2026, 11, 5, 0, 0); t += 37 * MIN) {
      const next = new Date(nextTournament(t).startsAtMs);
      expect([3, 6], next.toISOString()).toContain(next.getUTCDay());
      expect([next.getUTCHours(), next.getUTCMinutes()]).toEqual([18, 40]);
      expect(nextTournament(t).startsAtMs).toBeGreaterThan(t);
      expect(nextTournament(t).startsAtMs - t).toBeLessThanOrEqual(4 * DAY);
    }
  });

  it('finds the latest tournament that has started: the one running, else the most recent', () => {
    expect(latestTournament(worldFixture.serverNowMs).startsAtMs).toBe(utc(2026, 10, 7));
    expect(latestTournament(utc(2026, 10, 10))).toEqual({ slotIndex: utc(2026, 10, 10) / 4_800_000, startsAtMs: utc(2026, 10, 10), endsAtMs: utc(2026, 10, 10) + 80 * MIN });
    expect(latestTournament(utc(2026, 10, 10) - 1).startsAtMs).toBe(utc(2026, 10, 7));
    expect(latestTournament(utc(2026, 10, 10) + 79 * MIN).startsAtMs).toBe(utc(2026, 10, 10));
  });

  it('keeps UTC times fixed across daylight-saving changes and shows the local time beside UTC', () => {
    // Europe/Berlin leaves summer time on 2026-10-25: 20:40 local before, 19:40 after, always 18:40 UTC.
    const saturday = utc(2026, 10, 24);
    const afterSaturday = saturday + 80 * MIN;
    expect(nextTournament(afterSaturday)).toMatchObject({ startsAtMs: utc(2026, 10, 28), countdownMs: 3 * DAY + 22 * HOUR + 40 * MIN });
    expect(tournamentTimeText(saturday, 'Europe/Berlin')).toEqual({ local: 'Sat 24 Oct, 20:40 GMT+2', utc: 'Sat 24 Oct, 18:40 UTC' });
    expect(tournamentTimeText(utc(2026, 10, 28), 'Europe/Berlin')).toEqual({ local: 'Wed 28 Oct, 19:40 GMT+1', utc: 'Wed 28 Oct, 18:40 UTC' });
    // New York leaves daylight time on 2026-11-01.
    expect(tournamentTimeText(utc(2026, 10, 31), 'America/New_York').local).toBe('Sat 31 Oct, 14:40 GMT-4');
    expect(tournamentTimeText(utc(2026, 11, 4), 'America/New_York').local).toBe('Wed 4 Nov, 13:40 GMT-5');
    // A viewer ahead of UTC can see the next calendar day.
    expect(tournamentTimeText(utc(2026, 10, 28), 'Pacific/Kiritimati').local).toBe('Thu 29 Oct, 08:40 GMT+14');
    expect(tournamentTimeText(utc(2026, 10, 28), 'UTC')).toEqual({ local: 'Wed 28 Oct, 18:40 UTC', utc: 'Wed 28 Oct, 18:40 UTC' });
    expect(tournamentTimeText(utc(2026, 10, 28), 'Europe/London').local).toBe('Wed 28 Oct, 18:40 UTC');
  });

  it('writes the countdown in days, hours and minutes, with seconds in the last hour', () => {
    expect(countdownText(3 * DAY + 22 * HOUR + 40 * MIN)).toBe('3 d 22 h 40 min');
    expect(countdownText(16 * HOUR + 40 * MIN + 59_999)).toBe('16 h 40 min');
    expect(countdownText(18 * HOUR)).toBe('18 h 0 min');
    expect(countdownText(59 * MIN + 5_000)).toBe('59 min 5 s');
    expect(countdownText(1)).toBe('0 min 1 s');
    expect(countdownText(0)).toBe('now');
  });
});

describe('bracket shape and reveal times', () => {
  it('fills the next power of two, with byes for the rest, from the number of entrants', () => {
    expect([0, 1].map(bracketShape)).toEqual([null, null]);
    expect([2, 3, 4, 5, 8, 9, 50, 64].map(bracketShape)).toEqual([
      { size: 2, rounds: 1, byes: 0 }, { size: 4, rounds: 2, byes: 1 }, { size: 4, rounds: 2, byes: 0 }, { size: 8, rounds: 3, byes: 3 },
      { size: 8, rounds: 3, byes: 0 }, { size: 16, rounds: 4, byes: 7 }, { size: 64, rounds: 6, byes: 14 }, { size: 64, rounds: 6, byes: 0 },
    ]);
  });

  it('reveals round r of R at 80 × r / (R + 1) minutes, rounded up to the millisecond, for R = 1..6', () => {
    expect(TOURNAMENT_DURATION_MS).toBe(80 * MIN);
    const start = utc(2026, 10, 28);
    const expected: Record<number, number[]> = {
      1: [2_400_000],
      2: [1_600_000, 3_200_000],
      3: [1_200_000, 2_400_000, 3_600_000],
      4: [960_000, 1_920_000, 2_880_000, 3_840_000],
      5: [800_000, 1_600_000, 2_400_000, 3_200_000, 4_000_000],
      // Task 19 phase 1 report, decision 4: never early, so 685,714.28… rounds up.
      6: [685_715, 1_371_429, 2_057_143, 2_742_858, 3_428_572, 4_114_286],
    };
    for (let rounds = 1; rounds <= 6; rounds += 1) expect(roundRevealTimes(start, rounds).map(t => t - start), `R = ${rounds}`).toEqual(expected[rounds]);
    // The fixture views use the same rounds: 8 entrants reveal at minutes 20, 40 and 60; a pair at minute 40.
    expect(at('completed', 0).rounds.map(r => r.revealAtMs - S('completed'))).toEqual([20 * MIN, 40 * MIN, 60 * MIN]);
    expect(at('pair', 0).rounds.map(r => r.revealAtMs - S('pair'))).toEqual([40 * MIN]);
    expect(at('completed', 0).rounds.map(r => r.label)).toEqual(['Quarterfinals', 'Semifinals', 'Final']);
  });

  it('matches the Task 19 bracket frame (reveal times, size, rounds, byes and ids) for 2 to 64 entrants', () => {
    // The stage core restates the domain's private frame; the real buildBracket is the reference.
    const fighter = makeFighter(baseFiveBuild, 'arena', RULES_V1);
    const leagues = ['bronze', 'silver', 'gold', 'champion'] as const;
    for (let n = 2; n <= 64; n += 1) {
      const league = leagues[n % leagues.length];
      const slotIndex = (n % 2 ? S('completed') : S('opening')) / RULES_V1.clock.slotMs;
      const entrants: ArenaEntrant[] = Array.from({ length: n }, (_, i) => ({
        gladiatorId: `g-${n}-${i}`, activityId: `a-${n}-${i}`, seasonId: 'season-1', league, slotIndex, rating: 1000, fighter }));
      const graph = buildBracket(entrants, `cross-check-${n}`);
      const shape = bracketShape(n)!;
      expect({ ...shape, id: tournamentIdFor(slotIndex, league) }, `n = ${n}`)
        .toEqual({ size: graph.size, rounds: graph.rounds, byes: graph.bouts.filter(b => b.bye).length, id: graph.id });
      expect(roundRevealTimes(graph.startsAtMs, graph.rounds), `n = ${n}`).toEqual(graph.revealAtMs);
      expect(graph.settlesAtMs - graph.startsAtMs).toBe(TOURNAMENT_DURATION_MS);
      // A view with these bouts gets the same rounds, bout counts and per-bout reveal times from the core.
      const slots = graph.bouts.filter(b => b.round === 1).flatMap(b => [...b.placed!]);
      const state = renderTournament({
        id: graph.id, league, slotIndex, startsAtMs: graph.startsAtMs, endsAtMs: graph.settlesAtMs, status: 'active',
        bracket: { size: graph.size, rounds: graph.rounds, slots },
        entrants: entrants.map(e => ({ gladiatorId: e.gladiatorId, name: e.gladiatorId, classId: 'guardian' })),
        bouts: graph.bouts.map(b => ({ id: b.id, round: b.round, position: b.position, parentBoutIds: [...b.parentBoutIds], revealedResult: null })),
        placements: [],
      }, graph.startsAtMs);
      expect(state.rounds.flatMap(r => r.bouts.map(b => [b.id, b.round, b.revealAtMs])), `n = ${n}`)
        .toEqual(graph.bouts.map(b => [b.id, b.round, b.revealAtMs]));
      // From the start, round one shows its seeded sides; each bye advances its entrant at once, with no fight.
      expect(state.rounds[0].bouts.map(b => [b.status, b.sides.map(s => s?.gladiatorId ?? null)]), `n = ${n}`)
        .toEqual(graph.bouts.filter(b => b.round === 1).map(b => b.bye ? ['bye', [b.result!.winnerId]] : ['preparing', [...b.placed!]]));
    }
  });

  it('shows the entrants and the bracket shape from the start, never before', () => {
    expect(at('opening', -1)).toMatchObject({ status: 'scheduled', entrants: [], rounds: [], shape: null });
    const open = at('opening', 0);
    expect(open.status).toBe('active');
    expect(open.shape).toEqual({ size: 8, rounds: 3, byes: 0 });
    expect(open.entrants.map(e => e.name)).toEqual(['Aster', 'Bellator', 'Cassia', 'Corvina', 'Nerva', 'Severus', 'Titus', 'Varro']);
    expect(open.rounds.map(r => r.bouts.length)).toEqual([4, 2, 1]);
    expect(at('midway', 0).shape).toEqual({ size: 8, rounds: 3, byes: 3 });
    expect(tournamentIdFor(TOURNAMENTS.completed.startsAtMs / 4_800_000, 'bronze')).toBe(tournamentId('completed'));
    expect(view('completed').id).toBe(tournamentId('completed'));
  });
});

describe('revealed results', () => {
  it('says Result preparing before a round reveals, even when the view already holds its result', () => {
    // The completed view holds every result: none may show before its round's reveal time.
    const before = at('completed', 20 - 1 / 60_000);
    for (const bout of boutsOf(before)) {
      expect([bout.status, bout.winnerId, bout.loserId, bout.log], bout.id).toEqual(['preparing', null, null, null]);
    }
    // Round 1 shows its seeded pairings from the start (the bracket slots); later rounds wait on winners.
    const slots = view('completed').bracket!.slots;
    expect(before.rounds[0].bouts.map(b => b.sides.map(s => s?.gladiatorId))).toEqual([0, 1, 2, 3].map(p => [slots[2 * p], slots[2 * p + 1]]));
    expect(before.rounds[1].bouts.every(b => b.sides.every(s => s === null))).toBe(true);
    expect(before.championId).toBeNull();
    // From the reveal the bout plays for its logged duration; only then does its winner show, by winnerId.
    const first = view('completed').bouts[0];
    const log = logOf('completed', first.id);
    const fighting = at('completed', 20);
    const live = fighting.rounds[0].bouts[0];
    expect([live.status, live.winnerId, live.log]).toEqual(['fighting', null, log]);
    expect(live.sides.map(s => s?.name)).toEqual(log.participants.map(p => p.name));
    expect(live.elapsedMs).toBe(0);
    const decided = renderTournament(view('completed'), S('completed') + 20 * MIN + log.durationMs).rounds[0].bouts[0];
    expect([decided.status, decided.winnerId]).toEqual(['decided', log.winnerId]);
    expect(decided.loserId).toBe(log.participants.find(p => p.id !== log.winnerId)!.gladiatorId);
  });

  it('marks a due round as preparing while its results are not published, and the tournament as processing', () => {
    const early = at('opening', 5);
    expect(early.status).toBe('active');
    expect(early.rounds.map(r => [r.due, r.delayed])).toEqual([[false, false], [false, false], [false, false]]);
    expect(boutsOf(early).every(b => b.status === 'preparing' && b.winnerId === null)).toBe(true);
    const late = at('opening', 25);
    expect(late.status).toBe('processing');
    expect(late.rounds[0]).toMatchObject({ due: true, delayed: true });
    expect(late.rounds[0].bouts.every(b => b.status === 'delayed' && b.winnerId === null && b.sides.length === 2)).toBe(true);
    expect(late.currentRound).toBe(1);
  });

  it('advances bye receivers without a fight from the start, and pairs later rounds from revealed winners', () => {
    // The byes are public from the start through the bracket slots: their entrants advance at once and wait for round 2.
    const start = at('midway', 0);
    expect(start.rounds[0].bouts.filter(b => b.status === 'bye').map(b => b.winnerId).sort())
      .toEqual(view('midway').bracket!.slots.filter((_, i, all) => all[i ^ 1] === null).sort());
    expect(start.rounds[1].bouts.flatMap(b => b.sides).filter(s => s !== null)).toHaveLength(3);
    expect(start.entrants.every(e => e.role === 'waiting')).toBe(true);
    const state = at('midway', 45);
    expect(state.status).toBe('active');
    const round1 = state.rounds[0].bouts;
    const byes = round1.filter(b => b.status === 'bye');
    expect(byes).toHaveLength(3);
    for (const bye of byes) {
      expect(bye.sides).toHaveLength(1);
      expect([bye.winnerId, bye.loserId, bye.log]).toEqual([bye.sides[0]!.gladiatorId, null, null]);
    }
    expect(round1.filter(b => b.status === 'decided')).toHaveLength(1);
    // After round 1 the bye receivers wait for round 2 with the one fought winner; only its loser spectates.
    const afterRound1 = at('midway', 30);
    const fought = afterRound1.rounds[0].bouts.find(b => b.status === 'decided')!;
    for (const e of afterRound1.entrants) expect(e.role, e.name).toBe(e.gladiatorId === fought.loserId ? 'spectating' : 'waiting');
    // The final is not revealed until minute 60, but its sides are the semifinal winners already shown.
    const final = state.rounds[2].bouts[0];
    const semifinalWinners = state.rounds[1].bouts.map(b => b.winnerId);
    expect(final.status).toBe('preparing');
    expect(final.sides.map(s => s?.gladiatorId)).toEqual(semifinalWinners);
    expect(final.winnerId).toBeNull();
    expect(state.currentRound).toBe(2);
    // The view was read at minute 45: by minute 65 its final is due but unpublished.
    const stale = at('midway', 65);
    expect([stale.status, stale.rounds[2].delayed, stale.rounds[2].bouts[0].status]).toEqual(['processing', true, 'delayed']);
  });

  it('takes the winner from winnerId, including a seeded tie-break with both fighters at 0 HP', () => {
    const final = view('pair').bouts[0];
    const log = final.revealedResult!.battleLog!;
    expect(log.finalHp).toEqual([0, 0]);
    expect(log.tieBreakReason).toBe('simultaneous-defeat');
    const state = renderTournament(view('pair'), S('pair') + 40 * MIN + log.durationMs);
    expect(state.rounds[0].bouts[0].winnerId).toBe(id('aster'));
    expect(state.championId).toBe(id('aster'));
    expect([roleOf(state, 'aster'), roleOf(state, 'severus')]).toEqual(['champion', 'spectating']);
  });

  it('never shows a result whose winner disagrees with its log or is not a participant', () => {
    const tampered: TournamentView = structuredClone(view('pair'));
    const result = tampered.bouts[0].revealedResult!;
    result.winnerId = id('severus');
    expect(renderTournament(tampered, S('pair') + 79 * MIN).rounds[0].bouts[0]).toMatchObject({ status: 'delayed', winnerId: null, log: null });
    const stranger: TournamentView = structuredClone(view('pair'));
    stranger.bouts[0].revealedResult!.winnerId = id('varro');
    expect(renderTournament(stranger, S('pair') + 79 * MIN).rounds[0].bouts[0].winnerId).toBeNull();
  });

  it('accepts result participants in any order that matches its log’s fighters, and fails closed on anything else', () => {
    const t = S('completed') + 79 * MIN;
    const first = view('completed').bouts[0];
    const log = first.revealedResult!.battleLog!;
    // The same two gladiators, listed in the other order: still the logged result, sides as the result lists them.
    const swapped: TournamentView = structuredClone(view('completed'));
    swapped.bouts[0].revealedResult!.participants.reverse();
    const shown = renderTournament(swapped, t).rounds[0].bouts[0];
    expect([shown.status, shown.winnerId]).toEqual(['decided', log.winnerId]);
    expect(shown.sides.map(s => s!.gladiatorId)).toEqual([...log.participants].reverse().map(p => p.gladiatorId));
    expect(shown.loserId).toBe(log.participants.find(p => p.id !== log.winnerId)!.gladiatorId);
    const hidden = (patch: (view: TournamentView) => void) => {
      const tampered: TournamentView = structuredClone(view('completed'));
      patch(tampered);
      return renderTournament(tampered, t).rounds[0].bouts[0];
    };
    // A log that names another entrant, the same fighter twice, one fighter, a third one or a repeat is never shown.
    const other = view('completed').bouts[1].revealedResult!.battleLog!.participants[0];
    const fighters = (v: TournamentView) => v.bouts[0].revealedResult!.battleLog!.participants as unknown as (typeof other)[];
    for (const patch of [
      (v: TournamentView) => { fighters(v)[1] = structuredClone(other); },
      (v: TournamentView) => { fighters(v)[1] = structuredClone(fighters(v)[0]); },
      (v: TournamentView) => { fighters(v).pop(); },
      (v: TournamentView) => { fighters(v).push(structuredClone(other)); },
      (v: TournamentView) => { fighters(v).push(structuredClone(fighters(v)[0])); },
      (v: TournamentView) => { v.bouts[0].revealedResult!.participants[1] = structuredClone(v.bouts[1].revealedResult!.participants[0]); },
    ]) expect(hidden(patch)).toMatchObject({ status: 'delayed', winnerId: null, log: null });
  });
});

describe('entrant roles', () => {
  it('shows every entrant waiting, fighting, spectating after elimination, or champion at the display time', () => {
    const roles = (minute: number) => Object.fromEntries(at('completed', minute).entrants.map(e => [e.name, e.role]));
    const all = (role: string) => Object.fromEntries(['Aster', 'Aurelia', 'Bellator', 'Cassia', 'Corvina', 'Decimus', 'Severus', 'Varro'].map(n => [n, role]));
    expect(roles(0)).toEqual(all('waiting'));
    expect(roles(20 + 1 / 60)).toEqual(all('fighting'));
    expect(roles(30)).toEqual({ Aster: 'spectating', Aurelia: 'spectating', Bellator: 'spectating', Corvina: 'spectating',
      Cassia: 'waiting', Decimus: 'waiting', Severus: 'waiting', Varro: 'waiting' });
    expect(roles(40 + 1 / 60)).toEqual({ ...roles(30), Cassia: 'fighting', Decimus: 'fighting', Severus: 'fighting', Varro: 'fighting' });
    expect(roles(79)).toEqual({ ...all('spectating'), Varro: 'champion' });
    // The fighting entrant knows its bout; eliminated ones know their round.
    const state = at('completed', 30, id('aster'));
    expect(state.viewer.entrant).toMatchObject({ name: 'Aster', role: 'spectating', eliminatedInRound: 1, boutId: null });
    expect(at('completed', 20 + 1 / 60).entrants.find(e => e.name === 'Aster')!.boutId).toBe(view('completed').bouts[3].id);
    expect(at('completed', 79).entrants.find(e => e.name === 'Severus')!.eliminatedInRound).toBe(3);
    expect(at('completed', 30, id('lucilla')).viewer.entrant).toBeNull();
  });
});

describe('special views and placements', () => {
  it('fails closed on a malformed bracket: no seeded sides, and byes only from their published results', () => {
    const t = S('midway') + 5 * MIN;
    for (const patch of [
      (v: TournamentView) => { v.bracket!.slots.pop(); },
      (v: TournamentView) => { v.bracket!.slots[0] = 'stranger'; },
      (v: TournamentView) => { v.bracket!.slots[2] = v.bracket!.slots[0]; },
      (v: TournamentView) => { v.bracket!.slots[2] = null; v.bracket!.slots[3] = null; },
      (v: TournamentView) => { v.bracket!.size = 16; },
    ]) {
      const tampered: TournamentView = structuredClone(view('midway'));
      patch(tampered);
      const round1 = renderTournament(tampered, t).rounds[0].bouts;
      expect(round1.every(b => b.status === 'preparing' && b.sides.length === 0)).toBe(true);
    }
    // A published round-one result whose fighters are not the seeded pair is never shown.
    const swapped: TournamentView = structuredClone(view('completed'));
    const [a, b, c] = swapped.bracket!.slots;
    swapped.bracket!.slots.splice(0, 3, c, b, a);
    expect(renderTournament(swapped, S('completed') + 79 * MIN).rounds[0].bouts[0]).toMatchObject({ status: 'delayed', winnerId: null });
  });

  it('explains a slot with too few entrants and a scheduled tournament without a bracket', () => {
    const fallback = at('insufficient', 30);
    expect(fallback).toMatchObject({ status: 'insufficient-entrants', shape: null, rounds: [], placements: [], championId: null });
    expect(fallback.entrants.map(e => [e.name, e.role])).toEqual([['Valeria', null]]);
    const scheduled = renderTournament(view('upcoming'), worldFixture.serverNowMs);
    expect(scheduled).toMatchObject({ status: 'scheduled', entrants: [], rounds: [], shape: null, placements: [] });
    // A stale scheduled view read after the start shows a pending bracket, not an empty tournament.
    expect(renderTournament(view('upcoming'), S('upcoming') + 2 * MIN).status).toBe('processing');
  });

  it('places entrants only once settled, and gives the viewer only their own credited summary', () => {
    const end = S('completed') + 80 * MIN;
    const before = renderTournament(view('completed'), end - 1, { viewerId: id('aster') });
    expect([before.status, before.placements, before.viewer.placement]).toEqual(['active', [], null]);
    const after = renderTournament(view('completed'), end, { viewerId: id('aster') });
    expect(after.status).toBe('completed');
    expect(after.placements.map(p => [p.name, p.place])).toEqual([['Varro', 1], ['Severus', 2], ['Cassia', 3], ['Decimus', 3],
      ['Aster', 5], ['Aurelia', 5], ['Bellator', 5], ['Corvina', 5]]);
    // The viewer's own place and activity, whose credited summary the owner reads from its own timeline; the public view
    // carries no reward or receipt for anyone.
    expect(after.viewer.placement).toEqual({ place: 5, activityId: tournamentActivityId('completed', 'aster') });
    expect(JSON.stringify(after)).not.toMatch(/renown|money|receiptId|rewards/);
    expect(renderTournament(view('completed'), end).viewer.placement).toBeNull();
    // A late view (final revealed, not yet settled) shows no placements, and processing once minute 80 passes.
    expect(at('late', 79).placements).toEqual([]);
    expect([at('late', 85).status, at('late', 85).placements]).toEqual(['processing', []]);
  });

  it('lists the display times when a fresh read may reveal more', () => {
    const s = S('completed');
    expect(tournamentRevealMarks(at('completed', -1))).toEqual([s, s + 20 * MIN, s + 40 * MIN, s + 60 * MIN, s + 80 * MIN]);
    expect(tournamentRevealMarks(at('completed', 45))).toEqual([s + 60 * MIN, s + 80 * MIN]);
    expect(tournamentRevealMarks(at('completed', 80))).toEqual([]);
    expect(tournamentRevealMarks(at('insufficient', 10))).toEqual([]);
  });
});

describe('purity', () => {
  it('is deterministic, frozen, leaves its input untouched and reads no clock or randomness', () => {
    const now = vi.spyOn(Date, 'now');
    const random = vi.spyOn(Math, 'random');
    const perf = vi.spyOn(performance, 'now');
    const input = structuredClone(view('completed'));
    const before = JSON.stringify(input);
    const times = [-5, 0, 19, 20, 20.2, 41, 60.1, 79, 80, 90].map(m => S('completed') + m * MIN);
    const first = times.map(t => renderTournament(input, t, { viewerId: id('aster') }));
    const second = [...times].reverse().map(t => renderTournament(input, t, { viewerId: id('aster') })).reverse();
    expect(second).toEqual(first);
    expect(JSON.stringify(input)).toBe(before);
    const state = first[8];
    expect(Object.isFrozen(state) && Object.isFrozen(state.rounds) && Object.isFrozen(state.rounds[0].bouts[0]) && Object.isFrozen(state.entrants[0])
      && Object.isFrozen(state.placements) && Object.isFrozen(state.viewer.placement)).toBe(true);
    // The revealed logs are shared by reference and never frozen here.
    expect(state.rounds[0].bouts[0].log).toBe(input.bouts[0].revealedResult!.battleLog);
    expect([now, random, perf].map(spy => spy.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it('imports no Phaser, React or combat engine and keeps no clock or browser state', () => {
    const source = readFileSync('src/game/tournament-stage.ts', 'utf8');
    expect(source).not.toMatch(/Date\.now|performance\.now|Math\.random|window\.|document\.|new Date/);
    expect(source).not.toMatch(/from '[^']*(phaser|react|combat|arena\.ts|@domain\/arena)[^']*'/);
  });
});

describe('polled views carry no battle log (2b review I1)', () => {
  const lean = (key: TournamentKey) => withoutTournamentLogs(view(key));
  const withoutLogs = (state: TournamentStageState) => boutsOf(state).map(b => ({ ...b, log: null }));

  it('replaces each fought log with its fight summary and leaves byes and unrevealed bouts alone', () => {
    for (const key of ['completed', 'midway', 'pair', 'opening'] as const) {
      const polled = lean(key);
      expect(JSON.stringify(polled), key).not.toMatch(/battleLog|"events"|finalHp/);
      for (const bout of polled.bouts) {
        const full = view(key).bouts.find(b => b.id === bout.id)!.revealedResult;
        const log = full?.battleLog;
        expect(bout.revealedResult, bout.id).toEqual(!full ? null : log ? { participants: full.participants, winnerId: full.winnerId, bye: false,
          fight: { durationMs: log.durationMs, victoryReason: log.victoryReason, tieBreakReason: log.tieBreakReason } } : full);
      }
    }
    // A copy: the fixture view keeps its logs.
    expect(view('completed').bouts[0].revealedResult!.battleLog).toBeTruthy();
  });

  it('shows the same bracket at every display time from the summary alone: fighting for the logged duration, then decided', () => {
    const polled = lean('completed');
    for (const minute of [-5, 19, 20, 20.1, 20.2, 30, 40.1, 41, 60.1, 79, 85]) {
      const full = at('completed', minute, id('aster'));
      const shown = renderTournament(polled, S('completed') + minute * MIN, { viewerId: id('aster') });
      expect(withoutLogs(shown), `minute ${minute}`).toEqual(withoutLogs(full));
      expect([shown.status, shown.championId, shown.entrants, shown.placements, shown.viewer], `minute ${minute}`)
        .toEqual([full.status, full.championId, full.entrants, full.placements, full.viewer]);
    }
    // How the winner won is known without the log, and only once the bout is decided.
    const final = view('pair').bouts[0].revealedResult!.battleLog!;
    const fighting = renderTournament(lean('pair'), S('pair') + 40 * MIN).rounds[0].bouts[0];
    expect([fighting.status, fighting.fight]).toEqual(['fighting', null]);
    const decided = renderTournament(lean('pair'), S('pair') + 40 * MIN + final.durationMs).rounds[0].bouts[0];
    expect([decided.status, decided.log, decided.fight]).toEqual(['decided', null,
      { durationMs: final.durationMs, victoryReason: 'tie-break', tieBreakReason: 'simultaneous-defeat' }]);
  });

  it('merges a loaded log only into its own published bout, and only when it agrees with the result', () => {
    const polled = lean('completed');
    const final = polled.bouts.find(b => b.round === 3)!;
    const log = logOf('completed', final.id);
    const merged = withTournamentLogs(polled, new Map([[final.id, log]]));
    expect(merged.bouts.find(b => b.id === final.id)!.revealedResult!.battleLog).toBe(log);
    expect(merged.bouts.filter(b => b.revealedResult?.battleLog)).toHaveLength(1);
    const state = renderTournament(merged, S('completed') + 79 * MIN);
    expect([state.rounds[2].bouts[0].status, state.rounds[2].bouts[0].log]).toEqual(['decided', log]);
    // Nothing new to merge keeps the same view object.
    expect(withTournamentLogs(polled, new Map())).toBe(polled);
    expect(withTournamentLogs(merged, new Map([[final.id, log]]))).toBe(merged);
    // Another bout's log, a log naming another winner, an unpublished bout and a bye never take a log.
    const firstLog = logOf('completed', polled.bouts[0].id);
    const loser = log.participants.find(p => p.gladiatorId !== log.winnerId)!.gladiatorId;
    expect(withTournamentLogs(polled, new Map([[final.id, firstLog]]))).toBe(polled);
    expect(withTournamentLogs(polled, new Map([[final.id, { ...log, winnerId: loser! }]]))).toBe(polled);
    const opening = lean('opening');
    expect(withTournamentLogs(opening, new Map([[opening.bouts[0].id, firstLog]]))).toBe(opening);
    const midway = lean('midway');
    const bye = midway.bouts.find(b => b.revealedResult?.bye)!;
    expect(withTournamentLogs(midway, new Map([[bye.id, firstLog]]))).toBe(midway);
  });

  it('fails closed on a malformed fight summary, as on a malformed log', () => {
    const decided = (patch: (fight: Record<string, unknown>) => void) => {
      const polled = structuredClone(lean('pair'));
      patch(polled.bouts[0].revealedResult!.fight as unknown as Record<string, unknown>);
      return renderTournament(polled, S('pair') + 79 * MIN).rounds[0].bouts[0].status;
    };
    expect(decided(() => {})).toBe('decided');
    for (const patch of [(f: Record<string, unknown>) => { f.durationMs = -1; }, (f: Record<string, unknown>) => { f.durationMs = '9000'; },
      (f: Record<string, unknown>) => { f.durationMs = Number.POSITIVE_INFINITY; }, (f: Record<string, unknown>) => { f.victoryReason = 7; }]) {
      expect(decided(patch)).toBe('delayed');
    }
  });

  it('backs processing re-reads off from 30 s, doubling to a 5-minute cap', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(processingRetryDelay)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
  });
});
