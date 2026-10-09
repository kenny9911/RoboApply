// server/src/features/announcements/contract.ts
//
// In-app announcements (ARCHITECTURE.md §8.5; TASK_PLAN.md WP-61). Mounts:
// /api/v1/roboapply/announcements (seeker) and /admin/announcements (admin).
// At most one announcement per view, through the popup budget
// (lib/ui/popupGate.ts; RAUserUiState). Per brand, locale and cohort.

import { z } from 'zod';

const Id = z.string().min(1).max(64);

/** `RAAnnouncement.content` (documented JSON column): `{ [locale]: { title, body, ctaLabel?, ctaHref? } }` */
export const AnnouncementLocaleContentSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(2000),
    ctaLabel: z.string().trim().max(40).optional(),
    ctaHref: z.string().max(500).regex(/^\/(?!\/)|^https:\/\//).optional(),
  })
  .strict();
export const AnnouncementContentSchema = z.record(z.string(), AnnouncementLocaleContentSchema);

/** `RAAnnouncement.cohort` (documented JSON column): `{ plans?, signedUpBefore?, flags? }` */
export const AnnouncementCohortSchema = z
  .object({ plans: z.array(z.string()).optional(), signedUpBefore: z.iso.datetime().optional(), flags: z.array(z.string()).optional() })
  .strict();

export interface AnnouncementView {
  id: string;
  key: string;
  title: string;
  body: string;
  ctaLabel: string | null;
  ctaHref: string | null;
}
/** GET /announcements/next → at most one (or null). */
export interface NextAnnouncementResponse {
  announcement: AnnouncementView | null;
}
export const AnnouncementParamsSchema = z.object({ id: Id });

// ── Admin ────────────────────────────────────────────────────────────────

export const UpsertAnnouncementBodySchema = z
  .object({
    key: z.string().regex(/^[a-z0-9_.-]{3,64}$/),
    brand: z.enum(['roboapply', 'goapply']),
    locales: z.array(z.string().max(8)).min(1).max(9),
    content: AnnouncementContentSchema,
    cohort: AnnouncementCohortSchema.default({}),
    startsAt: z.iso.datetime().optional(),
    endsAt: z.iso.datetime().optional(),
    active: z.boolean().default(false),
  })
  .strict();
export const PatchAnnouncementBodySchema = z
  .object({
    locales: z.array(z.string().max(8)).min(1).max(9).optional(),
    content: AnnouncementContentSchema.optional(),
    cohort: AnnouncementCohortSchema.optional(),
    startsAt: z.iso.datetime().nullable().optional(),
    endsAt: z.iso.datetime().nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();
export const AdminAnnouncementsQuerySchema = z.object({ brand: z.enum(['roboapply', 'goapply']).optional(), active: z.enum(['true', 'false']).optional() });
