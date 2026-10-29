import { describe, expect, it } from 'vitest';
import type { ApiErrorCode } from '@contracts/commands';
import type { ActivitySummary } from '@contracts/events';
import { buildRefusal } from '../../src/features/build/build-refusal';
import { gearRefusal } from '../../src/features/inventory/gear';
import { LOWEST_PRICE_TEXT, marketErrorText, money, npcValueText, type MarketKind } from '../../src/features/market/market-text';
import { choiceHint } from '../../src/features/schedule/schedule-text';
import { creditedText } from '../../src/features/tournaments/tournament-text';

// Task 7b (Avi, 2026-10-28: "about the money, next patch change it to gold"): every word a player reads says gold. The data keeps
// its `money` names (columns, JSON fields, the icon id); only the text builders change, so each is checked here with sample values.
const MONEY = /\bmoney\b/i;
const CODES: ApiErrorCode[] = ['unauthenticated', 'invalid', 'conflict', 'processing', 'insufficient-funds', 'inventory-full', 'sold', 'expired', 'not-found', 'rate-limited', 'unavailable'];
const KINDS: MarketKind[] = ['create-listing', 'cancel-listing', 'buy-listing'];

describe('the currency is called gold', () => {
  it('writes an amount as gold, with thousands separators', () => {
    expect(money(1250)).toBe('1,250 gold');
    expect(money(1)).toBe('1 gold');
    expect(money(1_000_000_000)).toBe('1,000,000,000 gold');
  });

  it('says gold in every market sentence', () => {
    const sentences = [
      money(450), LOWEST_PRICE_TEXT,
      npcValueText({ catalogId: 'sword:5:common', catalogVersion: 'v1', tier: 5, rarity: 'common', quantity: 1 }),
      npcValueText({ catalogId: 'salvage', catalogVersion: 'v1', tier: 1, rarity: 'common', quantity: 12 }),
      ...KINDS.flatMap(kind => CODES.map(code => marketErrorText(code, kind))),
    ];
    for (const text of sentences) expect(text).not.toMatch(MONEY);
    expect(LOWEST_PRICE_TEXT).toMatch(/^The lowest price is \d+ gold, /);
    expect(marketErrorText('insufficient-funds', 'buy-listing')).toBe('Not enough available gold for this purchase. Held fees cannot be spent.');
    expect(marketErrorText('invalid', 'create-listing')).toMatch(/at least \d+ gold, with at most/);
    expect(npcValueText({ catalogId: 'salvage', catalogVersion: 'v1', tier: 1, rarity: 'common', quantity: 12 })).toMatch(/^NPC sale value: [\d,]+ gold \([\d,]+ each\)$/);
  });

  it('says gold in the refusal of a build change and of a gear change', () => {
    for (const code of [...CODES, 'something-else']) {
      expect(buildRefusal(code), `build ${code}`).not.toMatch(MONEY);
      expect(gearRefusal(code), `gear ${code}`).not.toMatch(MONEY);
    }
    expect(buildRefusal('insufficient-funds')).toBe('Not enough available gold for this reservation.');
    expect(gearRefusal('insufficient-funds')).toBe('Not enough available gold for this reservation.');
  });

  it('says gold in the schedule hint of every activity', () => {
    for (const choice of [{ kind: 'training' }, { kind: 'rest' }, { kind: 'arena' }, { kind: 'expedition', expeditionId: 'woodland' }] as const) {
      expect(choiceHint(choice), choice.kind).not.toMatch(MONEY);
    }
    expect(choiceHint({ kind: 'expedition', expeditionId: 'woodland' })).toMatch(/^Gathers loot and gold over the slot\./);
  });

  it('says gold in the credited placement of a tournament', () => {
    const summary = (money: number, renown: number): ActivitySummary => ({
      activityId: '00000000-0000-4000-8000-000000000001' as ActivitySummary['activityId'], resolvedKind: 'tournament', result: 'victory', success: true,
      rewards: { money, renown, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 }, receiptId: '00000000-0000-4000-9000-000000000001',
      settledAtMs: 1, replayExpiry: { state: 'expired' } });
    expect(creditedText(summary(100, 60))).toBe('+100 gold, +60 renown');
    expect(creditedText(summary(0, 7))).toBe('+7 renown');
    expect(creditedText(summary(0, 0))).toBe('nothing');
    for (const text of [creditedText(summary(100, 60)), creditedText(summary(5, 0))]) expect(text).not.toMatch(MONEY);
  });
});
