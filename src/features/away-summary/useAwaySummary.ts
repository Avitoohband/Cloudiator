'use client';

import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { HistoryEntry, OwnerState } from '@contracts/reads';
import type { Rules } from '@domain/types';
import type { DisplayClock } from '../../game/display-clock';
import type { GameGateway } from '../../lib/api/gateway';
import { modalOpen } from '../shell/modal';
import { AWAY_SEEN_KEY, readAwaySeen, writeAwaySeen } from './away-seen';
import { awaySince, buildAwaySummary, MIN_AWAY_MS, type AwaySummary } from './away-summary';

type OpenSummary = { gladiatorId: string; summary: AwaySummary };

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
  const checking = useRef<(() => void) | null>(null);
  const snapshot = useEffectEvent(() => ({ owner, rules, blocked }));

  useEffect(() => {
    setOpened(null);
    if (!gladiatorId || !reads?.resultsSince) return;
    const gateway = reads;
    const readResults = reads.resultsSince.bind(reads);
    const id = gladiatorId;
    let active = true;
    let inFlight = false;
    let readFailed = false;

    const isBlocked = () => snapshot().blocked || modalOpen() || document.visibilityState !== 'visible';
    function saveRecentVisit() {
      if (inFlight || readFailed || !clock.synced()) return;
      const previous = readAwaySeen(id);
      const now = Math.floor(clock.now());
      if (previous !== null && now - previous < MIN_AWAY_MS) writeAwaySeen(id, now);
    }

    async function check(returning: boolean) {
      if (!active || !clock.synced()) return;
      if (returning) readFailed = false;
      if (inFlight || readFailed) return;
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
        writeAwaySeen(id, now);
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
          readPlacements(gateway, id, result.items.filter(item => item.kind === 'tournament').map(item => item.activityId)),
        ]);
        if (!active) return;
        const messages = latest.inbox.unread > 0 ? await gateway.messages() : [];
        const current = snapshot();
        if (!active || current.owner?.gladiatorId !== id || isBlocked()) return;
        const through = result.serverNowMs;
        const device = readAwaySeen(id);
        const floor = Math.max(since, device ?? 0, current.owner.inbox.notificationsSeenMs, latest.inbox.notificationsSeenMs);
        if (through - floor < MIN_AWAY_MS) {
          writeAwaySeen(id, through);
          return;
        }
        const summary = buildAwaySummary({
          owner: latest, sinceMs: floor, nowMs: through, results: result.items, rests,
          history, messages, rules: current.rules,
          progressionTrusted: result.progression?.level === latest.progression.level && result.progression?.xp === latest.progression.xp,
        });
        writeAwaySeen(id, through);
        if (summary) setOpened({ gladiatorId: id, summary });
      } catch {
        readFailed = true;
      } finally {
        inFlight = false;
      }
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') void check(true);
      else saveRecentVisit();
    };
    const onFocus = () => { void check(true); };
    const onStorage = (event: StorageEvent) => {
      if (event.key === AWAY_SEEN_KEY) void check(false);
    };
    const scheduled = () => { void check(false); };
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

  return { summary, dismiss() { setOpened(null); } };
}

async function readPlacements(gateway: GameGateway, gladiatorId: string, activityIds: string[]) {
  const pending = new Set(activityIds);
  const placements: HistoryEntry[] = [];
  let cursor: string | undefined;
  while (pending.size && gateway.history) {
    const page = await gateway.history(gladiatorId, 'tournament', cursor);
    for (const row of page.rows) {
      if (row.activityId && pending.delete(row.activityId)) placements.push(row);
    }
    // History is ordered by bout time, while the summary window uses settlement time.
    if (!page.nextCursor || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  return placements;
}
