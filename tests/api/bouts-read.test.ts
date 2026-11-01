import { afterEach, expect, test, vi } from 'vitest';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { RULES_V1 } from '@domain/rules-v1';
// No browser client by default (no backend configured); a test may install one over a fake Data API.
const holder = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock('../../src/lib/api/client', () => ({ getBrowserClient: () => holder.client }));
import { createLiveGateway } from '../../src/lib/api/gateway';
import { BOUTS_PAGE, boutOf, parseBoutsCursor, readBouts, type LastBout, type MyBout } from '../../src/lib/api/reads';
afterEach(() => { holder.client = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// My bouts (Arena replays patch, Task 2): the owner's own settled Arena and tournament bouts, newest first, 20 a page, from the
// owner-only `activities` table, plus ONE read of the public `visible_events` view for the opponents' names of the kept replays.
// No server change: every table, view and column is one the client reads today.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const SESSION = { user: { id: 'first' }, access_token: 'first', expires_at: Math.floor(Date.now() / 1000) + 3600 } as Session;
const SLOT_MS = RULES_V1.clock.slotMs;
/** The server's now is the end of slot 373249: the bout of `slotOf(1)` settled at exactly this time. */
const SERVER_NOW = 373_250 * SLOT_MS;
const DAY = 86_400_000;
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
const revision = () => json({ revision: '7', server_now_ms: SERVER_NOW, slot_index: 373_250, published_slot_index: 373_250 });

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** The owner's gladiator, and the gladiator `name` is when it is a player (an NPC has none). */
const ME = uuid(9000);
const ASTER = 'Aster';
const foe = (name: string) => uuid(8000 + [...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0));
const slotOf = (n: number) => 373_250 - n;
const startOf = (n: number) => slotOf(n) * SLOT_MS;

type Earned = { renown?: number; ratingDelta?: number; result?: string };
type Over = { expired?: boolean; lapsed?: boolean } & Record<string, unknown>;
/** One `activities` row as the Data API answers the read's select: bout `n`, `n` slots back, settled at its slot's end. */
function row(n: number, kind: string, earned: Earned = {}, over: Over = {}) {
  const { expired, lapsed, ...rest } = over;
  const settledAtMs = startOf(n) + SLOT_MS;
  const replayExpiry = expired ? { state: 'expired' } : lapsed ? { state: 'available', expiresAtMs: SERVER_NOW } : { state: 'available', expiresAtMs: SERVER_NOW + DAY };
  const summary = { activityId: uuid(n), resolvedKind: kind, result: earned.result ?? 'victory', success: true,
    rewards: { money: 0, renown: earned.renown ?? 0, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 }, receiptId: uuid(1000 + n), settledAtMs, replayExpiry,
    ...(earned.ratingDelta === undefined ? {} : { ratingDelta: earned.ratingDelta }) };
  return { id: uuid(n), gladiator_id: ME, slot_index: slotOf(n), starts_at_ms: startOf(n), resolved_kind: kind, settled_at_ms: settledAtMs, summary, ...rest };
}
/** Bouts `from` to `to`, all Arena victories. */
const rows = (from: number, to: number, kind = 'arena') => Array.from({ length: to - from + 1 }, (_, i) => row(from + i, kind));
/**
 * One bout stage of activity `n` as the Data API answers the names read: the label, the log's tie-break reason and the two
 * participants' id, gladiator id and name, the owner first. `opponent` is a player's name, or null for an NPC fallback named
 * `npc`. A tournament run has one such row per fought round (`ordinal` = its round).
 */
function lastBout(n: number, label: string, opponent: string | null, over: Record<string, unknown> = {}, npc = 'Iron Warden') {
  return { activity_id: uuid(n), ordinal: 1, label, tieBreakReason: null, p0id: ME, p0gladiator: ME, p0name: ASTER,
    p1id: opponent === null ? `npc:${ME}` : foe(opponent), p1gladiator: opponent === null ? null : foe(opponent), p1name: opponent ?? npc, ...over };
}

type Stage = ReturnType<typeof lastBout>;
/**
 * Answers the revision, the `activities` read (`activityRows`, as sent: the test checks the query) and the names read: the
 * stages sorted by activity and ordinal, narrowed by the keyset `or` and the `in` list and cut at `limit`, as the Data API does.
 */
const serveBouts = (activityRows: unknown[], stages: Stage[] = [], onNames?: (query: URLSearchParams) => Response | undefined) => (table: string, query: URLSearchParams) => {
  if (table === 'world_revision') return revision();
  if (table === 'activities') return json(activityRows);
  if (table !== 'visible_events') throw new Error(`Unexpected table ${table}`);
  const custom = onNames?.(query);
  if (custom) return custom;
  const wanted = new Set(/^in\.\((.*)\)$/.exec(query.get('activity_id') ?? '')?.[1]?.split(',') ?? []);
  const after = /^\(activity_id\.gt\.([^,]+),and\(activity_id\.eq\.[^,]+,ordinal\.gt\.(\d+)\)\)$/.exec(query.get('or') ?? '');
  const sorted = stages.filter(s => wanted.has(s.activity_id)).sort((a, b) => (a.activity_id < b.activity_id ? -1 : a.activity_id > b.activity_id ? 1 : 0) || a.ordinal - b.ordinal);
  const rest = after ? sorted.filter(s => s.activity_id > after[1] || (s.activity_id === after[1] && s.ordinal > Number(after[2]))) : sorted;
  return json(rest.slice(0, Number(query.get('limit'))));
};
const bouts = async (activityRows: unknown[], stages: Stage[] = [], filter: 'all' | 'won' | 'lost' = 'all') =>
  readBouts(api(serveBouts(activityRows, stages), SESSION).client, filter);

test('reads the owner’s settled Arena and tournament bouts, newest first, 20 a page', async () => {
  const { client, requests } = api(serveBouts([row(1, 'arena', { renown: 10, ratingDelta: 14 }), row(2, 'tournament')], [lastBout(1, 'Bout: victory', 'Varro')]), SESSION);
  const page = await readBouts(client, 'all');
  expect(requests.map(r => r.table)).toEqual(['world_revision', 'activities', 'visible_events']);
  const q = requests[1].query;
  expect(q.get('select')).toBe('id,gladiator_id,slot_index,starts_at_ms,resolved_kind,settled_at_ms,summary');
  expect([q.get('status'), q.get('resolved_kind'), q.get('summary'), q.get('settled_at_ms')])
    .toEqual(['eq.completed', 'in.(arena,tournament)', 'not.is.null', `lte.${SERVER_NOW}`]);
  expect([q.get('order'), q.get('limit'), q.get('summary->>result')]).toEqual(['slot_index.desc', '20', null]);
  expect(page.rows[0]).toMatchObject({ kind: 'arena', foughtAtMs: startOf(1) + 3_600_000, renown: 10, ratingDelta: 14,
    opponent: { name: 'Varro', npc: false }, tieBreak: false, round: null });
  // Everything the row shows, and nothing else of it.
  expect(page.rows[0]).toEqual<MyBout>({ activityId: uuid(1), kind: 'arena', slotIndex: slotOf(1), foughtAtMs: startOf(1) + RULES_V1.arena.revealAfterMs, settledAtMs: startOf(1) + SLOT_MS,
    result: 'victory', renown: 10, ratingDelta: 14, replayExpiry: { state: 'available', expiresAtMs: SERVER_NOW + DAY }, opponent: { name: 'Varro', npc: false }, tieBreak: false, round: null });
  // A tournament run is fought when its slot starts (the time the Tournaments panel announces), and has no opponent read here: no stage came back for it.
  expect(page.rows[1]).toMatchObject({ kind: 'tournament', foughtAtMs: startOf(2), opponent: null, round: null });
  expect(page.nextCursor).toBeNull();
  // Only the columns above cross: never a seed, snapshot, request or receipt.
  expect(q.get('select')).not.toMatch(/seed|snapshot|requested|receipt|stage/);
});

test('filters Won and Lost on the server and pages by slot', async () => {
  const { client, requests } = api(serveBouts([]), SESSION);
  await readBouts(client, 'lost', '400');
  expect(requests[1].query.get('summary->>result')).toBe('eq.defeat');
  expect(requests[1].query.get('slot_index')).toBe('lt.400');
  await readBouts(client, 'won');
  expect(requests.at(-1)!.query.get('summary->>result')).toBe('eq.victory');
  expect(requests.at(-1)!.query.get('slot_index')).toBeNull();
  await readBouts(client, 'all', '0');
  expect(requests.at(-1)!.query.get('slot_index')).toBe('lt.0');
  expect(requests.at(-1)!.query.get('summary->>result')).toBeNull();
  // A filter this client does not know is refused before any request, never read as Lost.
  const before = requests.length;
  await expect(readBouts(client, 'drawn' as never)).rejects.toMatchObject({ code: 'unavailable' });
  expect(requests).toHaveLength(before);
});

test('asks for names only of kept replays, and only the names cross', async () => {
  const { client, requests } = api(serveBouts([row(1, 'arena'), row(2, 'arena', {}, { expired: true })], []), SESSION);
  await readBouts(client, 'all');
  const v = requests.find(r => r.table === 'visible_events')!.query;
  expect(v.get('activity_id')).toBe(`in.(${uuid(1)})`);
  expect(v.get('stage->>kind')).toBe('eq.bout');
  // Only text paths and the two key columns cross: never the stage or the log as a whole.
  expect(v.get('select')!.split(',').every(field => /->>/.test(field) || ['activity_id', 'ordinal'].includes(field))).toBe(true);
  expect(v.get('select')).toBe('activity_id,ordinal,label:stage->>label,tieBreakReason:stage->battleLog->>tieBreakReason,'
    + 'p0id:stage->battleLog->participants->0->>id,p0gladiator:stage->battleLog->participants->0->>gladiatorId,p0name:stage->battleLog->participants->0->>name,'
    + 'p1id:stage->battleLog->participants->1->>id,p1gladiator:stage->battleLog->participants->1->>gladiatorId,p1name:stage->battleLog->participants->1->>name');
  // Due stages only, in the keyset order the paging needs, at the Data API's page size.
  expect([v.get('reveal_at_ms'), v.get('order'), v.get('limit'), v.get('or')]).toEqual([`lte.${SERVER_NOW}`, 'activity_id.asc,ordinal.asc', '50', null]);
  expect((await readBouts(api(serveBouts([row(2, 'arena', {}, { expired: true })]), SESSION).client, 'all')).rows[0].opponent).toBeNull();
});

test('asks for no names when no replay is kept: expired, or lapsed by the server’s time while its summary still says available', async () => {
  // The cleanup that flips `expired` runs hourly: between an expiry and it a summary still says `available`, so the expiry is compared with the server's now.
  const { client, requests } = api(serveBouts([row(1, 'arena', {}, { expired: true }), row(2, 'arena', {}, { lapsed: true }), row(3, 'tournament', {}, { expired: true })],
    [lastBout(2, 'Bout: victory', 'Varro')]), SESSION);
  const page = await readBouts(client, 'all');
  expect(requests.map(r => r.table)).toEqual(['world_revision', 'activities']);
  expect(page.rows.map(r => r.opponent)).toEqual([null, null, null]);
  expect(page.rows.map(r => r.replayExpiry.state)).toEqual(['expired', 'available', 'expired']);
  // One tick before the expiry the replay is still kept.
  const kept = api(serveBouts([row(2, 'arena', {}, { summary: { ...row(2, 'arena').summary, replayExpiry: { state: 'available', expiresAtMs: SERVER_NOW + 1 } } })],
    [lastBout(2, 'Bout: victory', 'Varro')]), SESSION);
  expect((await readBouts(kept.client, 'all')).rows[0].opponent).toEqual({ name: 'Varro', npc: false });
  expect(kept.requests.map(r => r.table)).toEqual(['world_revision', 'activities', 'visible_events']);
});

test('names an NPC, a tie-break and a tournament’s last round', async () => {
  // An NPC fallback has no gladiator id: its name is shown with the NPC tag.
  const npc = await bouts([row(1, 'arena')], [lastBout(1, 'Bout: victory', null, {}, 'Iron Warden')]);
  expect(npc.rows[0]).toMatchObject({ opponent: { name: 'Iron Warden', npc: true }, tieBreak: false, round: null });
  // Both tie-break endings of a bout are a seeded tie-break; a log with none, or a reason this client does not know, is not.
  for (const [reason, tieBreak] of [['simultaneous-defeat', true], ['equal-health-fraction', true], [null, false], ['coin-toss', false]] as const) {
    expect((await bouts([row(1, 'arena')], [lastBout(1, 'Bout: victory', 'Severus', { tieBreakReason: reason })])).rows[0].tieBreak, String(reason)).toBe(tieBreak);
  }
  // A run of Quarterfinal: victory (round 1) then Semifinal: defeat (round 2): the opponent and the round of the LAST bout (the highest ordinal).
  const run = await bouts([row(1, 'tournament', { renown: 7 })], [lastBout(1, 'Quarterfinal: victory', 'Varro', { ordinal: 1 }), lastBout(1, 'Semifinal: defeat', 'Cassia', { ordinal: 2 })]);
  expect(run.rows[0]).toMatchObject({ kind: 'tournament', opponent: { name: 'Cassia', npc: false }, round: 'Semifinal' });
  // The same two rows in the other order give the same answer: the highest ordinal wins, not the last one read.
  const reversed = await bouts([row(1, 'tournament')], [lastBout(1, 'Semifinal: defeat', 'Cassia', { ordinal: 2 }), lastBout(1, 'Quarterfinal: victory', 'Varro', { ordinal: 1 })]);
  expect(reversed.rows[0]).toMatchObject({ opponent: { name: 'Cassia' }, round: 'Semifinal' });
  // A tournament whose last bout is the final; a round it cannot name (an Arena-style label) leaves the round empty; an Arena bout never has a round.
  expect((await bouts([row(1, 'tournament')], [lastBout(1, 'Final: victory', 'Severus', { ordinal: 3 })])).rows[0]).toMatchObject({ round: 'Final', opponent: { name: 'Severus' } });
  expect((await bouts([row(1, 'tournament')], [lastBout(1, 'Bout: victory', 'Severus')])).rows[0].round).toBeNull();
  expect((await bouts([row(1, 'arena')], [lastBout(1, 'Final: victory', 'Severus')])).rows[0].round).toBeNull();
  // The owner may be the second participant of the log (a tournament pairs by bracket): the opponent is still the other one.
  const second = await bouts([row(1, 'tournament')], [lastBout(1, 'Final: victory', 'Severus', { p0id: foe('Severus'), p0gladiator: foe('Severus'), p0name: 'Severus', p1id: ME, p1gladiator: ME, p1name: ASTER })]);
  expect(second.rows[0].opponent).toEqual({ name: 'Severus', npc: false });
  // Each row gets its own activity's last bout.
  const two = await bouts([row(1, 'arena'), row(2, 'arena')], [lastBout(2, 'Bout: defeat', 'Cassia'), lastBout(1, 'Bout: victory', 'Varro')]);
  expect(two.rows.map(r => r.opponent?.name)).toEqual(['Varro', 'Cassia']);
});

test('names no opponent unless the row’s own gladiator is one of the two, or a stage cannot be read', async () => {
  const otherGladiator = lastBout(1, 'Bout: victory', 'Varro', { p0id: foe('Cato'), p0gladiator: foe('Cato'), p0name: 'Cato' });
  expect((await bouts([row(1, 'arena')], [otherGladiator])).rows[0].opponent).toBeNull();
  const bothMine = lastBout(1, 'Bout: victory', 'Varro', { p1gladiator: ME });
  expect((await bouts([row(1, 'arena')], [bothMine])).rows[0].opponent).toBeNull();
  // A stage with a missing field, a name that is not text or an empty one is no stage: the row stays, with no names and no tie-break.
  for (const broken of [{ label: null }, { p1name: null }, { p1name: '' }, { p1name: 7 }, { p0id: undefined }, { p1gladiator: 7 }, { tieBreakReason: 7 }]) {
    const { rows } = await bouts([row(1, 'tournament')], [lastBout(1, 'Final: victory', 'Varro', broken as Record<string, unknown>)]);
    expect(rows[0], JSON.stringify(broken)).toMatchObject({ opponent: null, tieBreak: false, round: null });
  }
});

test('pages the names read by activity and ordinal until a short page, and keeps the highest ordinal of each', async () => {
  // 20 kept tournament runs of three bouts each: 60 stage rows, so the 50-row cap needs a second read from where the first stopped.
  const runs = Array.from({ length: 20 }, (_, i) => i + 1);
  const stages = runs.flatMap(n => [1, 2, 3].map(ordinal => lastBout(n, `Round ${ordinal}: victory`, `Foe${n}x${ordinal}`, { ordinal })));
  const { client, requests } = api(serveBouts(rows(1, 20, 'tournament'), stages), SESSION);
  const page = await readBouts(client, 'all');
  const names = requests.filter(r => r.table === 'visible_events');
  expect(names).toHaveLength(2);
  expect(names[0].query.get('or')).toBeNull();
  // The second read starts after the 50th row: activity 17, ordinal 2 (ids sort as their numbers here).
  const sorted = [...stages].sort((a, b) => (a.activity_id < b.activity_id ? -1 : 1) || a.ordinal - b.ordinal);
  expect(names[1].query.get('or')).toBe(`(activity_id.gt.${sorted[49].activity_id},and(activity_id.eq.${sorted[49].activity_id},ordinal.gt.${sorted[49].ordinal}))`);
  expect(names[1].query.get('activity_id')).toBe(names[0].query.get('activity_id'));
  expect(page.rows.map(r => r.round)).toEqual(Array(20).fill('Round 3'));
  expect(page.rows.map(r => r.opponent?.name)).toEqual(runs.map(n => `Foe${n}x3`));
  // Exactly one full page of names (50 rows) still ends in one more, empty, read.
  const exact = api(serveBouts(rows(1, 10, 'tournament'), Array.from({ length: 50 }, (_, i) => lastBout(1 + Math.floor(i / 5), `Round ${1 + (i % 5)}: victory`, 'Varro', { ordinal: 1 + (i % 5) }))), SESSION);
  expect((await readBouts(exact.client, 'all')).rows[0].round).toBe('Round 5');
  expect(exact.requests.filter(r => r.table === 'visible_events')).toHaveLength(2);
});

test('stops when the names read does not move forward, instead of asking for ever', async () => {
  // A server that ignored the keyset and answered the same full page again must not loop this client.
  const full = Array.from({ length: 50 }, (_, i) => lastBout(1, 'Round 1: victory', 'Varro', { ordinal: i + 1 }));
  const { client, requests } = api(serveBouts([row(1, 'tournament')], [], () => json(full)), SESSION);
  await expect(readBouts(client, 'all')).rejects.toMatchObject({ code: 'unavailable' });
  expect(requests.filter(r => r.table === 'visible_events').length).toBeLessThanOrEqual(2);
  // A full page whose last row cannot name a place to continue from is refused too.
  const broken = api(serveBouts([row(1, 'tournament')], [], () => json(Array.from({ length: 50 }, () => ({ activity_id: 'not-an-id', ordinal: 1 })))), SESSION);
  await expect(readBouts(broken.client, 'all')).rejects.toMatchObject({ code: 'unavailable' });
});

test('refuses a malformed cursor before any request, and leaves out a row it cannot show', async () => {
  // 20 rows fetched: one with a summary it cannot read, then rows 2..20.
  const { client, requests } = api(serveBouts([row(1, 'arena', {}, { summary: { resolvedKind: 'arena' } }), ...rows(2, 20)]), SESSION);
  await expect(readBouts(client, 'all', 'x')).rejects.toMatchObject({ code: 'unavailable' });
  expect(requests).toHaveLength(0);
  const page = await readBouts(client, 'all');
  expect(page.rows).toHaveLength(19);
  expect(page.nextCursor).toBe(String(slotOf(20)));   // from the rows fetched, the left-out one included
});

test('the next cursor is the last fetched row’s slot when 20 were fetched, never from a short page or beyond the cap', async () => {
  expect(BOUTS_PAGE).toBe(20);
  expect((await bouts(rows(1, 19))).nextCursor).toBeNull();
  expect((await bouts(rows(1, 20))).nextCursor).toBe(String(slotOf(20)));
  // The Data API never sends more than the limit, but a 21st row would still not be shown or named.
  const over = await bouts(rows(1, 25));
  expect(over.rows).toHaveLength(20);
  expect(over.nextCursor).toBe(String(slotOf(20)));
  // When the last fetched row is the one left out, the cursor still comes from it.
  expect((await bouts([...rows(1, 19), row(20, 'arena', {}, { summary: null })])).nextCursor).toBe(String(slotOf(20)));
  // A last row with no readable slot gives nothing to continue from: refused, so the list is never silently cut short.
  await expect(bouts([...rows(1, 19), row(20, 'arena', {}, { slot_index: 'later' })])).rejects.toMatchObject({ code: 'unavailable' });
  // Bigints sent as text (a driver option) still read as numbers.
  const text = await bouts([row(1, 'arena', {}, { slot_index: String(slotOf(1)), starts_at_ms: String(startOf(1)) })]);
  expect(text.rows[0]).toMatchObject({ slotIndex: slotOf(1), foughtAtMs: startOf(1) + RULES_V1.arena.revealAfterMs });
});

/** The `code` of the error a call throws, or 'no error'. */
const codeOf = (call: () => unknown) => { try { call(); } catch (error) { return (error as { code?: string }).code; } return 'no error'; };

test('a cursor is a whole slot index: anything else is unavailable', () => {
  expect(parseBoutsCursor()).toBeNull();
  expect(parseBoutsCursor(null)).toBeNull();
  expect(parseBoutsCursor('400')).toBe(400);
  expect(parseBoutsCursor('0')).toBe(0);
  expect(parseBoutsCursor('999999999999999')).toBe(999_999_999_999_999);
  for (const bad of ['', 'x', '-1', '1.5', '01', ' 4', '4 ', '1e3', '+4', '0x10', '1000000000000000', 'lt.5', '4,id.neq.x', '4)', '٤', 400, {}, []]) {
    expect(codeOf(() => parseBoutsCursor(bad as never)), JSON.stringify(bad)).toBe('unavailable');
  }
});

const input = (over: Record<string, unknown> = {}) => {
  const base = row(1, 'arena', { renown: 10, ratingDelta: 14 });
  return { activityId: base.id, gladiatorId: ME, slotIndex: base.slot_index, startsAtMs: base.starts_at_ms, kind: 'arena', summary: base.summary, lastBout: null as LastBout | null, ...over };
};
const last = (opponent: string | null, over: Partial<LastBout> = {}): LastBout => ({ label: 'Bout: victory', tieBreakReason: null,
  participants: [{ id: ME, gladiatorId: ME, name: ASTER }, { id: opponent === null ? `npc:${ME}` : foe(opponent), gladiatorId: opponent === null ? null : foe(opponent), name: opponent ?? 'Iron Warden' }], ...over });

test('shows a row faithfully or not at all: every field is checked', () => {
  expect(boutOf(input())).toMatchObject({ activityId: uuid(1), kind: 'arena', result: 'victory', renown: 10, ratingDelta: 14, opponent: null, tieBreak: false, round: null });
  const summary = (over: Record<string, unknown>) => ({ ...row(1, 'arena', { renown: 10 }).summary, ...over });
  const refused: [string, Record<string, unknown>][] = [
    ['no activity id', { activityId: undefined }], ['an activity id that is not text', { activityId: 7 }], ['a negative slot', { slotIndex: -1 }], ['a fractional slot', { slotIndex: 1.5 }],
    ['a slot that is text but not a number', { slotIndex: 'x' }], ['no start', { startsAtMs: null }], ['an expedition', { kind: 'expedition', summary: summary({ resolvedKind: 'expedition' }) }],
    ['a rest', { kind: 'rest', summary: summary({ resolvedKind: 'rest' }) }], ['a kind the summary does not agree with', { kind: 'tournament' }], ['no summary', { summary: null }],
    ['a summary that is text', { summary: 'victory' }], ['a summary that is a list', { summary: [] }], ['a result this client does not know', { summary: summary({ result: 'draw' }) }],
    ['no result', { summary: summary({ result: undefined }) }], ['rewards that are missing', { summary: summary({ rewards: null }) }],
    ['a renown that is negative', { summary: summary({ rewards: { renown: -1 } }) }], ['a renown that is fractional', { summary: summary({ rewards: { renown: 1.5 } }) }],
    ['a renown that is text', { summary: summary({ rewards: { renown: '10' } }) }], ['a rating change that is not a whole number', { summary: summary({ ratingDelta: 1.5 }) }],
    ['a rating change that is text', { summary: summary({ ratingDelta: '14' }) }], ['no settlement time', { summary: summary({ settledAtMs: undefined }) }],
    ['a replay expiry that is missing', { summary: summary({ replayExpiry: undefined }) }], ['a replay state it does not know', { summary: summary({ replayExpiry: { state: 'gone' } }) }],
    ['an available replay with no expiry time', { summary: summary({ replayExpiry: { state: 'available' } }) }],
    ['an available replay with an expiry that is not a time', { summary: summary({ replayExpiry: { state: 'available', expiresAtMs: 'soon' } }) }],
  ];
  for (const [what, over] of refused) expect(boutOf(input(over)), what).toBeNull();
  // What it does accept: every result word, a bout with no rating change (an NPC bout) and a zero.
  for (const result of ['victory', 'defeat', 'completed']) expect(boutOf(input({ summary: summary({ result }) }))?.result).toBe(result);
  expect(boutOf(input({ summary: summary({ ratingDelta: undefined }) }))?.ratingDelta).toBeNull();
  expect(boutOf(input({ summary: summary({ ratingDelta: null }) }))?.ratingDelta).toBeNull();
  expect(boutOf(input({ summary: summary({ ratingDelta: 0 }) }))?.ratingDelta).toBe(0);
  expect(boutOf(input({ summary: summary({ ratingDelta: -13 }) }))?.ratingDelta).toBe(-13);
  expect(boutOf(input({ summary: summary({ replayExpiry: { state: 'expired' } }) }))?.replayExpiry).toEqual({ state: 'expired' });
});

test('a tournament bout is fought when its slot starts, an Arena bout at its minute 60; the settlement time is the summary’s', () => {
  const arena = boutOf(input())!;
  expect(arena.foughtAtMs).toBe(startOf(1) + 3_600_000);
  expect(arena.settledAtMs).toBe(startOf(1) + SLOT_MS);
  const tournament = boutOf(input({ kind: 'tournament', summary: row(1, 'tournament').summary }))!;
  expect(tournament.foughtAtMs).toBe(startOf(1));
  expect(tournament.kind).toBe('tournament');
});

test('names the opponent from the last bout, and only for a kept replay', () => {
  expect(boutOf(input({ lastBout: last('Varro') }))?.opponent).toEqual({ name: 'Varro', npc: false });
  expect(boutOf(input({ lastBout: last(null) }))?.opponent).toEqual({ name: 'Iron Warden', npc: true });
  // An expired summary never names one, even when a caller hands over a stage that cleanup has not removed yet.
  const expired = { summary: { ...row(1, 'arena', { renown: 10 }).summary, replayExpiry: { state: 'expired' } } };
  expect(boutOf(input({ ...expired, lastBout: last('Varro', { tieBreakReason: 'simultaneous-defeat' }) }))).toMatchObject({ opponent: null, tieBreak: false, round: null });
  // A tie-break is read from the last bout, a round from a tournament's.
  expect(boutOf(input({ lastBout: last('Varro', { tieBreakReason: 'equal-health-fraction' }) }))?.tieBreak).toBe(true);
  expect(boutOf(input({ kind: 'tournament', summary: row(1, 'tournament').summary, lastBout: last('Varro', { label: 'Quarterfinal: defeat' }) }))?.round).toBe('Quarterfinal');
  // The row's own gladiator must be in the log: a stranger's bout names nobody.
  expect(boutOf(input({ gladiatorId: uuid(1) + 'x', lastBout: last('Varro') }))?.opponent).toBeNull();
  expect(boutOf(input({ lastBout: last('Varro', { participants: [last('Varro').participants[0]] }) }))?.opponent).toBeNull();
  // Task 2 review carry: nor does it say a tie-break or a round. They rest on the same participant check as the opponent, so a row
  // never says "won on a tie-break" or "Final" of a bout that is not the owner's.
  const stranger = { gladiatorId: uuid(1) + 'x', kind: 'tournament' as const, summary: row(1, 'tournament').summary,
    lastBout: last('Varro', { label: 'Final: victory', tieBreakReason: 'simultaneous-defeat' }) };
  expect(boutOf(input(stranger))).toMatchObject({ opponent: null, tieBreak: false, round: null });
  expect(boutOf(input({ ...stranger, gladiatorId: ME }))).toMatchObject({ opponent: { name: 'Varro' }, tieBreak: true, round: 'Final' });
  expect(boutOf(input({ lastBout: last('Varro', { tieBreakReason: 'simultaneous-defeat', participants: [last('Varro').participants[0]] }) }))).toMatchObject({ tieBreak: false });
});

test('is the owner’s own read: a visitor is refused before any request', async () => {
  const { requests } = api(serveBouts([]), null);
  await expect(createLiveGateway().bouts('all')).rejects.toMatchObject({ code: 'unauthenticated' });
  expect(requests.filter(r => r.table === 'activities')).toHaveLength(0);
  expect(requests).toHaveLength(0);
});

test('the live gateway reads the signed-in owner’s bouts through the Data API only', async () => {
  const { requests } = api(serveBouts([row(1, 'arena', { renown: 10 }), row(2, 'arena', { result: 'defeat' })], [lastBout(1, 'Bout: victory', 'Varro'), lastBout(2, 'Bout: defeat', 'Cassia')]), SESSION);
  const sent = vi.fn();
  vi.stubGlobal('fetch', sent);
  const page = await createLiveGateway().bouts('won', '300');
  expect(page.rows.map(r => r.opponent?.name)).toEqual(['Varro', 'Cassia']);
  expect(requests.map(r => r.table)).toEqual(['world_revision', 'activities', 'visible_events']);
  expect(requests[1].query.get('summary->>result')).toBe('eq.victory');
  expect(requests[1].query.get('slot_index')).toBe('lt.300');
  expect(sent).not.toHaveBeenCalled();
  // A malformed cursor is the gateway's `unavailable` as well, with no further request.
  const before = requests.length;
  await expect(createLiveGateway().bouts('all', 'x')).rejects.toMatchObject({ code: 'unavailable' });
  expect(requests).toHaveLength(before);
});

test('without a configured backend the live gateway fails a bouts read explicitly', async () => {
  await expect(createLiveGateway().bouts('all')).rejects.toMatchObject({ code: 'unavailable' });
});

test('a failed read is unavailable (the server error is not forwarded) and a refused one is unauthenticated, in either of its two requests', async () => {
  const secret = { code: 'XX000', message: 'secret database detail' };
  await expect(readBouts(api(() => json(secret, 500), SESSION).client, 'all')).rejects.toMatchObject({ code: 'unavailable' });
  await expect(readBouts(api((table, q) => (table === 'activities' ? json(secret, 500) : serveBouts([])(table, q)), SESSION).client, 'all')).rejects.toMatchObject({ code: 'unavailable' });
  await expect(readBouts(api((table, q) => (table === 'activities' ? json({ code: '42501', message: 'permission denied' }, 401) : serveBouts([])(table, q)), SESSION).client, 'all'))
    .rejects.toMatchObject({ code: 'unauthenticated' });
  // The names read failing fails the page: a list is never shown half named, and Try again reads it whole.
  const names = (status: number, body: unknown) => api(serveBouts([row(1, 'arena')], [], () => json(body, status)), SESSION).client;
  await expect(readBouts(names(500, secret), 'all')).rejects.toMatchObject({ code: 'unavailable' });
  await expect(readBouts(names(401, { code: '42501', message: 'permission denied' }), 'all')).rejects.toMatchObject({ code: 'unauthenticated' });
});
