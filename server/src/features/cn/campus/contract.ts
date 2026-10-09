// server/src/features/cn/campus/contract.ts
//
// GoApply 校招日历 (campus calendar) + admin curation + deadline reminders
// (TASK_PLAN.md R-14, WP-58; CN_TW_LAUNCH_PLAN.md CN-E-08). Mounts:
//   /api/v1/roboapply/cn/campus-events   (S/P; capability `jobs.campusCalendar`)
//   /api/v1/public/campus                (public read API for SEO pages)
//   /api/v1/roboapply/admin/cn/campus    (admin curation)
//
// D3: every event carries the employer's official URL and a human
// verification (`verifiedAt` + `verifiedBy`) before publishing; entries
// older than 14 days without re-verification show "待核实".

import { z } from 'zod';

const Id = z.string().min(1).max(64);
export const CAMPUS_STAGE_KINDS = ['wangshen', 'ceping', 'bishi', 'mianshi', 'offer', 'info_session'] as const;
export const CAMPUS_EVENT_KINDS = ['application', 'test', 'interview', 'info_session'] as const;
export const CAMPUS_EVENT_STATUSES = ['draft', 'published', 'archived'] as const;
/** Days after which an unverified entry shows "待核实". */
export const CAMPUS_REVERIFY_DAYS = 14;

/** `RACampusEvent.stages` (documented JSON column). */
export const CampusStageSchema = z
  .object({ kind: z.enum(CAMPUS_STAGE_KINDS), startsAt: z.string().optional(), endsAt: z.string().optional(), note: z.string().max(300).optional() })
  .strict();
export const CampusStagesSchema = z.array(CampusStageSchema).max(20);

export const ListCampusEventsQuerySchema = z.object({
  /** 届别, e.g. 2027 */
  class: z.coerce.number().int().min(2025).max(2030).optional(),
  company: z.string().trim().max(120).optional(),
  role: z.string().trim().max(80).optional(),
  city: z.string().trim().max(40).optional(),
  openNow: z.enum(['true', 'false']).optional(),
  cursor: z.string().max(64).optional(),
});
export const CampusEventParamsSchema = z.object({ id: Id });
export const CampusCompanyParamsSchema = z.object({ slug: z.string().min(1).max(120) });

export interface CampusEventView {
  id: string;
  companyName: string;
  title: string;
  graduationClass: string;
  kind: (typeof CAMPUS_EVENT_KINDS)[number];
  applyOpensAt: string | null;
  applyClosesAt: string | null;
  stages: Array<z.infer<typeof CampusStageSchema>>;
  cities: string[];
  roles: string[];
  officialUrl: string;
  sourceName: string | null;
  verifiedAt: string;
  /** True when older than CAMPUS_REVERIFY_DAYS since verification ("待核实"). */
  needsReverify: boolean;
  subscribed: boolean;
}

/** Subscriptions: deadline reminders for an event, or follow a company + 届别. */
export const CreateCampusSubscriptionBodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), eventId: Id, channel: z.enum(['in_app', 'email', 'wechat']).default('in_app') }).strict(),
  z
    .object({
      kind: z.literal('company'),
      companyName: z.string().trim().min(1).max(120),
      graduationClass: z.string().regex(/^20(2[5-9]|30)届$/),
      channel: z.enum(['in_app', 'email', 'wechat']).default('in_app'),
    })
    .strict(),
]);
export const CampusSubscriptionParamsSchema = z.object({ id: Id });

// ── Admin curation (paste official URL → extractor proposes → human verifies → publish) ──

export const AdminCampusEventsQuerySchema = z.object({ status: z.enum(CAMPUS_EVENT_STATUSES).optional(), cursor: z.string().max(64).optional() });
export const ExtractCampusEventBodySchema = z.object({ officialUrl: z.string().url().max(2000) }).strict();
export const CampusEventDraftBodySchema = z
  .object({
    companyName: z.string().trim().min(1).max(200),
    companyId: Id.optional(),
    title: z.string().trim().min(1).max(200),
    graduationClass: z.string().regex(/^20(2[5-9]|30)届$/),
    kind: z.enum(CAMPUS_EVENT_KINDS).default('application'),
    applyOpensAt: z.iso.datetime().optional(),
    applyClosesAt: z.iso.datetime().optional(),
    stages: CampusStagesSchema.default([]),
    cities: z.array(z.string().max(40)).max(50).default([]),
    roles: z.array(z.string().max(80)).max(50).default([]),
    officialUrl: z.string().url().max(2000),
    sourceUrl: z.string().url().max(2000).optional(),
    sourceName: z.string().max(120).optional(),
    sourceNote: z.string().max(500).optional(),
  })
  .strict();
export const PatchCampusEventBodySchema = CampusEventDraftBodySchema.partial().strict();

export const CAMPUS_ERROR_CODES = {
  notVerified: 'campus_event_not_verified',
  officialUrlRequired: 'official_url_required',
} as const;
