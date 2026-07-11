import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  // Type-safe monorepo imports without a build step for the shared package.
  transpilePackages: ['@hotelos/domain'],

  // Lint is its own Turbo task and its own CI gate (`pnpm lint`), running the
  // @next/next plugin via flat config. Next's build-time linter only detects the
  // legacy `extends: "next"` shape, so leaving it on just re-runs ESLint with a
  // spurious "plugin not detected" warning. One gate, not two.
  eslint: { ignoreDuringBuilds: true },

  // A PMS runs on front-desk terminals, not the open web — but it still serves
  // guest PII, so the baseline headers are non-negotiable (TDD §9).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },

  // Don't ship source maps of our domain logic to a browser in prod.
  productionBrowserSourceMaps: false,
};

export default config;
