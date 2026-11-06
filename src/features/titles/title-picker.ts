// The rows of "Choose your title" (patch 1.7, spec "The picker" and "Progress"; the approved mockup, section 4): the titles by family in
// the catalog's order, Earned (the titles held) or All (the titles shown: 31, or one more for a holder of a hand-given title, a locked one with its progress), the counts on the two buttons,
// and the status line after a wear. Held ids this client does not know are shown nowhere (Review Focus 1); a counter the owner read
// leaves out counts 0 (`progressText`).
import type { OwnerState } from '@contracts/reads';
import { TITLES_V1, TITLE_FAMILIES, titleById } from '@domain/titles';
import { progressShare, progressText, titleName } from './title-text';

export type PickerRow = { id: string; name: string; rule: string; earned: boolean; progress: string | null; share: number };
export type PickerGroup = { family: string; rows: PickerRow[] };

/** The "Wear nothing" choice's line. */
export const NO_TITLE_LINE = 'Show your name only.';
/** All's last line: the titles of the later patches. */
export const LATER_TITLES = '8 more arrive later: 4 with party dungeons, 2 in the Deep, Outfitter with the new gear, and Legend-Bearer if a Legendary rarity ever comes.';

/** The titles this owner sees: all of them, but a hand-given (`award`) one only when held (patch 1.7.1). */
const shownTo = (held: ReadonlySet<string>) => TITLES_V1.filter(title => title.measure !== 'award' || held.has(title.id));

/** The ids of the 1.7 titles the owner holds. */
const heldIds = (owner: Pick<OwnerState, 'titles'>): Set<string> => new Set(owner.titles.map(title => title.id).filter(id => titleById(id) !== null));

/**
 * The families in the picker's order (empty ones left out), each with its titles in the catalog's order: in `'earned'` the titles held, in
 * `'all'` every 1.7 title. An earned row has no progress and a full bar; a locked one its progress line and bar.
 */
export function pickerGroups(owner: Pick<OwnerState, 'titles' | 'titleProgress' | 'progression'>, view: 'earned' | 'all'): PickerGroup[] {
  const held = heldIds(owner);
  const progress = owner.titleProgress ?? {};
  return TITLE_FAMILIES.map(family => ({
    family: family.name,
    rows: shownTo(held).filter(title => title.family === family.id && (view === 'all' || held.has(title.id))).map(title => {
      const earned = held.has(title.id);
      return { id: title.id, name: title.name, rule: title.rule, earned, progress: earned ? null : progressText(title, progress, owner.progression.level),
        share: earned ? 1 : progressShare(title, progress) };
    }),
  })).filter(group => group.rows.length > 0);
}

/** The numbers on Earned and All: the titles held, and the titles shown (31 for most players; a hand-given title counts for its holder). */
export function pickerCounts(owner: Pick<OwnerState, 'titles'>): { earned: number; all: number } {
  return { earned: heldIds(owner).size, all: shownTo(heldIds(owner)).length };
}

/** The status line after a wear: "You now wear {name}." or "You now wear no title." (an id this client does not know is none). */
export function wornStatus(id: string | null): string {
  const name = titleName(id);
  return name === null ? 'You now wear no title.' : `You now wear ${name}.`;
}
