import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql, admin, account, anonymous, resetIdentity, creation, request } from '../fixtures/db.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { makeVerifier } from '../../supabase/functions/_shared/backend/auth.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';

const database = createDatabase(admin);
beforeEach(async () => {
  await resetIdentity();
  await sql`update private.scheduler set enabled=false where singleton`;
  // Do not normalize or manufacture retained rows: the seed test must observe the deployed source unchanged.
});
afterEach(async () => {
  await sql`update private.rules_versions set active=false where version<>'v1'`;
  await sql`update private.rules_versions set active=true where version='v1'`;
});
afterAll(() => sql.end());

async function revision() {
  const result = await anonymous.from('world_revision').select('*').single();
  expect(result.error).toBeNull();
  return result.data!;
}
async function fighter() {
  const owner = await account();
  const created = await database.createGladiator({ userId: owner.id }, creation('Economy ' + randomUUID().slice(0, 8)));
  if (!created.ok) throw Error('creation failed');
  return { ...owner, gid: created.value.gladiatorId };
}
async function profile(gid: string) {
  const result = await anonymous.from('public_profile_reads').select('profile').eq('gladiator_id', gid).single();
  expect(result.error).toBeNull();
  return result.data!.profile;
}
/** SQL21 owns its BEGIN/COMMIT, so its whole-file replay must retain one explicitly reserved connection. */
async function reapply(source: string) {
  const connection = await sql.reserve();
  try {
    await connection.unsafe(source);
  } catch (error) {
    await connection`rollback`;
    throw error;
  } finally {
    connection.release();
  }
}

describe('rules versions', () => {
  it('seeds v2 inactive beside the active v1', async () => {
    expect(await sql`select version,active from private.rules_versions order by version`)
      .toEqual([{ version: 'v1', active: true }, { version: 'v2', active: false }]);
  });

  it('publishes the active version only at commit, retaining every revision field', async () => {
    const before = await revision();
    expect(before.rules_version).toBe('v1');
    expect(Object.keys(before).sort()).toEqual(['latest_patch', 'published_slot_index', 'revision', 'rules_version', 'server_now_ms', 'slot_index']);
    await sql.begin(async tx => {
      await tx`update private.rules_versions set active=false where version='v1'`;
      expect(await tx`update private.rules_versions set active=true where version='v2' returning version`).toHaveLength(1);
      expect(await tx`select rules_version from public.world_revision_state`).toEqual([{ rules_version: 'v1' }]);
      expect((await revision()).rules_version).toBe('v1');
    });
    const after = await revision();
    expect(after.rules_version).toBe('v2');
    expect(after.latest_patch).toEqual(before.latest_patch);
    expect(after.published_slot_index).toEqual(before.published_slot_index);
    expect(after.revision).toEqual(expect.any(String));
    expect(after.server_now_ms).toBeGreaterThanOrEqual(before.server_now_ms);
  });

  it('does not publish a rolled-back activation', async () => {
    const rollback = new Error('rollback');
    await expect(sql.begin(async tx => {
      await tx`update private.rules_versions set active=false where version='v1'`;
      expect(await tx`update private.rules_versions set active=true where version='v2' returning version`).toHaveLength(1);
      expect(await tx`select rules_version from public.world_revision_state`).toEqual([{ rules_version: 'v1' }]);
      throw rollback;
    })).rejects.toBe(rollback);
    expect((await revision()).rules_version).toBe('v1');
    expect(await sql`select version from private.rules_versions where active`).toEqual([{ version: 'v1' }]);
  });
});

describe('the Arena banner', () => {
  it('shows a real bought banner, preserves the rich profile, and publishes the revision', async () => {
    const owner = await fighter(), other = await fighter();
    await sql`update public.wallets set renown=50 where gladiator_id=${owner.gid}`;
    const beforeProfile = await profile(owner.gid), beforeRevision = await revision();
    expect(beforeProfile.banner).toBe(false);
    const response = await handleCommand(request(owner.token, { kind: 'buy-shop', operationId: randomUUID(),
      catalogId: 'banner', catalogVersion: 'v1', quantity: 1 }),
    { database, verifyActor: makeVerifier(anonymous), allowedOrigins: ['http://127.0.0.1:3000'] });
    expect(await response.json()).toMatchObject({ ok: true, value: { cosmeticId: 'banner', renownDebit: 50 } });
    expect(await sql`select renown::int from public.wallets where gladiator_id=${owner.gid}`).toEqual([{ renown: 0 }]);
    expect(await profile(owner.gid)).toEqual({ ...beforeProfile, banner: true });
    expect((await profile(other.gid)).banner).toBe(false);
    expect(Number((await revision()).revision.split(':')[0])).toBeGreaterThan(Number(beforeRevision.revision.split(':')[0]));
    // Existing projection upserts must retain ownership without re-purchasing.
    await sql`update public.gladiators set rating=1012 where id=${owner.gid}`;
    await sql`select private.project_character(${owner.gid})`;
    expect(await profile(owner.gid)).toMatchObject({ banner: true, rating: 1012,
      build: beforeProfile.build, joinedAtMs: beforeProfile.joinedAtMs, arenaRecord: beforeProfile.arenaRecord });
  });

  it('backfills existing banner ownership and reapplies without activating v2 or changing balances', async () => {
    const owner = await fighter(), other = await fighter();
    // Model ownership that predates this trigger; do not fake the implementation of the backfill.
    expect((await profile(owner.gid)).banner).toBe(false);
    await sql.begin(async tx => {
      await tx`alter table public.owned_cosmetics disable trigger publish_banner`;
      await tx`insert into public.owned_cosmetics(gladiator_id,catalog_id,catalog_version,binding)
        values(${owner.gid},'banner','v1','bound')`;
      await tx`alter table public.owned_cosmetics enable trigger publish_banner`;
    });
    expect((await profile(owner.gid)).banner).toBe(false);
    const balances = await sql`select gladiator_id,money::text,renown::text from public.wallets order by gladiator_id`;
    const source = readFileSync(new URL('../../supabase/sql/21-economy.sql', import.meta.url), 'utf8');
    await reapply(source);
    expect((await profile(owner.gid)).banner).toBe(true);
    expect((await profile(other.gid)).banner).toBe(false);
    const filled = await profile(owner.gid);
    await reapply(source);
    expect(await profile(owner.gid)).toEqual(filled);
    expect(await sql`select gladiator_id,money::text,renown::text from public.wallets order by gladiator_id`).toEqual(balances);
    expect(await sql`select version,active from private.rules_versions order by version`)
      .toEqual([{ version: 'v1', active: true }, { version: 'v2', active: false }]);
    // Reapplying is equally inert when the operator has already selected v2.
    await sql.begin(async tx => {
      await tx`update private.rules_versions set active=false where version='v1'`;
      await tx`update private.rules_versions set active=true where version='v2'`;
    });
    await reapply(source);
    expect(await sql`select version from private.rules_versions where active`).toEqual([{ version: 'v2' }]);
    expect((await revision()).rules_version).toBe('v2');
    expect(await sql`select gladiator_id,money::text,renown::text from public.wallets order by gladiator_id`).toEqual(balances);
  });
});
