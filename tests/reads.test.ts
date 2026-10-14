import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { readRecent, readTimeline, readWorld } from '../src/lib/api/reads';

function transport(rows: Record<string, unknown>, calls: string[]) {
  return createClient('http://127.0.0.1:54321', 'test-key', { auth: { persistSession: false }, global: { fetch: async (input) => {
    const url = new URL(String(input)); calls.push(url.pathname + url.search);
    const body = rows[url.pathname.split('/').at(-1)!];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } } });
}
describe('protected Data API adapters', () => {
  it('loads safe world pages with a stable revision and no eager owner/log/profile query', async () => {
    const calls: string[] = [], revision = { revision: '7:20', server_now_ms: 99_000_000, slot_index: 20 };
    const client = transport({ world_revision: revision, world_actor_reads: [{ gladiator_id: 'g', actor: { gladiatorId: 'g' } }] }, calls);
    expect(await readWorld(client)).toMatchObject({ revision: '7:20', serverNowMs: 99_000_000, actors: [{ gladiatorId: 'g' }] });
    expect(calls.filter(c => c.includes('world_actor_reads'))).toHaveLength(1);
    expect(calls.every(c => /world_revision|world_actor_reads/.test(c))).toBe(true);
    expect(calls.find(c => c.includes('world_actor_reads'))).toContain('limit=50');
  });
  it('keeps spectator completion separate from an absent RLS owner summary', async () => {
    const calls: string[] = [], summary = { activityId: 'a', resolvedKind: 'rest', result: 'completed', success: true, settledAtMs: 10, replayExpiry: { state: 'expired' } };
    const client = transport({ world_revision: { revision: '1', server_now_ms: 20, slot_index: 0 }, visible_events: [], recent_results: { summary }, activities: null }, calls);
    expect(await readTimeline(client, 'a')).toEqual({ activityId: 'a', serverNowMs: 20, visibleThroughMs: 20, stages: [], completion: summary });
    expect(calls.find(c => c.includes('visible_events'))).toContain('limit=50');
  });
  it('rejects malformed cursors before issuing a query and bounds recent pages', async () => {
    const calls: string[] = [], client = transport({ recent_results: [] }, calls);
    await expect(readRecent(client, 'bad,filter')).rejects.toMatchObject({ code: 'unavailable' }); expect(calls).toHaveLength(0);
    expect(await readRecent(client)).toEqual({ rows: [], nextCursor: null }); expect(calls[0]).toContain('limit=50');
  });
});
