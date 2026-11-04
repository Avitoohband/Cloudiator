import { afterEach, expect, test, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CATALOG_V1 } from '@domain/catalog-v1';
const holder = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock('../../src/lib/api/client', () => ({ getBrowserClient: () => holder.client }));
import { createLiveGateway } from '../../src/lib/api/gateway';
import { readProfile } from '../../src/lib/api/reads';
import { worldFixture } from '../fixtures/domain';
afterEach(() => { holder.client = null; vi.restoreAllMocks(); });

// Task 11c (Patch A spec, "A richer profile card", Client): the one profile read now carries the current build, the creation time
// and the Arena record over all seasons. Each is checked, and a malformed one is null (a malformed slot makes the whole build null).
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function api(row: unknown) {
  const requests: URLSearchParams[] = [];
  const client = createClient('http://127.0.0.1:54321', 'test-key', { auth: { persistSession: false }, global: { fetch: async input => {
    requests.push(new URL(String(input)).searchParams);
    return json(row);
  } } });
  vi.spyOn(client.auth, 'getSession').mockResolvedValue({ data: { session: null }, error: null });
  holder.client = client;
  return { client, requests };
}
const gear = (id: string) => {
  const item = CATALOG_V1.items[id];
  return { catalogId: id, catalogVersion: 'v1', tier: item.tier, rarity: item.rarity, stats: structuredClone(item.stats) };
};
const ACTOR = worldFixture.actors[0];
const BUILD = { stance: 'defensive', allocations: { strength: 5, agility: 1, vitality: 9, endurance: 4, precision: 3 },
  equipment: { weapon: gear('spear:5:uncommon'), offHand: null, head: gear('iron-helmet:5:common'), body: gear('heavy-armor:1:rare'), feet: null } };
const profile = (over: Record<string, unknown> = {}) => ({ profile: { actor: ACTOR, combatStrength: null, rating: 1040, prestige: [],
  build: BUILD, joinedAtMs: 1_791_000_000_000, arenaRecord: { wins: 9, losses: 5 }, ...over } });

test('maps the build, the creation time and the Arena record', async () => {
  const { client, requests } = api(profile());
  expect(await readProfile(client, ACTOR.gladiatorId)).toEqual({ actor: ACTOR, combatStrength: null, rating: 1040, prestige: [], build: BUILD,
    joinedAtMs: 1_791_000_000_000, arenaRecord: { wins: 9, losses: 5 }, banner: false });
  expect(requests[0].get('select')).toBe('profile');
  // The live gateway's profile is the same read, for a visitor.
  expect((await createLiveGateway().profile(ACTOR.gladiatorId)).build).toEqual(BUILD);
});

test('reads a malformed build as null, whatever part of it is wrong', async () => {
  const cases: [string, unknown][] = [
    ['an unknown stance', { ...BUILD, stance: 'reckless' }],
    ['a fractional point', { ...BUILD, allocations: { ...BUILD.allocations, strength: 1.5 } }],
    ['a negative point', { ...BUILD, allocations: { ...BUILD.allocations, agility: -1 } }],
    ['a missing slot', { ...BUILD, equipment: { weapon: null, offHand: null, head: null, body: null } }],
    ['a slot that is not an item', { ...BUILD, equipment: { ...BUILD.equipment, feet: 'x' } }],
    ['an item with a bad rarity', { ...BUILD, equipment: { ...BUILD.equipment, head: { ...gear('iron-helmet:5:common'), rarity: 'epic' } } }],
    ['an item without stats', { ...BUILD, equipment: { ...BUILD.equipment, head: { ...gear('iron-helmet:5:common'), stats: null } } }],
    ['not an object', 'build'],
  ];
  for (const [label, build] of cases) expect((await readProfile(api(profile({ build })).client, ACTOR.gladiatorId)).build, label).toBeNull();
  expect((await readProfile(api(profile({ arenaRecord: { wins: '3' } })).client, ACTOR.gladiatorId)).arenaRecord).toBeNull();
  expect((await readProfile(api(profile({ joinedAtMs: 'soon' })).client, ACTOR.gladiatorId)).joinedAtMs).toBeNull();
});

test('reads a profile from before M26 (without the three keys) with all three null', async () => {
  const { build: _b, joinedAtMs: _j, arenaRecord: _a, ...older } = profile().profile;
  expect(await readProfile(api({ profile: older }).client, ACTOR.gladiatorId)).toEqual({ actor: ACTOR, combatStrength: null, rating: 1040, prestige: [],
    build: null, joinedAtMs: null, arenaRecord: null, banner: false });
});

// Patch 1.6 (spec "The Arena banner", M27): the profile read publishes whether the gladiator owns the Arena banner. Only `true` is a banner; a
// missing key (a database before M27) or any other value is none.
test('reads the Arena banner: true only for true', async () => {
  expect((await readProfile(api(profile({ banner: true })).client, ACTOR.gladiatorId)).banner).toBe(true);
  for (const banner of [false, 'yes', 1, null, 'true']) {
    expect((await readProfile(api(profile({ banner })).client, ACTOR.gladiatorId)).banner, String(banner)).toBe(false);
  }
  expect((await readProfile(api(profile()).client, ACTOR.gladiatorId)).banner).toBe(false);
  expect((await createLiveGateway().profile(ACTOR.gladiatorId)).banner).toBe(false);
  api(profile({ banner: true }));
  expect((await createLiveGateway().profile(ACTOR.gladiatorId)).banner).toBe(true);
});
