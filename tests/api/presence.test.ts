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
    p.update({ account: null, owner: null, resting: false });
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    p.update({ account: 'first', owner: null, resting: false });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(send).not.toHaveBeenCalled();
    // The player's gladiator is shown: one presence at once; a later owner read of the same account sends none.
    p.update({ account: 'first', owner: ACTIVE, resting: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    p.update({ account: 'first', owner: structuredClone(ACTIVE), resting: false });
    await vi.advanceTimersByTimeAsync(6 * HOUR - 1);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    expect(send).toHaveBeenCalledTimes(4);
    // Signed out: nothing more however long the page stays open.
    p.update({ account: null, owner: null, resting: false });
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(send).toHaveBeenCalledTimes(4);
    // Another account signs in: its own presence at once.
    p.update({ account: 'second', owner: ACTIVE, resting: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(5);
    p.stop();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(send).toHaveBeenCalledTimes(5);
  });

  it('sends nothing while the page is hidden, and the presence that fell due then once the page is visible again', async () => {
    const { send, presence: p } = presence();
    p.update({ account: 'first', owner: ACTIVE, resting: false });
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
    p.update({ account: 'first', owner: ACTIVE, resting: false });
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
    // No current activity and no restingUntilSlot, but not resting in the world (its next activity is not published yet):
    // nothing waits on this presence, so a failure waits for the next one.
    p.update({ account: 'first', owner: RESTING, resting: false });
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
    resting.presence.update({ account: 'first', owner: RESTING, resting: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(resting.reread).toHaveBeenCalledTimes(1);
    // The fresh read says when it returns: the next presence needs no read.
    resting.presence.update({ account: 'first', owner: { ...RESTING, restingUntilSlot: 373_249 }, resting: true });
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(resting.send).toHaveBeenCalledTimes(2);
    expect(resting.reread).toHaveBeenCalledTimes(1);
    resting.presence.stop();
    // A gladiator with a current activity is not resting: its owner state cannot change with the presence.
    const active = presence();
    active.presence.update({ account: 'first', owner: ACTIVE, resting: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(active.send).toHaveBeenCalledTimes(1);
    expect(active.reread).not.toHaveBeenCalled();
    active.presence.stop();
  });

  // Fix round 1 (review Minor 1): a returning owner whose gladiator rests waits on its presence, so a failure there is
  // retried once, after the server's retry-after or 60 s; nowhere else, and never more than once.
  it('retries a failed presence once, after its retry-after or 60 s, only while its gladiator rests waiting for it', async () => {
    const refused = (retryAfterMs?: number) => async (): Promise<PresenceResult> => ({ ok: false, code: 'rate-limited', ...(retryAfterMs ? { retryAfterMs } : {}) });
    const failed = async (): Promise<PresenceResult> => { throw new Error('network'); };
    const ok = async (): Promise<PresenceResult> => ({ ok: true });

    // Refused with a retry-after of 5 s: one retry then; it fails too, and nothing more until the 6-hour mark (unchanged).
    let answers = [refused(5_000), failed, ok];
    const waiting = presence(() => answers.shift()!());
    waiting.presence.update({ account: 'first', owner: RESTING, resting: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(waiting.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(waiting.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(waiting.send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6 * HOUR - 5_000 - 1);
    expect(waiting.send).toHaveBeenCalledTimes(2);
    expect(waiting.reread).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(waiting.send).toHaveBeenCalledTimes(3);
    expect(waiting.reread).toHaveBeenCalledTimes(1);
    waiting.presence.stop();

    // A failure with no retry-after: the retry 60 s later, which is answered and reads the owner.
    answers = [failed, ok];
    const sixty = presence(() => answers.shift()!());
    sixty.presence.update({ account: 'first', owner: RESTING, resting: true });
    await vi.advanceTimersByTimeAsync(60_000 - 1);
    expect(sixty.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sixty.send).toHaveBeenCalledTimes(2);
    expect(sixty.reread).toHaveBeenCalledTimes(1);
    sixty.presence.stop();

    // Hidden when the retry falls due: it is sent once the page is visible again.
    answers = [refused(), ok];
    const hidden = presence(() => answers.shift()!());
    hidden.presence.update({ account: 'first', owner: RESTING, resting: true });
    await vi.advanceTimersByTimeAsync(0);
    hide();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(hidden.send).toHaveBeenCalledTimes(1);
    show();
    await vi.advanceTimersByTimeAsync(0);
    expect(hidden.send).toHaveBeenCalledTimes(2);
    expect(hidden.reread).toHaveBeenCalledTimes(1);
    hidden.presence.stop();

    // Nothing waits on the presence of an active gladiator, of one whose return is already known, or of one not resting.
    const others = [{ owner: ACTIVE, resting: false }, { owner: { ...RESTING, restingUntilSlot: 373_249 }, resting: true }, { owner: RESTING, resting: false }];
    for (const [i, viewer] of others.entries()) {
      const other = presence(refused(5_000));
      other.presence.update({ account: 'first', ...viewer });
      await vi.advanceTimersByTimeAsync(6 * HOUR - 1);
      expect(other.send, `viewer ${i}`).toHaveBeenCalledTimes(1);
      other.presence.stop();
    }
  });

  it('neither reads nor reports anything after it is stopped or the account changed', async () => {
    let answer!: (result: PresenceResult) => void;
    const { send, reread, presence: p } = presence(() => new Promise(resolve => { answer = resolve; }));
    p.update({ account: 'first', owner: RESTING, resting: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    p.update({ account: null, owner: null, resting: false });
    answer({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(reread).not.toHaveBeenCalled();
    show();
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    expect(send).toHaveBeenCalledTimes(1);
    p.stop();
  });
});
