// server/src/features/visitor/contract.ts
//
// Visitor surfaces (TASK_PLAN.md WP-78). Mounts (public):
//   /api/v1/public/copilot  — visitor assistant (capability `visitorAssistant`,
//                             default off); 10/h + 30/day per IP; page-scoped
//                             public tools only; no persistence; SSE.
//   /api/v1/public/alerts   — logged-out job alerts with double opt-in
//                             (capability `jobs.alerts`); one-click unsubscribe.
// The public feed (/api/v1/public/feed) is feed/publicRoutes.ts, also WP-78's.

import { z } from 'zod';
import { AnonAlertFiltersSchema } from '../alerts/contract.js';

export { VisitorTurnBodySchema } from '../copilot/contract.js';
export type { VisitorTurnInput } from '../copilot/contract.js';

/** POST /api/v1/public/alerts — creates an unconfirmed subscription and emails a confirm link (double opt-in). */
export const CreateAnonAlertBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    filters: AnonAlertFiltersSchema,
    frequency: z.enum(['daily', 'weekly']).default('weekly'),
    locale: z.string().max(8),
    /** The visitor ticked the (unchecked by default) consent line. */
    consent: z.literal(true),
  })
  .strict();
/** Always 202 — no enumeration of existing subscriptions. */
export interface CreateAnonAlertResponse {
  status: 'pending_confirmation';
}

/** GET /api/v1/public/alerts/confirm?token= (RAAuthToken kind anon_alert_confirm). */
export const AnonAlertTokenQuerySchema = z.object({ token: z.string().min(16).max(512) });
/** POST /api/v1/public/alerts/unsubscribe { token } — one click. */
export const AnonAlertUnsubscribeBodySchema = z.object({ token: z.string().min(16).max(1024) }).strict();

export const VISITOR_LIMITS = {
  copilotPerIpPerHour: 10,
  copilotPerIpPerDay: 30,
  alertSignupsPerIpPerDay: 5,
} as const;
