import { describe, expect, it } from 'vitest';
import type { Schedule } from '@contracts/commands';
import type { OwnerState } from '@contracts/reads';
import { RULES_V2 } from '@domain/rules-v2';
import { partVerdicts, type ActivityCosts } from '../../src/features/schedule/rest-stamina';
import {
  nextSlotNotice, restedNoteLines, restedResultText, runningRestLines, runningRestNotice, slotMark,
} from '../../src/features/schedule/stamina-text';
import { settledActivity } from '../../src/features/character/activity-status';

// Patch 1.9 Task 29: stamina notices and what really runs. Written apart from the code: a slot is 80 minutes from the epoch, and slot n is
// phase n mod 3 (0 morning, 1 afternoon, 2 evening); slot 373248 is a morning.
const SLOT = 4_800_000;
const MORNING_SLOT = 373_248, AFTERNOON_SLOT = MORNING_SLOT + 1, EVENING_SLOT = MORNING_SLOT + 2;
const morning = MORNING_SLOT * SLOT + 25 * 60_000;
const afternoon = AFTERNOON_SLOT * SLOT + 25 * 60_000;
const BASE: ActivityCosts = { training: 20, expedition: 30, arena: 25, tournament: 25, rest: 0 };
const day: Schedule = { morning: { kind: 'training' }, afternoon: { kind: 'expedition', expeditionId: 'woodland' }, evening: { kind: 'rest' } };
const trainingDay: Schedule = { morning: { kind: 'training' }, afternoon: { kind: 'training' }, evening: { kind: 'training' } };

type Owner = Pick<OwnerState, 'stamina' | 'currentActivity' | 'pendingBuild' | 'processedSlotIndex'>;
function owner(stamina: number, kind: 'training' | 'rest' | 'expedition' = 'training', slot = MORNING_SLOT): Owner {
  return { stamina: { current: stamina, maximum: 104 }, pendingBuild: null, processedSlotIndex: slot,
    currentActivity: { id: '9fce3cd5-e831-4a66-8ca1-16b4576b1499', kind, status: 'active', startsAtMs: slot * SLOT, endsAtMs: (slot + 1) * SLOT, label: 'Running' } };
}
const pendingAt = (state: Owner, effectiveSlotIndex: number): Owner => ({ ...state,
  pendingBuild: { build: {} as never, effectiveSlotIndex, reservedMoney: 0, reservedItemIds: [], operationId: 'pending-op' } });

describe('partVerdicts', () => {
  it('says each part runs, with the stamina after it', () => {
    // 74 now: the afternoon's expedition leaves 44, the evening's Rest refills to 104, the next morning's training leaves 84.
    expect(partVerdicts({ nowMs: morning, owner: owner(74), day, costs: BASE })).toEqual({
      afternoon: { kind: 'runs', after: 44 }, evening: { kind: 'runs', after: 104 }, morning: { kind: 'runs', after: 84 } });
  });

  it('says a part becomes a Rest for lack of stamina, with what it needs and what it will have', () => {
    expect(partVerdicts({ nowMs: morning, owner: owner(12), day, costs: BASE })).toEqual({
      afternoon: { kind: 'stamina', needs: 30, has: 12 }, evening: { kind: 'runs', after: 104 }, morning: { kind: 'runs', after: 84 } });
    // Exactly enough runs, down to nothing.
    expect(partVerdicts({ nowMs: morning, owner: owner(30), day, costs: BASE }).afternoon).toEqual({ kind: 'runs', after: 0 });
  });

  it('says a third Training of a game day becomes a Rest (v2 limit)', () => {
    // The morning's training runs now (one); the afternoon's is the second; the evening's is past the limit; the next morning starts a new day.
    expect(partVerdicts({ nowMs: morning, owner: owner(100), day: trainingDay, costs: BASE, rules: RULES_V2 })).toEqual({
      afternoon: { kind: 'runs', after: 80 }, evening: { kind: 'limit' }, morning: { kind: 'runs', after: 84 } });
    // v1 has no limit: the evening's training runs.
    expect(partVerdicts({ nowMs: morning, owner: owner(100), day: trainingDay, costs: BASE }).evening).toEqual({ kind: 'runs', after: 60 });
  });

  it('says nothing it cannot know', () => {
    const none = { morning: null, afternoon: null, evening: null };
    expect(partVerdicts({ nowMs: morning, owner: owner(74), day, costs: null })).toEqual(none);
    // The slot the clock is in is not processed yet, or the clock is behind the processed slot.
    expect(partVerdicts({ nowMs: morning, owner: { ...owner(74), processedSlotIndex: MORNING_SLOT - 1 }, day, costs: BASE })).toEqual(none);
    expect(partVerdicts({ nowMs: morning, owner: { ...owner(74), processedSlotIndex: MORNING_SLOT + 1 }, day, costs: BASE })).toEqual(none);
    // Resting at home.
    expect(partVerdicts({ nowMs: morning, owner: { ...owner(74), currentActivity: null }, day, costs: BASE })).toEqual(none);
    // A pending build from the evening: the afternoon is still known, the evening and the next morning are not.
    expect(partVerdicts({ nowMs: morning, owner: pendingAt(owner(74), EVENING_SLOT), day, costs: BASE })).toEqual({ afternoon: { kind: 'runs', after: 44 }, evening: null, morning: null });
    // The ways disagree: in the afternoon the morning may or may not have been a Training, so the evening's may be the second or the third.
    expect(partVerdicts({ nowMs: afternoon, owner: owner(100, 'training', AFTERNOON_SLOT), day: trainingDay, costs: BASE, rules: RULES_V2 }).evening).toBeNull();
    // A dungeon whose cost is not known (v1 costs have none).
    expect(partVerdicts({ nowMs: morning, owner: owner(74), day: { ...day, afternoon: { kind: 'dungeon', dungeonId: 'wolf-den' } }, costs: BASE }).afternoon).toBeNull();
  });
});

describe('the slot mark', () => {
  it('warns on a part that will not run, and quietly says the stamina after one that will', () => {
    expect(slotMark({ kind: 'stamina', needs: 30, has: 12 }, { kind: 'expedition', expeditionId: 'woodland' }, RULES_V2)).toEqual({ tone: 'warn',
      text: '⚠ Not enough stamina: your gladiator will rest instead', hint: 'Needs 30, will have 12. Add a Rest before it or pick a cheaper activity.' });
    expect(slotMark({ kind: 'limit' }, { kind: 'training' }, RULES_V2)).toEqual({ tone: 'warn',
      text: '⚠ Training limit: this becomes Rest (2 a game day)', hint: 'Pick another activity for this part, or leave it as a Rest.' });
    expect(slotMark({ kind: 'runs', after: 12 }, { kind: 'training' }, RULES_V2)).toEqual({ tone: 'quiet', text: 'Stamina after: 12', hint: null });
  });

  it('adds nothing to a Rest (its own line says what it gives) or to a part it cannot know', () => {
    expect(slotMark({ kind: 'runs', after: 104 }, { kind: 'rest' }, RULES_V2)).toBeNull();
    expect(slotMark(null, { kind: 'training' }, RULES_V2)).toBeNull();
  });
});

describe('the notice', () => {
  const verdicts = { afternoon: { kind: 'stamina', needs: 30, has: 12 }, evening: { kind: 'runs', after: 104 }, morning: null } as const;
  it("names the next slot's activity, when it starts and that the gladiator will rest instead", () => {
    expect(nextSlotNotice({ verdicts, day, nowMs: morning, dismissed: new Set() })).toEqual({ slot: AFTERNOON_SLOT,
      text: 'Not enough stamina for your next Expedition (starts in 55 min). Your gladiator will rest instead.' });
    const limit = nextSlotNotice({ verdicts: { ...verdicts, afternoon: { kind: 'limit' } }, day: trainingDay, nowMs: morning, dismissed: new Set(), rules: RULES_V2 });
    expect(limit?.text).toBe('Training limit reached: your next Training (starts in 55 min) will be a Rest (2 a game day).');
  });

  it('shows once per slot: a dismissal lasts for that slot, and the next slot that will not run gets its own', () => {
    expect(nextSlotNotice({ verdicts, day, nowMs: morning, dismissed: new Set([AFTERNOON_SLOT]) })).toBeNull();
    // An hour and twenty minutes on, the next slot is the evening: the afternoon's dismissal does not hide it.
    const evening = nextSlotNotice({ verdicts: { ...verdicts, evening: { kind: 'stamina', needs: 25, has: 4 } }, day: { ...day, evening: { kind: 'arena' } },
      nowMs: afternoon, dismissed: new Set([AFTERNOON_SLOT]) });
    expect(evening).toEqual({ slot: EVENING_SLOT, text: 'Not enough stamina for your next Arena (starts in 55 min). Your gladiator will rest instead.' });
  });

  it('shows nothing when the next slot runs or cannot be known', () => {
    expect(nextSlotNotice({ verdicts: { ...verdicts, afternoon: { kind: 'runs', after: 44 } }, day, nowMs: morning, dismissed: new Set() })).toBeNull();
    expect(nextSlotNotice({ verdicts: { ...verdicts, afternoon: null }, day, nowMs: morning, dismissed: new Set() })).toBeNull();
  });
});

describe('what really runs, and afterwards', () => {
  it('says the running part rests instead, and what was planned', () => {
    expect(runningRestLines({ planned: 'expedition', destination: 'Woodland Path', reason: 'stamina', had: 12, needed: 30 }, RULES_V2)).toEqual({
      what: 'Resting', instead: 'instead of Expedition: not enough stamina', planned: 'Planned: Expedition · Woodland Path (had 12, needed 30)' });
    expect(runningRestLines({ planned: 'training', destination: null, reason: 'limit', had: null, needed: null }, RULES_V2)).toEqual({
      what: 'Resting', instead: 'instead of Training: Training limit: 2 a game day', planned: 'Planned: Training' });
    // Numbers it cannot tell are left out.
    expect(runningRestLines({ planned: 'arena', destination: null, reason: 'stamina', had: 12, needed: null }, RULES_V2).planned).toBe('Planned: Arena');
  });

  it('says so in the note above the cards', () => {
    expect(runningRestNotice({ phase: 'afternoon', planned: 'expedition', reason: 'stamina', ends: '4:20 AM', next: 'tomorrow 1:20 AM' }, RULES_V2))
      .toBe('Afternoon is resting now instead of an Expedition (not enough stamina). It ends 4:20 AM. A change to the afternoon starts with the next afternoon, tomorrow 1:20 AM.');
    expect(runningRestNotice({ phase: 'evening', planned: 'training', reason: 'limit', ends: '', next: '' }, RULES_V2))
      .toBe('Evening is resting now instead of Training (Training limit: 2 a game day). A change to the evening starts with the next evening.');
  });

  it("writes the owner's notification of a rest that replaced a planned activity", () => {
    expect(restedNoteLines({ planned: 'expedition', destination: 'Ruined Outpost', reason: 'stamina' }, 'Aster', RULES_V2))
      .toEqual({ title: 'Aster rested instead of the Ruined Outpost expedition', lines: ['Not enough stamina'] });
    expect(restedNoteLines({ planned: 'training', destination: null, reason: 'limit' }, 'Aster', RULES_V2))
      .toEqual({ title: 'Aster rested instead of Training', lines: ['Training limit: 2 a game day'] });
    expect(restedNoteLines({ planned: 'arena', destination: null, reason: 'stamina' }, null, RULES_V2).title).toBe('Your gladiator rested instead of Arena');
  });

  it("writes the owner's own Results line", () => {
    expect(restedResultText('Aster', { planned: 'expedition', reason: 'stamina' }, RULES_V2)).toBe('Aster rested instead of Expedition: not enough stamina');
    expect(restedResultText('Aster', { planned: 'training', reason: 'limit' }, RULES_V2)).toBe('Aster rested instead of Training: Training limit, 2 a game day');
  });
});

describe('the settled activity (A3: the boundary window)', () => {
  const at = (status: 'queued' | 'active', slot: number, processed: number) => ({ processedSlotIndex: processed,
    currentActivity: { id: 'a', kind: 'rest' as const, status, startsAtMs: slot * SLOT, endsAtMs: (slot + 1) * SLOT, label: 'Resting (not enough stamina)' } });
  it('is the current activity once the server has processed its slot', () => {
    expect(settledActivity(at('active', AFTERNOON_SLOT, AFTERNOON_SLOT))?.id).toBe('a');
  });
  it('is none while its slot is not processed yet (the next slot prepared before the world is published)', () => {
    expect(settledActivity(at('queued', AFTERNOON_SLOT, AFTERNOON_SLOT))).toBeNull();
    expect(settledActivity({ currentActivity: null })).toBeNull();
  });
});

describe('the expedition view after a defeat', () => {
  it('says the gladiator is on an expedition, resting at the safe return point', async () => {
    const { phaseText } = await import('../../src/features/character/ExpeditionView');
    const state = { phase: 'safe-return', stages: [{ encounter: 1, outcome: 'victory' }, { encounter: 2, outcome: 'defeat' }] } as unknown as Parameters<typeof phaseText>[0];
    expect(phaseText(state, 'Ruined Outpost')).toEqual({ title: 'Returning without rewards', status: 'On an expedition · resting at the safe return point after a defeat',
      detail: 'Defeated in the second encounter. Resting at the safe return point until the slot ends, with all gear kept.' });
    expect(phaseText({ ...state, phase: 'returning' } as typeof state, 'Ruined Outpost').status).toBeUndefined();
  });
});
