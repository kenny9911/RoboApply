// server/src/features/extension/workers.ts — STUB (FND-3). Owner: WP-55a.
//
// Queue workers for this area. server/src/platform/queue/registry.ts (FND-5) imports
// `workers` from every area and registers them. The list is empty until the owner
// adds handlers, so items of these kinds stay `queued` (never leased) until then.
// Kinds this area will handle:
//   - 'ext.prepare': prepare files/answers the extension asked for.

import type { WorkerDefinition } from '../../platform/queue/index.js';

export const EXTENSION_WORK_KINDS = { extPrepare: 'ext.prepare' } as const;

export const workers: WorkerDefinition[] = [];
