import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityChoice, DayScheduleValue, Phase, Schedule } from '@contracts/commands';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { RULES_V1 } from '@domain/rules-v1';
import { RULES_V2 } from '@domain/rules-v2';
import type { Rules } from '@domain/types';
import { arenaNote, choiceHint, choiceKey, choiceLabel, choiceOf, choicesFor, dungeonNote, lockedChoices, optionLabel, runningNotice, runningPart, savedSummary, tournamentEntryText } from '../../src/features/schedule/schedule-text';
import { trainingRoom } from '../../src/features/schedule/training-cap';

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
      expect(key(lockedChoices('evening', player)), `level ${player}`).toEqual(shut);
    }
    expect(lockedChoices('afternoon', RULES_V1.attributes.maximumLevel)).toEqual([]);
  });

  it('reads the Arena parts from the rules it is given, defaulting to v1', () => {
    const wider = { ...RULES_V1, schedule: { arenaPhases: ['afternoon', 'evening'] } } as unknown as Rules;
    expect(key(choicesFor('afternoon', 1, wider))).toContain('arena');
    expect(key(choicesFor('morning', 1, wider))).not.toContain('arena');
  });

  it('opens Wolf Den and Raider Stronghold in the v2 afternoon at level 7', () => {
    expect(choicesFor('afternoon', 7, RULES_V2).filter(choice => choice.kind === 'dungeon')).toEqual([
      { kind: 'dungeon', dungeonId: 'wolf-den' },
      { kind: 'dungeon', dungeonId: 'raider-stronghold' },
    ]);
  });

  it('lists Troll Hall as locked in the v2 afternoon at level 7', () => {
    expect(lockedChoices('afternoon', 7, RULES_V2).filter(choice => choice.kind === 'dungeon')).toEqual([
      { kind: 'dungeon', dungeonId: 'troll-hall' },
    ]);
  });

  it('keeps dungeons out of other v2 phases and all v1 phases, including locked options', () => {
    for (const [rules, phases] of [[RULES_V1, PHASE_OF], [RULES_V2, ['morning', 'evening']]] as const) {
      for (const phase of phases) {
        expect(choicesFor(phase, 20, rules).map(choice => choice.kind)).not.toContain('dungeon');
        expect(lockedChoices(phase, 1, rules).map(choice => choice.kind)).not.toContain('dungeon');
      }
    }
  });
});

describe('schedule option values', () => {
  it.each([
    ['dungeon:wolf-den', { kind: 'dungeon', dungeonId: 'wolf-den' }],
    ['dungeon:raider-stronghold', { kind: 'dungeon', dungeonId: 'raider-stronghold' }],
    ['dungeon:troll-hall', { kind: 'dungeon', dungeonId: 'troll-hall' }],
    ['expedition:woodland', WOODLAND],
    ['training', TRAINING],
  ] as const)('round-trips %s without losing the saved choice', (value, choice) => {
    expect(choiceKey(choice)).toBe(value);
    expect(choiceOf(value)).toEqual(choice);
  });
});

describe('dungeonNote', () => {
  it('says when dungeons run in the other v2 phases and omits the note under v1', () => {
    expect(dungeonNote('morning', RULES_V2)).toBe('Dungeons run in the afternoon only.');
    expect(dungeonNote('evening', RULES_V2)).toBe('Dungeons run in the afternoon only.');
    expect(dungeonNote('afternoon', RULES_V2)).toBeNull();
    for (const phase of PHASE_OF) expect(dungeonNote(phase, RULES_V1)).toBeNull();
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

  it('names each dungeon and its required level in the option', () => {
    expect(optionLabel({ kind: 'dungeon', dungeonId: 'wolf-den' })).toBe('Dungeon: Wolf Den · Level 3');
    expect(optionLabel({ kind: 'dungeon', dungeonId: 'raider-stronghold' })).toBe('Dungeon: Raider Stronghold · Level 7');
    expect(optionLabel({ kind: 'dungeon', dungeonId: 'troll-hall' })).toBe('Dungeon: Troll Hall · Level 12');
  });
});

describe('choiceHint', () => {
  it('describes the v2 dungeon party and its base stamina cost', () => {
    const wolf = { kind: 'dungeon', dungeonId: 'wolf-den' } as const;
    const description = '3 rooms, then the boss. Players group first. Eligible bots and hired fighters fill open seats.';
    expect(choiceHint(wolf, '12', RULES_V2)).toBe(`${description} Costs 40 base stamina.`);
    const dearer = { ...RULES_V2, activityStamina: { ...RULES_V2.activityStamina, dungeon: 42 } };
    expect(choiceHint(wolf, '12', dearer)).toBe(`${description} Costs 42 base stamina.`);
  });

  it('carries each activity\'s stamina cost from the rules (training, expedition, Arena)', () => {
    expect(RULES_V1.activityStamina).toMatchObject({ training: 20, expedition: 30, arena: 25, rest: 0 });
    expect(choiceHint(TRAINING, '12')).toContain(`Costs ${RULES_V1.activityStamina.training} stamina.`);
    for (const expeditionId of ['woodland', 'outpost', 'mountain'] as const) {
      expect(choiceHint({ kind: 'expedition', expeditionId }, '12')).toContain(`Costs ${RULES_V1.activityStamina.expedition} stamina.`);
    }
    expect(choiceHint(ARENA, '12')).toContain(`Costs ${RULES_V1.activityStamina.arena} stamina.`);
  });

  it('says Rest costs nothing, and gives every activity its own words', () => {
    expect(RULES_V1.activityStamina.rest).toBe(0);
    expect(choiceHint(REST, '12')).toBe('Recovers stamina. Costs nothing.');
    expect(new Set([TRAINING, REST, ARENA, WOODLAND].map(c => choiceHint(c, '12'))).size).toBe(4);
  });

  it('describes the Arena bout and the tournament from the rules', () => {
    expect(choiceHint(ARENA, '24')).toBe('Bout revealed at minute 60, rewards at 80. Wed and Sat 18:40 UTC: the tournament. Costs 25 stamina.');
    // The fixed tournament hour follows the clock setting (Patch A, item 7).
    expect(choiceHint(ARENA, '12')).toBe('Bout revealed at minute 60, rewards at 80. Wed and Sat 6:40\xA0PM UTC: the tournament. Costs 25 stamina.');
    expect(choiceHint({ kind: 'arena' }, '12')).toContain('Wed and Sat 6:40\xA0PM UTC: the tournament.');
    // Only the Arena hint names a time: the others read the same in either mode.
    for (const choice of [TRAINING, REST, WOODLAND]) expect(choiceHint(choice, '24')).toBe(choiceHint(choice, '12'));
  });

  it('follows the rules it is given rather than fixed numbers', () => {
    const changed = { ...RULES_V1, activityStamina: { ...RULES_V1.activityStamina, training: 7, expedition: 8, arena: 9, rest: 3 },
      arena: { ...RULES_V1.arena, revealAfterMs: 1_800_000 }, clock: { ...RULES_V1.clock, slotMs: 3_600_000 },
      tournament: { ...RULES_V1.tournament, utcWeekdays: [1, 5], hourUtc: 9, minuteUtc: 5 } } as unknown as Rules;
    expect(choiceHint(TRAINING, '12', changed)).toContain('Costs 7 stamina.');
    expect(choiceHint(WOODLAND, '12', changed)).toContain('Costs 8 stamina.');
    expect(choiceHint(REST, '12', changed)).toBe('Recovers stamina. Costs 3 stamina.');
    expect(choiceHint(ARENA, '24', changed)).toBe('Bout revealed at minute 30, rewards at 60. Mon and Fri 09:05 UTC: the tournament. Costs 9 stamina.');
    expect(choiceHint(ARENA, '12', changed)).toBe('Bout revealed at minute 30, rewards at 60. Mon and Fri 9:05\xA0AM UTC: the tournament. Costs 9 stamina.');
  });
});

// Patch 1.6 (spec "The Training line" and "Tournament entry stamina"): under the active rules v2 the Training choice says how far the
// point cap lets Training go, and Arena says that tournament entry is free while regular Arena still costs its stamina.
describe('choiceHint under the active rules', () => {
  const ENTRY = 'Tournament entry costs 0 stamina. Choose Arena and opt in before the cutoff; a bracket needs at least two entrants in your league. '
    + 'If no bracket forms, regular Arena still costs 25 stamina and needs enough stamina.';
  it("says the Training line of the owner's room under v2, and the old line under v1", () => {
    const room = (level: number, earned: number) => trainingRoom({ level, earnedAttributePoints: earned }, RULES_V2);
    expect(choiceHint(TRAINING, '12', RULES_V2, room(1, 10))).toBe('Practice yard: +1 attribute point, up to 14 at level 1 (you have 10). When Training runs, it costs 20 stamina.');
    expect(choiceHint(TRAINING, '24', RULES_V2, room(1, 94))).toBe('Training is full: 94 points, and level 1 allows 14. It gives nothing until level 22. When Training runs, it costs 20 stamina.');
    // No room (v1 has no cap, or the owner's numbers could not be read): the line a v1 Schedule has always shown.
    expect(choiceHint(TRAINING, '12', RULES_V1)).toBe('Practice yard: builds experience. Costs 20 stamina.');
    expect(choiceHint(TRAINING, '12', RULES_V1, trainingRoom({ level: 1, earnedAttributePoints: 10 }, RULES_V1))).toBe('Practice yard: builds experience. Costs 20 stamina.');
    expect(choiceHint(TRAINING, '12', RULES_V2, null)).toBe('Practice yard: builds experience. Costs 20 stamina.');
  });

  it('says tournament entry is free under v2, and keeps the v1 Arena line', () => {
    expect(tournamentEntryText(RULES_V2)).toBe(ENTRY);
    expect(tournamentEntryText(RULES_V1)).toBeNull();
    expect(choiceHint(ARENA, '24', RULES_V2)).toBe(`Bout revealed at minute 60, rewards at 80. Costs 25 stamina. Wed and Sat 18:40 UTC: the tournament. ${ENTRY}`);
    expect(choiceHint(ARENA, '12', RULES_V2)).toBe(`Bout revealed at minute 60, rewards at 80. Costs 25 stamina. Wed and Sat 6:40 PM UTC: the tournament. ${ENTRY}`);
    expect(choiceHint(ARENA, '24', RULES_V1)).toBe('Bout revealed at minute 60, rewards at 80. Wed and Sat 18:40 UTC: the tournament. Costs 25 stamina.');
    // The other choices read the same under both versions.
    for (const choice of [REST, WOODLAND]) expect(choiceHint(choice, '12', RULES_V2)).toBe(choiceHint(choice, '12', RULES_V1));
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
    expect(plain(runningNotice({ phase: 'afternoon', endsAtMs: Date.UTC(2026, 6, 15, 2, 40) }, AFTERNOON_NEXT, NOW, '12')))
      .toBe('Afternoon is running now (ends 10:40 PM). A change to the afternoon starts with the next afternoon, tomorrow 1:20 AM.');
  });

  it('puts "at" before a time of the same day, and leaves out a time that cannot be shown', () => {
    const early = Date.UTC(2026, 6, 14, 20, 0); // 4:00 PM, a slot start
    expect(plain(runningNotice({ phase: 'morning', endsAtMs: early + SLOT }, early + 3 * SLOT, early, '12')))
      .toBe('Morning is running now (ends 5:20 PM). A change to the morning starts with the next morning, at 8:00 PM.');
    expect(runningNotice({ phase: 'evening', endsAtMs: NaN }, NaN, NOW, '12')).toBe('Evening is running now. A change to the evening starts with the next evening.');
  });

  it('writes its times in the 24-hour form when asked, "at" before a time of the same day included', () => {
    expect(runningNotice({ phase: 'afternoon', endsAtMs: Date.UTC(2026, 6, 15, 2, 40) }, AFTERNOON_NEXT, NOW, '24'))
      .toBe('Afternoon is running now (ends 22:40). A change to the afternoon starts with the next afternoon, tomorrow 01:20.');
    const early = Date.UTC(2026, 6, 14, 20, 0);
    expect(runningNotice({ phase: 'morning', endsAtMs: early + SLOT }, early + 3 * SLOT, early, '24'))
      .toBe('Morning is running now (ends 17:20). A change to the morning starts with the next morning, at 20:00.');
  });
});

describe('savedSummary', () => {
  it('names a changed part with its activity and start time, and no part that did not change', () => {
    const value: DayScheduleValue = { version: 2, receivedAtMs: NOW, parts: { morning: part(MORNING_NEXT), afternoon: null, evening: null } };
    expect(plain(savedSummary(value, DAY, NOW, '12'))).toBe('Saved. Morning: Training from tomorrow 12:00 AM.');
  });

  it('says "after the running <part>" for a changed part that is running now', () => {
    const value: DayScheduleValue = { version: 2, receivedAtMs: NOW, parts: { morning: null, afternoon: part(AFTERNOON_NEXT), evening: null } };
    expect(plain(savedSummary(value, DAY, NOW, '12'))).toBe('Saved. Afternoon: Expedition: Woodland Path from tomorrow 1:20 AM, after the running afternoon.');
  });

  it('writes the start times in the 24-hour form when asked', () => {
    const value: DayScheduleValue = { version: 2, receivedAtMs: NOW, parts: { morning: part(MORNING_NEXT), afternoon: part(AFTERNOON_NEXT), evening: part(EVENING_NEXT) } };
    expect(savedSummary(value, DAY, NOW, '24')).toBe('Saved. Morning: Training from tomorrow 00:00. '
      + 'Afternoon: Expedition: Woodland Path from tomorrow 01:20, after the running afternoon. Evening: Arena from 22:40.');
  });

  it('names every changed part in day order, and only the running one gets the "after" words', () => {
    const value: DayScheduleValue = { version: 2, receivedAtMs: NOW, parts: { morning: part(MORNING_NEXT), afternoon: part(AFTERNOON_NEXT), evening: part(EVENING_NEXT) } };
    expect(plain(savedSummary(value, DAY, NOW, '12'))).toBe('Saved. Morning: Training from tomorrow 12:00 AM. '
      + 'Afternoon: Expedition: Woodland Path from tomorrow 1:20 AM, after the running afternoon. Evening: Arena from 10:40 PM.');
  });

  it('judges the running part by the time the server received the save, not by the clock now', () => {
    const value: DayScheduleValue = { version: 2, receivedAtMs: NOW, parts: { morning: null, afternoon: part(AFTERNOON_NEXT), evening: null } };
    // The afternoon has ended by the time the line is read: it was running when saved, and the line says so still.
    const later = Date.UTC(2026, 6, 15, 3, 0);
    expect(plain(savedSummary(value, DAY, later, '12'))).toContain(', after the running afternoon.');
    // Saved during the morning, read during the afternoon: not "running" in the line.
    const saved: DayScheduleValue = { ...value, receivedAtMs: Date.UTC(2026, 6, 15, 0, 30) };
    expect(plain(savedSummary(saved, DAY, NOW, '12'))).not.toContain('running');
  });

  it('leaves out the start time it cannot show, and says only "Saved." when nothing changed', () => {
    const noTime: DayScheduleValue = { version: 2, receivedAtMs: NOW, parts: { morning: { effectiveSlotIndex: 0, effectiveAtMs: NaN }, afternoon: null, evening: null } };
    expect(savedSummary(noTime, DAY, NOW, '12')).toBe('Saved. Morning: Training.');
    const none: DayScheduleValue = { version: 2, receivedAtMs: NOW, parts: { morning: null, afternoon: null, evening: null } };
    expect(savedSummary(none, DAY, NOW, '12')).toBe('Saved.');
  });

  it('is a plain sentence that names parts as the phase words', () => {
    for (const phase of ['morning', 'afternoon', 'evening'] as Phase[]) {
      const value: DayScheduleValue = { version: 2, receivedAtMs: NOW, parts: { morning: null, afternoon: null, evening: null, [phase]: part(AFTERNOON_NEXT) } };
      expect(savedSummary(value, DAY, NOW, '12')).toMatch(new RegExp(`^Saved\\. ${phase[0].toUpperCase()}${phase.slice(1)}: `));
    }
  });
});
