import { expect, it } from 'vitest';
import type { ActivitySummary, CreditedRewards } from '@contracts/events';
import type { GameNotification } from '@contracts/reads';
import { levelUpLine, notificationLines } from '../../src/features/messages/notifications';

// Notifications (2026-10-28, spec "Added 2026-10-28: notifications"): what a settled activity of the player's own earned, as plain
// text lines. The text says gold (the player-facing word for the `money` fields), never money, and a "Level up!" line only when the
// notification carries the level the gladiator reached (`levelAfter`).
const rewards = (over: Partial<CreditedRewards> = {}): CreditedRewards => ({ money: 0, renown: 0, xp: 0, attributePoints: 0, items: [], overflowMoney: 0, ...over });
const item = (catalogId: string, tier: 1 | 5 | 10, rarity: 'common' | 'uncommon' | 'rare', quantity = 1) => ({ catalogId, catalogVersion: 'v1', tier, rarity, quantity });
function note(kind: GameNotification['kind'], summary: Partial<ActivitySummary> = {}, over: Partial<GameNotification> = {}): GameNotification {
  const full: ActivitySummary = { activityId: '11111111-1111-4111-8111-111111111111', resolvedKind: kind, result: 'completed', success: true, rewards: rewards(),
    receiptId: '22222222-2222-4222-8222-222222222222', settledAtMs: 1_791_590_400_000, replayExpiry: { state: 'expired' }, ...summary };
  return { activityId: full.activityId, kind, settledAtMs: full.settledAtMs, summary: full, destination: null, levelAfter: null, ...over };
}
const woodland = { destination: 'Woodland Path' };

it('lists what training earned: XP and attribute points, with the singular for one point', () => {
  expect(notificationLines(note('training', { rewards: rewards({ xp: 40, attributePoints: 1 }) }))).toEqual({
    title: 'Training finished', lines: ['+40 XP', '+1 attribute point'], levelUp: null });
  expect(notificationLines(note('training', { rewards: rewards({ attributePoints: 3 }) })).lines).toEqual(['+3 attribute points']);
  // A training that credited nothing (the attribute points were capped) says so rather than showing an empty card.
  expect(notificationLines(note('training')).lines).toEqual(['No rewards']);
});

it('lists an expedition: the destination and result, gold, XP, each item with its rarity and tier, and the extra items sold for gold', () => {
  const sword = item('sword:5:rare', 5, 'rare');
  expect(notificationLines(note('expedition', { result: 'victory', rewards: rewards({ money: 120, xp: 250, items: [sword], overflowMoney: 35 }) }, woodland))).toEqual({
    title: 'Expedition victory: Woodland Path',
    lines: ['+120 gold', '+250 XP', 'Rare Sword (tier 5)', '+35 gold for extra items sold'], levelUp: null });
  // A catalog name this client does not know is built from the item's id, so a future item is still listed (never skipped).
  expect(notificationLines(note('expedition', { result: 'victory', rewards: rewards({ money: 120, xp: 250, items: [item('iron-sword:5:rare', 5, 'rare')], overflowMoney: 35 }) }, woodland)).lines)
    .toEqual(['+120 gold', '+250 XP', 'Rare Iron sword (tier 5)', '+35 gold for extra items sold']);
  // A stack shows its quantity (not "×1"), and salvage has no tier or rarity worth saying.
  expect(notificationLines(note('expedition', { result: 'victory', rewards: rewards({ items: [item('light-boots:1:uncommon', 1, 'uncommon', 2), item('salvage', 1, 'common', 3), item('salvage', 1, 'common', 1)] }) })).lines)
    .toEqual(['Uncommon Light boots (tier 1) ×2', 'Salvage ×3', 'Salvage']);
  // Without a destination (a result this client cannot name) the title still says what it was.
  expect(notificationLines(note('expedition', { result: 'victory', rewards: rewards({ xp: 10 }) })).title).toBe('Expedition victory');
});

it('says a defeated expedition earned nothing', () => {
  expect(notificationLines(note('expedition', { result: 'defeat', success: false }, woodland))).toEqual({
    title: 'Expedition defeat: Woodland Path', lines: ['No rewards'], levelUp: null });
});

it('lists an Arena result: victory or defeat, renown and the rating change', () => {
  expect(notificationLines(note('arena', { result: 'victory', rewards: rewards({ renown: 30 }), ratingDelta: 12 }))).toEqual({
    title: 'Arena victory', lines: ['+30 renown', 'Rating +12'], levelUp: null });
  expect(notificationLines(note('arena', { result: 'defeat', rewards: rewards({ renown: 10 }), ratingDelta: -8 }))).toEqual({
    title: 'Arena defeat', lines: ['+10 renown', 'Rating −8'], levelUp: null });
  expect(notificationLines(note('arena', { result: 'victory', ratingDelta: 0 })).lines).toEqual(['Rating unchanged']);
  // A bout with no rating change (an NPC fallback) shows no rating line, and no renown shows no renown line.
  expect(notificationLines(note('arena', { result: 'victory', rewards: rewards({ renown: 30 }) })).lines).toEqual(['+30 renown']);
  expect(notificationLines(note('arena', { result: 'defeat' })).lines).toEqual(['No rewards']);
});

it('lists a tournament result: its result, gold and renown', () => {
  expect(notificationLines(note('tournament', { result: 'victory', rewards: rewards({ money: 200, renown: 50 }) }))).toEqual({
    title: 'Tournament victory', lines: ['+200 gold', '+50 renown'], levelUp: null });
  expect(notificationLines(note('tournament', { result: 'defeat' }))).toEqual({ title: 'Tournament defeat', lines: ['No rewards'], levelUp: null });
});

it('shows "Level up! Now level 4" only when the notification carries the level reached, right after the XP', () => {
  const earned = rewards({ money: 120, xp: 250 });
  const levelled = notificationLines(note('expedition', { result: 'victory', rewards: earned }, { ...woodland, levelAfter: 4 }));
  expect(levelled.levelUp).toBe(4);
  expect(levelled.lines).toEqual(['+120 gold', '+250 XP', 'Level up! Now level 4']);
  expect(levelUpLine(4)).toBe('Level up! Now level 4');
  const same = notificationLines(note('expedition', { result: 'victory', rewards: earned }, { ...woodland, levelAfter: null }));
  expect(same.levelUp).toBeNull();
  expect(same.lines.join('\n')).not.toMatch(/level/i);
  // Without an XP line the level-up line still shows (it never hides a level reached).
  expect(notificationLines(note('expedition', { result: 'victory' }, { levelAfter: 2 })).lines).toEqual(['Level up! Now level 2']);
});

it('says gold and never money in any title or line', () => {
  const all = [
    note('training', { rewards: rewards({ money: 5, xp: 1, attributePoints: 1 }) }),
    note('expedition', { result: 'victory', rewards: rewards({ money: 5, xp: 1, overflowMoney: 7, items: [item('sword:1:common', 1, 'common')] }) }, { ...woodland, levelAfter: 2 }),
    note('arena', { result: 'victory', rewards: rewards({ money: 5, renown: 1 }), ratingDelta: 1 }),
    note('tournament', { result: 'victory', rewards: rewards({ money: 5, renown: 1 }) }),
  ];
  for (const n of all) {
    const { title, lines } = notificationLines(n);
    expect([title, ...lines].join('\n'), n.kind).not.toMatch(/money/i);
  }
  expect(notificationLines(all[0]).lines).toContain('+5 gold');
});

it('shows text as text: a destination with markup stays characters, and the input is never changed', () => {
  const n = note('expedition', { result: 'victory', rewards: rewards({ xp: 1 }) }, { destination: '<b>Woodland</b> & "Path"' });
  const before = structuredClone(n);
  expect(notificationLines(n).title).toBe('Expedition victory: <b>Woodland</b> & "Path"');
  expect(n).toEqual(before);
});
