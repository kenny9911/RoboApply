// server/src/features/cn/jobs/workers.ts — STUB (FND-3). Owner: WP-41.
//
// Queue workers for this area. server/src/platform/queue/registry.ts (FND-5) imports
// `workers` from every area and registers them. The list is empty until the owner
// adds handlers, so items of these kinds stay `queued` (never leased) until then.
// Kinds this area will handle:
//   - 'cn.jobs.fraudCheck': GoApply anti-fraud classification of one job (培训贷/招转培, CN-E-08).

import type { WorkerDefinition } from '../../../platform/queue/index.js';

export const CN_JOBS_WORK_KINDS = { fraudCheck: 'cn.jobs.fraudCheck' } as const;

export const workers: WorkerDefinition[] = [];
