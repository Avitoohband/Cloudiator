import { afterEach, expect, test, vi } from 'vitest';
import type { BattleLog } from '@contracts/events';

// Task 23.4 (C7): the live gateway's tournament log cache is bounded. It keeps the most recently used logs, so a camp
// that follows a long tournament (or several leagues) never holds every log of the slot for the whole session.
const holder = vi.hoisted(() => ({ reads: [] as string[], failing: new Set<string>() }));
vi.mock('../../src/lib/api/client', () => ({
  getBrowserClient: () => ({ auth: { getSession: async () => ({ data: { session: null }, error: null }) } }),
}));
vi.mock('../../src/lib/api/reads', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/lib/api/reads')>();
  return {
    ...original,
    readTournamentLog: async (_client: unknown, boutId: string) => {
      holder.reads.push(boutId);
      if (holder.failing.has(boutId)) throw new original.GatewayReadError('unavailable');
      return { battleId: boutId } as unknown as BattleLog;
    },
  };
});
import { TOURNAMENT_LOG_CACHE_LIMIT, createLiveGateway } from '../../src/lib/api/gateway';

afterEach(() => { holder.reads.length = 0; holder.failing.clear(); });
const bout = (n: number) => `tournament:301:bronze:1:${n}`;
const readsOf = (id: string) => holder.reads.filter(r => r === id).length;

test('keeps at most N tournament logs in the cache', async () => {
  // Big enough for the camp's six rings (their current and next windows) and the panel's watched replay, small enough
  // that a whole 50-entrant slot of four leagues (about 200 logs of 9-14 KB) is never held at once.
  expect(TOURNAMENT_LOG_CACHE_LIMIT).toBeGreaterThanOrEqual(6 * 2 + 1);
  expect(TOURNAMENT_LOG_CACHE_LIMIT).toBeLessThanOrEqual(128);
  const gateway = createLiveGateway();
  const n = TOURNAMENT_LOG_CACHE_LIMIT;
  for (let i = 0; i < n; i += 1) expect(await gateway.tournamentLog(bout(i))).toEqual({ battleId: bout(i) });
  expect(holder.reads).toHaveLength(n);
  // Every cached log is served without another read, and asking for one makes it the most recently used.
  for (let i = 0; i < n; i += 1) await gateway.tournamentLog(bout(i));
  expect(holder.reads).toHaveLength(n);
  await gateway.tournamentLog(bout(0));
  // One more log evicts the least recently used one (bout 1, since bout 0 was just used), and only that one.
  await gateway.tournamentLog(bout(n));
  expect(holder.reads).toHaveLength(n + 1);
  await gateway.tournamentLog(bout(0));
  expect(readsOf(bout(0))).toBe(1);
  await gateway.tournamentLog(bout(1));
  expect(readsOf(bout(1))).toBe(2);
  // Ten more: the cache never holds more than its limit (the oldest are read again when asked).
  for (let i = n + 1; i <= n + 10; i += 1) await gateway.tournamentLog(bout(i));
  const before = holder.reads.length;
  for (let i = 0; i <= n + 10; i += 1) await gateway.tournamentLog(bout(i));
  const reread = holder.reads.length - before;
  expect(reread).toBeGreaterThanOrEqual(n + 11 - TOURNAMENT_LOG_CACHE_LIMIT);
});

test('shares one pending read and forgets a failed one, so it can be asked again', async () => {
  const gateway = createLiveGateway();
  const [a, b] = [gateway.tournamentLog(bout(7)), gateway.tournamentLog(bout(7))];
  expect(a).toBe(b);
  await a;
  expect(readsOf(bout(7))).toBe(1);
  holder.failing.add(bout(8));
  await expect(gateway.tournamentLog(bout(8))).rejects.toMatchObject({ code: 'unavailable' });
  holder.failing.delete(bout(8));
  expect(await gateway.tournamentLog(bout(8))).toEqual({ battleId: bout(8) });
  expect(readsOf(bout(8))).toBe(2);
});
