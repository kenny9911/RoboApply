// server/src/features/push/workers.ts — STUB (FND-3). Owner: WP-61.
//
// Queue workers for this area. server/src/platform/queue/registry.ts (FND-5) imports
// `workers` from every area and registers them. The list is empty until the owner
// adds handlers, so items of these kinds stay `queued` (never leased) until then.
// Kinds this area will handle:
//   - 'push.send': deliver one web-push notification (RoboApply only).

import type { WorkerDefinition } from '../../platform/queue/index.js';

export const PUSH_WORK_KINDS = { pushSend: 'push.send' } as const;

export const workers: WorkerDefinition[] = [];
