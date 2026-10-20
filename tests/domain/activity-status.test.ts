import { describe, expect, it } from 'vitest';
import type { CurrentActivity, OwnerState } from '../../supabase/functions/_shared/contracts/reads';
import { activityStatus, ownRestingText } from '../../src/features/character/activity-status';
import { slotTimeText } from '../../src/features/schedule/slot-time';

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
    // Completed needs a checkpoint that has reached the slot of the display time (here the one after the activity's).
    const current = owner('active', slot + 1);
    expect(labels(current, slot)).toEqual(['In progress', 'Completed', 'Completed']);
    expect(activityStatus(current, slot, end - 1)).toEqual({ status: 'in-progress', label: 'In progress', endsAtMs: end });
    expect(activityStatus(current, slot, end)).toEqual({ status: 'completed', label: 'Completed', endsAtMs: null });
    // A settled activity whose slot the checkpoint has reached reads Completed too.
    expect(activityStatus(owner('completed', slot + 1), slot, end + 1).label).toBe('Completed');
    const queued = owner('queued', slot, start + 1000);
    expect([start + 999, start + 1000, start + 1001].map(now => activityStatus(queued, slot, now).label)).toEqual(['Scheduled', 'In progress', 'In progress']);
    expect(activityStatus(queued, slot, start)).toEqual({ status: 'scheduled', label: 'Scheduled', endsAtMs: end });
  });

  it('does not show processing before the end, nor when the checkpoint has already reached the slot', () => {
    expect(activityStatus(owner('active', slot + 1), slot + 1, end + 1).status).toBe('completed');
    expect(activityStatus(owner('active', slot - 1), slot, end - 1).status).toBe('in-progress');
  });

  it('reads a slot index up to 30 s old as the slot of the display time, so an ended activity never reads Completed early', () => {
    // The last revision read (20 s before the boundary) still names the activity's slot; the display clock is past it.
    for (const now of [end, end + 10_000, end + 30_000]) {
      expect(activityStatus(owner('active'), slot, now), `${now - end} ms after the end`).toEqual({ status: 'processing', label: 'Processing results', endsAtMs: null });
      expect(activityStatus(owner('completed'), slot, now).status).toBe('preparing');
    }
    // Before the boundary the stale index is the current slot, and a slot index ahead of the display time still counts.
    expect(activityStatus(owner('active'), slot, end - 1).status).toBe('in-progress');
    expect(activityStatus(owner('completed', slot), slot + 1, end - 1).status).toBe('preparing');
  });

  it('shows Preparing your next activity while no activity has been published yet', () => {
    expect(activityStatus({ processedSlotIndex: slot - 1, currentActivity: null }, slot, start + 1)).toEqual({ status: 'preparing', label: 'Preparing your next activity', endsAtMs: null });
  });

  // Task 23.9: a gladiator resting at home (Task 23.8's OwnerState.restingUntilSlot, the approved copy).
  it('shows the owner "Resting at home: back on your schedule at {time}" until that boundary', () => {
    const back = slot + 1, boundary = back * SLOT_MS;
    const resting = { processedSlotIndex: slot, currentActivity: null, restingUntilSlot: back };
    // {time} is the start of that slot in the viewer's local time, as every slot time is shown (`slotTimeText`, Task 23.10),
    // against the display time the status is read at.
    const lineAt = (now: number) => `Resting at home: back on your schedule at ${slotTimeText(boundary, now)}`;
    for (const now of [start, start + 1, boundary - 1]) {
      expect(activityStatus(resting, slot, now), `${boundary - now} ms before the boundary`).toEqual({ status: 'resting', label: lineAt(now), endsAtMs: null });
    }
    // The wording follows the display time, not the boundary alone: a day or more ahead it is not the time of day alone.
    const early = boundary - 36 * 3_600_000;
    const timeOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(boundary);
    expect(activityStatus(resting, slot, early).label).toBe(lineAt(early));
    expect(activityStatus(resting, slot, early).label).not.toBe(`Resting at home: back on your schedule at ${timeOnly}`);
    expect(lineAt(boundary - 1)).toBe(`Resting at home: back on your schedule at ${timeOnly}`);
    // From the boundary (by the display clock, or by a revision read already in that slot) the schedule applies again:
    // the next activity is being prepared until the owner state is read once more.
    expect(activityStatus(resting, slot, boundary)).toEqual({ status: 'preparing', label: 'Preparing your next activity', endsAtMs: null });
    expect(activityStatus(resting, back, boundary - 1).status).toBe('preparing');
    // Resting with no signal since it began (null until the owner's presence and a fresh read): no time to show yet.
    expect(activityStatus({ ...resting, restingUntilSlot: null }, slot, start + 1).status).toBe('preparing');
    // The owner's own words for its card and its list row (fix round 1) are the same line.
    expect(ownRestingText(back, start + 1)).toBe(lineAt(start + 1));
  });

  // Fix round 1 (review Minor 1): resting in the world, before its presence is answered.
  it('shows the owner "Resting at home." while its gladiator rests and its return is not known yet', () => {
    const waiting = { processedSlotIndex: slot, currentActivity: null, restingUntilSlot: null };
    expect(ownRestingText(null)).toBe('Resting at home.');
    for (const now of [start, start + 1, end - 1]) {
      expect(activityStatus(waiting, slot, now, { resting: true })).toEqual({ status: 'resting', label: 'Resting at home.', endsAtMs: null });
    }
    // Not resting in the world (a new gladiator whose activity is not published yet), or past its slot: as before.
    expect(activityStatus(waiting, slot, start + 1).status).toBe('preparing');
    expect(activityStatus(waiting, slot, start + 1, { resting: false }).status).toBe('preparing');
    expect(activityStatus(waiting, slot, end, { resting: true }).status).toBe('preparing');
    expect(activityStatus(waiting, slot + 1, end - 1, { resting: true }).status).toBe('preparing');
    // Once its return is known, the line says when.
    expect(activityStatus({ ...waiting, restingUntilSlot: slot + 1 }, slot, start + 1, { resting: true }).label).toBe(ownRestingText(slot + 1, start + 1));
  });
});
