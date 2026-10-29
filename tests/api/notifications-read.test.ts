import { afterEach, expect, test, vi } from 'vitest';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { ActivitySummary, CreditedRewards } from '@contracts/events';
import type { GameNotification } from '@contracts/reads';
// No browser client by default (no backend configured); a test may install one over a fake Data API.
const holder = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock('../../src/lib/api/client', () => ({ getBrowserClient: () => holder.client }));
import { createLiveGateway } from '../../src/lib/api/gateway';
import { createFixtureGateway } from '../../src/lib/api/fixture-gateway';
import { readNotifications } from '../../src/lib/api/reads';
afterEach(() => { holder.client = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Notifications (2026-10-28): the owner's own settled results, newest 20, read from the owner-only `activities` table in one request
// that also names the gladiator's current level and XP and how many results settled after the server's now (so the level each result
// reached is derived from one snapshot, and only when no unlisted result could have changed the XP).
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const SESSION = { user: { id: 'first' }, access_token: 'first', expires_at: Math.floor(Date.now() / 1000) + 3600 } as Session;
const SERVER_NOW = 1_791_600_000_000;
/** A browser client over a fake Data API; `answer` gets each request's table and query. `session` is what getSession reports. */
function api(answer: (table: string, query: URLSearchParams) => Response, session: Session | null = null) {
  const requests: { table: string; query: URLSearchParams; auth: string | null }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'test-key', { auth: { persistSession: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input)), table = url.pathname.split('/').at(-1)!;
    requests.push({ table, query: url.searchParams, auth: new Headers(init?.headers).get('Authorization') });
    return answer(table, url.searchParams);
  } } });
  vi.spyOn(client.auth, 'getSession').mockResolvedValue(session ? { data: { session }, error: null } : { data: { session: null }, error: null });
  holder.client = client;
  return { client, requests };
}
const revision = () => json({ revision: '7', server_now_ms: SERVER_NOW, slot_index: 372, published_slot_index: 372 });
/** Answers the revision read and the activities read (`rows`). */
const serve = (rows: unknown, status = 200) => (table: string) => (table === 'world_revision' ? revision() : json(rows, status));

const rewards = (over: Partial<CreditedRewards> = {}): CreditedRewards => ({ money: 0, renown: 0, xp: 0, attributePoints: 0, items: [], overflowMoney: 0, ...over });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const summaryOf = (n: number, kind: ActivitySummary['resolvedKind'], earned: Partial<CreditedRewards> = {}, over: Partial<ActivitySummary> = {}): ActivitySummary =>
  ({ activityId: uuid(n), resolvedKind: kind, result: kind === 'training' ? 'completed' : 'victory', success: true, rewards: rewards(earned), receiptId: uuid(1000 + n),
    settledAtMs: SERVER_NOW - n * 1000, replayExpiry: { state: 'expired' }, ...over });
/** The gladiator as the Data API embeds it: its level and XP now, and how many results settled after the server's now (an unlisted one could hold XP). */
const snap = (level: number, xp: number, later = 0) => ({ level, xp, newer: [{ count: later }] });
/** One row as the Data API answers it: id, slot, settlement time, the summary, the expedition id and the gladiator's level and XP. */
const row = (n: number, kind: ActivitySummary['resolvedKind'], earned: Partial<CreditedRewards> = {}, over: Record<string, unknown> = {},
  current: unknown = snap(1, 0)) =>
  ({ id: uuid(n), slot_index: 400 - n, settled_at_ms: SERVER_NOW - n * 1000, summary: summaryOf(n, kind, earned), destination: kind === 'expedition' ? 'woodland' : null,
    gladiators: current, ...over });

test('reads the owner\'s newest 20 settled results from the server\'s now, newest first, with the destination and no private column', async () => {
  const current = snap(2, 0);
  const { client, requests } = api(serve([row(1, 'training', { attributePoints: 1 }, {}, current), row(2, 'expedition', { money: 20, xp: 100 }, {}, current)]), SESSION);
  const { items: list, newestSettledMs } = await readNotifications(client);
  expect(requests.map(r => r.table)).toEqual(['world_revision', 'activities']);
  const query = requests[1].query;
  expect(query.get('select')).toBe('id,slot_index,settled_at_ms,summary,destination:requested->>expeditionId,gladiators(level,xp,newer:activities(count))');
  // Completed and revealed (settled at or before the server's now), never a rest, in the four kinds that earn something, with a summary.
  expect(query.get('status')).toBe('eq.completed');
  expect(query.get('resolved_kind')).toBe('in.(training,expedition,arena,tournament)');
  expect(query.get('summary')).toBe('not.is.null');
  expect(query.get('settled_at_ms')).toBe(`lte.${SERVER_NOW}`);
  expect(query.get('order')).toBe('settled_at_ms.desc,slot_index.desc');
  expect(query.get('limit')).toBe('20');
  // The gladiator's embedded count is of the results that settled after that same now: the XP of one of those is not in the list.
  expect(query.get('gladiators.newer.status')).toBe('eq.completed');
  expect(query.get('gladiators.newer.settled_at_ms')).toBe(`gt.${SERVER_NOW}`);
  // The seed, the snapshot, the job and the request never cross: only the columns above.
  expect(query.get('select')).not.toMatch(/seed|snapshot|requested(?!->>)|receipt/);
  expect(list).toEqual<GameNotification[]>([
    { activityId: uuid(1), kind: 'training', settledAtMs: SERVER_NOW - 1000, summary: summaryOf(1, 'training', { attributePoints: 1 }), destination: null, levelAfter: null },
    { activityId: uuid(2), kind: 'expedition', settledAtMs: SERVER_NOW - 2000, summary: summaryOf(2, 'expedition', { money: 20, xp: 100 }), destination: 'Woodland Path', levelAfter: 2 },
  ]);
  // The newest settled time of the rows fetched (the "seen" mark's upper bound); none fetched, none.
  expect(newestSettledMs).toBe(SERVER_NOW - 1000);
  expect(await readNotifications(api(serve([]), SESSION).client)).toEqual({ items: [], newestSettledMs: null });
});

test('names the destination from the catalog: the three expeditions, and null for an id it does not know or none', async () => {
  const rows = [row(1, 'expedition', {}, { destination: 'woodland' }), row(2, 'expedition', {}, { destination: 'outpost' }), row(3, 'expedition', {}, { destination: 'mountain' }),
    row(4, 'expedition', {}, { destination: 'volcano' }), row(5, 'expedition', {}, { destination: null }), row(6, 'arena', {}, { destination: 'woodland' })];
  const { items: list } = await readNotifications(api(serve(rows), SESSION).client);
  expect(list.map(n => n.destination)).toEqual(['Woodland Path', 'Ruined Outpost', 'Mountain Pass', null, null, null]);
});

test('derives the level a result reached from the XP of the results after it and the gladiator\'s level now, and from nothing else', async () => {
  // Level n costs 100 × n to leave. A gladiator now at level 4 with 0 XP has 600 in all: the results below, oldest first, took it
  // 100 (level 2, 0), 350 (level 3, 50), 400 (level 3, 100), 600 (level 4, 0). Arena and training earned no XP and reach no level.
  const rows = [row(1, 'expedition', { xp: 200 }), row(2, 'arena', { renown: 5 }), row(3, 'expedition', { xp: 50 }), row(4, 'training', { attributePoints: 1 }),
    row(5, 'expedition', { xp: 250 }), row(6, 'expedition', { xp: 100 })].map(r => ({ ...r, gladiators: snap(4, 0) }));
  const { items: list } = await readNotifications(api(serve(rows), SESSION).client);
  expect(list.map(n => n.levelAfter)).toEqual([4, null, null, null, 3, 2]);
  // The level is claimed by the result that crossed into it, not by a later one: at level 4 with 30 XP (630 in all), a result of 31 XP
  // began at 599 (level 3) and is the one that reached level 4; a result of 30 XP began at exactly 600, already level 4.
  const crossing = async (xp: number) => (await readNotifications(api(serve([row(1, 'expedition', { xp })].map(r => ({ ...r, gladiators: snap(4, 30) }))), SESSION).client)).items;
  expect((await crossing(31))[0].levelAfter).toBe(4);
  expect((await crossing(30))[0].levelAfter).toBeNull();
  // Several levels in one result: 100 + 200 + 300 = 600 XP at once, from level 1 to level 4.
  const { items: jump } = await readNotifications(api(serve([row(1, 'expedition', { xp: 600 })].map(r => ({ ...r, gladiators: snap(4, 0) }))), SESSION).client);
  expect(jump[0].levelAfter).toBe(4);
});

test('never guesses a level: with the gladiator unknown or the numbers inconsistent, no result claims one', async () => {
  const expedition = (xp: number) => row(1, 'expedition', { xp });
  // No gladiator in the answer, or one with no level or XP, or text instead of numbers.
  const nothingLater = { newer: [{ count: 0 }] };
  for (const gladiators of [null, {}, nothingLater, { level: 2, ...nothingLater }, { level: 'two', xp: 0, ...nothingLater }, { level: 0, xp: 0, ...nothingLater },
    { level: 2, xp: -1, ...nothingLater }, { level: 1.5, xp: 0, ...nothingLater }]) {
    const { items: list } = await readNotifications(api(serve([{ ...expedition(100), gladiators }]), SESSION).client);
    expect(list.map(n => n.levelAfter), JSON.stringify(gladiators)).toEqual([null]);
  }
  // More XP in the results than the gladiator has ever had cannot be true: nothing is said of the levels.
  expect((await readNotifications(api(serve([{ ...expedition(500), gladiators: snap(1, 0) }]), SESSION).client)).items[0].levelAfter).toBeNull();
  // A result with a level-up is not claimed when no level was crossed (XP only).
  expect((await readNotifications(api(serve([{ ...expedition(50), gladiators: snap(1, 50) }]), SESSION).client)).items[0].levelAfter).toBeNull();
  // A result that settled after the server's now (committed between the clock read and this read) may hold XP this list does not show:
  // the numbers cannot be trusted, so no level is claimed. Nor when the count is missing or malformed.
  for (const newer of [[{ count: 1 }], [{ count: 2 }], [], undefined, null, [{ count: '0' }], [{}], [{ count: 0 }, { count: 0 }], 'none']) {
    const { items: list } = await readNotifications(api(serve([{ ...expedition(100), gladiators: { level: 2, xp: 0, newer } }]), SESSION).client);
    expect(list.map(n => n.levelAfter), JSON.stringify(newer)).toEqual([null]);
  }
  expect((await readNotifications(api(serve([{ ...expedition(100), gladiators: snap(2, 0) }]), SESSION).client)).items[0].levelAfter).toBe(2);
  // An absent or malformed XP amount in a result stops the derivation there: the older results are not guessed either.
  const rows = [row(1, 'expedition', { xp: 100 }), { ...row(2, 'expedition', { xp: 1 }), summary: { ...summaryOf(2, 'expedition'), rewards: { ...rewards(), xp: 'lots' } } },
    row(3, 'expedition', { xp: 100 })].map(r => ({ ...r, gladiators: snap(2, 0) }));
  const { items: list } = await readNotifications(api(serve(rows), SESSION).client);
  expect(list.map(n => n.activityId)).toEqual([uuid(1), uuid(3)]);
  expect(list.map(n => n.levelAfter)).toEqual([2, null]);
});

test('shows only what it understands: a row of another kind or without a usable summary is left out, never failed on', async () => {
  const good = row(9, 'training', { attributePoints: 1 });
  const rows = [good, row(8, 'rest'), { ...row(7, 'arena'), summary: null }, { ...row(6, 'arena'), summary: 'text' }, { ...row(5, 'arena'), summary: { ...summaryOf(5, 'arena'), rewards: null } },
    { ...row(4, 'arena'), summary: { ...summaryOf(4, 'arena'), rewards: { ...rewards(), items: 'sword' } } }, { ...row(3, 'arena'), summary: { ...summaryOf(3, 'arena'), rewards: { ...rewards(), renown: -1 } } },
    { ...row(2, 'arena'), id: 7 }, { ...row(1, 'arena'), settled_at_ms: 'soon' }];
  expect((await readNotifications(api(serve(rows), SESSION).client)).items.map(n => n.activityId)).toEqual([uuid(9)]);
});

test('names the newest settled time of EVERY row fetched, so a newest row the list leaves out still moves the "seen" mark', async () => {
  // The badge counts every completed result of the four kinds, but the list drops a row this client cannot read: the mark is sent up to
  // the newest fetched row, not the newest one shown, or an unreadable newest row would keep the badge on for good.
  const readable = row(5, 'training', { attributePoints: 1 });
  const unreadable = { ...row(1, 'arena'), summary: { ...summaryOf(1, 'arena'), rewards: { ...rewards(), renown: -1 } } };
  const read = await readNotifications(api(serve([unreadable, row(3, 'training', { attributePoints: 1 }), readable]), SESSION).client);
  expect(read.items.map(n => n.activityId)).toEqual([uuid(3), uuid(5)]);
  expect(read.newestSettledMs).toBe(SERVER_NOW - 1000);
  // Every way a row can be left out counts: an unknown kind, no summary, a summary that is not an object, an id that is not text.
  for (const dropped of [{ ...row(1, 'arena'), summary: null }, { ...row(1, 'arena'), summary: 'text' }, { ...row(1, 'rest') }, { ...row(1, 'arena'), id: 7 }]) {
    const one = await readNotifications(api(serve([dropped, readable]), SESSION).client);
    expect(one.items.map(n => n.activityId), JSON.stringify(dropped)).toEqual([uuid(5)]);
    expect(one.newestSettledMs, JSON.stringify(dropped)).toBe(SERVER_NOW - 1000);
  }
  // A settled time that is not a number is no time at all: it never becomes the bound (text from a bigint column still does).
  const text = await readNotifications(api(serve([{ ...row(1, 'arena'), settled_at_ms: 'soon' }, { ...readable, settled_at_ms: String(SERVER_NOW - 5000) }]), SESSION).client);
  expect(text.newestSettledMs).toBe(SERVER_NOW - 5000);
  expect((await readNotifications(api(serve([{ ...row(1, 'arena'), settled_at_ms: 'soon' }]), SESSION).client)).newestSettledMs).toBeNull();
  // Like the list, the bound covers the 20 rows kept, never a 21st the server sent beyond the cap.
  const many = [...Array.from({ length: 20 }, (_, i) => row(i + 10, 'training', { attributePoints: 1 })), row(1, 'training', { attributePoints: 1 })];
  expect((await readNotifications(api(serve(many), SESSION).client)).newestSettledMs).toBe(SERVER_NOW - 10_000);
});

test('turns numbers from the database into numbers and caps the list at 20 even if the server sent more', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => row(i + 1, 'training', { attributePoints: 1 }));
  const { items: list } = await readNotifications(api(serve(rows), SESSION).client);
  expect(list).toHaveLength(20);
  expect(list[0].activityId).toBe(uuid(1));
  expect(list.every(n => typeof n.settledAtMs === 'number')).toBe(true);
  // A bigint sent as text (a driver option) still reads as a number.
  const { items: [read] } = await readNotifications(api(serve([{ ...row(1, 'training', { attributePoints: 1 }), settled_at_ms: String(SERVER_NOW - 1000), slot_index: '399' }]), SESSION).client);
  expect(read.settledAtMs).toBe(SERVER_NOW - 1000);
});

test('a failed read is unavailable (the server error is not forwarded) and a refused one is unauthenticated', async () => {
  await expect(readNotifications(api(() => json({ code: 'XX000', message: 'secret database detail' }, 500), SESSION).client)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(readNotifications(api(serve({ code: 'XX000', message: 'secret database detail' }, 500), SESSION).client)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(readNotifications(api(serve({ code: '42501', message: 'permission denied' }, 401), SESSION).client)).rejects.toMatchObject({ code: 'unauthenticated' });
});

test('the live gateway reads notifications for the signed-in owner only: a visitor is refused before any request', async () => {
  const visitor = api(serve([row(1, 'training', { attributePoints: 1 })]), null);
  await expect(createLiveGateway().notifications()).rejects.toMatchObject({ code: 'unauthenticated' });
  expect(visitor.requests).toEqual([]);
  const { requests } = api(serve([row(1, 'training', { attributePoints: 1 })]), SESSION);
  const sent = vi.fn();
  vi.stubGlobal('fetch', sent);
  const { items: list, newestSettledMs } = await createLiveGateway().notifications();
  expect(list.map(n => n.activityId)).toEqual([uuid(1)]);
  expect(newestSettledMs).toBe(SERVER_NOW - 1000);
  expect(requests.map(r => r.table)).toEqual(['world_revision', 'activities']);
  expect(sent).not.toHaveBeenCalled();
});

test('without a configured backend the live gateway fails a notifications read explicitly', async () => {
  await expect(createLiveGateway().notifications()).rejects.toMatchObject({ code: 'unavailable' });
});

test('sends "seen up to" to the authenticated command endpoint and takes an answer with no receipt, keeping the business codes', async () => {
  api(() => json([]), SESSION);
  const sent: { url: string; body: unknown; auth: string | null }[] = [];
  const answers = [{ status: 200, body: { ok: true, value: { seenMs: 1_791_590_400_000 } } }, { status: 400, body: { ok: false, code: 'invalid' } },
    { status: 429, body: { ok: false, code: 'rate-limited', retryAfterMs: 900 } },
    // Never taken as a mark: a success with no value or a value that is not a time, a 5xx with a success body, a receipt-bearing success and a garbled answer.
    { status: 200, body: { ok: true } }, { status: 200, body: { ok: true, value: { seenMs: 'now' } } }, { status: 500, body: { ok: true, value: { seenMs: 1 } } },
    { status: 200, body: 'not an object' }];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('Authorization') });
    const { status, body } = answers.shift()!;
    return new Response(JSON.stringify(body), { status });
  });
  const command = { kind: 'see-notifications' as const, operationId: 'd43f7844-52e0-4302-b8e4-740035047765', upToMs: 1_791_590_400_000 };
  const gateway = createLiveGateway();
  const results = [];
  for (let i = 0; i < 7; i++) results.push(await gateway.command(command));
  expect(results).toEqual([{ ok: true, receiptId: '', value: { seenMs: 1_791_590_400_000 } }, { ok: false, code: 'invalid' },
    { ok: false, code: 'rate-limited', retryAfterMs: 900 }, { ok: false, code: 'unavailable' }, { ok: false, code: 'unavailable' }, { ok: false, code: 'unavailable' },
    { ok: false, code: 'unavailable' }]);
  expect(sent).toEqual(Array(7).fill({ url: expect.stringMatching(/\/functions\/v1\/game-command$/), body: command, auth: 'Bearer first' }));
});

test('a visitor\'s "seen up to" is refused locally and sends nothing', async () => {
  api(() => json([]), null);
  const sent = vi.fn();
  vi.stubGlobal('fetch', sent);
  expect(await createLiveGateway().command({ kind: 'see-notifications', operationId: 'd43f7844-52e0-4302-b8e4-740035047765', upToMs: 1 }))
    .toEqual({ ok: false, code: 'unauthenticated' });
  expect(sent).not.toHaveBeenCalled();
});

test('the fixture preview lists sample notifications, newest first, and agrees with the owner\'s inbox', async () => {
  const gateway = createFixtureGateway();
  const { items: list, newestSettledMs } = await gateway.notifications();
  // The mark's upper bound is the newest sample's time.
  expect(newestSettledMs).toBe(list[0].settledAtMs);
  expect(list.length).toBeGreaterThan(2);
  expect(list.map(n => n.settledAtMs)).toEqual([...list.map(n => n.settledAtMs)].sort((a, b) => b - a));
  expect(new Set(list.map(n => n.activityId)).size).toBe(list.length);
  // The preview's gladiator is level 1 (the owner fixture): no sample claims a level above the one it has reached.
  const owner = await gateway.owner();
  expect(owner.progression.level).toBe(1);
  expect(list.every(n => n.levelAfter === null || n.levelAfter <= owner.progression.level)).toBe(true);
  for (const n of list) {
    expect(['training', 'expedition', 'arena', 'tournament']).toContain(n.kind);
    expect(n.summary.resolvedKind).toBe(n.kind);
    expect(n.summary.activityId).toBe(n.activityId);
    expect(n.settledAtMs).toBe(n.summary.settledAtMs);
  }
  // The owner's inbox is what these results make of it: new = settled after the mark.
  const { inbox } = owner;
  expect(inbox.newNotifications).toBe(list.filter(n => n.settledAtMs > inbox.notificationsSeenMs).length);
  expect(inbox.newNotifications).toBeGreaterThan(0);
  // A copy each time: a caller that edits it changes nothing for the next.
  list[0].destination = 'Edited';
  expect((await gateway.notifications()).items[0].destination).not.toBe('Edited');
  // The preview takes no commands: "seen up to" is refused like every command there.
  expect(await gateway.command({ kind: 'see-notifications', operationId: 'd43f7844-52e0-4302-b8e4-740035047765', upToMs: 1 })).toEqual({ ok: false, code: 'unavailable' });
});
