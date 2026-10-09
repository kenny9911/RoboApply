// server/src/features/jobs/enrich/workers.ts — STUB (FND-3). Owner: WP-17.
//
// Queue workers for this area. server/src/platform/queue/registry.ts (FND-5) imports
// `workers` from every area and registers them. The list is empty until the owner
// adds handlers, so items of these kinds stay `queued` (never leased) until then.
// Kinds this area will handle:
//   - 'job.enrich': LLM-light enrichment of one job (ARCH §4.5).

import type { WorkerDefinition } from '../../../platform/queue/index.js';

export const JOBS_ENRICH_WORK_KINDS = { jobEnrich: 'job.enrich' } as const;

export const workers: WorkerDefinition[] = [];
