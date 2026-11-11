// My gladiator's equip picker (Patch 1.9, the approved equip-from-gladiator and stacks mockups). Pure, so the panel only lays it out:
// the tiles a slot offers (one per stack, `groupStacks`), the mark each tile carries, and the comparison of a chosen piece with what is
// worn next in that slot. The "after" gear is the equipment of the very command Wear or Remove sends (`wearCommand`, `removeCommand`),
// so the comparison, its Load and the command can never disagree, two-handed weapons and the off-hand included.
import type { Equipment, EquipmentSlot } from '@contracts/commands';
import type { ItemInstance, OwnerState } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { RULES_V1 } from '@domain/rules-v1';
import { deriveStats } from '@domain/stats';
import { fixedClassAndPoints } from '../build/fixed-build';
import { GEAR_SLOTS, blockedText, nextEquipment, removeCommand, wearCommand, wearState, wornNow, type GearCommand, type WearState } from '../inventory/gear';
import { itemStatLines } from '../inventory/item-presentation';
import { groupStacks, isStackable, type StackTile } from '../inventory/stacks';

/** A slot's name on My gladiator (the Worn equipment row's words). */
export const SLOT_NAMES: Record<EquipmentSlot, string> = { weapon: 'Weapon', offHand: 'Off hand', head: 'Head', body: 'Body', feet: 'Feet' };

export const itemName = (item: ItemInstance) => CATALOG_V1.items[item.catalogId]?.name ?? item.catalogId;
/** "Sword, level 1 common": the Inventory's label, which tells two same-name pieces apart. */
export const itemLabel = (item: ItemInstance) => `${itemName(item)}, level ${item.tier} ${item.rarity}`;
/** "Sword, level 1 · common": the Inventory's "Next:" words. */
export const nextLabel = (item: ItemInstance) => `${itemName(item)}, level ${item.tier} · ${item.rarity}`;
export const isTwoHanded = (item: ItemInstance | undefined) => !!item && CATALOG_V1.items[item.catalogId]?.hands === 2;

/** The pieces that fit `slot`, one tile per stack of identical free pieces, in the bag's order. */
export function slotTiles(owner: OwnerState, slot: EquipmentSlot): StackTile[] {
  return groupStacks(owner.inventory.filter(item => CATALOG_V1.items[item.catalogId]?.slot === slot), item => isStackable(owner, item));
}

/**
 * The mark a tile carries top right: a lock for a piece that cannot be worn now (above the level, listed, or an off-hand piece while a
 * two-handed weapon is next), ✓ for a piece worn now (`worn`), → for one worn from the next slot (`next`), none for the rest.
 */
export type TileMark = 'lock' | 'worn' | 'next' | null;
export function tileMark(state: WearState): TileMark {
  if (state === 'needs-level' || state === 'listed' || state === 'needs-free-hand') return 'lock';
  return state === 'queued' ? 'next' : state === 'wearing' || state === 'leaving' ? 'worn' : null;
}

/** Whether a piece in this state is locked, and why: the words of `blockedText`. */
export function lockText(owner: OwnerState, item: ItemInstance): string | null {
  return blockedText(wearState(owner, item), item);
}

const round = (value: number) => Math.round(value * 100) / 100;
/** A stat as the card shows it: at most two decimals. */
export const statText = (value: number) => String(round(value));
/** An attack interval in seconds, as the item's own stat lines show it ("1.00 s"). */
export const intervalText = (ms: number) => `${(ms / 1000).toFixed(3).replace(/0$/, '')} s`;

/** One comparison row: the value worn (or worn next) in the slot, the chosen piece's, and the difference. */
export type ComparisonRow = { label: string; before: string; after: string; change: string; tone: 'good' | 'bad' | 'same' };
/** What the card compares: the stat rows, then Load against capacity, and the off-hand piece a two-handed weapon pushes off. */
export type Comparison = {
  rows: ComparisonRow[];
  load: (ComparisonRow & { over: boolean; value: number; capacity: number }) | null;
  /** The off-hand piece that comes off with a two-handed weapon, or null. */
  offHandOff: ItemInstance | null;
  /** The worn off-hand piece that goes back on when a queued two-handed weapon is removed or replaced by a one-handed one, or null. */
  offHandBack: ItemInstance | null;
  /** The chosen piece uses both hands. */
  twoHanded: boolean;
};

/** "+6", "−0.20 s", "=" (a minus sign, not a hyphen), and its tone: `lowerIsBetter` for weight, load and the attack interval. */
function change(before: number | null, after: number | null, lowerIsBetter: boolean, format: (value: number) => string, bothOnly = false) {
  if (bothOnly && (before === null || after === null)) return { change: '', tone: 'same' as const };
  const delta = Math.round(((after ?? 0) - (before ?? 0)) * 1000) / 1000;
  if (delta === 0) return { change: '=', tone: 'same' as const };
  return { change: `${delta > 0 ? '+' : '−'}${format(Math.abs(delta))}`, tone: (delta < 0) === lowerIsBetter ? 'good' as const : 'bad' as const };
}

function numberRow(label: string, before: number | null, after: number | null, lowerIsBetter: boolean, format = statText, bothOnly = false): ComparisonRow {
  return { label, before: before === null ? '–' : format(before), after: after === null ? '–' : format(after), ...change(before, after, lowerIsBetter, format, bothOnly) };
}

const bonusText = (item: ItemInstance | undefined) => (item ? itemStatLines(item).find(([label]) => label === 'Attribute bonuses')?.[1] ?? 'None' : 'None');

/**
 * The load and capacity of `equipment` under the next build's class and points, by the planner's rules (`deriveStats`, RULES_V1). It
 * is worked out for any piece in the bag, a locked one included, so a locked piece still shows what it would weigh; null when the
 * build cannot be derived.
 */
export function equipmentLoad(owner: OwnerState, equipment: Equipment): { load: number; capacity: number } | null {
  const base = owner.pendingBuild?.build ?? owner.currentBuild;
  const { classId, allocations } = fixedClassAndPoints(base, owner.currentBuild);
  const pieces = Object.fromEntries(GEAR_SLOTS.map(slot => [slot, owner.inventory.find(item => item.id === equipment[slot]) ?? null])) as Record<EquipmentSlot, ItemInstance | null>;
  try {
    const stats = deriveStats({ rulesVersion: RULES_V1.version, classId, stance: base.stance, allocations, equipment: pieces }, RULES_V1);
    return { load: stats.load, capacity: stats.loadCapacity };
  } catch { return null; }
}

/**
 * Whether the next slot's build differs from the current one in what the Load heading reads: the gear, or the attribute points (which set
 * the capacity). The class and points are those a gear command sends (`fixedClassAndPoints`); a stance change alone changes neither.
 */
export function nextBuildDiffers(owner: OwnerState): boolean {
  const pending = owner.pendingBuild?.build, current = owner.currentBuild;
  if (!pending) return false;
  const { allocations } = fixedClassAndPoints(pending, current);
  return GEAR_SLOTS.some(slot => pending.equipment[slot] !== current.equipment[slot])
    || (Object.keys(current.allocations) as (keyof typeof current.allocations)[]).some(key => allocations[key] !== current.allocations[key]);
}

/** The operation id of the commands the card only reads the equipment of: they are never sent, so they need no fresh id. */
const COMPARE_ONLY = 'compare-only';

/** The equipment a gear command leaves for the next slot: a cancel-build goes back to what is worn now. */
export const commandEquipment = (owner: OwnerState, command: GearCommand): Equipment => (command.kind === 'queue-build' ? { ...command.equipment } : wornNow(owner));

/**
 * The card's comparison of `choice` (a piece, or null for Remove) with what is worn next in `slot`: Damage, Attack interval and (when
 * either uses both hands) Hands for a weapon, Armor for the rest, Weight, the attribute bonuses when either piece has any, then Load
 * against capacity. The gear after it is the equipment of the command Wear (or Remove) sends, so it names the off-hand piece that comes
 * off with a two-handed weapon, and the one that goes back on when a queued two-handed weapon gives way.
 */
export function compareChoice(owner: OwnerState, slot: EquipmentSlot, choice: ItemInstance | null): Comparison {
  const before = nextEquipment(owner), current = owner.inventory.find(item => item.id === before[slot]);
  const after = commandEquipment(owner, choice ? wearCommand(owner, choice.id, COMPARE_ONLY) : removeCommand(owner, slot, COMPARE_ONLY));
  const chosen = choice ?? undefined;
  const value = (item: ItemInstance | undefined, read: (item: ItemInstance) => number) => (item ? read(item) : null);
  const rows: ComparisonRow[] = [];
  if (slot === 'weapon') {
    rows.push(numberRow('Damage', value(current, item => item.stats.damage), value(chosen, item => item.stats.damage), false));
    rows.push(numberRow('Attack interval', value(current, item => item.stats.intervalMs), value(chosen, item => item.stats.intervalMs), true, intervalText, true));
    if (isTwoHanded(current) || isTwoHanded(chosen)) {
      const hands = (item: ItemInstance | undefined) => (item ? String(CATALOG_V1.items[item.catalogId]?.hands ?? 1) : '–');
      rows.push({ label: 'Hands', before: hands(current), after: hands(chosen), change: '', tone: 'same' });
    }
  } else rows.push(numberRow('Armor', value(current, item => item.stats.armor), value(chosen, item => item.stats.armor), false));
  rows.push(numberRow('Weight', value(current, item => item.stats.weight), value(chosen, item => item.stats.weight), true));
  const bonuses = [bonusText(current), bonusText(chosen)];
  if (bonuses.some(text => text !== 'None')) rows.push({ label: 'Attribute bonuses', before: current ? bonuses[0] : '–', after: chosen ? bonuses[1] : '–', change: '', tone: 'same' });
  const was = equipmentLoad(owner, before), will = equipmentLoad(owner, after);
  const load = was && will ? { ...numberRow('Load', was.load, will.load, true), after: `${statText(will.load)} / ${statText(will.capacity)}`,
    over: will.load > will.capacity, value: will.load, capacity: will.capacity } : null;
  const offHand = (id: string | null) => owner.inventory.find(item => item.id === id) ?? null;
  const off = slot === 'weapon' && before.offHand && !after.offHand ? offHand(before.offHand) : null;
  const back = slot === 'weapon' && !before.offHand && after.offHand ? offHand(after.offHand) : null;
  return { rows, load, offHandOff: off, offHandBack: back, twoHanded: isTwoHanded(chosen) };
}
