import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

// Use Playwright's public multi-config merge overload. Keep the root config's Chrome/Pixel 7 projects, viewports,
// rendering, web servers and selection. Match the reviewed native profile's outer test budget; individual waits stay intact.
export default defineConfig(baseConfig, {
  workers: 1,
  retries: 0,
  repeatEach: 1,
  timeout: 90_000,
});
