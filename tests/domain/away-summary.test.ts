import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CreditedRewards, ItemReward } from '@contracts/events';
import type { EarnedTitle, GameMessage, GameNotification, HistoryEntry } from '@contracts/reads';
import { RULES_V2 } from '@domain/rules-v2';
import { awaySince, awayTimeText, buildAwaySummary, type AwaySummaryInput } from '../../src/features/away-summary/away-summary';
import { AwaySummaryDialog } from '../../src/features/away-summary/AwaySummaryDialog';
import { notificationLines } from '../../src/features/messages/notifications';
import { restedActivityName, restedNoteLines } from '../../src/features/schedule/stamina-text';
import { ownerFixture } from '../fixtures/domain';

const MINUTE = 60_000, DAY = 1440 * MINUTE;
const nowMs = 8 * DAY, sinceMs = nowMs - 2 * 60 * MINUTE - 5 * MINUTE;
const salvage: ItemReward = { catalogId: 'salvage', catalogVersion: 'v1', rarity: 'common', tier: 1, quantity: 2 };
const spear: ItemReward = { catalogId: 'spear:5:rare', catalogVersion: 'v1', rarity: 'rare', tier: 5, quantity: 1 };

function result(id: string, kind: GameNotification['kind'], options: {
  at?: number; won?: boolean; rewards?: Partial<CreditedRewards>; destination?: string; ratingDelta?: number; unranked?: boolean;
  dungeon?: GameNotification['summary']['dungeon'];
} = {}): GameNotification {
  const { at = nowMs, won = true, rewards, destination = null, ratingDelta, unranked, dungeon } = options;
  return { activityId: id, kind, settledAtMs: at, levelAfter: null, destination,
    summary: { activityId: id, resolvedKind: kind, result: kind === 'training' ? 'completed' : won ? 'victory' : 'defeat',
      success: won, settledAtMs: at, receiptId: id, replayExpiry: { state: 'expired' }, ratingDelta,
      ...(unranked ? { arenaMode: 'unranked' as const } : {}), dungeon,
      rewards: { money: 0, xp: 0, renown: 0, attributePoints: 0, overflowMoney: 0, items: [], ...rewards } },
  };
}
const title = (id: string, at = nowMs, details: Partial<EarnedTitle> = {}): EarnedTitle => ({
  id, earnedAtMs: at, source: 'result', activityId: null, detail: null, ...details,
});
function history(id: string, place: number, round: HistoryEntry['round']): HistoryEntry {
  return { entryId: `${id}-${round}`, kind: 'tournament', activityId: id, foughtAtMs: nowMs, settledAtMs: nowMs,
    result: 'defeat', success: false, replayExpiry: { state: 'expired' }, league: 'silver', tournamentId: `tournament:${id}:silver`,
    place, round, expeditionId: null, opponent: null };
}

function input(changes: Partial<AwaySummaryInput> = {}): AwaySummaryInput {
  return { owner: structuredClone(ownerFixture), rules: RULES_V2, sinceMs, nowMs, results: [], rests: [], history: [],
    messages: [], progressionTrusted: true, ...changes };
}

describe('While you were away model', () => {
  it('uses the most recent mark, including a new device, and caps history at seven days', () => {
    expect(awaySince(nowMs, sinceMs + 1, sinceMs)).toBe(sinceMs + 1);
    expect(awaySince(nowMs, sinceMs, sinceMs + 1)).toBe(sinceMs + 1);
    expect(awaySince(nowMs, null, sinceMs)).toBe(sinceMs);
    expect(awaySince(nowMs, null, 0)).toBe(nowMs - 7 * DAY);
  });

  it('uses the exclusive start, inclusive end and newest 150 results', () => {
    const items = Array.from({ length: 151 }, (_, index) => result(String(index), 'training', { at: sinceMs + index + 1,
      rewards: { attributePoints: index === 0 ? 99 : 1 } }));
    const summary = buildAwaySummary(input({ results: [
      result('too-old', 'training', { at: sinceMs }), ...items, result('future', 'training', { at: nowMs + 1 }),
    ] }));
    expect(summary?.resultCount).toBe(150);
    expect(summary?.lines[0]).toMatchObject({ label: 'Training ×150', main: '+150 attribute points' });
    expect(summary?.seenUpToMs).toBe(sinceMs + 151);
  });

  it('opens for a replaced rest or a known new title, while messages alone leave nothing to show', () => {
    const data = input();
    data.owner.inbox.unread = 1;
    expect(buildAwaySummary(data)).toBeNull();
    const rest = { activityId: 'rest', settledAtMs: nowMs, planned: 'expedition' as const, destination: 'Ruined Outpost', reason: 'stamina' as const, name: 'Aster' };
    expect(buildAwaySummary({ ...data, rests: [{ ...rest, settledAtMs: null }] })).toBeNull();
    expect(buildAwaySummary({ ...data, rests: [{ ...rest, settledAtMs: sinceMs }] })).toBeNull();
    expect(buildAwaySummary({ ...data, rests: [rest] })).toMatchObject({ resultCount: 0, seenUpToMs: nowMs,
      rested: 'Rested once instead of the Ruined Outpost expedition: not enough stamina.' });
    data.owner.titles = [title('rare-find')];
    expect(buildAwaySummary(data)).toMatchObject({ resultCount: 0, seenUpToMs: nowMs, titles: [{ name: 'Rare Find' }] });
  });

  it('rolls up Arena wins and losses and counts only ranked rating changes', () => {
    const summary = buildAwaySummary(input({ results: [
      result('a', 'arena', { ratingDelta: 20 }), result('b', 'arena', { won: false, ratingDelta: -6 }),
      result('c', 'arena', { ratingDelta: 37, unranked: true }),
    ] }));
    expect(summary?.lines).toEqual([{ kind: 'arena', label: 'Arena', main: '2 won', detail: ' · 1 lost · rating +14' }]);
    expect(buildAwaySummary(input({ results: [result('c', 'arena', { ratingDelta: 37, unranked: true })] }))?.lines)
      .toEqual([{ kind: 'arena', label: 'Arena', main: '1 won' }]);
  });

  it('uses the history placement once per tournament run, with semifinal and quarterfinal ties', () => {
    const summary = buildAwaySummary(input({ results: [result('1', 'tournament'), result('2', 'tournament')],
      history: [history('1', 3, 'Semifinal'), history('1', 3, 'Quarterfinal'), history('2', 5, 'Quarterfinal')] }));
    expect(summary?.lines).toEqual([
      { kind: 'tournament', label: 'Silver Tournament', main: '3rd place' },
      { kind: 'tournament', label: 'Silver Tournament', main: '5th place' },
    ]);
  });

  it('keeps a known tournament league when its history has no placement', () => {
    const bout = { ...history('1', 3, 'Semifinal'), league: 'bronze' as const, place: null };
    expect(buildAwaySummary(input({ results: [result('1', 'tournament')], history: [bout] }))?.lines)
      .toEqual([{ kind: 'tournament', label: 'Bronze Tournament', main: 'finished' }]);
  });

  it('lists the two newest runs of each kind, keeping older runs and their loot beside their kind', () => {
    const runs = Array.from({ length: 7 }, (_, i) => [
      result(`dungeon-${i}`, 'dungeon', { at: nowMs - i * MINUTE, destination: `Dungeon ${i}`, rewards: { items: [salvage] } }),
      result(`tournament-${i}`, 'tournament', { at: nowMs - i * MINUTE }),
    ]).flat().reverse();
    const placements = Array.from({ length: 7 }, (_, i) => history(`tournament-${i}`, i + 1, 'Semifinal'));
    const summary = buildAwaySummary(input({ results: runs, history: placements }));
    expect(summary?.resultCount).toBe(14);
    expect(summary?.lines.filter(line => line.kind === 'tournament').map(line => line.main))
      .toEqual(['1st place', '2nd place', '5 more tournaments']);
    expect(summary?.lines.filter(line => line.kind === 'dungeon')).toMatchObject([
      { label: 'Dungeon 0' }, { label: 'Dungeon 1' },
      { main: '5 more dungeon runs', detail: ' · 10 items' },
    ]);
    expect(summary?.items).toMatchObject([{ catalogId: 'salvage', quantity: 14 }]);
  });

  it('groups expedition destinations and counts kept loot, with the dungeon member or party outcome', () => {
    const summary = buildAwaySummary(input({ results: [
      result('1', 'expedition', { destination: 'Ruined Outpost', rewards: { items: [spear, salvage] } }),
      result('2', 'expedition', { destination: 'Ruined Outpost', won: false }),
      result('3', 'expedition', { destination: 'Woodland Path' }),
      result('4', 'dungeon', { destination: 'Wolf Den', dungeon: { id: 'wolf-den', terminalFight: 4, partyWon: true },
        rewards: { items: [spear] } }),
      result('5', 'dungeon', { destination: 'Wolf Den', won: false, dungeon: { id: 'wolf-den', terminalFight: 3, partyWon: false } }),
    ] }));
    expect(summary?.lines).toEqual([
      { kind: 'expedition', label: 'Ruined Outpost ×2', main: '1 won', detail: ' · back with 3 items' },
      { kind: 'expedition', label: 'Woodland Path', main: 'won' },
      { kind: 'dungeon', label: 'Wolf Den', main: 'your party won', detail: ' · 1 item' },
      { kind: 'dungeon', label: 'Wolf Den', main: 'the party lost in Room 3' },
    ]);
  });

  it('describes Training points, available points and a full Training', () => {
    const data = input({ results: [result('1', 'training', { rewards: { attributePoints: 1 } }),
      result('2', 'training', { rewards: { attributePoints: 1 } })] });
    data.owner.progression.unspentAttributePoints = 1;
    expect(buildAwaySummary(data)?.lines).toEqual([
      { kind: 'training', label: 'Training ×2', main: '+2 attribute points', detail: ' to spend' },
    ]);
    data.owner.progression.unspentAttributePoints = 0;
    expect(buildAwaySummary(data)?.lines[0].detail).toBeUndefined();
    expect(buildAwaySummary(input({ results: [result('1', 'training')] }))?.lines).toEqual([
      { kind: 'training', label: 'Training', main: 'no point (Training was full for your level)' },
    ]);
  });

  it('orders known titles by catalog and names a season place, leaving out old or unknown titles', () => {
    const data = input();
    data.owner.titles = [title('rare-find'), title('not-real'), title('wanderer'), title('champion', nowMs - 1,
      { source: 'season', detail: { seasonIndex: 2, league: 'silver', place: 1 } }), title('founder', sinceMs)];
    expect(buildAwaySummary(data)?.titles).toEqual([
      { id: 'wanderer', name: 'Wanderer', detail: '10 expeditions won' },
      { id: 'champion', name: 'Champion', detail: '1st in Season 3 · Silver' },
      { id: 'rare-find', name: 'Rare Find', detail: 'A first Rare item' },
    ]);
  });

  it('adds overflow gold and shows how many items did not fit', () => {
    const summary = buildAwaySummary(input({ results: [result('1', 'expedition', { rewards: {
      money: 10, renown: 2, overflowMoney: 24, overflow: [{ catalogId: 'salvage', catalogVersion: 'v1', quantity: 2, unitValue: 12, money: 24 }],
    } })] }));
    expect(summary).toMatchObject({ gold: 34, renown: 2 });
    expect(summary?.lines.at(-1)).toEqual({ kind: 'overflow', label: 'Bag full', main: '2 items sold for 24 gold' });
  });

  it('shows bag-full gold when a legacy result has no usable overflow detail', () => {
    for (const overflow of [{ quantity: 2 }, [null, { quantity: '2' }]]) {
      const legacy = result('1', 'expedition', { rewards: {
        money: 10, overflowMoney: 24, overflow: overflow as unknown as CreditedRewards['overflow'],
      } });
      const summary = buildAwaySummary(input({ results: [legacy] }));
      expect(summary?.gold).toBe(34);
      expect(summary?.lines.at(-1)).toEqual({ kind: 'overflow', label: 'Bag full', main: 'Items sold for 24 gold' });
      const detailed = result('2', 'expedition', { rewards: {
        overflowMoney: 4, overflow: [{ catalogId: 'salvage', catalogVersion: 'v1', quantity: 1, unitValue: 4, money: 4 }],
      } });
      expect(buildAwaySummary(input({ results: [legacy, detailed] }))?.lines.at(-1))
        .toEqual({ kind: 'overflow', label: 'Bag full', main: 'Items sold for 28 gold' });
    }
  });

  it('shows multiple level gains when proven and keeps the arrow hidden without a trustworthy snapshot', () => {
    const data = input({ results: [result('1', 'expedition', { rewards: { xp: 250 } }), result('2', 'expedition', { rewards: { xp: 80 } })] });
    data.owner.progression = { ...data.owner.progression, level: 3, xp: 50 };
    expect(buildAwaySummary(data)).toMatchObject({ levelBefore: 1, level: 3, xpGained: 330,
      xp: { valueText: '50 / 300 XP', previousFill: 0, gainedFill: 1 / 6 } });
    expect(buildAwaySummary({ ...data, progressionTrusted: false })?.levelBefore).toBeNull();
    data.owner.progression = { ...data.owner.progression, level: 4, xp: 100 };
    expect(buildAwaySummary(input({ owner: data.owner, results: [result('3', 'expedition', { rewards: { xp: 30 } })] })))
      .toMatchObject({ levelBefore: null, xp: { previousFill: 70 / 400, gainedFill: 30 / 400 } });
  });

  it('formats minutes, hours and days as in the approved copy', () => {
    expect(awayTimeText(45 * MINUTE)).toBe('45 min');
    expect(awayTimeText(125 * MINUTE)).toBe('2 h 05 min');
    expect(awayTimeText(DAY + 6 * 60 * MINUTE)).toBe('1 d 6 h');
  });

  it('reuses notification item names, combines identical loot, and reports unread team replies', () => {
    const anExpedition = result('1', 'expedition', { rewards: { items: [spear, salvage] } });
    const data = input({ results: [anExpedition, result('2', 'expedition', { rewards: { items: [salvage] } })] });
    const reply: GameMessage = { id: 11, kind: 'team-reply', title: 'Reply', preview: '', body: [], action: null, publishedAtMs: nowMs - MINUTE };
    data.owner.inbox = { ...data.owner.inbox, sinceMs, unread: 2, readIds: [] };
    const summary = buildAwaySummary({ ...data, messages: [reply] });
    expect(summary).toMatchObject({ messageCount: 2, teamReply: true });
    expect(summary?.items.map(({ name, label, quantity }) => ({ name, label, quantity }))).toEqual([
      { name: 'Rare Spear', label: notificationLines(anExpedition).lines[0], quantity: 1 },
      { name: 'Salvage', label: 'Salvage', quantity: 4 },
    ]);
    data.owner.inbox.readIds = [11];
    expect(buildAwaySummary({ ...data, messages: [reply] })?.teamReply).toBe(false);
  });

  it('orders loot by rarity and then newest-first, with stacked salvage last', () => {
    const oldRare = { ...spear, catalogId: 'dagger:5:rare' };
    const uncommon = { ...spear, catalogId: 'spear:5:uncommon', rarity: 'uncommon' as const };
    const common = { ...spear, catalogId: 'spear:5:common', rarity: 'common' as const };
    const summary = buildAwaySummary(input({ results: [
      result('old', 'expedition', { at: nowMs - 2 * MINUTE, rewards: { items: [oldRare, salvage] } }),
      result('new', 'expedition', { rewards: { items: [salvage, common, uncommon, spear] } }),
    ] }));
    expect(summary?.items.map(({ catalogId, quantity }) => [catalogId, quantity])).toEqual([
      [spear.catalogId, 1], [oldRare.catalogId, 1], [uncommon.catalogId, 1], [common.catalogId, 1], [salvage.catalogId, 4],
    ]);
  });

  it('summarizes limit and stamina rests without borrowing activity numbers', () => {
    const limit = { activityId: 'rest', settledAtMs: nowMs, planned: 'training' as const, destination: null, reason: 'limit' as const, name: 'Aster' };
    expect(buildAwaySummary(input({ rests: [limit] }))?.rested)
      .toBe('Rested once instead of Training: the Training limit (2 a game day).');
    expect(buildAwaySummary(input({ rests: [limit, { ...limit, activityId: 'r2', planned: 'arena', reason: 'stamina' }] }))?.rested)
      .toBe('Rested 2 times instead of planned activities: not enough stamina or the Training limit (2 a game day).');
  });

  it('shares the planned-activity phrase with the owner’s notification', () => {
    const rest = { activityId: 'r', settledAtMs: nowMs, planned: 'dungeon' as const, destination: null, reason: 'stamina' as const, name: 'Aster' };
    const phrase = restedActivityName(rest);
    expect(phrase).toBe('a dungeon');
    expect(restedNoteLines(rest, rest.name, RULES_V2).title).toBe(`Aster rested instead of ${phrase}`);
    expect(buildAwaySummary(input({ rests: [rest] }))?.rested).toBe(`Rested once instead of ${phrase}: not enough stamina.`);
  });
});

describe('away summary presentation', () => {
  const render = (summary: NonNullable<ReturnType<typeof buildAwaySummary>>, compact = false) => renderToStaticMarkup(createElement(AwaySummaryDialog, {
    summary, owner: ownerFixture, compact, onClose: () => {},
  }));
  const text = (html: string) => html.replace(/<[^>]*>/g, '');

  it('keeps a six-item day with two dungeons and Arena in the regular layout', () => {
    const summary = buildAwaySummary(input({ results: [
      result('trip', 'expedition', { rewards: { items: Array.from({ length: 6 }, () => spear) } }),
      result('d1', 'dungeon'), result('d2', 'dungeon'), result('arena', 'arena'),
    ] }))!;
    expect(summary.items).toHaveLength(6);
    expect(render(summary, true)).not.toContain('data-dense');
  });

  it('keeps every title name in dense mode and groups the remaining runs beside their own kind', () => {
    const data = input({ results: Array.from({ length: 7 }, (_, index) => [
      result(`t${index}`, 'tournament'), result(`d${index}`, 'dungeon', { rewards: { overflowMoney: 4 } }),
    ]).flat() });
    data.owner.titles = [title('rare-find'), title('victor'), title('tiro')];
    const html = render(buildAwaySummary(data)!);
    expect(html).toContain('data-dense');
    expect(html.match(/<em>/g)).toHaveLength(3);
    const copy = text(html);
    expect(copy.indexOf('5 more tournaments')).toBeLessThan(copy.indexOf('Dungeon:'));
    expect(copy.indexOf('5 more dungeon runs')).toBeLessThan(copy.indexOf('Bag full:'));
  });

  it('provides hidden Rare item names as screen-reader text when Rares exceed the tile cap', () => {
    const items = [...Array.from({ length: 8 }, () => spear), { ...spear, catalogId: 'dagger:5:rare' }];
    const html = render(buildAwaySummary(input({ results: [result('loot', 'expedition', { rewards: { items } })] }))!);
    expect(html).not.toMatch(/<strong[^>]*aria-label=/);
    expect(text(html)).toContain('Additional Rare items: Rare Dagger (tier 5)');
    expect(text(html)).toContain('+1 more, 1 Rare');
  });
});
