// server/src/features/jobs/companies/routes.ts — company routes (WP-16b; ARCH §3.4).
// Mounted by features/index.ts at /api/v1/roboapply/companies.
//
//   GET /companies?q=            typeahead (seeker session): trigram + prefix on the
//                                normalized name, market-scoped, with logo (F-FILT-04)
//   GET /companies/:idOrSlug     profile (optional session): sourced facts only (F-JOB-04)
//   GET /companies/:id/h1b       US DOL LCA history (flag h1bHistory; RoboApply)
//   GET /companies/:id/sponsorship  sponsorship facts with year, source and date:
//                                DOL LCA, the USCIS H-1B Employer Data Hub and the UK
//                                sponsor register (flag h1bHistory; RoboApply; JI-11)
//   GET /companies/:id/jobs      live canonical public jobs, 20 a page
//
// Every read is scoped to the serving brand's market; another market's
// company answers 404. Without a session, the job list and the profile's
// open-job count include only jobs cleared for public display (OPS-A4).
// The job list and the count hold a recruiter-bank row whose bank has no
// posting page, and a row that owes a credit line (service.ts `liveJobWhere`).

import { Router, type Request } from 'express';
import { seekerAuth } from '../../../roboapply/engine/middleware/seekerAuth.js';
import { optionalAuth } from '../../../middleware/auth.js';
import { getCurrentBrandOrDefault } from '../../../platform/brand/index.js';
import { requireFlag } from '../../../platform/flags.js';
import { parseParams, parseQuery, route } from '../../../platform/http.js';
import prisma from '../../../lib/prisma.js';
import type { FeatureRouterDeps } from '../../index.js';
import { CompanyIdOrSlugParamsSchema, CompanyIdParamsSchema, CompanyJobsQuerySchema, CompanySponsorshipQuerySchema, CompanyTypeaheadQuerySchema } from './contract.js';
import { createCompanyReadService, type CompanyReadService, type CompanyReadViewer } from './service.js';
import { createSponsorshipService, matchViewerNeed, type SponsorshipService } from './sponsorship/service.js';
import { cnPostingsWhere } from '../../cn/jobs/index.js';

export interface CompaniesRouterDeps extends FeatureRouterDeps {
  /** Test seam (default: the service over the shared Prisma client). */
  service?: CompanyReadService;
  /** Test seam (default: the facts service over the shared Prisma client, with the viewer's answers from the match area). */
  sponsorship?: SponsorshipService;
}

export function createCompaniesRouter(deps: CompaniesRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const maybeAuth = [...(deps.optionalAuth ?? [optionalAuth])];
  let lazy: CompanyReadService | null = deps.service ?? null;
  const service = (): CompanyReadService => (lazy ??= createCompanyReadService(prisma));
  let lazySponsorship: SponsorshipService | null = deps.sponsorship ?? null;
  const sponsorship = (): SponsorshipService => (lazySponsorship ??= createSponsorshipService(prisma, { viewerNeed: matchViewerNeed }));
  const market = () => getCurrentBrandOrDefault().market;
  const env = () => deps.env ?? process.env;
  // optionalAuth sets req.user only for a valid session; anyone else is anonymous.
  const userOf = (req: Request) => (req as Request & { user?: { id?: string } }).user;
  // GoApply: the recruitment-info mode decides whether third-party postings
  // are listed or counted at all (R-14; WP-41 R41-1, Wave 3 gate). `env` is
  // where the service reads the bank posting-page settings from.
  // `printsCreditLine` stays off: the Company tab lists a title and a place
  // and cannot print a credit line (components/features/company/CompanyTab.tsx).
  // Turn it on in the change that makes that list print
  // `cardMeta.tw_sources.attribution` of each item.
  const viewer = (req: Request): CompanyReadViewer => {
    const user = userOf(req);
    return {
      publicOnly: !user,
      env: env(),
      ...(market() === 'cn' ? { restrict: cnPostingsWhere(user?.id ?? null, env()) } : {}),
    };
  };

  router.get(
    '/',
    ...auth,
    route(async (req) => {
      const { q, limit } = parseQuery(req, CompanyTypeaheadQuerySchema);
      return { items: await service().typeahead(market(), q, limit ?? 8) };
    }),
  );

  router.get(
    '/:idOrSlug',
    ...maybeAuth,
    route(async (req) => {
      const { idOrSlug } = parseParams(req, CompanyIdOrSlugParamsSchema);
      return service().profile(market(), idOrSlug, viewer(req));
    }),
  );

  router.get(
    '/:id/h1b',
    ...maybeAuth,
    requireFlag('h1bHistory', { env: deps.env }),
    route(async (req) => {
      const { id } = parseParams(req, CompanyIdParamsSchema);
      return service().h1b(market(), id);
    }),
  );

  router.get(
    '/:id/sponsorship',
    ...maybeAuth,
    requireFlag('h1bHistory', { env: deps.env }),
    route(async (req) => {
      const { id } = parseParams(req, CompanyIdParamsSchema);
      const { jobId } = parseQuery(req, CompanySponsorshipQuerySchema);
      return sponsorship().facts(market(), id, { userId: userOf(req)?.id ?? null, jobId: jobId ?? null });
    }),
  );

  router.get(
    '/:id/jobs',
    ...maybeAuth,
    route(async (req) => {
      const { id } = parseParams(req, CompanyIdParamsSchema);
      const { cursor } = parseQuery(req, CompanyJobsQuerySchema);
      return service().jobs(market(), id, cursor, viewer(req));
    }),
  );

  return router;
}
