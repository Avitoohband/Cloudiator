import { describe, expect, it } from 'vitest';
import type { CurrentActivity, OwnerState } from '../../supabase/functions/_shared/contracts/reads';
import { activityStatus } from '../../src/features/character/activity-status';

const SLOT_MS = 4_800_000;
const slot = 373_248;
const start = slot * SLOT_MS, end = start + SLOT_MS;
type Owner = Pick<OwnerState, 'currentActivity' | 'processedSlotIndex'>;
const activity = (status: CurrentActivity['status'], startsAtMs = start, endsAtMs = end): CurrentActivity =>
  ({ id: '9fce3cd5-e831-4a66-8ca1-16b4576b1499', kind: 'training', status, startsAtMs, endsAtMs, label: 'Training at the practice yard' });
const owner = (status: CurrentActivity['status'], processedSlotIndex = slot, startsAtMs = start): Owner =>
  ({ processedSlotIndex, currentActivity: activity(status, startsAtMs) });
const labels = (value: Owner, slotIndex: number) => [end - 1, end, end + 1].map(now => activityStatus(value, slotIndex, now).label);

describe('activity status', () => {
  it('shows an ended, unsettled activity as Processing results while its slot is not yet processed', () => {
    // The server's slot has moved on but this gladiator's checkpoint is still its last activity's slot.
    const endedNotCompleted = owner('active');
    expect(labels(endedNotCompleted, slot + 1)).toEqual(['In progress', 'Processing results', 'Processing results']);
    expect(activityStatus(owner('processing'), slot + 1, end + 1)).toEqual({ status: 'processing', label: 'Processing results', endsAtMs: null });
  });

  it('shows Preparing your next activity once the last activity is settled but the next slot is not yet published', () => {
    const completedPrev = owner('completed');
    expect(labels(completedPrev, slot + 1)).toEqual(['Preparing your next activity', 'Preparing your next activity', 'Preparing your next activity']);
    expect(activityStatus(completedPrev, slot + 1, end + 1)).toEqual({ status: 'preparing', label: 'Preparing your next activity', endsAtMs: null });
  });

  it('otherwise follows the activity times: Scheduled, In progress, then Completed', () => {
    const current = owner('active');
    expect(labels(current, slot)).toEqual(['In progress', 'Completed', 'Completed']);
    expect(activityStatus(current, slot, end - 1)).toEqual({ status: 'in-progress', label: 'In progress', endsAtMs: end });
    expect(activityStatus(current, slot, end)).toEqual({ status: 'completed', label: 'Completed', endsAtMs: null });
    // A settled activity whose slot the checkpoint has reached reads Completed too.
    expect(activityStatus(owner('completed'), slot, end + 1).label).toBe('Completed');
    const queued = owner('queued', slot, start + 1000);
    expect([start + 999, start + 1000, start + 1001].map(now => activityStatus(queued, slot, now).label)).toEqual(['Scheduled', 'In progress', 'In progress']);
    expect(activityStatus(queued, slot, start)).toEqual({ status: 'scheduled', label: 'Scheduled', endsAtMs: end });
  });

  it('does not show processing before the end, nor when the checkpoint has already reached the slot', () => {
    expect(activityStatus(owner('active', slot), slot, end + 1).status).toBe('completed');
    expect(activityStatus(owner('active', slot + 1), slot + 1, end + 1).status).toBe('completed');
    expect(activityStatus(owner('active', slot - 1), slot, end - 1).status).toBe('in-progress');
  });

  it('shows Preparing your next activity while no activity has been published yet', () => {
    expect(activityStatus({ processedSlotIndex: slot - 1, currentActivity: null }, slot, start + 1)).toEqual({ status: 'preparing', label: 'Preparing your next activity', endsAtMs: null });
  });
});
