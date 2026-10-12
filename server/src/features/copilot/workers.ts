// server/src/features/copilot/workers.ts — queue workers for the Assistant (WP-50).
//
// server/src/platform/queue/registry.ts (FND-5) imports `workers` from every
// area and registers them. The drain runs each item inside
// runWithBrand(item.brand).
//   - 'copilot.summary': rolling summary of one Assistant thread (summary.ts).

import type { WorkerDefinition } from '../../platform/queue/index.js';

export const COPILOT_WORK_KINDS = { copilotSummary: 'copilot.summary' } as const;

export const workers: WorkerDefinition[] = [
  {
    kind: COPILOT_WORK_KINDS.copilotSummary,
    concurrency: 2,
    async handler(item) {
      const threadId = (item.payload as { threadId?: unknown } | null)?.threadId;
      if (typeof threadId !== 'string' || !threadId) return;
      const [{ runThreadSummary }, { defaultSummaryDeps }] = await Promise.all([import('./summary.js'), import('./index.js')]);
      await runThreadSummary(threadId, defaultSummaryDeps());
    },
  },
];
