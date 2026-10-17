import type { NextConfig } from 'next';

if (process.env.NODE_ENV === 'production' && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY === 'sb_publishable_browser_test_only') {
  throw new Error('Test identity transport cannot be included in a production export.');
}

const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  distDir: process.env.CLOUDIATOR_BROWSER_TEST === 'true' ? '.next/browser-test' : '.next',
  // The full-screen camp has controls in every corner (the touch ☰ button sits where the indicator would); compile and
  // runtime errors still show.
  devIndicators: false,
  env: {
    NEXT_PUBLIC_FIXTURE_ENABLED: process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true' ? 'true' : 'false',
  },
};
export default config;
