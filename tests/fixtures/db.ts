import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

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
 * A Data API client signed in with `token` that records every response body it receives (decoded JSON text and its
 * UTF-8 size), so a test can measure what a read transfers. Bodies stay in memory; nothing is logged here.
 */
export function recordingClient(token: string) {
  const responses: { path: string; bytes: number; text: string }[] = [];
  const client = createClient(url, process.env.LOCAL_ANON_KEY!, { global: { headers: { Authorization: `Bearer ${token}` }, fetch: async (input, init) => {
    const response = await fetch(input, init);
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
  // Season rows and the standings archive have no foreign key to characters (Task 21), so the cascade does not reach them.
  await sql`truncate public.seasons, public.season_standings, private.season_awards`;
  // Retention state (Task 22): the operations log and wallet checkpoints start empty, and both watermarks at their seed (-1).
  await sql`truncate private.operations_events, private.wallet_checkpoints`;
  await sql`update private.retention_state set detail_through_slot=-1, summary_through_slot=-1, last_run_at_ms=null, last_result=null where singleton`;
  // Local and test databases set the launch season epoch explicitly (Task 16). It is immutable once set, so a local
  // database with any other epoch would place historical test slots outside a season.
  await sql`insert into private.season_epoch(singleton,epoch_slot) values(true,0) on conflict(singleton) do nothing`;
  const [{ epoch }] = await sql`select epoch_slot::int as epoch from private.season_epoch`;
  if (epoch !== 0) throw new Error('Local tests require the season epoch at slot 0');
}
export const creation = (name = 'Avi Fighter', operationId: string = randomUUID()) => ({ kind: 'create-character' as const, operationId, name, classId: 'guardian' as const,
  allocation: { strength: 2, agility: 2, vitality: 2, endurance: 2, precision: 2 } });
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
