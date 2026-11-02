// The away button on the camp (Patch A item 3, the approved mockup and the spec's "The button on the camp"): the pure core. While the
// owner's own expedition runs, the button says where the gladiator is and offers the live view; once it is back, it offers the whole trip
// with the owner's own result, until the slot after the trip ends or until the player closes it. Nothing here reads, draws or stores
// anything but the closed trips: the shell hands in what it knows (the owner's current activity, the destination its world actor
// names, the latest settled trip of the owner's notifications, whether its own timeline shows a lost fight) and gets the state, its
// words and the scene it opens.
//
// `AwayState` is a union on `kind`, and every consumer switches on it (the words, the scene, the progress): a new state (the Arena
// bout of patch 1.5) is a new member, a new case in `awayText` and `awayScene`, and the compiler names what is missing.
import type { GameNotification, OwnerState } from '@contracts/reads';
import type { RevealedTimeline } from '@contracts/events';
import { RULES_V1 } from '@domain/rules-v1';
import { boutEndMs } from '../../game/replay';
import { ratingText } from '../bouts/bout-text';
import type { SceneView } from './scene-url';

/** The device key: a JSON array of the activity ids whose "back" button was closed, the newest 50. */
export const TRIP_CLOSED_KEY = 'cloudiator.trip-closed.v1';
const KEEP = 50;
const SLOT_MS = RULES_V1.clock.slotMs;
const MINUTE_MS = 60_000;
/** An expedition fills one slot: minutes of it, and the minutes at which its fights start. */
const TRIP_MINUTES = SLOT_MS / MINUTE_MS;
const FIGHT_MINUTES = [20, 40, 60] as const;

export type AwayState =
  | { kind: 'running'; activityId: string; name: string; destination: string | null; minute: number; nextFight: 20 | 40 | 60 | null }
  | { kind: 'back'; activityId: string; name: string; destination: string | null; result: 'success' | 'defeat' | 'processing'; rewards: { money: number; xp: number } | null }
  | { kind: 'bout'; activityId: string; name: string; opponent: string; won: boolean; rewards: { renown: number; ratingDelta: number | null } | null };

const slotOf = (ms: number) => Math.floor(ms / SLOT_MS);

/** A revealed owner's bout, from its logged end until the end of the following slot. */
export function boutAway({ owner, timeline, nowMs, closed }: {
  owner: Pick<OwnerState, 'name' | 'gladiatorId'>; timeline: RevealedTimeline | null; nowMs: number; closed: ReadonlySet<string>;
}): AwayState | null {
  if (!timeline || closed.has(timeline.activityId)) return null;
  const stage = timeline.stages.find(s => s.kind === 'bout' && s.revealedAtMs <= nowMs
    && s.battleLog?.participants.some(p => p.gladiatorId === owner.gladiatorId));
  if (!stage?.battleLog || nowMs < boutEndMs(stage) || nowMs >= (slotOf(stage.startedAtMs) + 2) * SLOT_MS) return null;
  const me = stage.battleLog.participants.find(p => p.gladiatorId === owner.gladiatorId)!;
  const opponent = stage.battleLog.participants.find(p => p.id !== me.id)!;
  const summary = timeline.summary?.activityId === timeline.activityId && timeline.summary.settledAtMs <= nowMs ? timeline.summary : null;
  return { kind: 'bout', activityId: timeline.activityId, name: owner.name, opponent: opponent.name, won: stage.battleLog.winnerId === me.id,
    rewards: summary ? { renown: summary.rewards.renown, ratingDelta: summary.ratingDelta ?? null } : null };
}

/** The back state of a trip whose result the owner's notifications hold; `destination` is the trip's own, else the one the caller knows. */
const settled = (name: string, trip: GameNotification, fallback: string | null): AwayState => ({ kind: 'back', activityId: trip.activityId, name,
  destination: trip.destination ?? fallback, result: trip.summary.success ? 'success' : 'defeat', rewards: { money: trip.summary.rewards.money, xp: trip.summary.rewards.xp } });

/**
 * What the button shows, or null for nothing.
 *
 * - Running: the owner's current activity is an expedition and `startsAtMs <= now < endsAtMs`. The minute is whole (rounded down); the
 *   next fight is the next of minutes 20, 40 and 60 above it, and none from minute 60 or once the owner's own timeline shows a lost
 *   fight (`defeated`: the gladiator is on its way back and nothing more will be fought).
 * - Back: the current activity is an expedition at or after its end (`processing` until its own result is in `latestTrip`), or
 *   `latestTrip`, the newest settled expedition of the owner's notifications, settled in the display clock's current slot. Never once
 *   the player has closed that activity, and never after the slot that follows the trip.
 *
 * `destination` is the expedition the owner's world actor names (null when it names none): it is the running trip's, and the fallback
 * of a trip whose own notification names none.
 */
export function awayState(input: {
  owner: Pick<OwnerState, 'name' | 'currentActivity'>; destination: string | null; nowMs: number;
  latestTrip: GameNotification | null; defeated: boolean; closed: ReadonlySet<string>;
}): AwayState | null {
  const { owner, destination, nowMs, latestTrip, defeated, closed } = input;
  const current = owner.currentActivity;
  const trip = latestTrip?.kind === 'expedition' ? latestTrip : null;
  if (current?.kind === 'expedition') {
    if (current.startsAtMs <= nowMs && nowMs < current.endsAtMs) {
      const minute = Math.floor((nowMs - current.startsAtMs) / MINUTE_MS);
      const nextFight = defeated ? null : FIGHT_MINUTES.find(fight => fight > minute) ?? null;
      return { kind: 'running', activityId: current.id, name: owner.name, destination, minute, nextFight };
    }
    if (current.endsAtMs <= nowMs && nowMs < current.endsAtMs + SLOT_MS) {
      if (closed.has(current.id)) return null;
      if (trip?.activityId === current.id) return settled(owner.name, trip, destination);
      return { kind: 'back', activityId: current.id, name: owner.name, destination, result: 'processing', rewards: null };
    }
  }
  if (trip && slotOf(trip.settledAtMs) === slotOf(nowMs) && !closed.has(trip.activityId)) return settled(owner.name, trip, destination);
  return null;
}

export type AwayText = { name: string; title: string; sub: string; action: string };

/** "the Woodland Path", or "an expedition" where the destination is not known. */
const place = (destination: string | null) => (destination ? `the ${destination}` : 'an expedition');

/**
 * The words of the button: the gladiator's name (shown in bold), the rest of the title, the line under it and the action. `compact`
 * is the phone's shorter wording. The currency is said as gold, the player-facing word for the `money` fields.
 */
export function awayText(state: AwayState, compact: boolean): AwayText {
  switch (state.kind) {
    case 'bout': {
      const rating = state.rewards?.ratingDelta ? ratingText(state.rewards.ratingDelta) : '';
      const renown = state.rewards?.renown ? `+${state.rewards.renown} renown` : '';
      const sub = !state.rewards ? compact ? 'Rewards at minute 80' : 'Rewards are credited at minute 80'
        : compact ? rating || renown || 'No rewards' : [renown, rating].filter(Boolean).join(' · ') || 'No rewards';
      return { name: state.name, title: ` ${state.won ? 'beat' : 'lost to'} ${state.opponent}${compact ? '' : ' in the Arena'}`,
        sub, action: compact ? '▶ Watch' : '▶ Watch the bout' };
    }
    case 'running': {
      const minute = `Minute ${state.minute} of ${TRIP_MINUTES}`;
      return {
        name: state.name,
        title: compact ? ` · ${state.destination ?? 'on an expedition'}` : ` is on ${place(state.destination)}`,
        sub: compact ? minute : `${minute} · ${state.nextFight === null ? `back at minute ${TRIP_MINUTES}` : `next fight at minute ${state.nextFight}`}`,
        action: compact ? '● Live' : '● Watch live',
      };
    }
    case 'back': {
      const lostTrip = state.result === 'defeat';
      const title = compact
        ? lostTrip ? ' · back after a defeat' : state.destination ? ` · back from ${state.destination}` : ' · back'
        : lostTrip ? ` is back after a defeat on ${place(state.destination)}` : ` is back from ${place(state.destination)}`;
      const sub = state.result === 'processing' ? 'Processing results…'
        : lostTrip ? 'No rewards · all gear kept'
          : ['Success', state.rewards?.money ? `+${state.rewards.money} gold` : null, state.rewards?.xp ? `+${state.rewards.xp} XP` : null]
            .filter((part): part is string => part !== null).join(' · ');
      return { name: state.name, title, sub, action: compact ? '▶ Replay' : '▶ Watch the whole trip' };
    }
  }
}

/** The scene the button opens: the live view while the trip runs, the whole-trip replay once it is over. */
export function awayScene(state: AwayState): SceneView {
  switch (state.kind) {
    case 'running': return { kind: 'expedition', activityId: state.activityId };
    case 'back': return { kind: 'expedition', activityId: state.activityId, play: 'trip' };
    case 'bout': return { kind: 'replay', activityId: state.activityId };
  }
}

/** The fraction (0 to 1) of the trip the thin progress bar fills, or null for a state that has none (a trip that is over). */
export function awayProgress(state: AwayState): number | null {
  switch (state.kind) {
    case 'running': return Math.min(1, state.minute / TRIP_MINUTES);
    case 'back': case 'bout': return null;
  }
}

/** What this page has closed, oldest first: the answer where the device's storage cannot hold it. */
let memory: string[] = [];

/** The stored ids, or null when storage throws or holds anything but a list. */
function readStored(): string[] | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TRIP_CLOSED_KEY) ?? 'null');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : null;
  } catch { return null; }
}

/** Every activity whose button was closed: what this device stores and what this page remembers. */
export function readClosedTrips(): Set<string> {
  return new Set([...(readStored() ?? []), ...memory]);
}

/** Remembers `activityId` as closed: kept in memory first, then stored (the newest 50) if the device lets it. Never throws. */
export function closeTrip(activityId: string): void {
  memory = [...new Set([...(readStored() ?? []), ...memory, activityId])].slice(-KEEP);
  try { localStorage.setItem(TRIP_CLOSED_KEY, JSON.stringify(memory)); } catch { /* Private mode or blocked site data: the page's own memory answers. */ }
}
