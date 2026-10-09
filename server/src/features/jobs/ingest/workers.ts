// server/src/features/jobs/ingest/workers.ts — STUB (FND-3). Owner: WP-16b.
//
// Queue workers for this area. server/src/platform/queue/registry.ts (FND-5) imports
// `workers` from every area and registers them. The list is empty until the owner
// adds handlers, so items of these kinds stay `queued` (never leased) until then.
// Kinds this area will handle:
//   - 'ingest.query': one planned provider query (fetch → normalize → upsert).

import type { WorkerDefinition } from '../../../platform/queue/index.js';

export const JOBS_INGEST_WORK_KINDS = { ingestQuery: 'ingest.query' } as const;

export const workers: WorkerDefinition[] = [];
