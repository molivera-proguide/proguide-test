import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

// Phase 0 baseline: catch real defects (undeclared names, unreachable code,
// accidental globals) without forcing a stylistic rewrite of the existing
// codebase. Stricter rules (complexity, max-lines) are introduced in Phase 5.
export default [
  {
    ignores: [
      'node_modules/**',
      'proguide_tests/**',
      'test-results/**',
      'playwright-report/**',
      '**/*.tgz'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2023
      }
    },
    rules: {
      // Unused code is worth surfacing during a refactor, but as warnings so it
      // never blocks the suite; underscore-prefixed names are intentional.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // The codebase uses empty catch blocks as a deliberate "best effort" idiom.
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // `while (true)` polling loops are intentional.
      'no-constant-condition': ['error', { checkLoops: false }],
      // Defensive `let x = ''` then reassign-in-try with `catch { continue }` is
      // an intentional idiom here; surface it but do not block.
      'no-useless-assignment': 'warn',
      // Adding `{ cause }` to re-thrown errors changes runtime error payloads;
      // defer to Phase 5 rather than altering behavior during the safety-net step.
      'preserve-caught-error': 'warn'
    }
  },
  // Disable rules that conflict with Prettier formatting.
  prettier
];
