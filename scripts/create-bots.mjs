import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { BOT_CATALOG } from '../supabase/functions/_shared/domain/bots.ts';

// Use an owner connection from CLOUDIATOR_BOT_DB_URL.
// node scripts/create-bots.mjs --local
// node scripts/create-bots.mjs --production <exact-project-ref>
// Hosted execution follows separate release approval. This operation registers the roster in a benched state.
export function botTarget(args, connection) {
  const invalid = () => new Error('Invalid bot operator target.');
  let url;
  try { url = new URL(connection); } catch { throw invalid(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== 'postgres' || !url.password ||
    url.pathname !== '/postgres' || url.search || url.hash) throw invalid();
  if (args.length === 1 && args[0] === '--local' && url.hostname === '127.0.0.1' && url.port === '54322') return 'local';
  if (args.length === 2 && args[0] === '--production' && /^[a-z0-9]{20}$/.test(args[1]) &&
    url.hostname === `db.${args[1]}.supabase.co` && ['', '5432'].includes(url.port)) return 'production';
  throw invalid();
}

function systemId(key) {
  const bytes = createHash('sha256').update(`cloudiator\0ludus-nimbus\0${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The Auth rows and registrations commit together. Existing accounts are validated as-is on every retry. */
export async function provisionBots(sql) {
  return await sql.begin(async tx => {
    const counts = { created: 0, existing: 0, active: 0 };
    const identities = Object.keys(BOT_CATALOG).map(key => ({ key, id: systemId(key) }));
    await tx`select pg_advisory_xact_lock_shared(1600001,1)`;
    // Hold all account locks before taking any catalog member lock inside create_bot.
    for (const id of identities.map(identity => identity.id).sort()) {
      await tx`select pg_advisory_xact_lock(hashtextextended(${id}::text,0))`;
    }
    for (const { key, id } of identities) {
      try {
        await tx`insert into auth.users(id,instance_id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,
            created_at,updated_at,banned_until,confirmation_token,recovery_token,email_change,email_change_token_new)
          values(${id},'00000000-0000-0000-0000-000000000000','authenticated','authenticated',${key + '@ludus-nimbus.invalid'},'',
            ${tx.json({ provider: 'cloudiator-bot', providers: [], bot_key: key })},'{}',now(),now(),now()+interval '100 years','','','','')
          on conflict(id) do nothing`;
        const [{ result }] = await tx`select private.create_bot(${key},${id}::uuid) as result`;
        counts[result.created ? 'created' : 'existing']++;
        if (result.active) counts.active++;
      } catch {
        // Error details from Postgres can include the connection or identity. Report the catalog key only.
        throw new Error(`Bot provisioning failed for ${key}.`);
      }
    }
    return counts;
  });
}

async function main() {
  const connection = process.env.CLOUDIATOR_BOT_DB_URL;
  const target = botTarget(process.argv.slice(2), connection);
  const url = new URL(connection);
  const sql = postgres({ host: url.hostname, port: Number(url.port || 5432), database: 'postgres', user: 'postgres',
    password: decodeURIComponent(url.password), max: 1, ssl: target === 'production' ? { rejectUnauthorized: true } : false,
    onnotice: () => {} });
  try {
    const counts = await provisionBots(sql);
    console.log(JSON.stringify({ target, ...counts }));
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    const safe = /^(Invalid bot operator target\.|Bot provisioning failed for (tullia|grit|ash|rufus|pip)\.)$/.test(error.message);
    console.error(safe ? error.message : 'Bot provisioning failed.');
    process.exitCode = 1;
  });
}
