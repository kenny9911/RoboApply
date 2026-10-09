// server/src/features/jobs/enrich/workers.ts — queue workers for enrichment (WP-17).
//
// server/src/platform/queue/registry.ts (FND-5) imports `workers` from every
// area and registers them; `queue-drain` (every 5 minutes) and the
// `waitUntil` kick after an ingest tick run them (ARCHITECTURE.md §4.5–4.6).
// Kinds:
//   - 'job.enrich': one structured enrichment of one job (service.ts).
// Concurrency 10 per drain batch (ARCH §4.5). Idempotent: the producer's
// dedupe key is `job.enrich:<jobId>:v<ENRICH_VERSION>` and a row already
// enriched at that version is skipped (`force: true` re-runs a changed job).

import { DeferWorkError, PermanentWorkError, type WorkerDefinition } from '../../../platform/queue/index.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { enrichJob, defaultEnrichDeps, type EnrichDeps } from './service.js';
import { EnrichPayloadSchema } from './schema.js';

export const JOBS_ENRICH_WORK_KINDS = { jobEnrich: 'job.enrich' } as const;

/** Jobs enriched in parallel within one drain batch (ARCH §4.5). */
export const ENRICH_CONCURRENCY = 10;

let depsOverride: EnrichDeps | null = null;

/** Test seam: replace the worker's dependencies (null restores the defaults). */
export function setEnrichDepsForTests(deps: EnrichDeps | null): void {
  depsOverride = deps;
}

export const jobEnrichWorker: WorkerDefinition<Prisma.JsonValue> = {
  kind: JOBS_ENRICH_WORK_KINDS.jobEnrich,
  concurrency: ENRICH_CONCURRENCY,
  handler: async (item) => {
    const parsed = EnrichPayloadSchema.safeParse(item.payload);
    if (!parsed.success) throw new PermanentWorkError(`job.enrich: invalid payload (${parsed.error.issues[0]?.message ?? 'unknown'})`);
    const outcome = await enrichJob(
      parsed.data,
      { attempt: item.attempts, maxAttempts: item.maxAttempts, requestId: `job-enrich-${item.id}` },
      depsOverride ?? defaultEnrichDeps(),
    );
    if (outcome.status === 'deferred') throw new DeferWorkError(outcome.retryAfterMs, 'enrichment budget reached');
  },
};

export const workers: WorkerDefinition[] = [jobEnrichWorker];
