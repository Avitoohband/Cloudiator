// Regenerates the committed fixture expedition timelines with the real, reviewed Task 3 combat engine,
// mirroring the stage sequence Task 9 publishes, and checks them byte for byte. The browser never runs
// the engine: it only reads these JSON files through tests/fixtures/expeditions.ts.
// To rewrite them after an intentional change: UPDATE_EXPEDITION_FIXTURES=1 npx vitest run tests/domain/expedition-fixtures.test.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeFighter, simulateBattle } from '@domain/combat.ts';
import { RULES_V1 } from '@domain/rules-v1.ts';
import { CATALOG_V1 } from '@domain/catalog-v1.ts';
import type { BuildSnapshot, FighterSnapshot } from '@domain/types.ts';
import type { ActivitySummary, BattleLog, CreditedRewards, RevealedStage, RevealedTimeline } from '@contracts/events.ts';
import { itemFixture, worldFixture } from '../fixtures/domain.ts';
import { EXPEDITION_FIXTURES, EXPEDITION_GLADIATORS, type ExpeditionFixtureKey } from '../fixtures/expedition-ids.ts';
import { EXPEDITION_FIXTURE_TIMELINES } from '../fixtures/expeditions.ts';

const DIR = join(__dirname, '..', 'fixtures', 'expeditions');
const UPDATE = process.env.UPDATE_EXPEDITION_FIXTURES === '1';
const MIN = 60_000;
const DAY = 86_400_000;
const SLOT_MS = RULES_V1.clock.slotMs;
const NOW = worldFixture.serverNowMs;
const SLOT_START = NOW - (NOW % SLOT_MS);
type ExpeditionId = 'woodland' | 'outpost' | 'mountain';

const item = (id: string) => itemFixture(CATALOG_V1.items[id]);
const none = { weapon: null, offHand: null, head: null, body: null, feet: null };
function build(classId: BuildSnapshot['classId'], stance: BuildSnapshot['stance'], allocations: BuildSnapshot['allocations'], equipment: Partial<Record<keyof typeof none, string>>): BuildSnapshot {
  return { rulesVersion: 'v1', classId, stance, allocations,
    equipment: { ...none, ...Object.fromEntries(Object.entries(equipment).map(([slot, id]) => [slot, item(id!)])) } };
}
const mapOf = (id: ExpeditionId) => JSON.parse(readFileSync(join(__dirname, '..', '..', 'public', 'assets', 'expeditions', `${id}-map.json`), 'utf8')) as
  { expedition: { encounters: { index: number; creature: string }[] } };

/** The catalog enemy template as a fighter (no private encounter factory is visible here): its listed damage is the base damage. */
function enemy(expedition: ExpeditionId): FighterSnapshot {
  const e = CATALOG_V1.expeditions[expedition].enemy;
  return { rulesVersion: 'v1', classId: null, stance: e.stance, attributes: { ...e.attributes }, maxHealth: e.maxHp, armor: e.armor,
    weaponDamage: e.damage, baseDamage: e.damage, attackIntervalMs: e.intervalMs, efficiency: 1, equipmentSilhouettes: [] };
}
/** A tie-break victory with 0 HP counts as a defeat. */
const won = (log: BattleLog) => log.winnerId === log.participants[0].id && log.finalHp[0] > 0;

/**
 * Up to three encounters, mirroring Task 9: the gladiator is participant 0; the creature is participant 1 with
 * id creature:<manifest creature id>:<N>, no gladiator and the catalog enemy name. Encounter 1 starts at full
 * health; after a won non-final encounter the next starts at min(max, final + floor(20% of max)). A defeat
 * ends the run.
 */
function encounters(key: ExpeditionFixtureKey, gladiator: { id: string; name: string }, player: FighterSnapshot, seed: string): BattleLog[] {
  const { expedition } = EXPEDITION_FIXTURES[key];
  const creatures = mapOf(expedition).expedition.encounters;
  const logs: BattleLog[] = [];
  let health = player.maxHealth;
  for (let n = 1; n <= 3; n += 1) {
    const creature = creatures[n - 1].creature;
    const log = simulateBattle({ battleId: `fixture-${key}-encounter-${n}`, rulesVersion: 'v1', rules: RULES_V1, fighters: [
      { id: gladiator.id, gladiatorId: gladiator.id, name: gladiator.name, snapshot: player, ...(health === player.maxHealth ? {} : { startingHealth: health }) },
      { id: `creature:${creature}:${n}`, gladiatorId: null, name: CATALOG_V1.expeditions[expedition].enemy.name, snapshot: enemy(expedition) },
    ] }, `${seed}/encounter-${n}`);
    logs.push(log);
    if (!won(log)) break;
    health = Math.min(player.maxHealth, log.finalHp[0] + Math.floor(player.maxHealth * 0.2));
  }
  return logs;
}

/** The published stage sequence for a slot starting at `start` (Task 9 planExpedition, confirmed on the board). */
function stagesFor(activityId: string, expedition: ExpeditionId, start: number, logs: BattleLog[]): RevealedStage[] {
  const stages: RevealedStage[] = [];
  const add = (kind: RevealedStage['kind'], from: number, to: number, label: string, battleLog?: BattleLog) => {
    stages.push({ id: `${activityId}:${stages.length}`, kind, revealedAtMs: from, startedAtMs: from, endsAtMs: to, label, ...(battleLog ? { battleLog } : {}) });
  };
  const end = start + SLOT_MS;
  add('depart', start, start + 20 * MIN, `Depart for ${CATALOG_V1.expeditions[expedition].name}`);
  for (const [i, log] of logs.entries()) {
    const n = i + 1;
    const from = start + n * 20 * MIN;
    const battleEnd = from + log.durationMs;
    add('encounter', from, battleEnd, `Encounter ${n}: ${won(log) ? 'victory' : 'defeat'}`, log);
    if (!won(log)) { add('return', battleEnd, end, 'Rest at the safe return point'); break; }
    if (n < 3) add('exploration', battleEnd, start + (n + 1) * 20 * MIN, 'Recover and continue exploring');
    else add('travel', battleEnd, end, 'Return to camp');
  }
  add('return', end, end, 'Arrive at camp');
  return stages;
}

const noRewards: CreditedRewards = { money: 0, renown: 0, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 };
function summaryFor(activityId: string, key: ExpeditionFixtureKey, start: number, success: boolean, rewards: CreditedRewards, expired: boolean): ActivitySummary {
  const settledAtMs = start + SLOT_MS + 45_000;
  return { activityId, resolvedKind: 'expedition', result: success ? 'completed' : 'defeat', success, rewards: success ? rewards : noRewards,
    receiptId: `fixture-receipt-${key}`, settledAtMs, replayExpiry: expired ? { state: 'expired' } : { state: 'available', expiresAtMs: settledAtMs + 7 * DAY } };
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

type Case = {
  gladiator: { id: string; name: string }; player: FighterSnapshot; start: number; serverNowMs: number;
  wanted: (logs: BattleLog[]) => boolean;
  /** Settled summary, if the owner's timeline has one by its server time. */
  summary?: { rewards: CreditedRewards; expired?: boolean };
  /** Delayed reveal: only this many stages are published. */
  published?: number;
  /** Detailed events pruned (seven-day retention): stages keep their labels but lose their battle logs. */
  pruned?: boolean;
};
const wonAll = (logs: BattleLog[]) => logs.length === 3 && logs.every(won);
const CASES: Record<ExpeditionFixtureKey, Case> = {
  woodland: { gladiator: ASTER, player: woodlandPlayer, start: SLOT_START - 2 * SLOT_MS, serverNowMs: NOW,
    wanted: logs => wonAll(logs) && logs[1].participants[0].initialHealth < woodlandPlayer.maxHealth,
    summary: { rewards: { money: 20, renown: 0, xp: 100, attributePoints: 0, overflowMoney: 0, items: [
      { catalogId: 'salvage', catalogVersion: 'v1', tier: 1, rarity: 'common', quantity: 1 },
      { catalogId: 'light-boots:1:uncommon', catalogVersion: 'v1', tier: 1, rarity: 'uncommon', quantity: 1 }] } } },
  outpost: { gladiator: ASTER, player: outpostPlayer, start: SLOT_START - SLOT_MS, serverNowMs: SLOT_START - SLOT_MS + 65 * MIN,
    wanted: logs => logs.length === 2 && won(logs[0]) && !won(logs[1]) },
  mountain: { gladiator: ASTER, player: mountainPlayer, start: SLOT_START - 3 * SLOT_MS, serverNowMs: SLOT_START - 3 * SLOT_MS + 95 * MIN,
    wanted: logs => logs.length === 3 && won(logs[0]) && won(logs[1]) && !won(logs[2]), summary: { rewards: noRewards } },
  delayed: { gladiator: ASTER, player: woodlandPlayer, start: SLOT_START, serverNowMs: SLOT_START + 45 * MIN,
    wanted: logs => won(logs[0]), published: 3 },
  expired: { gladiator: ASTER, player: woodlandPlayer, start: SLOT_START - 10 * DAY, serverNowMs: NOW, wanted: wonAll, pruned: true,
    summary: { expired: true, rewards: { ...noRewards, money: 20, xp: 100, items: [{ catalogId: 'salvage', catalogVersion: 'v1', tier: 1, rarity: 'common', quantity: 1 }] } } },
  spectator: { gladiator: VARRO, player: varroPlayer, start: SLOT_START - SLOT_MS, serverNowMs: SLOT_START - SLOT_MS + 30 * MIN,
    wanted: logs => logs.length === 1 && !won(logs[0]) },
};

/** The first seed `fixture-<key>-n` (n = 0, 1, ...) whose encounters have the wanted shape. */
function firstSeed(key: ExpeditionFixtureKey): string {
  const c = CASES[key];
  for (let n = 0; n < 2000; n += 1) if (c.wanted(encounters(key, c.gladiator, c.player, `fixture-${key}-${n}`))) return `fixture-${key}-${n}`;
  throw new Error(`no ${key} seed found`);
}

// Recorded seeds, found by the deterministic searches below. They are private test inputs: the timelines
// (and the browser bundle) never contain them.
const SEEDS: Record<ExpeditionFixtureKey, string> = {
  woodland: 'fixture-woodland-14', outpost: 'fixture-outpost-280', mountain: 'fixture-mountain-0',
  delayed: 'fixture-delayed-0', expired: 'fixture-expired-0', spectator: 'fixture-spectator-196',
};

function timelineFor(key: ExpeditionFixtureKey): RevealedTimeline {
  const c = CASES[key];
  const { activityId, expedition } = EXPEDITION_FIXTURES[key];
  const logs = encounters(key, c.gladiator, c.player, SEEDS[key]);
  let stages = stagesFor(activityId, expedition, c.start, logs);
  if (c.published !== undefined) stages = stages.slice(0, c.published);
  if (c.pruned) stages = stages.map(({ battleLog: _pruned, ...stage }) => stage);
  return {
    activityId, serverNowMs: c.serverNowMs, visibleThroughMs: c.serverNowMs, stages,
    ...(c.summary ? { summary: summaryFor(activityId, key, c.start, logs.every(won), c.summary.rewards, !!c.summary.expired) } : {}),
  };
}

const KEYS = Object.keys(EXPEDITION_FIXTURES) as ExpeditionFixtureKey[];

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
    expect(JSON.stringify(EXPEDITION_FIXTURE_TIMELINES[key])).toBe(JSON.stringify(generated[key]));
  });

  it('mirrors the published stage sequence, creature ids, labels and carried health', () => {
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
      const encounterStages = t.stages.filter(s => s.kind === 'encounter');
      encounterStages.forEach((s, i) => {
        expect(s.startedAtMs).toBe(start + (i + 1) * 20 * MIN);
        expect(s.label).toMatch(new RegExp(`^Encounter ${i + 1}: (victory|defeat)$`));
        if (!s.battleLog) return;
        const [gladiator, creature] = s.battleLog.participants;
        expect(gladiator.gladiatorId).toBe(gladiator.id);
        expect(creature).toMatchObject({ id: `creature:${mapOf(expedition).expedition.encounters[i].creature}:${i + 1}`, gladiatorId: null, name: CATALOG_V1.expeditions[expedition].enemy.name });
        expect(s.endsAtMs).toBe(s.startedAtMs + s.battleLog.durationMs);
        expect(s.label.endsWith(won(s.battleLog) ? 'victory' : 'defeat')).toBe(true);
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

  it('covers success, a defeat after each encounter, a delayed reveal, pruned logs and a spectator', () => {
    const outcomes = (key: ExpeditionFixtureKey) => generated[key].stages.filter(s => s.kind === 'encounter').map(s => s.label.split(': ')[1]);
    expect(outcomes('woodland')).toEqual(['victory', 'victory', 'victory']);
    expect(generated.woodland.summary).toMatchObject({ success: true, result: 'completed', replayExpiry: { state: 'available' } });
    expect(outcomes('spectator')).toEqual(['defeat']);
    expect(outcomes('outpost')).toEqual(['victory', 'defeat']);
    expect(outcomes('mountain')).toEqual(['victory', 'victory', 'defeat']);
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
