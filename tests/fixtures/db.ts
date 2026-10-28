import postgres from 'postgres';
import type { Sql } from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';

if (process.env.LOCAL_DB_TEST !== 'Cloudiator') throw new Error('Run through npm run test:db');
const url = process.env.LOCAL_API_URL!;
const dbUrl = process.env.LOCAL_DB_URL!;
for (const value of [url, dbUrl]) if (!['127.0.0.1', 'localhost'].includes(new URL(value).hostname)) throw new Error('Local tests only');
export const sql = postgres(dbUrl, { max: 12, onnotice: () => {} });
export const admin = createClient(url, process.env.LOCAL_SERVICE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
export const anonymous = createClient(url, process.env.LOCAL_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
export function tokenFor(id: string, expired = false) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: id, aud: 'authenticated', role: 'authenticated', iss: `${url}/auth/v1`, iat: now - 60, exp: expired ? now - 1 : now + 3600 })}`;
  return `${body}.${createHmac('sha256', process.env.LOCAL_JWT_SECRET!).update(body).digest('base64url')}`;
}
export async function account(provider = 'google') {
  // Use real Auth account creation so GoTrue's internal defaults stay valid.
  // Only the trusted local operator installs a Google identity in this isolated test project.
  const { data, error } = await admin.auth.admin.createUser({ email: randomUUID() + '@example.test', email_confirm: true,
    app_metadata: { provider, providers: [provider] } });
  if (error || !data.user) throw new Error(`Local account setup failed: ${error?.message}`);
  const id = data.user.id;
  if (provider !== 'email') await sql`insert into auth.identities (id, user_id, provider_id, provider, identity_data, created_at, updated_at)
    values (${randomUUID()}, ${id}, ${id}, ${provider}, ${sql.json({ sub: id, email: id + '@example.test' })}, now(), now())`;
  const token = tokenFor(id);
  const client = createClient(url, process.env.LOCAL_ANON_KEY!, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  return { id, token, client };
}
/**
 * A test-only stand-in for the server time a read samples (Task 22 final fix wave). `public.world_revision` computes
 * `server_now_ms` and `slot_index` from `statement_timestamp()` in the view itself, so no database function can stand in for
 * them; this fetch rewrites only those two fields of that view's response to `serverNowMs`. The database, its due-time RLS
 * (`clock_timestamp()`) and every other response stay real, and nothing in the database changes, so nothing needs restoring.
 * Without `serverNowMs` it is plain `fetch`.
 */
export function serverClockFetch(serverNowMs?: number): typeof fetch {
  if (serverNowMs === undefined) return fetch;
  return async (input, init) => {
    const response = await fetch(input, init);
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
    if (!response.ok || !path.endsWith('/rest/v1/world_revision')) return response;
    const body = await response.json();
    const at = (row: Record<string, unknown>) => ({ ...row, server_now_ms: serverNowMs, slot_index: Math.floor(serverNowMs / RULES_V1.clock.slotMs) });
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(at) : at(body)), { status: response.status, statusText: response.statusText, headers });
  };
}
/** A Data API client signed in with `token` (anonymous when null) whose reads sample `serverNowMs` as the server time. */
export function clockedClient(token: string | null, serverNowMs: number) {
  return createClient(url, process.env.LOCAL_ANON_KEY!, { global: { ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    fetch: serverClockFetch(serverNowMs) }, auth: { persistSession: false, autoRefreshToken: false } });
}
/**
 * A Data API client signed in with `token` that records every response body it receives (decoded JSON text and its
 * UTF-8 size), so a test can measure what a read transfers. Bodies stay in memory; nothing is logged here. With
 * `serverNowMs`, its reads sample that server time (`serverClockFetch`).
 */
export function recordingClient(token: string, options: { serverNowMs?: number } = {}) {
  const responses: { path: string; bytes: number; text: string }[] = [];
  const base = serverClockFetch(options.serverNowMs);
  const client = createClient(url, process.env.LOCAL_ANON_KEY!, { global: { headers: { Authorization: `Bearer ${token}` }, fetch: async (input, init) => {
    const response = await base(input, init);
    const text = await response.clone().text();
    responses.push({ path: new URL(String(input instanceof Request ? input.url : input)).pathname, bytes: Buffer.byteLength(text, 'utf8'), text });
    return response;
  } }, auth: { persistSession: false, autoRefreshToken: false } });
  return { client, responses };
}
export async function resetIdentity() {
  // No schema creation here: missing schema must produce an honest RED result.
  await sql`truncate public.gladiators cascade`;
  await sql`truncate private.command_attempts`;
  // Task 23.8: owners' activity signals are keyed by the account, outside the gladiators cascade.
  await sql`truncate private.owner_signals`;
  // Season rows and the standings archive have no foreign key to characters (Task 21), so the cascade does not reach them.
  await sql`truncate public.seasons, public.season_standings, private.season_awards`;
  // Game messages (M25) and each account's read marks (keyed by the account, outside the gladiators cascade): both emptied together,
  // restarting the identity, so the first message of a test is 1. Likewise each account's notifications mark (M25, also keyed by the account).
  await sql`truncate public.game_messages, public.message_reads, public.notification_marks restart identity`;
  // Retention state (Task 22): the operations log and wallet checkpoints start empty, and the singleton is reseeded (recreated
  // if it was ever deleted) with every watermark at its seed (-1), Task 23.7's job-payload watermark included.
  await sql`truncate private.operations_events, private.wallet_checkpoints`;
  await sql`insert into private.retention_state(singleton,detail_through_slot,summary_through_slot,jobs_compacted_through_slot,last_run_at_ms,last_result)
    values(true,-1,-1,-1,null,null) on conflict (singleton) do update set detail_through_slot=-1, summary_through_slot=-1,
    jobs_compacted_through_slot=-1, last_run_at_ms=null, last_result=null`;
  // Local and test databases set the launch season epoch explicitly (Task 16). It is immutable once set, so a local
  // database with any other epoch would place historical test slots outside a season.
  await sql`insert into private.season_epoch(singleton,epoch_slot) values(true,0) on conflict(singleton) do nothing`;
  const [{ epoch }] = await sql`select epoch_slot::int as epoch from private.season_epoch`;
  if (epoch !== 0) throw new Error('Local tests require the season epoch at slot 0');
}
export const creation = (name = 'Avi Fighter', operationId: string = randomUUID()) => ({ kind: 'create-character' as const, operationId, name, classId: 'guardian' as const,
  allocation: { strength: 2, agility: 2, vitality: 2, endurance: 2, precision: 2 } });
/**
 * A pending build as one queued BEFORE the fixed class and points release (2026-10-28) held it. The server no longer queues a fee,
 * a class change or a lower attribute (every allowed build change is free), but a build already pending at deploy keeps its fee
 * and applies as queued. So a test of that rewrites a free pending build to what the earlier `queue_build` wrote: the held
 * reservation, `reservedMoney`, the build it will apply and the stamina maximum prepared for it. `q` is `sql` or a transaction.
 */
export async function makeLegacyPending(q: Sql, gladiatorId: string, operationId: string,
  legacy: { fee: number; classId?: string; allocations?: Record<string, number>; staminaMaximum?: number }) {
  const { fee, classId, allocations, staminaMaximum } = legacy;
  await q`update public.reservations set money=${fee} where gladiator_id=${gladiatorId} and operation_id=${operationId} and status='held'`;
  await q`update public.builds set pending_build=jsonb_set(jsonb_set(pending_build,'{reservedMoney}',to_jsonb(${fee}::bigint)),'{build}',
    (pending_build->'build')||${q.json({ ...(classId ? { classId } : {}), ...(allocations ? { allocations } : {}) })})
    where gladiator_id=${gladiatorId} and pending_build->>'operationId'=${operationId}`;
  if (staminaMaximum !== undefined) await q`update private.pending_build_preparations set stamina_maximum=${staminaMaximum}
    where gladiator_id=${gladiatorId} and operation_id=${operationId}`;
}
export const request = (token: string, body: unknown) => new Request('http://local/game-command', {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3000' }, body: JSON.stringify(body),
});
/** HTTP transport directly to the running Edge container; bypasses only local Kong's CORS rewrite. */
export function directEdge(token: string, body: unknown, origin = 'http://127.0.0.1:3000') {
  const config = [
    'url = "http://supabase_edge_runtime_Cloudiator:8081/game-command"', 'request = "POST"', 'dump-header = "-"', 'silent', 'show-error',
    `header = ${JSON.stringify(`Authorization: Bearer ${token}`)}`, 'header = "Content-Type: application/json"',
    `header = ${JSON.stringify(`Origin: ${origin}`)}`, `data-binary = ${JSON.stringify(JSON.stringify(body))}`,
  ].join('\n');
  // Credentials travel on stdin, never in command arguments or diagnostics.
  const output = execFileSync('docker', ['exec', '-i', 'supabase_db_Cloudiator', 'curl', '--config', '-'], { input: config, encoding: 'utf8' });
  const [head, ...rest] = output.split('\r\n\r\n');
  return { status: Number(head.split(' ')[1]), origin: /^access-control-allow-origin:\s*(.+)$/im.exec(head)?.[1].trim(), body: JSON.parse(rest.join('\r\n\r\n')) };
}
