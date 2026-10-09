// server/src/features/support/contract.ts
//
// Support contact form (TASK_PLAN.md WP-40; F-TRUST-07). Mount:
// /api/v1/roboapply/support (optional session; 5/day/IP). Sends to the
// brand's support address through platform/email (SUPPORT_EMAIL /
// CN_SUPPORT_EMAIL); nothing is promised about response times.

import { z } from 'zod';

export const SUPPORT_TOPICS = ['account', 'billing', 'jobs', 'resume', 'practice', 'extension', 'privacy', 'bug', 'other'] as const;

export const SupportContactBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    name: z.string().trim().max(120).optional(),
    topic: z.enum(SUPPORT_TOPICS),
    message: z.string().trim().min(10).max(5000),
    pageUrl: z.string().max(2000).optional(),
    locale: z.string().max(8).optional(),
  })
  .strict();
export interface SupportContactResponse {
  received: true;
}
export const SUPPORT_LIMITS = { perIpPerDay: 5 } as const;
