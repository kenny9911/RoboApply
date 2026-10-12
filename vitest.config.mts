import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// .mts extension (not .ts) — `@vitejs/plugin-react` is ESM-only and the
// default CJS config-loader breaks on it. This was the same workaround
// landed on the prior seeker-app workspace.
const root = fileURLToPath(new URL('./', import.meta.url));

export default defineConfig({
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'react' },
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
    // Tests never talk to a real database. A local .env carries live Neon URLs,
    // and a lazily imported Prisma client can slip past a factory mock (two
    // concurrent dynamic imports), so pin both URLs to CI's closed-port
    // placeholder: a stray query fails fast instead of reaching a real pool.
    env: {
      DATABASE_URL: 'postgresql://ci@127.0.0.1:1/ci',
      DIRECT_DATABASE_URL: 'postgresql://ci@127.0.0.1:1/ci',
    },
    setupFiles: ['./__tests__/setup.ts'],
    include: [
      '__tests__/**/*.test.ts',
      '__tests__/**/*.test.tsx',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    // '**/node_modules/**' (not 'node_modules/**'): the interview-agent
    // sub-package carries its own node_modules whose shipped *.test.ts files
    // the bare pattern doesn't exclude — the sweep then fails on third-party
    // snapshots. interview-agent's own sources are excluded too: they target
    // the worker's nodenext/ESM world, not this jsdom config.
    // Vitest 5 also discovers hidden directories. Nested agent worktrees are
    // separate checkouts whose tests must use their own source and config.
    // The extension package (extension/, WP-55b) runs its own vitest:
    // `npm --prefix extension test`.
    exclude: ['**/node_modules/**', '**/.claude/**', '**/.codex/**', '.next/**', 'dist/**', 'interview-agent/**', 'extension/**'],
  },
});
