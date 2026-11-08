'use client';

// The camp's expedition / Arena button, from the shell's owner and shared display clock:
//  - the owner's settled results (`reads.notifications()`), for the "back" button's own result. It is read when the owner's current
//    activity changes or its count of unseen results does (the key), and only the latest read lands: a slower earlier read, answered
//    after a newer one, never replaces it;
//  - the owner's own timeline of a trip that is running (`reads.timeline()`), because the public actor carries no stage: it says
//    whether a fight was lost, so the sub-line stops promising a next fight. It is read when the button appears and once after each
//    fight's minute (minutes 21, 41 and 61, a minute after the fight starts, which has ended and been published by then), latest only.
// Both are the owner's: nothing is read for a visitor or an account with no gladiator. A failed read leaves the button as it was.
// Arena extends those shared notifications: current Arena activity first, otherwise the newest Arena result settled this slot.
// Read its timeline on appearance, minute 60 + 1 s and settlement (80), latest only; schedule exact logged-end/display-expiry
// redraws against the shared clock, including freeze/jump notifications. Every cache is scoped to the owner AND reader lifetime.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RevealedTimeline } from '@contracts/events';
import type { GameNotification, OwnerState, WorldSnapshot } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import type { GameGateway } from '../../lib/api/gateway';
import { renderExpeditionStage } from '../../game/expedition-stage';
import { boutEndMs } from '../../game/replay';
import type { DisplayClock } from '../../game/display-clock';
import { RULES_V1 } from '@domain/rules-v1';
import { awayState, boutAway, closeTrip, dungeonSafeReturn, readClosedTrips, type AwayState } from './away-trip';

const MINUTE_MS = 60_000;
/** The expedition the owner's world actor is on (`expedition:woodland`), by its catalog name; null when it is on none. */
function destinationOf(world: WorldSnapshot | null, gladiatorId: string | null): string | null {
  const location = world?.actors.find(actor => actor.gladiatorId === gladiatorId)?.location;
  if (location?.startsWith('dungeon:')) return Object.values(CATALOG_V1.dungeons).find(dungeon => location === `dungeon:${dungeon.id}`)?.name ?? null;
  const id = location?.startsWith('expedition:') ? location.slice('expedition:'.length) : null;
  return id !== null && Object.hasOwn(CATALOG_V1.expeditions, id) ? CATALOG_V1.expeditions[id as keyof typeof CATALOG_V1.expeditions].name : null;
}

export function useAwayTrip({ reads, owner, world, nowMs: minuteNow, clock }: {
  reads: Pick<GameGateway, 'notifications' | 'timeline'> | null;
  /** The signed-in player's owner state, or null (a visitor, no gladiator yet, still loading). */
  owner: OwnerState | null;
  world: WorldSnapshot | null;
  /** The display clock's time to the minute. */
  nowMs: number;
  clock: DisplayClock;
}): { state: AwayState | null; close(activityId: string): void } {
  const ownerId = owner?.gladiatorId ?? null;
  const current = owner?.currentActivity ?? null;
  const currentId = current?.id ?? null;
  const unseen = owner?.inbox.newNotifications ?? 0;
  const scope = useMemo(() => ({ reads, ownerId }), [reads, ownerId]);
  // Minute samples suffice for expedition text; Arena needs the shared clock's exact end and read boundaries.
  const [, redraw] = useState(0);
  const nowMs = clock.now();
  const synced = clock.synced();
  const slot = Math.floor(nowMs / RULES_V1.clock.slotMs);

  // The newest settled expedition of the owner, as the latest read of its notifications holds it (scoped to the owner it was read for).
  const [trips, setTrips] = useState<{ scope: typeof scope; items: GameNotification[] } | null>(null);
  useEffect(() => {
    if (!reads || ownerId === null) return;
    let latest = true;
    reads.notifications().then(read => {
      if (latest) setTrips({ scope, items: read.items });
    }).catch(() => { /* The button keeps what it knew; the next change of the key reads again. */ });
    return () => { latest = false; };
  }, [reads, ownerId, currentId, unseen, scope, slot]);
  const notes = trips?.scope === scope ? trips.items : null;
  const latestTrip = notes?.find(item => item.kind === 'expedition' || item.kind === 'dungeon') ?? null;

  const recentArena = notes?.filter(item => item.kind === 'arena' && Math.floor(item.settledAtMs / RULES_V1.clock.slotMs) === slot)
    .reduce<GameNotification | null>((latest, item) => !latest || item.settledAtMs > latest.settledAtMs ? item : latest, null);
  const arenaId = current?.kind === 'arena' ? current.id : recentArena?.activityId ?? null;
  // Settlement can publish after minute80's pending timeline snapshot, before the owner projection leaves Arena.
  // The matching immutable receipt triggers a fresh timeline even when the candidate and unseen count stay the same.
  const arenaReceipt = notes?.find(note => note.kind === 'arena' && note.activityId === arenaId)?.summary.receiptId ?? null;
  const arenaStart = current?.kind === 'arena' ? current.startsAtMs
    : recentArena ? (Math.floor(recentArena.settledAtMs / RULES_V1.clock.slotMs) - 1) * RULES_V1.clock.slotMs : null;
  // Re-entering even the same activity is a new candidate lifetime, awaiting its own read.
  const arenaScope = useMemo(() => ({ scope, arenaId }), [scope, arenaId]);
  const arenaBucket = arenaStart === null ? 0 : nowMs >= arenaStart + RULES_V1.clock.slotMs ? 2 : nowMs >= arenaStart + 60 * MINUTE_MS + 1_000 ? 1 : 0;
  const [arena, setArena] = useState<{ scope: typeof arenaScope; timeline: RevealedTimeline } | null>(null);
  useEffect(() => {
    if (!reads || ownerId === null || arenaId === null || !synced) return;
    let latest = true;
    reads.timeline(arenaId).then(timeline => { if (latest) setArena({ scope: arenaScope, timeline }); }).catch(() => { /* Keep this candidate's last successful read. */ });
    return () => { latest = false; };
  }, [reads, ownerId, arenaScope, arenaId, arenaBucket, unseen, synced, arenaReceipt]);
  const arenaTimeline = arena?.scope === arenaScope ? arena.timeline : null;
  const arenaEnd = arenaTimeline?.stages.find(stage => stage.kind === 'bout' && stage.battleLog?.participants.some(p => p.gladiatorId === ownerId));
  const endedAt = arenaEnd ? boutEndMs(arenaEnd) : null;
  // Ordinary server sync renders without notifying subscribers: re-arm from this render's exact clock sample too.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (sampledAt: number) => {
      clearTimeout(timer);
      if (arenaStart === null || clock.frozen() !== null) return;
      const now = clock.now();
      const boundaries = [arenaStart + 60 * MINUTE_MS + 1_000, arenaStart + RULES_V1.clock.slotMs, arenaStart + 2 * RULES_V1.clock.slotMs,
        ...(endedAt === null ? [] : [endedAt])].filter(at => at > sampledAt);
      // A boundary passed since the UI's sample still needs a redraw; do not drop it during effect setup.
      if (boundaries.length) timer = setTimeout(update, Math.max(0, Math.min(60_000, Math.min(...boundaries) - now)));
    };
    const update = () => { const sample = clock.now(); redraw(value => value + 1); schedule(sample); };
    const off = clock.subscribe(update);
    document.addEventListener('visibilitychange', update);
    schedule(nowMs);
    return () => { clearTimeout(timer); off(); document.removeEventListener('visibilitychange', update); };
  }, [clock, minuteNow, nowMs, arenaStart, endedAt]);

  // The timeline of the trip that is running: when the button appears, and in each bucket of minutes after a fight's minute.
  const running = (current?.kind === 'expedition' || current?.kind === 'dungeon') && current.startsAtMs <= nowMs && nowMs < current.endsAtMs ? current : null;
  const runningId = running?.id ?? null;
  const minute = running ? Math.floor((nowMs - running.startsAtMs) / MINUTE_MS) : 0;
  const afterFight = Math.max(0, Math.floor((minute - 1) / (running?.kind === 'dungeon' ? 16 : 20)));
  const [tripTimeline, setTimeline] = useState<{ scope: typeof scope; timeline: RevealedTimeline } | null>(null);
  useEffect(() => {
    if (!reads || runningId === null) return;
    let latest = true;
    reads.timeline(runningId).then(read => { if (latest) setTimeline({ scope, timeline: read }); }).catch(() => { /* Not shown: the sub-line keeps promising the next fight. */ });
    return () => { latest = false; };
  }, [reads, runningId, afterFight, scope]);
  const timeline = tripTimeline?.scope === scope ? tripTimeline.timeline : null;
  const isDungeon = running?.kind === 'dungeon';
  const defeated = useMemo(() => {
    if (!timeline || timeline.activityId !== runningId) return false;
    if (isDungeon) return dungeonSafeReturn(timeline, nowMs);
    return renderExpeditionStage(timeline, nowMs).stages.some(stage => stage.outcome === 'defeat');
  }, [timeline, runningId, nowMs, isDungeon]);

  // The trips this device has closed: read once, and by `close` from then on.
  const [closed, setClosed] = useState<ReadonlySet<string>>(readClosedTrips);
  const close = useCallback((activityId: string) => { closeTrip(activityId); setClosed(readClosedTrips()); }, []);

  const destination = destinationOf(world, ownerId);
  const trip = owner ? awayState({ owner, destination, nowMs, latestTrip, defeated, closed }) : null;
  const bout = owner ? boutAway({ owner, timeline: arenaTimeline, nowMs, closed }) : null;
  const state = trip?.kind === 'running' ? trip : bout ?? trip;
  return { state, close };
}
