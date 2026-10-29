import { afterEach, expect, test, vi } from 'vitest';
import { createClient, type Session } from '@supabase/supabase-js';
import { createFixtureGateway } from '../../src/lib/api/fixture-gateway';
import { readBouts } from '../../src/lib/api/reads';
import { liveRows, type LiveData } from '../browser/live-routes';
import { ARENA_OWNER, ARENA_TIMELINES } from '../fixtures/arena';
import { REPLAY_TIMELINES } from '../fixtures/battles';
import { TOURNAMENT_OWNER_TIMELINES } from '../fixtures/tournaments';
import { myBoutTimelines } from '../fixtures/my-bouts';
import { worldFixture } from '../fixtures/domain';
afterEach(() => { vi.restoreAllMocks(); });

const MY_BOUT_TIMELINES = myBoutTimelines({ ...ARENA_TIMELINES, ...REPLAY_TIMELINES, ...TOURNAMENT_OWNER_TIMELINES });

// The live-mode browser specs stand in for the server with a small PostgREST evaluator (tests/browser/live-routes.ts). The My bouts read
// asks it for JSON-path filters and projections (`summary->>result`, `stage->>kind`, `stage->battleLog->participants->0->>id`), so this
// runs the real read over it, with the same fixture bouts the fixture gateway serves: the two must agree row for row.
const SESSION = { user: { id: 'owner' }, access_token: 'owner', expires_at: Math.floor(Date.now() / 1000) + 3600 } as Session;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
/** A client whose requests are answered by the specs' evaluator over `data`; `signedIn` false is a visitor, whose private tables the transport refuses. */
function overLiveRoutes(data: LiveData, signedIn = true) {
  const requests: { table: string; query: URLSearchParams }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'test-key', { auth: { persistSession: false }, global: { fetch: async input => {
    const url = new URL(String(input)), table = url.pathname.split('/').at(-1)!;
    requests.push({ table, query: url.searchParams });
    const answer = liveRows(table, url.searchParams, { world: data.world, owner: data.owner ?? null, now: worldFixture.serverNowMs, data, reader: signedIn ? 'owner' : null });
    if (answer === 'refused') return new Response(JSON.stringify({ code: '42501', message: `permission denied for table ${table}` }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    return json(table === 'world_revision' ? answer[0] : answer);
  } } });
  vi.spyOn(client.auth, 'getSession').mockResolvedValue(signedIn ? { data: { session: SESSION }, error: null } : { data: { session: null }, error: null });
  return { client, requests };
}
const data = (over: Partial<LiveData> = {}): LiveData => ({ world: worldFixture, owner: ARENA_OWNER, bouts: MY_BOUT_TIMELINES, ...over });
const state = (live: LiveData) => ({ world: live.world, owner: live.owner ?? null, now: worldFixture.serverNowMs, data: live, reader: 'owner' });

test('the specs’ Data API serves the real read the fixture bouts, and the fixture gateway gives the same rows', async () => {
  const fixture = createFixtureGateway();
  for (const filter of ['all', 'won', 'lost'] as const) {
    const { client } = overLiveRoutes(data());
    expect(await readBouts(client, filter), filter).toEqual(await fixture.bouts(filter));
  }
  // The cursor is applied by the evaluator as the Data API would: the rows below that slot, nothing else.
  const all = await fixture.bouts('all');
  const { client } = overLiveRoutes(data());
  expect(await readBouts(client, 'all', String(all.rows[4].slotIndex))).toEqual(await fixture.bouts('all', String(all.rows[4].slotIndex)));
  expect((await readBouts(client, 'lost', String(all.rows[4].slotIndex))).rows).toHaveLength(2);
});

test('the specs’ Data API answers one activities row per activity id, and the owner’s bouts only to the signed-in owner', async () => {
  const [first] = MY_BOUT_TIMELINES;
  // The same bout is also a timeline and a notification of the spec: still one row, which the owner's timeline read finds by its id.
  const both = data({ timelines: { [first.activityId]: first }, notifications: [{ summary: first.summary! }] });
  const rows = liveRows('activities', new URLSearchParams(), state(both));
  expect(rows).not.toBe('refused');
  const ids = (rows as { id: string }[]).map(r => r.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.filter(id => id === first.activityId)).toHaveLength(1);
  expect((await readBouts(overLiveRoutes(both).client, 'all')).rows).toHaveLength(8);
  // A visitor has no grant on the owner's table.
  await expect(readBouts(overLiveRoutes(data(), false).client, 'all')).rejects.toMatchObject({ code: 'unauthenticated' });
  // An account with no gladiator has no own bouts: its rows carry no gladiator and are not listed.
  expect((await readBouts(overLiveRoutes(data({ owner: null })).client, 'all')).rows).toEqual([]);
  // The names come from the revealed stages only: a stage not due yet (a bout still ahead of the server's time) names nobody.
  const early = { ...first, stages: first.stages.map(s => (s.kind === 'bout' ? { ...s, revealedAtMs: worldFixture.serverNowMs + 60_000 } : s)) };
  expect((await readBouts(overLiveRoutes(data({ bouts: [early, ...MY_BOUT_TIMELINES.slice(1)] })).client, 'all')).rows[0].opponent).toBeNull();
});
