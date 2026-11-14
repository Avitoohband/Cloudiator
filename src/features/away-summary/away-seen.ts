/** Visit timestamps use estimated server time, keyed by gladiator on this device. */
export const AWAY_SEEN_KEY = 'cloudiator.away-seen.v1';

const memory = new Map<string, number>();
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function readStored(): Map<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(AWAY_SEEN_KEY) ?? '{}');
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return new Map(Object.entries(parsed).filter((entry): entry is [string, number] => validTime(entry[1])));
    }
  } catch { /* Storage is unavailable. Keep the current page's memory. */ }
  return new Map();
}

function remember(id: string, time: number): void {
  memory.set(id, Math.max(memory.get(id) ?? 0, time));
}

/** Keep an advance observed from another tab even if device storage later fails. */
export function readAwaySeen(gladiatorId: string): number | null {
  const stored = readStored().get(gladiatorId);
  if (stored !== undefined) remember(gladiatorId, stored);
  return memory.get(gladiatorId) ?? null;
}

export function writeAwaySeen(gladiatorId: string, serverMs: number): void {
  const time = Math.floor(serverMs);
  if (!validTime(time)) return;
  const stored = readStored();
  const previous = stored.get(gladiatorId);
  const next = Math.max(time, memory.get(gladiatorId) ?? 0, previous ?? 0);
  memory.set(gladiatorId, next);
  if (previous === next) return;

  for (const [id, seen] of memory) stored.set(id, Math.max(stored.get(id) ?? 0, seen));
  try { localStorage.setItem(AWAY_SEEN_KEY, JSON.stringify(Object.fromEntries(stored))); } catch { /* The current page still remembers. */ }
}

/** Tests only. A reload starts with a fresh page's memory. */
export function resetAwaySeenMemory(): void {
  memory.clear();
}