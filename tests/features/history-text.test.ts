import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '@contracts/reads';
import type { OwnRewards } from '@/lib/api/reads';
import {
  EVERYTHING, HISTORY_KINDS, HISTORY_SUBTITLE, chipCount, chipText, emptyHistory, footerText, historyDays, historyRow, historyScene, historyTitle, retentionText, runLastRows,
} from '@/features/character/history-text';
import { roundPips } from '@/features/bouts/bout-text';

// Patch 1.9 Task 27 (the approved mockup `.superpowers/design/2026-11-12-gladiator-history/`): the words of a gladiator's History on its card.
// Zones are named in each call; the fixture's "now" is Sat 10 Oct 2026, 04:00 UTC.
const NOW = Date.UTC(2026, 9, 10, 4, 0);
const AT = Date.UTC(2026, 9, 10, 2, 40);
const DAY = 86_400_000;
const ACT = '1ac1fd28-1bc1-4ebb-9cc2-004e1dc201e1';

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return { entryId: ACT, kind: 'arena', activityId: ACT, foughtAtMs: AT, settledAtMs: AT + 20 * 60_000, result: 'victory', success: true,
    replayExpiry: { state: 'available', expiresAtMs: AT + 7 * DAY }, league: 'silver', tournamentId: null, round: null, place: null, expeditionId: null,
    opponent: { name: 'Varro', npc: false }, ...over };
}
const tournament = (over: Partial<HistoryEntry> = {}) => entry({ kind: 'tournament', entryId: 'tournament:373245:silver:3:0', tournamentId: 'tournament:373245:silver',
  round: 'Final', place: 1, opponent: { name: 'Marcellus', npc: false }, foughtAtMs: Date.UTC(2026, 9, 10, 20, 0) - DAY, ...over });
const expedition = (over: Partial<HistoryEntry> = {}) => entry({ kind: 'expedition', league: null, expeditionId: 'woodland', opponent: null, ...over });
const rewards = (over: Partial<OwnRewards> = {}): OwnRewards => ({ renown: 10, money: 0, ratingDelta: 13, unranked: false, items: [], ...over });

describe('the history view words', () => {
  it('names the view, its chips, its retention lines, its footer and its empty states as the mockup does', () => {
    expect(HISTORY_KINDS).toEqual(['arena', 'tournament', 'expedition']);
    expect(historyTitle('Lucilla', false)).toBe("Lucilla's history");
    expect(historyTitle('Aster', true)).toBe('My history');
    expect(HISTORY_SUBTITLE).toBe('Newest first · 20 at a time');
    // The controller's ruling: the tournament chip counts fights.
    expect(HISTORY_KINDS.map(chipText)).toEqual([{ icon: null, label: 'Arena' }, { icon: '🏆', label: 'Tournament fights' }, { icon: null, label: 'Expeditions' }]);
    const counts = { arena: { total: 24, won: 21 }, tournament: { total: 4, won: 3 }, expedition: { total: 12, won: 10 } };
    expect(HISTORY_KINDS.map(kind => chipCount(kind, counts))).toEqual(['21–3', '4', '12']);
    expect(HISTORY_KINDS.map(kind => chipCount(kind, null))).toEqual(['', '', '']);
    expect(HISTORY_KINDS.map(retentionText)).toEqual([
      'Replays are kept for 7 days. ▶ Watch shows where a replay is still kept.',
      'Tournament replays are kept for 7 days after the tournament ends.',
      'Expedition replays are kept for 7 days. A trip still under way can be watched once it is over.',
    ]);
    expect(footerText(false)).toBe('Rewards stay private. Anyone can watch a kept replay; it shows the fights, never loot.');
    expect(footerText(true)).toBe('You see your own rewards here. Other players see only the results.');
    expect(HISTORY_KINDS.map(kind => emptyHistory(kind, 'Lucilla'))).toEqual([
      { title: 'No Arena bouts yet', line: 'Lucilla has not fought in the Arena.' },
      { title: 'No tournament battles yet', line: 'Lucilla has not fought in a tournament.' },
      { title: 'No expeditions yet', line: 'Lucilla has not been on an expedition.' },
    ]);
    expect(EVERYTHING).toBe('That is everything.');
  });
});

describe('an Arena row', () => {
  it('writes a kept bout on another gladiator’s card: no reward of any kind', () => {
    expect(historyRow(entry(), { nowMs: NOW, clock: '12', timeZone: 'UTC' })).toEqual({ kept: true, badge: { text: 'W', name: 'Won', won: true }, name: 'vs Varro', tag: null,
      round: null, pill: null, sub: 'Arena · 2:40\xA0AM · Silver league', action: '▶ Watch', label: 'Watch: vs Varro, Sat 10 Oct, 2:40\xA0AM' });
    expect(historyRow(entry(), { nowMs: NOW, clock: '24', timeZone: 'UTC' }).sub).toBe('Arena · 02:40 · Silver league');
  });

  it('tags an NPC (no league) and a Ludus Nimbus bot of an unranked bout', () => {
    const npc = historyRow(entry({ result: 'defeat', opponent: { name: 'Iron Warden', npc: true } }), { nowMs: NOW, clock: '12', timeZone: 'UTC' });
    expect(npc).toMatchObject({ badge: { text: 'L', name: 'Lost', won: false }, name: 'vs Iron Warden', tag: 'NPC', sub: 'Arena · 2:40\xA0AM' });
    const bot = historyRow(entry({ arenaMode: 'unranked', opponent: { name: 'Nimbus Vex', npc: false, botTeam: 'ludus-nimbus' } }), { nowMs: NOW, clock: '12', timeZone: 'UTC' });
    expect(bot).toMatchObject({ name: 'vs Nimbus Vex', tag: 'BOT', sub: 'Unranked Arena · 2:40\xA0AM' });
  });

  it('dims a bout whose replay is gone: no opponent, "replay no longer kept" and Result, by the server clock', () => {
    const expired = historyRow(entry({ replayExpiry: { state: 'expired' }, opponent: null }), { nowMs: NOW, clock: '12', timeZone: 'UTC' });
    expect(expired).toEqual({ kept: false, badge: { text: 'W', name: 'Won', won: true }, name: 'Arena bout', tag: null, round: null, pill: null,
      sub: '2:40\xA0AM · replay no longer kept', action: 'Result', label: 'Result: Arena bout, Sat 10 Oct, 2:40\xA0AM' });
    // Kept when read, gone by the clock now: the opponent is no longer named.
    const lapsed = historyRow(entry({ replayExpiry: { state: 'available', expiresAtMs: NOW - 1 } }), { nowMs: NOW, clock: '12', timeZone: 'UTC' });
    expect(lapsed).toMatchObject({ kept: false, name: 'Arena bout', action: 'Result' });
    // Before the server time is known, the read's own state decides and no button is offered.
    expect(historyRow(entry(), { nowMs: null, clock: '12', timeZone: 'UTC' })).toMatchObject({ kept: true, action: null });
  });

  it('adds the owner’s own renown and rating change on its own card', () => {
    expect(historyRow(entry(), { nowMs: NOW, clock: '12', timeZone: 'UTC', rewards: rewards() }).sub).toBe('Arena · 2:40\xA0AM · Silver league · +10 renown · Rating +13');
    expect(historyRow(entry({ result: 'defeat' }), { nowMs: NOW, clock: '12', timeZone: 'UTC', rewards: rewards({ renown: 2, ratingDelta: -13 }) }).sub)
      .toBe('Arena · 2:40\xA0AM · Silver league · +2 renown · Rating −13');
    // An NPC bout: renown only (the mockup's "+0 renown" too).
    expect(historyRow(entry({ result: 'defeat', opponent: { name: 'Bronze Sentinel', npc: true } }), { nowMs: NOW, clock: '12', timeZone: 'UTC',
      rewards: rewards({ renown: 0, ratingDelta: null }) }).sub).toBe('Arena · 2:40\xA0AM · +0 renown');
    expect(historyRow(entry({ arenaMode: 'unranked', opponent: { name: 'Nimbus Vex', npc: false, botTeam: 'ludus-nimbus' } }), { nowMs: NOW, clock: '12', timeZone: 'UTC',
      rewards: rewards({ renown: 4, ratingDelta: null, unranked: true }) }).sub).toBe('Unranked Arena · 2:40\xA0AM · +4 renown · Rating unchanged');
    expect(historyRow(entry({ replayExpiry: { state: 'expired' }, opponent: null }), { nowMs: NOW, clock: '12', timeZone: 'UTC', rewards: rewards() }).sub)
      .toBe('2:40\xA0AM · +10 renown · Rating +13 · replay no longer kept');
  });
});

describe('a tournament row', () => {
  it('writes the round, the tournament’s name, WON or LOST and the opponent, as the mockup does', () => {
    expect(historyRow(tournament(), { nowMs: NOW, clock: '12', timeZone: 'UTC' })).toEqual({ kept: true, badge: { text: 'W', name: 'Won', won: true },
      name: 'Silver Tournament', tag: null, round: 'FINAL', pill: 'WON', sub: 'vs Marcellus · 8:00\xA0PM', action: '▶ Watch',
      label: 'Watch: Silver Tournament, Final vs Marcellus, Fri 9 Oct, 8:00\xA0PM' });
    const lost = historyRow(tournament({ result: 'defeat', round: 'Quarterfinal', entryId: 'tournament:373100:silver:1:2', replayExpiry: { state: 'expired' }, opponent: null }),
      { nowMs: NOW, clock: '12', timeZone: 'UTC' });
    expect(lost).toMatchObject({ kept: false, round: 'QUARTERFINAL', pill: 'LOST', sub: '8:00\xA0PM · replay no longer kept', action: 'Result' });
    expect(historyRow(tournament({ round: 'Round 1', league: null }), { nowMs: NOW, clock: '12', timeZone: 'UTC' })).toMatchObject({ round: 'ROUND 1', name: 'Tournament' });
  });

  it('adds the run’s place and prize to its last bout only, on the owner’s own card', () => {
    const prize = rewards({ renown: 30, money: 150, ratingDelta: 16 });
    expect(historyRow(tournament(), { nowMs: NOW, clock: '12', timeZone: 'UTC', rewards: prize, runLast: true }).sub).toBe('vs Marcellus · 8:00\xA0PM · 1st place · 150 gold · +30 renown');
    expect(historyRow(tournament({ round: 'Semifinal', opponent: { name: 'Kael', npc: false } }), { nowMs: NOW, clock: '12', timeZone: 'UTC', rewards: prize, runLast: false }).sub)
      .toBe('vs Kael · 8:00\xA0PM');
    expect(historyRow(tournament({ place: 2 }), { nowMs: NOW, clock: '12', timeZone: 'UTC', rewards: rewards({ renown: 30, money: 60 }), runLast: true }).sub)
      .toBe('vs Marcellus · 8:00\xA0PM · 2nd place · 60 gold · +30 renown');
    expect(historyRow(tournament({ place: 3 }), { nowMs: NOW, clock: '12', timeZone: 'UTC', rewards: rewards({ renown: 15, money: 30 }), runLast: true }).sub)
      .toContain('3rd place');
    expect(historyRow(tournament({ place: 11 }), { nowMs: NOW, clock: '12', timeZone: 'UTC', rewards: rewards({ renown: 5, money: 0 }), runLast: true }).sub)
      .toBe('vs Marcellus · 8:00\xA0PM · 11th place · +5 renown');
  });

  it('marks the newest row of each run as its last bout', () => {
    const final = tournament(), semi = tournament({ entryId: 'tournament:373245:silver:2:0', round: 'Semifinal' });
    const other = tournament({ activityId: '205cb3d6-215c-4569-9e5c-b0b01f5cb243', entryId: 'tournament:373100:silver:1:0' });
    expect([...runLastRows([final, semi, other])]).toEqual([final.entryId, other.entryId]);
  });
});

describe('an expedition row', () => {
  it('writes the destination, its result and time with a ✓ or ✗', () => {
    expect(historyRow(expedition(), { nowMs: NOW, clock: '12', timeZone: 'UTC' })).toEqual({ kept: true, badge: { text: '✓', name: 'Success', won: true }, name: 'Woodland Path',
      tag: null, round: null, pill: null, sub: 'Expedition · Success · 2:40\xA0AM', action: '▶ Watch', label: 'Watch: Woodland Path, Sat 10 Oct, 2:40\xA0AM' });
    expect(historyRow(expedition({ result: 'defeat', success: false, expeditionId: 'outpost', replayExpiry: { state: 'expired' } }), { nowMs: NOW, clock: '12', timeZone: 'UTC' }))
      .toMatchObject({ kept: false, badge: { text: '✗', name: 'Failed', won: false }, name: 'Ruined Outpost', sub: 'Expedition · Failed · 2:40\xA0AM · replay no longer kept', action: 'Result' });
    expect(historyRow(expedition({ expeditionId: 'atlantis' }), { nowMs: NOW, clock: '12', timeZone: 'UTC' }).name).toBe('Expedition');
  });

  it('adds the owner’s own gold and items on its own card', () => {
    expect(historyRow(expedition(), { nowMs: NOW, clock: '12', timeZone: 'UTC', rewards: rewards({ renown: 0, money: 85, ratingDelta: null,
      items: [{ catalogId: 'iron-helmet:1:common', quantity: 1 }, { catalogId: 'salvage', quantity: 3 }] }) }).sub)
      .toBe('Expedition · Success · 2:40\xA0AM · +85 gold · Iron helmet · Salvage ×3');
    expect(historyRow(expedition({ result: 'defeat', success: false }), { nowMs: NOW, clock: '12', timeZone: 'UTC', rewards: rewards({ renown: 0, money: 0, ratingDelta: null }) }).sub)
      .toBe('Expedition · Failed · 2:40\xA0AM');
  });
});

describe('groups and scenes', () => {
  it('groups the rows by the day they were fought, newest first, today named', () => {
    const rows = [entry({ entryId: 'a', foughtAtMs: NOW - 60_000 }), entry({ entryId: 'b', foughtAtMs: AT - DAY }), entry({ entryId: 'c', foughtAtMs: AT - DAY - 3_600_000 })];
    expect(historyDays(rows, NOW, 'UTC').map(group => [group.label, group.entries.map(row => row.entryId)]))
      .toEqual([['TODAY · SAT 10 OCT', ['a']], ['FRI 9 OCT', ['b', 'c']]]);
    expect(historyDays(rows, null, 'UTC')[0].label).toBe('SAT 10 OCT');
  });

  it('opens an Arena bout’s replay, a tournament bout at its round and an expedition’s whole trip', () => {
    expect(historyScene(entry())).toEqual({ kind: 'replay', activityId: ACT });
    expect(historyScene(tournament())).toEqual({ kind: 'replay', activityId: ACT, stageId: `${ACT}:3` });
    expect(historyScene(tournament({ entryId: 'tournament:373245:silver:12:3' }))).toEqual({ kind: 'replay', activityId: ACT, stageId: `${ACT}:12` });
    expect(historyScene(expedition())).toEqual({ kind: 'expedition', activityId: ACT, play: 'trip' });
  });
});

describe('the tournament replay’s round pips', () => {
  it('marks the rounds before the shown one done, for a run’s round chapters only', () => {
    expect(roundPips(['Quarterfinal', 'Semifinal', 'Final'], 2)).toEqual([
      { label: 'Quarterfinal', state: 'done' }, { label: 'Semifinal', state: 'done' }, { label: 'Final', state: 'current' }]);
    expect(roundPips(['Round 1', 'Quarterfinal', 'Semifinal', 'Final'], 1).map(p => p.state)).toEqual(['done', 'current', 'later', 'later']);
    // A bracket's chapters (QF 1, SF 2…) and a single bout have none.
    expect(roundPips(['QF 1', 'QF 2', 'SF 1', 'Final'], 3)).toEqual([]);
    expect(roundPips(['Final'], 0)).toEqual([]);
  });
});
