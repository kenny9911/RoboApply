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
  /** Path segment of `/campus/[company]` (see `campusCompanySlug`). */
  companySlug: string;
  title: string;
  graduationClass: string;
  kind: (typeof CAMPUS_EVENT_KINDS)[number];
  /** 网申 window, only as the official page states it (null = not stated; render "未公布" / "Not listed"). */
  applyOpensAt: string | null;
  applyClosesAt: string | null;
  stages: Array<z.infer<typeof CampusStageSchema>>;
  cities: string[];
  roles: string[];
  officialUrl: string;
  /** Where the details were read when not the official page itself (never an aggregator). */
  sourceUrl: string | null;
  sourceName: string | null;
  verifiedAt: string;
  /** True when older than CAMPUS_REVERIFY_DAYS since verification ("待核实"). */
  needsReverify: boolean;
  subscribed: boolean;
}

/** One page of programmes. `asOf` = when the list was read (WP-31 dates its count with it). */
export interface CampusEventList {
  items: CampusEventView[];
  /** Opaque; null on the last page. */
  cursor: string | null;
  asOf: string;
}

/** `GET /api/v1/public/campus/companies/:slug` — one company's published programmes. */
export interface CampusCompanyResponse extends CampusEventList {
  companyName: string;
  companySlug: string;
}

/** Programmes per page (list routes). */
export const CAMPUS_PAGE_SIZE = 30;
/** 网申截止 reminders go out this many days before the close (F-NOTIF-08 cn). */
export const CAMPUS_REMINDER_DAYS = [3, 1] as const;
/** Follow-a-company notices are produced for programmes verified within this many days. */
export const CAMPUS_FOLLOW_WINDOW_DAYS = 7;
/** Display time zone of every 网申 date (the official pages state Beijing time). */
export const CAMPUS_TIME_ZONE = 'Asia/Shanghai';

/**
 * Hosts that aggregate other employers' campus programmes. D3 / WP-58: the
 * calendar takes facts only from the employer's own page, so these are refused
 * as an official URL or a source URL (in addition to the job-board denylist of
 * the import area). Patterns: `host` matches the host and its subdomains;
 * `name.*` matches any country suffix.
 */
export const CAMPUS_AGGREGATOR_HOSTS = [
  'yingjiesheng.com',
  'yingjiesheng.net',
  'nowcoder.com',
  'shixiseng.com',
  'haitou.cc',
  'dajie.com',
  'iguopin.com',
  'ncss.cn',
  '91job.com',
  'jobui.com',
  'kanzhun.com',
  'offershow.cn',
  'wondercv.com',
  'zhipin.com',
  'zhaopin.com',
  'liepin.com',
  '51job.com',
  'maimai.cn',
  'lagou.com',
  'linkedin.com',
  'indeed.*',
  'glassdoor.*',
] as const;
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
/**
 * The draft fields once, with no defaults. Zod keeps an inner `.default()`
 * through `.partial()`, so the draft and the patch schema are built from this
 * base separately: a partial edit must never write a default over a stored value.
 */
const CampusEventFieldsSchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  companyId: Id.optional(),
  title: z.string().trim().min(1).max(200),
  graduationClass: z.string().regex(/^20(2[5-9]|30)届$/),
  kind: z.enum(CAMPUS_EVENT_KINDS),
  applyOpensAt: z.iso.datetime().optional(),
  applyClosesAt: z.iso.datetime().optional(),
  stages: CampusStagesSchema,
  cities: z.array(z.string().max(40)).max(50),
  roles: z.array(z.string().max(80)).max(50),
  officialUrl: z.string().url().max(2000),
  sourceUrl: z.string().url().max(2000).optional(),
  sourceName: z.string().max(120).optional(),
  sourceNote: z.string().max(500).optional(),
});
export const CampusEventDraftBodySchema = CampusEventFieldsSchema.extend({
  kind: z.enum(CAMPUS_EVENT_KINDS).default('application'),
  stages: CampusStagesSchema.default([]),
  cities: z.array(z.string().max(40)).max(50).default([]),
  roles: z.array(z.string().max(80)).max(50).default([]),
}).strict();
/** Edit: any draft field; `null` clears a date or an optional source field. Omitted fields are left as stored. */
export const PatchCampusEventBodySchema = CampusEventFieldsSchema.partial()
  .extend({
    companyId: Id.nullable().optional(),
    applyOpensAt: z.iso.datetime().nullable().optional(),
    applyClosesAt: z.iso.datetime().nullable().optional(),
    sourceUrl: z.string().url().max(2000).nullable().optional(),
    sourceName: z.string().max(120).nullable().optional(),
    sourceNote: z.string().max(500).nullable().optional(),
  })
  .strict();

/** `details.reason` values of the area's 4xx answers (clients localize by reason). */
export const CAMPUS_ERROR_CODES = {
  notVerified: 'campus_event_not_verified',
  officialUrlRequired: 'official_url_required',
  /** The URL is a campus aggregator or a job board (never a source). */
  aggregatorSource: 'aggregator_source',
  /** Not an http(s) address on a public web host. */
  notAWebAddress: 'not_a_web_address',
  /** The single-page fetch failed (status, size, type, timeout, private address). */
  pageUnreachable: 'page_unreachable',
  /** Close date before open date. */
  windowInverted: 'apply_window_inverted',
  /** Reminders need a stated close date that is still ahead. */
  eventClosed: 'campus_event_closed',
  noCloseDate: 'campus_event_no_close_date',
} as const;
export type CampusErrorReason = (typeof CAMPUS_ERROR_CODES)[keyof typeof CAMPUS_ERROR_CODES];

/** A deadline reminder or a followed company (GET/POST /subscriptions). */
export interface CampusSubscriptionView {
  id: string;
  kind: 'event' | 'company';
  eventId: string | null;
  /** kind 'company': the followed company as the user typed it (normalized for matching). */
  companyName: string | null;
  graduationClass: string | null;
  channel: 'in_app' | 'email' | 'wechat';
  createdAt: string;
  /** kind 'event': the programme (null once it is no longer published). */
  event: CampusEventView | null;
}

export interface CampusSubscriptionList {
  items: CampusSubscriptionView[];
}

// ── Admin views ──

export interface AdminCampusEventView extends Omit<CampusEventView, 'verifiedAt' | 'subscribed'> {
  status: (typeof CAMPUS_EVENT_STATUSES)[number];
  companyId: string | null;
  sourceNote: string | null;
  /** Null until a staff member checked the entry against the official page. */
  verifiedAt: string | null;
  verifiedByUserId: string | null;
  /** Display label of the verifier (name or email), when known. */
  verifiedByName: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminCampusEventList {
  items: AdminCampusEventView[];
  cursor: string | null;
}

/** Fields the extractor may propose (a subset of the draft body). */
export const CAMPUS_EXTRACT_FIELDS = [
  'companyName',
  'title',
  'graduationClass',
  'kind',
  'applyOpensAt',
  'applyClosesAt',
  'stages',
  'cities',
  'roles',
  'sourceName',
] as const;
export type CampusExtractField = (typeof CAMPUS_EXTRACT_FIELDS)[number];

/**
 * `POST /admin/cn/campus/events/extract` — a proposal, never a saved row.
 * Every date is backed by a quote found on the fetched page; a date whose
 * quote is not on the page is dropped (`dropped`), never guessed.
 */
export interface CampusExtractResponse {
  draft: Partial<z.infer<typeof CampusEventDraftBodySchema>> & { officialUrl: string };
  /** Field → the sentence on the page it rests on. */
  evidence: Partial<Record<CampusExtractField, string>>;
  /** Fields the model proposed but whose quote is not on the page. */
  dropped: CampusExtractField[];
  /** The page's <title>, when it has one. */
  pageTitle: string | null;
  fetchedAt: string;
  /** The final URL after redirects (each hop passed the same checks). */
  finalUrl: string;
  /** Always true: the proposal is AI output and must be checked by a person. */
  aiGenerated: true;
  model: string;
}

export interface AdminCampusDeleteResponse {
  id: string;
  /** Drafts are removed; anything that was published is archived (subscriptions keep their history). */
  result: 'deleted' | 'archived';
}

/** Normalized key of a company name for follow matching (NFKC, trimmed, single spaces, lower case). */
export function normalizeCampusCompany(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** `/campus/[company]` segment for a company name (spaces → '-'). Encode it with encodeURIComponent in links. */
export function campusCompanySlug(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, '-');
}
