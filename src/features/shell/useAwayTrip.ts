'use client';

// What the away button shows now (Patch A item 3), from what the shell already has and the two owner reads the button needs:
//  - the owner's settled results (`reads.notifications()`), for the "back" button's own result. It is read when the owner's current
//    activity changes or its count of unseen results does (the key), and only the latest read lands: a slower earlier read, answered
//    after a newer one, never replaces it;
//  - the owner's own timeline of a trip that is running (`reads.timeline()`), because the public actor carries no stage: it says
//    whether a fight was lost, so the sub-line stops promising a next fight. It is read when the button appears and once after each
//    fight's minute (minutes 21, 41 and 61, a minute after the fight starts, which has ended and been published by then), latest only.
// Both are the owner's: nothing is read for a visitor or an account with no gladiator. A failed read leaves the button as it was.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RevealedTimeline } from '@contracts/events';
import type { GameNotification, OwnerState, WorldSnapshot } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import type { GameGateway } from '../../lib/api/gateway';
import { renderExpeditionStage } from '../../game/expedition-stage';
import { awayState, closeTrip, readClosedTrips, type AwayState } from './away-trip';

const MINUTE_MS = 60_000;
/** The expedition the owner's world actor is on (`expedition:woodland`), by its catalog name; null when it is on none. */
function destinationOf(world: WorldSnapshot | null, gladiatorId: string | null): string | null {
  const location = world?.actors.find(actor => actor.gladiatorId === gladiatorId)?.location;
  const id = location?.startsWith('expedition:') ? location.slice('expedition:'.length) : null;
  return id !== null && Object.hasOwn(CATALOG_V1.expeditions, id) ? CATALOG_V1.expeditions[id as keyof typeof CATALOG_V1.expeditions].name : null;
}

export function useAwayTrip({ reads, owner, world, nowMs }: {
  reads: Pick<GameGateway, 'notifications' | 'timeline'> | null;
  /** The signed-in player's owner state, or null (a visitor, no gladiator yet, still loading). */
  owner: OwnerState | null;
  world: WorldSnapshot | null;
  /** The display clock's time to the minute. */
  nowMs: number;
}): { state: AwayState | null; close(activityId: string): void } {
  const ownerId = owner?.gladiatorId ?? null;
  const current = owner?.currentActivity ?? null;
  const currentId = current?.id ?? null;
  const unseen = owner?.inbox.newNotifications ?? 0;

  // The newest settled expedition of the owner, as the latest read of its notifications holds it (scoped to the owner it was read for).
  const [trips, setTrips] = useState<{ ownerId: string; latest: GameNotification | null } | null>(null);
  useEffect(() => {
    if (!reads || ownerId === null) return;
    let latest = true;
    reads.notifications().then(read => {
      if (latest) setTrips({ ownerId, latest: read.items.find(item => item.kind === 'expedition') ?? null });
    }).catch(() => { /* The button keeps what it knew; the next change of the key reads again. */ });
    return () => { latest = false; };
  }, [reads, ownerId, currentId, unseen]);
  const latestTrip = trips && trips.ownerId === ownerId ? trips.latest : null;

  // The timeline of the trip that is running: when the button appears, and in each bucket of minutes after a fight's minute.
  const running = current?.kind === 'expedition' && current.startsAtMs <= nowMs && nowMs < current.endsAtMs ? current : null;
  const runningId = running?.id ?? null;
  const minute = running ? Math.floor((nowMs - running.startsAtMs) / MINUTE_MS) : 0;
  const afterFight = Math.max(0, Math.floor((minute - 1) / 20));
  const [timeline, setTimeline] = useState<RevealedTimeline | null>(null);
  useEffect(() => {
    if (!reads || runningId === null) return;
    let latest = true;
    reads.timeline(runningId).then(read => { if (latest) setTimeline(read); }).catch(() => { /* Not shown: the sub-line keeps promising the next fight. */ });
    return () => { latest = false; };
  }, [reads, runningId, afterFight]);
  const defeated = useMemo(() => timeline !== null && timeline.activityId === runningId && renderExpeditionStage(timeline, nowMs).stages.some(stage => stage.outcome === 'defeat'),
    [timeline, runningId, nowMs]);

  // The trips this device has closed: read once, and by `close` from then on.
  const [closed, setClosed] = useState<ReadonlySet<string>>(readClosedTrips);
  const close = useCallback((activityId: string) => { closeTrip(activityId); setClosed(readClosedTrips()); }, []);

  const destination = destinationOf(world, ownerId);
  const state = useMemo(() => (owner ? awayState({ owner, destination, nowMs, latestTrip, defeated, closed }) : null),
    [owner, destination, nowMs, latestTrip, defeated, closed]);
  return { state, close };
}
