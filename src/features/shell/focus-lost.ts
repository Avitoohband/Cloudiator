// Task 23.5: whether the focus has lost its place, so a panel may move it to a command's outcome. It has when it is on
// <body> (its control left the page), on a disabled control (a button disabled while its command was sent), or on the
// menu panel itself (where `useFocusRescue` put it when its control left). A focus the player moved elsewhere is kept.
export function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active.matches(':disabled, [data-menu-surface]');
}

/**
 * After a trade (a purchase, a sale, a listing, a cancellation or a discard), its outcome takes the focus unless the player
 * has moved it out of the panel meanwhile: the control that sent it has often left (the bought row, the sold item), and
 * a screen reader then reads the receipt or the reason where the player is (Task 23.5, C18).
 */
export function focusOutcome(panel: HTMLElement | null, outcome: HTMLElement | null) {
  if (!outcome) return;
  const active = document.activeElement;
  if (focusLost() || (panel && active && panel.contains(active))) outcome.focus();
}
