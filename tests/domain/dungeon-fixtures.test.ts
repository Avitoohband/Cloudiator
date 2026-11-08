import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { ActivitySummary, ItemReward, PublicActivitySummary, RevealedTimeline } from '@contracts/events';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { planDungeonRun, type DungeonSeat } from '@domain/dungeon';
import { RULES_V2 } from '@domain/rules-v2';
import { ARENA_GLADIATORS, fixtureUuid } from '../fixtures/arena-ids';
import { cappedDungeonBuild, partyInput } from '../fixtures/dungeon-builds';

// Refresh only after an intentional planner or fixture change with UPDATE_DUNGEON_FIXTURES=1.
const UPDATE = process.env.UPDATE_DUNGEON_FIXTURES === '1';
const CASES = {
  'full-victory': { id: 1, slot: 373237, dungeon: 'wolf-den', seed: 'full-victory:0', humans: [
    { classId: 'duelist', level: 3 }, { classId: 'guardian', level: 3 }, { classId: 'berserker', level: 3 }] },
  'solo-major-lost': { id: 2, slot: 373240, dungeon: 'raider-stronghold', seed: 'solo-major-lost:3', humans: [{ classId: 'duelist', level: 7 }] },
  'room-lost': { id: 3, slot: 373243, dungeon: 'troll-hall', seed: 'room-lost:591', humans: [
    { classId: 'duelist', level: 12 }, { classId: 'guardian', level: 12 }, { classId: 'berserker', level: 12 }] },
  'member-fell-party-cleared': { id: 4, slot: 373246, dungeon: 'wolf-den', seed: 'member-fell-party-cleared:158', humans: [
    { classId: 'duelist', level: 3 }, { classId: 'guardian', level: 7 }] },
} as const;
type Key = keyof typeof CASES;
const PEOPLE = [ARENA_GLADIATORS.aster, ARENA_GLADIATORS.varro, ARENA_GLADIATORS.cassia];

function fixture(key: Key) {
  const { id, slot, dungeon, seed, humans } = CASES[key];
  const activityId = `d0700000-0000-4000-8000-${String(id).padStart(12, '0')}`;
  const runId = `dungeon:${slot}:${dungeon}:1`, startsAtMs = slot * RULES_V2.clock.slotMs;
  const input = partyInput(dungeon, [...humans], runId);
  const seats = input.seats.map((seat): DungeonSeat => {
    if (key === 'member-fell-party-cleared' && seat.seat === 2) return { kind: 'bot', seat: 2, role: 'striker', name: 'Ludus Fixture',
      gladiatorId: fixtureUuid('ludus-dungeon-bot'), activityId: fixtureUuid(`dungeon-${key}-bot`), level: 3 };
    if (seat.kind !== 'human') return seat;
    const { id: gladiatorId, name } = PEOPLE[seat.seat];
    let build = seat.build;
    if (key === 'room-lost' && seat.seat !== 1) build = { ...build,
      equipment: { weapon: build.equipment.weapon, body: null, feet: null, offHand: null, head: null } };
    if (key === 'member-fell-party-cleared') build = seat.seat === 1 ? cappedDungeonBuild('guardian', 7) : { ...build, stance: 'defensive',
      allocations: { strength: 0, vitality: 0, endurance: 0, agility: 0, precision: 0 },
      equipment: { weapon: null, body: null, feet: null, offHand: null, head: null } };
    return { ...seat, build, gladiatorId, name, activityId: seat.seat === 0 ? activityId : fixtureUuid(`dungeon-${key}-${seat.seat}`) };
  });
  const planned = planDungeonRun({ ...input, slotIndex: slot, startsAtMs, seats }, seed, RULES_V2);
  const terminal = planned.fights.at(-1)!, outcome = planned.outcomes[0];
  const settledAtMs = startsAtMs + RULES_V2.clock.slotMs;
  const completion: PublicActivitySummary = { activityId, resolvedKind: 'dungeon', result: outcome.result, success: outcome.success, settledAtMs,
    replayExpiry: { state: 'available', expiresAtMs: settledAtMs + RULES_V2.retention.replayMs },
    dungeon: { id: dungeon, terminalFight: terminal.ordinal, partyWon: terminal.won } };
  const items = outcome.rewards.loot.map(({ catalogId, catalogVersion, quantity }): ItemReward => {
    const item = catalogId === CATALOG_V1.salvage.id ? CATALOG_V1.salvage : CATALOG_V1.items[catalogId];
    return { catalogId, catalogVersion, quantity, tier: item.tier, rarity: item.rarity };
  });
  // Fixture inventory has room for every grant and none of these rewards crosses a level boundary.
  const summary: ActivitySummary = { ...completion, rewards: { xp: outcome.rewards.xp, money: outcome.rewards.money, renown: 0,
    attributePoints: 0, overflowMoney: 0, items }, receiptId: fixtureUuid(`dungeon-${key}-receipt`) };
  // SQL24 writes each member's stage ID from the activity UUID and exposes only the pointer, with logs in dungeon_fights.
  const timeline: RevealedTimeline = { activityId, serverNowMs: settledAtMs, visibleThroughMs: settledAtMs,
    stages: planned.stages.map((stage, i) => ({ ...stage, id: `${activityId}:${i}` })), completion, summary };
  return { activityId, dungeonId: dungeon, runId, startsAtMs, gladiatorId: outcome.gladiatorId, level: humans[0].level, name: PEOPLE[0].name, timeline,
    fights: planned.fights.map(({ ordinal, offsetMs, log }) => ({ run_id: runId, ordinal, reveal_at_ms: startsAtMs + offsetMs, log })) };
}

test.each(Object.keys(CASES) as Key[])('regenerates %s from planDungeonRun byte for byte', key => {
  const path = new URL(`../fixtures/dungeons/${key}.json`, import.meta.url), bytes = `${JSON.stringify(fixture(key), null, 2)}\n`;
  if (UPDATE) writeFileSync(path, bytes);
  expect(existsSync(path), `Missing ${key}.json; run with UPDATE_DUNGEON_FIXTURES=1`).toBe(true);
  expect(readFileSync(path, 'utf8')).toBe(bytes);
});

test('the fixed seeds cover a human clear, a hired boss loss and a room loss after the owner falls', () => {
  const full = fixture('full-victory'), solo = fixture('solo-major-lost'), room = fixture('room-lost');
  expect(full.fights.map(({ log }) => log.winnerSide)).toEqual([0, 0, 0, 0]);
  expect(full.fights.at(-1)?.log.participants.filter(p => p.side === 0).map(p => p.role)).toEqual(['gladiator', 'gladiator', 'gladiator']);
  expect(solo.fights.map(({ log }) => log.winnerSide)).toEqual([0, 0, 0, 1]);
  expect(solo.fights[0].log.participants.filter(p => p.side === 0).map(p => p.role)).toEqual(['gladiator', 'hireling', 'hireling']);
  expect(room.fights.map(({ log }) => log.winnerSide)).toEqual([0, 0, 1]);
  expect(room.fights[1].log.finalHp[0]).toBe(0);
  expect(room.fights[2].log.participants.map(p => p.gladiatorId)).not.toContain(room.gladiatorId);
  expect(room.timeline.stages.at(-2)).toMatchObject({ label: 'Rest at the safe return point', endsAtMs: room.startsAtMs + 4_800_000 });
  expect(room.timeline.summary?.rewards).toMatchObject({ xp: 60, money: 8, items: [] });
});

test('the fallen member retains only won-room pay after the human and bot clear the major', () => {
  const fallen = fixture('member-fell-party-cleared');
  expect(fallen.timeline.completion).toMatchObject({ dungeon: { id: 'wolf-den', terminalFight: 4, partyWon: true }, result: 'defeat', success: false });
  expect(fallen.timeline.summary?.rewards).toMatchObject({ xp: 12, money: 2, items: [] });
  expect(fallen.fights[1].log.finalHp[0]).toBe(0);
  expect(fallen.fights[3].log.participants.filter(p => p.side === 0).map(p => p.role)).toEqual(['gladiator', 'bot']);
  for (const stage of fallen.timeline.stages.filter(s => s.kind === 'room' || s.kind === 'major')) {
    const row = fallen.fights.find(f => f.ordinal === stage.fight?.ordinal);
    expect(stage.fight).toEqual({ runId: fallen.runId, ordinal: row?.ordinal });
    expect(stage.revealedAtMs).toBe(row?.reveal_at_ms);
    expect(stage).not.toHaveProperty('battleLog');
  }
  expect(fallen.timeline.completion).not.toHaveProperty('rewards');
  expect(fallen.timeline.completion).not.toHaveProperty('receiptId');
});
