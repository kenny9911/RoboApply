// server/src/features/seo/workers.ts — STUB (FND-3). Owner: WP-56.
//
// Queue workers for this area. server/src/platform/queue/registry.ts (FND-5) imports
// `workers` from every area and registers them. The list is empty until the owner
// adds handlers, so items of these kinds stay `queued` (never leased) until then.
// Kinds this area will handle:
//   - 'seo.rebuild': rebuild one RASeoPage.

import type { WorkerDefinition } from '../../platform/queue/index.js';

export const SEO_WORK_KINDS = { seoRebuild: 'seo.rebuild' } as const;

export const workers: WorkerDefinition[] = [];
