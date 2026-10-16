import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
const holder = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock('../../src/lib/api/client', () => ({ getBrowserClient: () => holder.client }));
import { createLiveGateway } from '../../src/lib/api/gateway';
afterEach(() => { holder.client = null; });
describe('live projection session guards', () => {
  it.each([{state:{gladiatorId:'private-first'}},null])('rejects a delayed owner success/no-character response from the previous account: %j', async response => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let session = { user: { id: 'first' }, access_token: 'first-token' } as Session;
    const client = createClient('http://127.0.0.1:54321', 'test-key', { auth: {persistSession:false}, global:{fetch:async()=>{
      await wait;return new Response(JSON.stringify(response),{headers:{'Content-Type':'application/json'}});
    }}});
    vi.spyOn(client.auth,'getSession').mockImplementation(async()=>({data:{session},error:null}));holder.client=client;
    const gateway=createLiveGateway(), pending=gateway.owner();
    await new Promise(resolve=>setTimeout(resolve,0));
    session={user:{id:'second'},access_token:'second-token'} as Session;release();
    await expect(pending).rejects.toMatchObject({code:'unauthenticated'});
  });
  it('uses protected server authorization for expiry and never substitutes fixtures on a denied read', async () => {
    const client=createClient('http://127.0.0.1:54321','test-key',{auth:{persistSession:false},global:{fetch:async()=>new Response(
      JSON.stringify({code:'PGRST303',message:'expired'}),{status:401,headers:{'Content-Type':'application/json'}})}});
    vi.spyOn(client.auth,'getSession').mockResolvedValue({data:{session:{user:{id:'first'},access_token:'expired'} as Session},error:null});holder.client=client;
    await expect(createLiveGateway().world()).rejects.toMatchObject({code:'unauthenticated'});
  });
  it('invalidates on account changes but keeps the cache through same-account focus and token refresh', () => {
    const client=createClient('http://127.0.0.1:54321','test-key',{auth:{persistSession:false}});holder.client=client;
    let callback!: Parameters<typeof client.auth.onAuthStateChange>[0];const unsubscribe=vi.fn();
    vi.spyOn(client.auth,'onAuthStateChange').mockImplementation(handler=>{callback=handler;return {data:{subscription:{id:'test',callback:handler,unsubscribe}}};});
    const changed=vi.fn(), remove=createLiveGateway().subscribeSession!(changed);
    const session={user:{id:'first'},access_token:'first'} as Session;
    callback('INITIAL_SESSION',session);callback('SIGNED_IN',session);callback('TOKEN_REFRESHED',{...session,access_token:'refreshed'});
    expect(changed).not.toHaveBeenCalled();
    callback('SIGNED_IN',{...session,user:{id:'second'} as Session['user']});expect(changed).toHaveBeenCalledTimes(1);
    callback('SIGNED_OUT',null);expect(changed).toHaveBeenCalledTimes(2);remove();expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('serves live league standings through the account-guarded Data API read', async () => {
    const paths: string[] = [];
    const client=createClient('http://127.0.0.1:54321','test-key',{auth:{persistSession:false},global:{fetch:async input=>{
      const url=new URL(String(input));paths.push(url.pathname);
      const body=url.searchParams.get('select')==='season_index'?[{season_index:2}]
        :[{gladiator_id:'g1',name:'Aster',rating:1012,human_wins:1,human_losses:0,rank:1,promoted:false}];
      return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
    }}});
    vi.spyOn(client.auth,'getSession').mockResolvedValue({data:{session:{user:{id:'first'},access_token:'first'} as Session},error:null});holder.client=client;
    expect(await createLiveGateway().standings('bronze')).toEqual({league:'bronze',seasonId:'2',archived:false,nextCursor:null,
      rows:[{rank:1,gladiatorId:'g1',name:'Aster',rating:1012,humanWins:1,humanLosses:0,promoted:false,inactive:false,rewardEligible:false}]});
    // The latest-season probe reads the indexed projection table; the ranked page reads the public view.
    expect(paths).toEqual(['/rest/v1/arena_standings','/rest/v1/arena_standing_reads']);
  });
  it('serves the live tournament read through the account-guarded Data API reads', async () => {
    const paths: string[] = [];
    const row = { id: 'tournament:301:gold', slot_index: 301, league: 'gold', starts_at_ms: 1_444_800_000, ends_at_ms: 1_449_600_000,
      status: 'insufficient-entrants', entrants: [{ gladiatorId: 'g9', name: 'Valeria', classId: 'guardian' }], bracket: null, bouts: [], reveal_at_ms: [] };
    const client=createClient('http://127.0.0.1:54321','test-key',{auth:{persistSession:false},global:{fetch:async input=>{
      const url=new URL(String(input));paths.push(url.pathname);
      const table=url.pathname.split('/').at(-1);
      const body=table==='world_revision'?{revision:'1',server_now_ms:1_450_000_000,slot_index:302}:table==='tournament_views'?row:[];
      return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
    }}});
    vi.spyOn(client.auth,'getSession').mockResolvedValue({data:{session:{user:{id:'first'},access_token:'first'} as Session},error:null});holder.client=client;
    expect(await createLiveGateway().tournament('tournament:301:gold')).toEqual({ id: 'tournament:301:gold', league: 'gold', slotIndex: 301,
      startsAtMs: 1_444_800_000, endsAtMs: 1_449_600_000, status: 'insufficient-entrants', bracket: null, entrants: row.entrants, bouts: [], placements: [] });
    expect(paths).toEqual(['/rest/v1/world_revision','/rest/v1/tournament_views','/rest/v1/tournament_bout_results']);
  });
  it('loads a tournament bout’s log on demand once per session: later requests share it, a failure is not kept, a new account reads again', async () => {
    const id = 'tournament:301:gold:1:0', log = { battleId: id, durationMs: 9_000, winnerId: 'g1', participants: [], events: [] };
    let logReads = 0, failNext = true;
    const client=createClient('http://127.0.0.1:54321','test-key',{auth:{persistSession:false},global:{fetch:async input=>{
      const table=new URL(String(input)).pathname.split('/').at(-1);
      if(table==='world_revision') return new Response(JSON.stringify({revision:'1',server_now_ms:1_450_000_000,slot_index:302}),{headers:{'Content-Type':'application/json'}});
      logReads++;
      if(failNext){failNext=false;return new Response(JSON.stringify({code:'XX000',message:'down'}),{status:500,headers:{'Content-Type':'application/json'}});}
      return new Response(JSON.stringify({battleLog:log}),{headers:{'Content-Type':'application/json'}});
    }}});
    vi.spyOn(client.auth,'getSession').mockResolvedValue({data:{session:{user:{id:'first'},access_token:'first'} as Session},error:null});holder.client=client;
    let callback!: Parameters<typeof client.auth.onAuthStateChange>[0];
    vi.spyOn(client.auth,'onAuthStateChange').mockImplementation(handler=>{callback=handler;return {data:{subscription:{id:'test',callback:handler,unsubscribe:vi.fn()}}};});
    const gateway=createLiveGateway();gateway.subscribeSession!(()=>{});
    callback('INITIAL_SESSION',{user:{id:'first'},access_token:'first'} as Session);
    await expect(gateway.tournamentLog(id)).rejects.toMatchObject({code:'unavailable'});
    const [first, second] = await Promise.all([gateway.tournamentLog(id), gateway.tournamentLog(id)]);
    expect(first).toEqual(log);
    expect(second).toBe(first);
    expect(await gateway.tournamentLog(id)).toBe(first);
    expect(logReads).toBe(2);
    // Another account's session starts with an empty cache.
    callback('SIGNED_IN',{user:{id:'second'},access_token:'second'} as Session);
    expect(await gateway.tournamentLog(id)).toEqual(log);
    expect(logReads).toBe(3);
  });
  it('sends the automatic-entry command to the authenticated command endpoint', async () => {
    const client=createClient('http://127.0.0.1:54321','test-key',{auth:{persistSession:false}});holder.client=client;
    vi.spyOn(client.auth,'getSession').mockResolvedValue({data:{session:{user:{id:'first'},access_token:'first',
      expires_at:Math.floor(Date.now()/1000)+3600} as Session},error:null});
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true, receiptId: 'r1', value: { enabled: true, receivedAtMs: 1 } }), { status: 200 });
    });
    try {
      const command = { kind: 'set-tournament-opt-in' as const, operationId: 'd43f7844-52e0-4302-b8e4-740035047765', enabled: true };
      expect(await createLiveGateway().command(command)).toEqual({ ok: true, receiptId: 'r1', value: { enabled: true, receivedAtMs: 1 } });
      expect(sent).toEqual([command]);
    } finally { vi.unstubAllGlobals(); }
  });
});

// Task 13.2: public projections are read without a session; owner reads and commands still need one.
describe('public projection reads without a session', () => {
  const NOW = 1_450_000_000, TID = 'tournament:301:gold', BOUT = `${TID}:1:0`;
  const completion = { activityId: 'act', resolvedKind: 'rest', result: 'completed', success: true, settledAtMs: 1, replayExpiry: { state: 'expired' } };
  const log = { battleId: BOUT, durationMs: 9_000, winnerId: 'g1', participants: [], events: [] };
  const profile = { actor: { gladiatorId: 'g1', name: 'Aster' }, combatStrength: 410, rating: 1012, prestige: [] };
  const ownerSummary = { activityId: 'act', resolvedKind: 'rest', result: 'completed', success: true, receiptId: 'r1', settledAtMs: 1,
    rewards: { money: 5, renown: 0, xp: 1, attributePoints: 0, items: [], overflowMoney: 0 }, replayExpiry: { state: 'expired' } };
  const tournament = { id: TID, slot_index: 301, league: 'gold', starts_at_ms: 1_444_800_000, ends_at_ms: 1_449_600_000,
    status: 'insufficient-entrants', entrants: [{ gladiatorId: 'g9', name: 'Valeria', classId: 'guardian' }], bracket: null, bouts: [], reveal_at_ms: [] };
  const session = (id: string) => ({ user: { id }, access_token: `${id}-token` }) as Session;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  /** What the Data API answers for each public object; `activities` is owner-only, so a visitor's read of it is denied. */
  function answer(table: string, url: URL, signedIn: boolean): Response {
    switch (table) {
      case 'world_revision': return json({ revision: '1', server_now_ms: NOW, slot_index: 302 });
      case 'world_actor_reads': return json([]);
      case 'public_profile_reads': return json({ profile });
      case 'visible_events': return json([{ ordinal: 0, stage: { id: 's1', kind: 'staging', revealedAtMs: 0, startedAtMs: 0, endsAtMs: 1, label: 'Warm-up' } }]);
      case 'recent_results': return json([{ activity_id: 'act', gladiator_id: 'g1', name: 'Aster', summary: completion, reveal_at_ms: 5 }]);
      case 'arena_standings': return json([{ season_index: 2 }]);
      case 'arena_standing_reads': return json([{ gladiator_id: 'g1', name: 'Aster', rating: 1012, human_wins: 1, human_losses: 0, rank: 1, promoted: false }]);
      case 'tournament_views': return json(tournament);
      case 'tournament_bout_results': return json(url.searchParams.get('select')?.startsWith('battleLog:') ? { battleLog: log } : []);
      case 'tournament_placements': return json([]);
      case 'activities': return signedIn ? json({ summary: ownerSummary }) : json({ code: '42501', message: 'permission denied' }, 401);
      default: return json({ code: '42501', message: 'permission denied' }, 401);
    }
  }
  /**
   * A browser client over a fake Data API. `current` is the session getSession reports (null for a visitor), and `onRequest`
   * runs as each request arrives, so a test can change the account while a read is in flight. `tables` records every object asked for.
   */
  function api(current: () => Session | null, onRequest?: (table: string) => void) {
    const tables: string[] = [];
    const client = createClient('http://127.0.0.1:54321', 'test-key', { auth: { persistSession: false }, global: { fetch: async input => {
      const url = new URL(String(input)), table = url.pathname.split('/').at(-1)!;
      tables.push(table); onRequest?.(table);
      return answer(table, url, current() !== null);
    } } });
    const getSession = vi.spyOn(client.auth, 'getSession').mockImplementation(async () => {
      const session = current();
      return session ? { data: { session }, error: null } : { data: { session: null }, error: null };
    });
    holder.client = client;
    return { client, tables, getSession };
  }

  it('reads every public projection without a session', async () => {
    const { tables } = api(() => null);
    const gateway = createLiveGateway();
    expect(await gateway.world()).toEqual({ revision: '1', serverNowMs: NOW, slotIndex: 302, actors: [] });
    expect(await gateway.revision()).toEqual({ revision: '1', serverNowMs: NOW, slotIndex: 302 });
    expect(await gateway.timeline('act')).toMatchObject({ activityId: 'act', completion, stages: [{ id: 's1' }] });
    expect(await gateway.profile('g1')).toEqual(profile);
    expect(await gateway.standings('bronze')).toMatchObject({ league: 'bronze', seasonId: '2', rows: [{ rank: 1, gladiatorId: 'g1', name: 'Aster' }] });
    expect(await gateway.tournament(TID)).toMatchObject({ id: TID, status: 'insufficient-entrants', bouts: [], placements: [] });
    expect(await gateway.tournamentLog(BOUT)).toEqual(log);
    expect(await gateway.recent()).toEqual({ rows: [{ gladiatorId: 'g1', name: 'Aster', summary: completion }], nextCursor: null });
    // Only public objects: never the owner's state or activities.
    expect(tables).not.toContain('owner_state');
    expect(tables).not.toContain('activities');
  });

  it('refuses owner() and commands without a session', async () => {
    const { tables } = api(() => null);
    const sent = vi.fn();
    vi.stubGlobal('fetch', sent);
    try {
      const gateway = createLiveGateway();
      await expect(gateway.owner()).rejects.toMatchObject({ code: 'unauthenticated' });
      expect(await gateway.command({ kind: 'set-tournament-opt-in', operationId: 'd43f7844-52e0-4302-b8e4-740035047765', enabled: true }))
        .toEqual({ ok: false, code: 'unauthenticated' });
      expect(tables).toEqual([]);
      expect(sent).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('a visitor timeline never queries activities and has no summary', async () => {
    const { tables } = api(() => null);
    const timeline = await createLiveGateway().timeline('act');
    expect(tables).toEqual(['world_revision', 'visible_events', 'recent_results']);
    expect(timeline.completion).toEqual(completion);
    expect(timeline.summary).toBeUndefined();
  });

  it('a signed-in reader still gets the owner summary with the timeline', async () => {
    const { tables } = api(() => session('first'));
    const timeline = await createLiveGateway().timeline('act');
    expect(tables).toEqual(['world_revision', 'visible_events', 'recent_results', 'activities']);
    expect(timeline.summary).toEqual(ownerSummary);
  });

  it('retries a public read once when the account changes during it', async () => {
    let account: Session | null = null, changes = 0;
    const { tables } = api(() => account, table => { if (table === 'world_revision' && changes++ === 0) account = session('first'); });
    expect(await createLiveGateway().revision()).toEqual({ revision: '1', serverNowMs: NOW, slotIndex: 302 });
    expect(tables).toEqual(['world_revision', 'world_revision']);
  });

  it('throws unavailable when the account changes again during the retry', async () => {
    let account: Session | null = null, changes = 0;
    const { tables } = api(() => account, () => { account = session(`account-${++changes}`); });
    await expect(createLiveGateway().revision()).rejects.toMatchObject({ code: 'unavailable' });
    expect(tables).toEqual(['world_revision', 'world_revision']);
  });

  it('decides the owner summary again on the retry when a visitor signs in during a timeline read', async () => {
    let account: Session | null = null, changes = 0;
    const { tables } = api(() => account, table => { if (table === 'world_revision' && changes++ === 0) account = session('first'); });
    const timeline = await createLiveGateway().timeline('act');
    // The visitor attempt is discarded without asking for the owner summary; the retry runs as the new account and does.
    expect(tables).toEqual(['world_revision', 'visible_events', 'recent_results', 'world_revision', 'visible_events', 'recent_results', 'activities']);
    expect(timeline.summary).toEqual(ownerSummary);
  });

  it('serves a cached tournament log to a later viewer without a session check, and forgets it when the account changes', async () => {
    const { client, tables, getSession } = api(() => null);
    let callback!: Parameters<typeof client.auth.onAuthStateChange>[0];
    vi.spyOn(client.auth, 'onAuthStateChange').mockImplementation(handler => { callback = handler; return { data: { subscription: { id: 'test', callback: handler, unsubscribe: vi.fn() } } }; });
    const gateway = createLiveGateway();
    gateway.subscribeSession!(() => {});
    callback('INITIAL_SESSION', null);
    const first = await gateway.tournamentLog(BOUT);
    expect(tables).toEqual(['world_revision', 'tournament_bout_results']);
    getSession.mockClear();
    expect(await gateway.tournamentLog(BOUT)).toBe(first);
    expect(getSession).not.toHaveBeenCalled();
    expect(tables).toHaveLength(2);
    // An account change clears the cache: the next viewer reads again.
    callback('SIGNED_IN', session('first'));
    expect(await gateway.tournamentLog(BOUT)).toEqual(log);
    expect(tables).toHaveLength(4);
  });
});
