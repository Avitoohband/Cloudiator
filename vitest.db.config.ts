import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/db/**/*.test.ts'], fileParallelism: false, testTimeout: 20000, hookTimeout: 30000 } });
