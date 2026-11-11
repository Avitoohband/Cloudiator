// Patch 1.9, Task 11 (Avi approved the Settings mockup, 2026-11-11): which names and titles the camp draws over heads, by the
// Settings panel's two three-way choices, and the "Tidy" rule for names that overlap.
//
// Names: Off draws none at all, your own selected gladiator's included (its profile card names it). When zoomed in is the
// camp before Patch 1.9: gladiators' names from zoom 1.4, NPCs' from zoom 2, and a selected or followed gladiator's at any
// zoom. Always draws every name at any zoom, zoomed out too, where a name keeps the size it has at zoom 1.
// Titles (a worn title in gold italics over the name) never show without their name: Off none, When zoomed in from zoom 2
// (and a selected or followed gladiator's), Always with every name that shows.
// Tidy: the nearer name wins (lower on screen is nearer); a name that would overlap one already drawn fades to 30%. Your own
// gladiator, a selected or followed one and the NPC that is talking are drawn first and never fade; hovering a gladiator
// brings its name back at full strength, on top (the scene does that part).

export type LabelMode = 'off' | 'zoom' | 'always';
export type LabelPrefs = { names: LabelMode; titles: LabelMode };
/** The choices in the order the Settings panel shows them. */
export const LABEL_MODES: readonly LabelMode[] = ['off', 'zoom', 'always'];
/** When zoomed in, for both: the camp as it was before the choice existed. */
export const DEFAULT_LABEL_PREFS: LabelPrefs = { names: 'zoom', titles: 'zoom' };
/** When zoomed in: gladiators' names from this zoom. */
export const NAME_ZOOM = 1.4;
/** When zoomed in: NPCs' names, and titles, from this zoom. */
export const CLOSE_ZOOM = 2;
/** A name Tidy fades behind a nearer one. */
export const FADED_LABEL_ALPHA = 0.3;

/** Who wears the label: an ambient NPC, whether it is selected or followed, and whether it wears a title. */
export type LabelSubject = { npc: boolean; focused: boolean; hasTitle: boolean };

/** Whether `subject`'s name and title show at camera `zoom`. */
export function labelsShown(subject: LabelSubject, zoom: number, prefs: LabelPrefs): { name: boolean; title: boolean } {
  const name = prefs.names === 'always' ? true
    : prefs.names === 'zoom' ? (subject.npc ? zoom >= CLOSE_ZOOM : zoom >= NAME_ZOOM || subject.focused)
      : false;
  const title = name && subject.hasTitle && (prefs.titles === 'always' || (prefs.titles === 'zoom' && (zoom >= CLOSE_ZOOM || subject.focused)));
  return { name, title };
}

/** The scale a name and title are drawn at: with Always and the camera zoomed out, the size they have at zoom 1. */
export function labelScale(zoom: number, prefs: LabelPrefs): number {
  return prefs.names === 'always' && zoom < 1 ? 1 / zoom : 1;
}

/** A shown name (with its title), as a box with its top-left corner, and how near it stands (its feet's screen y). */
export type TidyItem = { x: number; y: number; width: number; height: number; depth: number; pinned: boolean };

/**
 * Tidy: writes into `faded[i]` whether name `i` fades, and returns how many do. Pinned names come first, then the nearer
 * (greater depth) before the farther; each name that overlaps one already kept fades, and a faded name blocks nothing.
 * Names that only touch, within `tolerance` (in the boxes' units), both stay. `order` is a reused scratch array.
 */
export function tidyLabels(items: readonly TidyItem[], faded: boolean[], tolerance = { x: 1, y: 2 }, order: number[] = []): number {
  order.length = 0;
  for (let i = 0; i < items.length; i += 1) order.push(i);
  order.sort((a, b) => Number(items[b].pinned) - Number(items[a].pinned) || items[b].depth - items[a].depth || a - b);
  let count = 0;
  for (let k = 0; k < order.length; k += 1) {
    const i = order[k];
    const p = items[i];
    let hit = false;
    for (let m = 0; m < k && !hit && !p.pinned; m += 1) {
      const j = order[m];
      if (faded[j]) continue;
      const q = items[j];
      hit = q.x < p.x + p.width - tolerance.x && p.x < q.x + q.width - tolerance.x
        && q.y < p.y + p.height - tolerance.y && p.y < q.y + q.height - tolerance.y;
    }
    faded[i] = hit;
    if (hit) count += 1;
  }
  return count;
}
