import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  /**
   * Dev and prod builds get SEPARATE output directories.
   *
   * They share `.next` by default, and the two are not compatible: a production
   * build writes a client manifest with no dev-tools modules in it, so a dev
   * server pointed at it dies with
   *
   *   Could not find the module ...segment-explorer-node.js#SegmentViewNode
   *   in the React Client Manifest
   *   TypeError: Cannot read properties of undefined (reading 'call')
   *
   * ...and Next blames "a bug in the React Server Components bundler", which
   * sends you hunting in the wrong place entirely.
   *
   * That collision happens on a completely ordinary action: running `pnpm build`
   * (or CI's build gate) while `pnpm dev` is up. A README warning does not
   * survive contact with that. Separate directories make it impossible.
   */
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',

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
