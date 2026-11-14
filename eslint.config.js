import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', '.tools/**', '.superpowers/**', 'drizzle/meta/**', 'playwright-report/**', 'test-results/**'] },
  { files: ['tests/{image,compose,release}/**/*.mjs','deploy/release/*.mjs'],languageOptions: { globals: { process: 'readonly',URL: 'readonly',Response: 'readonly',Headers: 'readonly',AbortController: 'readonly',AbortSignal: 'readonly',Buffer: 'readonly',setInterval: 'readonly',clearInterval: 'readonly',setTimeout: 'readonly',console: 'readonly',fetch: 'readonly' } } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
