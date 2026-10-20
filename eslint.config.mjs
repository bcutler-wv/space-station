import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo', '.cache/**', 'test-results/**', 'design/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: { console: 'readonly', process: 'readonly' } } },
  { files: ['tests/integration/mail-parser.mjs'], languageOptions: { globals: { Buffer: 'readonly', fetch: 'readonly', console: 'readonly', process: 'readonly', setTimeout: 'readonly', Response: 'readonly', ReadableStream: 'readonly', Uint8Array: 'readonly', URL: 'readonly', AbortController: 'readonly' } } },
  { files: ['tests/fixtures/mail-child.mjs'], languageOptions: { globals: { Buffer: 'readonly', process: 'readonly', setInterval: 'readonly' } } },
);
