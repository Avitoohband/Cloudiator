import { expect, type Page } from '@playwright/test';

type SyncPollProbe = { armed: number; pending: number; idle: boolean };

/**
 * The shared sync controller's 30 s revision poll under Playwright's fake clock (Task 24.0c fix round 1).
 *
 * src/lib/api/sync.ts arms the next poll only once a refresh has finished (its revision read and any world read), and a poll
 * that fires during a refresh joins it instead of reading again. A test that fast-forwards 30 s as soon as it has seen a
 * request can therefore fire nothing: the timer does not exist yet, or the poll joins the refresh still in flight. Under load
 * this failed `live-camp.spec.ts:234` (owner reads 1, expected 2: two fast-forwards 9 ms apart, the first counted by a late
 * read) and raced `seasons.spec.ts`.
 *
 * `watchSyncPoll` (call it after `page.clock.install()` and before the page loads) records in the page the poll's timers
 * (30 s timeouts whose callback refreshes: armed, fired, cleared). A fired poll remains busy until its refresh rearms it.
 * Independent serverNow/world readers use the same public revision endpoint, so their completion cannot identify a sync
 * cycle. `nextSyncPoll` waits for a poll armed after the previous step, then fast-forwards 30 s: each step fires one fresh poll.
 */
export async function watchSyncPoll(page: Page) {
  await page.addInitScript(() => {
    type Timers = { setTimeout: (callback: unknown, ms?: number, ...rest: unknown[]) => unknown; clearTimeout: (id?: unknown) => void;
      __cloudiatorSyncPoll?: () => { armed: number; pending: number; idle: boolean } };
    const w = window as unknown as Timers;
    const set = w.setTimeout.bind(window), clear = w.clearTimeout.bind(window);
    const pending = new Set<unknown>();
    let armed = 0;
    const isPoll = (callback: unknown, ms: unknown) => ms === 30_000 && typeof callback === 'function' && String(callback).includes('refresh(');
    w.setTimeout = (callback, ms, ...rest) => {
      if (!isPoll(callback, ms)) return set(callback, ms, ...rest);
      const id: unknown = set((...args: unknown[]) => { pending.delete(id); return (callback as (...a: unknown[]) => unknown)(...args); }, ms, ...rest);
      pending.add(id);
      armed += 1;
      return id;
    };
    w.clearTimeout = id => { pending.delete(id); clear(id); };
    w.__cloudiatorSyncPoll = () => ({ armed, pending: pending.size, idle: pending.size > 0 });
  });
  let stepped = 0;
  const probe = () => page.evaluate(() => (window as unknown as { __cloudiatorSyncPoll?: () => SyncPollProbe }).__cloudiatorSyncPoll?.() ?? null);
  return {
    /** Waits for the poll cycle to settle and arm its next timer, e.g. before counting reads. */
    async idle() {
      await expect.poll(async () => (await probe())?.idle === true, { message: 'the sync controller is idle', timeout: 15_000 }).toBe(true);
    },
    /** Fires the next poll: waits for an idle controller with a poll armed since the previous step, then moves the clock 30 s. */
    async nextSyncPoll() {
      let ready: SyncPollProbe | null = null;
      await expect.poll(async () => {
        ready = await probe();
        return ready !== null && ready.idle && ready.armed > stepped;
      }, { message: 'the sync controller is idle with its next 30 s poll armed', timeout: 15_000 }).toBe(true);
      stepped = (ready as SyncPollProbe | null)!.armed;
      await page.clock.fastForward(30_000);
    },
  };
}
