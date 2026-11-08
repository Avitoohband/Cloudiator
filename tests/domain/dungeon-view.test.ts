import { describe, expect, it } from 'vitest';
import { dungeonFrom, dungeonTripMarks } from '@/features/dungeon/dungeon-text';
import { renderDungeonStage } from '@/game/dungeon-stage';
import { DUNGEON_FIXTURES } from '../fixtures/dungeons';

describe('dungeon view projection', () => {
  it('uses a public departure or retained outcome to name the dungeon', () => {
    const sample = DUNGEON_FIXTURES['room-lost'];
    expect(dungeonFrom({ ...sample.timeline, summary: undefined, completion: undefined })?.id).toBe('troll-hall');
    expect(dungeonFrom({ ...sample.timeline, summary: undefined, stages: [] })?.id).toBe('troll-hall');
    expect(dungeonFrom({ ...sample.timeline, summary: undefined, completion: undefined, stages: [] })).toBeNull();
  });

  it('labels three rooms and the major, only linking fights that ended', () => {
    const sample = DUNGEON_FIXTURES['full-victory'];
    const state = renderDungeonStage(sample.timeline, sample.startsAtMs + 32 * 60_000, new Map());
    const marks = dungeonTripMarks(state, 'Alpha of the Den', '24');
    expect(marks.map(mark => mark.fight)).toEqual([null, 1, 2, 3, 4, null]);
    expect(marks.map(mark => mark.replay)).toEqual([false, true, false, false, false, false]);
    expect(marks[4].text).toContain('Alpha of the Den');
  });

  it('leaves fights beyond a terminal loss unavailable', () => {
    const sample = DUNGEON_FIXTURES['room-lost'];
    const state = renderDungeonStage(sample.timeline, sample.startsAtMs + 78 * 60_000, new Map());
    expect(dungeonTripMarks(state, 'Troll King', '24').map(mark => mark.replay)).toEqual([false, true, true, true, false, false]);
  });
});
