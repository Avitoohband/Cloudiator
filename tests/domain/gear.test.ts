import { describe, expect, it } from 'vitest';
import type { Attributes, ClassId, Equipment, GameCommand, Stance } from '@contracts/commands';
import type { ItemInstance, OwnerState, PendingBuildView } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { ownerFixture, itemFixture } from '../fixtures/domain.ts';
import {
  GEAR_SLOTS, blockedText, cancelGearCommand, changedSlots, gearRefusal, isWearable, keepsOtherChanges, nextEquipment, pendingNote,
  undoCommand, wearBadge, wearBadgeText, wearCommand, wearState, wornNow,
} from '../../src/features/inventory/gear';

// Launch feedback, note 9: the gear view. A swap is a whole `queue-build` based on the pending build (or the current one) with
// only the equipment changed, so a queued stance or points change survives; a swap that lands back on the current build is a
// `cancel-build`. Written apart from the code: the expected builds are spelled out, never derived by the helpers.
let serial = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
const item = (catalogId: string, overrides: Partial<ItemInstance> = {}): ItemInstance =>
  ({ ...itemFixture(CATALOG_V1.items[catalogId]), id: nextId(), ...overrides });
const gear = (slots: Partial<Equipment>): Equipment => ({ weapon: null, offHand: null, head: null, body: null, feet: null, ...slots });
const OPERATION = '5d0f6a52-8f3e-4a51-9a39-3c1f4e0f9d21';

// The player's bag: two one-handed swords, a two-handed spear, a shield, a hood, a helmet, a tier 5 axe, a listed hood and salvage.
const sword = item('sword:1:common'), sword2 = item('sword:1:uncommon'), spear = item('spear:1:common'), shield = item('round-shield:1:common');
const bow = item('bow:1:common'), hood = item('leather-hood:1:common'), helmet = item('iron-helmet:1:common'), axe5 = item('axe:5:common'), armor = item('light-armor:1:common');
const listedHood = item('leather-hood:1:uncommon', { reservation: { kind: 'listing', referenceId: nextId() } });
const salvage: ItemInstance = { ...item('sword:1:common'), id: nextId(), catalogId: 'salvage', quantity: 4, origin: 'expedition' };
const bag = [sword, sword2, spear, bow, shield, hood, helmet, axe5, armor, listedHood, salvage];

/** The player wears the sword, the shield and the hood; `pending` is a queued build (its equipment defaults to what is worn). */
function owner(options: { worn?: Partial<Equipment>; pending?: { equipment?: Partial<Equipment>; classId?: ClassId; stance?: Stance; allocations?: Attributes } | null; level?: number } = {}): OwnerState {
  const worn = gear(options.worn ?? { weapon: sword.id, offHand: shield.id, head: hood.id });
  const state = structuredClone(ownerFixture);
  state.currentBuild = { ...state.currentBuild, version: 4, classId: 'guardian', stance: 'balanced', equipment: worn,
    allocations: { strength: 3, agility: 2, vitality: 2, endurance: 2, precision: 1 } };
  state.buildVersion = 7;
  state.progression.level = options.level ?? 1;
  state.inventory = structuredClone(bag).map(entry => ({ ...entry, reservation: Object.values(worn).includes(entry.id) ? { kind: 'equipment' as const, referenceId: state.gladiatorId } : entry.reservation }));
  if (options.pending) {
    const equipment = { ...worn, ...options.pending.equipment };
    const build = { ...state.currentBuild, version: 8, classId: options.pending.classId ?? state.currentBuild.classId, equipment,
      stance: options.pending.stance ?? state.currentBuild.stance, allocations: options.pending.allocations ?? state.currentBuild.allocations };
    state.pendingBuild = { build, effectiveSlotIndex: 373_250, reservedMoney: 0, reservedItemIds: Object.values(equipment).filter((id): id is string => id !== null), operationId: OPERATION } satisfies PendingBuildView;
  }
  return state;
}
const find = (state: OwnerState, id: string) => state.inventory.find(entry => entry.id === id)!;
const queued = (command: GameCommand) => { expect(command.kind).toBe('queue-build'); return command as Extract<GameCommand, { kind: 'queue-build' }>; };

describe('wornNow and nextEquipment', () => {
  it('read the current build, and the pending build for the next slot', () => {
    const plain = owner();
    expect(wornNow(plain)).toEqual(gear({ weapon: sword.id, offHand: shield.id, head: hood.id }));
    expect(nextEquipment(plain)).toEqual(wornNow(plain));
    const swapping = owner({ pending: { equipment: { weapon: sword2.id } } });
    expect(wornNow(swapping)).toEqual(gear({ weapon: sword.id, offHand: shield.id, head: hood.id }));
    expect(nextEquipment(swapping)).toEqual(gear({ weapon: sword2.id, offHand: shield.id, head: hood.id }));
  });

  it('hand out copies that cannot change the owner', () => {
    const state = owner();
    wornNow(state).weapon = 'x'; nextEquipment(state).head = 'y';
    expect(state.currentBuild.equipment.weapon).toBe(sword.id);
    expect(state.currentBuild.equipment.head).toBe(hood.id);
  });

  it('list the changed slots in the slots\' order, none for a class-only pending build', () => {
    expect(GEAR_SLOTS).toEqual(['weapon', 'offHand', 'head', 'body', 'feet']);
    expect(changedSlots(owner())).toEqual([]);
    expect(changedSlots(owner({ pending: { classId: 'berserker' } }))).toEqual([]);
    expect(changedSlots(owner({ pending: { equipment: { head: helmet.id, weapon: sword2.id } } }))).toEqual(['weapon', 'head']);
  });
});

describe('wearCommand', () => {
  it('queues the whole build with only the weapon changed when a second sword is worn', () => {
    const state = owner();
    expect(wearCommand(state, sword2.id, OPERATION)).toEqual({
      kind: 'queue-build', operationId: OPERATION, expectedVersion: 7, classId: 'guardian', stance: 'balanced',
      allocation: { strength: 3, agility: 2, vitality: 2, endurance: 2, precision: 1 },
      equipment: { weapon: sword2.id, offHand: shield.id, head: hood.id, body: null, feet: null },
    });
  });

  it('gives each command a fresh operation id unless one is passed', () => {
    const state = owner();
    const [a, b] = [wearCommand(state, sword2.id), wearCommand(state, sword2.id)];
    expect(a.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a.operationId).not.toBe(b.operationId);
  });

  it('puts a piece on an empty slot', () => {
    expect(queued(wearCommand(owner(), helmet.id, OPERATION)).equipment).toEqual(gear({ weapon: sword.id, offHand: shield.id, head: helmet.id }));
  });

  it('is based on the pending build: a queued stance change and the other queued pieces survive', () => {
    const state = owner({ pending: { stance: 'offensive', equipment: { head: helmet.id } } });
    expect(queued(wearCommand(state, sword2.id, OPERATION))).toMatchObject({
      classId: 'guardian', stance: 'offensive', expectedVersion: 7, equipment: gear({ weapon: sword2.id, offHand: shield.id, head: helmet.id }),
    });
  });

  it('takes the stance and the added attribute points of the pending build, not the current one', () => {
    const state = owner({ pending: { stance: 'offensive', allocations: { strength: 5, agility: 5, vitality: 2, endurance: 2, precision: 1 } } });
    expect(queued(wearCommand(state, sword2.id, OPERATION))).toMatchObject({
      classId: 'guardian', stance: 'offensive', allocation: { strength: 5, agility: 5, vitality: 2, endurance: 2, precision: 1 },
    });
  });

  it('clears the off-hand when a two-handed weapon is worn, and the shield then reads "needs-free-hand"', () => {
    const state = owner();
    const command = queued(wearCommand(state, spear.id, OPERATION));
    expect(command.equipment).toEqual(gear({ weapon: spear.id, offHand: null, head: hood.id }));
    state.pendingBuild = { build: { ...state.currentBuild, version: 8, equipment: command.equipment }, effectiveSlotIndex: 373_250,
      reservedMoney: 0, reservedItemIds: [spear.id, hood.id], operationId: OPERATION };
    expect(wearState(state, find(state, shield.id))).toBe('needs-free-hand');
    expect(wearState(state, find(state, spear.id))).toBe('queued');
    expect(wearState(state, find(state, sword.id))).toBe('leaving');
  });

  it('brings the shield back when a one-handed weapon is worn after a two-handed one, instead of undoing it', () => {
    // The spear is queued (the off-hand cleared); wearing the sword again lands on the current build, wearing the other sword
    // keeps the shield (the off-hand follows the weapon's hands, as in the approved mockup).
    const spearQueued = owner({ pending: { equipment: { weapon: spear.id, offHand: null } } });
    expect(wearCommand(spearQueued, sword.id, OPERATION)).toEqual({ kind: 'cancel-build', operationId: OPERATION, expectedVersion: 7 });
    expect(wearCommand(spearQueued, sword2.id, OPERATION)).toEqual({
      kind: 'queue-build', operationId: OPERATION, expectedVersion: 7, classId: 'guardian', stance: 'balanced',
      allocation: { strength: 3, agility: 2, vitality: 2, endurance: 2, precision: 1 },
      equipment: { weapon: sword2.id, offHand: shield.id, head: hood.id, body: null, feet: null },
    });
  });

  it('brings the shield back after a two-handed weapon and keeps a queued stance change and the other pieces', () => {
    const state = owner({ pending: { stance: 'offensive', equipment: { weapon: spear.id, offHand: null, head: helmet.id } } });
    expect(queued(wearCommand(state, sword.id, OPERATION))).toMatchObject({
      stance: 'offensive', equipment: gear({ weapon: sword.id, offHand: shield.id, head: helmet.id }),
    });
  });

  it('reads the shield as worn again once a one-handed weapon follows the two-handed one', () => {
    const spearQueued = owner({ pending: { equipment: { weapon: spear.id, offHand: null } } });
    const command = queued(wearCommand(spearQueued, sword2.id, OPERATION));
    const state = owner({ pending: { equipment: command.equipment } });
    expect(wearState(state, find(state, shield.id))).toBe('wearing');
    expect(wearBadge(state, find(state, shield.id))).toBe('wearing');
    expect(changedSlots(state)).toEqual(['weapon']);
  });

  it('leaves an off-hand the player emptied while the weapon was one-handed empty', () => {
    // Emptied through the Build panel under a one-handed sword: no two-handed weapon was involved, so nothing brings it back.
    const state = owner({ pending: { equipment: { weapon: sword2.id, offHand: null } } });
    expect(queued(wearCommand(state, sword.id, OPERATION)).equipment).toEqual(gear({ weapon: sword.id, offHand: null, head: hood.id }));
  });

  it('brings back nothing when the worn weapon was two-handed and there was no worn off-hand', () => {
    const state = owner({ worn: { weapon: spear.id, head: hood.id }, pending: { equipment: { weapon: bow.id } } });
    expect(queued(wearCommand(state, sword2.id, OPERATION)).equipment).toEqual(gear({ weapon: sword2.id, offHand: null, head: hood.id }));
  });

  it('keeps the off-hand free from one two-handed weapon to another', () => {
    const state = owner({ pending: { equipment: { weapon: spear.id, offHand: null } } });
    expect(queued(wearCommand(state, bow.id, OPERATION)).equipment).toEqual(gear({ weapon: bow.id, offHand: null, head: hood.id }));
  });

  it('becomes cancel-build when the swap lands back on the current build', () => {
    // The sword is queued out for the other sword; wearing the first sword again is the current build.
    const state = owner({ pending: { equipment: { weapon: sword2.id } } });
    expect(wearCommand(state, sword.id, OPERATION)).toEqual({ kind: 'cancel-build', operationId: OPERATION, expectedVersion: 7 });
  });

  it('stays a queue-build when the pending build still holds another change', () => {
    const state = owner({ pending: { stance: 'offensive', equipment: { weapon: sword2.id } } });
    expect(queued(wearCommand(state, sword.id, OPERATION))).toMatchObject({ stance: 'offensive', equipment: gear({ weapon: sword.id, offHand: shield.id, head: hood.id }) });
  });

  it('refuses an item that has no slot, such as salvage, and an unknown item', () => {
    const state = owner();
    expect(() => wearCommand(state, salvage.id)).toThrow(RangeError);
    expect(() => wearCommand(state, 'nope')).toThrow(RangeError);
  });
});

describe('undoCommand', () => {
  it('puts the worn piece back in its slot and keeps the rest of the queue', () => {
    const state = owner({ pending: { equipment: { weapon: sword2.id, head: helmet.id } } });
    expect(queued(undoCommand(state, 'weapon', OPERATION))).toMatchObject({ equipment: gear({ weapon: sword.id, offHand: shield.id, head: helmet.id }) });
  });

  it('restores the worn off-hand when the queued weapon was two-handed', () => {
    // A two-handed spear is queued over the sword and shield (the off-hand is cleared), with a stance change queued too.
    const state = owner({ pending: { stance: 'offensive', equipment: { weapon: spear.id, offHand: null } } });
    expect(queued(undoCommand(state, 'weapon', OPERATION))).toMatchObject({
      stance: 'offensive', equipment: gear({ weapon: sword.id, offHand: shield.id, head: hood.id }),
    });
  });

  it('is cancel-build when undoing the only queued change, the two-handed weapon included', () => {
    expect(undoCommand(owner({ pending: { equipment: { weapon: spear.id, offHand: null } } }), 'weapon', OPERATION))
      .toEqual({ kind: 'cancel-build', operationId: OPERATION, expectedVersion: 7 });
    expect(undoCommand(owner({ pending: { equipment: { head: helmet.id } } }), 'head', OPERATION))
      .toEqual({ kind: 'cancel-build', operationId: OPERATION, expectedVersion: 7 });
  });

  it('leaves the off-hand alone when the queued weapon was one-handed', () => {
    // The off-hand was emptied through the build panel; undoing a sword swap does not bring the shield back.
    const state = owner({ pending: { equipment: { weapon: sword2.id, offHand: null } } });
    expect(queued(undoCommand(state, 'weapon', OPERATION)).equipment).toEqual(gear({ weapon: sword.id, offHand: null, head: hood.id }));
  });

  it('keeps the off-hand free when the restored weapon is itself two-handed', () => {
    const state = owner({ worn: { weapon: spear.id, head: hood.id }, pending: { equipment: { weapon: sword.id, offHand: shield.id } } });
    expect(undoCommand(state, 'weapon', OPERATION)).toEqual({ kind: 'cancel-build', operationId: OPERATION, expectedVersion: 7 });
    const withHelmet = owner({ worn: { weapon: spear.id, head: hood.id }, pending: { equipment: { weapon: sword.id, offHand: shield.id, head: helmet.id } } });
    expect(queued(undoCommand(withHelmet, 'weapon', OPERATION)).equipment).toEqual(gear({ weapon: spear.id, offHand: null, head: helmet.id }));
  });

  it('undoes a one-handed weapon chosen after a two-handed one back to the current build, the shield included', () => {
    const afterSpear = owner({ pending: { equipment: { weapon: sword2.id, offHand: shield.id } } });
    expect(undoCommand(afterSpear, 'weapon', OPERATION)).toEqual({ kind: 'cancel-build', operationId: OPERATION, expectedVersion: 7 });
  });

  it('empties a slot that was empty when worn', () => {
    const state = owner({ pending: { stance: 'offensive', equipment: { body: armor.id } } });
    expect(queued(undoCommand(state, 'body', OPERATION)).equipment).toEqual(gear({ weapon: sword.id, offHand: shield.id, head: hood.id }));
  });
});

describe('cancelGearCommand', () => {
  it('cancelling gear changes keeps a queued stance change', () => {
    const state = owner({ pending: { stance: 'offensive', equipment: { weapon: spear.id, offHand: null, head: helmet.id } } });
    expect(cancelGearCommand(state, OPERATION)).toEqual({
      kind: 'queue-build', operationId: OPERATION, expectedVersion: 7, classId: 'guardian', stance: 'offensive',
      allocation: { strength: 3, agility: 2, vitality: 2, endurance: 2, precision: 1 },
      equipment: { weapon: sword.id, offHand: shield.id, head: hood.id, body: null, feet: null },
    });
    expect(keepsOtherChanges(state)).toBe(true);
  });

  it('is cancel-build when only gear was queued', () => {
    const state = owner({ pending: { equipment: { weapon: spear.id, offHand: null, head: helmet.id } } });
    expect(cancelGearCommand(state, OPERATION)).toEqual({ kind: 'cancel-build', operationId: OPERATION, expectedVersion: 7 });
    expect(keepsOtherChanges(state)).toBe(false);
  });

  it('counts a queued stance or attribute change as another change', () => {
    const stance = owner({ pending: { equipment: { head: helmet.id } } });
    stance.pendingBuild!.build.stance = 'offensive';
    expect(keepsOtherChanges(stance)).toBe(true);
    expect(queued(cancelGearCommand(stance, OPERATION))).toMatchObject({ stance: 'offensive', equipment: wornNow(stance) });
    const points = owner({ pending: { equipment: { head: helmet.id } } });
    points.pendingBuild!.build.allocations = { ...points.pendingBuild!.build.allocations, strength: 4, precision: 0 };
    expect(keepsOtherChanges(points)).toBe(true);
    expect(keepsOtherChanges(owner())).toBe(false);
  });
});

// Fixed class and points (Avi, 2026-10-28): the server refuses a class change and any attribute below the CURRENT build's value
// as `invalid`. A build queued BEFORE that release may hold either, so a gear command starts from the current class and from no
// attribute below the current build's, never sending what would be refused; that player's old class change or respec is dropped
// when they change gear (the Build panel's form starts the same way).
describe('a pending build queued before the class and points were fixed', () => {
  const earlier = { strength: 1, agility: 4, vitality: 2, endurance: 2, precision: 1 };

  it('sends the current class, not the queued one, when a piece is worn', () => {
    const state = owner({ pending: { classId: 'berserker', stance: 'offensive', equipment: { head: helmet.id } } });
    expect(queued(wearCommand(state, sword2.id, OPERATION))).toMatchObject({
      classId: 'guardian', stance: 'offensive', equipment: gear({ weapon: sword2.id, offHand: shield.id, head: helmet.id }),
    });
  });

  it('sends no attribute below the current build\'s, and keeps the points that were added', () => {
    // Current: strength 3, agility 2, vitality 2, endurance 2, precision 1. The queued build respecced strength down and added agility.
    const state = owner({ pending: { allocations: earlier, equipment: { head: helmet.id } } });
    expect(queued(wearCommand(state, sword2.id, OPERATION)).allocation).toEqual({ strength: 3, agility: 4, vitality: 2, endurance: 2, precision: 1 });
    expect(state.pendingBuild!.build.allocations).toEqual(earlier);
  });

  it('is the same for Undo and Cancel changes', () => {
    const state = owner({ pending: { classId: 'duelist', allocations: earlier, equipment: { weapon: spear.id, offHand: null, head: helmet.id } } });
    const expected = { classId: 'guardian', stance: 'balanced', allocation: { strength: 3, agility: 4, vitality: 2, endurance: 2, precision: 1 } };
    expect(queued(undoCommand(state, 'head', OPERATION))).toMatchObject({ ...expected, equipment: gear({ weapon: spear.id, offHand: null, head: hood.id }) });
    expect(queued(cancelGearCommand(state, OPERATION))).toMatchObject({ ...expected, equipment: gear({ weapon: sword.id, offHand: shield.id, head: hood.id }) });
  });

  it('is cancel-build when the gear lands back on the current build and only the dropped class change was left', () => {
    const state = owner({ pending: { classId: 'berserker', equipment: { weapon: sword2.id } } });
    expect(wearCommand(state, sword.id, OPERATION)).toEqual({ kind: 'cancel-build', operationId: OPERATION, expectedVersion: 7 });
    expect(cancelGearCommand(state, OPERATION)).toEqual({ kind: 'cancel-build', operationId: OPERATION, expectedVersion: 7 });
    // The panel's note about "other queued build changes" agrees: the dropped class change is not one that is kept.
    expect(keepsOtherChanges(state)).toBe(false);
  });

  it('counts only a stance or an added-points change as another change to keep, not the dropped class change or respec', () => {
    expect(keepsOtherChanges(owner({ pending: { classId: 'duelist', equipment: { head: helmet.id } } }))).toBe(false);
    expect(keepsOtherChanges(owner({ pending: { allocations: earlier, equipment: { head: helmet.id } } }))).toBe(true);
    expect(keepsOtherChanges(owner({ pending: { allocations: { strength: 2, agility: 2, vitality: 2, endurance: 2, precision: 1 }, equipment: { head: helmet.id } } }))).toBe(false);
    expect(keepsOtherChanges(owner({ pending: { classId: 'duelist', stance: 'defensive', equipment: { head: helmet.id } } }))).toBe(true);
  });

  it('never sends a class or attribute the lock would refuse, whatever the pending build holds', () => {
    const current = owner().currentBuild;
    for (const classId of ['guardian', 'berserker', 'duelist'] as const) {
      for (const allocations of [current.allocations, earlier, { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 }, { strength: 9, agility: 0, vitality: 9, endurance: 0, precision: 9 }]) {
        const command = queued(wearCommand(owner({ pending: { classId, allocations, equipment: { head: helmet.id } } }), sword2.id, OPERATION));
        expect(command.classId, `${classId} ${JSON.stringify(allocations)}`).toBe(current.classId);
        for (const key of Object.keys(current.allocations) as (keyof Attributes)[]) expect(command.allocation[key]).toBeGreaterThanOrEqual(current.allocations[key]);
      }
    }
  });
});

describe('wearState', () => {
  const state = owner({ pending: { equipment: { weapon: sword2.id } } });
  const read = (target: OwnerState, entry: ItemInstance) => wearState(target, find(target, entry.id));

  it('tells worn, queued and leaving pieces apart', () => {
    expect(read(state, shield)).toBe('wearing');
    expect(read(state, hood)).toBe('wearing');
    expect(read(state, sword2)).toBe('queued');
    expect(read(state, sword)).toBe('leaving');
  });

  it('reads free for a piece nothing prevents', () => {
    expect(read(state, helmet)).toBe('free');
    expect(read(owner(), sword2)).toBe('free');
    expect(read(owner(), sword)).toBe('wearing');
  });

  it('reads needs-level for a piece above the character\'s level, and free once the level is reached', () => {
    expect(read(owner(), axe5)).toBe('needs-level');
    expect(read(owner({ level: 4 }), axe5)).toBe('needs-level');
    expect(read(owner({ level: 5 }), axe5)).toBe('free');
  });

  it('reads listed for a piece on the Marketplace', () => {
    expect(read(owner(), listedHood)).toBe('listed');
  });

  it('reads needs-free-hand for every off-hand piece while the next weapon is two-handed, not before or after', () => {
    expect(read(owner({ worn: { weapon: sword.id, head: hood.id } }), shield)).toBe('free');
    const spearNext = owner({ worn: { weapon: sword.id, head: hood.id }, pending: { equipment: { weapon: spear.id } } });
    expect(read(spearNext, shield)).toBe('needs-free-hand');
    const wornSpear = owner({ worn: { weapon: spear.id, head: hood.id } });
    expect(read(wornSpear, shield)).toBe('needs-free-hand');
    const back = owner({ worn: { weapon: sword.id, head: hood.id }, pending: { equipment: { weapon: sword2.id } } });
    expect(read(back, shield)).toBe('free');
  });

  it('does not read needs-free-hand for a weapon or armor while a two-handed weapon is next', () => {
    const spearNext = owner({ pending: { equipment: { weapon: spear.id, offHand: null } } });
    expect(read(spearNext, sword2)).toBe('free');
    expect(read(spearNext, helmet)).toBe('free');
  });

  it('judges a piece by the pending build\'s level, not an earlier read: a worn piece stays wearing', () => {
    const level = owner({ worn: { weapon: axe5.id }, level: 5 });
    expect(read(level, axe5)).toBe('wearing');
  });
});

describe('wearBadge', () => {
  it('names the pieces worn, coming and going, and leaves the rest unmarked', () => {
    const state = owner({ pending: { equipment: { weapon: sword2.id } } });
    const badge = (entry: ItemInstance) => wearBadge(state, find(state, entry.id));
    expect(badge(shield)).toBe('wearing');
    expect(badge(sword2)).toBe('wears-from');
    expect(badge(sword)).toBe('off-at');
    expect(badge(helmet)).toBeNull();
  });

  it('marks a shield a two-handed weapon pushes off as going, though it reads needs-free-hand', () => {
    const state = owner({ pending: { equipment: { weapon: spear.id, offHand: null } } });
    expect(wearState(state, find(state, shield.id))).toBe('needs-free-hand');
    expect(wearBadge(state, find(state, shield.id))).toBe('off-at');
  });

  it('writes the badges with their time, and without one when it cannot be shown', () => {
    expect(wearBadgeText('wearing', '4:20 AM')).toBe('Wearing');
    expect(wearBadgeText('wears-from', '4:20 AM')).toBe('Wears from 4:20 AM');
    expect(wearBadgeText('off-at', 'tomorrow 4:20 AM')).toBe('Off at tomorrow 4:20 AM');
    expect(wearBadgeText('wears-from', '')).toBe('Wears from the next slot');
    expect(wearBadgeText('off-at', '')).toBe('Off at the next slot');
  });
});

describe('words', () => {
  it('says why a piece cannot be worn, in the words the screen shows', () => {
    const state = owner();
    expect(blockedText('needs-free-hand', find(state, shield.id))).toBe('Needs a free hand');
    expect(blockedText('needs-level', find(state, axe5.id))).toBe('Needs level 5');
    expect(blockedText('listed', find(state, listedHood.id))).toBe('Listed for sale');
    for (const free of ['wearing', 'queued', 'leaving', 'free'] as const) expect(blockedText(free, find(state, sword.id))).toBeNull();
  });

  it('says when queued changes start and that a running activity keeps its gear', () => {
    expect(pendingNote('4:20 AM')).toBe('Gear changes start at the next slot, 4:20 AM. Anything already running keeps the gear it started with.');
    expect(pendingNote('')).toBe('Gear changes start at the next slot. Anything already running keeps the gear it started with.');
  });

  it('explains a refusal of a gear change in words, never a raw code alone', () => {
    expect(gearRefusal('processing')).toBe('The world is processing previous results. Retry shortly.');
    expect(gearRefusal('conflict')).toBe('Your build changed. The latest state has been loaded; review and try again.');
    expect(gearRefusal('unavailable')).toBe('This change could not be confirmed. Retry to confirm the same request.');
    expect(gearRefusal('insufficient-funds')).toBe('Not enough available gold for this reservation.');
    // Final review fix: the server answers `invalid` for any build that fails its checks (a piece listed or gone since the view
    // was loaded); the panel reloads the gear, and the words say so instead of the raw code.
    expect(gearRefusal('invalid')).toBe('That gear change is no longer possible. Your gear has been reloaded.');
    expect(gearRefusal('invalid')).not.toContain('invalid');
  });

  it('knows which inventory items can be worn', () => {
    const state = owner();
    expect(isWearable(find(state, sword.id))).toBe(true);
    expect(isWearable(find(state, shield.id))).toBe(true);
    expect(isWearable(find(state, salvage.id))).toBe(false);
  });
});
