// server/src/features/copilot/workers.ts — STUB (FND-3). Owner: WP-50.
//
// Queue workers for this area. server/src/platform/queue/registry.ts (FND-5) imports
// `workers` from every area and registers them. The list is empty until the owner
// adds handlers, so items of these kinds stay `queued` (never leased) until then.
// Kinds this area will handle:
//   - 'copilot.summary': rolling summary of one Assistant thread.

import type { WorkerDefinition } from '../../platform/queue/index.js';

export const COPILOT_WORK_KINDS = { copilotSummary: 'copilot.summary' } as const;

export const workers: WorkerDefinition[] = [];
