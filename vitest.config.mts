import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// .mts extension (not .ts) — `@vitejs/plugin-react` is ESM-only and the
// default CJS config-loader breaks on it. This was the same workaround
// landed on the prior seeker-app workspace.
const root = fileURLToPath(new URL('./', import.meta.url));

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    alias: {
      '@': resolve(root),
      '@/components': resolve(root, 'components'),
      '@/lib': resolve(root, 'lib'),
      '@/app': resolve(root, 'app'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./__tests__/setup.ts'],
    include: [
      '__tests__/**/*.test.ts',
      '__tests__/**/*.test.tsx',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    exclude: ['node_modules/**', '.next/**', 'dist/**'],
  },
});
