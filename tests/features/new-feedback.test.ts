import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NEW_FEEDBACK_POLL_MS, pollNewFeedback, rememberEditor, rememberedEditor } from '../../src/features/game-info/new-feedback';

// Patch 1.9 final fix wave (notes.md Q5): the owner's count of New feedback on the corner chip's Game Info button. It is read at once, again
// on request (Game Info closed), and every few minutes while the page is visible, never more often than every 2 minutes; one read at a time.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** A count read the test answers by hand, one at a time. */
function reads() {
  const pending: ((value: number | 'forbidden' | null) => void)[] = [];
  const read = vi.fn(() => new Promise<number | 'forbidden' | null>(resolve => { pending.push(resolve); }));
  const answer = async (value: number | 'forbidden' | null) => { pending.shift()!(value); await vi.advanceTimersByTimeAsync(0); };
  return { read, answer };
}

test('reads the count at once and then every 3 minutes, not sooner', async () => {
  const { read, answer } = reads();
  const report = vi.fn();
  const poll = pollNewFeedback(read, report, { visible: () => true });
  expect(read).toHaveBeenCalledTimes(1);
  await answer(3);
  expect(report).toHaveBeenLastCalledWith(3);
  await vi.advanceTimersByTimeAsync(NEW_FEEDBACK_POLL_MS - 1);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  await answer(5);
  expect(report).toHaveBeenLastCalledWith(5);
  expect(NEW_FEEDBACK_POLL_MS).toBeGreaterThanOrEqual(120_000);
  poll.stop();
});

test('never polls faster than every 2 minutes, and skips a tick while the page is hidden', async () => {
  const { read, answer } = reads();
  let visible = true;
  const poll = pollNewFeedback(read, vi.fn(), { intervalMs: 1_000, visible: () => visible });
  await answer(1);
  await vi.advanceTimersByTimeAsync(119_999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  await answer(1);
  visible = false;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(read).toHaveBeenCalledTimes(2);
  poll.stop();
});

test('refresh reads at once; a refresh during a read reads once more after it; a failed read keeps the count', async () => {
  const { read, answer } = reads();
  const report = vi.fn();
  const poll = pollNewFeedback(read, report, { visible: () => true });
  poll.refresh();
  poll.refresh();
  expect(read).toHaveBeenCalledTimes(1);
  await answer(2);
  expect(read).toHaveBeenCalledTimes(2);
  await answer(null);
  expect(report.mock.calls).toEqual([[2]]);
  poll.refresh();
  expect(read).toHaveBeenCalledTimes(3);
  await answer('forbidden');
  expect(report).toHaveBeenLastCalledWith('forbidden');
  poll.stop();
});

test('after stop nothing is read and a read in flight reports nothing', async () => {
  const { read, answer } = reads();
  const report = vi.fn();
  const poll = pollNewFeedback(read, report, { visible: () => true });
  poll.stop();
  await answer(4);
  poll.refresh();
  await vi.advanceTimersByTimeAsync(10 * NEW_FEEDBACK_POLL_MS);
  expect(read).toHaveBeenCalledTimes(1);
  expect(report).not.toHaveBeenCalled();
});

test('the editor is remembered per browser for its own account only, and forgotten when it is refused', () => {
  const store = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); } } });
  expect(rememberedEditor('avi')).toBe(false);
  rememberEditor('avi', true);
  expect(rememberedEditor('avi')).toBe(true);
  expect(rememberedEditor('someone-else')).toBe(false);
  // Another account refused does not forget Avi's.
  rememberEditor('someone-else', false);
  expect(rememberedEditor('avi')).toBe(true);
  rememberEditor('avi', false);
  expect(rememberedEditor('avi')).toBe(false);
  // Storage that throws (blocked site data) reads as not remembered and never throws.
  vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => undefined } });
  expect(rememberedEditor('avi')).toBe(false);
  expect(() => rememberEditor('avi', true)).not.toThrow();
});

// Final review (client minor, fix round 1): a tab that becomes visible again reads the count at once, through the same one-read-at-a-time
// guard (a read still out reads once more after it); the 2-minute floor still holds for the timer.
test('reads again when the page becomes visible again, one read at a time', async () => {
  const { read, answer } = reads();
  let onVisible: (() => void) | null = null;
  const unwatch = vi.fn();
  const poll = pollNewFeedback(read, vi.fn(), { visible: () => true, watchVisible: listener => { onVisible = listener; return unwatch; } });
  expect(read).toHaveBeenCalledTimes(1);
  onVisible!();
  expect(read).toHaveBeenCalledTimes(1);
  await answer(1);
  expect(read).toHaveBeenCalledTimes(2);
  await answer(2);
  onVisible!();
  expect(read).toHaveBeenCalledTimes(3);
  await answer(3);
  poll.stop();
  expect(unwatch).toHaveBeenCalledTimes(1);
  onVisible!();
  expect(read).toHaveBeenCalledTimes(3);
});

test('by default it listens for the document becoming visible, and stops listening on stop', async () => {
  const { read, answer } = reads();
  const listeners = new Set<() => void>();
  let state = 'hidden';
  vi.stubGlobal('document', { get visibilityState() { return state; }, addEventListener: (type: string, fn: () => void) => { if (type === 'visibilitychange') listeners.add(fn); },
    removeEventListener: (type: string, fn: () => void) => { if (type === 'visibilitychange') listeners.delete(fn); } });
  const poll = pollNewFeedback(read, vi.fn());
  await answer(1);
  expect(listeners.size).toBe(1);
  // Hidden: nothing; visible again: one read.
  for (const fn of listeners) fn();
  expect(read).toHaveBeenCalledTimes(1);
  state = 'visible';
  for (const fn of listeners) fn();
  expect(read).toHaveBeenCalledTimes(2);
  await answer(2);
  poll.stop();
  expect(listeners.size).toBe(0);
});
