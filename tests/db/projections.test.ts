import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, admin, account, anonymous, resetIdentity, creation } from '../fixtures/db.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { readOwner, readWorld, readTimeline, readProfile, readRecent, readRevision } from '../../src/lib/api/reads.ts';
import { refreshProjections } from '../../supabase/functions/_shared/backend/projections.ts';

const commands = createDatabase(admin);
beforeEach(async () => { await resetIdentity(); await sql`update private.scheduler set enabled=false where singleton`; });
afterAll(() => sql.end());
async function fighter() {
  const owner = await account(), other = await account();
  const created = await commands.createGladiator({ userId: owner.id }, creation('Proj ' + randomUUID().slice(0,8)));
  if (!created.ok) throw Error('creation failed');
  return { owner, other, gid: created.value.gladiatorId };
}
async function activity(gid: string, status = 'active') {
  const id = randomUUID(), slot = Math.floor(Date.now()/4_800_000)-1;
  await sql`insert into public.activities(id,gladiator_id,slot_index,starts_at_ms,ends_at_ms,requested,resolved_kind,status,published_at_ms)
    values(${id},${gid},${slot},${slot*4_800_000},${(slot+1)*4_800_000},'{"kind":"rest"}','rest',${status},${slot*4_800_000})`;
  return id;
}
const forbidden = ['owner_id','ownerId','wallets','inventory','seed','email','schedule','ownedCosmetics','rewards','receiptId','pendingBuild'];
function safe(value: unknown) { const json = JSON.stringify(value); for (const key of forbidden) expect(json).not.toContain(`"${key}"`); }
describe('safe projection authorization', () => {
  it('publishes explicit equipped silhouettes to authenticated spectators, retaining private owner management', async () => {
    const f = await fighter();
    const world = await readWorld(f.other.client);
    expect(world.actors).toHaveLength(1);
    expect(world.actors[0]).toMatchObject({ gladiatorId: f.gid, equipmentSilhouettes: ['armor-light','weapon-sword'], location: 'orientation' });
    safe(world); safe(await readProfile(f.other.client, f.gid));
    expect((await readOwner(f.owner.client)).wallets.money).toBe(100);
    await expect(readOwner(f.other.client)).rejects.toMatchObject({code:'not-found'});
    for (const name of ['world_actors','world_revision','public_profiles','visible_events','recent_results','world_actor_reads']) {
      expect((await anonymous.from(name).select('*')).error).not.toBeNull();
      expect((await f.other.client.from(name).delete().neq('gladiator_id',randomUUID())).error).not.toBeNull();
    }
    expect((await f.other.client.rpc('refresh_projections')).error).not.toBeNull();
    const revisionBeforeRepair=await readRevision(f.other.client);
    await refreshProjections(admin);
    expect((await readRevision(f.other.client)).revision).toBe(revisionBeforeRepair.revision);
    const grants = await sql`select has_table_privilege('authenticated','public.world_actors','INSERT,UPDATE,DELETE') as mutation,
      has_function_privilege('authenticated','public.refresh_projections()','EXECUTE') as refresh,
      has_schema_privilege('authenticated','private','USAGE') as private`;
    expect(grants[0]).toEqual({mutation:false,refresh:false,private:false});
    const initial = await readOwner(f.owner.client), item = structuredClone(initial.inventory[0]);
    item.id=randomUUID();item.catalogId='axe:1:common';item.reservation=null;
    await sql`insert into public.item_instances(id,gladiator_id,item) values(${item.id},${f.gid},${sql.json(item)})`;
    expect((await readWorld(f.other.client)).actors[0].equipmentSilhouettes).toEqual(['armor-light','weapon-sword']);
  });
  it('applies the deployed reveal RLS predicate at -1ms, equality, and +1ms under owner and spectator roles', async () => {
    const f=await fighter(), id=await activity(f.gid), event=randomUUID();
    await sql`insert into public.activity_stages(id,activity_id,ordinal,reveal_at_ms,stage)
      values(${event},${id},0,1000,'{"id":"boundary","kind":"travel"}')`;
    // Local operator clock seam only: retain the deployed predicate verbatim except its clock call.
    // Transaction rollback restores the real-clock policy; no player endpoint or production test clock exists.
    const [policy]=await sql`select pg_get_expr(polqual,polrelid) as expression from pg_policy where polrelid='public.activity_stages'::regclass and polname='due_read'`;
    for(const owner of [f.owner,f.other])for(const [clock,count] of [[999,0],[1000,1],[1001,1]]) {
      await expect(sql.begin(async tx=>{
        const expression=policy.expression.replaceAll('clock_timestamp()',`to_timestamp(${clock}/1000.0)`);
        if(expression===policy.expression)throw Error('clock seam missing');
        await tx.unsafe(`alter policy due_read on public.activity_stages using (${expression})`);
        await tx`select set_config('request.jwt.claim.sub',${owner.id},true)`;
        await tx`set local role authenticated`;
        const [row]=await tx`select count(*)::int as count from public.visible_events where id=${event}`;
        expect(row.count).toBe(count);
        throw Error('rollback-test-clock');
      })).rejects.toThrow('rollback-test-clock');
    }
    const [restored]=await sql`select pg_get_expr(polqual,polrelid) as expression from pg_policy where polrelid='public.activity_stages'::regclass and polname='due_read'`;
    expect(restored.expression).toBe(policy.expression);
  });
  it('pages recent results in descending settlement order without dropping equal-time rows', async () => {
    const f=await fighter();
    for(let slot=1;slot<=52;slot++) {
      const id=randomUUID(), settled=slot<=51?1000:2000;
      const summary={activityId:id,resolvedKind:'training',result:'completed',success:true,settledAtMs:settled,replayExpiry:{state:'expired'},rewards:{money:999,items:[]},receiptId:randomUUID()};
      await sql`insert into public.activities(id,gladiator_id,slot_index,starts_at_ms,ends_at_ms,requested,resolved_kind,status,published_at_ms,summary,settled_at_ms)
        values(${id},${f.gid},${slot},${slot*4_800_000},${(slot+1)*4_800_000},'{"kind":"training"}','training','completed',0,${sql.json(summary)},${settled})`;
    }
    const first=await readRecent(f.other.client);expect(first.rows).toHaveLength(50);
    expect(first.rows[0].summary.settledAtMs).toBe(2000);expect(first.nextCursor).not.toBeNull();
    const second=await readRecent(f.other.client,first.nextCursor!);expect(second.rows).toHaveLength(2);
    expect(new Set([...first.rows,...second.rows].map(r=>r.summary.activityId)).size).toBe(52);safe(first);safe(second);
  });
  it('keeps guessed future events hidden from owner and spectator and bumps revision when due events are written', async () => {
    const f = await fighter(), id = await activity(f.gid), event = randomUUID();
    const before = await readRevision(f.other.client), future = Date.now()+60_000;
    await sql`insert into public.activity_stages(id,activity_id,ordinal,reveal_at_ms,stage) values(${event},${id},0,${future},
      ${sql.json({id:event,kind:'travel',revealedAtMs:future,startedAtMs:future,endsAtMs:future+100,label:'Travel'})})`;
    for (const client of [f.owner.client,f.other.client]) {
      expect((await client.from('visible_events').select('*').eq('id',event)).data).toEqual([]);
      expect((await readTimeline(client,id)).stages).toEqual([]);
      expect((await readWorld(client)).actors[0].visibleStage).toBeNull();
    }
    // Trusted fixture marker proves camp/profile omit the bulky replay payload while timeline remains on demand.
    await sql`update public.activity_stages set reveal_at_ms=0,stage=jsonb_set(stage,'{revealedAtMs}','0')||'{"battleLog":{"battleId":"only-on-demand"}}'::jsonb where id=${event}`;
    expect((await readTimeline(f.other.client,id)).stages).toHaveLength(1);
    expect((await readRevision(f.other.client)).revision).not.toBe(before.revision);
    expect((await readWorld(f.other.client)).actors[0].visibleStage?.id).toBe(event);
    expect((await readWorld(f.other.client)).actors[0].visibleStage).not.toHaveProperty('battleLog');
    expect((await readProfile(f.other.client,f.gid)).actor.visibleStage).not.toHaveProperty('battleLog');
    expect((await readTimeline(f.other.client,id)).stages[0].battleLog?.battleId).toBe('only-on-demand');
  });
  it('publishes completion without reward details, exposes full settled rewards only to the owner, and stays processing before settlement', async () => {
    const f = await fighter(), id = await activity(f.gid);
    expect((await readWorld(f.other.client)).actors[0].activityStatus).toBe('processing');
    expect((await readTimeline(f.owner.client,id)).summary).toBeUndefined();
    const summary = {activityId:id,resolvedKind:'rest',result:'completed',success:true,settledAtMs:Date.now()-1,replayExpiry:{state:'expired'},receiptId:randomUUID(),
      rewards:{money:1,renown:0,xp:0,attributePoints:0,items:[],overflowMoney:0}};
    await sql`update public.activities set status='completed',summary=${sql.json(summary)},settled_at_ms=${summary.settledAtMs} where id=${id}`;
    const spectator = await readTimeline(f.other.client,id), owner = await readTimeline(f.owner.client,id);
    expect(owner.summary?.rewards.money).toBe(1); expect(spectator.summary).toBeUndefined();
    expect(spectator.completion).toMatchObject({resolvedKind:'rest',result:'completed'}); safe(spectator);
    const recent = await readRecent(f.other.client); expect(recent.rows).toHaveLength(1); safe(recent);
    expect((await readWorld(f.other.client)).actors[0].activityStatus).toBe('completed');
  });
});
