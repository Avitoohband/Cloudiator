import { describe, expect, it } from 'vitest';
import type { Schedule } from '@contracts/commands';
import type { ItemInstance, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { validateBuild } from '@domain/build';
import { RULES_V1 } from '@domain/rules-v1';
import { RULES_V2 } from '@domain/rules-v2';
import { activityCost, deriveStats } from '@domain/stats';
import { activityCosts, projectRest, restHint, restingGain, restingGainText, type ActivityCosts } from '../../src/features/schedule/rest-stamina';
import { itemFixture, ownerFixture } from '../fixtures/domain';

// Patch A item 6: what a Rest gives back. Written apart from the code: a slot is 80 minutes from the epoch, and slot n is phase
// n mod 3 (0 morning, 1 afternoon, 2 evening); slot 373248 is a morning.
const SLOT = 4_800_000;
const MORNING_SLOT = 373_248, AFTERNOON_SLOT = MORNING_SLOT + 1, EVENING_SLOT = MORNING_SLOT + 2;
const morning = MORNING_SLOT * SLOT + 25 * 60_000;
const evening = EVENING_SLOT * SLOT + 25 * 60_000;

const BASE: ActivityCosts = { training: 20, expedition: 30, arena: 25, tournament: 25, rest: 0 };
const day: Schedule = { morning: { kind: 'training' }, afternoon: { kind: 'expedition', expeditionId: 'woodland' }, evening: { kind: 'rest' } };

/** An owner at `stamina` (of 104) whose current activity is `kind`, in the slot `slot` (the one already paid and processed). */
function owner(stamina: number, kind: 'training' | 'rest' | 'expedition' = 'training', slot = MORNING_SLOT): Pick<OwnerState, 'stamina' | 'currentActivity' | 'pendingBuild' | 'processedSlotIndex'> {
  return { stamina: { current: stamina, maximum: 104 }, pendingBuild: null, processedSlotIndex: slot,
    currentActivity: { id: '9fce3cd5-e831-4a66-8ca1-16b4576b1499', kind, status: 'active', startsAtMs: slot * SLOT, endsAtMs: (slot + 1) * SLOT, label: 'Running' } };
}
const pendingAt = (effectiveSlotIndex: number): NonNullable<OwnerState['pendingBuild']> =>
  ({ build: ownerFixture.currentBuild, effectiveSlotIndex, reservedMoney: 0, reservedItemIds: [], operationId: 'pending-op' });

/** The shared owner wearing every heavy piece of the catalog's tier 1: 29 load against a capacity of 24.7 (10 + 2 × the guardian's 7.35 endurance). */
function overloadedOwner(): OwnerState {
  const worn = ['axe:1:common', 'round-shield:1:common', 'iron-helmet:1:common', 'heavy-armor:1:common', 'heavy-boots:1:common'].map(id => itemFixture(CATALOG_V1.items[id]));
  const [weapon, offHand, head, body, feet] = worn;
  return { ...structuredClone(ownerFixture), inventory: worn,
    currentBuild: { ...ownerFixture.currentBuild, equipment: { weapon: weapon.id, offHand: offHand.id, head: head.id, body: body.id, feet: feet.id } } };
}
const overloaded = overloadedOwner();
/** The owner's current build as the server's boundary validates it, apart from the code under test. */
function snapshotOf(state: OwnerState) {
  const build = state.currentBuild;
  const valid = validateBuild({ classId: build.classId, stance: build.stance, allocation: build.allocations, equipment: build.equipment },
    state.inventory, state.progression.earnedAttributePoints, state.progression.level);
  if (!valid.ok) throw new Error(`the fixture build is not valid: ${valid.reason}`);
  return valid.snapshot;
}

describe('the words', () => {
  it('says what a Rest gives, and that a full one adds nothing', () => {
    expect(restHint({ before: 74, maximum: 104 })).toBe('Refills stamina to full: +30 (74 → 104). Costs nothing.');
    expect(restHint({ before: 104, maximum: 104 })).toBe('Stamina will already be full (104): this rest adds nothing. Costs nothing.');
    expect(restHint(null)).toBe('Refills stamina to full. Costs nothing.');
    expect(restingGainText({ before: 74, maximum: 104 })).toBe('Stamina refills to 104 when it ends: +30');
    expect(restingGainText({ before: 104, maximum: 104 })).toBe('Stamina is already full (104): this rest adds nothing');
    expect(restingGainText(null)).toBe('Stamina refills to full when it ends.');
  });

  it('never says "+0" or a negative gain', () => {
    expect(restHint({ before: 103, maximum: 104 })).toBe('Refills stamina to full: +1 (103 → 104). Costs nothing.');
    // A stamina above its maximum cannot happen (the server caps it), and still reads as full rather than a negative gain.
    expect(restHint({ before: 110, maximum: 104 })).toBe('Stamina will already be full (104): this rest adds nothing. Costs nothing.');
    expect(restingGainText({ before: 110, maximum: 104 })).toBe('Stamina is already full (104): this rest adds nothing');
  });
});

describe('projectRest', () => {
  it('walks the parts before the Rest in time order', () => {   // now in a morning slot, training running and paid
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: owner(74, 'training'), day, costs: BASE })).toEqual({ before: 44, maximum: 104 });
  });

  it('walks the parts of the draft day, not of anything else', () => {
    // The afternoon's draft is another expedition and a training: 74 - 20 = 54 before the evening.
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: owner(74, 'training'), day: { ...day, afternoon: { kind: 'training' } }, costs: BASE })).toEqual({ before: 54, maximum: 104 });
    // A Rest before the Rest refills first: the evening one then adds nothing.
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: owner(74, 'training'), day: { ...day, afternoon: { kind: 'rest' } }, costs: BASE })).toEqual({ before: 104, maximum: 104 });
    // The afternoon Rest itself starts from what the running part left.
    expect(projectRest({ phase: 'afternoon', nowMs: morning, owner: owner(74, 'training'), day, costs: BASE })).toEqual({ before: 74, maximum: 104 });
  });

  it('charges Arena at its cost, a tournament at the same one', () => {
    // v1's tournament costs what Arena does (the projection charges Arena's cost for the evening, a tournament night included).
    expect(RULES_V1.activityStamina.tournament).toBe(RULES_V1.activityStamina.arena);
    // The running morning is paid; the afternoon's training takes 20 and the evening's Arena 25 before the next morning's Rest.
    const arenaDay: Schedule = { morning: { kind: 'rest' }, afternoon: { kind: 'training' }, evening: { kind: 'arena' } };
    expect(projectRest({ phase: 'morning', nowMs: morning, owner: owner(60, 'training'), day: arenaDay, costs: BASE })).toEqual({ before: 15, maximum: 104 });
  });

  it('charges an affordable part down to nothing, and turns the one that costs one more into a Rest', () => {
    // Exactly what is left is affordable (30 - 30 = 0), and the Rest after it gives the whole 104.
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: owner(30, 'training'), day: { ...day, afternoon: { kind: 'expedition', expeditionId: 'woodland' } }, costs: BASE })).toEqual({ before: 0, maximum: 104 });
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: owner(29, 'training'), day, costs: BASE })).toEqual({ before: 104, maximum: 104 });
  });

  it('projects a v2 evening Rest after the draft dungeon and its overload-adjusted cost', () => {
    const dungeonDay: Schedule = { ...day, afternoon: { kind: 'dungeon', dungeonId: 'wolf-den' } };
    const projection = { phase: 'evening', nowMs: morning, day: dungeonDay, rules: RULES_V2 } as const;
    expect(projectRest({ ...projection, owner: owner(46), costs: activityCosts(ownerFixture, RULES_V2) })).toEqual({ before: 6, maximum: 104 });
    // Overload raises the cost to 47. Exact stamina pays it, one less yields a Rest instead.
    const costs = activityCosts(overloaded, RULES_V2);
    expect(projectRest({ ...projection, owner: owner(47), costs })).toEqual({ before: 0, maximum: 104 });
    expect(projectRest({ ...projection, owner: owner(46), costs })).toEqual({ before: 104, maximum: 104 });
  });

  it('turns a part it cannot afford into a Rest', () => {
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: owner(20, 'training'), day, costs: BASE })).toEqual({ before: 104, maximum: 104 });
  });

  it('refills after a running Rest', () => {
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: owner(50, 'rest'), day, costs: BASE })).toEqual({ before: 74, maximum: 104 });
  });

  it('projects the next occurrence of the running part', () => {   // evening rest running; next evening after morning and afternoon
    expect(projectRest({ phase: 'evening', nowMs: evening, owner: owner(10, 'rest', EVENING_SLOT), day, costs: BASE })).toEqual({ before: 54, maximum: 104 });
    // The running part is not walked: a running training is already paid, and its next morning follows the afternoon (30) and the evening (25).
    expect(projectRest({ phase: 'morning', nowMs: morning, owner: owner(74, 'training'), day: { ...day, morning: { kind: 'rest' }, evening: { kind: 'arena' } }, costs: BASE })).toEqual({ before: 19, maximum: 104 });
  });

  it('starts from the slot the clock is in, wherever in it the clock is', () => {
    const first = MORNING_SLOT * SLOT, last = (MORNING_SLOT + 1) * SLOT - 1;
    for (const nowMs of [first, first + 0.5, last]) expect(projectRest({ phase: 'evening', nowMs, owner: owner(74, 'training'), day, costs: BASE }), String(nowMs)).toEqual({ before: 44, maximum: 104 });
    // In the afternoon the evening Rest follows the running part directly: nothing is walked, and the running part is already paid.
    expect(projectRest({ phase: 'evening', nowMs: AFTERNOON_SLOT * SLOT, owner: owner(74, 'expedition', AFTERNOON_SLOT), day, costs: BASE })).toEqual({ before: 74, maximum: 104 });
  });

  it('drops the number for a pending build at or before the Rest, and for unknown costs', () => {
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: { ...owner(74, 'training'), pendingBuild: pendingAt(EVENING_SLOT) }, day, costs: BASE })).toBeNull();
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: { ...owner(74, 'training'), pendingBuild: pendingAt(EVENING_SLOT + 1) }, day, costs: BASE })).not.toBeNull();
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: owner(74, 'training'), day, costs: null })).toBeNull();
  });

  it('drops the number for a pending build that takes effect before the Rest, even one that is already due', () => {
    // In the next slot (the afternoon, a part the walk charges at the new build's costs) and in the slot being read (already due).
    for (const effectiveSlotIndex of [AFTERNOON_SLOT, MORNING_SLOT, MORNING_SLOT - 5]) {
      expect(projectRest({ phase: 'evening', nowMs: morning, owner: { ...owner(74, 'training'), pendingBuild: pendingAt(effectiveSlotIndex) }, day, costs: BASE }), String(effectiveSlotIndex)).toBeNull();
    }
    // The Rest's own slot is what counts: the afternoon's is this slot + 1, and the next morning's is this slot + 3.
    const waiting = (index: number) => ({ ...owner(74, 'training'), pendingBuild: pendingAt(index) });
    expect(projectRest({ phase: 'afternoon', nowMs: morning, owner: waiting(AFTERNOON_SLOT), day, costs: BASE })).toBeNull();
    expect(projectRest({ phase: 'afternoon', nowMs: morning, owner: waiting(AFTERNOON_SLOT + 1), day, costs: BASE })).not.toBeNull();
    expect(projectRest({ phase: 'morning', nowMs: morning, owner: waiting(MORNING_SLOT + 3), day, costs: BASE })).toBeNull();
    expect(projectRest({ phase: 'morning', nowMs: morning, owner: waiting(MORNING_SLOT + 4), day, costs: BASE })).not.toBeNull();
  });

  it('gives no number for a time or a day it cannot read', () => {
    for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(projectRest({ phase: 'evening', nowMs, owner: owner(74, 'training'), day, costs: BASE }), String(nowMs)).toBeNull();
    }
  });
});

// The server debits a slot's activity (and refills a Rest) in one transaction at the boundary, and sets `processedSlotIndex` to that slot in
// it; the display clock moves to the slot at the cutoff, about one to two and a half minutes earlier. Until the owner read says the slot is
// processed, its stamina is not the running part's paid stamina, so no exact number is told (the same `behind` test as `activityStatus`).
describe('a slot the server has not processed yet', () => {
  const wait = (processedSlotIndex: number) => ({ ...owner(74, 'training'), processedSlotIndex });
  it('gives no number while the slot the clock is in is not processed, and the number once it is', () => {
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: wait(MORNING_SLOT - 1), day, costs: BASE })).toBeNull();
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: wait(MORNING_SLOT), day, costs: BASE })).toEqual({ before: 44, maximum: 104 });
    expect(restHint(projectRest({ phase: 'evening', nowMs: morning, owner: wait(MORNING_SLOT - 1), day, costs: BASE }))).toBe('Refills stamina to full. Costs nothing.');
  });
  it('is behind by any number of slots, and gives no number either when the server is ahead of the clock', () => {
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: wait(MORNING_SLOT - 40), day, costs: BASE })).toBeNull();
    // Patch 1.6 (spec "Rest projections"): a display clock that lags the server (held or not yet synced) would walk a slot the server has
    // already paid, whose debit the stamina read already holds: no number is told rather than charging it twice, under either version.
    for (const rules of [RULES_V1, RULES_V2]) {
      expect(projectRest({ phase: 'evening', nowMs: morning, owner: wait(MORNING_SLOT + 1), day, costs: BASE, rules }), rules.version).toBeNull();
      expect(projectRest({ phase: 'evening', nowMs: morning, owner: wait(MORNING_SLOT + 5), day, costs: BASE, rules }), rules.version).toBeNull();
    }
  });
  it('follows the clock into the next slot: the afternoon reads nothing until the owner read has caught up', () => {
    const afternoon = AFTERNOON_SLOT * SLOT + 25 * 60_000;
    expect(projectRest({ phase: 'evening', nowMs: afternoon, owner: owner(74, 'training', MORNING_SLOT), day, costs: BASE })).toBeNull();
    expect(projectRest({ phase: 'evening', nowMs: afternoon, owner: owner(44, 'expedition', AFTERNOON_SLOT), day, costs: BASE })).toEqual({ before: 44, maximum: 104 });
  });
  it('says nothing of the running Rest refill either', () => {
    // A running Rest refills at the boundary that ends it; before that boundary is processed the clock is already in the next slot.
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: { ...owner(50, 'rest', MORNING_SLOT - 1) }, day, costs: BASE })).toBeNull();
  });
});

// Patch 1.6 (spec "Rest projections"; plan Task 8): under v2 only two actual Training activities run per game day, and an excess Training
// request is an ordinary Rest (refills, costs nothing); a tournament evening's Arena may be a free bracket, a paid Arena or a Rest. The
// projection never takes the day's earlier Training from the edited draft (the parts already played are history the client does not
// read): where the number depends on what it cannot know, it gives none (`restHint(null)`'s generic words).
describe('projectRest under the rules v2', () => {
  const T = { kind: 'training' } as const, R = { kind: 'rest' } as const, A = { kind: 'arena' } as const, W = { kind: 'expedition', expeditionId: 'woodland' } as const;
  const afternoon = AFTERNOON_SLOT * SLOT + 25 * 60_000;
  const v2 = { costs: activityCosts(ownerFixture, RULES_V2)!, rules: RULES_V2 };
  /** An owner at `stamina` of `maximum` with an activity of `kind` running (resolved and paid) in slot `slot`. */
  const at = (stamina: number, kind: 'training' | 'rest' | 'expedition', slot: number, maximum = 104) =>
    ({ ...owner(stamina, kind, slot), stamina: { current: stamina, maximum } });

  it('cannot claim the old +60 after two actual earlier Trainings, whatever the edited elapsed parts say', () => {
    // The morning and the afternoon were Trainings (100 - 20 - 20 = 60, the afternoon one running now); the player now plans the morning
    // and the afternoon as Rests and the evening as Training. v1 walks the evening (60 - 20) and claims +60 for the next morning's Rest.
    const edited: Schedule = { morning: R, afternoon: R, evening: T };
    const now = at(60, 'training', AFTERNOON_SLOT, 100);
    expect(projectRest({ phase: 'morning', nowMs: afternoon, owner: now, day: edited, costs: BASE })).toEqual({ before: 40, maximum: 100 });
    // Under v2 the evening is a third Training (an ordinary Rest, refilling to 100) or a second one (60 - 20): the morning is history.
    expect(projectRest({ phase: 'morning', nowMs: afternoon, owner: now, day: edited, ...v2 })).toBeNull();
    expect(restHint(projectRest({ phase: 'morning', nowMs: afternoon, owner: now, day: edited, ...v2 }))).toBe('Refills stamina to full. Costs nothing.');
    // The draft's parts that are already played (the morning) or running (the afternoon) never stand for the day's actual Training.
    for (const playedAfternoon of [T, R, W]) {
      expect(projectRest({ phase: 'morning', nowMs: afternoon, owner: now, day: { ...edited, afternoon: playedAfternoon }, ...v2 }), playedAfternoon.kind).toBeNull();
    }
    // What the running afternoon actually is comes from the paid activity, not the draft: if it is not Training, the evening's is the
    // day's first or second whatever the morning was, and runs (a running Rest refills first: 100 - 20).
    expect(projectRest({ phase: 'morning', nowMs: afternoon, owner: at(60, 'expedition', AFTERNOON_SLOT, 100), day: edited, ...v2 })).toEqual({ before: 40, maximum: 100 });
    expect(projectRest({ phase: 'morning', nowMs: afternoon, owner: at(60, 'rest', AFTERNOON_SLOT, 100), day: edited, ...v2 })).toEqual({ before: 80, maximum: 100 });
  });

  it("keeps the number when the day's Training so far is known: the running part is the morning, read from the paid activity", () => {
    // The running morning Training is the day's first; the afternoon's is the second and runs (74 - 20), as in v1.
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: owner(74, 'training'), day: { morning: T, afternoon: T, evening: R }, ...v2 })).toEqual({ before: 54, maximum: 104 });
    // With a third Training in the evening, that one is an ordinary Rest and refills to full: the next morning's Rest adds nothing.
    const triple: Schedule = { morning: R, afternoon: T, evening: T };
    expect(projectRest({ phase: 'morning', nowMs: morning, owner: owner(74, 'training'), day: triple, ...v2 })).toEqual({ before: 104, maximum: 104 });
    expect(projectRest({ phase: 'morning', nowMs: morning, owner: owner(74, 'training'), day: triple, costs: BASE })).toEqual({ before: 34, maximum: 104 });
    // A running morning that is not Training leaves both later Trainings to run (74 - 20 - 20).
    expect(projectRest({ phase: 'morning', nowMs: morning, owner: owner(74, 'rest'), day: triple, ...v2 })).toEqual({ before: 64, maximum: 104 });
    expect(projectRest({ phase: 'morning', nowMs: morning, owner: owner(74, 'expedition'), day: triple, ...v2 })).toEqual({ before: 34, maximum: 104 });
  });

  it("gives no number when the running part's own activity is not known", () => {
    // The owner read's activity is another slot's: the running morning may or may not have been Training.
    const base = owner(74, 'training');
    const stale = { ...base, currentActivity: { ...base.currentActivity!, startsAtMs: (MORNING_SLOT - 3) * SLOT, endsAtMs: (MORNING_SLOT - 2) * SLOT } };
    expect(projectRest({ phase: 'morning', nowMs: morning, owner: stale, day: { morning: R, afternoon: T, evening: T }, ...v2 })).toBeNull();
    // A day it does not depend on keeps its number.
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: stale, day: { morning: T, afternoon: W, evening: R }, ...v2 })).toEqual({ before: 44, maximum: 104 });
  });

  it('starts the count again with a new game day', () => {
    // The evening Rest runs; the next morning and afternoon are the new day's first two Trainings (full 104 - 20 - 20).
    expect(projectRest({ phase: 'evening', nowMs: evening, owner: owner(10, 'rest', EVENING_SLOT), day: { morning: T, afternoon: T, evening: R }, ...v2 })).toEqual({ before: 64, maximum: 104 });
  });

  it('counts a Training at the point cap but not a Training that became a Rest for want of stamina', () => {
    // The running morning Training is the first; the afternoon's cannot be afforded (15 < 20) and rests instead, so it is not counted,
    // and the evening's is the second and runs: 104 - 20 before the next morning's Rest.
    const day2: Schedule = { morning: R, afternoon: T, evening: T };
    expect(projectRest({ phase: 'morning', nowMs: morning, owner: owner(15, 'training'), day: day2, ...v2 })).toEqual({ before: 84, maximum: 104 });
    // A Training gives no point at the cap but still runs and costs its stamina: the projection never reads the cap.
    const capped = { ...structuredClone(ownerFixture), progression: { ...ownerFixture.progression, earnedAttributePoints: 94 } };
    expect(activityCosts(capped, RULES_V2)).toEqual(v2.costs);
  });

  describe('a tournament evening', () => {
    // Written apart from the code: Unix-epoch slots with index mod 126 of 50 or 122 are the Saturday and Wednesday 18:40 UTC evenings.
    const TOURNAMENT = MORNING_SLOT + ((50 - (MORNING_SLOT % 126) + 126) % 126);
    const DAY_START = TOURNAMENT - 2;
    const dayMorning = DAY_START * SLOT + 25 * 60_000, dayAfternoon = (DAY_START + 1) * SLOT + 25 * 60_000;
    const arenaDay: Schedule = { morning: R, afternoon: W, evening: A };
    it('is an evening', () => { expect(TOURNAMENT % 3).toBe(2); });

    it('gives no number while the opted-in Arena may be a free bracket or a paid Arena', () => {
      const now = owner(74, 'training', DAY_START);
      // 74 - 30 for the afternoon's expedition; then the bracket is free (44) or regular Arena costs 25 (19).
      for (const tournamentOptIn of [true, undefined]) {
        expect(projectRest({ phase: 'morning', nowMs: dayMorning, owner: now, day: arenaDay, ...v2, tournamentOptIn }), String(tournamentOptIn)).toBeNull();
      }
      // Opted out, it is a regular Arena at its cost.
      expect(projectRest({ phase: 'morning', nowMs: dayMorning, owner: now, day: arenaDay, ...v2, tournamentOptIn: false })).toEqual({ before: 19, maximum: 104 });
      // v1's tournament costs what Arena does: the number stays.
      expect(projectRest({ phase: 'morning', nowMs: dayMorning, owner: now, day: arenaDay, costs: BASE, tournamentOptIn: true })).toEqual({ before: 19, maximum: 104 });
    });

    it('keeps the number when a Rest after the tournament evening refills either way, and on an evening with no tournament', () => {
      // The running afternoon; the evening may be free or paid, and the next morning's Rest refills either way: the next afternoon's Rest finds 104.
      expect(projectRest({ phase: 'afternoon', nowMs: dayAfternoon, owner: owner(74, 'expedition', DAY_START + 1), day: { morning: R, afternoon: R, evening: A }, ...v2, tournamentOptIn: true }))
        .toEqual({ before: 104, maximum: 104 });
      // The day before the tournament day has no tournament evening: Arena is regular.
      const before = (DAY_START - 3) * SLOT + 25 * 60_000;
      expect(projectRest({ phase: 'morning', nowMs: before, owner: owner(74, 'training', DAY_START - 3), day: arenaDay, ...v2, tournamentOptIn: true })).toEqual({ before: 19, maximum: 104 });
    });
  });

  it("gives no number while the gladiator rests at home (idle), whose slots are not the draft's", () => {
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: { ...owner(74, 'training'), restingUntilSlot: MORNING_SLOT + 1 }, day, costs: BASE })).toBeNull();
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: { ...owner(74, 'training'), currentActivity: null }, day, ...v2 })).toBeNull();
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: { ...owner(74, 'training'), currentActivity: null, restingUntilSlot: null }, day, costs: BASE })).toBeNull();
    // Back on its schedule (no idle rest): the number.
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: { ...owner(74, 'training'), restingUntilSlot: null }, day, costs: BASE })).toEqual({ before: 44, maximum: 104 });
  });

  it('keeps the v1 walk unchanged when no rules are given', () => {
    const triple: Schedule = { morning: R, afternoon: T, evening: T };
    expect(projectRest({ phase: 'morning', nowMs: morning, owner: owner(74, 'training'), day: triple, costs: BASE }))
      .toEqual(projectRest({ phase: 'morning', nowMs: morning, owner: owner(74, 'training'), day: triple, costs: BASE, rules: RULES_V1 }));
  });
});

describe('activityCosts', () => {
  it('derives the costs under the rules it is given: a v2 tournament entry costs nothing, even overloaded', () => {
    expect(activityCosts(ownerFixture, RULES_V2)).toEqual({ ...BASE, tournament: 0, dungeon: 40 });
    expect(activityCosts(ownerFixture, RULES_V1)).toEqual(BASE);
    expect(activityCosts(overloaded, RULES_V2)).toEqual({ training: 24, expedition: 36, arena: 30, tournament: 0, rest: 0, dungeon: 47 });
  });

  it('uses the build overload in the costs, as the boundary does', () => {
    expect(activityCosts(ownerFixture)).toEqual(BASE);
    expect(activityCosts(overloaded)!.expedition).toBe(activityCost(30, deriveStats(snapshotOf(overloaded), RULES_V1).overload));
    expect(activityCosts(overloaded)!.expedition).toBeGreaterThan(30);
  });

  it('charges every kind its base cost raised by the overload, rounded up', () => {
    // 29 load against a capacity of 24.7: an overload of 4.3/24.7, written apart from the code (the ceiling of base × 29/24.7).
    expect(deriveStats(snapshotOf(overloaded), RULES_V1).overload).toBeCloseTo(4.3 / 24.7, 10);
    expect(activityCosts(overloaded)).toEqual({ training: 24, expedition: 36, arena: 30, tournament: 30, rest: 0 });
  });

  it('gives no costs for a current build that does not validate', () => {
    const missing: OwnerState = { ...structuredClone(overloaded), inventory: overloaded.inventory.slice(1) };
    expect(activityCosts(missing)).toBeNull();
    // An equipped piece that is on sale is not wearable, as the boundary reads it.
    const listed: OwnerState = { ...structuredClone(overloaded), inventory: overloaded.inventory.map((item: ItemInstance, index) => index === 0 ? { ...item, reservation: { kind: 'listing', referenceId: 'listing' } } : item) };
    expect(activityCosts(listed)).toBeNull();
    // A class the rules do not know never throws; it gives nothing.
    const stranger = { ...structuredClone(ownerFixture), currentBuild: { ...ownerFixture.currentBuild, classId: 'summoner' as never } };
    expect(activityCosts(stranger)).toBeNull();
  });

  it('reads only the current build, never a pending one', () => {
    const pending = { ...structuredClone(ownerFixture), pendingBuild: { ...pendingAt(EVENING_SLOT + 5), build: overloaded.currentBuild } };
    expect(activityCosts({ ...pending, inventory: overloaded.inventory })).toEqual(BASE);
  });
});

describe('no wrong rest number', () => {
  it('moves what a part can afford with the overload, end to end', () => {
    const costs = activityCosts(overloaded)!;
    // The base cost of the afternoon's expedition is 30; the overloaded build pays 36, so the evening Rest starts 6 lower.
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: owner(74, 'training'), day, costs: BASE })).toEqual({ before: 44, maximum: 104 });
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: owner(74, 'training'), day, costs })).toEqual({ before: 38, maximum: 104 });
    // 30 is exactly enough for the base cost (it reaches 0) and one short of the overloaded cost, which turns into a Rest.
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: owner(30, 'training'), day, costs: BASE })).toEqual({ before: 0, maximum: 104 });
    expect(projectRest({ phase: 'evening', nowMs: morning, owner: owner(30, 'training'), day, costs })).toEqual({ before: 104, maximum: 104 });
  });

  it('shows no number while a pending build is waiting before the Rest, whatever the costs', () => {
    const costs = activityCosts(overloaded)!;
    const waiting = { ...owner(74, 'training'), pendingBuild: pendingAt(EVENING_SLOT) };
    expect(restHint(projectRest({ phase: 'evening', nowMs: morning, owner: waiting, day, costs }))).toBe('Refills stamina to full. Costs nothing.');
  });

  it('shows no number when the costs cannot be derived', () => {
    const missing: OwnerState = { ...structuredClone(overloaded), inventory: [] };
    expect(restHint(projectRest({ phase: 'evening', nowMs: morning, owner: owner(74, 'training'), day, costs: activityCosts(missing) }))).toBe('Refills stamina to full. Costs nothing.');
  });
});

describe('restingGain', () => {
  const resting = (stamina: number) => owner(stamina, 'rest');
  // Patch 1.6: the running Rest's refill (My gladiator, the trip replay) is the actual stamina now and the frozen end, under either rules
  // version: a schedule edit or the v2 daily Training limit, which only reach later slots, never change it, and it takes no rules.
  it('reads only the running Rest itself: no rules, no schedule, no daily history', () => {
    expect(restingGain.length).toBe(1);
    const planned = { ...resting(74), schedule: { morning: { kind: 'training' }, afternoon: { kind: 'training' }, evening: { kind: 'training' } } };
    expect(restingGain(planned)).toEqual({ before: 74, maximum: 104 });
  });
  it('is the running Rest\'s own refill: from the stamina now to the maximum', () => {
    expect(restingGain(resting(74))).toEqual({ before: 74, maximum: 104 });
    expect(restingGain(resting(104))).toEqual({ before: 104, maximum: 104 });
  });
  it('is nothing for an activity that is not a Rest, and for no activity', () => {
    expect(restingGain(owner(74, 'training'))).toBeNull();
    expect(restingGain({ ...owner(74, 'rest'), currentActivity: null })).toBeNull();
  });
  it('drops the number for a pending build that takes effect when the Rest ends or before', () => {
    // The Rest runs in the morning slot and ends at the boundary that starts slot + 1, where a build effective at slot + 1 takes effect.
    expect(restingGain({ ...resting(74), pendingBuild: pendingAt(MORNING_SLOT + 1) })).toBeNull();
    expect(restingGain({ ...resting(74), pendingBuild: pendingAt(MORNING_SLOT) })).toBeNull();
    expect(restingGain({ ...resting(74), pendingBuild: pendingAt(MORNING_SLOT + 2) })).toEqual({ before: 74, maximum: 104 });
    expect(restingGainText(restingGain({ ...resting(74), pendingBuild: pendingAt(MORNING_SLOT + 1) }))).toBe('Stamina refills to full when it ends.');
  });
});
