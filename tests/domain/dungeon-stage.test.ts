import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { PartyBattleLog, RevealedTimeline } from '@contracts/events';
import { DUNGEON_JOURNEY, planDungeonTrip, renderDungeonStage } from '@/game/dungeon-stage';
import type { MapData } from '@/game/assets';
import { journeyMap, legPath } from '@/game/expedition-path';
import { firstLocked, tripFrame, tripPositionOf } from '@/game/trip-replay';

type Fixture = {
  startsAtMs: number;
  timeline: RevealedTimeline;
  fights: { ordinal: number; log: PartyBattleLog }[];
};
const load = (key: string): Fixture => JSON.parse(readFileSync(new URL(`../fixtures/dungeons/${key}.json`, import.meta.url), 'utf8'));
const clear = load('full-victory');
const lost = load('room-lost');
const fell = load('member-fell-party-cleared');
const bossLost = load('solo-major-lost');
const MINUTE = 60_000;
const at = (fixture: Fixture, minute: number) => fixture.startsAtMs + minute * MINUTE;
const logsOf = (fixture: Fixture) => new Map(fixture.fights.map(({ ordinal, log }) => [ordinal, log]));
const state = (fixture: Fixture, time: number) => renderDungeonStage(fixture.timeline, time, logsOf(fixture));
const tripOptions = { walkMs: () => 8_000, resting: true };

test('departs at minute zero and reaches all four fight points at minutes 16, 32, 48 and 64', () => {
  expect(DUNGEON_JOURNEY).toEqual(['start', 'search-1', 'encounter-1', 'search-2', 'encounter-2', 'search-3', 'encounter-3', 'search-4', 'end']);
  expect(state(clear, at(clear, 0))).toMatchObject({ phase: 'depart', progress: { minute: 0 },
    route: { from: 'start', to: 'search-1', walkedMs: 0, then: 'search' }, party: [], fight: null });
  for (const [minute, ordinal, phase, point] of [
    [16, 1, 'room', 'encounter-1'], [32, 2, 'room', 'encounter-2'],
    [48, 3, 'room', 'encounter-3'], [64, 4, 'major', 'search-4'],
  ] as const) {
    expect(state(clear, at(clear, minute))).toMatchObject({ phase, progress: { minute },
      current: { ordinal, inProgress: true }, route: { from: point, to: point, then: 'fight' },
      fight: { ordinal, elapsedMs: 0, finished: false } });
  }
  expect(state(clear, at(clear, 65))).toMatchObject({ phase: 'returning', route: { from: 'search-4', to: 'end', then: 'wait' } });
});

test('masks the published fight label and result until the fight ends, even with its log loaded', () => {
  const start = at(clear, 64);
  expect(state(clear, start + 31_703).current).toMatchObject({ label: 'Major', inProgress: true, outcome: null, replay: false });
  expect(state(clear, start + 31_704).stages.find(stage => stage.ordinal === 4)).toMatchObject({
    label: 'Alpha of the Den: victory', inProgress: false, outcome: 'victory', replay: true,
  });
});

test('keeps fallen party health at zero while the next fight plays with its own logged survivors', () => {
  const finish = state(fell, at(fell, 32) + 14_531);
  expect(finish.stages.find(stage => stage.ordinal === 2)?.outcome).toBe('victory');
  expect(finish.party.map(({ name, hp, max }) => [name, hp, max])).toEqual([
    ['Aster', 0, 100], ['Varro', 261, 291], ['Ludus Fixture', 108, 117],
  ]);
  expect(finish.fight?.log.participants.filter(unit => unit.side === 0).map(unit => unit.name)).toEqual(['Aster', 'Varro', 'Ludus Fixture']);
  expect(state(fell, at(fell, 47)).party).toEqual(finish.party);
  const next = state(fell, at(fell, 48));
  expect(next.party.map(({ name, role, hp }) => [name, role, hp])).toEqual([
    ['Aster', 'gladiator', 0], ['Varro', 'gladiator', 291], ['Ludus Fixture', 'bot', 117],
  ]);
  expect(next.fight?.log.participants.filter(unit => unit.side === 0).map(unit => unit.name)).toEqual(['Varro', 'Ludus Fixture']);
  expect(state(fell, at(fell, 80)).summary).toMatchObject({ success: false, dungeon: { partyWon: true } });
});

test('uses recorded attack health at its due timestamp when the display clock seeks', () => {
  const first = at(clear, 16);
  expect(state(clear, first + 999).party.map(unit => unit.hp)).toEqual([110, 176, 130]);
  expect(state(clear, first + 1_000).party.map(unit => unit.hp)).toEqual([104, 171, 123]);
  expect(state(clear, first).party.map(unit => unit.hp)).toEqual([110, 176, 130]);
});

test.each([
  ['room', lost, 48, 'encounter-3', 14_300], ['major', bossLost, 64, 'search-4', 40_300],
] as const)('turns from a lost %s to the map safe point and stays until minute 80', (_, fixture, minute, point, duration) => {
  const over = at(fixture, minute) + duration + 2_000;
  expect(state(fixture, over - 1).route).toMatchObject({ from: point, to: point, then: 'fight' });
  expect(state(fixture, over)).toMatchObject({ phase: 'safe-return', route: { from: point, to: 'safe', walkedMs: 0, then: 'rest' } });
  expect(state(fixture, at(fixture, 80) - 1)).toMatchObject({ phase: 'safe-return', route: { to: 'safe', then: 'rest' }, summary: null });
  expect(state(fixture, at(fixture, 80))).toMatchObject({ phase: 'settled', route: { from: 'safe', to: 'safe', then: 'leave', rest: { then: 'rest' } } });
  const mapId = fixture === lost ? 'mountain' : 'outpost';
  const map: MapData = JSON.parse(readFileSync(`public/assets/expeditions/${mapId}-map.json`, 'utf8'));
  expect(legPath(journeyMap(map), point, 'safe')?.length).toBeGreaterThan(1);
});

test('ignores later stages, preloaded logs and the owner summary at an earlier display time', () => {
  expect(state(clear, at(clear, 0) - 1)).toMatchObject({ phase: 'preparing', current: null, stages: [], progress: null, route: null, party: [], summary: null });
  const early = state(clear, at(clear, 32) - 1);
  expect(early.stages.map(stage => stage.kind)).toEqual(['depart', 'room', 'exploration']);
  expect(early.fight?.ordinal).toBe(1);
  expect(early.party.map(unit => unit.hp)).toEqual([86, 166, 116]);
  expect(early.summary).toBeNull();
  const timeline = { ...clear.timeline, completion: undefined, summary: { ...clear.timeline.summary!, settledAtMs: at(clear, 81) } };
  expect(renderDungeonStage(timeline, at(clear, 80), logsOf(clear))).toMatchObject({ phase: 'arrived', summary: null });
  expect(renderDungeonStage(timeline, at(clear, 81), logsOf(clear))).toMatchObject({ phase: 'settled', summary: { success: true } });
});

test('allows a completed fight pointer to open a replay before its log loads, until retention expires', () => {
  const timeline = { ...clear.timeline, summary: undefined, completion: { ...clear.timeline.completion!,
    replayExpiry: { state: 'available' as const, expiresAtMs: at(clear, 81) } } };
  const stage = (time: number) => renderDungeonStage(timeline, time, new Map()).stages.find(entry => entry.ordinal === 1);
  expect(stage(at(clear, 80))).toMatchObject({ outcome: 'victory', replay: true, fight: { ordinal: 1, runId: 'dungeon:373237:wolf-den:1' } });
  expect(stage(at(clear, 81))?.replay).toBe(false);
});

test('keeps the settled summary usable after old replay stages have been cleaned up', () => {
  const timeline = { ...clear.timeline, stages: [], summary: { ...clear.timeline.summary!, replayExpiry: { state: 'expired' as const } } };
  expect(renderDungeonStage(timeline, at(clear, 80) - 1, logsOf(clear))).toMatchObject({ phase: 'preparing', summary: null });
  expect(renderDungeonStage(timeline, at(clear, 80), logsOf(clear))).toMatchObject({
    phase: 'settled', stages: [], route: null, fight: null, party: [], summary: { replayExpiry: { state: 'expired' }, success: true },
  });
  expect(planDungeonTrip(timeline, tripOptions)).toBeNull();
});

test('plans nine chapters with the real fight speed and Patch A walking pace', () => {
  const plan = planDungeonTrip(clear.timeline, tripOptions)!;
  expect(plan.chapters.map(({ id, label }) => [id, label])).toEqual([
    ['leaving', 'Leaving camp'], ['trail', 'Into Wolf Den'], ['fight-1', 'Room 1'], ['fight-2', 'Room 2'],
    ['fight-3', 'Room 3'], ['fight-4', 'Alpha of the Den'], ['heading-home', 'Heading home'],
    ['back', 'Back in camp'], ['resting', 'Resting'],
  ]);
  expect(plan.chapters.map(chapter => (chapter.displayFromMs - clear.startsAtMs) / MINUTE)).toEqual([
    0, 0, 16, 32, 48, 64, (64 * MINUTE + 33_704) / MINUTE, 80, 80,
  ]);
  expect(firstLocked(plan, null)).toBe(9);
  expect(tripFrame(plan, 6_000).displayMs).toBe(at(clear, 0) + 8_000);
  for (const minute of [16, 32, 48, 64]) {
    const start = at(clear, minute);
    expect(tripFrame(plan, tripPositionOf(plan, start) + 1_200).displayMs).toBe(start + 1_200);
  }
});

test('replaces chapters after the lost room with Safe point until the camp return', () => {
  const plan = planDungeonTrip(lost.timeline, { ...tripOptions, resting: false })!;
  expect(plan.chapters.map(chapter => chapter.id)).toEqual(['leaving', 'trail', 'fight-1', 'fight-2', 'fight-3', 'safe-point', 'back']);
  expect(plan.chapters[4]).toMatchObject({ displayFromMs: at(lost, 48), displayToMs: at(lost, 48) + 16_300 });
  expect(plan.chapters[5]).toMatchObject({ label: 'Safe point', displayFromMs: at(lost, 48) + 16_300, displayToMs: at(lost, 80) });
  expect(plan.chapters[6].displayFromMs).toBe(at(lost, 80));
});

test('locks chapters after a live cap without disclosing a future loss or settlement', () => {
  const before = at(lost, 0) - 1;
  expect(planDungeonTrip(lost.timeline, { ...tripOptions, nowMs: before })).toBeNull();
  const live = at(lost, 48) + 700;
  const plan = planDungeonTrip(lost.timeline, { ...tripOptions, nowMs: live })!;
  expect(plan.chapters.map(({ id, label, revealed }) => [id, label, revealed])).toEqual([
    ['leaving', 'Leaving camp', true], ['trail', 'Into Troll Hall', true],
    ['fight-1', 'Room 1', true], ['fight-2', 'Room 2', true], ['fight-3', 'Room 3', true],
    ['fight-4', 'Troll King', false], ['heading-home', 'Heading home', false], ['back', 'Back in camp', false],
  ]);
  const cap = tripPositionOf(plan, live);
  expect(firstLocked(plan, cap)).toBe(5);
  expect(tripFrame(plan, cap)).toMatchObject({ displayMs: live, chapter: { id: 'fight-3' } });
  const safe = at(lost, 70);
  const recovering = planDungeonTrip(lost.timeline, { ...tripOptions, nowMs: safe })!;
  expect(firstLocked(recovering, tripPositionOf(recovering, safe))).toBe(6);
  expect(recovering.chapters[5]).toMatchObject({ id: 'safe-point', revealed: true });
  expect(recovering.chapters[6]).toMatchObject({ id: 'back', revealed: false });
});
