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
    // Nothing that is the owner's own: no forbidden key, and no item id.
    const json = JSON.stringify(visitor);
    for (const key of FORBIDDEN) expect(json, key).not.toContain(`"${key}"`);
    for (const item of owner.inventory) expect(json).not.toContain(item.id);
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
  });
});
