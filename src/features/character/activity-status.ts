import type { OwnerState } from '@contracts/reads';
import { RULES_V1 } from '@domain/rules-v1';

export type ActivityStatus = 'scheduled' | 'in-progress' | 'processing' | 'preparing' | 'completed';

const PROCESSING = { status: 'processing', label: 'Processing results', endsAtMs: null } as const;
const PREPARING = { status: 'preparing', label: 'Preparing your next activity', endsAtMs: null } as const;
const SLOT_MS = RULES_V1.clock.slotMs;

/**
 * The owner's activity line at display time `nowMs`, in the server's current slot. The server settles a slot's results
 * and publishes the next activity a little after each boundary, and `processedSlotIndex` reaches the current slot only
 * then. Until it does, a delay reads as one, never as a result: an ended activity that is not completed is "Processing
 * results", and a completed one is followed by "Preparing your next activity" (also shown while no activity has been
 * published). Otherwise the label follows the activity's times: Scheduled, In progress, then Completed. `endsAtMs` is the
 * activity's end while it is scheduled or in progress, and null otherwise.
 *
 * The current slot is the later of `slotIndex` (the last revision read's, up to 30 s old) and the slot of `nowMs`, so a
 * slot index read before the boundary never shows an ended activity as Completed.
 */
export function activityStatus(owner: Pick<OwnerState, 'currentActivity' | 'processedSlotIndex'>, slotIndex: number, nowMs: number):
  { status: ActivityStatus; label: string; endsAtMs: number | null } {
  const activity = owner.currentActivity;
  const current = Math.max(slotIndex, Math.floor(nowMs / SLOT_MS));
  const behind = owner.processedSlotIndex < current;
  if (!activity) return { ...PREPARING };
  const ended = nowMs >= activity.endsAtMs;
  if (behind && ended && activity.status !== 'completed') return { ...PROCESSING };
  if (behind && activity.status === 'completed') return { ...PREPARING };
  if (nowMs < activity.startsAtMs) return { status: 'scheduled', label: 'Scheduled', endsAtMs: activity.endsAtMs };
  if (!ended) return { status: 'in-progress', label: 'In progress', endsAtMs: activity.endsAtMs };
  return { status: 'completed', label: 'Completed', endsAtMs: null };
}
