// A new player is announced (Patch A item 2). A newcomer is a gladiator whose public actor is in orientation (from its creation
// until its first boundary, at most one slot) and not resting at home; the shared world already says so, so nothing is stored on the
// account. Everyone in the camp (a visitor too) sees one banner for the newcomers they have not yet been told about on this device;
// the newcomer's own player is welcomed first. The words are the approved mockup copy. The announced ids are kept on this device
// only, behind try/catch, with the page's own memory as the fallback when storage throws (private mode, blocked site data).
import type { PublicActor } from '@contracts/reads';
import { isNewcomer } from '../../game/actors';
import { title } from '../character/actor-text';

/** The device key: a JSON array of the announced gladiator ids, the newest 200. */
export const ARRIVALS_KEY = 'cloudiator.arrivals-seen.v1';
const KEEP = 200;

export type ArrivalBanner = {
  /** `welcome` is the newcomer's own player's, `arrival` everyone else's. */
  kind: 'arrival' | 'welcome';
  /** The gladiators this banner announces; they are remembered when it closes. */
  ids: string[];
  /** The gladiator Find goes to: the newest arrival, or the player's own. */
  findId: string;
  findName: string;
  text: string;
  /** The phone's sentence (it drops "in the camp" from a single arrival). */
  narrowText: string;
};

/** The newcomers among `actors`: the newest `startsAtMs` first, ties by name. */
export function newcomers(actors: readonly PublicActor[]): PublicActor[] {
  return actors.filter(isNewcomer).sort((a, b) => (b.startsAtMs ?? 0) - (a.startsAtMs ?? 0) || a.name.localeCompare(b.name));
}

/**
 * The banner for the newcomers not yet in `seen`, or null. The newcomer's own player (`ownerId`) is welcomed alone first; once that
 * is seen, or for anyone else, every unseen newcomer shares one banner: a single arrival with its class, two by name, more as
 * "{first} and {n} others". The first named is the newest, and Find goes to them.
 */
export function arrivalBanner(actors: readonly PublicActor[], seen: ReadonlySet<string>, ownerId: string | null): ArrivalBanner | null {
  const unseen = newcomers(actors).filter(a => !seen.has(a.gladiatorId));
  if (unseen.length === 0) return null;
  const own = ownerId === null ? undefined : unseen.find(a => a.gladiatorId === ownerId);
  if (own) {
    const text = `Welcome to the camp, ${own.name}! Everyone here has been told you arrived.`;
    return { kind: 'welcome', ids: [own.gladiatorId], findId: own.gladiatorId, findName: own.name, text, narrowText: text };
  }
  const [first, second] = unseen;
  const common = { kind: 'arrival' as const, ids: unseen.map(a => a.gladiatorId), findId: first.gladiatorId, findName: first.name };
  if (unseen.length === 1) {
    const who = `${first.name}, a new ${title(first.classId)}, has arrived`;
    return { ...common, text: `${who} in the camp. Say hello at the gate!`, narrowText: `${who}. Say hello at the gate!` };
  }
  const text = unseen.length === 2 ? `${first.name} and ${second.name} have arrived in the camp.`
    : `${first.name} and ${unseen.length - 1} others have arrived in the camp.`;
  return { ...common, text, narrowText: text };
}

/** What this page has remembered, oldest first: the answer where the device's storage cannot hold it. */
let memory: string[] = [];

/** The stored ids, or null when storage throws or holds anything but a list of ids. */
function readStored(): string[] | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ARRIVALS_KEY) ?? 'null');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : null;
  } catch { return null; }
}

/** Every announced id: what this device stores and what this page remembers. */
export function readSeenArrivals(): Set<string> {
  return new Set([...(readStored() ?? []), ...memory]);
}

/** Remembers `ids` as announced: kept in memory first, then stored (the newest 200) if the device lets it. Never throws. */
export function rememberArrivals(ids: readonly string[]): void {
  memory = [...new Set([...(readStored() ?? []), ...memory, ...ids])].slice(-KEEP);
  try { localStorage.setItem(ARRIVALS_KEY, JSON.stringify(memory)); } catch { /* Private mode or blocked site data: the page's own memory answers. */ }
}
