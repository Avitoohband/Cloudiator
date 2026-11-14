// Patch 1.9 Task 32: where a gladiator's History was when a replay was opened from it, so Back from the replay reopens the card on the same
// page. The card closes while a scene covers the camp and its store is new when it reopens, so the row opened is kept here for one return:
// taken once by the History it belongs to (the same gladiator and chip), else forgotten. A reload forgets it (the card then opens on page 1).
let remembered: { gladiatorId: string; kind: string; entryId: string; owner: unknown } | null = null;

/** The History row whose replay was just opened. */
export function rememberHistoryRow(gladiatorId: string, kind: string, entryId: string, owner: unknown = null): void {
  remembered = { gladiatorId, kind, entryId, owner };
}

/** Forgets the marker if `owner` made it: that History came back by itself (it stayed mounted under the replay), so no new one should read it. */
export function clearHistoryRow(owner: unknown): void {
  if (remembered && remembered.owner === owner) remembered = null;
}

/** The row to land on when `gladiatorId`'s History opens on `kind` again; gone once taken (or when it belongs to another card). */
export function takeHistoryRow(gladiatorId: string, kind: string): string | null {
  const found = remembered && remembered.gladiatorId === gladiatorId && remembered.kind === kind ? remembered.entryId : null;
  remembered = null;
  return found;
}

/** A landing the History is working towards: the row and the chip it belongs to. */
export type Landing = { kind: string; entryId: string };

/**
 * What the landing does next, given the rows read so far. `done`: forget it (the row is not on this chip's list, or the list ended without it);
 * `failed`: forget it, and say so (the read for it failed); `jump`: turn to the row's index; `read`: read the next server page first (the row is
 * further down, or on the partly read last page).
 * A row already on page 1 (rows shown even when the first page is partly read) counts as loaded.
 */
export function landingStep(landing: Landing, state: { kind: string; ids: readonly string[]; hasMore: boolean; failed: boolean; size: number }):
  { step: 'done' } | { step: 'failed' } | { step: 'jump'; index: number } | { step: 'read' } {
  if (landing.kind !== state.kind) return { step: 'done' };
  const index = state.ids.indexOf(landing.entryId);
  const whole = Math.floor(state.ids.length / state.size) * state.size;
  const loaded = Math.max(whole, Math.min(state.ids.length, state.size));
  if (index >= 0 && (!state.hasMore || index < loaded)) return { step: 'jump', index };
  if (!state.hasMore) return { step: 'done' };
  return state.failed ? { step: 'failed' } : { step: 'read' };
}
