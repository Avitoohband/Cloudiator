import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceResult } from '@contracts/commands';
import type { OwnerState } from '@contracts/reads';
import { createPresence, PRESENCE_INTERVAL_MS } from '../../src/lib/api/presence';
import { ownerFixture } from '../fixtures/domain';

// Task 23.9: the owner's activity signal (Task 23.8's `presence` command), once after sign-in or page load, then every
// 6 hours while the page is visible. Fake timers, a stand-in document and a stand-in send.
const HOUR = 3_600_000;
let visible = true;
let doc: EventTarget;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_791_592_800_000);
  doc = new EventTarget(); visible = true;
  Object.defineProperty(doc, 'visibilityState', { get: () => (visible ? 'visible' : 'hidden') });
  vi.stubGlobal('document', doc);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** An owner with a current activity (not resting), and one resting at home whose owner has not signalled since. */
const ACTIVE: OwnerState = structuredClone(ownerFixture);
const RESTING: OwnerState = { ...structuredClone(ownerFixture), currentActivity: null, processedSlotIndex: 373_248, restingUntilSlot: null };

function presence(answer: () => Promise<PresenceResult> = async () => ({ ok: true })) {
  const send = vi.fn(answer);
  const reread = vi.fn();
  return { send, reread, presence: createPresence({ send, reread }) };
}
const hide = () => { visible = false; doc.dispatchEvent(new Event('visibilitychange')); };
const show = () => { visible = true; doc.dispatchEvent(new Event('visibilitychange')); };

describe('presence', () => {
  it('sends one presence after sign-in and then every 6 hours while visible, never for a visitor', async () => {
    expect(PRESENCE_INTERVAL_MS).toBe(6 * HOUR);
    const { send, presence: p } = presence();
    // A visitor, then a signed-in account whose gladiator is not loaded yet (or that has none): nothing is sent.
    p.update({ account: null, owner: null });
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    p.update({ account: 'first', owner: null });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(send).not.toHaveBeenCalled();
    // The player's gladiator is shown: one presence at once; a later owner read of the same account sends none.
    p.update({ account: 'first', owner: ACTIVE });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    p.update({ account: 'first', owner: structuredClone(ACTIVE) });
    await vi.advanceTimersByTimeAsync(6 * HOUR - 1);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    expect(send).toHaveBeenCalledTimes(4);
    // Signed out: nothing more however long the page stays open.
    p.update({ account: null, owner: null });
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(send).toHaveBeenCalledTimes(4);
    // Another account signs in: its own presence at once.
    p.update({ account: 'second', owner: ACTIVE });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(5);
    p.stop();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(send).toHaveBeenCalledTimes(5);
  });

  it('sends nothing while the page is hidden, and the presence that fell due then once the page is visible again', async () => {
    const { send, presence: p } = presence();
    p.update({ account: 'first', owner: ACTIVE });
    await vi.advanceTimersByTimeAsync(0);
    hide();
    await vi.advanceTimersByTimeAsync(20 * HOUR);
    expect(send).toHaveBeenCalledTimes(1);
    show();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    // The next one is 6 hours after that send; a quick hide and show in between sends nothing.
    hide(); show();
    await vi.advanceTimersByTimeAsync(6 * HOUR - 1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it('waits for the page to be visible before the first presence of a page loaded in the background', async () => {
    visible = false;
    const { send, presence: p } = presence();
    p.update({ account: 'first', owner: ACTIVE });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(send).not.toHaveBeenCalled();
    show();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('swallows a refusal or a failure, and tries again only at the next 6-hour mark', async () => {
    const answers: (() => Promise<PresenceResult>)[] = [
      async () => ({ ok: false, code: 'rate-limited', retryAfterMs: 1000 }),
      async () => { throw new Error('network'); },
      async () => ({ ok: true }),
    ];
    const { send, reread, presence: p } = presence(() => answers.shift()!());
    p.update({ account: 'first', owner: RESTING });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    // No retry before the next mark, even with a retry-after.
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(send).toHaveBeenCalledTimes(2);
    expect(reread).not.toHaveBeenCalled();
    // Only the answered presence reads the owner again.
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(send).toHaveBeenCalledTimes(3);
    expect(reread).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('reads the owner again once after an answered presence while its gladiator rests with no signal yet', async () => {
    // Resting, with no signal since it began (restingUntilSlot null): the answered presence makes it the next slot.
    const resting = presence();
    resting.presence.update({ account: 'first', owner: RESTING });
    await vi.advanceTimersByTimeAsync(0);
    expect(resting.reread).toHaveBeenCalledTimes(1);
    // The fresh read says when it returns: the next presence needs no read.
    resting.presence.update({ account: 'first', owner: { ...RESTING, restingUntilSlot: 373_249 } });
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(resting.send).toHaveBeenCalledTimes(2);
    expect(resting.reread).toHaveBeenCalledTimes(1);
    resting.presence.stop();
    // A gladiator with a current activity is not resting: its owner state cannot change with the presence.
    const active = presence();
    active.presence.update({ account: 'first', owner: ACTIVE });
    await vi.advanceTimersByTimeAsync(0);
    expect(active.send).toHaveBeenCalledTimes(1);
    expect(active.reread).not.toHaveBeenCalled();
    active.presence.stop();
  });

  it('neither reads nor reports anything after it is stopped or the account changed', async () => {
    let answer!: (result: PresenceResult) => void;
    const { send, reread, presence: p } = presence(() => new Promise(resolve => { answer = resolve; }));
    p.update({ account: 'first', owner: RESTING });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    p.update({ account: null, owner: null });
    answer({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(reread).not.toHaveBeenCalled();
    show();
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    expect(send).toHaveBeenCalledTimes(1);
    p.stop();
  });
});
