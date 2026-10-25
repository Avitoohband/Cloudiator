import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityChoice, DayScheduleValue, Phase, Schedule } from '@contracts/commands';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { RULES_V1 } from '@domain/rules-v1';
import type { Rules } from '@domain/types';
import { arenaNote, choiceHint, choiceLabel, choicesFor, lockedChoices, optionLabel, runningNotice, runningPart, savedSummary } from '../../src/features/schedule/schedule-text';

// Launch feedback (2026-10-25): the schedule screen's words. The zone is pinned to New York and the locale to en-US, as
// slot-time.test.ts does, so no assertion depends on the host; July 2026 is far from any daylight-saving change.
const RealFormat = Intl.DateTimeFormat;
const zone = process.env.TZ;
process.env.TZ = 'America/New_York';
beforeAll(() => { expect(new Date(2026, 6, 14, 4, 20).getTimezoneOffset()).toBe(240); });
afterAll(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
beforeEach(() => {
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (this: unknown, locale?: string | string[], options?: Intl.DateTimeFormatOptions) {
    return new RealFormat(locale ?? 'en-US', options);
  } as unknown as typeof Intl.DateTimeFormat);
});
afterEach(() => { vi.restoreAllMocks(); });

/** Written apart from the code: a slot is 80 minutes from the epoch, and slot n is phase n mod 3. */
const SLOT = 4_800_000;
const PHASE_OF = ['morning', 'afternoon', 'evening'] as const;
const slotOf = (ms: number) => Math.floor(ms / SLOT);
const plain = (text: string) => text.replaceAll('\xA0', ' ');
const TRAINING: ActivityChoice = { kind: 'training' }, REST: ActivityChoice = { kind: 'rest' }, ARENA: ActivityChoice = { kind: 'arena' };
const WOODLAND: ActivityChoice = { kind: 'expedition', expeditionId: 'woodland' };
const key = (choices: ActivityChoice[]) => choices.map(c => c.kind === 'expedition' ? `expedition:${c.expeditionId}` : c.kind);

describe('choicesFor', () => {
  it('omits Arena in the morning and the afternoon and lists it in the evening', () => {
    expect(key(choicesFor('morning', 10))).not.toContain('arena');
    expect(key(choicesFor('afternoon', 10))).not.toContain('arena');
    expect(key(choicesFor('evening', 10))).toContain('arena');
  });

  it('lists training, rest and the unlocked expeditions in the same order in every part, with Arena third in the evening', () => {
    expect(key(choicesFor('morning', 10))).toEqual(['training', 'rest', 'expedition:woodland', 'expedition:outpost', 'expedition:mountain']);
    expect(key(choicesFor('afternoon', 10))).toEqual(['training', 'rest', 'expedition:woodland', 'expedition:outpost', 'expedition:mountain']);
    expect(key(choicesFor('evening', 10))).toEqual(['training', 'rest', 'arena', 'expedition:woodland', 'expedition:outpost', 'expedition:mountain']);
  });

  it('opens an expedition from its required level, and lockedChoices lists the ones still shut', () => {
    const level = (id: 'woodland' | 'outpost' | 'mountain') => CATALOG_V1.expeditions[id].requiredLevel;
    for (const player of [1, level('outpost') - 1, level('outpost'), level('mountain') - 1, level('mountain')]) {
      const open = Object.values(CATALOG_V1.expeditions).filter(e => e.requiredLevel <= player).map(e => `expedition:${e.id}`);
      const shut = Object.values(CATALOG_V1.expeditions).filter(e => e.requiredLevel > player).map(e => `expedition:${e.id}`);
      expect(key(choicesFor('evening', player)).filter(k => k.startsWith('expedition:')), `level ${player}`).toEqual(open);
      expect(key(lockedChoices(player)), `level ${player}`).toEqual(shut);
    }
    expect(lockedChoices(RULES_V1.attributes.maximumLevel)).toEqual([]);
  });

  it('reads the Arena parts from the rules it is given, defaulting to v1', () => {
    const wider = { ...RULES_V1, schedule: { arenaPhases: ['afternoon', 'evening'] } } as unknown as Rules;
    expect(key(choicesFor('afternoon', 1, wider))).toContain('arena');
    expect(key(choicesFor('morning', 1, wider))).not.toContain('arena');
  });
});

describe('arenaNote', () => {
  it('tells the morning and the afternoon that Arena runs in the evening only, and the evening nothing', () => {
    expect(arenaNote('morning')).toBe('Arena runs in the evening only.');
    expect(arenaNote('afternoon')).toBe('Arena runs in the evening only.');
    expect(arenaNote('evening')).toBeNull();
  });

  it('names the parts from the rules it is given', () => {
    const wider = { ...RULES_V1, schedule: { arenaPhases: ['afternoon', 'evening'] } } as unknown as Rules;
    expect(arenaNote('morning', wider)).toBe('Arena runs in the afternoon and the evening only.');
    expect(arenaNote('afternoon', wider)).toBeNull();
  });
});

describe('choiceLabel', () => {
  it('names each choice, an expedition by its catalog name', () => {
    expect(choiceLabel(TRAINING)).toBe('Training');
    expect(choiceLabel(REST)).toBe('Rest');
    expect(choiceLabel(ARENA)).toBe('Arena');
    expect(choiceLabel(WOODLAND)).toBe(`Expedition: ${CATALOG_V1.expeditions.woodland.name}`);
    expect(choiceLabel({ kind: 'expedition', expeditionId: 'mountain' })).toBe(`Expedition: ${CATALOG_V1.expeditions.mountain.name}`);
  });

  it('adds the opening level to an expedition\'s option, and nothing to the other choices', () => {
    expect(optionLabel(TRAINING)).toBe('Training');
    expect(optionLabel(ARENA)).toBe('Arena');
    expect(optionLabel(WOODLAND)).toBe(`Expedition: ${CATALOG_V1.expeditions.woodland.name} · Level ${CATALOG_V1.expeditions.woodland.requiredLevel}`);
    expect(optionLabel({ kind: 'expedition', expeditionId: 'mountain' })).toBe(`Expedition: ${CATALOG_V1.expeditions.mountain.name} · Level ${CATALOG_V1.expeditions.mountain.requiredLevel}`);
  });
});

describe('choiceHint', () => {
  it('carries each activity\'s stamina cost from the rules (training, expedition, Arena)', () => {
    expect(RULES_V1.activityStamina).toMatchObject({ training: 20, expedition: 30, arena: 25, rest: 0 });
    expect(choiceHint(TRAINING)).toContain(`Costs ${RULES_V1.activityStamina.training} stamina.`);
    for (const expeditionId of ['woodland', 'outpost', 'mountain'] as const) {
      expect(choiceHint({ kind: 'expedition', expeditionId })).toContain(`Costs ${RULES_V1.activityStamina.expedition} stamina.`);
    }
    expect(choiceHint(ARENA)).toContain(`Costs ${RULES_V1.activityStamina.arena} stamina.`);
  });

  it('says Rest costs nothing, and gives every activity its own words', () => {
    expect(RULES_V1.activityStamina.rest).toBe(0);
    expect(choiceHint(REST)).toBe('Recovers stamina. Costs nothing.');
    expect(new Set([TRAINING, REST, ARENA, WOODLAND].map(c => choiceHint(c))).size).toBe(4);
  });

  it('describes the Arena bout and the tournament from the rules', () => {
    expect(choiceHint(ARENA)).toBe('Bout revealed at minute 60, rewards at 80. Wed and Sat 18:40 UTC: the tournament. Costs 25 stamina.');
  });

  it('follows the rules it is given rather than fixed numbers', () => {
    const changed = { ...RULES_V1, activityStamina: { ...RULES_V1.activityStamina, training: 7, expedition: 8, arena: 9, rest: 3 },
      arena: { ...RULES_V1.arena, revealAfterMs: 1_800_000 }, clock: { ...RULES_V1.clock, slotMs: 3_600_000 },
      tournament: { ...RULES_V1.tournament, utcWeekdays: [1, 5], hourUtc: 9, minuteUtc: 5 } } as unknown as Rules;
    expect(choiceHint(TRAINING, changed)).toContain('Costs 7 stamina.');
    expect(choiceHint(WOODLAND, changed)).toContain('Costs 8 stamina.');
    expect(choiceHint(REST, changed)).toBe('Recovers stamina. Costs 3 stamina.');
    expect(choiceHint(ARENA, changed)).toBe('Bout revealed at minute 30, rewards at 60. Mon and Fri 09:05 UTC: the tournament. Costs 9 stamina.');
  });
});

describe('runningPart', () => {
  it('names the part the clock is in and when it ends, for every part', () => {
    // Slots 0, 1, 2 of a day, 2026-07-15 (UTC midnight is a slot boundary: 18 slots a day).
    const midnight = Date.UTC(2026, 6, 15);
    expect(slotOf(midnight) % 3).toBe(0);
    for (let index = 0; index < 6; index++) {
      const start = midnight + index * SLOT;
      const expected = { phase: PHASE_OF[slotOf(start) % 3], endsAtMs: start + SLOT };
      expect(runningPart(start + 1234), `slot ${index}`).toEqual(expected);
    }
  });

  it('is inclusive at a slot\'s start and exclusive at its end', () => {
    const start = Date.UTC(2026, 6, 15, 1, 20);
    expect(PHASE_OF[slotOf(start) % 3]).toBe('afternoon');
    expect(runningPart(start)).toEqual({ phase: 'afternoon', endsAtMs: start + SLOT });
    expect(runningPart(start + SLOT - 1)).toEqual({ phase: 'afternoon', endsAtMs: start + SLOT });
    expect(runningPart(start + SLOT)).toEqual({ phase: 'evening', endsAtMs: start + 2 * SLOT });
    expect(runningPart(start - 1)).toEqual({ phase: 'morning', endsAtMs: start });
  });

  it('accepts the display clock\'s fractional milliseconds', () => {
    const start = Date.UTC(2026, 6, 15, 2, 40);
    expect(runningPart(start + 0.75)).toEqual({ phase: 'evening', endsAtMs: start + SLOT });
    expect(runningPart(start - 0.25)).toEqual({ phase: 'afternoon', endsAtMs: start });
  });
});

// 10:00 PM on 14 July in New York (02:00 UTC on the 15th): the afternoon (01:20-02:40 UTC) is running. The next morning starts at
// 04:00 UTC (midnight in New York), the next afternoon at 05:20 UTC (1:20 AM) and the next evening at 02:40 UTC (10:40 PM).
const NOW = Date.UTC(2026, 6, 15, 2, 0);
const MORNING_NEXT = Date.UTC(2026, 6, 15, 4, 0), AFTERNOON_NEXT = Date.UTC(2026, 6, 15, 5, 20), EVENING_NEXT = Date.UTC(2026, 6, 15, 2, 40);
const part = (effectiveAtMs: number) => ({ effectiveSlotIndex: slotOf(effectiveAtMs), effectiveAtMs });
const DAY: Schedule = { morning: TRAINING, afternoon: WOODLAND, evening: ARENA };

describe('runningNotice', () => {
  it('says the part is running, when it ends and that a change starts with its next occurrence', () => {
    expect(plain(runningNotice({ phase: 'afternoon', endsAtMs: Date.UTC(2026, 6, 15, 2, 40) }, AFTERNOON_NEXT, NOW)))
      .toBe('Afternoon is running now (ends 10:40 PM). A change to the afternoon starts with the next afternoon, tomorrow 1:20 AM.');
  });

  it('puts "at" before a time of the same day, and leaves out a time that cannot be shown', () => {
    const early = Date.UTC(2026, 6, 14, 20, 0); // 4:00 PM, a slot start
    expect(plain(runningNotice({ phase: 'morning', endsAtMs: early + SLOT }, early + 3 * SLOT, early)))
      .toBe('Morning is running now (ends 5:20 PM). A change to the morning starts with the next morning, at 8:00 PM.');
    expect(runningNotice({ phase: 'evening', endsAtMs: NaN }, NaN, NOW)).toBe('Evening is running now. A change to the evening starts with the next evening.');
  });
});

describe('savedSummary', () => {
  it('names a changed part with its activity and start time, and no part that did not change', () => {
    const value: DayScheduleValue = { version: 2, receivedAtMs: NOW, parts: { morning: part(MORNING_NEXT), afternoon: null, evening: null } };
    expect(plain(savedSummary(value, DAY, NOW))).toBe('Saved. Morning: Training from tomorrow 12:00 AM.');
  });

  it('says "after the running <part>" for a changed part that is running now', () => {
    const value: DayScheduleValue = { version: 2, receivedAtMs: NOW, parts: { morning: null, afternoon: part(AFTERNOON_NEXT), evening: null } };
    expect(plain(savedSummary(value, DAY, NOW))).toBe('Saved. Afternoon: Expedition: Woodland Path from tomorrow 1:20 AM, after the running afternoon.');
  });

  it('names every changed part in day order, and only the running one gets the "after" words', () => {
    const value: DayScheduleValue = { version: 2, receivedAtMs: NOW, parts: { morning: part(MORNING_NEXT), afternoon: part(AFTERNOON_NEXT), evening: part(EVENING_NEXT) } };
    expect(plain(savedSummary(value, DAY, NOW))).toBe('Saved. Morning: Training from tomorrow 12:00 AM. '
      + 'Afternoon: Expedition: Woodland Path from tomorrow 1:20 AM, after the running afternoon. Evening: Arena from 10:40 PM.');
  });

  it('judges the running part by the time the server received the save, not by the clock now', () => {
    const value: DayScheduleValue = { version: 2, receivedAtMs: NOW, parts: { morning: null, afternoon: part(AFTERNOON_NEXT), evening: null } };
    // The afternoon has ended by the time the line is read: it was running when saved, and the line says so still.
    const later = Date.UTC(2026, 6, 15, 3, 0);
    expect(plain(savedSummary(value, DAY, later))).toContain(', after the running afternoon.');
    // Saved during the morning, read during the afternoon: not "running" in the line.
    const saved: DayScheduleValue = { ...value, receivedAtMs: Date.UTC(2026, 6, 15, 0, 30) };
    expect(plain(savedSummary(saved, DAY, NOW))).not.toContain('running');
  });

  it('leaves out the start time it cannot show, and says only "Saved." when nothing changed', () => {
    const noTime: DayScheduleValue = { version: 2, receivedAtMs: NOW, parts: { morning: { effectiveSlotIndex: 0, effectiveAtMs: NaN }, afternoon: null, evening: null } };
    expect(savedSummary(noTime, DAY, NOW)).toBe('Saved. Morning: Training.');
    const none: DayScheduleValue = { version: 2, receivedAtMs: NOW, parts: { morning: null, afternoon: null, evening: null } };
    expect(savedSummary(none, DAY, NOW)).toBe('Saved.');
  });

  it('is a plain sentence that names parts as the phase words', () => {
    for (const phase of ['morning', 'afternoon', 'evening'] as Phase[]) {
      const value: DayScheduleValue = { version: 2, receivedAtMs: NOW, parts: { morning: null, afternoon: null, evening: null, [phase]: part(AFTERNOON_NEXT) } };
      expect(savedSummary(value, DAY, NOW)).toMatch(new RegExp(`^Saved\\. ${phase[0].toUpperCase()}${phase.slice(1)}: `));
    }
  });
});
