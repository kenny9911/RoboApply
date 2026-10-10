// server/src/features/jobs/sources/atsPublic/contract.ts
//
// Public ATS job-board sources (TASK_PLAN.md WP-42; TW-02): ops-curated
// `RACareerSiteSource` rows read through the boards' public posting APIs
// (Greenhouse `boards-api…/jobs?content=true`, Lever `?mode=json`, Ashby
// posting API, SmartRecruiters postings). No Workday scraping. Admin mount:
// /api/v1/roboapply/admin/career-sources.
//
// Both brands (GOAPPLY_PARITY_PLAN.md §3.9): a source belongs to one market
// (`market`), the market of the brand whose admin added it, and feeds that
// brand with the board's postings located in that market (mainland China →
// cn, anything else → intl). An admin sees and changes the sources of the
// brand they are signed in to; `market` in a request may only name that
// market (it defaults to it).

import { z } from 'zod';

export const PUBLIC_ATS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'] as const;
export type PublicAts = (typeof PUBLIC_ATS)[number];

export const CareerSourceBodySchema = z
  .object({
    /** Optional: the market of the brand the admin is on (the default). Naming the other market is refused. */
    market: z.enum(['intl', 'cn']).optional(),
    ats: z.enum(PUBLIC_ATS),
    boardToken: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,120}$/),
    companyName: z.string().trim().min(1).max(200),
    companyId: z.string().min(1).max(64).optional(),
    countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export const PatchCareerSourceBodySchema = z
  .object({
    companyName: z.string().trim().min(1).max(200).optional(),
    companyId: z.string().min(1).max(64).nullable().optional(),
    countryCode: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export const CareerSourceParamsSchema = z.object({ id: z.string().min(1).max(64) });
export const ListCareerSourcesQuerySchema = z.object({ market: z.enum(['intl', 'cn']).optional(), enabled: z.enum(['true', 'false']).optional() });

export interface CareerSourceView {
  id: string;
  market: 'intl' | 'cn';
  ats: PublicAts;
  boardToken: string;
  companyName: string;
  companyId: string | null;
  countryCode: string | null;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastJobCount: number | null;
  lastError: string | null;
}

/** Display names of the public job-board systems (data, never bundle copy). */
export const PUBLIC_ATS_NAMES: Readonly<Record<PublicAts, string>> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  smartrecruiters: 'SmartRecruiters',
};

/**
 * `POST /:id/run` ("Check now"): the board is read once to report what it
 * lists (or why it cannot be read); when it can, the source is marked due and
 * ingest's standing `ats_public` query is queued to run now, so the postings
 * go through the same normalize → save path as the scheduled run.
 */
export interface CareerSourceRunResult {
  sourceId: string;
  /** 'scheduled': the board was read and the import is queued or waits for the next run; 'error': it could not be read. */
  status: 'scheduled' | 'error';
  /** Postings the board lists right now. */
  listed: number;
  /** True when the import was queued to run now; false = it runs at the next scheduled ingest. */
  queued: boolean;
  error: string | null;
}

// ── Taiwan card meta (marketHooks.cardMeta → `meta.ats_public`) ──────────

/** Work-authorization tags for Taiwan, each shown only with a quote from the posting (TW-09). */
export const TW_PERMIT_TAGS = ['tw_work_permit_support', 'tw_gold_card'] as const;
export type TwPermitTag = (typeof TW_PERMIT_TAGS)[number];

export interface TwPermitTagView {
  tag: TwPermitTag;
  /** Verbatim sentence from the posting (≤ 240 characters). */
  quote: string;
}

/**
 * `cardMeta(job).ats_public` for jobs in Taiwan (JobMetaTw). Pay is only ever
 * the posting's own text: `negotiable` means the posting says 面議 / 依公司規定
 * and gives no figure; nothing here estimates or implies an amount (TW-03).
 */
export interface TwCardMeta {
  country: 'TW';
  pay: {
    /**
     * The pay text for cards: as posted, except that for a 面議 posting the
     * Employment Services Act Art. 5 floor clause ("經常性薪資達4萬元或以上")
     * is removed, because it is the legal rule, not this job's pay. Null when
     * the posting gives no pay text.
     */
    text: string | null;
    /** The pay text exactly as posted (shown on the job page as the posting's own words), or null. */
    posted: string | null;
    /** The posting states an amount or range. */
    disclosed: boolean;
    /** The posting says pay is negotiable / per company rules, with no figure. */
    negotiable: boolean;
  };
  permitTags: TwPermitTagView[];
  source: {
    /** e.g. "Appier · Greenhouse" (company + job board). */
    name: string | null;
    url: string | null;
    board: PublicAts | null;
  };
}
