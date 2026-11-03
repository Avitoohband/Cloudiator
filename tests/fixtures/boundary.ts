import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, account, resetIdentity, admin, creation } from './db.ts';
import { createDatabase, createWorkerDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import type { WorkerDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { DEFAULT_EXECUTORS, runWorker } from '../../supabase/functions/_shared/backend/jobs.ts';
import type { JobLease } from '../../supabase/functions/_shared/domain/types.ts';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads.ts';

export const SLOT = 4_800_000;
export type Outcome = { ok: boolean; code?: string; [key: string]: unknown };
const commands = createDatabase(admin);

export async function rpc<T = Outcome>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}

// Operator-only world controls for the isolated local test database; no player API exposes them.
export async function resetWorld(published: number | null) {
  await resetIdentity();
  await sql`truncate private.boundaries, private.boundary_work, private.dispatch_log`;
  await sql`update private.coordinator set published_slot=${published}, lease_token=null, lease_until_ms=0, last_error=null where singleton`;
  await sql`update private.rules_versions set active=false where version<>'v1'`;
  await sql`delete from private.rules_versions where version not in ('v1','v2')`;
  await sql`update private.rules_versions set active=true where version='v1'`;
  await sql`update private.scheduler set enabled=false where singleton`;
}
export type Choices = { morning: unknown; afternoon: unknown; evening: unknown };
export const TTR: Choices = { morning: { kind: 'training' }, afternoon: { kind: 'training' }, evening: { kind: 'rest' } };
export const TRAINING: Choices = { morning: { kind: 'training' }, afternoon: { kind: 'training' }, evening: { kind: 'training' } };
/** Real creation, then the operator places the character at a historical first activity slot. */
export async function fighter(options: { firstSlot?: number; stamina?: number; schedule?: Choices; name?: string } = {}) {
  const firstSlot = options.firstSlot ?? 300, schedule = options.schedule ?? TTR;
  const owner = await account();
  const created = await commands.createGladiator({ userId: owner.id }, creation(options.name ?? 'Slot ' + randomUUID().slice(0, 8)));
  if (!created.ok) throw new Error('creation failed');
  const gid = created.value.gladiatorId;
  const createdAt = (firstSlot - 1) * SLOT + 1;
  await sql`update public.gladiators set created_at_ms=${createdAt},orientation_end_ms=${firstSlot * SLOT},processed_slot_index=${firstSlot - 1}
    ${options.stamina === undefined ? sql`` : sql`,stamina_current=${options.stamina}`} where id=${gid}`;
  await sql`update public.schedules set schedule=${sql.json(schedule as never)} where gladiator_id=${gid}`;
  for (const phase of ['morning', 'afternoon', 'evening'] as const) {
    await sql`update public.schedule_revisions set received_at_ms=${createdAt},effective_slot_index=${firstSlot},choice=${sql.json(schedule[phase] as never)}
      where gladiator_id=${gid} and phase=${phase}`;
  }
  const state = async (): Promise<OwnerState> => {
    const { data, error } = await owner.client.from('owner_state').select('state').single();
    if (error) throw new Error(error.message);
    return data!.state;
  };
  const row = async () => (await sql`select earned_points::int as earned, unspent_points::int as unspent, stamina_current::int as stamina,
    stamina_maximum::int as maximum, processed_slot_index::int as processed from public.gladiators where id=${gid}`)[0];
  return { ...owner, gid, state, row };
}
export async function coordinatorLease() {
  const token = randomUUID();
  await sql`update private.coordinator set lease_token=${token},lease_until_ms=9007199254740991 where singleton`;
  return token;
}
export const advance = (target: number, token: string) => rpc('advance_boundary', { target_slot: target, coordinator_token: token });
/** The real RPC adapter and real runWorker; only coordination is pinned to an explicit historical target. */
export function historicalPort(target: number, token: string): WorkerDatabase {
  const real = createWorkerDatabase(admin);
  return { ...real, coordinate: async () => ({ ok: true, publishedSlot: null, boundaries: [await advance(target, token)] }) };
}
export async function runBoundary(target: number, token?: string) {
  const lease = token ?? await coordinatorLease();
  for (let round = 0; round < 6; round++) {
    const result = await advance(target, lease);
    if (result.status === 'complete' || ['integration', 'operator', 'extension', 'straggler'].includes(result.wait as string)) return result;
    await runWorker({ database: historicalPort(target, lease), workerId: randomUUID() });
  }
  return advance(target, lease);
}
export async function settleDue(target: number, token: string) {
  return runWorker({ database: historicalPort(target, token), workerId: randomUUID() });
}
export async function claim(kind: string, limit = 20, worker = randomUUID()) {
  return rpc<JobLease[]>('claim_jobs', { worker_id: worker, kind, batch_limit: limit });
}
/** Completes preparation with its retained executor, without coordinating another boundary. */
export async function completePreparations() {
  for (const job of await claim('prepare')) {
    const executor = DEFAULT_EXECUTORS[job.rulesVersion];
    if (!executor?.prepare) throw new Error('unsupported preparation rules: ' + job.rulesVersion);
    const result = await executor.prepare(job);
    expect(await rpc('complete_job', { job_id: job.id, lease_token: job.token, result })).toMatchObject({ ok: true });
  }
}
