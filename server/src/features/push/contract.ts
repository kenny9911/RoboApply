// server/src/features/push/contract.ts
//
// Web push (RoboApply; ARCHITECTURE.md §8.4; TASK_PLAN.md WP-61). Mount:
// /api/v1/roboapply/push, capability `webPush` per route. Opt-in only after
// a user action ("Get alerts on this device"); failed endpoints are pruned.

import { z } from 'zod';

export interface VapidKeyResponse {
  publicKey: string;
}

/** PushSubscription.toJSON() shape. */
export const CreatePushSubscriptionBodySchema = z
  .object({
    endpoint: z.string().url().max(2000),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }).strict(),
    userAgent: z.string().max(400).optional(),
  })
  .strict();
export interface PushSubscriptionView {
  id: string;
  userAgent: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
}
export const PushSubscriptionParamsSchema = z.object({ id: z.string().min(1).max(64) });

export const PUSH_ERROR_CODES = {
  vapidUnset: 'push_not_configured',
} as const;
