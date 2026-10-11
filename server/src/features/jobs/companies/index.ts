// server/src/features/jobs/companies/index.ts — public surface (FND-5; filled by WP-16b).
// The Assistant's company_insights tool and job detail use `companyService.profile`;
// ingest uses `upsertCompanies`.

import prisma from '../../../lib/prisma.js';
import { getCurrentBrandOrDefault } from '../../../platform/brand/index.js';
import type { CompanyProfile, CompanyTypeaheadItem } from './contract.js';
import { createCompanyReadService, setIndustryFromPosting, type CompanyReadService, type CompanyReadViewer, type PostingIndustry, type PostingIndustryOutcome } from './service.js';

export * from './contract.js';
export { createCompaniesRouter } from './routes.js';
export type { CompaniesRouterDeps } from './routes.js';
export {
  COMPANY_JOBS_PAGE,
  H1B_DISCLAIMER,
  MAX_POSTING_INDUSTRIES,
  POSTING_INDUSTRY_SOURCE,
  companyKey,
  companyPatch,
  companyJobsOrder,
  companySlug,
  createCompanyReadService,
  escapeLike,
  liveJobWhere,
  setIndustryFromPosting,
  toCompanyJobItem,
  toCompanyProfile,
  upsertCompanies,
} from './service.js';
export type { CompaniesDb, CompanyReadService, CompanyReadViewer, PostingIndustry, PostingIndustryOutcome } from './service.js';

/** Market-scoped to the current brand (request or cron context). */
export interface CompanyService {
  /**
   * `viewer` defaults to anonymous: the open-job count then covers only jobs
   * cleared for public display. Callers serving a signed-in user (job detail,
   * the Assistant) pass `{ publicOnly: false }`.
   */
  profile(idOrSlug: string, viewer?: CompanyReadViewer): Promise<CompanyProfile>;
  typeahead(q: string, limit?: number): Promise<CompanyTypeaheadItem[]>;
}

let reader: CompanyReadService | null = null;
const read = (): CompanyReadService => (reader ??= createCompanyReadService(prisma));

export const companyService: CompanyService = {
  profile(idOrSlug, viewer) {
    return read().profile(getCurrentBrandOrDefault().market, idOrSlug, viewer);
  },
  typeahead(q, limit) {
    return read().typeahead(getCurrentBrandOrDefault().market, q, limit);
  },
};

/**
 * Store the industry a posting states for its employer, on the application
 * database (SM-10; the rules are `setIndustryFromPosting`'s). Enrichment
 * calls this after it has verified the posting's quote.
 */
export function recordPostingIndustry(companyId: string, input: PostingIndustry): Promise<PostingIndustryOutcome> {
  return setIndustryFromPosting(prisma, companyId, input);
}
