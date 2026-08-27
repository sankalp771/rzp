// Flat ESLint config shared by every workspace package.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.db'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts (demo/ops tooling) outside the TS packages.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },
  {
    rules: {
      // Unused args prefixed with _ are intentional (e.g. fastify handlers).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
);
