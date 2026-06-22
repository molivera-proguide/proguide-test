import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

// Phase 0 surfaced real defects (undeclared names, unreachable code, accidental
// globals) as warnings during the refactor. Phase 5 promotes the now-clean rules
// to errors so regressions block CI; underscore-prefixed names stay intentional
// and empty catches remain a sanctioned best-effort idiom.
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
      // Dead code blocks CI now that the tree is clean; underscore-prefixed names
      // are intentional opt-outs.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Empty catch blocks are a deliberate "best effort" idiom across the codebase.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `while (true)` polling loops are intentional.
      'no-constant-condition': ['error', { checkLoops: false }],
      // Dead `let x = <init>` before a try/catch that always reassigns is now removed.
      'no-useless-assignment': 'error',
      // Re-thrown wrapper errors must chain the original via `{ cause }`.
      'preserve-caught-error': 'error'
    }
  },
  // Disable rules that conflict with Prettier formatting.
  prettier
];
