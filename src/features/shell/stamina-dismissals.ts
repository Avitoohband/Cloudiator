// Patch 1.9 Task 29 addition: which stamina notices the player dismissed, by gladiator and slot index, kept across a reload on this device.
// `next` is the notice before the next slot (it will not run), `now` the pop-up while the running slot rests instead. A dismissal lasts for
// its slot only. The device's storage may be missing, blocked or hold garbage: every read and write is guarded, and the page's own memory
// answers then (for the page's life). Only the newest 20 slots of each list are kept and old slots are pruned against server time.
export const STAMINA_DISMISSED_KEY = 'cloudiator.stamina-dismissed.v1';
const KEEP = 20;
export type NoticeKind = 'next' | 'now';
type Stored = Record<string, Partial<Record<NoticeKind, number[]>>>;

let memory: Stored = {};

function readStored(): Stored {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STAMINA_DISMISSED_KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Stored = {};
    for (const [id, lists] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof lists !== 'object' || lists === null || Array.isArray(lists)) continue;
      const entry: Partial<Record<NoticeKind, number[]>> = {};
      for (const kind of ['next', 'now'] as const) {
        const list = (lists as Record<string, unknown>)[kind];
        if (Array.isArray(list)) entry[kind] = list.filter((slot): slot is number => Number.isSafeInteger(slot));
      }
      out[id] = entry;
    }
    return out;
  } catch { return {}; }
}

/** The slots whose `kind` notice this gladiator's player dismissed: what the device stored and what this page remembers. */
export function readDismissedSlots(gladiatorId: string, kind: NoticeKind): Set<number> {
  return new Set([...(readStored()[gladiatorId]?.[kind] ?? []), ...(memory[gladiatorId]?.[kind] ?? [])]);
}

/** Remembers `slot` as dismissed for this gladiator's `kind` notice: in memory first, then stored if the device lets it. Never throws. */
export function dismissSlot(gladiatorId: string, kind: NoticeKind, slot: number): void {
  const stored = readStored();
  const slots = [...new Set([...readDismissedSlots(gladiatorId, kind), slot])].sort((a, b) => a - b).slice(-KEEP);
  memory = { ...memory, [gladiatorId]: { ...memory[gladiatorId], [kind]: slots } };
  try { localStorage.setItem(STAMINA_DISMISSED_KEY, JSON.stringify({ ...stored, [gladiatorId]: { ...stored[gladiatorId], [kind]: slots } })); } catch { /* No storage: the page's memory answers. */ }
}

function withoutExpiredSlots(stored: Stored, oldest: number): Stored {
  const kept: Stored = {};
  for (const [gladiatorId, lists] of Object.entries(stored)) {
    const next = lists.next?.filter(slot => slot >= oldest);
    const now = lists.now?.filter(slot => slot >= oldest);
    if (next?.length || now?.length) kept[gladiatorId] = { ...(next?.length ? { next } : {}), ...(now?.length ? { now } : {}) };
  }
  return kept;
}

/** Keep the preceding slot for another tab that is still crossing the boundary. */
export function pruneDismissedSlots(confirmedSlot: number): void {
  if (!Number.isSafeInteger(confirmedSlot) || confirmedSlot < 0) return;
  const oldest = Math.max(0, confirmedSlot - 1);
  memory = withoutExpiredSlots(memory, oldest);
  const stored = readStored();
  const next = JSON.stringify(withoutExpiredSlots(stored, oldest));
  if (next === JSON.stringify(stored)) return;
  try { localStorage.setItem(STAMINA_DISMISSED_KEY, next); } catch { /* The page's memory still answers. */ }
}

/** Tests only: forget this page's memory (a reload). */
export function resetDismissalMemory(): void { memory = {}; }
