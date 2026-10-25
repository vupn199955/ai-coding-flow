import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `http://127.0.0.1:${process.env.FLOW_API_PORT || '4310'}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
