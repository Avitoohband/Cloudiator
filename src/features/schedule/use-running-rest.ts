'use client';

// Patch 1.9 Task 29 (approved mockup 2026-11-13, "Running card truth"): whether the part running now rests instead of its plan. The owner
// read names the running activity (a Rest, "Resting (not enough stamina)" for a stamina fallback) but not what was planned: the owner's own
// `activities` row says that (`requested`, `fallback`), read once per running activity through `gateway.rested`. Only for an activity whose
// slot the server has processed (`settledActivity`, A3) and that is the running slot's, and only a Rest; a gateway without the read (the
// fixture preview) or a failed read shows the card as before.
import { useEffect, useState } from 'react';
import type { OwnerState } from '@contracts/reads';
import { RULES_V1 } from '@domain/rules-v1';
import type { GameGateway, RestedActivity } from '../../lib/api/gateway';
import { settledActivity } from '../character/activity-status';

const SLOT_MS = RULES_V1.clock.slotMs;

/** The running Rest's planned activity and reason, or null when the running part runs as planned (or that cannot be told). */
export function useRunningRest(gateway: Pick<GameGateway, 'rested'>, owner: Pick<OwnerState, 'currentActivity'>, slot: number | null): RestedActivity | null {
  const activity = settledActivity(owner);
  const id = activity && activity.kind === 'rest' && slot !== null && Math.floor(activity.startsAtMs / SLOT_MS) === slot ? activity.id : null;
  const [answer, setAnswer] = useState<{ id: string; rest: RestedActivity | null } | null>(null);
  useEffect(() => {
    if (!id || !gateway.rested) return;
    let active = true;
    gateway.rested([id]).then(rows => { if (active) setAnswer({ id, rest: rows.find(row => row.activityId.toLowerCase() === id.toLowerCase()) ?? null }); },
      () => { if (active) setAnswer({ id, rest: null }); });
    return () => { active = false; };
  }, [gateway, id]);
  return id && answer?.id === id ? answer.rest : null;
}
