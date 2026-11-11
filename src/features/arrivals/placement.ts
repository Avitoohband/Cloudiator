// Where the arrival banner sits on a pointer window. The rail and a standard open menu take the left 458 px
// (66 px of rail and gutter, a 380 px panel, a 12 px gutter), and the corner chip, which is as wide as its name and its figures make it,
// sits at the right with a 12 px margin, over the column of notices (up to 320 px wide, so a narrow chip still has them reach left of it).
// The banner takes the top row when at least 380 px are left between them; otherwise it goes
// under the chip, in the column the notices share, 420 px wide at the right (the touch layout always uses that column, full width).
// If the stacked banner would reach over the measured open panel, the shell keeps the banner back
// while a panel is open, as it does while a scene covers the camp.
//
// Hysteresis: the chip's width follows its figures (the slot countdown every second, the gold, the stamina), so a window within a few
// pixels of the threshold would flip the banner back and forth. It goes under the chip as soon as the room is short, and returns to the top row
// only with `RETURN_SPARE` px more than it needs: 24 px is three digits of the chip's figures (about 8 px each) and more than the 1-2 px a
// window's edge is nudged by.

/** The minimum space kept for the rail, a standard menu, and a gutter. */
export const CLEAR_LEFT = 458;
/** The chip's margin from the window's edge, and the gap kept between it and the banner. */
const CHIP_MARGIN = 12;
const CHIP_GAP = 12;
/** The narrowest top-row banner (its text then takes two lines), and the width of the banner under the chip. */
export const MIN_TOP_WIDTH = 380;
/** The notices' widest box, which hangs under the chip at the right. */
export const NOTICE_WIDTH = 320;
export const UNDER_WIDTH = 420;
/** The room a banner that is under the chip needs beyond the top row's minimum before it returns to the top row. */
export const RETURN_SPARE = 24;

export type BannerPlace = {
  /** Under the chip, in the column with the notices, instead of in the top row. */
  stacked: boolean;
  /** Stacked, it would cover an open menu panel's header: the banner waits while a panel is open. */
  coversPanel: boolean;
};

/** `wasStacked`: the banner is under the chip now (the previous answer), which makes the return to the top row harder. */
export function bannerPlace({ windowWidth, chipWidth, compact, panelClearLeft = CLEAR_LEFT, wasStacked = false }: { windowWidth: number; chipWidth: number; compact: boolean; panelClearLeft?: number; wasStacked?: boolean }): BannerPlace {
  if (compact) return { stacked: true, coversPanel: false };
  // Centred on the window once there is room, else held clear of the panel (the slot uses the same measured panel boundary in CSS).
  const left = Math.max(panelClearLeft, windowWidth / 2 - 280);
  const room = windowWidth - CHIP_MARGIN - Math.max(chipWidth, NOTICE_WIDTH) - CHIP_GAP - left;
  if (room >= MIN_TOP_WIDTH + (wasStacked ? RETURN_SPARE : 0)) return { stacked: false, coversPanel: false };
  const underLeft = windowWidth - CHIP_MARGIN - Math.min(UNDER_WIDTH, windowWidth - 2 * CHIP_MARGIN);
  return { stacked: true, coversPanel: underLeft < panelClearLeft };
}
