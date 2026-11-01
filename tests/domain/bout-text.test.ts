import { describe, expect, it } from 'vitest';
import type { ActivitySummary, BattleLog, RevealedStage } from '@contracts/events';
import type { MyBout } from '@/lib/api/reads';
import {
  RESULT_HINT, bracketChapter, againLabel, recentRow, boutEyebrow, boutRow, chapterLabel, counterText, dayGroups, emptyText, nextLabel, ratingText, rewardChips, unwatchedCount, upNextText, verdictText,
} from '@/features/bouts/bout-text';
import { ARENA_BATTLE_LOGS } from '../fixtures/arena';

// Arena replays Task 4 (spec 1): the words of My bouts' rows, day groups, count and empty states. Zones are named in each call.
const NOW = Date.UTC(2026, 9, 10, 4, 0);
const AT = Date.UTC(2026, 9, 10, 3, 0);
const DAY = 86_400_000;

it('writes the queue counter and Up next in the approved wide and narrow copy', () => {
  expect(counterText({ entries: Array.from({ length: 5 }, () => bout()), index: 0, more: false }))
    .toEqual({ wide: 'Bout 1 of 5 in My bouts', narrow: '1 / 5' });
  expect(counterText({ entries: Array.from({ length: 20 }, () => bout()), index: 19, more: true }))
    .toEqual({ wide: 'Bout 20 of 20+ in My bouts', narrow: '20 / 20+' });
  expect(upNextText({ a: 'Aster', b: 'Cassia', kind: 'arena', foughtAtMs: Date.UTC(2026, 9, 10, 0, 20) }, '12', 'UTC'))
    .toEqual({ wide: 'Aster vs Cassia · Arena · Sat 10 Oct, 12:20\xA0AM', narrow: 'Aster vs Cassia · Sat 12:20\xA0AM' });
  expect(upNextText({ a: 'Aster', b: 'Varro', chapter: 'Semifinal' }, '12', 'UTC'))
    .toEqual({ wide: 'Aster vs Varro · Semifinal', narrow: 'Aster vs Varro · Semifinal' });
});

/** An Arena victory fought at 03:00 UTC on Sat 10 Oct, +10 renown, rating +14, its replay kept, against Varro. */
function bout(over: Partial<MyBout> = {}): MyBout {
  return { activityId: 'a', kind: 'arena', slotIndex: 373_247, foughtAtMs: AT, settledAtMs: AT + 20 * 60_000, result: 'victory', renown: 10, ratingDelta: 14,
    replayExpiry: { state: 'available', expiresAtMs: AT + 20 * 60_000 + 7 * DAY }, opponent: { name: 'Varro', npc: false }, tieBreak: false, round: null, ...over };
}

describe('a My bouts row', () => {
  it('writes a kept bout as the mockup does', () => {
    expect(boutRow(bout(), NOW, '12', 'UTC')).toEqual({ kept: true, badge: { letter: 'W', name: 'Won' }, name: 'vs Varro', tag: null,
      sub: { wide: 'Arena · 3:00\xA0AM · +10 renown · Rating +14', narrow: '3:00\xA0AM · +10 renown · Rating +14' },
      action: '▶ Watch', label: 'Watch: vs Varro, Sat 10 Oct, 3:00\xA0AM' });
    expect(boutRow(bout(), NOW, '24', 'UTC').sub.wide).toBe('Arena · 03:00 · +10 renown · Rating +14');
  });

  it('says a loss, a tie-break, an NPC and leaves out zero parts', () => {
    expect(boutRow(bout({ result: 'defeat', renown: 2, ratingDelta: -13, tieBreak: true, opponent: { name: 'Cassia', npc: false } }), NOW, '12', 'UTC'))
      .toMatchObject({ badge: { letter: 'L', name: 'Lost' }, sub: { wide: 'Arena · 3:00\xA0AM · lost on a tie-break · +2 renown · Rating −13' } });
    expect(boutRow(bout({ tieBreak: true }), NOW, '12', 'UTC').sub.wide).toContain('· won on a tie-break ·');
    expect(boutRow(bout({ opponent: { name: 'Iron Warden', npc: true }, renown: 3, ratingDelta: null }), NOW, '12', 'UTC'))
      .toMatchObject({ name: 'vs Iron Warden', tag: 'NPC', sub: { wide: 'Arena · 3:00\xA0AM · +3 renown' } });
    expect(boutRow(bout({ renown: 0, ratingDelta: 0 }), NOW, '12', 'UTC').sub.wide).toBe('Arena · 3:00\xA0AM');
  });

  it('starts a tournament row with its round', () => {
    expect(boutRow(bout({ kind: 'tournament', round: 'Final', renown: 60, ratingDelta: 16 }), NOW, '12', 'UTC'))
      .toMatchObject({ tag: 'TOURNAMENT', sub: { wide: 'Final · 3:00\xA0AM · +60 renown · Rating +16', narrow: 'Final · 3:00\xA0AM · +60 renown · Rating +16' } });
    expect(boutRow(bout({ kind: 'tournament', round: null }), NOW, '12', 'UTC').sub.narrow).toBe('3:00\xA0AM · +10 renown · Rating +14');
    expect(boutRow(bout({ kind: 'tournament', round: null }), NOW, '12', 'UTC').sub.wide).toBe('Tournament · 3:00\xA0AM · +10 renown · Rating +14');
  });

  it('dims a bout whose replay is gone, by the server’s time, and names no opponent', () => {
    const gone = boutRow(bout({ replayExpiry: { state: 'expired' } }), NOW, '12', 'UTC');
    expect(gone).toMatchObject({ kept: false, name: 'Arena bout', tag: null, action: 'Result', badge: { letter: 'W', name: 'Won' },
      sub: { wide: '3:00\xA0AM · replay no longer kept', narrow: '3:00\xA0AM · replay no longer kept' }, label: 'Result: Arena bout, Sat 10 Oct, 3:00\xA0AM' });
    const at = bout({ replayExpiry: { state: 'available', expiresAtMs: NOW } });
    expect(boutRow(at, NOW - 1, '12', 'UTC').kept).toBe(true);
    expect(boutRow(at, NOW, '12', 'UTC').kept).toBe(false);
    expect(boutRow(bout(), null, '12', 'UTC').action).toBeNull();
    expect(boutRow(bout({ opponent: null }), NOW, '12', 'UTC').name).toBe('Arena bout');
    // Task 2 carry: the read named the opponent while the replay was kept; once the display clock passes the expiry the row no longer
    // names them, nor says a tie-break, an NPC or a tournament tag, though its summary still says `available`.
    const lapsed = boutRow(bout({ replayExpiry: { state: 'available', expiresAtMs: NOW }, tieBreak: true, opponent: { name: 'Iron Warden', npc: true } }), NOW, '12', 'UTC');
    expect(lapsed).toMatchObject({ kept: false, name: 'Arena bout', tag: null, action: 'Result', sub: { wide: '3:00\xA0AM · replay no longer kept' } });
    expect(JSON.stringify(lapsed)).not.toMatch(/Iron Warden|tie-break/);
    expect(boutRow(bout({ kind: 'tournament', round: 'Final', replayExpiry: { state: 'expired' } }), NOW, '12', 'UTC'))
      .toMatchObject({ name: 'Tournament bout', tag: null, sub: { wide: '3:00\xA0AM · replay no longer kept' }, label: 'Result: Tournament bout, Sat 10 Oct, 3:00\xA0AM' });
    // A kept tournament bout whose run could not be read: the generic name, still watchable, with no tag repeating it.
    expect(boutRow(bout({ kind: 'tournament', opponent: null }), NOW, '12', 'UTC')).toMatchObject({ name: 'Tournament bout', tag: null, action: '▶ Watch' });
  });

  it('writes a rating change with a real minus sign', () => {
    expect([ratingText(14), ratingText(-13), ratingText(1)]).toEqual(['Rating +14', 'Rating −13', 'Rating +1']);
  });
});

describe('the My bouts list', () => {
  it('groups by day, today first', () => {
    expect(dayGroups([bout(), bout({ activityId: 'b', foughtAtMs: Date.UTC(2026, 9, 10, 1) }), bout({ activityId: 'c', foughtAtMs: Date.UTC(2026, 9, 9, 23) })], NOW, 'UTC')
      .map(g => [g.label, g.bouts.length])).toEqual([['TODAY · SAT 10 OCT', 2], ['FRI 9 OCT', 1]]);
    // The viewer's own zone decides the day: 23:00 UTC on Fri is already Sat in UTC+3.
    expect(dayGroups([bout({ foughtAtMs: Date.UTC(2026, 9, 9, 23) })], NOW, 'Etc/GMT-3').map(g => g.label)).toEqual(['TODAY · SAT 10 OCT']);
    // Without the server's time no day is called today.
    expect(dayGroups([bout()], Number.NaN, 'UTC').map(g => g.label)).toEqual(['SAT 10 OCT']);
    expect(dayGroups([], NOW, 'UTC')).toEqual([]);
  });

  it('counts the kept bouts not watched, and says an empty list', () => {
    expect(unwatchedCount([bout(), bout({ activityId: 'b' }), bout({ activityId: 'c', replayExpiry: { state: 'expired' } })], new Set(['b']), NOW)).toBe(1);
    expect(unwatchedCount([bout({ replayExpiry: { state: 'available', expiresAtMs: NOW } })], new Set(), NOW)).toBe(0);
    expect([emptyText('all'), emptyText('won'), emptyText('lost')]).toEqual(['No bouts yet. Your Arena and tournament bouts show here with their replays.',
      'No won bouts yet.', 'No lost bouts yet.']);
  });
});

// Arena replays Task 5 (spec 2): the viewer's words. The eyebrow says the kind and when the bout was fought, never the server's stage
// label (Review Focus 4); the end card says who won and why, the owner's credited rewards as chips, and names its buttons.
describe('the replay viewer', () => {
  const at = Date.UTC(2026, 9, 10, 3, 0), fri = Date.UTC(2026, 9, 9, 23, 0);
  const boutStage = (startedAtMs: number, label: string): RevealedStage =>
    ({ id: `bout-${label}`, kind: 'bout', revealedAtMs: startedAtMs, startedAtMs, endsAtMs: startedAtMs + 20 * 60_000, label });
  const encounterStage = (label: string): RevealedStage =>
    ({ id: `encounter-${label}`, kind: 'encounter', revealedAtMs: at, startedAtMs: at, endsAtMs: at + 60_000, label });
  const LOGS = ARENA_BATTLE_LOGS;
  const summary = (over: { renown?: number; money?: number; ratingDelta?: number }): ActivitySummary => ({
    activityId: 'a', resolvedKind: 'arena', result: 'victory', success: true,
    rewards: { money: over.money ?? 0, renown: over.renown ?? 0, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 },
    receiptId: 'r', settledAtMs: at, replayExpiry: { state: 'available', expiresAtMs: at + 7 * DAY },
    ...(over.ratingDelta === undefined ? {} : { ratingDelta: over.ratingDelta }),
  });
  /** Varro's bout, ended another way: the victory event and the log say the same reason. */
  const endedBy = (reason: BattleLog['victoryReason'], tieBreakReason: BattleLog['tieBreakReason']): BattleLog => ({
    ...LOGS.ownerHumanWin, victoryReason: reason, tieBreakReason,
    events: LOGS.ownerHumanWin.events.map(e => (e.kind === 'victory' ? { ...e, reason } : e)),
  });

  it('writes the eyebrow from the kind and the time, never the stage label', () => {
    expect(boutEyebrow(boutStage(at, 'Bout: victory'), { npc: false, league: null, compact: false }, '12', 'UTC')).toBe('ARENA · SAT 10 OCT, 3:00\xA0AM');
    expect(boutEyebrow(boutStage(fri, 'Bout: defeat'), { npc: true, league: null, compact: false }, '12', 'UTC')).toBe('ARENA · FRI 9 OCT, 11:00\xA0PM · NPC OPPONENT');
    expect(boutEyebrow(boutStage(at, 'Bout: victory'), { npc: false, league: null, compact: true }, '12', 'UTC')).toBe('ARENA · SAT 3:00\xA0AM');
    expect(boutEyebrow(boutStage(fri, 'Bout: victory'), { npc: true, league: null, compact: true }, '12', 'UTC')).toBe('ARENA · FRI 11:00\xA0PM · NPC');
    expect(boutEyebrow(boutStage(at, 'Bout: victory'), { npc: false, league: null, compact: false }, '24', 'UTC')).toBe('ARENA · SAT 10 OCT, 03:00');
    expect(boutEyebrow(boutStage(at, 'Final: defeat'), { npc: false, league: 'bronze', compact: false }, '12', 'UTC')).toBe('TOURNAMENT · BRONZE · FINAL');
    expect(boutEyebrow(boutStage(at, 'Final: defeat'), { npc: false, league: null, compact: false }, '12', 'UTC')).toBe('TOURNAMENT · FINAL');
    expect(boutEyebrow(encounterStage('Encounter 1: Dire Wolf'), { npc: false, league: null, compact: false }, '12', 'UTC')).toBe('Expedition · Encounter 1: Dire Wolf');
    expect(chapterLabel(boutStage(at, 'Quarterfinal: victory'))).toBe('Quarterfinal');
    // TournamentPanel supplies this safe bracket label; its round must survive in the eyebrow.
    expect(boutEyebrow(boutStage(at, 'Tournament · Final'), { npc: false, league: 'silver', compact: false }, '12', 'UTC')).toBe('TOURNAMENT · SILVER · FINAL');
    expect(boutEyebrow(boutStage(at, 'Tournament · Semifinals'), { npc: false, league: 'bronze', compact: false }, '12', 'UTC')).toBe('TOURNAMENT · BRONZE · SEMIFINAL');
    expect(boutEyebrow(boutStage(at, 'Tournament · Quarterfinals'), { npc: false, league: 'bronze', compact: true }, '12', 'UTC')).toBe('TOURNAMENT · BRONZE · QUARTERFINAL');
    expect(boutEyebrow(boutStage(at, 'Arena bout against Varro'), { npc: false, league: null, compact: false }, '12', 'UTC')).toBe('ARENA · SAT 10 OCT, 3:00\xA0AM');
    expect(chapterLabel(encounterStage('Encounter 2: Forest Bear'))).toBe('Encounter 2: Forest Bear');
    expect(chapterLabel(boutStage(at, 'Bout: defeat'))).toBe('Bout');
    // An eyebrow or a chapter never carries the outcome, whatever the label says.
    for (const label of ['Bout: victory', 'Bout: defeat', 'Final: victory', 'Round 2: defeat']) {
      for (const compact of [false, true]) {
        expect(boutEyebrow(boutStage(at, label), { npc: false, league: null, compact }, '12', 'UTC')).not.toMatch(/victory|defeat/i);
      }
      expect(chapterLabel(boutStage(at, label))).not.toMatch(/victory|defeat/i);
    }
  });

  it('says who won and why', () => {
    expect(verdictText(LOGS.ownerHumanWin, false)).toEqual({ verdict: 'Aster wins', reason: 'Varro is defeated.' });
    expect(verdictText(LOGS.ownerHumanLoss, true)).toEqual({ verdict: 'Cassia wins', reason: 'Aster is defeated.' });
    expect(verdictText(LOGS.ownerTieBreak, false).reason).toBe('Both fell at the same moment; a seeded tie-break chose Aster.');
    expect(verdictText(LOGS.ownerTieBreak, true).reason).toBe('A tie-break chose Aster.');
    // The time-out endings (Planner's call).
    expect(verdictText(endedBy('health-fraction', null), false)).toEqual({ verdict: 'Aster wins', reason: 'Time ran out and Aster kept more health.' });
    expect(verdictText(endedBy('tie-break', 'equal-health-fraction'), false).reason).toBe('Time ran out with equal health; a seeded tie-break chose Aster.');
    expect(verdictText(endedBy('tie-break', 'equal-health-fraction'), true).reason).toBe('A tie-break chose Aster.');
  });

  it('lists the credited rewards as chips', () => {
    expect(rewardChips(summary({ renown: 10, ratingDelta: 14 }), { fighter: true, npc: false, kind: 'arena', last: true })).toEqual(['+10 renown', 'Rating +14']);
    expect(rewardChips(summary({ renown: 3 }), { fighter: true, npc: true, kind: 'arena', last: true })).toEqual(['+3 renown', 'NPC: no rating change']);
    expect(rewardChips(summary({ renown: 60, money: 100, ratingDelta: 16 }), { fighter: true, npc: false, kind: 'tournament', last: true })).toEqual(['+60 renown', '+100 gold', 'Rating +16']);
    expect(rewardChips(summary({ renown: 60 }), { fighter: true, npc: false, kind: 'tournament', last: false })).toEqual([]);
    expect(rewardChips(null, { fighter: true, npc: false, kind: 'arena', last: true })).toEqual(['Rewards are credited when the bout settles']);
    expect(rewardChips(null, { fighter: true, npc: false, kind: 'tournament', last: true })).toEqual(['Rewards are credited when the tournament settles']);
    expect(rewardChips(null, { fighter: false, npc: false, kind: 'arena', last: true })).toEqual([]);
    // A loss writes its rating as the notifications do; zero parts are left out; a spectator sees none.
    expect(rewardChips(summary({ renown: 2, ratingDelta: -13 }), { fighter: true, npc: false, kind: 'arena', last: true })).toEqual(['+2 renown', 'Rating −13']);
    expect(rewardChips(summary({ ratingDelta: 0 }), { fighter: true, npc: false, kind: 'arena', last: true })).toEqual([]);
    expect(rewardChips(summary({ renown: 10, ratingDelta: 14 }), { fighter: false, npc: false, kind: 'arena', last: true })).toEqual([]);
    // An expedition's rewards are the whole trip's: the Result card below lists them, the end card has none (builder's call).
    expect(rewardChips(summary({ renown: 5, money: 20 }), { fighter: true, npc: true, kind: 'expedition', last: true })).toEqual([]);
    expect(rewardChips(null, { fighter: true, npc: true, kind: 'expedition', last: true })).toEqual([]);
  });

  it('names the end card’s buttons', () => {
    expect([nextLabel('Cassia', false), nextLabel('Cassia', true), nextLabel(null, false), againLabel(false), againLabel(true)])
      .toEqual(['▶ Next bout · vs Cassia', '▶ Next · vs Cassia', '▶ Next bout', '↺ Watch again', '↺ Again']);
    expect(nextLabel(null, true)).toBe('▶ Next');
    expect(RESULT_HINT).toBe('The result appears when the fight ends, or now with ⚑ Result.');
  });
});

describe('recent Arena menu rows', () => {
 it('uses relative calendar days and only the first applicable detail', () => {
 expect(recentRow(bout(), NOW, '12', 'UTC').sub).toEqual({ wide: 'Today, 3:00 AM · Rating +14', narrow: 'Today, 3:00 AM · Rating +14' });
 expect(recentRow(bout({ ratingDelta: null, renown: 0, tieBreak: true }), NOW, '12', 'UTC').sub).toEqual({ wide: 'Today, 3:00 AM · won on a tie-break', narrow: 'Today, 3:00 AM · tie-break' });
 expect(recentRow(bout({ result: 'defeat', ratingDelta: 0, tieBreak: true }), NOW, '24', 'UTC').sub.wide).toBe('Today, 03:00 · lost on a tie-break');
 expect(recentRow(bout({ foughtAtMs: Date.UTC(2026, 9, 9, 23), ratingDelta: null, renown: 3 }), NOW, '12', 'UTC').sub.wide).toBe('Fri, 11:00 PM · +3 renown');
 expect(recentRow(bout({ foughtAtMs: Date.UTC(2026, 9, 3, 19), ratingDelta: 0, renown: 0 }), NOW, '12', 'UTC').sub.wide).toBe('Sat 3 Oct, 7:00 PM');
 expect(recentRow(bout({ replayExpiry: { state: 'expired' } }), NOW, '12', 'UTC').sub.wide).toBe('Today, 3:00 AM · replay no longer kept');
 expect(recentRow(bout(), null, '12', 'UTC')).toMatchObject({ action: null, sub: { wide: 'Sat 10 Oct, 3:00 AM · Rating +14' } });
 expect(recentRow(bout({ foughtAtMs: Date.UTC(2026, 9, 9, 23) }), NOW, '24', 'Etc/GMT-3').sub.wide).toBe('Today, 02:00 · Rating +14');
 });
});

it('names bracket chapters without outcomes', () => {
  expect([bracketChapter('Final', 0, 1), bracketChapter('Semifinal', 1, 2), bracketChapter('Quarterfinal', 2, 4), bracketChapter('Round 1', 4, 8)])
    .toEqual(['Final', 'SF 2', 'QF 3', 'R1 · 5']);
});
