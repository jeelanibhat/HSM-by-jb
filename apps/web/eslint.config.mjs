import next from '@next/eslint-plugin-next';
import base from '@hotelos/config/eslint/base';

/**
 * eslint-config-next is still eslintrc-format, so we mount the plugin directly
 * rather than dragging in FlatCompat. Same rule sets: recommended catches App
 * Router mistakes (<img> over next/image, sync scripts); core-web-vitals
 * promotes the ones that cost real CLS/LCP to errors.
 */
export default [
  ...base,
  {
    ignores: ['.next/**', 'next-env.d.ts', 'lib/graphql/generated/**'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { '@next/next': next },
    rules: {
      ...next.configs.recommended.rules,
      ...next.configs['core-web-vitals'].rules,
    },
  },
];
