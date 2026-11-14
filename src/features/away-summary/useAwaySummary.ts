'use client';

import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { HistoryEntry, OwnerState } from '@contracts/reads';
import type { Rules } from '@domain/types';
import type { DisplayClock } from '../../game/display-clock';
import type { GameGateway } from '../../lib/api/gateway';
import { modalOpen } from '../shell/modal';
import { heartbeatAwaySeen, onAwaySeenStorage, readAwaySeen, writeAwaySeen } from './away-seen';
import { awaySince, buildAwaySummary, MAX_DETAILED_RUNS, MIN_AWAY_MS, type AwaySummary } from './away-summary';

const PLACEMENT_PAGE_LIMIT = 3;
type OpenSummary = { gladiatorId: string; through: number; summary: AwaySummary };

export function useAwaySummary({ owner, reads, clock, clockReady, ownerForSummary, rules, blocked, tick }: {
  owner: OwnerState | null;
  reads: GameGateway | null;
  clock: DisplayClock;
  clockReady: boolean;
  ownerForSummary(refresh: boolean): Promise<OwnerState | null>;
  rules: Rules;
  blocked: boolean;
  tick: number;
}) {
  const gladiatorId = owner?.gladiatorId;
  const [opened, setOpened] = useState<OpenSummary | null>(null);
  const openVisit = useRef<OpenSummary | null>(null);
  const checking = useRef<(() => void) | null>(null);
  const snapshot = useEffectEvent(() => ({ owner, rules, blocked }));

  useEffect(() => {
    openVisit.current = null;
    setOpened(null);
    if (!gladiatorId || !reads?.resultsSince) return;
    const gateway = reads;
    const readResults = reads.resultsSince.bind(reads);
    const id = gladiatorId;
    let active = true;
    let inFlight = false;
    let readFailed = false;
    let previousTick: number | null = null;
    let returnedWhileReading = false;

    const isBlocked = () => snapshot().blocked || modalOpen() || document.visibilityState !== 'visible';
    function saveRecentVisit() {
      if (inFlight || readFailed || openVisit.current || !clock.synced()) return;
      const previous = readAwaySeen(id);
      const now = Math.floor(clock.now());
      if (previous !== null && now - previous < MIN_AWAY_MS) heartbeatAwaySeen(id, now);
    }

    async function check(returning: boolean) {
      if (!active || !clock.synced()) return;
      if (inFlight) {
        returnedWhileReading ||= returning;
        return;
      }
      if (returning) readFailed = false;
      if (readFailed || openVisit.current) return;
      if (isBlocked()) {
        if (document.visibilityState === 'visible') saveRecentVisit();
        return;
      }
      const initial = snapshot().owner;
      if (initial?.gladiatorId !== id) return;
      const now = Math.floor(clock.now());
      const previous = readAwaySeen(id);
      const since = awaySince(now, previous, initial.inbox.notificationsSeenMs);
      // A real owner read floors the mark at creation. Zero is an uninitialized or sample inbox.
      if ((initial.inbox.notificationsSeenMs === 0 && previous === null) || now - since < MIN_AWAY_MS) {
        heartbeatAwaySeen(id, now);
        return;
      }

      inFlight = true;
      try {
        const [result] = await Promise.all([readResults(id, since), ownerForSummary(true)]);
        if (!active || isBlocked()) return;
        const latest = await ownerForSummary(false);
        if (latest?.gladiatorId !== id) return;
        // Read rests and placements after the results cutoff. The model filters out anything that settled later.
        const [rests, history] = await Promise.all([
          gateway.rested?.() ?? [],
          readPlacements(gateway, id, result.items.filter(item => item.kind === 'tournament').slice(0, MAX_DETAILED_RUNS).map(item => item.activityId)),
        ]);
        if (!active) return;
        const messages = latest.inbox.unread > 0 ? await gateway.messages() : [];
        const current = snapshot();
        if (!active || current.owner?.gladiatorId !== id || isBlocked()) return;
        const through = result.serverNowMs;
        const device = readAwaySeen(id);
        const serverMark = Math.max(current.owner.inbox.notificationsSeenMs, latest.inbox.notificationsSeenMs);
        const floor = Math.max(since, device ?? 0, serverMark);
        if (through - floor < MIN_AWAY_MS) {
          writeAwaySeen(id, through);
          return;
        }
        const summary = buildAwaySummary({
          owner: latest, sinceMs: floor, nowMs: through, results: result.items, rests,
          history, messages, rules: current.rules,
          progressionTrusted: result.progression?.level === latest.progression.level && result.progression?.xp === latest.progression.xp,
        });
        if (!summary) {
          writeAwaySeen(id, through);
          return;
        }
        // Got it marks through the newest result in the window, readable or not (M7). Results older than the device's last visit settled
        // while the player was in the game, so the account mark passes them too and the Messages badge drops (Avi's Q1; N4).
        const newest = result.newestSettledMs;
        const mark = Math.max(summary.seenUpToMs ?? 0, newest !== null && newest > floor && newest <= through ? newest : 0);
        if ((readAwaySeen(id) ?? 0) > floor) return;
        const visit = { gladiatorId: id, through, summary: { ...summary, seenUpToMs: mark > floor ? mark : null } };
        openVisit.current = visit;
        setOpened(visit);
      } catch {
        readFailed = true;
      } finally {
        inFlight = false;
        if (returnedWhileReading) {
          returnedWhileReading = false;
          void check(true);
        }
      }
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') void check(true);
      else saveRecentVisit();
    };
    const onFocus = () => { void check(true); };
    const onStorage = (event: StorageEvent) => {
      const seen = onAwaySeenStorage(id, event);
      // Another tab dismissed this summary (its visit reaches this copy's cutoff): close this copy without writing anything back.
      if (seen !== null && openVisit.current?.gladiatorId === id && seen >= openVisit.current.through) {
        openVisit.current = null;
        setOpened(null);
      }
    };
    const scheduled = () => {
      if (!clock.synced()) return;
      const now = clock.now();
      const woke = previousTick !== null && now - previousTick >= MIN_AWAY_MS;
      previousTick = now;
      void check(woke);
    };
    checking.current = scheduled;
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', saveRecentVisit);
    window.addEventListener('storage', onStorage);
    return () => {
      active = false;
      checking.current = null;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pagehide', saveRecentVisit);
      window.removeEventListener('storage', onStorage);
    };
  }, [gladiatorId, reads, clock, ownerForSummary]);

  const summary = opened && opened.gladiatorId === gladiatorId ? opened.summary : null;
  useEffect(() => { checking.current?.(); }, [blocked, reads, gladiatorId, clockReady, tick, summary]);

  return { summary, dismiss() {
    const visit = openVisit.current;
    // The visit ends when the player closes the summary (N2): results that settled while it was open stay in Notifications.
    if (visit && visit.gladiatorId === gladiatorId) writeAwaySeen(visit.gladiatorId, Math.max(visit.through, clock.synced() ? clock.now() : 0));
    openVisit.current = null;
    setOpened(null);
  } };
}

async function readPlacements(gateway: GameGateway, gladiatorId: string, activityIds: string[]) {
  const pending = new Set(activityIds);
  const placements = new Map<string, HistoryEntry>();
  let cursor: string | undefined;
  for (let i = 0; i < PLACEMENT_PAGE_LIMIT && pending.size && gateway.history; i++) {
    const page = await gateway.history(gladiatorId, 'tournament', cursor);
    for (const row of page.rows) {
      if (!pending.has(row.activityId)) continue;
      if (!placements.has(row.activityId) || row.place !== null) placements.set(row.activityId, row);
      if (row.place !== null) pending.delete(row.activityId);
    }
    // History is ordered by bout time, while the summary window uses settlement time.
    if (!page.nextCursor || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  return [...placements.values()];
}
