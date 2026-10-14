// Regenerates the committed Arena fixture battle logs with the real, reviewed Task 3 combat engine and checks
// them byte for byte, then checks that tests/fixtures/arena.ts assembles them into timelines with the proposed
// Task 16 public stage sequence (dispatch table): staging S..S+60 "Warming up"; the bout from S+60 for the
// log's duration, "Bout: victory"/"Bout: defeat" by winnerId; a zero-length return at S+80 "Results credited".
// The browser never runs the engine: it only reads these JSON files.
// To rewrite them after an intentional change: UPDATE_ARENA_FIXTURES=1 npx vitest run tests/domain/arena-fixtures.test.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeFighter, simulateBattle } from '@domain/combat.ts';
import { RULES_V1 } from '@domain/rules-v1.ts';
import { CATALOG_V1 } from '@domain/catalog-v1.ts';
import type { BattleParticipant, BuildSnapshot, FighterSnapshot } from '@domain/types.ts';
import type { BattleLog } from '@contracts/events.ts';
import type { LeagueId } from '@contracts/commands.ts';
import { itemFixture, ownerFixture, worldFixture } from '../fixtures/domain.ts';
import {
  ARENA_ACTIVITIES, ARENA_BOUTS, ARENA_CAMP_KEYS, ARENA_GLADIATORS, ARENA_SAMPLE_KEYS, arenaActivityId, arenaBattleId,
  type ArenaActivityKey, type ArenaBoutKey, type ArenaGladiatorKey,
} from '../fixtures/arena-ids.ts';
import {
  ARENA_BATTLE_LOGS, ARENA_BOUT_RATINGS, ARENA_OWNER, ARENA_PROFILES, ARENA_SAMPLES, ARENA_STANDINGS, ARENA_TIMELINES, ARENA_WORLD_ACTORS,
  arenaStandingsPage,
} from '../fixtures/arena.ts';
import { EQUIPMENT_LAYERS } from '../../src/game/actors.ts';

const DIR = join(__dirname, '..', 'fixtures', 'arena');
const UPDATE = process.env.UPDATE_ARENA_FIXTURES === '1';
const MIN = 60_000;
const SLOT_MS = RULES_V1.clock.slotMs;
const NOW = worldFixture.serverNowMs;
const SLOT_START = NOW - (NOW % SLOT_MS);

const item = (id: string) => itemFixture(CATALOG_V1.items[id]);
const none = { weapon: null, offHand: null, head: null, body: null, feet: null };
type Gear = Partial<Record<keyof typeof none, string>>;
function build(classId: BuildSnapshot['classId'], stance: BuildSnapshot['stance'], allocations: BuildSnapshot['allocations'], equipment: Gear): BuildSnapshot {
  return { rulesVersion: 'v1', classId, stance, allocations,
    equipment: { ...none, ...Object.fromEntries(Object.entries(equipment).map(([slot, id]) => [slot, item(id!)])) } };
}
const a = (strength: number, agility: number, vitality: number, endurance: number, precision: number) => ({ strength, agility, vitality, endurance, precision });

/** Private builds (test inputs only; the logs carry the derived public snapshots). */
const ASTER = build('guardian', 'balanced', a(3, 2, 3, 1, 1), { weapon: 'sword:1:common', offHand: 'round-shield:1:common', head: 'iron-helmet:1:common', body: 'light-armor:1:common' });
const BUILDS: Record<ArenaGladiatorKey, BuildSnapshot> = {
  aster: ASTER,
  varro: build('berserker', 'offensive', a(4, 1, 3, 2, 0), { weapon: 'spear:1:common', head: 'leather-hood:1:common', body: 'heavy-armor:1:common' }),
  cassia: build('duelist', 'balanced', a(2, 3, 1, 2, 2), { weapon: 'sword:1:common', head: 'leather-hood:1:common', body: 'light-armor:1:common' }),
  // A mirror of Aster, so the two can fall at the same moment.
  severus: ASTER,
  bellator: build('berserker', 'offensive', a(4, 2, 2, 1, 1), { weapon: 'axe:1:common', body: 'light-armor:1:common' }),
  corvina: build('duelist', 'defensive', a(2, 3, 2, 1, 2), { weapon: 'sword:1:common', offHand: 'round-shield:1:common', head: 'leather-hood:1:common' }),
  // Mirror duelists for the camp's simultaneous-defeat tie-break.
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
const fighterOf = (key: ArenaGladiatorKey) => makeFighter(BUILDS[key], 'arena', RULES_V1);

/**
 * Spec §7 fallback template, as Task 14's fixture approximates it until Task 16's makeFallback lands: mirror the
 * player's effective attributes, armour and attack interval, use Balanced stance, and set maximum health
 * (floored) and pre-stance base damage to 85% of the player's. Efficiency is kept as is, so it applies once.
 */
function npcFallback(player: FighterSnapshot): FighterSnapshot {
  const k = RULES_V1.arena.npcHealthDamageMultiplier;
  return { ...player, classId: null, stance: 'balanced', maxHealth: Math.floor(player.maxHealth * k), baseDamage: player.baseDamage * k };
}

/** The bout's two participants: the entrant first; an NPC fallback is `npc:<entrant gladiatorId>` with no gladiator. */
function participants(bout: ArenaBoutKey): [BattleParticipant, BattleParticipant] {
  const { entrant, opponent, npcName } = ARENA_BOUTS[bout];
  const e = ARENA_GLADIATORS[entrant];
  const first: BattleParticipant = { id: e.id, gladiatorId: e.id, name: e.name, snapshot: fighterOf(entrant) };
  if (opponent === null) return [first, { id: `npc:${e.id}`, gladiatorId: null, name: npcName!, snapshot: npcFallback(fighterOf(entrant)) }];
  const o = ARENA_GLADIATORS[opponent];
  return [first, { id: o.id, gladiatorId: o.id, name: o.name, snapshot: fighterOf(opponent) }];
}
const fight = (bout: ArenaBoutKey) => (seed: string) =>
  simulateBattle({ battleId: arenaBattleId(bout), rulesVersion: 'v1', rules: RULES_V1, fighters: participants(bout) }, seed);

const entrantWins = (log: BattleLog) => log.winnerId === log.participants[0].id;
const shortDefeat = (log: BattleLog) => log.victoryReason === 'defeat' && log.durationMs <= 45_000;
const tieBreakAtZero = (log: BattleLog, winner: 0 | 1) => log.tieBreakReason === 'simultaneous-defeat' && log.victoryReason === 'tie-break'
  && log.winnerId === log.participants[winner].id && log.finalHp[0] === 0 && log.finalHp[1] === 0;
const WANTED: Record<ArenaBoutKey, (log: BattleLog) => boolean> = {
  ownerHumanWin: log => entrantWins(log) && log.victoryReason === 'defeat',
  ownerHumanLoss: log => !entrantWins(log) && log.victoryReason === 'defeat',
  ownerNpcWin: log => entrantWins(log) && log.victoryReason === 'defeat',
  ownerNpcLoss: log => !entrantWins(log) && log.victoryReason === 'defeat',
  ownerTieBreak: log => tieBreakAtZero(log, 0),
  campOne: log => entrantWins(log) && shortDefeat(log),
  campTieBreak: log => tieBreakAtZero(log, 1) && log.durationMs <= 45_000,
  campThree: log => !entrantWins(log) && shortDefeat(log),
  campFour: log => entrantWins(log) && shortDefeat(log),
  campFive: log => !entrantWins(log) && shortDefeat(log),
  campNpcOne: log => entrantWins(log) && shortDefeat(log),
  campNpcTwo: log => !entrantWins(log) && shortDefeat(log),
};

/** The first seed `arena-<bout>-n` (n = 0, 1, ...) whose battle has the wanted shape. */
function firstSeed(bout: ArenaBoutKey): string {
  const run = fight(bout);
  for (let n = 0; n < 3000; n += 1) if (WANTED[bout](run(`arena-${bout}-${n}`))) return `arena-${bout}-${n}`;
  throw new Error(`no ${bout} seed found`);
}

// Recorded seeds, found by the deterministic searches below. They are private test inputs: the logs (and the
// browser bundle) never contain them.
const SEEDS: Record<ArenaBoutKey, string> = {
  ownerHumanWin: 'arena-ownerHumanWin-0', ownerHumanLoss: 'arena-ownerHumanLoss-33', ownerNpcWin: 'arena-ownerNpcWin-0',
  ownerNpcLoss: 'arena-ownerNpcLoss-21', ownerTieBreak: 'arena-ownerTieBreak-8', campOne: 'arena-campOne-0',
  campTieBreak: 'arena-campTieBreak-16', campThree: 'arena-campThree-4', campFour: 'arena-campFour-5',
  campFive: 'arena-campFive-0', campNpcOne: 'arena-campNpcOne-0', campNpcTwo: 'arena-campNpcTwo-7',
};
const BOUTS = Object.keys(ARENA_BOUTS) as ArenaBoutKey[];
const ACTIVITIES = Object.keys(ARENA_ACTIVITIES) as ArenaActivityKey[];

/** Spec §8.1 Elo, written independently of any production code: the winner gains round(24 × (1 − E)). */
function eloGain(winner: number, loser: number): number {
  return Math.round(RULES_V1.rating.k * (1 - 1 / (1 + 10 ** ((loser - winner) / RULES_V1.rating.expectationScale))));
}

describe('arena fixture logs', () => {
  it('records the first seeds that give each wanted bout shape', () => {
    for (const bout of BOUTS) expect(firstSeed(bout), bout).toBe(SEEDS[bout]);
  });

  const generated = Object.fromEntries(BOUTS.map(bout => [bout, fight(bout)(SEEDS[bout])])) as Record<ArenaBoutKey, BattleLog>;

  it.each(BOUTS)('commits %s.json exactly as the engine regenerates it', bout => {
    const path = join(DIR, `${bout}.json`);
    const text = `${JSON.stringify(generated[bout], null, 2)}\n`;
    if (UPDATE) writeFileSync(path, text);
    expect(existsSync(path), `${bout}.json is missing; run with UPDATE_ARENA_FIXTURES=1`).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(JSON.stringify(ARENA_BATTLE_LOGS[bout])).toBe(JSON.stringify(generated[bout]));
  });

  it('builds NPC fallbacks from the spec template and never logs a seed', () => {
    for (const bout of BOUTS) {
      const log = generated[bout];
      const { entrant, opponent } = ARENA_BOUTS[bout];
      expect(log.participants[0].gladiatorId, bout).toBe(ARENA_GLADIATORS[entrant].id);
      if (opponent === null) {
        const [player, npc] = log.participants;
        expect(npc, bout).toMatchObject({ id: `npc:${player.gladiatorId}`, gladiatorId: null, classId: null, stance: 'balanced' });
        expect(npc.maxHealth).toBe(Math.floor(player.maxHealth * 0.85));
        expect([npc.armor, npc.attackIntervalMs, npc.efficiencyBasisPoints, npc.attributes]).toEqual([player.armor, player.attackIntervalMs, player.efficiencyBasisPoints, player.attributes]);
      } else {
        expect(log.participants[1].gladiatorId, bout).toBe(ARENA_GLADIATORS[opponent].id);
      }
      expect(JSON.stringify(log)).not.toMatch(/seed/i);
    }
    // The 0-HP tie-breaks: the logged winner is the winner, although both end on 0 HP.
    expect(generated.ownerTieBreak.finalHp).toEqual([0, 0]);
    expect(generated.campTieBreak.winnerId).toBe(ARENA_GLADIATORS.gallus.id);
  });
});

describe('arena fixture timelines', () => {
  const slotStart = (key: ArenaActivityKey) => SLOT_START - ARENA_ACTIVITIES[key].slotsAgo * SLOT_MS;

  it.each(ACTIVITIES)('%s follows the public stage sequence', key => {
    const { gladiator, bout, owner } = ARENA_ACTIVITIES[key];
    const activityId = arenaActivityId(key);
    const timeline = ARENA_TIMELINES[activityId];
    const S = slotStart(key);
    expect(timeline.activityId).toBe(activityId);
    const [staging, boutStage, settled, ...rest] = timeline.stages;
    expect(rest).toEqual([]);
    expect(staging).toEqual({ id: `${activityId}:0`, kind: 'staging', revealedAtMs: S, startedAtMs: S, endsAtMs: S + 60 * MIN, label: 'Warming up' });
    if (bout === null) {
      // A worker delay: minute 60 has passed, but no bout (and so no result) is published.
      expect(timeline.stages).toHaveLength(1);
      expect(timeline.summary).toBeUndefined();
      return;
    }
    const log = ARENA_BATTLE_LOGS[bout];
    const me = log.participants.find(p => p.gladiatorId === ARENA_GLADIATORS[gladiator].id)!;
    const won = log.winnerId === me.id;
    expect(boutStage).toEqual({ id: `${activityId}:1`, kind: 'bout', revealedAtMs: S + 60 * MIN, startedAtMs: S + 60 * MIN,
      endsAtMs: S + 60 * MIN + log.durationMs, label: won ? 'Bout: victory' : 'Bout: defeat', battleLog: log });
    // Both entrants of a human pair carry the same battle.
    expect(boutStage.battleLog!.battleId).toBe(arenaBattleId(bout));
    expect(settled).toEqual({ id: `${activityId}:2`, kind: 'return', revealedAtMs: S + 80 * MIN, startedAtMs: S + 80 * MIN, endsAtMs: S + 80 * MIN, label: 'Results credited' });
    if (!owner) { expect(timeline.summary, 'spectators never get rewards').toBeUndefined(); return; }
    const npc = ARENA_BOUTS[bout].opponent === null;
    const renown = npc ? (won ? RULES_V1.arena.npcWinRenown : RULES_V1.arena.npcLossRenown) : won ? RULES_V1.arena.humanWinRenown : RULES_V1.arena.humanLossRenown;
    expect(timeline.summary).toMatchObject({ activityId, resolvedKind: 'arena', result: won ? 'victory' : 'defeat', success: won, settledAtMs: S + 80 * MIN,
      rewards: { money: 0, renown, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 },
      replayExpiry: { state: 'available', expiresAtMs: S + 80 * MIN + RULES_V1.retention.replayMs } });
    if (npc) { expect(timeline.summary).not.toHaveProperty('ratingDelta'); return; }
    const r = ARENA_BOUT_RATINGS[bout]!;
    const gain = won ? eloGain(r.entrant, r.opponent) : eloGain(r.opponent, r.entrant);
    expect(timeline.summary!.ratingDelta).toBe(won ? gain : -gain);
  });

  it('pairs both camp entrants of each human bout and adds them to the camp world at minute 40', () => {
    expect(NOW - SLOT_START).toBe(40 * MIN);
    expect(ARENA_WORLD_ACTORS.map(actor => actor.activityId)).toEqual(ARENA_CAMP_KEYS.map(arenaActivityId));
    for (const actor of ARENA_WORLD_ACTORS) {
      const key = ARENA_CAMP_KEYS.find(k => arenaActivityId(k) === actor.activityId)!;
      expect(actor).toMatchObject({ gladiatorId: ARENA_GLADIATORS[ARENA_ACTIVITIES[key].gladiator].id, location: 'arena', activityStatus: 'active',
        startsAtMs: SLOT_START, endsAtMs: SLOT_START + SLOT_MS, phase: worldFixture.actors[0].phase });
      // The public projection shows the latest revealed stage without its battle log: here, the warm-up.
      expect(actor.visibleStage).toEqual({ ...ARENA_TIMELINES[actor.activityId!].stages[0] });
      // The public silhouettes match the gear in the battle log.
      const bout = ARENA_ACTIVITIES[key].bout;
      if (bout) {
        const p = ARENA_BATTLE_LOGS[bout].participants.find(x => x.gladiatorId === actor.gladiatorId)!;
        const fromLog = p.equipmentSilhouettes.map(id => EQUIPMENT_LAYERS[id.split(':')[0]]).filter(Boolean).sort();
        expect([...actor.equipmentSilhouettes].sort(), actor.name).toEqual(fromLog);
      }
    }
    const camp = new Set(ARENA_WORLD_ACTORS.map(actor => actor.gladiatorId));
    for (const bout of BOUTS.filter(b => ARENA_BOUTS[b].slotsAgo === 0 && ARENA_BOUTS[b].opponent !== null)) {
      const ids = ARENA_BATTLE_LOGS[bout].participants.map(p => p.gladiatorId!);
      expect(ids.every(id => camp.has(id)), bout).toBe(true);
      const timelines = ARENA_WORLD_ACTORS.filter(actor => ids.includes(actor.gladiatorId)).map(actor => ARENA_TIMELINES[actor.activityId!]);
      expect(timelines.map(t => t.stages[1].battleLog!.battleId)).toEqual([arenaBattleId(bout), arenaBattleId(bout)]);
    }
    // Several simultaneous fights: more than the arena's six sparring rings.
    expect(BOUTS.filter(b => ARENA_BOUTS[b].slotsAgo === 0)).toHaveLength(7);
  });

  it('lists every sample once with a label', () => {
    expect(ARENA_SAMPLES.map(s => s.activityId)).toEqual(ARENA_SAMPLE_KEYS.map(arenaActivityId));
    for (const s of ARENA_SAMPLES) expect(s.label.length).toBeGreaterThan(5);
    expect(ARENA_TIMELINES[arenaActivityId('ownerHumanWin')].summary).toBeDefined();
    expect(ARENA_TIMELINES[arenaActivityId('varroSpectator')].summary).toBeUndefined();
  });

  it('gives every fixture gladiator a public profile with its standings rating', () => {
    for (const g of Object.values(ARENA_GLADIATORS)) {
      const profile = ARENA_PROFILES[g.id];
      expect(profile.actor).toMatchObject({ gladiatorId: g.id, name: g.name });
      const row = ARENA_STANDINGS[profile.actor.league].find(r => r.gladiatorId === g.id)!;
      expect(row, g.name).toBeDefined();
      expect(profile.rating).toBe(row.rating);
      expect(profile.combatStrength !== null && Number.isSafeInteger(profile.combatStrength) && profile.combatStrength > 0).toBe(true);
    }
    expect(ARENA_PROFILES[ownerFixture.gladiatorId].rating).toBe(ARENA_OWNER.progression.rating);
    expect(ARENA_PROFILES[ownerFixture.gladiatorId].actor.league).toBe(ARENA_OWNER.progression.league);
  });

  it('chains the owner’s credited bouts from the season start into the owner, profile and standings', () => {
    // The owner's credited Arena activities, oldest slot first.
    const credited = ACTIVITIES.filter(k => ARENA_ACTIVITIES[k].owner && ARENA_ACTIVITIES[k].bout !== null)
      .sort((p, q) => ARENA_ACTIVITIES[q].slotsAgo - ARENA_ACTIVITIES[p].slotsAgo);
    let rating = RULES_V1.rating.initial;
    let renown = 0;
    let wins = 0;
    let losses = 0;
    const opponentsAfter = new Map<string, number>();
    for (const key of credited) {
      const bout = ARENA_ACTIVITIES[key].bout!;
      const summary = ARENA_TIMELINES[arenaActivityId(key)].summary!;
      renown += summary.rewards.renown;
      const opponent = ARENA_BOUTS[bout].opponent;
      if (opponent === null) continue;
      const before = ARENA_BOUT_RATINGS[bout]!;
      expect(before.entrant, `${bout}: Aster's rating before the bout is her rating after the previous one`).toBe(rating);
      const won = summary.result === 'victory';
      const gain = won ? eloGain(before.entrant, before.opponent) : eloGain(before.opponent, before.entrant);
      const delta = won ? gain : -gain;
      expect(summary.ratingDelta, bout).toBe(delta);
      rating += delta;
      if (won) wins += 1; else losses += 1;
      opponentsAfter.set(ARENA_GLADIATORS[opponent].id, before.opponent - delta);
    }
    // The latest credited bout is in the owner's state, profile and standings row.
    expect(ARENA_OWNER.progression.rating).toBe(rating);
    expect(ARENA_OWNER.wallets.renown).toBe(renown);
    expect(ARENA_OWNER.processedSlotIndex).toBe(worldFixture.slotIndex - 1);
    expect(ARENA_PROFILES[ARENA_GLADIATORS.aster.id].rating).toBe(rating);
    const row = ARENA_STANDINGS.bronze.find(r => r.gladiatorId === ARENA_GLADIATORS.aster.id)!;
    expect([row.rating, row.humanWins, row.humanLosses]).toEqual([rating, wins, losses]);
    // Each opponent has not fought since: its current rating is its rating after that bout.
    for (const [id, after] of opponentsAfter) {
      expect(ARENA_PROFILES[id].rating, ARENA_PROFILES[id].actor.name).toBe(after);
      expect(ARENA_STANDINGS[ARENA_PROFILES[id].actor.league].find(r => r.gladiatorId === id)!.rating).toBe(after);
    }
  });
});

describe('arena fixture standings', () => {
  const LEAGUES: LeagueId[] = ['bronze', 'silver', 'gold', 'champion'];

  it('ranks each league by rating, human wins, fewer human losses, then id', () => {
    for (const league of LEAGUES) {
      const rows = ARENA_STANDINGS[league];
      rows.forEach((row, i) => expect(row.rank).toBe(i + 1));
      for (let i = 1; i < rows.length; i += 1) {
        const [p, q] = [rows[i - 1], rows[i]];
        const order = q.rating - p.rating || q.humanWins - p.humanWins || p.humanLosses - q.humanLosses || p.gladiatorId.localeCompare(q.gladiatorId);
        expect(order, `${league} ${p.name} before ${q.name}`).toBeLessThan(0);
      }
      for (const row of rows) expect(row.rewardEligible).toBe(row.humanWins + row.humanLosses >= RULES_V1.seasons.minimumHumanBouts);
    }
    expect(ARENA_STANDINGS.bronze.length).toBeGreaterThan(50);
    expect(ARENA_STANDINGS.silver.length).toBeGreaterThan(0);
    expect(ARENA_STANDINGS.bronze.some(r => r.promoted) && ARENA_STANDINGS.bronze.some(r => r.inactive)).toBe(true);
    const ids = LEAGUES.flatMap(league => ARENA_STANDINGS[league].map(r => r.gladiatorId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('pages each league at most 50 rows at a time with an opaque cursor', () => {
    for (const league of LEAGUES) {
      const rows = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 5; pages += 1) {
        const page = arenaStandingsPage(league, cursor);
        expect(page).toMatchObject({ league, archived: false });
        expect(page.rows.length).toBeLessThanOrEqual(50);
        rows.push(...page.rows);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(rows).toEqual(ARENA_STANDINGS[league]);
    }
    expect(arenaStandingsPage('bronze').rows).toHaveLength(50);
    expect(arenaStandingsPage('bronze', arenaStandingsPage('bronze').nextCursor!).nextCursor).toBeNull();
    // An unknown or another league's cursor starts again at the first page.
    expect(arenaStandingsPage('silver', arenaStandingsPage('bronze').nextCursor!).rows[0].rank).toBe(1);
    expect(arenaStandingsPage('bronze', 'bogus').rows[0].rank).toBe(1);
  });
});
