import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivitySummary } from '@contracts/events';
import type { GameNotification, OwnerState } from '@contracts/reads';
import { awayProgress, awayScene, awayState, awayText, boutAway, type AwayState } from '@/features/shell/away-trip';
import { ARENA_GLADIATORS, ARENA_TIMELINES, arenaActivityId } from '../fixtures/arena';

// Patch A Task 11 (spec "Item 3 + Task 10", "The button on the camp"; the approved mockup): the pure core of the away button. While
// the owner's expedition runs it says where the gladiator is; once back it offers the whole trip with the owner's own result, until
// the slot after the trip ends or until it is closed. The words are the approved copy.

const MIN = 60_000;
const SLOT_MS = 4_800_000;
const start = 373_247 * SLOT_MS;
const tripEnd = start + SLOT_MS;
const tripId = 'f6c5b7d9-0eb5-4a1d-8e2f-6d7e8f9a0b16';

describe('the camp button after my Arena bout', () => {
  const owner = { name: 'Aster', gladiatorId: ARENA_GLADIATORS.aster.id };
  const settled = ARENA_TIMELINES[arenaActivityId('ownerHumanWin')];
  const { summary: _summary, ...pending } = settled;
  const bout = settled.stages[1];
  const S = settled.stages[0].startedAtMs;
  // The published end can be stale; only the logged duration decides eligibility.
  const end = bout.startedAtMs + bout.battleLog!.durationMs;
  const input = { owner, timeline: pending, nowMs: end, closed: new Set<string>() };
  it('appears at the logged end, through the next slot, unless dismissed', () => {
    expect(boutAway({ ...input, nowMs: end - 1 })).toBeNull();
    const state = boutAway(input)!;
    expect(awayText(state, false)).toEqual({ name: 'Aster', title: ' beat Varro in the Arena', sub: 'Rewards are credited at minute 80', action: '▶ Watch the bout' });
    expect(awayText(state, true)).toEqual({ name: 'Aster', title: ' beat Varro', sub: 'Rewards at minute 80', action: '▶ Watch' });
    expect(boutAway({ ...input, nowMs: S + 2 * SLOT_MS - 1 })).not.toBeNull();
    expect(boutAway({ ...input, nowMs: S + 2 * SLOT_MS })).toBeNull();
    expect(boutAway({ ...input, closed: new Set([pending.activityId]) })).toBeNull();
    expect(awayScene(state)).toEqual({ kind: 'replay', activityId: pending.activityId });
    expect(awayProgress(state)).toBeNull();
    expect(boutAway({ ...input, timeline: { ...pending, stages: pending.stages.map(s => s === bout ? { ...s, endsAtMs: end + MIN } : s) } })).not.toBeNull();
  });
  it('uses the owner’s credited rewards with compact rating precedence and no zero parts', () => {
    const text = (key: Parameters<typeof arenaActivityId>[0], compact: boolean) => {
      const timeline = ARENA_TIMELINES[arenaActivityId(key)];
      return awayText(boutAway({ ...input, timeline, nowMs: timeline.stages[0].startedAtMs + 85 * MIN })!, compact);
    };
    expect(text('ownerHumanWin', false).sub).toBe('+10 renown · Rating +13');
    expect(text('ownerHumanWin', true).sub).toBe('Rating +13');
    expect(text('ownerHumanLoss', false)).toMatchObject({ title: ' lost to Cassia in the Arena', sub: '+2 renown · Rating −13' });
    expect(text('ownerNpcWin', true).sub).toBe('+3 renown');
    expect(text('ownerNpcLoss', false).sub).toBe('No rewards');
    const zero = { ...settled, summary: { ...settled.summary!, ratingDelta: 0, rewards: { ...settled.summary!.rewards, renown: 0 } } };
    expect(awayText(boutAway({ ...input, timeline: zero, nowMs: S + 85 * MIN })!, true).sub).toBe('No rewards');
  });
  it('requires a revealed owner-participating bout, never a public completion or future summary', () => {
    expect(boutAway({ ...input, owner: { ...owner, gladiatorId: ARENA_GLADIATORS.cassia.id } })).toBeNull();
    expect(boutAway({ ...input, timeline: null })).toBeNull();
    expect(boutAway({ ...input, timeline: { ...pending, stages: [] } })).toBeNull();
    expect(boutAway({ ...input, timeline: { ...pending, stages: [{ ...bout, revealedAtMs: end + 1 }] } })).toBeNull();
    expect(awayText(boutAway({ ...input, timeline: settled })!, false).sub).toBe('Rewards are credited at minute 80');
  });
});

const expeditionOwner: Pick<OwnerState, 'name' | 'currentActivity'> = { name: 'Aster',
  currentActivity: { id: tripId, kind: 'expedition', status: 'active', startsAtMs: start, endsAtMs: tripEnd, label: 'Woodland Path' } };
const training: Pick<OwnerState, 'name' | 'currentActivity'> = { name: 'Aster',
  currentActivity: { id: 'a1', kind: 'training', status: 'active', startsAtMs: start, endsAtMs: tripEnd, label: 'Training at the practice yard' } };
/** The slot after the trip: the owner rests, the trip has been settled. */
const resting: Pick<OwnerState, 'name' | 'currentActivity'> = { name: 'Aster',
  currentActivity: { id: 'a2', kind: 'rest', status: 'active', startsAtMs: tripEnd, endsAtMs: tripEnd + SLOT_MS, label: 'Resting in camp' } };

const summaryOf = (over: Partial<ActivitySummary> = {}): ActivitySummary => ({ activityId: tripId, resolvedKind: 'expedition', result: 'victory', success: true,
  rewards: { money: 20, renown: 0, xp: 100, attributePoints: 0, items: [], overflowMoney: 0 }, receiptId: 'receipt-1', settledAtMs: tripEnd + 45_000,
  replayExpiry: { state: 'available', expiresAtMs: tripEnd + 7 * 24 * 60 * MIN }, ...over });
const noteOf = (over: Partial<GameNotification> = {}): GameNotification => ({ activityId: tripId, kind: 'expedition', settledAtMs: tripEnd + 45_000, summary: summaryOf(),
  destination: 'Woodland Path', levelAfter: null, ...over });

const base = { owner: expeditionOwner, destination: 'Woodland Path' as string | null, nowMs: start, latestTrip: null as GameNotification | null, defeated: false,
  closed: new Set<string>() as ReadonlySet<string> };
/** The owner in the slot after the trip, with the settled trip in its notifications. */
const afterTrip = { ...base, owner: resting, destination: null, nowMs: tripEnd + 10 * MIN, latestTrip: noteOf() };
const back = (rewards: { money: number; xp: number }): AwayState => awayState({ ...afterTrip,
  latestTrip: noteOf({ summary: summaryOf({ rewards: { money: rewards.money, renown: 0, xp: rewards.xp, attributePoints: 0, items: [], overflowMoney: 0 } }) }) })!;
const lost = (): AwayState => awayState({ ...afterTrip, latestTrip: noteOf({ destination: 'Ruined Outpost',
  summary: summaryOf({ result: 'defeat', success: false, rewards: { money: 0, renown: 0, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 } }) }) })!;
/** The trip is over, its own activity is still the owner's current one and nothing has settled yet. */
const processing = (): AwayState => awayState({ ...base, nowMs: tripEnd + 30_000 })!;

describe('the away button while the trip runs', () => {
  it('says where the gladiator is while the trip runs', () => {
    const s = awayState({ ...base, nowMs: start + 30 * MIN })!;
    expect(awayText(s, false)).toEqual({ name: 'Aster', title: ' is on the Woodland Path', sub: 'Minute 30 of 80 · next fight at minute 40', action: '● Watch live' });
    expect(awayText(s, true)).toEqual({ name: 'Aster', title: ' · Woodland Path', sub: 'Minute 30 of 80', action: '● Live' });
    expect(awayText(awayState({ ...base, nowMs: start + 65 * MIN })!, false).sub).toBe('Minute 65 of 80 · back at minute 80');
    expect(awayText(awayState({ ...base, nowMs: start + 45 * MIN, defeated: true })!, false).sub).toBe('Minute 45 of 80 · back at minute 80');
    expect(awayText(awayState({ ...base, destination: null, nowMs: start + 30 * MIN })!, false).title).toBe(' is on an expedition');
    expect(awayText(awayState({ ...base, destination: null, nowMs: start + 30 * MIN })!, true).title).toBe(' · on an expedition');
  });

  it('names the trip, its minute and its next fight, from the owner’s current activity', () => {
    expect(awayState({ ...base, nowMs: start + 30 * MIN })).toEqual({ kind: 'running', activityId: tripId, name: 'Aster', destination: 'Woodland Path', minute: 30, nextFight: 40 });
    expect(awayState({ ...base, destination: null, nowMs: start + 30 * MIN })).toMatchObject({ kind: 'running', destination: null });
  });

  it('rounds the minute down, and the next fight is the next of 20, 40 and 60 above it', () => {
    const next = (ms: number) => { const s = awayState({ ...base, nowMs: start + ms })!; return s.kind === 'running' ? [s.minute, s.nextFight] : null; };
    expect(next(0)).toEqual([0, 20]);
    expect(next(19 * MIN + 59_999)).toEqual([19, 20]);
    expect(next(20 * MIN)).toEqual([20, 40]);
    expect(next(39 * MIN)).toEqual([39, 40]);
    expect(next(40 * MIN)).toEqual([40, 60]);
    expect(next(59 * MIN)).toEqual([59, 60]);
    // From minute 60 there is no next fight to name.
    expect(next(60 * MIN)).toEqual([60, null]);
    expect(next(79 * MIN + 59_999)).toEqual([79, null]);
  });

  it('is running from the start to the end of the trip, and not before or after', () => {
    expect(awayState({ ...base, nowMs: start - 1 })).toBeNull();
    expect(awayState({ ...base, nowMs: start })).toMatchObject({ kind: 'running', minute: 0 });
    expect(awayState({ ...base, nowMs: tripEnd - 1 })).toMatchObject({ kind: 'running', minute: 79 });
    expect(awayState({ ...base, nowMs: tripEnd })).toMatchObject({ kind: 'back' });
  });

  it('takes no next fight after a revealed defeat, at any minute', () => {
    expect(awayState({ ...base, nowMs: start + 41 * MIN, defeated: true })).toMatchObject({ minute: 41, nextFight: null });
    expect(awayState({ ...base, nowMs: start + 5 * MIN, defeated: true })).toMatchObject({ nextFight: null });
  });
});

describe('the away button once the trip is over', () => {
  it('offers the whole trip once back, with the owner’s own result', () => {
    expect(awayText(back({ money: 20, xp: 100 }), false)).toEqual({ name: 'Aster', title: ' is back from the Woodland Path', sub: 'Success · +20 gold · +100 XP', action: '▶ Watch the whole trip' });
    expect(awayText(back({ money: 20, xp: 0 }), false).sub).toBe('Success · +20 gold');
    expect(awayText(back({ money: 0, xp: 100 }), false).sub).toBe('Success · +100 XP');
    expect(awayText(back({ money: 0, xp: 0 }), false).sub).toBe('Success');
    expect(awayText(lost(), false)).toMatchObject({ title: ' is back after a defeat on the Ruined Outpost', sub: 'No rewards · all gear kept' });
    expect(awayText(processing(), false).sub).toBe('Processing results…');
  });

  it('says the same on a phone in fewer words', () => {
    expect(awayText(back({ money: 20, xp: 100 }), true)).toEqual({ name: 'Aster', title: ' · back from Woodland Path', sub: 'Success · +20 gold · +100 XP', action: '▶ Replay' });
    expect(awayText(lost(), true)).toMatchObject({ title: ' · back after a defeat', sub: 'No rewards · all gear kept', action: '▶ Replay' });
    expect(awayText(processing(), true)).toMatchObject({ title: ' · back from Woodland Path', sub: 'Processing results…' });
  });

  it('names an unknown destination without inventing one', () => {
    const unknown = awayState({ ...afterTrip, latestTrip: noteOf({ destination: null }) })!;
    expect(awayText(unknown, false).title).toBe(' is back from an expedition');
    expect(awayText(unknown, true).title).toBe(' · back');
    const unknownLoss = awayState({ ...afterTrip, latestTrip: noteOf({ destination: null, summary: summaryOf({ result: 'defeat', success: false }) }) })!;
    expect(awayText(unknownLoss, false).title).toBe(' is back after a defeat on an expedition');
  });

  it('is back from the activity itself until it settles, then from its own settled result', () => {
    // Minute 80, the owner's current activity is still the trip: its result is not in yet.
    expect(awayState({ ...base, nowMs: tripEnd })).toEqual({ kind: 'back', activityId: tripId, name: 'Aster', destination: 'Woodland Path', result: 'processing', rewards: null });
    // Settled: the same activity, now with the owner's result (the notification's destination is the trip's own).
    expect(awayState({ ...base, destination: null, nowMs: tripEnd + 2 * MIN, latestTrip: noteOf() })).toEqual({ kind: 'back', activityId: tripId, name: 'Aster',
      destination: 'Woodland Path', result: 'success', rewards: { money: 20, xp: 100 } });
    // Another trip's notification never settles this one.
    expect(awayState({ ...base, nowMs: tripEnd + 2 * MIN, latestTrip: noteOf({ activityId: 'older', settledAtMs: start - SLOT_MS + 45_000 }) })).toMatchObject({ result: 'processing', activityId: tripId });
  });

  it('is back from the settled trip once the owner has moved on to the next slot', () => {
    expect(awayState(afterTrip)).toEqual({ kind: 'back', activityId: tripId, name: 'Aster', destination: 'Woodland Path', result: 'success', rewards: { money: 20, xp: 100 } });
    // A destination the owner's world actor still has (it has not left the gate yet) is the fallback; the notification's own wins.
    expect(awayState({ ...afterTrip, destination: 'Mountain Pass', latestTrip: noteOf({ destination: null }) })).toMatchObject({ destination: 'Mountain Pass' });
    expect(awayState({ ...afterTrip, destination: 'Mountain Pass' })).toMatchObject({ destination: 'Woodland Path' });
    expect(awayState({ ...afterTrip, latestTrip: noteOf({ summary: summaryOf({ result: 'defeat', success: false }) }) })).toMatchObject({ result: 'defeat' });
  });

  it('stops offering it after the next slot, once closed, and for anything but an expedition', () => {
    expect(awayState({ ...afterTrip, nowMs: tripEnd + SLOT_MS - 1 })).not.toBeNull();
    expect(awayState({ ...afterTrip, nowMs: tripEnd + SLOT_MS + 1 })).toBeNull();
    expect(awayState({ ...afterTrip, closed: new Set([tripId]) })).toBeNull();
    expect(awayState({ ...base, nowMs: tripEnd + 30_000, closed: new Set([tripId]) })).toBeNull();
    expect(awayState({ ...base, owner: training, latestTrip: null })).toBeNull();
    // A settled result of another kind is no trip, and a trip settled in an earlier slot is over.
    expect(awayState({ ...afterTrip, latestTrip: noteOf({ kind: 'arena', summary: summaryOf({ resolvedKind: 'arena' }) }) })).toBeNull();
    expect(awayState({ ...afterTrip, latestTrip: noteOf({ settledAtMs: start + 45_000 }) })).toBeNull();
  });

  it('keeps a trip that is still the current activity past its end for one slot only', () => {
    expect(awayState({ ...base, nowMs: tripEnd + SLOT_MS - 1 })).toMatchObject({ kind: 'back', result: 'processing' });
    expect(awayState({ ...base, nowMs: tripEnd + SLOT_MS })).toBeNull();
  });

  it('shows nothing for an owner with no activity, and nothing in a slot that holds no trip', () => {
    expect(awayState({ ...base, owner: { name: 'Aster', currentActivity: null }, latestTrip: null })).toBeNull();
    expect(awayState({ ...base, owner: { name: 'Aster', currentActivity: null }, latestTrip: noteOf(), nowMs: tripEnd + 5 * MIN })).toMatchObject({ kind: 'back' });
  });

  it('a running trip wins over the last one’s result', () => {
    const next = { ...expeditionOwner, currentActivity: { ...expeditionOwner.currentActivity!, id: 'second', startsAtMs: tripEnd, endsAtMs: tripEnd + SLOT_MS } };
    expect(awayState({ ...base, owner: next, nowMs: tripEnd + 10 * MIN, latestTrip: noteOf() })).toMatchObject({ kind: 'running', activityId: 'second', minute: 10 });
  });
});

describe('what the button opens', () => {
  it('opens the live view while the trip runs, and the whole trip once it is over', () => {
    expect(awayScene(awayState({ ...base, nowMs: start + 30 * MIN })!)).toEqual({ kind: 'expedition', activityId: tripId });
    expect(awayScene(back({ money: 20, xp: 100 }))).toEqual({ kind: 'expedition', activityId: tripId, play: 'trip' });
    expect(awayScene(processing())).toEqual({ kind: 'expedition', activityId: tripId, play: 'trip' });
  });
});

describe('the progress bar', () => {
  it('fills with the minute of the 80 while the trip runs, and has none once it is over', () => {
    expect(awayProgress(awayState({ ...base, nowMs: start + 30 * MIN })!)).toBe(0.375);
    expect(awayProgress(awayState({ ...base, nowMs: start + 20 * MIN })!)).toBe(0.25);
    expect(awayProgress(awayState({ ...base, nowMs: start })!)).toBe(0);
    expect(awayProgress(back({ money: 20, xp: 100 }))).toBeNull();
    expect(awayProgress(processing())).toBeNull();
  });
});

describe('the device memory of closed trips', () => {
  // Each test imports a fresh module after vi.resetModules(): the page's own memory starts empty.
  const store = new Map<string, string>();
  const fresh = async () => { vi.resetModules(); return import('@/features/shell/away-trip'); };
  const throwingStorage = () => vi.stubGlobal('localStorage', {
    getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); },
  });
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('names its key', async () => { expect((await fresh()).TRIP_CLOSED_KEY).toBe('cloudiator.trip-closed.v1'); });
  it('remembers closed trips, and keeps them in memory when storage throws', async () => {
    const a = await fresh(); a.closeTrip(tripId); expect(JSON.parse(store.get('cloudiator.trip-closed.v1')!)).toEqual([tripId]);
    expect(a.readClosedTrips().has(tripId)).toBe(true);
    throwingStorage(); const b = await fresh(); expect(() => b.closeTrip(tripId)).not.toThrow(); expect(b.readClosedTrips().has(tripId)).toBe(true);
  });
  it('keeps the newest 50, each trip once', async () => {
    const a = await fresh();
    for (let i = 0; i < 52; i += 1) a.closeTrip(`trip-${i}`);
    a.closeTrip('trip-51');
    const stored = JSON.parse(store.get('cloudiator.trip-closed.v1')!) as string[];
    expect(stored).toHaveLength(50);
    expect(stored[0]).toBe('trip-2'); expect(stored.at(-1)).toBe('trip-51');
    expect(a.readClosedTrips().has('trip-1')).toBe(false);
  });
  it('adds to what an earlier visit stored, and ignores a stored value that is not a list of ids', async () => {
    store.set('cloudiator.trip-closed.v1', JSON.stringify(['old-1', 7, 'old-2']));
    const a = await fresh(); expect([...a.readClosedTrips()].sort()).toEqual(['old-1', 'old-2']);
    a.closeTrip('new-1');
    expect(JSON.parse(store.get('cloudiator.trip-closed.v1')!)).toEqual(['old-1', 'old-2', 'new-1']);
    store.set('cloudiator.trip-closed.v1', '{"not":"a list"}');
    expect((await fresh()).readClosedTrips().size).toBe(0);
    store.set('cloudiator.trip-closed.v1', 'nonsense');
    const c = await fresh(); expect(c.readClosedTrips().size).toBe(0); c.closeTrip('id-y');
    expect(JSON.parse(store.get('cloudiator.trip-closed.v1')!)).toEqual(['id-y']);
  });
  it('reads nothing at all when storage throws on a read', async () => {
    throwingStorage(); expect((await fresh()).readClosedTrips().size).toBe(0);
  });
});
