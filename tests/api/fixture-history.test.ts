import { describe, expect, it } from 'vitest';
import type { HistoryEntry, HistoryKind } from '@contracts/reads';
import { createFixtureGateway } from '../../src/lib/api/fixture-gateway';
import { HISTORY_PAGE } from '../../src/lib/api/reads';
import { replayKept } from '../../src/lib/replay-retention';
import { tournamentRound } from '../../src/lib/tournament-id';
import { ARENA_GLADIATORS } from '../fixtures/arena-ids';
import { HISTORY_NOW, HISTORY_RUNS } from '../fixtures/history';
import { RESTING_ACTOR } from '../fixtures/resting';

// Patch 1.9 Task 27: the fixture preview's gladiator history (tests/fixtures/history.ts), paged, ordered and counted as the live read
// does, through the live read's own row parser; every kept row opens a replay the preview holds; the owner's own rewards only for her own.
const gateway = createFixtureGateway();
const { aster, varro, corvina, lucilla } = ARENA_GLADIATORS;
async function all(id: string, kind: HistoryKind): Promise<HistoryEntry[]> {
  const rows: HistoryEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const read = await gateway.history!(id, kind, cursor);
    rows.push(...read.rows);
    if (!read.nextCursor) return rows;
    cursor = read.nextCursor;
  }
  throw new Error('the history never ended');
}
const ordered = (rows: readonly HistoryEntry[]) => rows.every((row, i) => i === 0 || rows[i - 1].foughtAtMs > row.foughtAtMs
  || (rows[i - 1].foughtAtMs === row.foughtAtMs && rows[i - 1].entryId < row.entryId));

describe('the fixture preview’s gladiator history', () => {
  it('pages 20 at a time, newest first, with the live read’s cursor rules', async () => {
    const first = await gateway.history!(varro.id, 'arena');
    expect(first.rows).toHaveLength(HISTORY_PAGE);
    expect(first.nextCursor).toBe(`${first.rows[19].foughtAtMs}:${first.rows[19].entryId}`);
    const second = await gateway.history!(varro.id.toUpperCase(), 'arena', first.nextCursor!);
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.rows).toHaveLength(3);
    const rows = [...first.rows, ...second.rows];
    expect(ordered(rows)).toBe(true);
    expect(new Set(rows.map(r => r.entryId)).size).toBe(23);
    // A malformed id, kind or cursor is refused; a well-formed cursor past the end is an empty page.
    for (const [id, kind, cursor] of [['g1', 'arena'], [varro.id, 'dungeon'], [varro.id, 'arena', 'bad']] as const) {
      await expect(gateway.history!(id, kind as HistoryKind, cursor)).rejects.toMatchObject({ code: 'unavailable' });
    }
    expect(await gateway.history!(varro.id, 'arena', `0:${aster.id}`)).toEqual({ rows: [], nextCursor: null });
    await expect(gateway.historyCounts!('g1')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('counts every row of each kind and how many were won', async () => {
    for (const id of [aster.id, varro.id, corvina.id, lucilla.id, RESTING_ACTOR.gladiatorId]) {
      const counts = await gateway.historyCounts!(id);
      for (const kind of ['arena', 'tournament', 'expedition'] as const) {
        const rows = await all(id, kind);
        expect(counts[kind], `${id} ${kind}`).toEqual({ total: rows.length, won: rows.filter(r => r.result === 'victory').length });
      }
    }
    // Otho has no history: every list is empty and every count 0.
    expect(await gateway.historyCounts!(RESTING_ACTOR.gladiatorId)).toEqual({ arena: { total: 0, won: 0 }, tournament: { total: 0, won: 0 }, expedition: { total: 0, won: 0 } });
  });

  it('gives several gladiators all three kinds, kept and gone, and a kept tournament final', async () => {
    const kept = (row: HistoryEntry) => replayKept(row.replayExpiry, HISTORY_NOW);
    const varroRuns = await all(varro.id, 'tournament');
    expect(varroRuns.map(r => [r.round, r.result, kept(r)])).toEqual([
      ['Final', 'victory', true], ['Semifinal', 'victory', true], ['Quarterfinal', 'victory', true],
      ['Final', 'victory', false], ['Semifinal', 'victory', false], ['Quarterfinal', 'victory', false]]);
    expect(varroRuns.slice(0, 3).map(r => r.opponent?.name)).toEqual(['Corvina', 'Cassia', 'Titus']);
    expect(varroRuns.slice(3).map(r => r.opponent)).toEqual([null, null, null]);
    expect(varroRuns.map(r => [r.league, r.place])).toEqual(Array.from({ length: 6 }, () => ['bronze', 1]));
    expect((await all(corvina.id, 'tournament')).map(r => [r.round, r.result, kept(r), r.place])).toEqual([
      ['Final', 'defeat', true, 2], ['Semifinal', 'victory', true, 2], ['Quarterfinal', 'victory', true, 2], ['Quarterfinal', 'defeat', false, 5]]);
    expect(await all(corvina.id, 'expedition')).toEqual([]);
    const varroArena = await all(varro.id, 'arena');
    expect(varroArena.filter(kept).map(r => r.opponent)).toEqual([{ name: 'Aster', npc: false }]);
    expect(varroArena.filter(r => !kept(r)).every(r => r.opponent === null)).toBe(true);
    expect((await all(varro.id, 'expedition')).map(r => [r.expeditionId, r.success, kept(r)])).toEqual([['outpost', false, true], ['woodland', true, false]]);
    expect((await all(lucilla.id, 'tournament')).map(r => [r.round, r.result, kept(r), r.league])).toEqual([['Final', 'victory', false, 'silver'], ['Semifinal', 'victory', false, 'silver']]);
  });

  it('opens every kept row’s replay: the run’s bout at its round, with the row’s opponent and result, and no owner summary for another', async () => {
    for (const id of [aster.id, varro.id, corvina.id, lucilla.id]) {
      for (const kind of ['arena', 'tournament', 'expedition'] as const) {
        for (const row of (await all(id, kind)).filter(r => replayKept(r.replayExpiry, HISTORY_NOW))) {
          const timeline = await gateway.timeline(row.activityId);
          expect(timeline.stages.some(s => s.battleLog), `${row.entryId}`).toBe(true);
          if (id !== aster.id) expect(timeline.summary, row.entryId).toBeUndefined();
          if (kind !== 'tournament') continue;
          const round = row.entryId.split(':')[3], stage = timeline.stages.find(s => s.id === `${row.activityId}:${round}`)!;
          expect(tournamentRound(stage.label)).toBe(row.round);
          expect(stage.label.endsWith(row.result)).toBe(true);
          expect(stage.battleLog!.participants.map(p => p.name)).toContain(row.opponent!.name);
          expect(stage.battleLog!.participants.map(p => p.gladiatorId)).toContain(id);
        }
      }
    }
    expect(Object.values(HISTORY_RUNS)).toHaveLength(2);
  });

  it('lists Aster’s own bouts as My bouts does, and gives her own rewards for her own activities only', async () => {
    const bouts = (await gateway.bouts('all')).rows;
    const arena = await all(aster.id, 'arena');
    expect(arena.map(r => [r.activityId, r.result])).toEqual(bouts.filter(b => b.kind === 'arena').map(b => [b.activityId, b.result]));
    expect(arena.map(r => r.opponent?.name ?? null)).toEqual(bouts.filter(b => b.kind === 'arena').map(b => b.opponent?.name ?? null));
    const runs = await all(aster.id, 'tournament');
    expect(runs.map(r => [r.round, r.result, r.place])).toEqual([['Quarterfinal', 'defeat', 5], ['Final', 'victory', 1]]);
    const trips = await all(aster.id, 'expedition');
    expect(trips).toHaveLength(5);
    const rewards = await gateway.ownRewards!([arena[0].activityId, runs[1].activityId, trips[0].activityId, HISTORY_RUNS.varro]);
    expect(rewards.get(arena[0].activityId)).toEqual({ renown: 10, money: 0, ratingDelta: 13, unranked: false, items: [] });
    expect(rewards.get(runs[1].activityId)).toMatchObject({ renown: 60, money: 100 });
    expect(rewards.get(trips[0].activityId)).toMatchObject({ money: 20, items: [{ catalogId: 'light-boots:1:uncommon', quantity: 1 }, { catalogId: 'salvage', quantity: 1 }] });
    expect(rewards.has(HISTORY_RUNS.varro)).toBe(false);
  });
});
