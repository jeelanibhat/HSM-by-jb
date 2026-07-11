import base from '@hotelos/config/eslint/base';

/**
 * Module boundary enforcement — TDD §2.1.
 *
 * "A module may only import another module's public API (modules/<name>/index.ts)."
 * Reaching into a sibling's domain/, infra/, or application/ folder is how a
 * modular monolith quietly becomes a big ball of mud, so it fails the build.
 *
 * A module's own internals are re-allowed below, since the restriction only
 * makes sense across module boundaries.
 */
export default [
  ...base,
  {
    files: ['src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/modules/*/domain/**',
                '**/modules/*/infra/**',
                '**/modules/*/application/**',
                '**/modules/*/graphql/**',
              ],
              message:
                'Cross-module imports must go through the module facade (modules/<name>/index.ts). See TDD §2.1.',
            },
            {
              group: ['../../*/'],
              message:
                'Reaching into a sibling module by relative path bypasses its public API. Import from its index.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    // Inside a module, its own layers may import each other freely.
    files: ['src/modules/*/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-imports': 'off',
    },
  },
];
