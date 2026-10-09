// server/src/features/admin/contract.ts
//
// Admin console additions (TASK_PLAN.md WP-74; ARCHITECTURE.md §3.9).
// Mount: /api/v1/roboapply/admin (admin only) with sub-paths /system,
// /reports, /overrides, /copilot-feedback. Area-specific admin routers are
// mounted at /admin/<area> by their owners (credits, compliance, prep,
// coaching, announcements, cn/jobs, cn/campus, auth-cn, career-sources).
// Admin copy avoids the copy-gate bans ("Reports to review", "alert level").

import { z } from 'zod';

const Id = z.string().min(1).max(64);

/** GET /admin/system — platform health: queue depth, dead items, cron runs, provider usage. */
export interface SystemStatusResponse {
  queue: Array<{ kind: string; queued: number; leased: number; dead: number; oldestQueuedAt: string | null }>;
  crons: Array<{ name: string; lastRunAt: string | null; lastOk: boolean | null; lastMs: number | null }>;
  providers: Array<{ provider: string; dayKey: string; calls: number; jobsNew: number; errors: number }>;
  brandsServed: string[];
}
export const QueueListQuerySchema = z.object({ status: z.enum(['queued', 'leased', 'done', 'dead']).optional(), kind: z.string().max(60).optional(), cursor: z.string().max(64).optional() });
export const WorkItemParamsSchema = z.object({ id: Id });

/** Reports to review (job reports from the feed; 3 distinct users close a job). */
export const ReportsQuerySchema = z.object({ status: z.enum(['open', 'resolved']).optional(), cursor: z.string().max(64).optional() });
export const ReportParamsSchema = z.object({ id: Id });
export const ResolveReportBodySchema = z
  .object({ decision: z.enum(['close_job', 'keep_job', 'flag_fraud']), note: z.string().max(500).optional() })
  .strict();

/** Per-user overrides (flags, buckets, entitlements) — RAEntitlementOverride. */
export const AdminOverridesQuerySchema = z.object({ userId: Id.optional(), key: z.string().max(80).optional(), cursor: z.string().max(64).optional() });
export const AdminCreateOverrideBodySchema = z
  .object({
    userId: Id,
    key: z.string().regex(/^(bucket|entitlement|flag):[A-Za-z0-9_.]+$/),
    value: z.union([z.number().int().min(0).max(10_000), z.boolean(), z.enum(['off', 'deeplinks_only', 'on'])]),
    expiresAt: z.iso.datetime().optional(),
    reason: z.string().trim().min(1).max(300),
  })
  .strict();
export const OverrideParamsSchema = z.object({ id: Id });

/** Assistant feedback queue (rows from copilot.listFeedback()). */
export const CopilotFeedbackQuerySchema = z.object({ value: z.enum(['up', 'down']).optional(), cursor: z.string().max(64).optional() });
