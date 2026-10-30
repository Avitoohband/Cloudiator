import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { sql, admin, account, anonymous, resetIdentity, creation } from '../fixtures/db.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { readOwner, readProfile } from '../../src/lib/api/reads.ts';

// Task 11c (Patch A spec, "A richer profile card", Server; source supabase/sql/20-profile-card.sql, in M26): the public profile carries
// the gladiator's CURRENT build (stance, points and each worn item's public fields), its creation time and its Arena record over every
// season and league. A queued build stays private until it takes effect, and nothing that is the owner's own appears.
const commands = createDatabase(admin);
beforeEach(async () => { await resetIdentity(); await sql`update private.scheduler set enabled=false where singleton`; });
afterAll(() => sql.end());

async function fighter() {
  const owner = await account(), other = await account();
  const created = await commands.createGladiator({ userId: owner.id }, creation('Card ' + randomUUID().slice(0, 8)));
  if (!created.ok) throw Error('creation failed');
  return { owner, other, gid: created.value.gladiatorId };
}
/** The projection tests' forbidden keys, and the item fields that stay the owner's. */
const FORBIDDEN = ['owner_id', 'ownerId', 'wallets', 'inventory', 'seed', 'email', 'schedule', 'ownedCosmetics', 'rewards', 'receiptId', 'pendingBuild',
  'origin', 'binding', 'reservation'];
const SLOTS = ['weapon', 'offHand', 'head', 'body', 'feet'] as const;
/** The keys a worn item may show on the card: the fields a market listing shows, and nothing else. */
const ITEM_KEYS = ['catalogId', 'catalogVersion', 'rarity', 'stats', 'tier'];
/**
 * What in a raw profile row (as the Data API serves it, before the client's read rebuilds anything) is the owner's own: a forbidden key,
 * an item's id or owner key, an item id's value, or a worn slot with keys beyond the five public ones. Empty when nothing leaks.
 */
function leaks(profile: unknown, itemIds: readonly string[]): string[] {
  const found: string[] = [];
  const json = JSON.stringify(profile);
  for (const key of [...FORBIDDEN, 'id', 'owner']) if (json.includes(`"${key}":`)) found.push(`key ${key}`);
  for (const id of itemIds) if (json.includes(id)) found.push(`item id ${id}`);
  const equipment = (profile as { build?: { equipment?: Record<string, unknown> } }).build?.equipment ?? {};
  for (const [slot, item] of Object.entries(equipment)) {
    if (item !== null && JSON.stringify(Object.keys(item as object).sort()) !== JSON.stringify(ITEM_KEYS)) found.push(`slot ${slot} keys ${Object.keys(item as object)}`);
  }
  return found;
}

describe('the public profile card', () => {
  it('publishes the current build, its worn items\' public fields and the creation time', async () => {
    const f = await fighter();
    const visitor = await readProfile(anonymous, f.gid), player = await readProfile(f.other.client, f.gid);
    expect(visitor).toEqual(player);
    const owner = await readOwner(f.owner.client);
    expect(visitor.build).not.toBeNull();
    expect(visitor.build!.stance).toBe(owner.currentBuild.stance);
    expect(visitor.build!.allocations).toEqual(owner.currentBuild.allocations);
    for (const slot of SLOTS) {
      const id = owner.currentBuild.equipment[slot];
      const item = id === null ? null : owner.inventory.find(i => i.id === id)!;
      expect(visitor.build!.equipment[slot], slot).toEqual(item && { catalogId: item.catalogId, catalogVersion: item.catalogVersion, tier: item.tier,
        rarity: item.rarity, stats: item.stats });
    }
    // The starter sword and light armor are worn.
    expect(visitor.build!.equipment.weapon?.catalogId).toMatch(/^sword:/);
    expect(visitor.build!.equipment.body?.catalogId).toMatch(/^light-armor:/);
    const [{ created }] = await sql`select created_at_ms::bigint as created from public.gladiators where id=${f.gid}`;
    expect(visitor.joinedAtMs).toBe(Number(created));
    expect(visitor.arenaRecord).toEqual({ wins: 0, losses: 0 });
    // Nothing that is the owner's own, checked on the RAW row the Data API serves a visitor (fix round: the read rebuilds each item from
    // its five fields, so a check on its result could not see a leak inside an item).
    const raw = await anonymous.from('public_profile_reads').select('profile').eq('gladiator_id', f.gid).single();
    expect(raw.error).toBeNull();
    const ids = owner.inventory.map(item => item.id);
    expect(leaks(raw.data!.profile, ids)).toEqual([]);
    for (const slot of SLOTS) {
      const item = (raw.data!.profile as { build: { equipment: Record<string, object | null> } }).build.equipment[slot];
      if (item !== null) expect(Object.keys(item).sort(), slot).toEqual(ITEM_KEYS);
    }
  });

  it('would see a leak inside an item: the check is not vacuous', async () => {
    const f = await fighter();
    const owner = await readOwner(f.owner.client);
    const ids = owner.inventory.map(item => item.id);
    // In a transaction that rolls back, the stored build's weapon gains the item's id, origin and owner: the raw row read as a visitor shows them.
    const seen = await sql.begin(async tx => {
      await tx`update public.public_profiles set build=jsonb_set(build,'{equipment,weapon}',(build->'equipment'->'weapon')
        ||jsonb_build_object('id',${ids[0]}::text,'origin','starter','ownerId',${f.owner.id}::text)) where gladiator_id=${f.gid}`;
      await tx.unsafe('set local role anon');
      const [{ profile }] = await tx`select profile from public.public_profile_reads where gladiator_id=${f.gid}`;
      throw Object.assign(new Error('rollback'), { profile });
    }).catch(error => (error as { profile?: unknown }).profile);
    expect(leaks(seen, ids)).toEqual(expect.arrayContaining(['key ownerId', 'key origin', 'key id', `item id ${ids[0]}`]));
    expect(leaks(seen, ids).some(found => found.startsWith('slot weapon keys'))).toBe(true);
    // Rolled back: the served row is clean again.
    const raw = await anonymous.from('public_profile_reads').select('profile').eq('gladiator_id', f.gid).single();
    expect(leaks(raw.data!.profile, ids)).toEqual([]);
  });

  it('backfills an existing profile with refresh_projections, and a second call changes nothing', async () => {
    const f = await fighter();
    const [{ created }] = await sql`select created_at_ms::bigint as created from public.gladiators where id=${f.gid}`;
    const result = await sql.begin(async tx => {
      // A profile as M25 left it: no build and no creation time.
      await tx`update public.public_profiles set build=null, joined_at_ms=null where gladiator_id=${f.gid}`;
      await tx`select public.refresh_projections()`;
      const [filled] = await tx`select build, joined_at_ms::bigint as joined, ctid::text as version from public.public_profiles where gladiator_id=${f.gid}`;
      await tx`select public.refresh_projections()`;
      const [again] = await tx`select ctid::text as version from public.public_profiles where gladiator_id=${f.gid}`;
      throw Object.assign(new Error('rollback'), { filled, again });
    }).catch(error => error as { filled: { build: { stance: string } | null; joined: string; version: string }; again: { version: string } });
    expect(result.filled.build?.stance).toEqual(expect.any(String));
    expect(Number(result.filled.joined)).toBe(Number(created));
    // The is-distinct check: an unchanged profile is not written again (its tuple stays where it is).
    expect(result.again.version).toBe(result.filled.version);
  });

  it('keeps a queued build private until it takes effect', async () => {
    const f = await fighter();
    const before = (await readProfile(anonymous, f.gid)).build!;
    expect(before.stance).not.toBe('offensive');
    const [{ current }] = await sql`select current_build as current from public.builds where gladiator_id=${f.gid}`;
    await sql`update public.builds set pending_build=${sql.json({ ...current, stance: 'offensive' })} where gladiator_id=${f.gid}`;
    expect((await readProfile(anonymous, f.gid)).build).toEqual(before);
    await sql`update public.builds set current_build=jsonb_set(current_build,'{stance}','"offensive"'), pending_build=null where gladiator_id=${f.gid}`;
    expect((await readProfile(anonymous, f.gid)).build!.stance).toBe('offensive');
  });

  it('sums the Arena record over every league and season', async () => {
    const f = await fighter();
    await sql`insert into public.arena_standings(gladiator_id,league,season_index,name,rating,human_wins,human_losses)
      values(${f.gid},'bronze',0,'Card',1000,3,1),(${f.gid},'silver',1,'Card',1000,2,2)`;
    expect((await readProfile(anonymous, f.gid)).arenaRecord).toEqual({ wins: 5, losses: 3 });
  });

  it('orders its source: the columns, then the projector, then the view, then the backfill (M24 lesson)', () => {
    const source = readFileSync(new URL('../../supabase/sql/20-profile-card.sql', import.meta.url), 'utf8');
    const at = (needle: string) => { const i = source.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
    const order = [at('alter table public.public_profiles add column if not exists build jsonb;'),
      at('alter table public.public_profiles add column if not exists joined_at_ms bigint;'),
      at('create or replace function private.project_character(gid uuid) returns void'),
      at('create or replace view public.public_profile_reads with(security_invoker=true) as'), at('select public.refresh_projections();')];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The projector is 17-appearance.sql's, changed only in its public_profiles upsert and the one variable it needs.
    const body = (text: string) => { const open = text.indexOf('as $$', text.indexOf('create or replace function private.project_character(')) + 5; return text.slice(open, text.indexOf('$$', open)); };
    const appearance = readFileSync(new URL('../../supabase/sql/17-appearance.sql', import.meta.url), 'utf8');
    const lines = (text: string) => body(text).split('\n');
    const removed = lines(appearance).filter(line => !lines(source).includes(line)), added = lines(source).filter(line => !lines(appearance).includes(line));
    expect(removed.join('\n')).toMatch(/resting boolean;[\s\S]*insert into public\.public_profiles\(gladiator_id,rating,prestige\)/);
    expect(removed.every(line => /resting boolean;|public_profiles|set rating=excluded\.rating,prestige=excluded\.prestige/.test(line)), removed.join('\n')).toBe(true);
    expect(added.join('\n')).toContain("card:=jsonb_build_object('stance',b->'stance','allocations',b->'allocations','equipment',");
  });

  // M26 carries the card with 19-patches.sql (Task 11b Step 5): one migration for Patch 1.4.
  it('ships the profile card in M26: project_character as its source, the invoker view kept with its grants, the backfill', () => {
    const dir = new URL('../../supabase/migrations/', import.meta.url);
    const [name] = readdirSync(dir).filter(file => file.endsWith('_patch_1_4.sql'));
    const m26 = readFileSync(new URL(name, dir), 'utf8').replace(/\r\n/g, '\n');
    const source = readFileSync(new URL('../../supabase/sql/20-profile-card.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const at = (needle: string, from = 0) => { const i = m26.indexOf(needle, from); expect(i, needle).toBeGreaterThan(-1); return i; };
    expect(m26).toMatch(/alter table "public"\."public_profiles" add column "build" jsonb;|alter table public\.public_profiles add column if not exists build jsonb;/);
    expect(m26).toMatch(/alter table "public"\."public_profiles" add column "joined_at_ms" bigint;|alter table public\.public_profiles add column if not exists joined_at_ms bigint;/);
    const open = source.indexOf('as $$', source.indexOf('create or replace function private.project_character(')) + 'as $$'.length;
    const sourceBody = source.slice(open, source.indexOf('$$', open));
    const start = at('CREATE OR REPLACE FUNCTION private.project_character(');
    expect(m26.indexOf('CREATE OR REPLACE FUNCTION private.project_character(', start + 1)).toBe(-1);
    const bodyOpen = at('AS $function$', start) + 'AS $function$'.length;
    expect(m26.slice(bodyOpen, m26.indexOf('$function$', bodyOpen))).toBe(sourceBody);
    for (const acl of source.match(/^(?:revoke all on function|grant execute on function) private\.project_character[^;]*;/gm)!) expect(m26, acl).toContain(acl);
    const head = 'create or replace view public.public_profile_reads with(security_invoker=true) as';
    const view = source.slice(source.indexOf(head), source.indexOf(';', source.indexOf(head)) + 1);
    const viewAt = at(view);
    expect(m26.match(/^create or replace view public\.public_profile_reads/gim)).toHaveLength(1);
    expect(m26).not.toMatch(/drop view[^;]*public_profile_reads/i);
    const revoke = at('revoke all on public.public_profile_reads from public,anon,authenticated,service_role;', viewAt);
    const grant = at('grant select on public.public_profile_reads to anon,authenticated,service_role;', revoke);
    const backfill = at('select public.refresh_projections();', grant);
    expect(backfill).toBeLessThan(m26.lastIndexOf('notify pgrst'));
    // The backfill runs the NEW projector: it comes after project_character's restatement (fix round).
    expect(backfill).toBeGreaterThan(start);
  });
});
