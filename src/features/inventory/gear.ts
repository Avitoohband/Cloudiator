// The gear view of the Inventory panel (launch feedback, 2026-10-25, note 9): what is worn now, what a swap queues, and the
// commands that queue, undo and cancel it. Pure, so the panel only lays it out. Gear changes go through the existing
// `queue-build` and `cancel-build` (no new command): a swap is the WHOLE build based on the pending build (or the current one
// when none is queued) with only the equipment changed, so a queued class, stance or attribute change survives it. A swap that
// lands back on the current build entirely is a `cancel-build` instead: there is then nothing left to queue.
import type { Attributes, Equipment, EquipmentSlot, GameCommand } from '@contracts/commands';
import type { BuildView, ItemInstance, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';

/** The five slots, in the order the "Wearing now" row shows them. */
export const GEAR_SLOTS: readonly EquipmentSlot[] = ['weapon', 'offHand', 'head', 'body', 'feet'];
/** A slot's name on the screen. */
export const SLOT_LABELS: Record<EquipmentSlot, string> = { weapon: 'Weapon', offHand: 'Off-hand', head: 'Head', body: 'Body', feet: 'Feet' };
const ATTRIBUTES = ['strength', 'agility', 'vitality', 'endurance', 'precision'] as const;

/**
 * Where a piece of gear stands against the build worn now and the one queued for the next slot:
 * - `wearing`: worn now and still worn next; `queued`: worn from the next slot; `leaving`: worn now, off from the next slot;
 * - `needs-free-hand`: an off-hand piece while the next weapon is two-handed (that weapon uses both hands; this wins over
 *   `leaving`, so the shield a two-handed weapon pushes off reads "Needs a free hand");
 * - `needs-level`: above the character's level; `listed`: on the Marketplace; `free`: nothing prevents wearing it.
 */
export type WearState = 'wearing' | 'queued' | 'leaving' | 'free' | 'needs-free-hand' | 'needs-level' | 'listed';
/** A gear change is one of the build panel's own commands (a `GameCommand`, narrowed to the pair gear uses). */
export type GearCommand = Extract<GameCommand, { kind: 'queue-build' | 'cancel-build' }>;
/** The badge a piece carries: worn, coming from the next slot, or going at it; none for the rest. */
export type WearBadge = 'wearing' | 'wears-from' | 'off-at';

const newOperation = () => crypto.randomUUID();
const entryOf = (item: ItemInstance | undefined) => (item ? CATALOG_V1.items[item.catalogId] : undefined);
const itemById = (owner: OwnerState, id: string | null) => (id === null ? undefined : owner.inventory.find(item => item.id === id));
const twoHanded = (owner: OwnerState, id: string | null) => entryOf(itemById(owner, id))?.hands === 2;
/** The build the next swap is based on: the queued one, else the current one. */
const baseBuild = (owner: OwnerState): BuildView => owner.pendingBuild?.build ?? owner.currentBuild;

/** Whether the item can be worn at all (it has a slot): gear, not salvage. */
export function isWearable(item: ItemInstance): boolean {
  return entryOf(item)?.slot !== undefined;
}

/** What is worn now (the current build's equipment), a copy. */
export function wornNow(owner: OwnerState): Equipment {
  return { ...owner.currentBuild.equipment };
}

/** What is worn from the next slot: the pending build's equipment, else what is worn now. A copy. */
export function nextEquipment(owner: OwnerState): Equipment {
  return { ...baseBuild(owner).equipment };
}

/** The slots whose piece changes at the next slot, in the row's order. */
export function changedSlots(owner: OwnerState): EquipmentSlot[] {
  const worn = wornNow(owner), next = nextEquipment(owner);
  return GEAR_SLOTS.filter(slot => worn[slot] !== next[slot]);
}

/** Whether the queued build holds more than gear: a class, stance or attribute change that "Cancel changes" keeps. */
export function keepsOtherChanges(owner: OwnerState): boolean {
  const pending = owner.pendingBuild?.build, current = owner.currentBuild;
  return !!pending && (pending.classId !== current.classId || pending.stance !== current.stance
    || ATTRIBUTES.some(key => pending.allocations[key] !== current.allocations[key]));
}

export function wearState(owner: OwnerState, item: ItemInstance): WearState {
  const worn = Object.values(owner.currentBuild.equipment).includes(item.id);
  const next = Object.values(nextEquipment(owner)).includes(item.id);
  if (worn && next) return 'wearing';
  if (next) return 'queued';
  const slot = entryOf(item)?.slot;
  if (slot === 'offHand' && twoHanded(owner, nextEquipment(owner).weapon)) return 'needs-free-hand';
  if (worn) return 'leaving';
  if (item.tier > owner.progression.level) return 'needs-level';
  if (item.reservation?.kind === 'listing') return 'listed';
  return 'free';
}

/** The badge a piece carries: from what is worn now and what is worn next (a shield a two-handed weapon pushes off is going). */
export function wearBadge(owner: OwnerState, item: ItemInstance): WearBadge | null {
  const worn = Object.values(owner.currentBuild.equipment).includes(item.id);
  const next = Object.values(nextEquipment(owner)).includes(item.id);
  return worn && next ? 'wearing' : next ? 'wears-from' : worn ? 'off-at' : null;
}

/** The badge's words; `time` is the effective slot's time as the screen shows it, or '' when it cannot be shown. */
export function wearBadgeText(badge: WearBadge, time: string): string {
  if (badge === 'wearing') return 'Wearing';
  return `${badge === 'wears-from' ? 'Wears from' : 'Off at'} ${time || 'the next slot'}`;
}

/** Why a piece cannot be worn, or null when it can (or is worn already). */
export function blockedText(state: WearState, item: ItemInstance): string | null {
  switch (state) {
    case 'needs-free-hand': return 'Needs a free hand';
    case 'needs-level': return `Needs level ${item.tier}`;
    case 'listed': return 'Listed for sale';
    default: return null;
  }
}

/** The note that says when queued gear changes start; `time` is as for `wearBadgeText`. */
export function pendingNote(time: string): string {
  return `Gear changes start at the next slot${time ? `, ${time}` : ''}. Anything already running keeps the gear it started with.`;
}

/** The words for a refused gear command: the Build panel's, since the same commands are refused for the same reasons. */
export function gearRefusal(code: string): string {
  return code === 'processing' ? 'The world is processing previous results. Retry shortly.'
    : code === 'conflict' ? 'Your build changed. The latest state has been loaded; review and try again.'
      : code === 'unavailable' ? 'This change could not be confirmed. Retry to confirm the same request.'
        : code === 'insufficient-funds' ? 'Not enough available money for this reservation.' : `Build change rejected: ${code}.`;
}

const sameAttributes = (a: Attributes, b: Attributes) => ATTRIBUTES.every(key => a[key] === b[key]);

/**
 * The command that makes `equipment` the next slot's gear: the whole build of `pendingBuild ?? currentBuild` with that
 * equipment, or `cancel-build` when the result equals the current build entirely.
 */
function buildCommand(owner: OwnerState, equipment: Equipment, operationId: string): GearCommand {
  const base = baseBuild(owner), current = owner.currentBuild;
  const unchanged = base.classId === current.classId && base.stance === current.stance && sameAttributes(base.allocations, current.allocations)
    && GEAR_SLOTS.every(slot => equipment[slot] === current.equipment[slot]);
  if (unchanged) return { kind: 'cancel-build', operationId, expectedVersion: owner.buildVersion };
  return { kind: 'queue-build', operationId, expectedVersion: owner.buildVersion, classId: base.classId, stance: base.stance,
    allocation: { ...base.allocations }, equipment: { ...equipment } };
}

/**
 * Wear `itemId` from the next slot: its slot takes it, and a two-handed weapon frees the off-hand. The panel offers it only
 * for a piece that is not `needs-free-hand`, `needs-level` or `listed`; the server refuses what the rules do not allow.
 * A new operation id unless one is given (a retry passes the first attempt's).
 */
export function wearCommand(owner: OwnerState, itemId: string, operationId: string = newOperation()): GearCommand {
  const item = itemById(owner, itemId), slot = entryOf(item)?.slot;
  if (!item || slot === undefined) throw new RangeError('This item cannot be worn');
  const equipment = nextEquipment(owner);
  equipment[slot] = itemId;
  if (slot === 'weapon' && twoHanded(owner, itemId)) equipment.offHand = null;
  return buildCommand(owner, equipment, operationId);
}

/**
 * Undo the queued change in `slot`: the worn piece goes back. Undoing a queued two-handed weapon also restores the worn
 * off-hand piece it pushed off; a restored weapon that is itself two-handed keeps the off-hand free. The rest of the queue stays.
 */
export function undoCommand(owner: OwnerState, slot: EquipmentSlot, operationId: string = newOperation()): GearCommand {
  const worn = wornNow(owner), equipment = nextEquipment(owner);
  const undone = equipment[slot];
  equipment[slot] = worn[slot];
  if (slot === 'weapon' && twoHanded(owner, undone)) equipment.offHand = worn.offHand;
  if (twoHanded(owner, equipment.weapon)) equipment.offHand = null;
  return buildCommand(owner, equipment, operationId);
}

/** "Cancel changes": every slot back to what is worn now; a queued class, stance or attribute change is kept. */
export function cancelGearCommand(owner: OwnerState, operationId: string = newOperation()): GearCommand {
  return buildCommand(owner, wornNow(owner), operationId);
}
