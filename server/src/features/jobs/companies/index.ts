// server/src/features/jobs/companies/index.ts — public surface (FND-5; filled by WP-16b).
// The Assistant's company_insights tool and job detail use `companyService.profile`;
// ingest uses `upsertCompanies`.

import prisma from '../../../lib/prisma.js';
import { getCurrentBrandOrDefault } from '../../../platform/brand/index.js';
import type { CompanyProfile, CompanyTypeaheadItem } from './contract.js';
import { createCompanyReadService, type CompanyReadService, type CompanyReadViewer } from './service.js';

export * from './contract.js';
export { createCompaniesRouter } from './routes.js';
export type { CompaniesRouterDeps } from './routes.js';
export {
  COMPANY_JOBS_PAGE,
  H1B_DISCLAIMER,
  companyKey,
  companyPatch,
  companyJobsOrder,
  companySlug,
  createCompanyReadService,
  escapeLike,
  liveJobWhere,
  toCompanyJobItem,
  toCompanyProfile,
  upsertCompanies,
} from './service.js';
export type { CompaniesDb, CompanyReadService, CompanyReadViewer } from './service.js';

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
