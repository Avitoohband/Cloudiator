import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { sql, admin, account, resetIdentity, creation, anonymous } from '../fixtures/db.ts';
import { createDatabase, createWorkerDatabase, prepareGrant } from '../../supabase/functions/_shared/backend/database.ts';
import { prepareActivityV1, runWorker } from '../../supabase/functions/_shared/backend/jobs.ts';
import { planExpedition } from '../../supabase/functions/_shared/domain/expedition.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { applyXp } from '../../supabase/functions/_shared/domain/inventory.ts';
import type { ActivitySnapshot, JobLease } from '../../supabase/functions/_shared/domain/types.ts';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';

const SLOT = 4_800_000;
const commands = createDatabase(admin);
async function fixture(options: { weak?: boolean; realSlot?: boolean } = {}) {
  const owner = await account();
  const created = await commands.createGladiator({ userId: owner.id }, creation('Exp ' + randomUUID().slice(0,8)));
  if (!created.ok) throw Error('create failed');
  const gid = created.value.gladiatorId, aid = randomUUID(), slot = options.realSlot ? Math.floor(Date.now()/SLOT)-1 : 300;
  const state = async (): Promise<OwnerState> => (await owner.client.from('owner_state').select('state').single()).data!.state;
  if(options.weak) await sql`update public.gladiators set level=5 where id=${gid}`;
  const initial = await state();
  const input = { gladiatorId: gid, slotIndex: slot, rulesVersion: 'v1', level: initial.progression.level, earnedPoints: 300,
    build: { ...initial.currentBuild, allocations: { strength: options.weak ? 0 : 150, agility: 5, vitality: options.weak ? 0 : 30, endurance: 5, precision: 5 } }, items: initial.inventory };
  const prepared = prepareActivityV1(input);
  const snapshot: ActivitySnapshot = { activityId: aid, gladiatorId: gid, slotIndex: slot, cutoffMs: slot*SLOT,
    choice: { kind: 'expedition', expeditionId: options.weak ? 'outpost' : 'woodland' }, scheduleVersion: 1, ...prepared,
    build: prepared.snapshot, starting: { stamina: initial.stamina, level: initial.progression.level, xp: 0, earnedPoints: 300, unspentPoints: 105,
      league: 'bronze', rating: 1000, peakStrength: 28, tournamentOptIn: false } };
  await sql`insert into public.activities(id,gladiator_id,slot_index,starts_at_ms,ends_at_ms,requested,resolved_kind,status,debited)
    values(${aid},${gid},${slot},${slot*SLOT},${(slot+1)*SLOT},${sql.json(snapshot.choice)},'expedition','active',true)`;
  await sql`insert into private.activity_snapshots(activity_id,snapshot,seed,rules_version) values(${aid},${sql.json(snapshot as never)},'success','v1')`;
  await sql`select private.prepare_activity_jobs(${aid})`;
  return { ...owner, gid, aid, slot, snapshot, state, initial };
}
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(name,args); if (error) throw Error(error.message); return data;
}
const claim = (kind: string) => rpc('claim_jobs',{worker_id:randomUUID(),kind,batch_limit:20}) as Promise<JobLease[]>;
async function plan(f: Awaited<ReturnType<typeof fixture>>) {
  const [job] = await claim('simulation');
  const proposal = planExpedition(f.snapshot,job.seed,RULES_V1);
  expect(await rpc('commit_expedition_plan',{job_id:job.id,lease_token:job.token,plan:proposal})).toMatchObject({ok:true});
  return { job, proposal };
}
async function revealAll() {
  for (let i=0;i<10;i++) {
    const jobs=await claim('reveal'); if (!jobs.length) return;
    for (const job of jobs) expect(await rpc('complete_job',{job_id:job.id,lease_token:job.token,result:{}})).toMatchObject({ok:true});
  }
}
async function settlementPreparation(f: Awaited<ReturnType<typeof fixture>>, rewards: { xp: number; money: number; loot: readonly import('../../supabase/functions/_shared/domain/inventory.ts').LootGrant[] }) {
  const state=await f.state(), baseline={level:state.progression.level,xp:state.progression.xp};
  return {rewards,grant:prepareGrant(state,rewards.loot),progressionBaseline:baseline,progression:applyXp(baseline.level,baseline.xp,rewards.xp)};
}
beforeEach(async()=>{
  await resetIdentity();
  await sql`truncate private.boundaries,private.boundary_work`;
  await sql`update private.coordinator set published_slot=300,lease_token=null,lease_until_ms=0 where singleton`;
  await sql`update private.scheduler set enabled=false where singleton`;
});
afterAll(()=>sql.end());
describe('private expedition integration',()=>{
  it('failure still waits until terminal settlement and preserves equipment, points, stamina and all wallets',async()=>{
    const f=await fixture({weak:true}), {proposal}=await plan(f);
    expect(proposal.success).toBe(false);expect(proposal.rewards).toEqual({money:0,xp:0,loot:[]});
    await revealAll();const [job]=await claim('settlement');
    expect(await createWorkerDatabase(admin).settle(f.aid,job.token)).toMatchObject({ok:true,summary:{success:false,result:'defeat',rewards:{money:0,xp:0,items:[],overflowMoney:0}}});
    const after=await f.state();expect(after.wallets).toEqual(f.initial.wallets);expect(after.inventory).toEqual(f.initial.inventory);
    expect(after.progression).toEqual(f.initial.progression);expect(after.stamina).toEqual(f.initial.stamina);
  });
  it('runs planning, reveals and exactly-once rewards through the real private Edge worker HTTP endpoint',async()=>{
    const f=await fixture({realSlot:true});
    await sql`update private.coordinator set published_slot=${f.slot},lease_token=null,lease_until_ms=0 where singleton`;
    const secret=process.env.LOCAL_WORKER_SECRET!;expect(secret.length).toBeGreaterThan(20);
    const worker=()=>{
      const config=['url = "http://supabase_edge_runtime_Cloudiator:8081/game-worker"','request = "POST"','silent','show-error',
        'write-out = "\\n%{http_code}"',`header = ${JSON.stringify(`Authorization: Bearer ${secret}`)}`,'header = "Content-Type: application/json"','data-binary = "{}"'].join('\n');
      const output=execFileSync('docker',['exec','-i','supabase_db_Cloudiator','curl','--config','-'],{input:config,encoding:'utf8'});
      const split=output.lastIndexOf('\n');expect(Number(output.slice(split+1))).toBe(200);return JSON.parse(output.slice(0,split));
    };
    let completed=false;
    for(let round=0;round<14;round++) {const report=worker();expect(report.failed).toBe(0);
      completed=(await sql`select status from public.activities where id=${f.aid}`)[0].status==='completed';if(completed) break;}
    expect(completed).toBe(true);expect((await f.state()).wallets.money).toBe(120);
    expect(worker().failed).toBe(0);expect((await f.state()).wallets.money).toBe(120);
    expect(await sql`select * from private.settled_slots where activity_id=${f.aid}`).toHaveLength(1);
  });
  it('withholds money/items/progression at minute 79 and settles at minute 80 using database time',async()=>{
    const f=await fixture(); await plan(f);
    const before=await f.state();
    const rollback=Error('rollback-only');
    await expect(sql.begin(async tx=>{
      const clock=async(ms:number)=>tx.unsafe(`create or replace function private.planning_now_ms() returns bigint language sql volatile security invoker set search_path='' as 'select ${ms}::bigint'`);
      const drain=async()=>{
        for(let n=0;n<10;n++) {
          const [{jobs}]=await tx`select public.claim_jobs(${randomUUID()},'reveal',20) as jobs`;
          if(!jobs.length) break;
          expect(jobs).toHaveLength(1);
          for(const job of jobs) await tx`select public.complete_job(${job.id},${job.token},'{}'::jsonb)`;
        }
      };
      await clock(f.slot*SLOT+79*60000); await drain();
      expect((await tx`select public.claim_jobs(${randomUUID()},'settlement',20) as jobs`)[0].jobs).toEqual([]);
      const [unchanged]=await tx`select w.money::int as money,g.level::int as level,g.xp::int as xp,
        (select count(*)::int from public.item_instances where gladiator_id=g.id) as items from public.gladiators g join public.wallets w on w.gladiator_id=g.id where g.id=${f.gid}`;
      expect(unchanged).toEqual({money:before.wallets.money,level:before.progression.level,xp:before.progression.xp,items:before.inventory.length});
      await clock((f.slot+1)*SLOT);await drain();
      const [{jobs}]=await tx`select public.claim_jobs(${randomUUID()},'settlement',20) as jobs`;
      expect(jobs).toHaveLength(1);
      const proposal=planExpedition(f.snapshot,'success',RULES_V1);
      const prepared=await settlementPreparation(f,structuredClone(proposal.rewards));
      const [{outcome}]=await tx`select public.settle_expedition(${f.aid},${jobs[0].token},${tx.json(prepared as never)}) as outcome`;
      expect(outcome).toMatchObject({ok:true,newGrants:1,summary:{rewards:{money:20,xp:100}}});
      throw rollback;
    })).rejects.toBe(rollback);
  });
  it('returns stale preparation without a guard or grant then replans the same reward proposal',async()=>{
    const f=await fixture(), {proposal}=await plan(f); await revealAll();
    const [job]=await claim('settlement');
    const prepared=await settlementPreparation(f,structuredClone(proposal.rewards));
    const item={...f.initial.inventory[0],id:randomUUID(),reservation:null,origin:'shop'};
    await sql`insert into public.item_instances(id,gladiator_id,item) values(${item.id},${f.gid},${sql.json(item)})`;
    expect(await rpc('settle_expedition',{activity_id:f.aid,lease_token:job.token,prepared})).toEqual({ok:false,code:'stale-preparation'});
    expect(await sql`select * from private.settled_slots where activity_id=${f.aid}`).toHaveLength(0);
    expect((await f.state()).wallets).toEqual(f.initial.wallets);
    expect(await createWorkerDatabase(admin).settle(f.aid,job.token)).toMatchObject({ok:true,newGrants:1});
    expect((await sql`select plan->'rewards' as rewards from private.expedition_plans where activity_id=${f.aid}`)[0].rewards).toEqual(proposal.rewards);
  });
  it('converts full-inventory rewards atomically, preserves held fees and reports every conversion',async()=>{
    const f=await fixture(), {proposal}=await plan(f);
    for(let i=0;i<58;i++) {
      const item={...f.initial.inventory[0],id:randomUUID(),reservation:null,origin:'shop'};
      await sql`insert into public.item_instances(id,gladiator_id,item) values(${item.id},${f.gid},${sql.json(item)})`;
    }
    await sql`insert into public.reservations(gladiator_id,operation_id,money,renown,status) values(${f.gid},${randomUUID()},80,0,'held')`;
    await revealAll();const [job]=await claim('settlement');
    const prepared=await settlementPreparation(f,structuredClone(proposal.rewards));
    const result=await createWorkerDatabase(admin).settle(f.aid,job.token);
    expect(result).toMatchObject({ok:true,summary:{rewards:{items:[],overflowMoney:prepared.grant.plan.overflowMoney,overflow:prepared.grant.plan.overflow.map(e=>({...e,catalogVersion:'v1'}))}}});
    const after=await f.state();
    expect(after.inventory).toHaveLength(60);
    expect(after.wallets.money).toBe(120+prepared.grant.plan.overflowMoney);
    expect(after.reservedFees.money).toBe(80);
    const ledger=await sql`select money_delta::int as money from public.wallet_ledger where gladiator_id=${f.gid} and reason='expedition'`;
    expect(ledger).toEqual([{money:20+prepared.grant.plan.overflowMoney}]);
    const ownerReceipt=await f.client.from('activities').select('summary').eq('id',f.aid).single();
    expect(ownerReceipt.data?.summary.rewards.overflow).toEqual(prepared.grant.plan.overflow.map(e=>({...e,catalogVersion:'v1'})));
    const spectator=await account();
    expect((await spectator.client.from('activities').select('summary').eq('id',f.aid)).data).toEqual([]);
    const stages=await spectator.client.from('activity_stages').select('stage').eq('activity_id',f.aid);
    expect(stages.data!.length).toBeGreaterThan(0);
    expect(JSON.stringify(stages.data)).not.toMatch(/"(?:rewards|overflow|money|loot)":/);
  });
  it('rolls back item/progression/wallet/guard effects when final ledger insertion fails',async()=>{
    const f=await fixture();await plan(f);await revealAll();const [job]=await claim('settlement');
    await sql`create or replace function private.test_expedition_ledger_failure() returns trigger language plpgsql as 'begin if new.reason=''expedition'' then raise exception ''test failure''; end if; return new; end'`;
    await sql`create trigger test_expedition_ledger_failure before insert on public.wallet_ledger for each row execute function private.test_expedition_ledger_failure()`;
    try {
      await expect(createWorkerDatabase(admin).settle(f.aid,job.token)).rejects.toThrow('worker-database-unavailable');
      const state=await f.state();expect(state.wallets).toEqual(f.initial.wallets);expect(state.inventory).toEqual(f.initial.inventory);expect(state.progression).toEqual(f.initial.progression);
      expect(await sql`select * from private.settled_slots where activity_id=${f.aid}`).toHaveLength(0);
    } finally {await sql`drop trigger test_expedition_ledger_failure on public.wallet_ledger`;await sql`drop function private.test_expedition_ledger_failure()`;}
  });
  it('validates nested reward, rating and replay variants and strips unknown private keys',async()=>{
    const base={result:'victory',success:true,rewards:{money:1,renown:0,xp:100,attributePoints:0,overflowMoney:0,items:[]},replayExpiry:{state:'available',expiresAtMs:10}};
    const [{safe}]=await sql`select private.safe_settlement(${sql.json({...base,seed:'hidden',rewards:{...base.rewards,private:'hidden'},replayExpiry:{...base.replayExpiry,seed:'hidden'}})}) as safe`;
    expect(safe).toEqual(base);
    for(const bad of [
      {...base,rewards:{...base.rewards,money:-1}}, {...base,rewards:{...base.rewards,xp:1.1}},
      {...base,rewards:{...base.rewards,items:[{catalogId:'salvage',catalogVersion:'v1',tier:1,rarity:'common',quantity:0}]}},
      {...base,ratingDelta:'5'}, {...base,replayExpiry:{state:'available'}}, {...base,replayExpiry:{state:'unknown'}},
      {...base,rewards:{...base.rewards,overflowMoney:10,overflow:[{catalogId:'salvage',catalogVersion:'v1',quantity:1,unitValue:10,money:9}]}},
      {...base,rewards:{...base.rewards,overflowMoney:11,overflow:[{catalogId:'salvage',catalogVersion:'v1',quantity:1,unitValue:10,money:10}]}},
    ]) await expect(sql`select private.safe_settlement(${sql.json(bad)})`).rejects.toThrow('invalid settlement outcome');
    expect((await sql`select private.safe_settlement(${sql.json({...base,ratingDelta:-12,replayExpiry:{state:'expired'}})}) as value`)[0].value).toMatchObject({ratingDelta:-12,replayExpiry:{state:'expired'}});
  });
  it('malformed settlement hook rolls back its writes and permanent guard, then records a failed worker job',async()=>{
    const f=await fixture();await plan(f);await revealAll();
    await sql`update public.activities set resolved_kind='training' where id=${f.aid}`;
    const [{definition}]=await sql`select pg_get_functiondef('private.settle_rewards(uuid)'::regprocedure) as definition`;
    const malformed={result:'completed',success:true,rewards:{money:0,renown:0,xp:0,attributePoints:1,overflowMoney:10,items:[],overflow:[{catalogId:'salvage',catalogVersion:'v1',quantity:1,unitValue:10,money:9}]},replayExpiry:{state:'expired'}};
    await sql.unsafe(`create or replace function private.settle_rewards(activity uuid) returns jsonb language plpgsql security invoker set search_path='' as $hook$
      begin update public.gladiators set earned_points=earned_points+1 where id=(select gladiator_id from public.activities where id=activity);
      return '${JSON.stringify(malformed)}'::jsonb; end $hook$`);
    try {
      const database={...createWorkerDatabase(admin),coordinate:async()=>({ok:true,publishedSlot:300})};
      expect(await runWorker({database,workerId:randomUUID()})).toMatchObject({failed:1,completed:0});
      expect(await sql`select * from private.settled_slots where activity_id=${f.aid}`).toHaveLength(0);
      expect((await f.state()).progression).toEqual(f.initial.progression);
      expect((await f.state()).wallets).toEqual(f.initial.wallets);
      expect((await sql`select status,last_failure from private.jobs where dedupe_key=${'settlement:'+f.aid}`)[0]).toMatchObject({status:'pending',last_failure:'execution-failed'});
    } finally {await sql.unsafe(definition);}
  });
  it('fences stolen and expired leases, retries the same seed/snapshot, and sweeps the exhausted third lease',async()=>{
    const f=await fixture();const [first]=await claim('simulation');
    const result=planExpedition(first.snapshot as ActivitySnapshot,first.seed,RULES_V1);
    expect(await rpc('commit_expedition_plan',{job_id:first.id,lease_token:randomUUID(),plan:result})).toMatchObject({ok:false,code:'conflict'});
    await expect(sql`update private.jobs set seed='changed' where id=${first.id}`).rejects.toThrow('immutable job');
    await sql`update private.jobs set lease_until_ms=0 where id=${first.id}`;
    expect(await rpc('commit_expedition_plan',{job_id:first.id,lease_token:first.token,plan:result})).toMatchObject({ok:false,code:'conflict'});
    const [second]=await claim('simulation');expect(second.seed).toBe(first.seed);expect(second.snapshot).toEqual(first.snapshot);expect(second.rulesVersion).toBe(first.rulesVersion);
    expect(planExpedition(second.snapshot as ActivitySnapshot,second.seed,RULES_V1)).toEqual(result);
    await sql`update private.jobs set lease_until_ms=0 where id=${first.id}`;
    const [third]=await claim('simulation');expect(third.attempt).toBe(3);
    await sql`update private.jobs set lease_until_ms=0 where id=${first.id}`;
    await sql`select private.sweep_exhausted_leases(private.planning_now_ms())`;
    expect((await sql`select status from private.jobs where id=${first.id}`)[0].status).toBe('operator');
    expect(await claim('simulation')).toEqual([]);expect(await claim('settlement')).toEqual([]);
    expect((await f.state()).wallets).toEqual(f.initial.wallets);
  });
  it.each(['renew_job','complete_job','commit_expedition_plan','settle_expedition'])('%s checks expiry after a proven lock wait',async(name)=>{
    const f=await fixture();
    if(name==='settle_expedition') { await plan(f); await revealAll(); }
    const [job]=await claim(name==='settle_expedition'?'settlement':'simulation');
    const payload=name==='settle_expedition' ? await settlementPreparation(f,planExpedition(f.snapshot,job.seed,RULES_V1).rewards)
      : planExpedition(f.snapshot,job.seed,RULES_V1);
    const [{expiry}]=await sql`update private.jobs set lease_until_ms=private.planning_now_ms()+3000 where id=${job.id} returning lease_until_ms::text as expiry`;
    let locked!:()=>void, release!:()=>void;
    const ready=new Promise<void>(resolve=>{locked=resolve;});
    const hold=new Promise<void>(resolve=>{release=resolve;});
    const blocker=sql.begin(async tx=>{
      await tx`select 1 from private.jobs where id=${job.id} for update`;
      locked();await hold;
    });
    await ready;
    const contender=await sql.reserve();
    let response: PromiseLike<unknown> | undefined;
    try {
      const [{pid}]=await contender`select pg_backend_pid() as pid`;
      response=(name==='renew_job' ? contender`select public.renew_job(${job.id},${job.token}) as outcome`
        : name==='complete_job' ? contender`select public.complete_job(${job.id},${job.token},${contender.json(payload as never)}) as outcome`
        : name==='commit_expedition_plan' ? contender`select public.commit_expedition_plan(${job.id},${job.token},${contender.json(payload as never)}) as outcome`
        : contender`select public.settle_expedition(${f.aid},${job.token},${contender.json(payload as never)}) as outcome`).execute();
      let blocked=false;
      for(let n=0;n<100;n++) {
        const [state]=await sql`select cardinality(pg_blocking_pids(${pid}))>0 as blocked,private.planning_now_ms()::text as now`;
        if(state.blocked) { expect(Number(state.now)).toBeLessThan(Number(expiry)); blocked=true; break; }
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);
      while(Number((await sql`select private.planning_now_ms()::text as now`)[0].now)<=Number(expiry)) await new Promise(resolve=>setTimeout(resolve,40));
      release();await blocker;
      expect(await response).toMatchObject([{outcome:{ok:false,code:'conflict'}}]);
      expect((await sql`select status,lease_until_ms::text as expiry from private.jobs where id=${job.id}`)[0]).toEqual({status:'leased',expiry});
      expect(await sql`select 1 from private.settled_slots where activity_id=${f.aid}`).toHaveLength(0);
      if(name!=='settle_expedition') expect(await sql`select 1 from private.expedition_plans where activity_id=${f.aid}`).toHaveLength(0);
    } finally { release();await blocker;await response;contender.release(); }
  });
  it.each(['renew_job','complete_job'])('%s revalidates current token and status after locking',async(name)=>{
    const f=await fixture(),[job]=await claim('simulation');
    const payload=planExpedition(f.snapshot,job.seed,RULES_V1);
    for(const state of ['replaced-token','pending']) {
      await sql`update private.jobs set lease_token=${job.token},status='leased' where id=${job.id}`;
      let locked!:()=>void,release!:()=>void;
      const ready=new Promise<void>(resolve=>{locked=resolve;});
      const hold=new Promise<void>(resolve=>{release=resolve;});
      const blocker=sql.begin(async tx=>{
        await tx`update private.jobs set lease_token=${state==='replaced-token'?randomUUID():job.token},status=${state==='pending'?'pending':'leased'} where id=${job.id}`;
        locked();await hold;
      });
      await ready;
      const contender=await sql.reserve();let response:PromiseLike<unknown>|undefined;
      try {
        const [{pid}]=await contender`select pg_backend_pid() as pid`;
        response=(name==='renew_job'?contender`select public.renew_job(${job.id},${job.token}) as outcome`
          :contender`select public.complete_job(${job.id},${job.token},${contender.json(payload as never)}) as outcome`).execute();
        let blocked=false;
        for(let n=0;n<100;n++) {
          if((await sql`select cardinality(pg_blocking_pids(${pid}))>0 as blocked`)[0].blocked) {blocked=true;break;}
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        expect(blocked).toBe(true);release();await blocker;
        expect(await response).toMatchObject([{outcome:{ok:false,code:'conflict'}}]);
      } finally {release();await blocker;await response;contender.release();}
    }
    expect(await sql`select 1 from private.expedition_plans where activity_id=${f.aid}`).toHaveLength(0);
  });
  it('dispatch counts only dependency-ready jobs',async()=>{
    const f=await fixture(), [job]=await claim('simulation');
    const rollback=Error('rollback dispatch');
    await expect(sql.begin(async tx=>{
      await tx`select vault.create_secret('http://127.0.0.1:9/never-sent','game_worker_url')`;
      await tx`select vault.create_secret('dependency-test-secret-0123456789abcdef','game_worker_secret')`;
      expect((await tx`select private.dispatch_workers() as result`)[0].result).toMatchObject({dispatched:0});
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await claim('settlement')).toEqual([]);
    expect(job.activityId).toBe(f.aid);
  });
  it('rechecks salvage reservations after preparation and leaves the immutable activity snapshot unchanged',async()=>{
    const f=await fixture(), {proposal}=await plan(f);await revealAll();const [job]=await claim('settlement');
    const item={id:randomUUID(),ownerId:f.gid,catalogId:'salvage',catalogVersion:'v1',tier:1,rarity:'common',quantity:5,
      origin:'expedition',binding:'tradable',reservation:null,stats:{damage:0,armor:0,weight:0,intervalMs:0,attributes:{strength:0,agility:0,vitality:0,endurance:0,precision:0}}};
    await sql`insert into public.item_instances(id,gladiator_id,item) values(${item.id},${f.gid},${sql.json(item)})`;
    const prepared=await settlementPreparation(f,structuredClone(proposal.rewards));
    await sql`update public.item_instances set item=jsonb_set(item,'{reservation}',${sql.json({kind:'listing',referenceId:randomUUID()})}) where id=${item.id}`;
    expect(await rpc('settle_expedition',{activity_id:f.aid,lease_token:job.token,prepared})).toMatchObject({ok:false,code:'stale-preparation'});
    expect(await createWorkerDatabase(admin).settle(f.aid,job.token)).toMatchObject({ok:true});
    const inventory=(await f.state()).inventory;
    expect(inventory.find(i=>i.id===item.id)?.quantity).toBe(5);
    expect(inventory.filter(i=>i.catalogId==='salvage')).toHaveLength(2);
    expect((await sql`select snapshot from private.activity_snapshots where activity_id=${f.aid}`)[0].snapshot).toEqual(f.snapshot);
  });
  it('never reveals or serializes private reward or seed extensions in stage logs',async()=>{
    const f=await fixture(), [job]=await claim('simulation');
    const proposal=structuredClone(planExpedition(f.snapshot,job.seed,RULES_V1));
    const battle=proposal.stages.find(s=>s.battleLog)!.battleLog!;
    Object.assign(battle,{seed:'private-canary',rewards:{money:999}});
    Object.assign(battle.participants[0],{ownerId:'private-canary'});
    expect(await rpc('commit_expedition_plan',{job_id:job.id,lease_token:job.token,plan:proposal})).toMatchObject({ok:true});
    await revealAll();
    const other=await account(), visible=await other.client.from('activity_stages').select('stage').eq('activity_id',f.aid);
    expect(JSON.stringify(visible.data)).not.toContain('private-canary');
    expect(JSON.stringify(visible.data)).not.toContain('"rewards"');
    expect((await other.client.from('activities').select('summary').eq('id',f.aid)).data).toEqual([]);
  });
  it('creates a simulation prerequisite and withholds settlement until all ordered due reveals complete',async()=>{
    const f=await fixture();
    expect(await claim('settlement')).toEqual([]);
    const {job,proposal}=await plan(f);
    expect(await rpc('commit_expedition_plan',{job_id:job.id,lease_token:job.token,plan:proposal})).toMatchObject({ok:true,replayed:true});
    expect(await claim('settlement')).toEqual([]);
    await revealAll();
    const [settlement]=await claim('settlement');
    const db=createWorkerDatabase(admin);
    const result=await db.settle(f.aid,settlement.token);
    expect(result).toMatchObject({ok:true,newGrants:1,summary:{success:true,rewards:{xp:100,money:20}}});
    expect(await db.settle(f.aid,settlement.token)).toMatchObject({ok:true,newGrants:0,replayed:true});
    const state=await f.state();
    expect(state.wallets.money).toBe(120);
    expect(state.progression).toMatchObject({level:2,xp:0});
    expect(state.inventory.find(i=>i.catalogId==='salvage')?.quantity).toBe(1);
    expect(state.stamina).toEqual(f.initial.stamina);
    expect(state.progression.earnedAttributePoints).toBe(f.initial.progression.earnedAttributePoints);
    expect((await sql`select * from private.settled_slots where activity_id=${f.aid}`)).toHaveLength(1);
  });
  it('denies private plans and future guessed stages to owner, other account, and anonymous clients',async()=>{
    const f=await fixture();await plan(f);await revealAll();
    const other=await account();
    for(const client of [f.client,other.client,anonymous]) {
      expect((await client.schema('private').from('expedition_plans').select('*')).error).not.toBeNull();
      expect((await client.rpc('commit_expedition_plan',{job_id:randomUUID(),lease_token:randomUUID(),plan:{}})).error).not.toBeNull();
      expect((await client.rpc('expedition_settlement_input',{activity_id:f.aid,lease_token:randomUUID()})).error).not.toBeNull();
      expect((await client.rpc('settle_expedition',{activity_id:f.aid,lease_token:randomUUID(),prepared:{}})).error).not.toBeNull();
      expect((await client.from('activity_stages').insert({activity_id:f.aid,ordinal:90,reveal_at_ms:0,stage:{}})).error).not.toBeNull();
    }
    const futureId=randomUUID();
    await sql`insert into public.activity_stages(id,activity_id,ordinal,reveal_at_ms,stage) values(${futureId},${f.aid},99,
      ${Date.now()+100000},${sql.json({id:futureId,kind:'return',revealedAtMs:Date.now()+100000,startedAtMs:Date.now()+100000,endsAtMs:Date.now()+100000,label:'future'})})`;
    for(const client of [f.client,other.client]) {
      const hidden=await client.from('activity_stages').select('*').eq('id',futureId);
      expect(hidden.error).toBeNull();expect(hidden.data).toEqual([]);
      const visible=await client.from('activity_stages').select('*').eq('activity_id',f.aid);
      expect(visible.data!.length).toBeGreaterThan(0);
      expect(JSON.stringify(visible.data)).not.toContain('seed');
    }
    expect((await anonymous.from('activity_stages').select('*')).error).not.toBeNull();
  });
});
