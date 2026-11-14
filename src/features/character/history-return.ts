// Patch 1.9 Task 32: where a gladiator's History was when a replay was opened from it, so Back from the replay reopens the card on the same
// page. The card closes while a scene covers the camp and its store is new when it reopens, so the row opened is kept here for one return:
// taken once by the History it belongs to (the same gladiator and chip), else forgotten. A reload forgets it (the card then opens on page 1).
let remembered: { gladiatorId: string; kind: string; entryId: string } | null = null;

/** The History row whose replay was just opened. */
export function rememberHistoryRow(gladiatorId: string, kind: string, entryId: string): void {
  remembered = { gladiatorId, kind, entryId };
}

/** The row to land on when `gladiatorId`'s History opens on `kind` again; gone once taken (or when it belongs to another card). */
export function takeHistoryRow(gladiatorId: string, kind: string): string | null {
  const found = remembered && remembered.gladiatorId === gladiatorId && remembered.kind === kind ? remembered.entryId : null;
  remembered = null;
  return found;
}
