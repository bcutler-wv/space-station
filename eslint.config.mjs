import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo', '.cache/**', 'test-results/**', 'design/**', 'packages/search/src/generated-parser.js', 'packages/search/src/generated-parser.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: { console: 'readonly', process: 'readonly' } } },
  { files: ['tests/integration/mail-parser.mjs'], languageOptions: { globals: { Buffer: 'readonly', fetch: 'readonly', console: 'readonly', process: 'readonly', setTimeout: 'readonly', Response: 'readonly', ReadableStream: 'readonly', Uint8Array: 'readonly', URL: 'readonly', AbortController: 'readonly' } } },
  { files: ['tests/integration/mail-sanitize.mjs'], languageOptions: { globals: { Buffer: 'readonly', console: 'readonly', setTimeout: 'readonly' } } },
  { files: ['tests/integration/node-version.mjs'], languageOptions: { globals: { process: 'readonly' } } },
  { files: ['tests/integration/meili-contract.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly' } } },
  { files: ['tests/fixtures/mail-child.mjs'], languageOptions: { globals: { Buffer: 'readonly', process: 'readonly', setInterval: 'readonly' } } },
);
