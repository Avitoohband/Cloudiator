import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: {
    '@domain': fileURLToPath(new URL('./supabase/functions/_shared/domain', import.meta.url)),
    '@contracts': fileURLToPath(new URL('./supabase/functions/_shared/contracts', import.meta.url)),
    '@': fileURLToPath(new URL('./src', import.meta.url)),
  } },
  test: { include: ['tests/**/*.test.ts'], exclude: ['tests/db/**', 'tests/browser/**'] },
});
