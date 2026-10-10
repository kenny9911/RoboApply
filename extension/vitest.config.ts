// extension/vitest.config.ts — the extension's own unit tests (jsdom).
// The root vitest config excludes extension/**; run `npm --prefix extension test`.
// Playwright e2e specs (test/e2e) run with `npm --prefix extension run e2e`.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'react' },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['**/node_modules/**', 'dist/**', 'test/e2e/**'],
  },
});
