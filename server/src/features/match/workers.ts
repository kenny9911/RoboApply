// server/src/features/match/workers.ts — STUB (FND-3). Owner: WP-18.
//
// Queue workers for this area. server/src/platform/queue/registry.ts (FND-5) imports
// `workers` from every area and registers them. The list is empty until the owner
// adds handlers, so items of these kinds stay `queued` (never leased) until then.
// Kinds this area will handle:
//   - 'job.score': AI score for one (user, job) pair (ARCH §4.7).

import type { WorkerDefinition } from '../../platform/queue/index.js';

export const MATCH_WORK_KINDS = { jobScore: 'job.score' } as const;

export const workers: WorkerDefinition[] = [];
