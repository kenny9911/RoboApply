// server/src/features/compliance/workers.ts — STUB (FND-3). Owner: WP-13.
//
// Queue workers for this area. server/src/platform/queue/registry.ts (FND-5) imports
// `workers` from every area and registers them. The list is empty until the owner
// adds handlers, so items of these kinds stay `queued` (never leased) until then.
// Kinds this area will handle:
//   - 'compliance.export': build a personal-data export.
//   - 'compliance.purge': one retention purge batch (e.g. after a withdrawn cross-border consent).

import type { WorkerDefinition } from '../../platform/queue/index.js';

export const COMPLIANCE_WORK_KINDS = { dataExport: 'compliance.export', retentionPurge: 'compliance.purge' } as const;

export const workers: WorkerDefinition[] = [];
