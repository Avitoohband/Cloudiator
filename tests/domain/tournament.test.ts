import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTournamentRatings, buildBracket, isTournamentSlot, partitionTournament, placementGrants, readyBouts, recordBout, runBout,
  tournamentOutcomes, type BoutJob, type SlotWindow, type TournamentCandidate, type TournamentGraph } from '@domain/tournament.ts';
import { matchArena, RETAINED_RULES, type ArenaEntrant } from '@domain/arena.ts';
import { CATALOG_V1 } from '@domain/catalog-v1.ts';
import { slotAt } from '@domain/clock.ts';
import { makeFighter, simulateBattle } from '@domain/combat.ts';
import { RULES_V1 } from '@domain/rules-v1.ts';
import type { LeagueId } from '@contracts/commands.ts';
import type { BattleLog } from '@contracts/events.ts';
import type { Attributes, BattleParticipant, BuildSnapshot, EquipmentSlot, ItemInstance, Rules } from '@domain/types.ts';
import { baseFiveBuild, itemFixture } from '../fixtures/domain.ts';

/**
 * A second retained rules version, added to Arena's registry for this suite only (production retains v1 alone). It
 * changes values the tournament reads from its inputs' rules: Elo K and floor, fight renown, tournament days, the
 * minimum entrant count and placement bonuses. Combat is unchanged, so v1 fighters stay valid under it.
 */
const CUSTOM = vi.hoisted(() => 'v1-custom');
vi.mock('@domain/arena.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('@domain/arena.ts')>();
  const { RULES_V1: v1 } = await import('@domain/rules-v1.ts');
  const custom: Rules = { ...v1, version: CUSTOM, rating: { ...v1.rating, k: 32, minimum: 100 },
    arena: { ...v1.arena, humanWinRenown: 7, humanLossRenown: 1 },
    tournament: { ...v1.tournament, utcWeekdays: [3], minimumEntrants: 3, placements: { winner: { money: 90, renown: 40 },
      runnerUp: { money: 50, renown: 20 }, semifinal: { money: 20, renown: 10 }, other: { money: 1, renown: 3 } } } };
  return { ...actual, RETAINED_RULES: Object.freeze({ ...actual.RETAINED_RULES, [CUSTOM]: custom }) };
});

const MINUTE = 60_000;
const SLOT_MS = RULES_V1.clock.slotMs;
/** Wednesday 2026-10-14 17:20 UTC: slot 373333, an afternoon. */
const WEDNESDAY = Date.UTC(2026, 9, 14, 17, 20);
const SLOT = WEDNESDAY / SLOT_MS;
/** Saturday 2026-10-17 17:20 UTC, the next tournament slot. */
const SATURDAY = Date.UTC(2026, 9, 17, 17, 20);
const LEAGUES: LeagueId[] = ['bronze', 'silver', 'gold', 'champion'];

const item = (id: string): ItemInstance => itemFixture(CATALOG_V1.items[id]);
function build(classId: BuildSnapshot['classId'], stance: BuildSnapshot['stance'], allocations: Attributes,
  equipment: Partial<Record<EquipmentSlot, ItemInstance>> = {}): BuildSnapshot {
  return { rulesVersion: 'v1', classId, stance, allocations, equipment: { ...baseFiveBuild.equipment, ...equipment } };
}
const arena = (snapshot: BuildSnapshot) => makeFighter(snapshot, 'arena', RULES_V1);
/** Berserker {4, 2, 2, 1, 1} with the starter sword and light armor: a typical new real build. */
const starter = arena(build('berserker', 'balanced', { strength: 4, agility: 2, vitality: 2, endurance: 1, precision: 1 },
  { weapon: item('sword:1:common'), body: item('light-armor:1:common') }));
const entrant = (gladiatorId: string, patch: Partial<ArenaEntrant> = {}): ArenaEntrant => ({
  gladiatorId, activityId: `activity-${gladiatorId}`, seasonId: 'season-1', league: 'bronze', slotIndex: SLOT, rating: 1000,
  fighter: starter, ...patch });
/** An opted-in Arena entrant with full stamina, toggled on an hour before the Wednesday cutoff. */
const candidate = (gladiatorId: string, patch: Partial<TournamentCandidate> = {}, entrantPatch: Partial<ArenaEntrant> = {}): TournamentCandidate => ({
  entrant: entrant(gladiatorId, entrantPatch), choice: { kind: 'arena' }, stamina: 104, costs: { arena: 25, tournament: 25 },
  optIn: [{ enabled: true, receivedAtMs: WEDNESDAY - 60 * MINUTE }], ...patch });
const routeOf = (partition: ReturnType<typeof partitionTournament>, gladiatorId: string) =>
  partition.routes.find(r => r.gladiatorId === gladiatorId);
/** The starter build frozen under the suite's custom retained rules. */
const customFighter = { ...starter, rulesVersion: CUSTOM };
const customEntrant = (gladiatorId: string, patch: Partial<ArenaEntrant> = {}) => entrant(gladiatorId, { fighter: customFighter, ...patch });

describe('retained rules', () => {
  it('reads retained rules from the Arena registry, not a second copy', () => {
    expect(RETAINED_RULES[CUSTOM].version).toBe(CUSTOM);
    const graph = buildBracket(['c1', 'c2', 'c3'].map(id => customEntrant(id)), 'registry');
    expect(graph.rulesVersion).toBe(CUSTOM);
    expect(graph.entries.every(e => e.fighter.rulesVersion === CUSTOM)).toBe(true);
    // A version neither registry retains still fails closed.
    expect(() => buildBracket(['u1', 'u2', 'u3'].map(id => entrant(id, { fighter: { ...starter, rulesVersion: 'v2' } })), 'registry'))
      .toThrow(RangeError);
  });
  it('settles ratings, fight renown and placements with the graph rules', () => {
    // Four entrants at the custom floor 100. K 32 gains 16 per equal bout and every loser is clamped at 100, where the
    // default v1 Elo (K 24, floor 0) would give 124 for the champion and 88 for each first-round loser.
    const done = play(buildBracket(['c1', 'c2', 'c3', 'c4'].map(id => customEntrant(id, { rating: 100 })), 'custom-elo'));
    expect(applyTournamentRatings(done).bouts.map(b => [b.round, b.winnerBefore, b.winnerAfter, b.loserBefore, b.loserAfter]))
      .toEqual([[1, 100, 116, 100, 100], [1, 100, 116, 100, 100], [2, 116, 132, 116, 100]]);
    // Fight renown 7 a win and 1 a loss, plus the custom placements.
    expect(tournamentOutcomes(done).map(o => [o.place, o.ratingAfter, o.rewards.money, o.rewards.renown]).sort((a, b) => a[0] - b[0]))
      .toEqual([[1, 132, 90, 54], [2, 100, 50, 28], [3, 100, 20, 11], [3, 100, 20, 11]]);
  });
  it('partitions with the candidates rules: tournament days, minimum entrants and rating floor', () => {
    const custom = (id: string, patch: Partial<TournamentCandidate> = {}, entrantPatch: Partial<ArenaEntrant> = {}) =>
      candidate(id, patch, { fighter: customFighter, ...entrantPatch });
    const wednesday = slotAt(WEDNESDAY);
    const two = partitionTournament(wednesday, [custom('c1'), custom('c2')]);
    expect(two.brackets).toEqual([]);
    expect(two.routes.map(r => [r.route, r.reason])).toEqual([['arena', 'too-few-entrants'], ['arena', 'too-few-entrants']]);
    expect(partitionTournament(wednesday, [custom('c1'), custom('c2'), custom('c3')]).brackets.map(b => b.entrants.length)).toEqual([3]);
    // Saturday is not a tournament day under these rules.
    const saturday = slotAt(SATURDAY);
    const weekend = partitionTournament(saturday, ['c1', 'c2', 'c3'].map(id => custom(id, {}, { slotIndex: saturday.index })));
    expect(weekend.tournamentSlot).toBe(false);
    expect(weekend.routes.every(r => r.route === 'arena' && r.reason === 'not-tournament-slot')).toBe(true);
    expect(() => partitionTournament(wednesday, [custom('c1', {}, { rating: 99 })])).toThrow(RangeError);
    expect(() => partitionTournament(wednesday, [custom('c1'), custom('c2'), candidate('v1')])).toThrow(/share one rules version/);
  });
  it('builds brackets with the entrants rules and detects slots with the rules it is given, defaulting to v1', () => {
    expect(() => buildBracket(['c1', 'c2'].map(id => customEntrant(id)), 'custom')).toThrow(RangeError);
    expect(() => buildBracket(['c1', 'c2', 'c3'].map(id => customEntrant(id, { slotIndex: SATURDAY / SLOT_MS })), 'custom')).toThrow(RangeError);
    expect(() => buildBracket(['c1', 'c2', 'c3'].map(id => customEntrant(id, { rating: 99 })), 'custom')).toThrow(RangeError);
    expect(isTournamentSlot(slotAt(SATURDAY), RETAINED_RULES[CUSTOM])).toBe(false);
    expect(isTournamentSlot(slotAt(WEDNESDAY), RETAINED_RULES[CUSTOM])).toBe(true);
    expect(isTournamentSlot(slotAt(SATURDAY))).toBe(true);
  });
});

describe('tournament slot detection', () => {
  const originalTz = process.env.TZ;
  afterEach(() => { process.env.TZ = originalTz; });

  it('detects Wednesday and Saturday 17:20 UTC afternoon slots', () => {
    expect(SLOT).toBe(373_333);
    expect(isTournamentSlot(slotAt(WEDNESDAY))).toBe(true);
    expect(isTournamentSlot(slotAt(Date.UTC(2026, 9, 17, 17, 20)))).toBe(true);
    // The slot lasts 80 minutes: its final millisecond is still the same tournament slot.
    expect(isTournamentSlot(slotAt(WEDNESDAY + SLOT_MS - 1))).toBe(true);
  });
  it('rejects the neighbouring slots at the cutoff ±1 ms', () => {
    expect(isTournamentSlot(slotAt(WEDNESDAY - 1))).toBe(false);
    expect(isTournamentSlot(slotAt(WEDNESDAY + SLOT_MS))).toBe(false);
  });
  it('finds exactly two tournament slots in a week, both afternoons', () => {
    const found: number[] = [];
    // Monday 2026-10-12 00:00 UTC through the following Sunday: 7 × 18 slots.
    const monday = Date.UTC(2026, 9, 12) / SLOT_MS;
    for (let index = monday; index < monday + 7 * 18; index += 1) {
      const slot = slotAt(index * SLOT_MS);
      if (isTournamentSlot(slot)) { found.push(slot.startMs); expect(slot.phase).toBe('afternoon'); }
    }
    expect(found).toEqual([Date.UTC(2026, 9, 14, 17, 20), Date.UTC(2026, 9, 17, 17, 20)]);
  });
  it.each([
    // EU summer time ends Sunday 2026-10-25 and starts Sunday 2027-03-28; US time ends Sunday 2026-11-01.
    [Date.UTC(2026, 9, 24, 17, 20), true], [Date.UTC(2026, 9, 25, 17, 20), false], [Date.UTC(2026, 9, 28, 17, 20), true],
    [Date.UTC(2026, 9, 31, 17, 20), true], [Date.UTC(2026, 10, 4, 17, 20), true],
    [Date.UTC(2027, 2, 27, 17, 20), true], [Date.UTC(2027, 2, 28, 17, 20), false], [Date.UTC(2027, 2, 31, 17, 20), true],
    // 17:20 local on those dates is a different UTC slot: London summer time, Jerusalem winter time, New York summer
    // time (21:20 UTC is an afternoon slot start, but not 17:20).
    [Date.UTC(2026, 9, 24, 16, 20), false], [Date.UTC(2026, 9, 28, 15, 20), false], [Date.UTC(2027, 2, 31, 21, 20), false],
  ])('uses UTC slot math only across daylight-saving changes (%i ms → %s)', (ms, expected) => {
    for (const zone of ['UTC', 'Europe/London', 'Asia/Jerusalem', 'America/New_York', 'Pacific/Auckland']) {
      process.env.TZ = zone;
      expect(isTournamentSlot(slotAt(ms))).toBe(expected);
    }
  });
  it.each([
    { index: SLOT, phase: 'afternoon', startMs: WEDNESDAY + 1, endMs: WEDNESDAY + SLOT_MS + 1 },
    { index: SLOT, phase: 'morning', startMs: WEDNESDAY, endMs: WEDNESDAY + SLOT_MS },
    { index: SLOT + 1, phase: 'afternoon', startMs: WEDNESDAY, endMs: WEDNESDAY + SLOT_MS },
    { index: SLOT, phase: 'afternoon', startMs: WEDNESDAY, endMs: WEDNESDAY + 80 * MINUTE - 1 },
    { index: -1, phase: 'evening', startMs: -SLOT_MS, endMs: 0 },
    null,
  ])('rejects a slot window that is not a canonical UTC slot: %j', (slot) => {
    expect(() => isTournamentSlot(slot as unknown as SlotWindow)).toThrow(RangeError);
  });
});

describe('tournament eligibility', () => {
  const wednesday = slotAt(WEDNESDAY);
  const ids = (entrants: readonly { gladiatorId: string }[]) => entrants.map(e => e.gladiatorId);

  it('puts opted-in Arena entrants with stamina into their league bracket and charges each once', () => {
    const partition = partitionTournament(wednesday, [candidate('a'), candidate('b'), candidate('c')]);
    expect(partition.tournamentSlot).toBe(true);
    expect(partition.slotIndex).toBe(SLOT);
    expect(partition.brackets.map(b => [b.league, ids(b.entrants)])).toEqual([['bronze', ['a', 'b', 'c']]]);
    expect(partition.arena).toEqual([]);
    expect(partition.routes).toEqual(['a', 'b', 'c'].map(id => ({ gladiatorId: id, activityId: `activity-${id}`, league: 'bronze',
      route: 'tournament', reason: 'bracket', staminaDebit: 25 })));
  });
  it('runs one bracket per league with at least two eligible entrants, never across leagues', () => {
    const league = (id: string, l: LeagueId, patch: Partial<TournamentCandidate> = {}) => candidate(id, patch, { league: l });
    const partition = partitionTournament(wednesday, [
      league('b1', 'bronze'), league('s1', 'silver'), league('g1', 'gold'), league('b2', 'bronze'), league('g2', 'gold'),
      league('g3', 'gold'), league('s2', 'silver', { optIn: [] }), league('c1', 'champion', { optIn: [] }),
    ]);
    expect(partition.brackets.map(b => [b.league, ids(b.entrants)])).toEqual([['bronze', ['b1', 'b2']], ['gold', ['g1', 'g2', 'g3']]]);
    for (const bracket of partition.brackets) expect(bracket.entrants.every(e => e.league === bracket.league)).toBe(true);
    // The lone opted-in Silver entrant runs regular Arena (with NPC fallback if needed), like the opted-out entrants.
    expect(ids(partition.arena)).toEqual(['s1', 's2', 'c1']);
    expect(routeOf(partition, 's1')).toMatchObject({ route: 'arena', reason: 'too-few-entrants', staminaDebit: 25 });
    expect(routeOf(partition, 's2')).toMatchObject({ route: 'arena', reason: 'opted-out', staminaDebit: 25 });
    expect(routeOf(partition, 'c1')).toMatchObject({ route: 'arena', reason: 'opted-out', staminaDebit: 25 });
  });
  it('sends every Arena entrant to regular Arena outside the tournament slots', () => {
    for (const ms of [WEDNESDAY - 1, WEDNESDAY + SLOT_MS, WEDNESDAY - 3 * SLOT_MS]) {
      const slot = slotAt(ms);
      const partition = partitionTournament(slot, ['a', 'b', 'c'].map(id => candidate(id, {}, { slotIndex: slot.index })));
      expect(partition.tournamentSlot).toBe(false);
      expect(partition.brackets).toEqual([]);
      expect(ids(partition.arena)).toEqual(['a', 'b', 'c']);
      expect(partition.routes.every(r => r.route === 'arena' && r.reason === 'not-tournament-slot' && r.staminaDebit === 25)).toBe(true);
    }
  });
  describe('opt-in at the slot cutoff', () => {
    // Two fixed partners keep the Bronze bracket alive whatever the subject's route is.
    const partners = [candidate('p1'), candidate('p2')];
    const routeWith = (optIn: TournamentCandidate['optIn'], slot = wednesday) => routeOf(partitionTournament(slot,
      [...partners.map(p => ({ ...p, entrant: { ...p.entrant, slotIndex: slot.index } })),
        candidate('subject', { optIn }, { slotIndex: slot.index })]), 'subject');
    it.each([
      [WEDNESDAY - 1, 'tournament'], [WEDNESDAY, 'arena'], [WEDNESDAY + 1, 'arena'],
    ])('counts an opt-in received at %i ms only when it precedes the cutoff (→ %s)', (receivedAtMs, route) => {
      expect(routeWith([{ enabled: true, receivedAtMs }])?.route).toBe(route);
    });
    it.each([
      [WEDNESDAY - 1, 'arena'], [WEDNESDAY, 'tournament'], [WEDNESDAY + 1, 'tournament'],
    ])('counts an opt-out received at %i ms only when it precedes the cutoff (→ %s)', (receivedAtMs, route) => {
      expect(routeWith([{ enabled: true, receivedAtMs: WEDNESDAY - 2 * SLOT_MS }, { enabled: false, receivedAtMs }])?.route).toBe(route);
    });
    it('treats a character that never opted in as opted out', () => {
      expect(routeWith([])).toMatchObject({ route: 'arena', reason: 'opted-out' });
    });
    it('uses the last toggle committed before the cutoff, in commit order within one millisecond', () => {
      const t = WEDNESDAY - 10;
      expect(routeWith([{ enabled: true, receivedAtMs: t }, { enabled: false, receivedAtMs: t }])?.route).toBe('arena');
      expect(routeWith([{ enabled: false, receivedAtMs: t }, { enabled: true, receivedAtMs: t }])?.route).toBe('tournament');
    });
    it('applies a toggle made after the cutoff to the next tournament', () => {
      const late = [{ enabled: true, receivedAtMs: WEDNESDAY + 5 * MINUTE }];
      expect(routeWith(late)?.route).toBe('arena');
      expect(routeWith(late, slotAt(SATURDAY))?.route).toBe('tournament');
    });
  });
  it('requires sufficient stamina at the cutoff, inclusive of the exact cost', () => {
    const partition = partitionTournament(wednesday, [candidate('a'), candidate('b'), candidate('exact', { stamina: 25 }),
      candidate('short', { stamina: 24 }), candidate('empty', { stamina: 0 })]);
    expect(ids(partition.brackets[0].entrants)).toEqual(['a', 'b', 'exact']);
    // An unaffordable Arena activity resolves as Rest with no debit; it neither enters the bracket nor regular Arena.
    expect(routeOf(partition, 'short')).toMatchObject({ route: 'rest', reason: 'insufficient-stamina', staminaDebit: 0 });
    expect(routeOf(partition, 'empty')).toMatchObject({ route: 'rest', reason: 'insufficient-stamina', staminaDebit: 0 });
    expect(partition.arena).toEqual([]);
  });
  it('keeps an entrant that affords Arena but not the tournament in regular Arena', () => {
    const costs = { arena: 25, tournament: 30 };
    const partition = partitionTournament(wednesday, [candidate('a', { costs }), candidate('b', { costs }), candidate('mid', { costs, stamina: 29 })]);
    expect(ids(partition.brackets[0].entrants)).toEqual(['a', 'b']);
    expect(routeOf(partition, 'a')).toMatchObject({ route: 'tournament', staminaDebit: 30 });
    expect(routeOf(partition, 'mid')).toMatchObject({ route: 'arena', reason: 'insufficient-stamina', staminaDebit: 25 });
  });
  it('sends a candidate that cannot afford Arena to Rest even when the tournament costs less, as boundary step 6 does', () => {
    const costs = { arena: 30, tournament: 25 };
    const partition = partitionTournament(wednesday, [candidate('a', { costs }), candidate('b', { costs }),
      candidate('cheap', { costs, stamina: 27 })]);
    expect(routeOf(partition, 'cheap')).toMatchObject({ route: 'rest', reason: 'insufficient-stamina', staminaDebit: 0 });
    expect(ids(partition.brackets[0].entrants)).toEqual(['a', 'b']);
    expect(routeOf(partition, 'a')).toMatchObject({ route: 'tournament', staminaDebit: 25 });
    expect(partition.arena).toEqual([]);
  });
  it('ignores characters without Arena scheduled for the phase', () => {
    const partition = partitionTournament(wednesday, [candidate('a'), candidate('b'), candidate('trainer', { choice: { kind: 'training' } }),
      candidate('explorer', { choice: { kind: 'expedition', expeditionId: 'woodland' } })]);
    expect(ids(partition.brackets[0].entrants)).toEqual(['a', 'b']);
    expect(partition.arena).toEqual([]);
    expect(routeOf(partition, 'trainer')).toMatchObject({ route: 'other', reason: 'not-arena', staminaDebit: 0 });
    expect(routeOf(partition, 'explorer')).toMatchObject({ route: 'other', reason: 'not-arena', staminaDebit: 0 });
  });
  it('routes every Arena entrant exactly once, so regular Arena receives each fallback once', () => {
    const all = [...Array(7).keys()].map(i => candidate(`e${i}`, i % 3 === 0 ? { optIn: [] } : {}, { league: i < 5 ? 'bronze' : 'silver' }));
    all.push(candidate('lone', {}, { league: 'gold' }));
    const partition = partitionTournament(wednesday, all);
    const routed = [...partition.brackets.flatMap(b => ids(b.entrants)), ...ids(partition.arena)];
    expect([...routed].sort()).toEqual(ids(all.map(c => c.entrant)).sort());
    expect(partition.routes.map(r => r.gladiatorId)).toEqual(ids(all.map(c => c.entrant)));
    const assigned = matchArena(partition.arena, [], 'fallback').flatMap(a => a.sides.map(s => s.gladiatorId));
    expect([...assigned].sort()).toEqual(ids(partition.arena).sort());
  });
  it('returns frozen copies without freezing or keeping the caller objects', () => {
    const input = [candidate('a'), candidate('b')];
    const partition = partitionTournament(wednesday, input);
    expect(Object.isFrozen(partition) && Object.isFrozen(partition.brackets[0].entrants[0].fighter)).toBe(true);
    expect(Object.isFrozen(input[0]) || Object.isFrozen(input[0].entrant)).toBe(false);
    expect(partition.brackets[0].entrants[0]).not.toBe(input[0].entrant);
    expect(partition.brackets[0].entrants[0]).toEqual(input[0].entrant);
  });
  it.each([
    ['a duplicate gladiator', [candidate('a'), candidate('a', {}, { activityId: 'other' })]],
    ['a duplicate activity', [candidate('a'), candidate('b', {}, { activityId: 'activity-a' })]],
    ['another slot', [candidate('a'), candidate('b', {}, { slotIndex: SLOT + 1 })]],
    ['another season', [candidate('a'), candidate('b', {}, { seasonId: 'season-2' })]],
    ['an unknown league', [candidate('a', {}, { league: 'diamond' as LeagueId })]],
    ['negative stamina', [candidate('a', { stamina: -1 })]],
    ['fractional stamina', [candidate('a', { stamina: 24.5 })]],
    ['an unsafe cost', [candidate('a', { costs: { arena: 25, tournament: Number.MAX_SAFE_INTEGER + 1 } })]],
    ['an unknown choice', [candidate('a', { choice: { kind: 'duel' } as never })]],
    ['out-of-order toggles', [candidate('a', { optIn: [{ enabled: true, receivedAtMs: 10 }, { enabled: false, receivedAtMs: 9 }] })]],
    ['a non-boolean toggle', [candidate('a', { optIn: [{ enabled: 'yes' as never, receivedAtMs: 10 }] })]],
    ['a missing entrant', [{ ...candidate('a'), entrant: null as never }]],
  ])('rejects %s', (_name, candidates) => {
    expect(() => partitionTournament(wednesday, candidates)).toThrow(RangeError);
  });
  it('rejects a malformed slot window', () => {
    expect(() => partitionTournament({ ...wednesday, startMs: WEDNESDAY + 1 }, [candidate('a')])).toThrow(RangeError);
  });
});

/** `n` Bronze entrants `g00 … g(n−1)` with real, varied v1 arena builds. */
const CLASSES = ['berserker', 'guardian', 'duelist'] as const;
const WEAPONS = ['sword:1:common', 'axe:1:common', 'spear:1:common'];
const roster = (n: number, patch: Partial<ArenaEntrant> = {}): ArenaEntrant[] => [...Array(n).keys()].map(i => entrant(
  `g${String(i).padStart(2, '0')}`, { fighter: arena(build(CLASSES[i % 3], (['balanced', 'offensive', 'defensive'] as const)[i % 3],
    { strength: 2 + (i % 4), agility: 2, vitality: 2 + ((i * 2) % 3), endurance: 1, precision: 3 - (i % 4 === 3 ? 1 : 0) },
    { weapon: item(WEAPONS[i % 3]) })), rating: 1000 + 8 * (i % 5), ...patch }));
const round1 = (graph: TournamentGraph) => graph.bouts.filter(b => b.round === 1);

describe('seeded single-elimination bracket', () => {
  it('versions the 80-minute tournament duration with the slot length', () => {
    expect(RULES_V1.tournament.durationMs).toBe(80 * MINUTE);
    expect(RULES_V1.tournament.durationMs).toBe(SLOT_MS);
  });
  it.each([
    [2, 2, 1], [3, 4, 2], [4, 4, 2], [5, 8, 3], [8, 8, 3], [9, 16, 4], [17, 32, 5], [33, 64, 6], [50, 64, 6], [64, 64, 6],
  ])('fills %i entrants into a %i-slot bracket of %i rounds with byes', (n, size, rounds) => {
    const graph = buildBracket(roster(n), 'shape');
    expect([graph.size, graph.rounds, graph.bouts.length]).toEqual([size, rounds, size - 1]);
    for (let r = 1; r <= rounds; r += 1) expect(graph.bouts.filter(b => b.round === r).map(b => b.position)).toEqual([...Array(size >> r).keys()]);
    const placed = round1(graph).flatMap(b => b.placed!);
    expect(placed.filter(id => id === null)).toHaveLength(size - n);
    expect(placed.filter(id => id !== null).sort()).toEqual(roster(n).map(e => e.gladiatorId));
    // Never two byes in one bout, so every first-round bout has an entrant and no NPC is ever fabricated.
    expect(round1(graph).every(b => b.placed!.some(id => id !== null))).toBe(true);
    expect(round1(graph).filter(b => b.bye)).toHaveLength(size - n);
    expect(graph.entries.map(e => e.gladiatorId).sort()).toEqual(roster(n).map(e => e.gladiatorId));
    expect(JSON.stringify(graph)).not.toContain('npc');
  });
  it('gives the byes to the first seeded ranks, spread by standard bracket positions', () => {
    const graph = buildBracket(roster(5), 'spread');
    const rank = (id: string | null) => id === null ? null : graph.entries.find(e => e.gladiatorId === id)!.rank;
    expect(graph.entries.map(e => e.rank)).toEqual([1, 2, 3, 4, 5]);
    // Standard 8-slot order 1-8, 4-5, 2-7, 3-6: ranks 1, 2 and 3 meet the empty slots 8, 7 and 6.
    expect(round1(graph).map(b => b.placed!.map(rank))).toEqual([[1, null], [4, 5], [2, null], [3, null]]);
    expect(round1(graph).map(b => b.bye)).toEqual([true, false, true, true]);
  });
  it('places entrants in a seeded random order, independent of input order', () => {
    const entrants = roster(9);
    const graph = buildBracket(entrants, 'order');
    expect(buildBracket([...entrants].reverse(), 'order')).toEqual(graph);
    const orders = ['order', 'other', 'third', 'fourth'].map(seed => buildBracket(entrants, seed).entries.map(e => e.gladiatorId).join());
    expect(new Set(orders).size).toBeGreaterThan(1);
    expect(orders[0]).not.toBe(entrants.map(e => e.gladiatorId).join());
  });
  it('keeps stable bout and parent ids across rebuilds and seeds', () => {
    const graph = buildBracket(roster(5), 'ids');
    expect(buildBracket(roster(5), 'ids')).toEqual(graph);
    const skeleton = (g: TournamentGraph) => g.bouts.map(b => [b.id, b.battleId, b.round, b.position, b.parentBoutIds, b.revealAtMs]);
    expect(skeleton(buildBracket(roster(5), 'another seed'))).toEqual(skeleton(graph));
    const id = `tournament:${SLOT}:bronze`;
    expect(graph.id).toBe(id);
    expect(skeleton(graph).map(([boutId, battleId, round, position, parents]) => [boutId, battleId, round, position, parents])).toEqual([
      [`${id}:1:0`, `${id}:1:0`, 1, 0, []], [`${id}:1:1`, `${id}:1:1`, 1, 1, []],
      [`${id}:1:2`, `${id}:1:2`, 1, 2, []], [`${id}:1:3`, `${id}:1:3`, 1, 3, []],
      [`${id}:2:0`, `${id}:2:0`, 2, 0, [`${id}:1:0`, `${id}:1:1`]], [`${id}:2:1`, `${id}:2:1`, 2, 1, [`${id}:1:2`, `${id}:1:3`]],
      [`${id}:3:0`, `${id}:3:0`, 3, 0, [`${id}:2:0`, `${id}:2:1`]],
    ]);
    expect(buildBracket(roster(2, { league: 'gold' }), 'ids').id).toBe(`tournament:${SLOT}:gold`);
  });
  it('derives no bout seed: neither the graph nor its jobs carry the tournament seed or a seed derived from it', () => {
    const graph = buildBracket(roster(9), 'tournament-secret');
    expect(graph.bouts.some(b => 'seed' in b)).toBe(false);
    expect(JSON.stringify(graph)).not.toContain('tournament-secret');
    const jobs = readyBouts(graph);
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.some(j => 'seed' in j)).toBe(false);
    expect(JSON.stringify(jobs)).not.toContain('tournament-secret');
  });
  it.each([
    // Round r of R reveals at 80 × r / (R + 1) minutes, rounded up to the next whole millisecond; settlement at minute 80.
    [2, [2_400_000]],
    [3, [1_600_000, 3_200_000]],
    [5, [1_200_000, 2_400_000, 3_600_000]],
    [9, [960_000, 1_920_000, 2_880_000, 3_840_000]],
    [17, [800_000, 1_600_000, 2_400_000, 3_200_000, 4_000_000]],
    [33, [685_715, 1_371_429, 2_057_143, 2_742_858, 3_428_572, 4_114_286]],
  ])('schedules the reveals of a %i-entrant bracket at %j ms after the start', (n, offsets) => {
    const graph = buildBracket(roster(n), 'reveal');
    expect(graph.rounds).toBe(offsets.length);
    expect(graph.startsAtMs).toBe(WEDNESDAY);
    expect(graph.settlesAtMs).toBe(WEDNESDAY + 80 * MINUTE);
    expect(graph.revealAtMs).toEqual(offsets.map(offset => WEDNESDAY + offset));
    expect(graph.bouts.every(b => b.revealAtMs === graph.revealAtMs[b.round - 1])).toBe(true);
  });
  it('resolves byes at once, without a battle, and leaves real bouts unresolved', () => {
    const graph = buildBracket(roster(5), 'byes');
    for (const bout of graph.bouts) {
      if (bout.bye) expect(bout.result).toEqual({ winnerId: bout.placed!.find(id => id !== null), loserId: null, log: null });
      else expect(bout.result).toBeNull();
    }
    expect(graph.bouts.filter(b => b.bye).every(b => b.round === 1)).toBe(true);
  });
  it('freezes copies of the entry snapshots and ratings taken at the start', () => {
    const entrants = roster(4).map(e => ({ ...e, fighter: { ...e.fighter, attributes: { ...e.fighter.attributes } } }));
    const graph = buildBracket(entrants, 'frozen');
    expect(Object.isFrozen(graph) && Object.isFrozen(graph.entries[0].fighter.attributes) && Object.isFrozen(graph.bouts[0])).toBe(true);
    expect(Object.isFrozen(entrants[0]) || Object.isFrozen(entrants[0].fighter)).toBe(false);
    const before = structuredClone(graph);
    (entrants[0].fighter as { maxHealth: number }).maxHealth = 1;
    (entrants[0].fighter.attributes as { strength: number }).strength = 99;
    (entrants[0] as { rating: number }).rating = 0;
    expect(graph).toEqual(before);
    for (const entry of graph.entries) {
      const source = roster(4).find(e => e.gladiatorId === entry.gladiatorId)!;
      expect(entry).toEqual({ gladiatorId: source.gladiatorId, activityId: source.activityId, rating: source.rating,
        fighter: source.fighter, rank: entry.rank });
    }
  });
  it.each([
    ['no entrants', []],
    ['one entrant', roster(1)],
    ['two leagues', [...roster(2), entrant('silver', { league: 'silver' })]],
    ['two slots', [...roster(2), entrant('late', { slotIndex: SLOT + 3 })]],
    ['two seasons', [...roster(2), entrant('next', { seasonId: 'season-2' })]],
    ['a duplicate gladiator', [...roster(2), roster(1, { activityId: 'another' })[0]]],
    ['a duplicate activity', [...roster(2), entrant('x', { activityId: 'activity-g00' })]],
    ['a non-tournament slot', roster(3, { slotIndex: SLOT + 1 })],
    ['an invalid fighter', [...roster(2), entrant('bad', { fighter: { ...starter, maxHealth: 0 } })]],
    ['an unknown rules version', [...roster(2), entrant('v2', { fighter: { ...starter, rulesVersion: 'v2' } })]],
    ['a negative rating', [...roster(2), entrant('neg', { rating: -1 })]],
  ])('rejects %s', (_name, entrants) => {
    expect(() => buildBracket(entrants as ArenaEntrant[], 'reject')).toThrow(RangeError);
  });
  it('requires a private seed', () => {
    expect(() => buildBracket(roster(2), '')).toThrow(RangeError);
  });
});

/**
 * A per-bout seed as phase 2 storage supplies it (there a one-way SHA-256 derivation stored with the bout row). Tests
 * only need distinct, stable seeds per bout.
 */
const boutSeed = (job: BoutJob, salt = 'bout') => `${salt}:${job.boutId}`;
/** Runs every ready bout, one job at a time, until none remain: the phase 2 job graph without a database. */
function play(graph: TournamentGraph): TournamentGraph {
  for (let jobs = readyBouts(graph); jobs.length > 0; jobs = readyBouts(graph)) {
    for (const job of jobs) graph = recordBout(graph, job.boutId, runBout(job, boutSeed(job)));
  }
  return graph;
}
/** The real engine bout of `job` under another seed, used to choose a wanted outcome deterministically. */
const reseeded = (job: BoutJob, seed: string): BattleLog => simulateBattle({ battleId: job.battleId, rulesVersion: job.rulesVersion,
  rules: RULES_V1, fighters: job.sides.map(s => ({ id: s.gladiatorId, gladiatorId: s.gladiatorId, name: 'Gladiator', snapshot: s.fighter })) as
    [BattleParticipant, BattleParticipant] }, seed);
function logWhere(job: BoutJob, prefix: string, wanted: (log: BattleLog) => boolean): BattleLog {
  for (let n = 0; n < 2000; n += 1) { const log = reseeded(job, `${prefix}-${n}`); if (wanted(log)) return log; }
  throw new Error(`no ${prefix} seed`);
}
/** Duelist {2, 2, 0, 3, 3} with a sword: equal intervals make simultaneous lethal attacks possible (Task 16 fixture). */
const mirror = arena(build('duelist', 'balanced', { strength: 2, agility: 2, vitality: 0, endurance: 3, precision: 3 }, { weapon: item('sword:1:common') }));
const byId = (graph: TournamentGraph, id: string) => graph.bouts.find(b => b.id === id)!;

describe('bout jobs and results', () => {
  it('readies only bouts whose parents are resolved, with byes resolved at once', () => {
    let graph = buildBracket(roster(5), 'ready');
    const id = graph.id;
    // Ranks 4-5 fight in round 1; ranks 2 and 3 both had byes, so their semifinal is ready immediately.
    const run = (job: BoutJob) => runBout(job, boutSeed(job));
    expect(readyBouts(graph).map(j => j.boutId)).toEqual([`${id}:1:1`, `${id}:2:1`]);
    graph = recordBout(graph, `${id}:1:1`, run(readyBouts(graph)[0]));
    expect(readyBouts(graph).map(j => j.boutId)).toEqual([`${id}:2:0`, `${id}:2:1`]);
    graph = recordBout(graph, `${id}:2:1`, run(readyBouts(graph)[1]));
    expect(readyBouts(graph).map(j => j.boutId)).toEqual([`${id}:2:0`]);
    graph = recordBout(graph, `${id}:2:0`, run(readyBouts(graph)[0]));
    expect(readyBouts(graph).map(j => j.boutId)).toEqual([`${id}:3:0`]);
    graph = recordBout(graph, `${id}:3:0`, run(readyBouts(graph)[0]));
    expect(readyBouts(graph)).toEqual([]);
  });
  it('gives a two-person bracket exactly one bout', () => {
    const graph = buildBracket(roster(2), 'pair');
    expect(graph.bouts).toHaveLength(1);
    const [job] = readyBouts(graph);
    expect(job.parentBoutIds).toEqual([]);
    expect(readyBouts(play(graph))).toEqual([]);
  });
  it('builds each job from the frozen snapshots and the reveal time, with no seed', () => {
    const graph = buildBracket(roster(4), 'job');
    const [job] = readyBouts(graph);
    const bout = byId(graph, job.boutId);
    const entry = (gid: string) => graph.entries.find(e => e.gladiatorId === gid)!;
    expect(job).toEqual({ tournamentId: graph.id, boutId: bout.id, battleId: bout.battleId, round: 1, position: 0, parentBoutIds: [],
      rulesVersion: 'v1', revealAtMs: graph.revealAtMs[0],
      sides: bout.placed!.map(gid => ({ gladiatorId: gid, activityId: entry(gid!).activityId, fighter: entry(gid!).fighter })) });
    expect(Object.isFrozen(job)).toBe(true);
  });
  it('simulates a bout only from the bout seed phase 2 supplies', () => {
    const [job] = readyBouts(buildBracket(roster(4), 'supplied'));
    expect(runBout(job, 'bout-seed-a')).toEqual(reseeded(job, 'bout-seed-a'));
    expect(runBout(job, 'bout-seed-b').events).not.toEqual(runBout(job, 'bout-seed-a').events);
    expect(() => runBout(job, '')).toThrow(RangeError);
    expect(() => (runBout as (job: BoutJob) => BattleLog)(job)).toThrow(RangeError);
  });
  it('replays a retried job identically from the same bout seed and snapshots', () => {
    const [job] = readyBouts(buildBracket(roster(4), 'retry'));
    expect(runBout(job, 'retry-seed')).toEqual(runBout(job, 'retry-seed'));
    expect(runBout(job, 'retry-seed')).toEqual(runBout(readyBouts(buildBracket(roster(4), 'retry'))[0], 'retry-seed'));
  });
  it('labels participants with the supplied names without changing the bout', () => {
    const [job] = readyBouts(buildBracket(roster(2), 'names'));
    const named = runBout(job, 'names-seed', { [job.sides[0].gladiatorId]: 'Aster', [job.sides[1].gladiatorId]: 'Brin' });
    const plain = runBout(job, 'names-seed');
    expect(named.participants.map(p => p.name)).toEqual(['Aster', 'Brin']);
    expect(plain.participants.map(p => p.name)).toEqual(['Gladiator', 'Gladiator']);
    expect(named.events).toEqual(plain.events);
    expect(named.winnerId).toBe(plain.winnerId);
  });
  it('starts every bout at full health with the initial snapshot, even after a 0-HP win', () => {
    // A bout seed whose first semifinal ends in a simultaneous defeat: its seeded winner advances at 0 HP.
    let graph = buildBracket(['m1', 'm2', 'm3', 'm4'].map(id => entrant(id, { fighter: mirror })), 'health');
    const [first] = readyBouts(graph);
    let tie: BattleLog | null = null;
    for (let n = 0; n < 2000 && !tie; n += 1) {
      const log = runBout(first, `health-${n}`);
      if (log.tieBreakReason === 'simultaneous-defeat') tie = log;
    }
    expect(tie?.finalHp).toEqual([0, 0]);
    graph = play(recordBout(graph, first.boutId, tie!));
    expect(graph.bouts[0].result).toMatchObject({ winnerId: tie!.winnerId });
    const finalLog = byId(graph, `${graph.id}:2:0`).result!.log!;
    expect(finalLog.participants.map(p => p.id)).toContain(tie!.winnerId);
    for (const p of finalLog.participants) {
      const entry = graph.entries.find(e => e.gladiatorId === p.id)!;
      expect([p.initialHealth, p.maxHealth]).toEqual([entry.fighter.maxHealth, entry.fighter.maxHealth]);
    }
    expect(graph.bouts.every(b => b.result!.log!.participants.every(p => p.initialHealth === p.maxHealth))).toBe(true);
  });
  it('advances the logged winnerId of a simultaneous defeat at 0 HP', () => {
    const graph = buildBracket(['m1', 'm2'].map(id => entrant(id, { fighter: mirror })), 'zero');
    const [job] = readyBouts(graph);
    for (const winner of ['m1', 'm2']) {
      const log = logWhere(job, `zero-${winner}`, l => l.tieBreakReason === 'simultaneous-defeat' && l.winnerId === winner);
      expect(log.finalHp).toEqual([0, 0]);
      expect(recordBout(graph, job.boutId, log).bouts[0].result).toMatchObject({ winnerId: winner, loserId: winner === 'm1' ? 'm2' : 'm1' });
    }
  });
  it('keeps every bout of an entrant on its frozen initial snapshot', () => {
    const graph = play(buildBracket(roster(8), 'snapshots'));
    for (const bout of graph.bouts) {
      for (const p of bout.result!.log!.participants) {
        const fighter = graph.entries.find(e => e.gladiatorId === p.id)!.fighter;
        expect([p.classId, p.stance, p.attributes, p.armor, p.attackIntervalMs, p.weaponDamage])
          .toEqual([fighter.classId, fighter.stance, fighter.attributes, fighter.armor, fighter.attackIntervalMs, fighter.weaponDamage]);
      }
    }
  });
  it('records a result as a new frozen graph and replays the same result idempotently', () => {
    const graph = buildBracket(roster(2), 'record');
    const [job] = readyBouts(graph);
    const log = runBout(job, boutSeed(job));
    const recorded = recordBout(graph, job.boutId, log);
    expect(graph.bouts[0].result).toBeNull();
    expect(Object.isFrozen(recorded) && Object.isFrozen(recorded.bouts[0].result)).toBe(true);
    expect(recorded.bouts[0].result).toEqual({ winnerId: log.winnerId,
      loserId: job.sides.map(s => s.gladiatorId).find(id => id !== log.winnerId), log });
    // A retried completion with the same log, even with JSON keys in another order, changes nothing.
    const reordered = Object.fromEntries(Object.entries(structuredClone(log)).reverse()) as BattleLog;
    expect(recordBout(recorded, job.boutId, structuredClone(log))).toBe(recorded);
    expect(recordBout(recorded, job.boutId, reordered)).toBe(recorded);
    const other = logWhere(job, 'other', l => l.winnerId !== log.winnerId);
    expect(() => recordBout(recorded, job.boutId, other)).toThrow(RangeError);
  });
  it('does not keep or freeze the caller log', () => {
    const graph = buildBracket(roster(2), 'copy');
    const [job] = readyBouts(graph);
    const log = structuredClone(runBout(job, boutSeed(job))) as BattleLog;
    const recorded = recordBout(graph, job.boutId, log);
    expect(Object.isFrozen(log)).toBe(false);
    (log as { durationMs: number }).durationMs = -1;
    expect(recorded.bouts[0].result!.log!.durationMs).not.toBe(-1);
  });
  describe('fences results to the ready bout they belong to', () => {
    const graph = buildBracket(roster(5), 'fence');
    const id = graph.id;
    const [job] = readyBouts(graph);
    const log = runBout(job, boutSeed(job));
    const participant = (i: 0 | 1, patch: object) => ({ ...log, participants: log.participants.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
    it.each([
      ['an unknown bout', `${id}:9:9`, log],
      ['a bye', `${id}:1:0`, log],
      ['a bout whose parents are unresolved', `${id}:3:0`, log],
      ['another battle id', job.boutId, { ...log, battleId: `${id}:1:2` }],
      ['another rules version', job.boutId, { ...log, rulesVersion: 'v2' }],
      ['a winner outside the bout', job.boutId, { ...log, winnerId: 'g99' }],
      ['swapped participants', job.boutId, { ...log, participants: [log.participants[1], log.participants[0]] }],
      ['a foreign participant', job.boutId, participant(0, { id: 'g99', gladiatorId: 'g99' })],
      ['reduced starting health', job.boutId, participant(1, { initialHealth: log.participants[1].maxHealth - 1 })],
      ['another build', job.boutId, participant(0, { maxHealth: log.participants[0].maxHealth + 10, initialHealth: log.participants[0].maxHealth + 10 })],
      ['another efficiency (5000 bp)', job.boutId, participant(0, { efficiencyBasisPoints: 5000 })],
      ['foreign equipment silhouettes', job.boutId, participant(1, { equipmentSilhouettes: ['great-axe:9:legendary'] })],
      ['a missing log', job.boutId, null],
    ])('rejects %s', (_name, bout, wrong) => {
      expect(() => recordBout(graph, bout, wrong as BattleLog)).toThrow(RangeError);
    });
  });
  describe('rejects a tampered graph', () => {
    const graph = buildBracket(roster(5), 'tamper');
    const bouts = (patch: (b: TournamentGraph['bouts'][number], i: number) => object) =>
      ({ ...graph, bouts: graph.bouts.map((b, i) => ({ ...b, ...patch(b, i) })) });
    it.each([
      ['a changed parent', bouts((b, i) => (i === 4 ? { parentBoutIds: [b.parentBoutIds[1], b.parentBoutIds[0]] } : {}))],
      ['swapped placement', bouts((b, i) => (i === 1 ? { placed: [b.placed![1], b.placed![0]] } : {}))],
      ['a moved reveal', bouts((b, i) => (i === 6 ? { revealAtMs: b.revealAtMs - 1 } : {}))],
      ['an invented bye winner', bouts((_, i) => (i === 0 ? { result: { winnerId: 'g99', loserId: null, log: null } } : {}))],
      ['a removed bye result', bouts((_, i) => (i === 0 ? { result: null } : {}))],
      ['a missing bout', { ...graph, bouts: graph.bouts.slice(1) }],
      ['an early settlement time', { ...graph, settlesAtMs: graph.settlesAtMs - 1 }],
      ['reordered entries', { ...graph, entries: [graph.entries[1], graph.entries[0], ...graph.entries.slice(2)] }],
      ['an unknown rules version', { ...graph, rulesVersion: 'v2' }],
      ['a corrupt fighter', { ...graph, entries: graph.entries.map((e, i) => (i === 0 ? { ...e, fighter: { ...e.fighter, maxHealth: 0 } } : e)) }],
      ['a result for an unready bout', bouts((_, i) => (i === 6 ? { result: { winnerId: 'g00', loserId: 'g01', log: null } } : {}))],
      ['null', null],
    ])('rejects %s', (_name, tampered) => {
      expect(() => readyBouts(tampered as TournamentGraph)).toThrow(RangeError);
    });
  });
  it('applies the recordBout log checks to every stored result before settlement', () => {
    const done = play(buildBracket(roster(5), 'stored'));
    const withLogs = (log: (bout: TournamentGraph['bouts'][number]) => unknown) => ({ ...done,
      bouts: done.bouts.map(b => (b.bye ? b : { ...b, result: { ...b.result!, log: log(b) } })) }) as TournamentGraph;
    // Stub logs carrying only the battle id and the winner.
    const stubs = withLogs(b => ({ battleId: b.battleId, winnerId: b.result!.winnerId }));
    // One real stored log altered after recording: its first combatant revealed at half efficiency.
    const finalId = `${done.id}:3:0`;
    const altered = withLogs(b => (b.id !== finalId ? b.result!.log : { ...b.result!.log!,
      participants: b.result!.log!.participants.map((p, i) => (i === 0 ? { ...p, efficiencyBasisPoints: 5000 } : p)) }));
    for (const graph of [stubs, altered]) {
      expect(() => tournamentOutcomes(graph)).toThrow(RangeError);
      expect(() => placementGrants(graph)).toThrow(RangeError);
      expect(() => applyTournamentRatings(graph)).toThrow(RangeError);
      expect(() => readyBouts(graph)).toThrow(RangeError);
    }
    expect(tournamentOutcomes(withLogs(b => b.result!.log))).toEqual(tournamentOutcomes(done));
  });
});

/** Plays a bracket with chosen winners: `winnerOf(job)` names each fought bout's winner, found by a reseeded real bout. */
function playWith(graph: TournamentGraph, winnerOf: (job: BoutJob) => string): TournamentGraph {
  for (let jobs = readyBouts(graph); jobs.length > 0; jobs = readyBouts(graph)) {
    for (const job of jobs) {
      const winner = winnerOf(job);
      graph = recordBout(graph, job.boutId, logWhere(job, `win-${job.boutId}-${winner}`, l => l.winnerId === winner));
    }
  }
  return graph;
}
/** A bracket of `ids` whose ratings are assigned by seeded rank (ranks do not depend on ratings). */
function rankedBracket(ids: string[], ratingByRank: number[], seed: string): TournamentGraph {
  const probe = buildBracket(ids.map(id => entrant(id)), seed);
  const rankOf = new Map(probe.entries.map(e => [e.gladiatorId, e.rank]));
  return buildBracket(ids.map(id => entrant(id, { rating: ratingByRank[rankOf.get(id)! - 1] })), seed);
}
const atRank = (graph: TournamentGraph, rank: number) => graph.entries[rank - 1].gladiatorId;

describe('round-ordered tournament ratings', () => {
  it('applies each round with the ratings updated by earlier rounds', () => {
    // Round 1: rank 1 (1000) beats rank 4 (1000); rank 2 (1100) beats rank 3 (1400). Final: rank 2 beats rank 1.
    const graph = rankedBracket(['a', 'b', 'c', 'd'], [1000, 1100, 1400, 1000], 'ratings');
    const [r1, r2, r3, r4] = [1, 2, 3, 4].map(rank => atRank(graph, rank));
    const done = playWith(graph, job => (job.round === 2 ? r2 : job.sides.some(s => s.gladiatorId === r1) ? r1 : r2));
    const ratings = applyTournamentRatings(done);
    expect(ratings.bouts).toEqual([
      { boutId: `${graph.id}:1:0`, round: 1, winnerId: r1, loserId: r4, winnerBefore: 1000, winnerAfter: 1012, loserBefore: 1000, loserAfter: 988 },
      { boutId: `${graph.id}:1:1`, round: 1, winnerId: r2, loserId: r3, winnerBefore: 1100, winnerAfter: 1120, loserBefore: 1400, loserAfter: 1380 },
      // 1120 against 1012 gains 8; the frozen 1100 against 1000 would have gained 9.
      { boutId: `${graph.id}:2:0`, round: 2, winnerId: r2, loserId: r1, winnerBefore: 1120, winnerAfter: 1128, loserBefore: 1012, loserAfter: 1004 },
    ]);
    expect(ratings.ratings).toEqual([
      { gladiatorId: r1, before: 1000, after: 1004, delta: 4 }, { gladiatorId: r2, before: 1100, after: 1128, delta: 28 },
      { gladiatorId: r3, before: 1400, after: 1380, delta: -20 }, { gladiatorId: r4, before: 1000, after: 988, delta: -12 },
    ]);
    expect(Object.isFrozen(ratings) && Object.isFrozen(ratings.bouts[0])).toBe(true);
  });
  it('rates no bye: an entrant with a bye changes rating only in fought bouts', () => {
    const graph = rankedBracket(['a', 'b', 'c'], [1000, 1000, 1000], 'bye-rating');
    const top = atRank(graph, 1);
    const done = playWith(graph, job => job.sides.some(s => s.gladiatorId === top) ? top : job.sides[0].gladiatorId);
    const ratings = applyTournamentRatings(done);
    expect(ratings.bouts).toHaveLength(2);
    expect(ratings.bouts.filter(b => b.winnerId === top || b.loserId === top).map(b => b.round)).toEqual([2]);
    // The bye winner meets the round-1 winner (1012) in the final: 1000 beating 1012 gains 12.
    expect(ratings.ratings.find(r => r.gladiatorId === top)).toEqual({ gladiatorId: top, before: 1000, after: 1012, delta: 12 });
  });
  it('clamps a loser at zero and reports the change actually applied', () => {
    const graph = rankedBracket(['low', 'high'], [0, 5], 'clamp');
    const done = playWith(graph, () => atRank(graph, 1));
    expect(applyTournamentRatings(done).ratings).toEqual([
      { gladiatorId: atRank(graph, 1), before: 0, after: 12, delta: 12 }, { gladiatorId: atRank(graph, 2), before: 5, after: 0, delta: -5 },
    ]);
  });
  it('rates n − 1 bouts with distinct players in every round', () => {
    const done = play(buildBracket(roster(50), 'fifty'));
    const ratings = applyTournamentRatings(done);
    expect(ratings.bouts).toHaveLength(49);
    for (let round = 1; round <= done.rounds; round += 1) {
      const players = ratings.bouts.filter(b => b.round === round).flatMap(b => [b.winnerId, b.loserId]);
      expect(new Set(players).size).toBe(players.length);
    }
    expect(ratings.bouts.map(b => b.round)).toEqual([...ratings.bouts.map(b => b.round)].sort((x, y) => x - y));
  });
  it('rejects an unfinished bracket', () => {
    const graph = buildBracket(roster(5), 'unfinished');
    expect(() => applyTournamentRatings(graph)).toThrow(RangeError);
    const first = readyBouts(graph)[0];
    expect(() => applyTournamentRatings(recordBout(graph, first.boutId, runBout(first, boutSeed(first))))).toThrow(RangeError);
  });
});

const noRewards = { money: 0, renown: 0, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 };

describe('placement grants and settlement outcomes', () => {
  const placements = (graph: TournamentGraph) => placementGrants(graph).map(g => [g.placement, g.place, g.money, g.renown]);
  it('grants the exact placement bonuses of a five-entrant bracket once each', () => {
    const done = play(buildBracket(roster(5), 'five'));
    expect(placements(done)).toEqual([['winner', 1, 100, 50], ['runner-up', 2, 60, 30], ['semifinal', 3, 30, 15],
      ['semifinal', 3, 30, 15], ['entrant', 5, 0, 5]]);
    const grants = placementGrants(done);
    expect(grants.map(g => g.gladiatorId).sort()).toEqual(done.entries.map(e => e.gladiatorId).sort());
    expect(grants.every(g => g.id === `${done.id}:placement:${g.gladiatorId}` && g.kind === 'placement' && g.tournamentId === done.id
      && g.activityId === `activity-${g.gladiatorId}`)).toBe(true);
    expect(Object.isFrozen(grants[0])).toBe(true);
  });
  it('awards only winner and runner-up placements in a two-person bracket', () => {
    expect(placements(play(buildBracket(roster(2), 'two')))).toEqual([['winner', 1, 100, 50], ['runner-up', 2, 60, 30]]);
  });
  it('awards one semifinal placement when a three-person bracket has a bye semifinal', () => {
    expect(placements(play(buildBracket(roster(3), 'three')))).toEqual([['winner', 1, 100, 50], ['runner-up', 2, 60, 30], ['semifinal', 3, 30, 15]]);
  });
  it('places every entrant of a fifty-person bracket by its elimination round', () => {
    const grants = placementGrants(play(buildBracket(roster(50), 'fifty')));
    const tally = (key: (g: (typeof grants)[number]) => string | number) =>
      Object.fromEntries([...new Set(grants.map(key))].map(k => [k, grants.filter(g => key(g) === k).length]));
    expect(tally(g => g.placement)).toEqual({ winner: 1, 'runner-up': 1, semifinal: 2, entrant: 46 });
    // 14 byes leave 18 first-round bouts; later rounds halve: 16, 8, 4, 2 and the final.
    expect(tally(g => g.place)).toEqual({ 1: 1, 2: 1, 3: 2, 5: 4, 9: 8, 17: 16, 33: 18 });
    expect(grants.filter(g => g.placement === 'entrant').every(g => g.money === 0 && g.renown === 5)).toBe(true);
  });
  it('keeps one stable grant identity per entrant across a replayed tournament', () => {
    const once = placementGrants(play(buildBracket(roster(9), 'stable')));
    expect(placementGrants(play(buildBracket([...roster(9)].reverse(), 'stable')))).toEqual(once);
    expect(new Set(once.map(g => g.id)).size).toBe(9);
  });
  it('combines fight renown with the placement and the round-ordered rating for each entrant', () => {
    const done = play(buildBracket(roster(5), 'outcomes'));
    const outcomes = tournamentOutcomes(done);
    const grants = new Map(placementGrants(done).map(g => [g.gladiatorId, g]));
    const ratings = new Map(applyTournamentRatings(done).ratings.map(r => [r.gladiatorId, r]));
    expect(outcomes.map(o => o.gladiatorId)).toEqual(done.entries.map(e => e.gladiatorId));
    for (const outcome of outcomes) {
      const grant = grants.get(outcome.gladiatorId)!, rating = ratings.get(outcome.gladiatorId)!;
      const wins = outcome.bouts.filter(b => b.kind === 'win').length, losses = outcome.bouts.filter(b => b.kind === 'loss').length;
      expect(outcome.bouts.map(b => b.renown)).toEqual(outcome.bouts.map(b => ({ bye: 0, win: 10, loss: 2 })[b.kind]));
      expect(outcome).toMatchObject({ activityId: `activity-${outcome.gladiatorId}`, place: grant.place, placement: grant, wins, losses,
        result: grant.place === 1 ? 'victory' : 'defeat', success: grant.place === 1,
        rewards: { ...noRewards, money: grant.money, renown: 10 * wins + 2 * losses + grant.renown },
        ratingBefore: rating.before, ratingAfter: rating.after, ratingDelta: rating.delta });
      expect(losses).toBe(grant.place === 1 ? 0 : 1);
      expect(outcome.bouts.reduce((sum, b) => sum + b.ratingDelta, 0)).toBe(rating.delta);
    }
    // Byes are their own kind: no win, no renown and no rating change.
    const byes = outcomes.flatMap(o => o.bouts.filter(b => b.kind === 'bye'));
    expect(byes).toHaveLength(3);
    expect(byes.every(b => b.renown === 0 && b.ratingDelta === 0)).toBe(true);
    // Human bouts for standings and the five-human-bout season rule: the 4 fought bouts, once per side, never a bye.
    expect(outcomes.reduce((sum, o) => sum + o.wins, 0)).toBe(4);
    expect(outcomes.reduce((sum, o) => sum + o.wins + o.losses, 0)).toBe(8);
  });
  it('never counts a bye as a win, whether its receiver later wins or loses', () => {
    const graph = buildBracket(roster(3), 'bye-kind');
    const top = atRank(graph, 1);
    for (const topWins of [false, true]) {
      const done = playWith(graph, job => (job.round === 1 ? job.sides[0].gladiatorId
        : topWins ? top : job.sides.find(s => s.gladiatorId !== top)!.gladiatorId));
      const outcome = tournamentOutcomes(done).find(o => o.gladiatorId === top)!;
      expect(outcome.bouts.map(b => [b.round, b.kind, b.renown])).toEqual([[1, 'bye', 0], [2, topWins ? 'win' : 'loss', topWins ? 10 : 2]]);
      expect(outcome.bouts[0].ratingDelta).toBe(0);
      expect([outcome.wins, outcome.losses]).toEqual(topWins ? [1, 0] : [0, 1]);
      expect(outcome).toMatchObject(topWins
        ? { place: 1, result: 'victory', success: true, rewards: { money: 100, renown: 60 } }
        : { place: 2, result: 'defeat', success: false, rewards: { money: 60, renown: 32 } });
    }
  });
  it('settles a 0-HP seeded winner as the winner', () => {
    const graph = buildBracket(['m1', 'm2'].map(id => entrant(id, { fighter: mirror })), 'zero-settle');
    const [job] = readyBouts(graph);
    const log = logWhere(job, 'zero-settle', l => l.tieBreakReason === 'simultaneous-defeat');
    const loser = log.winnerId === 'm1' ? 'm2' : 'm1';
    const outcomes = tournamentOutcomes(recordBout(graph, job.boutId, log));
    expect(outcomes.find(o => o.gladiatorId === log.winnerId)).toMatchObject({ place: 1, result: 'victory', success: true,
      rewards: { money: 100, renown: 60 }, ratingDelta: 12 });
    expect(outcomes.find(o => o.gladiatorId === loser)).toMatchObject({ place: 2, result: 'defeat', success: false,
      rewards: { money: 60, renown: 32 }, ratingDelta: -12 });
  });
  it('rejects an unfinished bracket', () => {
    const graph = buildBracket(roster(3), 'pending');
    expect(() => placementGrants(graph)).toThrow(RangeError);
    expect(() => tournamentOutcomes(graph)).toThrow(RangeError);
  });
});

/**
 * Plan Step 1 harness without a database: eligibility, one bracket per league, every bout as its own job, then
 * ratings and outcomes; leftover entrants run regular Arena. Charges count the activities that debit stamina.
 */
const tournamentHarness = {
  run(n: number, league: LeagueId = 'bronze') {
    const candidates = roster(n, { league }).map(e => candidate(e.gladiatorId, {}, e));
    const partition = partitionTournament(slotAt(WEDNESDAY), candidates);
    const graphs = partition.brackets.map(b => play(buildBracket(b.entrants, `harness-${league}-${n}`)));
    const outcomes = graphs.flatMap(g => tournamentOutcomes(g));
    const regular = matchArena(partition.arena, [], `harness-${league}-${n}`);
    const debited = new Map(partition.routes.filter(r => r.staminaDebit > 0).map(r => [r.activityId, r.staminaDebit]));
    const activities = [...outcomes.map(o => o.activityId), ...regular.flatMap(a => a.sides.map(s => s.activityId))];
    return {
      chargesPerParticipant: candidates.map(c => activities.filter(a => a === c.entrant.activityId && debited.has(a)).length),
      staminaDebited: [...debited.values()].reduce((sum, debit) => sum + debit, 0),
      bracketWinners: outcomes.filter(o => o.place === 1).length,
      ratedBouts: graphs.reduce((sum, g) => sum + applyTournamentRatings(g).bouts.length, 0) + regular.filter(a => a.kind === 'human').length,
      byeRenown: outcomes.flatMap(o => o.bouts).filter(b => b.kind === 'bye').reduce((sum, b) => sum + b.renown, 0),
    };
  },
};

describe('tournament participant counts and debit invariants', () => {
  for (const league of LEAGUES) {
    for (const n of [0, 1, 2, 3, 5, 50]) {
      it(`charges once, crowns one winner and rates n − 1 bouts for ${n} ${league} entrants`, () => {
        const run = tournamentHarness.run(n, league);
        expect(run.chargesPerParticipant).toEqual(Array(n).fill(1));
        expect(run.staminaDebited).toBe(25 * n);
        expect(run.bracketWinners).toBe(n >= 2 ? 1 : 0);
        expect(run.ratedBouts).toBe(n >= 2 ? n - 1 : 0);
        expect(run.byeRenown).toBe(0);
      });
    }
  }
  it('runs separate brackets for every qualifying league in one slot', () => {
    const counts: Record<LeagueId, number> = { bronze: 50, silver: 5, gold: 1, champion: 3 };
    const candidates = LEAGUES.flatMap(league => roster(counts[league]).map(e => {
      const id = `${league}-${e.gladiatorId}`;
      return candidate(id, {}, { ...e, gladiatorId: id, activityId: `activity-${id}`, league });
    }));
    const partition = partitionTournament(slotAt(WEDNESDAY), candidates);
    expect(partition.brackets.map(b => [b.league, b.entrants.length])).toEqual([['bronze', 50], ['silver', 5], ['champion', 3]]);
    expect(partition.arena.map(e => e.league)).toEqual(['gold']);
    const winners = partition.brackets.map(b => placementGrants(play(buildBracket(b.entrants, `multi-${b.league}`))).filter(g => g.place === 1));
    expect(winners.map(w => w.length)).toEqual([1, 1, 1]);
    expect(matchArena(partition.arena, [], 'multi')).toMatchObject([{ kind: 'npc', league: 'gold' }]);
  });
});
