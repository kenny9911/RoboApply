// server/src/features/seo/workers.ts — queue workers of the SEO area (WP-56).
//
// server/src/platform/queue/registry.ts imports `workers` from every area.
// The SEO area has none: `seo-rebuild` (cron.ts) rebuilds every page inside
// its own 240 s budget, most jobs first, and picks up where the inventory
// changed on the next daily run. The kind stays reserved for a per-page
// rebuild should a later package need one.

import type { WorkerDefinition } from '../../platform/queue/index.js';

export const SEO_WORK_KINDS = { seoRebuild: 'seo.rebuild' } as const;

export const workers: WorkerDefinition[] = [];
