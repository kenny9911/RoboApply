import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// The evaluation harness of the match area (server/src/features/match/eval;
// MARKET_STRATEGY.md 2.6). Run through `npm run eval:match`, never by
// `npm test`: the default config collects **/*.test.ts, this one collects
// only eval/**/*.eval.ts. The invariant specs are written against the target
// contract and fail on purpose until the phase that builds it has merged; a
// later bundle puts the invariants of finished phases into `npm test` through
// a *.test.ts file.
//
// Same aliases and the same closed-port database URLs as vitest.config.mts.
// No jsdom and no React setup: these specs are server-only.
const root = fileURLToPath(new URL('./', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(root),
      '@/components': resolve(root, 'components'),
      '@/lib': resolve(root, 'lib'),
      '@/app': resolve(root, 'app'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    // Never a real database: a stray query fails fast on a closed port.
    env: {
      DATABASE_URL: 'postgresql://ci@127.0.0.1:1/ci',
      DIRECT_DATABASE_URL: 'postgresql://ci@127.0.0.1:1/ci',
      FILE_LOGGING: 'false',
      LOG_LEVEL: 'ERROR',
    },
    // No network either: fetch throws "network is off in eval" (offline.ts).
    setupFiles: ['./server/src/features/match/eval/offline.setup.ts'],
    include: ['server/src/features/match/eval/**/*.eval.ts'],
    // invariants.eval.ts is the library the entry file calls; it declares no case at import.
    exclude: ['**/node_modules/**', '**/.claude/**', '**/.codex/**', 'server/src/features/match/eval/invariants.eval.ts'],
    passWithNoTests: false,
  },
});
