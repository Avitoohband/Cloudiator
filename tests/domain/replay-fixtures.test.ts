// Regenerates the committed replay fixture logs with the real, reviewed Task 3 combat engine and
// checks them byte for byte. The browser never runs the engine: it only reads these JSON files.
// To rewrite them after an intentional change: UPDATE_REPLAY_FIXTURES=1 npx vitest run tests/domain/replay-fixtures.test.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeFighter, simulateBattle } from '@domain/combat.ts';
import { RULES_V1 } from '@domain/rules-v1.ts';
import { CATALOG_V1 } from '@domain/catalog-v1.ts';
import type { BattleParticipant, BuildSnapshot, FighterSnapshot } from '@domain/types.ts';
import type { BattleAction, BattleLog } from '@contracts/events.ts';
import { itemFixture, ownerFixture } from '../fixtures/domain.ts';
import { FIXTURE_BATTLE_LOGS, REPLAY_FIXTURES } from '../fixtures/battles.ts';

const DIR = join(__dirname, '..', 'fixtures', 'battles');
const UPDATE = process.env.UPDATE_REPLAY_FIXTURES === '1';
const item = (id: string) => itemFixture(CATALOG_V1.items[id]);
const none = { weapon: null, offHand: null, head: null, body: null, feet: null };

function build(classId: BuildSnapshot['classId'], stance: BuildSnapshot['stance'], allocations: BuildSnapshot['allocations'], equipment: Partial<Record<keyof typeof none, string>>): BuildSnapshot {
  return { rulesVersion: 'v1', classId, stance, allocations,
    equipment: { ...none, ...Object.fromEntries(Object.entries(equipment).map(([slot, id]) => [slot, item(id!)])) } };
}
const fighter = (id: string, gladiatorId: string | null, name: string, snapshot: FighterSnapshot, startingHealth?: number): BattleParticipant =>
  ({ id, gladiatorId, name, snapshot, ...(startingHealth === undefined ? {} : { startingHealth }) });

/**
 * Spec §7 fallback template (no Task 9 factory exists yet): mirror the player's effective attributes,
 * armor and attack interval, use Balanced stance, and set maximum health and pre-stance base damage to
 * 85% of the player's (health floored to an integer). Efficiency is kept as is, so it applies once.
 */
function npcFallback(player: FighterSnapshot): FighterSnapshot {
  const k = RULES_V1.arena.npcHealthDamageMultiplier;
  return { ...player, classId: null, stance: 'balanced', maxHealth: Math.floor(player.maxHealth * k), baseDamage: player.baseDamage * k };
}
/** Expedition enemy from the catalog (no Task 8 encounter factory exists yet): its listed damage is the base damage. */
function creature(expedition: 'woodland' | 'outpost' | 'mountain'): FighterSnapshot {
  const e = CATALOG_V1.expeditions[expedition].enemy;
  return { rulesVersion: 'v1', classId: null, stance: e.stance, attributes: { ...e.attributes }, maxHealth: e.maxHp, armor: e.armor,
    weaponDamage: e.damage, baseDamage: e.damage, attackIntervalMs: e.intervalMs, efficiency: 1, equipmentSilhouettes: [] };
}
const battle = (battleId: string, a: BattleParticipant, b: BattleParticipant, seed: string) =>
  simulateBattle({ battleId, rulesVersion: 'v1', rules: RULES_V1, fighters: [a, b] }, seed);

const ASTER = ownerFixture.gladiatorId;
const VARRO = '5b0c3f8e-2d4a-4e61-9a7b-6c5d4e3f2a10';
const CASSIA = '7e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const attacks = (log: BattleLog) => log.events.filter((e): e is BattleAction => e.kind === 'attack');

const pvp = (seed: string) => battle(REPLAY_FIXTURES.pvp.battleId,
  fighter(ASTER, ASTER, 'Aster', makeFighter(build('guardian', 'defensive', { strength: 3, agility: 2, vitality: 3, endurance: 1, precision: 1 },
    { weapon: 'sword:1:common', offHand: 'round-shield:1:common', head: 'iron-helmet:1:common', body: 'light-armor:1:common' }), 'arena', RULES_V1)),
  fighter(VARRO, VARRO, 'Varro', makeFighter(build('berserker', 'offensive', { strength: 4, agility: 1, vitality: 3, endurance: 2, precision: 0 },
    { weapon: 'spear:1:common', head: 'leather-hood:1:common', body: 'heavy-armor:1:common' }), 'arena', RULES_V1)), seed);
const npcPlayer = makeFighter(build('guardian', 'balanced', { strength: 2, agility: 3, vitality: 2, endurance: 1, precision: 2 },
  { weapon: 'bow:1:common', head: 'leather-hood:1:common', body: 'light-armor:1:common' }), 'arena', RULES_V1);
const npc = (seed: string) => battle(REPLAY_FIXTURES.npc.battleId, fighter(ASTER, ASTER, 'Aster', npcPlayer),
  fighter(`npc:fallback:${REPLAY_FIXTURES.npc.activityId}`, null, 'Iron Warden', npcFallback(npcPlayer)), seed);
const expeditionPlayer = makeFighter(build('guardian', 'balanced', { strength: 3, agility: 2, vitality: 3, endurance: 2, precision: 0 },
  { weapon: 'axe:1:common', offHand: 'round-shield:1:common', body: 'light-armor:1:common' }), 'expedition', RULES_V1);
/** Three woodland encounters with carried health: 20% (floored) of maximum heals between fights, capped at maximum. */
function expedition(seed: string): BattleLog[] {
  const logs: BattleLog[] = [];
  let health = expeditionPlayer.maxHealth;
  for (const [i, creatureId] of ['dire-wolf', 'timber-wolf', 'dire-wolf'].entries()) {
    const log = battle(REPLAY_FIXTURES.expedition.battleIds[i], fighter(ASTER, ASTER, 'Aster', expeditionPlayer, health),
      fighter(`creature:${creatureId}:${i + 1}`, null, creatureId === 'dire-wolf' ? 'Dire Wolf' : 'Timber Wolf', creature('woodland')), `${seed}/encounter-${i + 1}`);
    logs.push(log);
    if (log.winnerId !== ASTER) break;
    health = Math.min(expeditionPlayer.maxHealth, log.finalHp[0] + Math.floor(expeditionPlayer.maxHealth * 0.2));
  }
  return logs;
}
const mirror = makeFighter(build('duelist', 'balanced', { strength: 2, agility: 2, vitality: 0, endurance: 3, precision: 3 }, { weapon: 'sword:1:common' }), 'arena', RULES_V1);
const tie = (seed: string) => battle(REPLAY_FIXTURES.tie.battleId, fighter(ASTER, ASTER, 'Aster', mirror), fighter(CASSIA, CASSIA, 'Cassia', mirror), seed);

/** The first seed `${prefix}-n` (n = 0, 1, ...) whose battle has the wanted shape. */
function firstSeed<T>(prefix: string, run: (seed: string) => T, wanted: (result: T) => boolean): string {
  for (let n = 0; n < 2000; n += 1) if (wanted(run(`${prefix}-${n}`))) return `${prefix}-${n}`;
  throw new Error(`no ${prefix} seed found`);
}
const has = (log: BattleLog, test: (a: BattleAction) => boolean) => attacks(log).some(test);

// Recorded seeds, found by the deterministic searches below. They are private test inputs: the logs
// (and the browser bundle) never contain them.
const SEEDS = { pvp: 'fixture-pvp-1', npc: 'fixture-npc-1', expedition: 'fixture-expedition-21', tie: 'fixture-tie-16' };

describe('replay fixture logs', () => {
  it('records the first seeds that give each wanted fight shape', () => {
    expect(firstSeed('fixture-pvp', pvp, log => log.winnerId === ASTER && log.victoryReason === 'defeat'
      && has(log, a => a.critical) && has(log, a => a.evade) && has(log, a => a.defend))).toBe(SEEDS.pvp);
    expect(firstSeed('fixture-npc', npc, log => log.winnerId === ASTER && log.victoryReason === 'defeat' && has(log, a => a.critical))).toBe(SEEDS.npc);
    expect(firstSeed('fixture-expedition', expedition, logs => logs.length === 3 && logs.every(l => l.winnerId === ASTER)
      && logs[1].participants[0].initialHealth < expeditionPlayer.maxHealth)).toBe(SEEDS.expedition);
    expect(firstSeed('fixture-tie', tie, log => log.tieBreakReason !== null)).toBe(SEEDS.tie);
  });

  const generated: Record<string, BattleLog> = {
    pvp: pvp(SEEDS.pvp), npc: npc(SEEDS.npc), tie: tie(SEEDS.tie),
    ...Object.fromEntries(expedition(SEEDS.expedition).map((log, i) => [`expedition-${i + 1}`, log])),
  };

  it.each(Object.keys(generated))('commits %s.json exactly as the engine regenerates it', name => {
    const path = join(DIR, `${name}.json`);
    const text = `${JSON.stringify(generated[name], null, 2)}\n`;
    if (UPDATE) writeFileSync(path, text);
    expect(existsSync(path), `${name}.json is missing; run with UPDATE_REPLAY_FIXTURES=1`).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(JSON.stringify(FIXTURE_BATTLE_LOGS[name])).toBe(JSON.stringify(generated[name]));
  });

  it('covers player, NPC fallback, expedition creature and tie-break fights', () => {
    const { pvp: p, npc: n, tie: t } = generated;
    expect(p.participants.map(x => x.gladiatorId)).toEqual([ASTER, VARRO]);
    expect(n.participants[1].gladiatorId).toBeNull();
    expect(n.participants[1].stance).toBe('balanced');
    expect(n.participants[1].maxHealth).toBe(Math.floor(n.participants[0].maxHealth * 0.85));
    expect(generated['expedition-2'].participants[1]).toMatchObject({ id: 'creature:timber-wolf:2', gladiatorId: null, equipmentSilhouettes: [] });
    expect(t.tieBreakReason).not.toBeNull();
    expect(t.victoryReason).toBe('tie-break');
    for (const log of Object.values(generated)) expect(JSON.stringify(log)).not.toMatch(/seed/i);
  });
});
