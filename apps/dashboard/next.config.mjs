/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  transpilePackages: ['@depf/shared'],
  async rewrites() {
    return [
      {
        source: '/api/agent/:path*',
        destination: `${process.env.AGENT_API_URL ?? 'http://localhost:3200'}/api/:path*`,
      },
    ];
  },
};
export default config;
