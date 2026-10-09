// server/src/features/jobs/ingest/workers.ts — queue workers of the inventory pipeline (WP-16b).
//
// server/src/platform/queue/registry.ts (FND-5) imports `workers` and registers them.
//   - 'ingest.query': one planned provider query that targeted ingest
//     (`ingestForProfile`) could not fit in its budget. The worker leases the
//     query by id (only while it is still due, so a cron tick that already
//     ran it makes this a no-op) and runs it inside the item's brand.

import prisma from '../../../lib/prisma.js';
import { getCurrentBrandOrDefault } from '../../../platform/brand/index.js';
import { PermanentWorkError, type WorkerDefinition } from '../../../platform/queue/index.js';
import { adaptersForBrand } from './providers.js';
import { runIngestTick } from './run.js';
import { ingestAllowed } from './cron.js';

export const JOBS_INGEST_WORK_KINDS = { ingestQuery: 'ingest.query' } as const;

export const workers: WorkerDefinition[] = [
  {
    kind: JOBS_INGEST_WORK_KINDS.ingestQuery,
    concurrency: 2,
    async handler(item, ctx) {
      const payload = (item.payload ?? {}) as { queryId?: unknown };
      if (typeof payload.queryId !== 'string' || !payload.queryId) throw new PermanentWorkError('ingest.query: payload.queryId missing');
      const brand = getCurrentBrandOrDefault();
      if (!ingestAllowed(brand)) return;
      await runIngestTick({
        db: prisma,
        brand,
        adapters: adaptersForBrand(brand),
        budgetMs: Math.min(60_000, ctx.budget.remainingMs()),
        queryIds: [payload.queryId],
      });
    },
  },
];
