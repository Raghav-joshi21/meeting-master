import type { NextConfig } from 'next';

// Served at https://<your-domain>/notes
const basePath = '/notes';

const nextConfig: NextConfig = {
  basePath,
  // fetch() calls don't get basePath added automatically; the client reads it from here.
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default nextConfig;
