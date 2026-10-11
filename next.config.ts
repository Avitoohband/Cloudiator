import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  env: {
    NEXT_PUBLIC_FIXTURE_ENABLED: process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true' ? 'true' : 'false',
  },
};
export default config;
