// server/src/features/jobs/sources/atsPublic/contract.ts
//
// Public ATS job-board sources (TASK_PLAN.md WP-42; TW-02): ops-curated
// `RACareerSiteSource` rows read through the boards' public posting APIs
// (Greenhouse `boards-api…/jobs?content=true`, Lever `?mode=json`, Ashby
// posting API, SmartRecruiters postings). No Workday scraping. Admin mount:
// /api/v1/roboapply/admin/career-sources.

import { z } from 'zod';

export const PUBLIC_ATS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'] as const;
export type PublicAts = (typeof PUBLIC_ATS)[number];

export const CareerSourceBodySchema = z
  .object({
    market: z.enum(['intl', 'cn']).default('intl'),
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
