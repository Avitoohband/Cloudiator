// Regenerates the committed fixture expedition timelines with the real, reviewed Task 3 combat engine,
// mirroring Task 9's planExpedition (supabase/functions/_shared/domain/expedition.ts at 545a82d: stage
// building, labels, stage ids, battle ids, creature ids and the participant name "Gladiator") and its
// expedition settlement result, and checks them byte for byte. The browser never runs the engine: it only
// reads these JSON files through tests/fixtures/expeditions.ts.
// To rewrite them after an intentional change: UPDATE_EXPEDITION_FIXTURES=1 npx vitest run tests/domain/expedition-fixtures.test.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeFighter, simulateBattle } from '@domain/combat.ts';
import { RULES_V1 } from '@domain/rules-v1.ts';
import { CATALOG_V1 } from '@domain/catalog-v1.ts';
import type { BuildSnapshot, FighterSnapshot } from '@domain/types.ts';
import type { ActivitySummary, BattleLog, CreditedRewards, ItemReward, RevealedStage, RevealedTimeline } from '@contracts/events.ts';
import { itemFixture, worldFixture } from '../fixtures/domain.ts';
import { EXPEDITION_FIXTURES, EXPEDITION_GLADIATORS, type ExpeditionFixtureKey } from '../fixtures/expedition-ids.ts';
import { EXPEDITION_FIXTURE_TIMELINES } from '../fixtures/expeditions.ts';

const DIR = join(__dirname, '..', 'fixtures', 'expeditions');
const UPDATE = process.env.UPDATE_EXPEDITION_FIXTURES === '1';
const MIN = 60_000;
const DAY = 86_400_000;
const SLOT_MS = RULES_V1.clock.slotMs;
const STAGE_MS = 1_200_000;
/** Task 9 keeps detailed replay events for seven days after the activity ends. */
const REPLAY_KEPT_MS = 7 * DAY;
const NOW = worldFixture.serverNowMs;
const SLOT_START = NOW - (NOW % SLOT_MS);
type ExpeditionId = 'woodland' | 'outpost' | 'mountain';
type Gladiator = { readonly id: string; readonly name: string };

const item = (id: string) => itemFixture(CATALOG_V1.items[id]);
const none = { weapon: null, offHand: null, head: null, body: null, feet: null };
function build(classId: BuildSnapshot['classId'], stance: BuildSnapshot['stance'], allocations: BuildSnapshot['allocations'], equipment: Partial<Record<keyof typeof none, string>>): BuildSnapshot {
  return { rulesVersion: 'v1', classId, stance, allocations,
    equipment: { ...none, ...Object.fromEntries(Object.entries(equipment).map(([slot, id]) => [slot, item(id!)])) } };
}
const mapOf = (id: ExpeditionId) => JSON.parse(readFileSync(join(__dirname, '..', '..', 'public', 'assets', 'expeditions', `${id}-map.json`), 'utf8')) as
  { expedition: { encounters: { index: number; creature: string }[] } };

/** Task 9's canonical enemy template: the catalog enemy, with its listed damage as base damage, efficiency 1 and no equipment. */
function enemy(expedition: ExpeditionId): FighterSnapshot {
  const e = CATALOG_V1.expeditions[expedition].enemy;
  return { rulesVersion: 'v1', classId: null, stance: e.stance, attributes: { ...e.attributes }, maxHealth: e.maxHp, armor: e.armor,
    weaponDamage: e.damage, baseDamage: e.damage, attackIntervalMs: e.intervalMs, efficiency: 1, equipmentSilhouettes: [] };
}
/** Task 9's winner rule (545a82d): the logged winner alone, including a simultaneous-defeat tie-break win at 0 HP. */
const won = (log: BattleLog) => log.winnerId === log.participants[0].id;
/** A simultaneous defeat whose seeded tie-break names the gladiator, who ends on 0 HP. */
const zeroHpWin = (log: BattleLog | undefined) => !!log && log.winnerId === log.participants[0].id && log.finalHp[0] === 0
  && log.victoryReason === 'tie-break' && log.tieBreakReason === 'simultaneous-defeat';

/**
 * Up to three encounters, as Task 9 plans them: the gladiator is participant 0 (named "Gladiator"); the
 * creature is participant 1 with id creature:<manifest creature id>:<N>, no gladiator and the catalog enemy
 * name. Battle N has id <activity>:encounter:N and seed <seed>:encounter:N. Encounter 1 starts at full health;
 * after a won non-final encounter the next starts at min(max, final + floor(20% of max)). A defeat ends the run.
 */
function encounters(key: ExpeditionFixtureKey, gladiator: Gladiator, player: FighterSnapshot, seed: string): BattleLog[] {
  const { expedition, activityId } = EXPEDITION_FIXTURES[key];
  const creatures = mapOf(expedition).expedition.encounters;
  const template = enemy(expedition);
  const logs: BattleLog[] = [];
  let hp = player.maxHealth;
  for (let i = 0; i < 3; i += 1) {
    const log = simulateBattle({ battleId: `${activityId}:encounter:${i + 1}`, rulesVersion: 'v1', rules: RULES_V1, fighters: [
      { id: gladiator.id, gladiatorId: gladiator.id, name: 'Gladiator', snapshot: player, startingHealth: hp },
      { id: `creature:${creatures[i].creature}:${i + 1}`, gladiatorId: null, name: CATALOG_V1.expeditions[expedition].enemy.name, snapshot: template },
    ] }, `${seed}:encounter:${i + 1}`);
    logs.push(log);
    if (!won(log)) break;
    hp = log.finalHp[0];
    if (i < 2) hp = Math.min(player.maxHealth, hp + Math.floor(player.maxHealth * 0.2));
  }
  return logs;
}

/** The published stage sequence for a slot starting at `start` (Task 9 planExpedition). */
function stagesFor(activityId: string, expedition: ExpeditionId, start: number, logs: BattleLog[]): RevealedStage[] {
  const stages: RevealedStage[] = [];
  const add = (kind: RevealedStage['kind'], offset: number, end: number, label: string, battleLog?: BattleLog) => {
    stages.push({ id: `${activityId}:${stages.length}`, kind, revealedAtMs: start + offset, startedAtMs: start + offset, endsAtMs: start + end, label, ...(battleLog ? { battleLog } : {}) });
  };
  add('depart', 0, STAGE_MS, `Depart for ${CATALOG_V1.expeditions[expedition].name}`);
  for (const [i, log] of logs.entries()) {
    const offset = (i + 1) * STAGE_MS;
    const success = won(log);
    add('encounter', offset, offset + log.durationMs, `Encounter ${i + 1}: ${success ? 'victory' : 'defeat'}`, log);
    if (!success) { add('return', offset + log.durationMs, SLOT_MS, 'Rest at the safe return point'); break; }
    if (i < 2) add('exploration', offset + log.durationMs, offset + STAGE_MS, 'Recover and continue exploring');
    else add('travel', offset + log.durationMs, SLOT_MS, 'Return to camp');
  }
  add('return', SLOT_MS, SLOT_MS, 'Arrive at camp');
  return stages;
}

const reward = (catalogId: string, quantity = 1): ItemReward => {
  const entry = catalogId === 'salvage' ? CATALOG_V1.salvage : CATALOG_V1.items[catalogId];
  return { catalogId, catalogVersion: 'v1', tier: entry.tier, rarity: entry.rarity, quantity };
};
/**
 * Task 9's expedition settlement result: victory or defeat, the catalog XP and money, retained gear then the
 * stacked salvage, and no rewards at all after a defeat. Replays stay available until seven days after the end.
 */
function summaryFor(key: ExpeditionFixtureKey, start: number, serverNowMs: number, success: boolean, gear: readonly string[]): ActivitySummary {
  const { activityId, expedition } = EXPEDITION_FIXTURES[key];
  const entry = CATALOG_V1.expeditions[expedition];
  const end = start + SLOT_MS;
  const rewards: CreditedRewards = success
    ? { money: entry.rewards.money, renown: 0, xp: entry.rewards.xp, attributePoints: 0,
      items: [...gear.map(id => reward(id)), reward('salvage', entry.rewards.salvageQuantity)], overflowMoney: 0 }
    : { money: 0, renown: 0, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 };
  return { activityId, resolvedKind: 'expedition', result: success ? 'victory' : 'defeat', success, rewards,
    receiptId: `fixture-receipt-${key}`, settledAtMs: end + 45_000,
    replayExpiry: serverNowMs < end + REPLAY_KEPT_MS ? { state: 'available', expiresAtMs: end + REPLAY_KEPT_MS } : { state: 'expired' } };
}

const { aster: ASTER, varro: VARRO } = EXPEDITION_GLADIATORS;
const woodlandPlayer = makeFighter(build('guardian', 'balanced', { strength: 3, agility: 2, vitality: 3, endurance: 2, precision: 0 },
  { weapon: 'axe:1:common', offHand: 'round-shield:1:common', body: 'light-armor:1:common' }), 'expedition', RULES_V1);
const outpostPlayer = makeFighter(build('guardian', 'balanced', { strength: 5, agility: 3, vitality: 5, endurance: 4, precision: 3 },
  { weapon: 'sword:5:common', offHand: 'round-shield:5:common', head: 'leather-hood:5:common', body: 'light-armor:5:common' }), 'expedition', RULES_V1);
const mountainPlayer = makeFighter(build('duelist', 'balanced', { strength: 10, agility: 7, vitality: 9, endurance: 6, precision: 8 },
  { weapon: 'spear:10:common', head: 'iron-helmet:10:common', body: 'heavy-armor:10:common' }), 'expedition', RULES_V1);
const varroPlayer = makeFighter(build('berserker', 'offensive', { strength: 4, agility: 1, vitality: 3, endurance: 2, precision: 0 },
  { weapon: 'spear:1:common', head: 'leather-hood:1:common', body: 'heavy-armor:1:common' }), 'expedition', RULES_V1);
// A tier-1 spear at 20 effective Agility swings every 1000 ms, as the Mountain enemy does, so both can fall
// at the same moment and the seeded tie-break decides the encounter.
const spearman = (strength: number) => makeFighter(build('berserker', 'balanced', { strength, agility: 15, vitality: 0, endurance: 5, precision: 5 },
  { weapon: 'spear:1:common' }), 'expedition', RULES_V1);
const tiebreakPlayer = spearman(5);
const laststandPlayer = spearman(34);

type Case = {
  gladiator: Gladiator; player: FighterSnapshot; start: number;
  /** The server time of the timeline read. */
  now: (start: number, logs: BattleLog[]) => number;
  wanted: (logs: BattleLog[]) => boolean;
  /** Settled summary (the owner's timeline only) with the retained gear it credits. */
  summary?: { gear: readonly string[] };
  /** Delayed reveal: only this many stages are published. */
  published?: number;
  /** Detailed events pruned (seven-day retention): stages keep their labels but lose their battle logs. */
  pruned?: boolean;
};
const wonAll = (logs: BattleLog[]) => logs.length === 3 && logs.every(won);
const at = (minutes: number) => (start: number) => start + minutes * MIN;
const CASES: Record<ExpeditionFixtureKey, Case> = {
  woodland: { gladiator: ASTER, player: woodlandPlayer, start: SLOT_START - 2 * SLOT_MS, now: () => NOW,
    wanted: logs => wonAll(logs) && logs[1].participants[0].initialHealth < woodlandPlayer.maxHealth, summary: { gear: ['light-boots:1:uncommon'] } },
  outpost: { gladiator: ASTER, player: outpostPlayer, start: SLOT_START - SLOT_MS, now: at(65),
    wanted: logs => logs.length === 2 && won(logs[0]) && !won(logs[1]) },
  mountain: { gladiator: ASTER, player: mountainPlayer, start: SLOT_START - 3 * SLOT_MS, now: at(95),
    wanted: logs => logs.length === 3 && won(logs[0]) && won(logs[1]) && !won(logs[2]) && !zeroHpWin(logs[2]), summary: { gear: [] } },
  delayed: { gladiator: ASTER, player: woodlandPlayer, start: SLOT_START, now: at(45), wanted: logs => won(logs[0]), published: 3 },
  expired: { gladiator: ASTER, player: woodlandPlayer, start: SLOT_START - 10 * DAY, now: () => NOW, wanted: wonAll, pruned: true, summary: { gear: [] } },
  spectator: { gladiator: VARRO, player: varroPlayer, start: SLOT_START - SLOT_MS, now: at(30),
    wanted: logs => logs.length === 1 && !won(logs[0]) && !zeroHpWin(logs[0]) },
  // Read five seconds before the tie-break battle ends, so the sample opens on the simultaneous defeat.
  tiebreak: { gladiator: ASTER, player: tiebreakPlayer, start: SLOT_START - 4 * SLOT_MS, now: (start, logs) => start + STAGE_MS + logs[0].durationMs - 5_000,
    wanted: logs => zeroHpWin(logs[0]) && logs.length >= 2 },
  laststand: { gladiator: ASTER, player: laststandPlayer, start: SLOT_START - 5 * SLOT_MS, now: () => NOW,
    wanted: logs => logs.length === 3 && zeroHpWin(logs[2]), summary: { gear: [] } },
};

/** The first seed `fixture-<key>-n` (n = 0, 1, ...) whose encounters have the wanted shape. */
function firstSeed(key: ExpeditionFixtureKey): string {
  const c = CASES[key];
  for (let n = 0; n < 5000; n += 1) if (c.wanted(encounters(key, c.gladiator, c.player, `fixture-${key}-${n}`))) return `fixture-${key}-${n}`;
  throw new Error(`no ${key} seed found`);
}

// Recorded seeds, found by the deterministic searches below. They are private test inputs: the timelines
// (and the browser bundle) never contain them.
const SEEDS: Record<ExpeditionFixtureKey, string> = {
  woodland: 'fixture-woodland-17', outpost: 'fixture-outpost-78', mountain: 'fixture-mountain-0',
  delayed: 'fixture-delayed-0', expired: 'fixture-expired-0', spectator: 'fixture-spectator-17',
  tiebreak: 'fixture-tiebreak-148', laststand: 'fixture-laststand-565',
};

function timelineFor(key: ExpeditionFixtureKey): RevealedTimeline {
  const c = CASES[key];
  const { activityId, expedition } = EXPEDITION_FIXTURES[key];
  const logs = encounters(key, c.gladiator, c.player, SEEDS[key]);
  const serverNowMs = c.now(c.start, logs);
  let stages = stagesFor(activityId, expedition, c.start, logs);
  if (c.published !== undefined) stages = stages.slice(0, c.published);
  if (c.pruned) stages = stages.map(({ battleLog: _pruned, ...stage }) => stage);
  return {
    activityId, serverNowMs, visibleThroughMs: serverNowMs, stages,
    ...(c.summary ? { summary: summaryFor(key, c.start, serverNowMs, logs.every(won), c.summary.gear) } : {}),
  };
}

const KEYS = Object.keys(EXPEDITION_FIXTURES) as ExpeditionFixtureKey[];
const encountersOf = (t: RevealedTimeline) => t.stages.filter(s => s.kind === 'encounter');
const after = (t: RevealedTimeline, stage: RevealedStage) => t.stages[t.stages.indexOf(stage) + 1];

describe('fixture expedition timelines', () => {
  it('records the first seeds that give each wanted expedition shape', () => {
    for (const key of KEYS) expect.soft(firstSeed(key), key).toBe(SEEDS[key]);
  });

  const generated = Object.fromEntries(KEYS.map(key => [key, timelineFor(key)])) as Record<ExpeditionFixtureKey, RevealedTimeline>;

  it.each(KEYS)('commits %s.json exactly as the engine and the stage sequence regenerate it', key => {
    const path = join(DIR, `${key}.json`);
    const text = `${JSON.stringify(generated[key], null, 2)}\n`;
    if (UPDATE) writeFileSync(path, text);
    expect(existsSync(path), `${key}.json is missing; run with UPDATE_EXPEDITION_FIXTURES=1`).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(text);
    if (!UPDATE) expect(JSON.stringify(EXPEDITION_FIXTURE_TIMELINES[key])).toBe(JSON.stringify(generated[key]));
  });

  it('mirrors the published stage sequence, battle and creature ids, labels and carried health', () => {
    for (const key of KEYS) {
      const t = generated[key];
      const { expedition, activityId } = EXPEDITION_FIXTURES[key];
      expect(t.activityId).toBe(activityId);
      t.stages.forEach((s, i) => {
        expect(s.id).toBe(`${activityId}:${i}`);
        expect(s.revealedAtMs).toBe(s.startedAtMs);
        expect(s.endsAtMs).toBeGreaterThanOrEqual(s.startedAtMs);
        if (i > 0) expect(s.startedAtMs, `${key} stage ${i} is contiguous`).toBe(t.stages[i - 1].endsAtMs);
      });
      const start = t.stages[0].startedAtMs;
      expect(start % SLOT_MS).toBe(0);
      expect(t.stages[0]).toMatchObject({ kind: 'depart', endsAtMs: start + 20 * MIN, label: `Depart for ${CATALOG_V1.expeditions[expedition].name}` });
      const encounterStages = encountersOf(t);
      encounterStages.forEach((s, i) => {
        expect(s.startedAtMs).toBe(start + (i + 1) * 20 * MIN);
        expect(s.label).toMatch(new RegExp(`^Encounter ${i + 1}: (victory|defeat)$`));
        if (!s.battleLog) return;
        const [gladiator, creature] = s.battleLog.participants;
        expect(s.battleLog.battleId).toBe(`${activityId}:encounter:${i + 1}`);
        expect(gladiator).toMatchObject({ id: CASES[key].gladiator.id, gladiatorId: CASES[key].gladiator.id, name: 'Gladiator' });
        expect(creature).toMatchObject({ id: `creature:${mapOf(expedition).expedition.encounters[i].creature}:${i + 1}`, gladiatorId: null, name: CATALOG_V1.expeditions[expedition].enemy.name });
        expect(s.endsAtMs).toBe(s.startedAtMs + s.battleLog.durationMs);
        // The label follows the logged winner alone.
        expect(s.label.endsWith(s.battleLog.winnerId === gladiator.id ? 'victory' : 'defeat')).toBe(true);
        if (i === 0) expect(gladiator.initialHealth).toBe(gladiator.maxHealth);
        else {
          const before = encounterStages[i - 1].battleLog!;
          expect(gladiator.initialHealth).toBe(Math.min(gladiator.maxHealth, before.finalHp[0] + Math.floor(gladiator.maxHealth * 0.2)));
        }
      });
      if (CASES[key].published === undefined) {
        expect(t.stages.at(-1)).toMatchObject({ kind: 'return', startedAtMs: start + SLOT_MS, endsAtMs: start + SLOT_MS, label: 'Arrive at camp' });
      }
      for (const s of t.stages) if (s.kind !== 'encounter') expect(s.battleLog).toBeUndefined();
      expect(JSON.stringify(t)).not.toMatch(/seed/i);
    }
  });

  it('labels a zero-HP tie-break win a victory: a non-final one heals by the floored 20% and continues, a final one succeeds', () => {
    const t = generated.tiebreak;
    const [first, second] = encountersOf(t);
    const log = first.battleLog!;
    expect(log).toMatchObject({ winnerId: ASTER.id, victoryReason: 'tie-break', tieBreakReason: 'simultaneous-defeat' });
    expect(log.finalHp[0]).toBe(0);
    expect(log.events.at(-1)).toMatchObject({ kind: 'victory', winnerId: ASTER.id });
    expect(first.label).toBe('Encounter 1: victory');
    expect(after(t, first)).toMatchObject({ kind: 'exploration', label: 'Recover and continue exploring', endsAtMs: t.stages[0].startedAtMs + 40 * MIN });
    expect(second?.battleLog?.participants[0].initialHealth).toBe(Math.floor(log.participants[0].maxHealth * 0.2));

    const last = generated.laststand;
    const third = encountersOf(last)[2];
    expect(third?.battleLog).toMatchObject({ winnerId: ASTER.id, victoryReason: 'tie-break', tieBreakReason: 'simultaneous-defeat' });
    expect(third.battleLog!.finalHp[0]).toBe(0);
    expect(third.label).toBe('Encounter 3: victory');
    expect(after(last, third)).toMatchObject({ kind: 'travel', label: 'Return to camp' });
    expect(last.stages.some(s => s.label === 'Rest at the safe return point')).toBe(false);
    const entry = CATALOG_V1.expeditions.mountain.rewards;
    expect(last.summary).toMatchObject({ result: 'victory', success: true, rewards: { xp: entry.xp, money: entry.money, items: [{ catalogId: 'salvage', quantity: entry.salvageQuantity }] } });
  });

  it('covers success, a defeat after each encounter, a delayed reveal, pruned logs and a spectator', () => {
    const outcomes = (key: ExpeditionFixtureKey) => encountersOf(generated[key]).map(s => s.label.split(': ')[1]);
    expect(outcomes('woodland')).toEqual(['victory', 'victory', 'victory']);
    expect(generated.woodland.summary).toMatchObject({ success: true, result: 'victory', replayExpiry: { state: 'available' } });
    expect(generated.woodland.summary!.rewards.items.map(i => i.catalogId)).toEqual(['light-boots:1:uncommon', 'salvage']);
    expect(outcomes('spectator')).toEqual(['defeat']);
    expect(outcomes('outpost')).toEqual(['victory', 'defeat']);
    expect(outcomes('mountain')).toEqual(['victory', 'victory', 'defeat']);
    expect(outcomes('tiebreak')).toEqual(['victory', 'defeat']);
    expect(outcomes('laststand')).toEqual(['victory', 'victory', 'victory']);
    const noRewards: CreditedRewards = { money: 0, renown: 0, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 };
    expect(generated.mountain.summary).toMatchObject({ success: false, result: 'defeat', rewards: noRewards });
    // The outpost run is viewed at minute 65, before settlement: no summary yet.
    expect(generated.outpost.summary).toBeUndefined();
    expect(generated.outpost.serverNowMs - generated.outpost.stages[0].startedAtMs).toBe(65 * MIN);
    // Delayed: encounter 2 is due at minute 40 but not published at minute 45.
    const delayed = generated.delayed;
    expect(delayed.stages.map(s => s.kind)).toEqual(['depart', 'encounter', 'exploration']);
    expect(delayed.serverNowMs).toBeGreaterThan(delayed.stages[0].startedAtMs + 40 * MIN);
    expect(delayed.summary).toBeUndefined();
    // Pruned: labels stay, logs are gone, and the summary says so.
    expect(generated.expired.stages.some(s => s.battleLog)).toBe(false);
    expect(outcomes('expired')).toEqual(['victory', 'victory', 'victory']);
    expect(generated.expired.summary).toMatchObject({ success: true, replayExpiry: { state: 'expired' } });
    // A spectator's public timeline has no summary and no reward details.
    expect(generated.spectator.summary).toBeUndefined();
    expect(generated.spectator.stages[1].battleLog!.participants[0].id).toBe(VARRO.id);
    expect(JSON.stringify(generated.spectator)).not.toMatch(/\b(rewards?|receiptId|money|renown|xp|summary)\b/i);
  });
});
