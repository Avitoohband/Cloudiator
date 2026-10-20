import { afterEach, expect, test, vi } from 'vitest';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
// No browser client by default (no backend configured); a test may install one over a fake Data API.
const holder = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock('../../src/lib/api/client', () => ({ getBrowserClient: () => holder.client }));
import { createLiveGateway } from '../../src/lib/api/gateway';
afterEach(() => { holder.client = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('without a configured backend, every live read and command fails explicitly instead of returning fixture authority', async () => {
  const gateway = createLiveGateway();
  const reads = [gateway.world(), gateway.revision(), gateway.timeline('activity'), gateway.profile('gladiator'),
    gateway.market(), gateway.standings('bronze'), gateway.standings('bronze', undefined, '0'), gateway.seasons(), gateway.standingOf('bronze', '0d5f8471-d919-428f-9ab7-058c95821757'),
    gateway.tournament('tournament'), gateway.tournamentLog('tournament:301:bronze:1:0'), gateway.recent()];
  await Promise.all(reads.map(read => expect(read).rejects.toMatchObject({ code: 'unavailable' })));
  await expect(gateway.command({ kind: 'edit-schedule', operationId: 'd43f7844-52e0-4302-b8e4-740035047765',
    expectedVersion: 1, phase: 'morning', choice: { kind: 'arena' } })).resolves.toEqual({ ok: false, code: 'unavailable' });
});

// Task 18.2: the marketplace's live read and commands.
const SELLER = '0d5f8471-d919-428f-9ab7-058c95821757', LISTING = '1f205d8f-cd7b-4631-9b4d-a22ef6614e70';
const offer = { id: LISTING, seller_gladiator_id: SELLER, seller_name: 'Aster', price: 95, listed_at_ms: 1_791_591_300_000, expires_at_ms: 1_792_196_100_000,
  item: { catalogId: 'iron-helmet:5:uncommon', catalogVersion: 'v1', tier: 5, rarity: 'uncommon', quantity: 1,
    stats: { damage: 0, armor: 5.18, weight: 4, intervalMs: 0, attributes: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 } } } };
/** A browser client over a fake Data API that answers only the public offers; `session` is what getSession reports. */
function api(session: Session | null) {
  const tables: string[] = [];
  const client = createClient('http://127.0.0.1:54321', 'test-key', { auth: { persistSession: false }, global: { fetch: async input => {
    const table = new URL(String(input)).pathname.split('/').at(-1)!;
    tables.push(table);
    return table === 'market_offers' ? new Response(JSON.stringify([offer]), { headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify({ code: '42501', message: 'permission denied' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  } } });
  vi.spyOn(client.auth, 'getSession').mockResolvedValue(session ? { data: { session }, error: null } : { data: { session: null }, error: null });
  holder.client = client;
  return tables;
}

test('reads offers without a session', async () => {
  const tables = api(null);
  const sent = vi.fn();
  vi.stubGlobal('fetch', sent);
  const gateway = createLiveGateway();
  const listing = { listingId: LISTING, seller: { gladiatorId: SELLER, name: 'Aster' }, item: offer.item, price: 95, listedAtMs: offer.listed_at_ms, expiresAtMs: offer.expires_at_ms };
  expect(await gateway.market()).toEqual({ rows: [listing], nextCursor: null });
  expect(await gateway.market(undefined, SELLER)).toEqual({ rows: [listing], nextCursor: null });
  // Only the public projection, and no command was sent.
  expect(tables).toEqual(['market_offers', 'market_offers']);
  expect(sent).not.toHaveBeenCalled();
  // A malformed cursor or seller is refused before any request.
  await expect(gateway.market('bad,filter')).rejects.toMatchObject({ code: 'unavailable' });
  await expect(gateway.market(undefined, 'not-a-gladiator')).rejects.toMatchObject({ code: 'unavailable' });
  expect(tables).toHaveLength(2);
});

test('sends the listing commands to the authenticated command endpoint and keeps their business codes', async () => {
  api({ user: { id: 'first' }, access_token: 'first', expires_at: Math.floor(Date.now() / 1000) + 3600 } as Session);
  const sent: unknown[] = [];
  const answers = [{ status: 200, body: { ok: true, receiptId: 'r1', value: { listingId: LISTING, expiresAtMs: 1 } } },
    { status: 409, body: { ok: false, code: 'expired' } }, { status: 409, body: { ok: false, code: 'sold' } },
    { status: 409, body: { ok: false, code: 'processing', retryAfterMs: 1000 } }];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const { status, body } = answers.shift()!;
    return new Response(JSON.stringify(body), { status });
  });
  const operationId = 'd43f7844-52e0-4302-b8e4-740035047765';
  const commands = [{ kind: 'create-listing' as const, operationId, itemId: LISTING, price: 95 }, { kind: 'cancel-listing' as const, operationId, listingId: LISTING },
    { kind: 'buy-listing' as const, operationId, listingId: LISTING }, { kind: 'buy-listing' as const, operationId, listingId: LISTING }];
  const gateway = createLiveGateway();
  const results = [];
  for (const command of commands) results.push(await gateway.command(command));
  expect(results).toEqual([{ ok: true, receiptId: 'r1', value: { listingId: LISTING, expiresAtMs: 1 } }, { ok: false, code: 'expired' }, { ok: false, code: 'sold' },
    { ok: false, code: 'processing', retryAfterMs: 1000 }]);
  expect(sent).toEqual(commands.map(body => ({ url: expect.stringMatching(/\/functions\/v1\/game-command$/), body })));
});

// Task 21.3: seasons are public reads too.
const SEASON_MS = 2_419_200_000;
const seasonRows = [{ season_index: 1, starts_at_ms: SEASON_MS, ends_at_ms: 2 * SEASON_MS, closed_at_ms: null },
  { season_index: 0, starts_at_ms: 0, ends_at_ms: SEASON_MS, closed_at_ms: SEASON_MS + 4_000 }];
const archived = { gladiator_id: SELLER, name: 'Aster', rating: 1074, human_wins: 8, human_losses: 5, rank: 4, promoted: false, inactive: false, reward_eligible: true, award_place: 3 };
const open = { gladiator_id: SELLER, name: 'Aster', rating: 1015, human_wins: 2, human_losses: 1, rank: 9, promoted: false, reward_eligible: false };
/** A browser client over a fake Data API that answers the public season objects, filtering seasons by an `eq` season index. */
function seasonApi(session: Session | null) {
  const requests: string[] = [];
  const client = createClient('http://127.0.0.1:54321', 'test-key', { auth: { persistSession: false }, global: { fetch: async input => {
    const url = new URL(String(input)), table = url.pathname.split('/').at(-1)!;
    requests.push(table);
    const named = url.searchParams.get('season_index')?.replace('eq.', '');
    const body = table === 'seasons' ? seasonRows.filter(r => named === undefined || String(r.season_index) === named).slice(0, Number(url.searchParams.get('limit') ?? 50))
      : table === 'season_standings' ? [archived] : table === 'arena_standing_reads' ? [open] : null;
    return body === null ? new Response(JSON.stringify({ code: '42501', message: 'permission denied' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  } } });
  vi.spyOn(client.auth, 'getSession').mockResolvedValue(session ? { data: { session }, error: null } : { data: { session: null }, error: null });
  holder.client = client;
  return requests;
}

test.each([['a visitor', null], ['a signed-in reader', { user: { id: 'first' }, access_token: 'first', expires_at: Math.floor(Date.now() / 1000) + 3600 } as Session]])(
  'reads seasons, the current season and a finished season for %s, without any command or private table', async (_who, session) => {
    const requests = seasonApi(session);
    const sent = vi.fn();
    vi.stubGlobal('fetch', sent);
    const gateway = createLiveGateway();
    expect(await gateway.seasons()).toEqual([{ seasonId: '1', startsAtMs: SEASON_MS, endsAtMs: 2 * SEASON_MS, closedAtMs: null },
      { seasonId: '0', startsAtMs: 0, endsAtMs: SEASON_MS, closedAtMs: SEASON_MS + 4_000 }]);
    // No season named: the latest one, which is open and reads the live view.
    expect(await gateway.standings('bronze')).toMatchObject({ league: 'bronze', seasonId: '1', archived: false,
      rows: [{ rank: 9, gladiatorId: SELLER, rewardEligible: false, awardPlace: null }] });
    // A finished season, named: the frozen archive, with its award place.
    expect(await gateway.standings('bronze', undefined, '0')).toEqual({ league: 'bronze', seasonId: '0', archived: true, nextCursor: null,
      rows: [{ rank: 4, gladiatorId: SELLER, name: 'Aster', rating: 1074, humanWins: 8, humanLosses: 5, promoted: false, inactive: false, rewardEligible: true, awardPlace: 3 }] });
    // An unknown or malformed season is unavailable; the unknown one costs a lookup, the malformed one nothing.
    await expect(gateway.standings('bronze', undefined, '7')).rejects.toMatchObject({ code: 'unavailable' });
    expect(requests).toEqual(['seasons', 'seasons', 'arena_standing_reads', 'seasons', 'season_standings', 'seasons']);
    await expect(gateway.standings('bronze', undefined, 'fixture-season-1')).rejects.toMatchObject({ code: 'unavailable' });
    expect(requests).toHaveLength(6);
    // Task 21.4: one gladiator's row of the current season, from the same public view (its rank is the view's).
    expect(await gateway.standingOf('bronze', SELLER)).toEqual({ rank: 9, gladiatorId: SELLER, name: 'Aster', rating: 1015, humanWins: 2, humanLosses: 1,
      promoted: false, inactive: false, rewardEligible: false, awardPlace: null });
    expect(requests.slice(6)).toEqual(['seasons', 'arena_standing_reads']);
    await expect(gateway.standingOf('bronze', 'not-a-gladiator')).rejects.toMatchObject({ code: 'unavailable' });
    expect(requests).toHaveLength(8);
    expect(sent).not.toHaveBeenCalled();
  });

// Task 23.9: the owner's activity signal (Task 23.8's `presence` command), answered with no receipt.
test('sends each presence with a fresh operation id, takes an answer without a receipt, and never throws', async () => {
  // Without a configured backend, a visitor, or a session that has expired: refused locally, nothing sent.
  const sent: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const answers: (() => Response)[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('Authorization') });
    return answers.shift()!();
  });
  expect(await createLiveGateway().sendPresence()).toEqual({ ok: false, code: 'unavailable' });
  api(null);
  expect(await createLiveGateway().sendPresence()).toEqual({ ok: false, code: 'unauthenticated' });
  api({ user: { id: 'first' }, access_token: 'first', expires_at: Math.floor(Date.now() / 1000) - 1 } as Session);
  expect(await createLiveGateway().sendPresence()).toEqual({ ok: false, code: 'unauthenticated' });
  expect(sent).toEqual([]);

  api({ user: { id: 'first' }, access_token: 'first', expires_at: Math.floor(Date.now() / 1000) + 3600 } as Session);
  const gateway = createLiveGateway();
  const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });
  answers.push(json({ ok: true }), json({ ok: true }), json({ ok: false, code: 'rate-limited', retryAfterMs: 1000 }, 429),
    json({ ok: true }, 500), json({ ok: false, code: 'not-a-code' }, 409), () => { throw new TypeError('network'); }, () => new Response('not json'));
  const results = [];
  for (let i = 0; i < 7; i++) results.push(await gateway.sendPresence());
  expect(results).toEqual([{ ok: true }, { ok: true }, { ok: false, code: 'rate-limited', retryAfterMs: 1000 },
    { ok: false, code: 'unavailable' }, { ok: false, code: 'unavailable' }, { ok: false, code: 'unavailable' }, { ok: false, code: 'unavailable' }]);
  // The authenticated command endpoint, with only the kind and a new operation id each time (never reused, even after a failure).
  expect(sent).toHaveLength(7);
  for (const request of sent) {
    expect(request.url).toMatch(/\/functions\/v1\/game-command$/);
    expect(request.auth).toBe('Bearer first');
    expect(Object.keys(request.body).sort()).toEqual(['kind', 'operationId']);
    expect(request.body.kind).toBe('presence');
    expect(request.body.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  expect(new Set(sent.map(request => request.body.operationId)).size).toBe(7);
  // A presence is not a receipted command: `command()` still refuses it locally, and an ordinary command still needs its receipt.
  expect(await gateway.command({ kind: 'presence', operationId: 'd43f7844-52e0-4302-b8e4-740035047765' })).toEqual({ ok: false, code: 'unavailable' });
  answers.push(json({ ok: true }));
  expect(await gateway.command({ kind: 'set-tournament-opt-in', operationId: 'd43f7844-52e0-4302-b8e4-740035047765', enabled: true }))
    .toEqual({ ok: false, code: 'unavailable' });
  expect(sent).toHaveLength(8);
});
