// server/src/features/announcements/contract.ts
//
// In-app announcements (ARCHITECTURE.md §8.5; TASK_PLAN.md WP-61). Mounts:
// /api/v1/roboapply/announcements (seeker) and /admin/announcements (admin).
// At most one announcement per view, through the popup budget
// (lib/ui/popupGate.ts; RAUserUiState). Per brand, locale and cohort.
//
// Rules:
//   - An announcement is shown once per person (`RAUserUiState.announcementsSeen`),
//     only between `startsAt` and `endsAt`, only when published (`active`),
//     only to people whose language is in `locales` and who match `cohort`.
//   - "Translated before publish": `active: true` needs content for EVERY
//     locale the brand serves (422 `invalid_request`, reason
//     `translations_missing`, `details.missing` lists them). Drafts may be partial.
//   - Server-side popup budget: `/next` answers null while the person saw a
//     non-essential popup in the last 24 h (`popupLastShownAt`).
//   - Lower `priority` shows first; ties go to the newest `startsAt`.

import { z } from 'zod';

const Id = z.string().min(1).max(64);

/**
 * A same-site path: one leading '/', and no second '/' or '\\' after it
 * (browsers read '/\\host' and '//host' as another site). Same rule as push's
 * `safeHref`; WhatsNew applies it again before rendering an internal link.
 */
export const INTERNAL_HREF_RE = /^\/(?![\/\\])[^\\]*$/;
/** An announcement link: a same-site path or an https URL. */
export const ANNOUNCEMENT_HREF_RE = /^\/(?![\/\\])[^\\]*$|^https:\/\/[^\\]+$/;

export function isInternalHref(href: string | null | undefined): href is string {
  return typeof href === 'string' && INTERNAL_HREF_RE.test(href);
}

/** `RAAnnouncement.content` (documented JSON column): `{ [locale]: { title, body, ctaLabel?, ctaHref? } }` */
export const AnnouncementLocaleContentSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(2000),
    ctaLabel: z.string().trim().max(40).optional(),
    ctaHref: z.string().max(500).regex(ANNOUNCEMENT_HREF_RE).optional(),
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
/** GET /announcements/next?locale= — the UI language (clamped to the brand; default: the brand's). */
export const NextAnnouncementQuerySchema = z.object({ locale: z.string().max(8).optional() });
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
    priority: z.number().int().min(0).max(1000).optional(),
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
    priority: z.number().int().min(0).max(1000).optional(),
    active: z.boolean().optional(),
  })
  .strict();
export const AdminAnnouncementsQuerySchema = z.object({ brand: z.enum(['roboapply', 'goapply']).optional(), active: z.enum(['true', 'false']).optional() });

export type AnnouncementLocaleContent = z.infer<typeof AnnouncementLocaleContentSchema>;
export type AnnouncementContent = z.infer<typeof AnnouncementContentSchema>;
export type AnnouncementCohort = z.infer<typeof AnnouncementCohortSchema>;

/** One announcement as the admin console sees it (GET/POST/PATCH /admin/announcements). */
export interface AdminAnnouncementView {
  id: string;
  key: string;
  brand: 'roboapply' | 'goapply';
  locales: string[];
  content: AnnouncementContent;
  cohort: AnnouncementCohort;
  priority: number;
  startsAt: string;
  endsAt: string;
  active: boolean;
  createdAt: string;
  /** Brand locales without content; publishing needs this to be empty. */
  missingLocales: string[];
  /** 'draft' | 'scheduled' | 'live' | 'ended' at the time of the response. */
  status: AnnouncementStatus;
}
export type AnnouncementStatus = 'draft' | 'scheduled' | 'live' | 'ended';

/** `details.reason` of this area's 422/409 answers. */
export const ANNOUNCEMENT_ERROR_REASONS = {
  translationsMissing: 'translations_missing',
  localeNotServed: 'locale_not_served',
  keyTaken: 'key_taken',
  invalidWindow: 'invalid_window',
  unknownFlag: 'unknown_flag',
} as const;

/** Without dates an announcement runs from now for this many days. */
export const ANNOUNCEMENT_DEFAULT_DAYS = 30;
/** `priority` when none is given (`RAAnnouncement.priority @default(100)`). */
export const ANNOUNCEMENT_DEFAULT_PRIORITY = 100;
/** Server-side popup budget (mirrors lib/ui/popupGate.ts POPUP_GAP_MS). */
export const ANNOUNCEMENT_POPUP_GAP_MS = 24 * 60 * 60 * 1000;
