// How a battle replay gets its gladiators' looks. The replay finds each gladiator's chosen look by id from the public
// actor reads; the battle scene is built once from whatever has arrived by then and never re-skins, so the replay
// waits for the looks (at most 1.5 s) before it mounts the scene, and on a failure or a timeout draws the legacy look.
// Pure (no React, no Phaser, no network): the viewport host runs `loadLooks`, a gateway supplies the reader.
import type { BattleLog } from '@contracts/events';
import { validAppearance, type Appearance } from '@domain/appearance';

/** A gladiator's chosen look by gladiator id; null is the legacy look, and an id that is absent is not known (also drawn as legacy). */
export type LookMap = ReadonlyMap<string, Appearance | null>;
/** Reads the looks of the given gladiators (one batched public read); an id it cannot find is left out of the answer. */
export type LookReader = (ids: readonly string[]) => Promise<LookMap>;
/** What a replay may be given: the looks its caller already holds, and a reader for the rest. Without a reader the rest are legacy. */
export type LookSource = { known?: LookMap | null; read?: LookReader | null };

/** The longest a replay waits for its fighters' looks before it mounts with the legacy look for the rest. */
export const LOOKS_TIMEOUT_MS = 1500;
/** A battle has two participants; a caller may pass a few more. Anything beyond is not read. */
export const MAX_LOOK_IDS = 16;

/**
 * The gladiators in the given battles (a replay's, an expedition's encounters), once each: an NPC fallback or a creature has no
 * gladiator id and keeps its own art.
 */
export function lookIdsFor(...logs: readonly Pick<BattleLog, 'participants'>[]): string[] {
  const ids = new Set<string>();
  for (const log of logs) for (const p of log.participants) if (p.gladiatorId) ids.add(p.gladiatorId);
  return [...ids];
}

/**
 * The looks of world actors a caller already holds. An actor from before M24 (or a cached one) has no `appearance` key, and
 * an invalid one is not drawn from either: both are the legacy look (null), which is also what `lookFor` draws.
 */
export function appearancesOf(actors: readonly { gladiatorId: string; appearance?: unknown }[] | null | undefined): Map<string, Appearance | null> {
  const looks = new Map<string, Appearance | null>();
  for (const actor of actors ?? []) looks.set(actor.gladiatorId, validAppearance(actor.appearance) ? actor.appearance : null);
  return looks;
}

/**
 * Settles the looks of `ids` for one replay, once: `onSettled` is called a single time with the looks that are known, those
 * `read` returned and nothing for the rest, as soon as they are in (never waiting on ids the caller already `known`), when the
 * read fails (at once), or after `timeoutMs`, whichever comes first. A late answer is dropped, so the scene never changes look
 * mid-play. `cancel` (the viewport unmounted) drops the result and clears the timeout. It never throws.
 */
export function loadLooks({ ids, known, read, timeoutMs = LOOKS_TIMEOUT_MS, onSettled }: LookSource & {
  ids: readonly string[]; timeoutMs?: number; onSettled: (looks: LookMap) => void;
}): { cancel(): void } {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wanted = [...new Set(ids)].slice(0, MAX_LOOK_IDS);
  const have = new Map<string, Appearance | null>();
  for (const id of wanted) if (known?.has(id)) have.set(id, validAppearance(known.get(id)) ? known.get(id)! : null);
  const missing = wanted.filter(id => !have.has(id));
  const settle = (answer?: LookMap) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    const looks = new Map(have);
    // Only what was asked for, each as a valid look or the legacy one.
    if (answer) for (const id of missing) if (answer.has(id)) looks.set(id, validAppearance(answer.get(id)) ? answer.get(id)! : null);
    onSettled(looks);
  };
  const cancel = () => { done = true; clearTimeout(timer); };
  if (!missing.length || !read) {
    queueMicrotask(() => settle());
    return { cancel };
  }
  timer = setTimeout(() => settle(), timeoutMs);
  // Asked one tick later, so a load cancelled at once (a development remount of the effect) never sends a read.
  Promise.resolve().then(() => (done ? undefined : read(missing))).then(settle, () => settle());
  return { cancel };
}
