import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Discover only this checkout's local stack. Never accept a hosted database override.
const cli = resolve('node_modules/supabase/dist/supabase.js');
let status;
try {
  status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
} catch {
  // Do not include CLI stdout in a thrown exception: status contains local credentials.
  throw new Error('Cannot discover the local backend. Start Supabase for this checkout first.');
}
for (const key of ['API_URL', 'DB_URL']) {
  const url = new URL(status[key]);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Tests require a local backend');
}
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.db.config.ts', ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, LOCAL_DB_TEST: 'Cloudiator', LOCAL_API_URL: status.API_URL,
    LOCAL_DB_URL: status.DB_URL, LOCAL_ANON_KEY: status.ANON_KEY, LOCAL_SERVICE_KEY: status.SERVICE_ROLE_KEY, LOCAL_JWT_SECRET: status.JWT_SECRET },
});
process.exit(result.status ?? 1);
