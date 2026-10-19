import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The same source aliases as vitest.config.ts: DB tests also drive the frontend read adapters, which import the shared domain.
export default defineConfig({
  resolve: { alias: {
    '@domain': fileURLToPath(new URL('./supabase/functions/_shared/domain', import.meta.url)),
    '@contracts': fileURLToPath(new URL('./supabase/functions/_shared/contracts', import.meta.url)),
    '@': fileURLToPath(new URL('./src', import.meta.url)),
  } },
  // fsModuleCache stays off (the default), stated so vitest does not print its caching hint in the gate (Task 23.6, C23).
  test: { include: ['tests/db/**/*.test.ts'], fileParallelism: false, testTimeout: 20000, hookTimeout: 30000, fsModuleCache: false },
});
