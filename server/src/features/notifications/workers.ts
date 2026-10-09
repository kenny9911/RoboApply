// server/src/features/notifications/workers.ts — STUB (FND-3). Owner: WP-39a.
//
// Queue workers for this area. server/src/platform/queue/registry.ts (FND-5) imports
// `workers` from every area and registers them. The list is empty until the owner
// adds handlers, so items of these kinds stay `queued` (never leased) until then.
// Kinds this area will handle:
//   - 'email.send': deliver one email through platform/email `sendEmail` (payload `EmailSendPayload`).

import type { WorkerDefinition } from '../../platform/queue/index.js';

export const NOTIFICATIONS_WORK_KINDS = { emailSend: 'email.send' } as const;

export const workers: WorkerDefinition[] = [];
