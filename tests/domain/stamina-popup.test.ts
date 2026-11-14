import { afterEach, describe, expect, it, vi } from 'vitest';
import { RULES_V2 } from '@domain/rules-v2';
import { restingNowPopup, restingNowText } from '../../src/features/schedule/stamina-text';
import { STAMINA_DISMISSED_KEY, dismissSlot, pruneDismissedSlots, readDismissedSlots, resetDismissalMemory } from '../../src/features/shell/stamina-dismissals';

// Patch 1.9 Task 29 addition (Avi, 2026-11-13: "it should also appear as the expedition pop up appear, and the user can dismiss it"): a
// pop-up while the RUNNING slot rests instead of its plan, once per slot, its dismissal (and the pre-slot notice's) kept across a reload.
const SLOT = 373_249;

describe('the rested-instead pop-up text', () => {
  it('names the planned activity, the reason and the numbers it knows', () => {
    expect(restingNowText({ name: 'Aster', planned: 'expedition', destination: 'Woodland Path', reason: 'stamina', had: 12, needed: 30 }, RULES_V2)).toEqual({
      heading: 'Stamina', text: 'Aster is resting instead of the Woodland Path expedition: not enough stamina (had 12, needed 30).' });
    expect(restingNowText({ name: 'Aster', planned: 'arena', destination: null, reason: 'stamina', had: 12, needed: 25 }, RULES_V2).text)
      .toBe('Aster is resting instead of the Arena: not enough stamina (had 12, needed 25).');
    expect(restingNowText({ name: 'Aster', planned: 'training', destination: null, reason: 'stamina', had: 5, needed: 20 }, RULES_V2).text)
      .toBe('Aster is resting instead of Training: not enough stamina (had 5, needed 20).');
    expect(restingNowText({ name: 'Aster', planned: 'dungeon', destination: 'Wolf Den', reason: 'stamina', had: null, needed: null }, RULES_V2).text)
      .toBe('Aster is resting instead of the Wolf Den dungeon: not enough stamina.');
    expect(restingNowText({ name: 'Aster', planned: 'expedition', destination: null, reason: 'stamina', had: 12, needed: null }, RULES_V2).text)
      .toBe('Aster is resting instead of an expedition: not enough stamina.');
  });

  it('says the Training limit under its own heading', () => {
    expect(restingNowText({ name: 'Aster', planned: 'training', destination: null, reason: 'limit', had: 100, needed: 20 }, RULES_V2)).toEqual({
      heading: 'Training limit', text: 'Aster is resting instead of Training: 2 Trainings a game day.' });
  });
});

describe('the pop-up shows once per slot', () => {
  const rested = { planned: 'expedition' as const, destination: 'Woodland Path', reason: 'stamina' as const };
  it('shows for the running slot until that slot is dismissed', () => {
    expect(restingNowPopup({ rested, name: 'Aster', slot: SLOT, had: 12, needed: 30, dismissed: new Set() }, RULES_V2))
      .toEqual({ slot: SLOT, heading: 'Stamina', text: 'Aster is resting instead of the Woodland Path expedition: not enough stamina (had 12, needed 30).' });
    expect(restingNowPopup({ rested, name: 'Aster', slot: SLOT, had: 12, needed: 30, dismissed: new Set([SLOT]) }, RULES_V2)).toBeNull();
    // A later slot that rests instead gets its own.
    expect(restingNowPopup({ rested, name: 'Aster', slot: SLOT + 3, had: 12, needed: 30, dismissed: new Set([SLOT]) }, RULES_V2)?.slot).toBe(SLOT + 3);
    expect(restingNowPopup({ rested: null, name: 'Aster', slot: SLOT, had: 12, needed: 30, dismissed: new Set() }, RULES_V2)).toBeNull();
  });
});

describe('dismissals kept across a reload', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetDismissalMemory(); });
  const memoryStorage = () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); } });
    return store;
  };

  it('stores each dismissed slot per gladiator and per notice', () => {
    const store = memoryStorage();
    dismissSlot('g1', 'next', SLOT);
    dismissSlot('g1', 'now', SLOT - 1);
    resetDismissalMemory(); // a reload: only what the device stored is left
    expect(readDismissedSlots('g1', 'next')).toEqual(new Set([SLOT]));
    expect(readDismissedSlots('g1', 'now')).toEqual(new Set([SLOT - 1]));
    expect(readDismissedSlots('g2', 'next')).toEqual(new Set());
    expect(JSON.parse(store.get(STAMINA_DISMISSED_KEY)!)).toEqual({ g1: { next: [SLOT], now: [SLOT - 1] } });
  });

  it('keeps only the newest slots', () => {
    memoryStorage();
    for (let n = 0; n < 30; n++) dismissSlot('g1', 'next', SLOT + n);
    const kept = readDismissedSlots('g1', 'next');
    expect(kept.size).toBe(20);
    expect(kept.has(SLOT + 29)).toBe(true);
    expect(kept.has(SLOT)).toBe(false);
  });

  it('prunes expired slots for every gladiator and preserves current and upcoming dismissals', () => {
    const store = memoryStorage();
    dismissSlot('g1', 'now', SLOT - 10);
    dismissSlot('g1', 'now', SLOT - 1);
    dismissSlot('g1', 'now', SLOT);
    dismissSlot('g1', 'next', SLOT + 1);
    dismissSlot('g2', 'now', SLOT - 20);
    dismissSlot('g3', 'next', SLOT + 1);
    pruneDismissedSlots(SLOT);
    expect(readDismissedSlots('g1', 'now')).toEqual(new Set([SLOT - 1, SLOT]));
    expect(readDismissedSlots('g2', 'now')).toEqual(new Set());
    expect(JSON.parse(store.get(STAMINA_DISMISSED_KEY)!)).toEqual({
      g1: { now: [SLOT - 1, SLOT], next: [SLOT + 1] }, g3: { next: [SLOT + 1] },
    });
  });

  it('works without storage: the page remembers for its own life', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(() => dismissSlot('g1', 'now', SLOT)).not.toThrow();
    expect(readDismissedSlots('g1', 'now')).toEqual(new Set([SLOT]));
    // Garbage in storage reads as nothing dismissed.
    vi.stubGlobal('localStorage', { getItem: () => '{"g1":"x"}', setItem: () => undefined });
    resetDismissalMemory();
    expect(readDismissedSlots('g1', 'now')).toEqual(new Set());
  });
});

describe('fix round 1', () => {
  it('says Preparing your next activity while the next slot is only queued (the boundary window)', async () => {
    const { activityStatus } = await import('../../src/features/character/activity-status');
    const SLOT_MS = 4_800_000, slot = 373_249, start = slot * SLOT_MS;
    const owner = { processedSlotIndex: slot - 1,
      currentActivity: { id: 'a', kind: 'rest' as const, status: 'queued' as const, startsAtMs: start, endsAtMs: start + SLOT_MS, label: 'Resting (not enough stamina)' } };
    expect(activityStatus(owner, slot, start + 60_000, { clock: '12' })).toEqual({ status: 'preparing', label: 'Preparing your next activity', endsAtMs: null });
  });

  it('keeps the rests within the results page, and the notice cutoff from the results only', async () => {
    const { notificationRows } = await import('../../src/features/messages/messages');
    const { notificationEntries } = await import('../../src/features/titles/title-notices');
    const result = (n: number) => ({ settledAtMs: 1000 - n * 10, id: `r${n}` });
    const rest = (at: number) => ({ settledAtMs: at, id: `rest${at}` });
    // A full page of 3 results (950..1000 every 10 ms down to 980): a rest older than the oldest result is left out, newer ones are merged in order.
    const full = [result(0), result(1), result(2)];
    expect(notificationRows(full, [rest(995), rest(975), rest(990)], 3).map(row => row.settledAtMs)).toEqual([1000, 995, 990, 990, 980]);
    // A page that is not full keeps every rest.
    expect(notificationRows([result(0)], [rest(1), rest(2)], 3).map(row => row.settledAtMs)).toEqual([1000, 2, 1]);
    // Many rests and few results: the list is not "full", so an older title notice still shows.
    const rows = notificationRows([result(0)], [rest(999), rest(998), rest(997), rest(996)], 3);
    const notice = { key: 'old', atMs: 5 } as unknown as Parameters<typeof notificationEntries>[1][number];
    expect(notificationEntries(rows, [notice], 3, [result(0)]).some(entry => entry.kind === 'notice')).toBe(true);
  });
});
